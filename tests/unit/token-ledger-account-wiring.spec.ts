/**
 * 「Token 用量」面板的**账号层 / 账号列**接线守卫（真渲染 + 真 RPC 桩）。
 *
 * ## 为什么必须另起一个文件、必须行为级
 *
 * `token-ledger-panel.spec.ts` 测的是**纯函数**（`accountLabel` / `buildAccountNameMap`），
 * 它们全绿完全不代表界面上真的用上了名字 —— 本仓库反复记录过这个形态：
 * 「纯函数测得动 + 源码字面量断言照得住」而**接线层零守卫**，于是
 * `panel.spec` 全绿而面板上恒显示裸 id。三处接线各自都能被独立改坏：
 *
 * | # | 接线点 | 被改坏的症状 |
 * |---|---|---|
 * | 1 | `account.list` 调用 | 传 `{}` 而不是 `{ provider }`（宿主 `account.list` 的过滤是 `a.provider === provider`）⇒ **恒空数组且不报错**，账号列全是裸 id |
 * | 2 | `accountLabel(id, accountNames)` | 漏传第二参 ⇒ 名字永远不生效（与「没实现」同形） |
 * | 3 | 表头 / 行同时加「账号」列 | 只改一处 ⇒ **所有列错位**（比不加列更糟） |
 *
 * ## 判据打在哪
 *
 * 不是「源码里有没有某个字面量」，而是：
 * 1. **真渲染** `TokenLedgerPanel`（经 `__tokenLedgerPanelForTest`），喂一份真实形状的
 *    账本快照 + 一份真实的 `account.list` 返回；
 * 2. 断言**渲染出来的树**里，账号行/账号格显示的是**名字**（不是裸 id）；
 * 3. 断言表头 9 列的顺序与行里 `td` 的顺序**逐格对应**（防错位）；
 * 4. 断言 `account.list` 是**按 provider 逐家**调的（不是一次 `{}` 扫全池）。
 *
 * ## ⚠️ 本文件的 react 替身刻意与 `checkin-panel-wiring.spec.ts` 同款
 *
 * `useState` 按槽位保存、`useEffect` 按 deps 逐项比较后才重跑 —— 这正是
 * 「`effect` 闭包停在第一次渲染」这类缺陷唯一能被抓住的地方。
 * ⚠️ `useRef` **必须同时写 `cur` 与 `current`**（真实 React 的 ref 对象属性叫
 * `current`；少了它 `ref.current` 恒 `undefined`，所有「只拉一次」的闸门会静默失效）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** hooks 槽位（跨渲染保留，下标即调用顺序）。 */
let slots: Array<{ v?: unknown; cur?: unknown; current?: unknown }> = []
let cursor = 0
/** 每个 effect 槽位上上一次提交的 deps。 */
let committed: Array<{ deps: unknown[] | undefined }> = []
let root: unknown = undefined
let pendingEffects: number[] = []

interface Node { type: unknown; props: Record<string, unknown>; children: unknown[] }

const reactStub = {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const k = cursor++
    if (!(k in slots)) slots[k] = {}
    const s = slots[k]!
    if (!('v' in s)) s.v = typeof initial === 'function' ? (initial as () => T)() : initial
    return [s.v as T, (next) => {
      s.v = typeof next === 'function' ? (next as (prev: T) => T)(s.v as T) : next
    }]
  },
  useRef<T>(initial: T) {
    const k = cursor++
    if (!(k in slots)) slots[k] = {}
    const s = slots[k]!
    // ⚠️⚠️ `current` 与 `cur` 都要写：真实 React 的 ref 属性叫 `current`。
    //    只写 `cur` 会让 `ref.current` 恒 `undefined` ⇒ `namedProviders` 那类
    //    「只拉一次」的闸门退化成「每次都拉」甚至「永远不拉」。
    if (!('cur' in s)) { s.cur = initial; (s as { current?: T }).current = initial }
    return s as unknown as { current: T }
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const k = cursor++
    const prev = committed[k]
    const changed = prev === undefined || deps === undefined
      || deps.length !== (prev.deps?.length ?? -1)
      || deps.some((d, i) => d !== prev.deps![i])
    if (!changed) return
    committed[k] = { deps }
    pendingEffects.push(k)
    Promise.resolve().then(() => { try { fn() } catch { /* 与本用例无关的副作用忽略 */ } })
  },
  useLayoutEffect(fn: () => void) { Promise.resolve().then(() => { try { fn() } catch { /* ignore */ } }) },
  useCallback<T>(fn: T): T { return fn },
  useMemo<T>(fn: () => T): T { return fn() },
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node {
    return { type, props: props ?? {}, children }
  },
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  Component: class {},
}

vi.mock('react', () => reactStub)

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i += 1) await tick() }

type AnyNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

function walk(nodes: unknown[], visit: (node: AnyNode) => void): void {
  for (const raw of nodes) {
    if (Array.isArray(raw)) { walk(raw, visit); continue }
    if (raw === null || typeof raw !== 'object') continue
    const node = raw as AnyNode
    if (!('props' in node)) continue
    visit(node)
    if (Array.isArray(node.children)) walk(node.children, visit)
  }
}

function findAll(pred: (node: AnyNode) => boolean): AnyNode[] {
  const out: AnyNode[] = []
  walk([root], (node) => { if (pred(node)) out.push(node) })
  return out
}

/** 收集任意深度上的字符串（`textsIn` 的同款；不能复用 `walk` —— 字符串不是对象）。 */
function textsIn(nodes: unknown[]): string[] {
  const out: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (value === null || typeof value !== 'object') return
    visit((value as AnyNode).children)
  }
  visit(nodes)
  return out
}

/** 每个 `display: none` 的祖先都要过滤掉？本替身不展开子组件，故不需要。 */
let panel: ((props: { rpcCall: (m: string, p?: unknown) => Promise<unknown>; onClose: () => void }) => unknown) | undefined

async function renderPanel(rpcCall: (m: string, p?: unknown) => Promise<unknown>): Promise<void> {
  cursor = 0
  pendingEffects = []
  root = panel!({ rpcCall, onClose: () => {} })
  await flush(3)
  let guard = 0
  while (pendingEffects.length > 0 && guard < 6) {
    pendingEffects = []
    cursor = 0
    root = panel!({ rpcCall, onClose: () => {} })
    await flush(3)
    guard += 1
  }
}

/**
 * 一份**真实形状**的账本快照：
 * - 一个 provider 下**两个**账号（走 nameMap，`nickname` 优先）；
 * - 另一个 provider 下**只有一个**账号（决策 Q3：单账号也分层）；
 * - 明细里有一笔 `accountId` 为空的请求（账户列的「未归属」格）。
 */
const SNAPSHOT = {
  channels: [
    {
      channel: 'direct',
      totals: { requests: 3, totalTokens: 300 },
      providers: [
        {
          provider: 'qodercn',
          totals: { requests: 2, totalTokens: 200 },
          accounts: [
            {
              accountId: 'qodercn-c5a414d5',
              totals: { requests: 1, totalTokens: 100 },
              models: [{ model: 'dfmodel', requests: 1, totalTokens: 100 }],
            },
            {
              accountId: 'qodercn-f01648a6',
              totals: { requests: 1, totalTokens: 100 },
              models: [{ model: 'qmodel_38max', requests: 1, totalTokens: 100 }],
            },
          ],
        },
        {
          provider: 'workbuddy',
          totals: { requests: 1, totalTokens: 100 },
          accounts: [
            {
              accountId: 'workbuddy-4c6e5683',
              totals: { requests: 1, totalTokens: 100 },
              models: [{ model: 'deepseek-v4.1-flash', requests: 1, totalTokens: 100 }],
            },
          ],
        },
      ],
    },
  ],
  totals: { requests: 3, totalTokens: 300 },
  entries: [
    { ts: 1_794_284_557_890, channel: 'direct', provider: 'qodercn', model: 'dfmodel', accountId: 'qodercn-c5a414d5', usageReported: true, inputTokens: 50, outputTokens: 50 },
    { ts: 1_794_284_500_000, channel: 'direct', provider: 'qodercn', model: 'qmodel_38max', accountId: 'qodercn-f01648a6', usageReported: true, inputTokens: 50, outputTokens: 50 },
    { ts: 1_794_284_400_000, channel: 'direct', provider: 'workbuddy', model: 'deepseek-v4.1-flash', accountId: 'workbuddy-4c6e5683', usageReported: true, inputTokens: 50, outputTokens: 50 },
    // ⚠️ 这一笔**没有** accountId：账号列必须显示「未归属」，不许渲染空白格。
    { ts: 1_794_284_300_000, channel: 'direct', provider: 'workbuddy', model: 'deepseek-v4.1-flash', usageReported: true, inputTokens: 10, outputTokens: 10 },
  ],
}

/**
 * `account.list` 的桩：**按 provider 过滤**（与宿主 `pool.listAccounts` 同判据）。
 * ⚠️ 传 `{}`（无 provider）时必须返回**空数组** —— 这正是真实宿主的行为，
 * 也是「只调一次 `account.list` 就以为能拿到全部账号」那个缺陷的症状来源。
 */
const ACCOUNTS: Record<string, Array<Record<string, unknown>>> = {
  qodercn: [
    // nickname 优先：用户自己填的备注名赢过上游用户名。
    { id: 'qodercn-c5a414d5', nickname: 'M籾 959', accountName: 'mylzscy4' },
    // nickname 是空串 ⇒ 用 accountName（上游真实用户名）。
    { id: 'qodercn-f01648a6', nickname: '', accountName: 'upstream-016' },
  ],
  workbuddy: [
    { id: 'workbuddy-4c6e5683', nickname: 'clover e', accountName: 'clover-upstream' },
  ],
}

function makeRpc(): { calls: Array<{ method: string; payload: unknown }>; rpcCall: (m: string, p?: unknown) => Promise<unknown> } {
  const calls: Array<{ method: string; payload: unknown }> = []
  const rpcCall = async (method: string, payload?: unknown): Promise<unknown> => {
    calls.push({ method, payload })
    if (method === 'usage.tokenLedger') return { snapshot: SNAPSHOT }
    if (method === 'usage.tokenLedgerHistory') return { history: [], totals: { requests: 0, totalTokens: 0 } }
    if (method === 'account.list') {
      const provider = (payload as { provider?: unknown } | undefined)?.provider
      const list = typeof provider === 'string' ? ACCOUNTS[provider] ?? [] : []
      return { accounts: list }
    }
    return {}
  }
  return { calls, rpcCall }
}

describe('★ Token 面板按账号归档 · 接线层行为守卫', () => {
  // ⚠️ 组件必须在 `vi.mock('react')` 已生效之后再取 —— 顶层 `import` 会被提升到
  //    mock 之前，那样拿到的是**真实** React（本仓库没有依赖它）⇒ 直接报错。
  beforeAll(async () => {
    const mod = await import('../../plugin-src/client/jet-hub.js') as unknown as {
      __tokenLedgerPanelForTest?: typeof panel
    }
    panel = mod.__tokenLedgerPanelForTest
    expect(typeof panel, 'jet-hub.js 没有导出 __tokenLedgerPanelForTest').toBe('function')
  })

  beforeEach(() => {
    slots = []
    committed = []
    cursor = 0
    pendingEffects = []
    root = undefined
  })

  it('★★ account.list 必须**按 provider 逐家**调（传 {} 会恒空而且不报错）', async () => {
    const { calls, rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const listCalls = calls.filter((c) => c.method === 'account.list')
    // 账本里出现过 2 家 ⇒ 至少各调一次（去重后不会更多）。
    const providers = listCalls.map((c) => (c.payload as { provider?: unknown } | undefined)?.provider)
    expect(providers).toContain('qodercn')
    expect(providers).toContain('workbuddy')
    // 每一条都必须**带** provider —— 不带的调用在宿主侧恒返回空数组。
    for (const p of providers) expect(typeof p).toBe('string')
    // 不许多调：同一 provider 只拉一次（否则切窗口/翻页会把凭据重读一遍）。
    expect(providers.filter((p) => p === 'qodercn')).toHaveLength(1)
    expect(providers.filter((p) => p === 'workbuddy')).toHaveLength(1)
  })

  it('★★ 账号层显示**名字**（nickname 优先，其次 accountName），不是裸 id', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const accountHeads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountName')
    const labels = accountHeads.map((node) => textsIn([node]).join(''))
    // nickname 优先
    expect(labels).toContain('M籾 959')
    // nickname 空串 ⇒ accountName
    expect(labels).toContain('upstream-016')
    expect(labels).toContain('clover e')
    // 裸 id 一个都不该露在**文本**里（它们只允许出现在 title 悬停里）。
    expect(labels).not.toContain('qodercn-c5a414d5')
    expect(labels).not.toContain('workbuddy-4c6e5683')
    // 完整 id 仍可从 title 悬停看到（决策 Q2-A）。
    const titles = accountHeads.map((node) => node.props?.title)
    expect(titles).toContain('qodercn-c5a414d5')
    expect(titles).toContain('workbuddy-4c6e5683')
  })

  it('★★★ 单账号也分层（决策 Q3：不加开关，1 个账号同样渲染账号行）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const accountRows = findAll((node) => node.props?.className === 'dim-jh-ledgerAccount')
    // workbuddy 只有 1 个账号 —— 改前它会被平铺，账号行根本不出现。
    // ⚠️ 2026-11-11 起不再靠 `data-single` 找单账号（该属性已删，样式统一）：
    //    判据改成「那个 provider 子树里确实只有这一段账号行」。
    const heads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountName')
      .map((node) => textsIn([node]).join(''))
    // 单账号的 workbuddy 必须有自己的账号行（名字来自 nickname）。
    expect(heads).toContain('clover e')
    // 且它**没有**兄弟账号行 —— 证明这是「单账号」那一格，不是多账号碰巧命中。
    expect(heads.filter((t) => t === 'clover e')).toHaveLength(1)
    // 账号行数量 = 3（qodercn 两个 + workbuddy 一个），不多不少。
    expect(accountRows).toHaveLength(3)
  })

  it('★★ 层级样式：账号行必须挂色块类名，模型行不挂（视觉区分度的接线守卫）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    // 账号头是**色块分组头**（方案 A）：className 必须是 ledgerAccountHead。
    const heads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountHead')
    expect(heads.length).toBe(3)
    // 模型行必须是 ledgerModel（不带 Account 语义），否则样式会套错。
    const models = findAll((node) => node.props?.className === 'dim-jh-ledgerModel')
    expect(models.length).toBeGreaterThan(0)
    // ⚠️ 死代码守卫：`data-single` 已随「单账号与多账号完全一样」的决策删除。
    //    判据只认**属性键**（渲染出来的 props），不认源码注释。
    expect(findAll((node) => 'data-single' in (node.props ?? {}))).toHaveLength(0)
  })

  it('★★★ 明细表「账号」列：表头与行的顺序逐格对应（只改一处会让所有列错位）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const table = findAll((node) => node.props?.className === 'dim-jh-ledgerTable')[0]
    expect(table, '明细表没渲染出来 ⇒ 本文件失效（结构已变）').toBeTruthy()

    const ths = findAll((node) => node.type === 'th').map((node) => textsIn([node]).join(''))
    expect(ths).toEqual(['时间', '渠道', '账号', '模型', 'TOKEN', '首字', '速率', '耗时', '状态'])

    const rows = findAll((node) => node.type === 'tr' && Array.isArray(node.children)
      && node.children.some((c) => (c as AnyNode)?.type === 'td'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const tds = row.children.filter((c) => (c as AnyNode)?.type === 'td') as AnyNode[]
      // ⚠️ 行与表头的列数必须相等 —— 缺一格就是「所有列整体左移」。
      expect(tds).toHaveLength(ths.length)
    }
  })

  it('★★ 明细表的账号格显示名字；没有 accountId 的行显示「未归属」', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const cells = findAll((node) => node.props?.className === 'dim-jh-ledgerEntryAccount')
    const cellTexts = cells.map((node) => textsIn([node]).join(''))
    expect(cellTexts).toContain('M籾 959')
    expect(cellTexts).toContain('upstream-016')
    expect(cellTexts).toContain('clover e')
    // 第四笔没有 accountId ⇒ 「未归属」（不是空白）。
    expect(cellTexts).toContain('未归属')
    // 裸 id 不许出现在单元格文本里。
    expect(cellTexts).not.toContain('qodercn-c5a414d5')
  })

  it('★ account.list 失败必须静默：面板照常显示，账号回落 id', async () => {
    const calls: string[] = []
    const rpcCall = async (method: string, payload?: unknown): Promise<unknown> => {
      calls.push(method)
      if (method === 'usage.tokenLedger') return { snapshot: SNAPSHOT }
      if (method === 'usage.tokenLedgerHistory') return { history: [], totals: {} }
      if (method === 'account.list') throw new Error('模拟凭据读取失败')
      return {}
    }
    // ⚠️ 不 catch ⇒ 名字加载的 rejection 若冒泡，这里会直接把用例打红。
    await renderPanel(rpcCall)
    const labels = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountName')
      .map((node) => textsIn([node]).join(''))
    // 账本主数据照常显示，名字回落**内部 id**（这是对的：账号可能真被删了）。
    expect(labels).toContain('qodercn-c5a414d5')
    expect(labels).toContain('workbuddy-4c6e5683')
    // 面板本体没被顶掉。
    expect(findAll((node) => node.type === 'table').length).toBe(1)
  })
})
