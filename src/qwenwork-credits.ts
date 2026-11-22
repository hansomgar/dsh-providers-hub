/**
 * 千问办公国际站（QwenWork Intl）的额度查询与展示装配。
 *
 * ## ⚠️⚠️ 本家**没有签到端点**，`credits.dailyCheckin` 必须为 `false`
 *
 * 2026-11-22 真机实测，逐个探测 16 个候选端点，**全部 404**：
 *
 * ```
 * 404  GET  /user/credits/balance     404  GET  /user/bonus
 * 404  GET  /user/bonuses            404  GET  /user/eligibility
 * 404  GET  /user/benefits           404  GET  /user/campaigns
 * 404  GET  /user/signup-bonus       404  GET  /user/activities
 * 404  GET  /user/tasks              404  GET  /user/wallet
 * 404  GET  /user/usage              404  GET  /user/settings
 * 404  POST /user/signup-bonus/claim 404  POST /user/bonus/claim
 * 404  POST /user/daily-bonus/claim  404  POST /user/benefits/claim
 * ```
 *
 * 而国内站那套营销活动端点在国际站**同样不存在**（实测 404）：
 *
 * | 端点 | 国内站 | **国际站** |
 * |---|---|---|
 * | `/api/marketing/benefits/claim` | **401（存在）** | **404** |
 * | `/api/marketing/eligibility/ensure` | **401（存在）** | **404** |
 *
 * ⇒ **国际站的额度是服务端每日自动发放的，没有任何「领取」动作可调。**
 *
 * ⚠️ 这与国内站形成鲜明对比：国内站的 500/月**要靠「伪造 session/turn 上报」
 * 去领**（`magpie-qwenwork-affiliate` 的实现：下载官方固定案例 + 校验 SHA256 +
 * `POST /api/desktop-sessions/report` 伪造一次「完成真实任务」），而官方活动页
 * 明禁「异常方式套取积分」。**本 provider 刻意不实现那套东西** ——
 * 国际站不需要，且那条路有封号风险。
 *
 * ## ⚠️⚠️ 额度是**瀑布**：先扣 daily，daily 用完扣 longterm
 *
 * ### 我先前的错误结论（2026-11-22 早，已推翻）
 *
 * 当时用**刚注册的新账号**实测，看到 `daily 200 / longterm 500`，
 * 发一次请求后 `daily 200 → 199.8368` 而 `longterm 500` 纹丝不动 ⇒
 * 我错误地得出「推理**只扣** daily，longterm 永远扣不到」，
 * 并把 `total` 取成 `daily`。
 *
 * ### 真实规则（2026-11-22 晚，用 daily 已耗尽的账号实测）
 *
 * ```json
 * { "daily_credits":    { "total_balance": 0 },        ← 当天额度已用完
 *   "monthly_credits":  { "total_balance": 0 },
 *   "longterm_credits": { "total_balance": 378.0028 } } ← 仍在
 * ```
 *
 * 此时**推理照样 200**，且扣的是 longterm：
 * `longterm 378.0028 → 378.0011`（扣 0.0017），`daily` 纹丝不动。
 *
 * ⇒ 机制是**瀑布扣减**：daily 有就先扣 daily，daily 空了就扣 longterm。
 * 先前「只扣 daily」的结论只在新账号（daily 未耗尽）这一段上成立，
 * 是**观察窗口太窄**造成的误判。
 *
 * ### 由此纠正的两处实现
 *
 * 1. **`total` 必须是 daily + longterm 之和**（先前取 daily ⇒ 用户账户里
 *    有 378 却显示 0 且报「查询失败」，这就是本次报障）；
 * 2. **折算可用性看合计**（先前只看 daily ⇒ daily 为 0 的账号被判不可用，
 *    而它其实完全能用）。
 *
 * ### ⚠️ 仍然成立的部分
 *
 * `monthly_credits` 是**订阅额度**（免费版恒 0），不属于可消耗池，
 * **不计入** `total`。三个池的**到期时刻不同**（daily 次日 00:00、
 * longterm 三个月后）⇒ 仍然**分成不同的包**呈现，不合并成一个数字，
 * 否则用户看不出哪部分是每天刷新、哪部分是长期的。
 *
 * @module src/qwenwork-credits.ts
 */

import { NEVER, UNUSABLE } from './aggregate-core.js'
import type { CreditBalance, CreditPackage } from './credits.js'
import type { QwenworkCredential } from './qwenwork.js'
import { QWENWORK_INTL, type QwenworkProduct } from './qwenwork-product.js'
import { qwenworkHeaders, qwenworkWalletsUrl } from './qwenwork.js'

/** `/user/wallets` 的原始解析结果（与 auth 服务的 `QwenworkBalance` 同形）。 */
export interface QwenworkWalletsSnapshot {
  daily?: number
  monthly?: number
  longterm?: number
  wallets: readonly { balance: number; validTo?: string }[]
  planName?: string
  total?: number
}

/**
 * 每日额度上限（**实测**免费账号 200/天）。
 *
 * ⚠️ 上游**不下发**这个上限（`/user/wallets` 只给 `total_balance`），
 * 所以这是**观察值**而非权威值。若某账号的 daily 余额 > 200（例如活动加成），
 * 占比计算会按 `min(100, …)` 夹住，不会出现 >100% 的怪值。
 */
export const QWENWORK_DAILY_ALLOWANCE = 200

/** 判定「这个钱包是每日池」的时间阈值：36 小时内到期。 */
const DAILY_WINDOW_MS = 36 * 60 * 60_000

/**
 * 判断某个钱包是不是「每日池」。
 *
 * ⚠️ 用「到期时刻在 36 小时内」作判据，而不是看下标：
 * 实测 `active_wallets.wallets` 的顺序**不保证**（同一天两个账号一个
 * `[200, 500]`、若要按位置读会错配）。36 小时是「次日 00:00（UTC+8）」
 * 这个语义的宽松上界（跨时区/时钟偏差都容得下）。
 */
export function isQwenworkDailyWallet(
  wallet: { balance: number; validTo?: string },
  now: number = Date.now(),
): boolean {
  if (typeof wallet.validTo !== 'string') return false
  const parsed = Date.parse(wallet.validTo)
  if (!Number.isFinite(parsed)) return false
  return parsed - now <= DAILY_WINDOW_MS
}

/**
 * 把钱包快照转成 `CreditPackage[]`。
 *
 * ## ⚠️ 三条不得违反的规则
 *
 * 1. **`totalKnown: false`**：上游只给 `total_balance`（当前余额），
 *    **不给**该池的初始总额 ⇒ 必须置 `false`，否则面板会显示
 *    `199.84 / 199.84` 这种「分母跟着余额跑」的假读数（用户 2026-11-05 报障）。
 * 2. **`expiryUnknown`**：上游没给 `valid_to` 时置 `true`
 *    （**绝不反推日期** —— 本仓红线 IKTLMX）。
 * 3. **名字必须说清是哪个池**：用户看到两个数字必须能分辨「哪个能花」。
 *
 * @param snapshot 钱包快照。
 * @param now      当前时刻（毫秒；便于单测注入）。
 */
export function buildQwenworkPackages(
  snapshot: QwenworkWalletsSnapshot,
  now: number = Date.now(),
): readonly CreditPackage[] {
  return snapshot.wallets.map((wallet) => {
    const isDaily = isQwenworkDailyWallet(wallet, now)
    const hasExpiry = typeof wallet.validTo === 'string' && Number.isFinite(Date.parse(wallet.validTo))
    const expiryMs = hasExpiry ? Date.parse(wallet.validTo as string) : undefined
    const name = isDaily
      ? '每日额度（次日刷新）'
      // ⚠️ **不能写「推理不消耗」**（2026-11-22 实测推翻）：daily 用完后
      //    推理**就扣这个池**（实测 longterm 378.0028 → 378.0011）。
      //    「注册赠送」是它的来源，「长期有效」是它的特征。
      : '长期额度（注册赠送）'
    return {
      name,
      unit: '积分',
      remaining: wallet.balance,
      // ⚠️ 总额未知 ⇒ 只能冗余填 remaining，并靠 `totalKnown: false` 告诉面板别并列显示。
      total: wallet.balance,
      totalKnown: false,
      // ⚠️ 已用额度**未知**（上游不给初始总额）⇒ 填 0 而不是编一个数。
      //    面板据 `totalKnown: false` 不显示进度条。
      used: 0,
      active: wallet.balance > 0,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: hasExpiry ? wallet.validTo as string : '',
      /**
       * ⚠️⚠️ **`deductionEndTime` 必须写 —— 这是分档判据的唯一入口**（2026-11-22 修复）。
       *
       * ## 缺陷（用户真机报障）
       *
       * 面板显示「临期 200」，但锁定长期积分后报「所有账号的这类额度都已用尽」。
       *
       * ## 根因
       *
       * 本仓分档函数 `splitBuddyCreditsByExpiry`（`buddy-balance-rank.ts:365`）
       * **只读 `pkg.deductionEndTime`**，**完全不读** `expiredTime`：
       *
       * ```ts
       * const endTime = pkg.deductionEndTime   // ← 唯一入口
       * ```
       *
       * 我原先只填了 `expiredTime` ⇒ `deductionEndTime` 恒 `undefined`
       * ⇒ **两个池都被判「永久」**（`buddy-balance-rank.ts` 的注释：
       * 「`deductionEndTime ≥ 15 天` **或未下发** ⇒ 落永久桶」）
       * ⇒ 锁定后 `allowPermanent: false` ⇒ **所有账号都不可用**。
       *
       * ⚠️ 面板之所以显示「临期 200」：那是**前端** `credit-expiry.js` 的
       * `packageExpiryMs`，它「优先 `deductionEndTime`、缺失才回落 `expiredTime`」
       * ⇒ 前端和好后端的判据**不是同一份**，于是同一份数据在面板是「临期」、
       * 在选号是「永久」—— 这正是本仓红线「同一语义两套判据」的形态。
       *
       * ⚠️ **必须两个都写**：`deductionEndTime` 给后端分档，
       * `expiredTime` 给前端显示（两边都要有，缺一个就有一边退化）。
       *
       * ⚠️ 与 `magicrew-credits.ts:399` / `minimax-credits.ts:724` /
       * `lobsterai-credits.ts:397` 同款写法：**读不到就不写**（不编造）。
       */
      ...expiryMs === undefined ? {} : { deductionEndTime: expiryMs },
      ...hasExpiry ? {} : { expiryUnknown: true },
    } satisfies CreditPackage
  })
}

/**
 * 把钱包快照转成 `CreditBalance`。
 *
 * ## ⚠️⚠️ `total` = **daily + longterm**（可消耗池之和），不是只看 daily
 *
 * 见模块头：额度是**瀑布扣减**（daily 用完扣 longterm）。
 * 先前取 `daily` 的写法会把「daily 已耗尽但 longterm 还有 378」的账号
 * 显示成 0 并判为查不到 —— 那正是 2026-11-22 的真实报障。
 *
 * ⚠️ **`monthly_credits` 不计入**：那是订阅额度（免费版恒 0），不属于
 * 可消耗池。把它加进来会让「免费版用户」的余额虚高。
 *
 * @param snapshot 钱包快照。
 * @param now      当前时刻（毫秒；便于单测注入）。
 * @returns 两个可消耗池都读不到时返回 `undefined`
 *          （调用方按「查不到」呈现，**不得**当 0）。
 */
export function buildQwenworkBalance(
  snapshot: QwenworkWalletsSnapshot,
  now: number = Date.now(),
): CreditBalance | undefined {
  const daily = readFinite(snapshot.daily)
  const longterm = readFinite(snapshot.longterm)
  // ⚠️ 两个池**都**读不到才算「查不到」。
  //    任一读到就按它算 —— 只读到 longterm 是**正常状态**
  //    （daily 当天用完之后就是这样）。
  if (daily === undefined && longterm === undefined) return undefined
  const packages = buildQwenworkPackages(snapshot, now)
  const dailyWallet = snapshot.wallets.find((w) => isQwenworkDailyWallet(w, now))
  const expiresAt = dailyWallet?.validTo === undefined ? undefined : Date.parse(dailyWallet.validTo)
  return {
    // ⚠️ 可消耗池之和（瀑布扣减 ⇒ 两个池都真的能用）。
    total: (daily ?? 0) + (longterm ?? 0),
    packages: [...packages],
    // ⚠️ 没有「已失效包」的概念（上游只回活跃钱包）⇒ 恒 0，不是查不到。
    expiredTotal: 0,
    ...expiresAt === undefined || !Number.isFinite(expiresAt)
      ? {}
      : { dailyGrantExpiresAt: expiresAt },
  }
}

/** 读一个有限数；`undefined` / `NaN` / `Infinity` 都当「没读到」。 */
function readFinite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 生成一行给用户看的额度摘要（面板副标题 / 错误提示用）。
 *
 * ⚠️ 必须把两个池**分开写**：`200 可用（另 500 注册赠送，推理不消耗）`。
 * 合成 `700` 是本模块要防的那个错。
 */
export function describeQwenworkCredits(snapshot: QwenworkWalletsSnapshot): string {
  const parts: string[] = []
  if (snapshot.daily !== undefined) parts.push(`每日 ${formatCredits(snapshot.daily)}`)
  if (snapshot.longterm !== undefined && snapshot.longterm > 0) {
    // ⚠️ **不能写「推理不消耗」**：daily 用完后推理就扣它（实测）。
    parts.push(`长期 ${formatCredits(snapshot.longterm)}`)
  }
  if (parts.length === 0) return '读不到额度'
  return parts.join(' · ')
}

/** 格式化积分（去掉无意义的尾零，但保留小数）。 */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return '—'
  // 实测额度精度到 4 位小数（如 199.8368）。
  const rounded = Math.round(value * 10_000) / 10_000
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 读额度（带**可区分的原因**）。
 *
 * ## ⚠️ 为什么用「带原因」变体而不是裸 `fetchBalance`
 *
 * 三种失败的**用户动作完全不同**，压成一句「余额查询失败」会让人按错方向排查：
 *
 * | 情况 | 用户该做什么 |
 * |---|---|
 * | **HTTP 401 / `INVALID_TOKEN`** | 登录失效 ⇒ 去面板重新登录 |
 * | **响应缺 `daily_credits`** | 上游改版 ⇒ 报「读数格式变了」（不是用户的错） |
 * | **邮箱类型没积分** | 换正常邮箱重新注册（实测临时邮箱恒 0） |
 *
 * ⚠️ 第三种**不是错误**：上游正常返回 200 且三元组全是 0。此时必须**正常返回
 * 一个 `balance`**（`total: 0`），而不是报「查询失败」—— 否则用户会以为插件坏了，
 * 而事实是那个账号确实没有额度（README 里要写明这个坑）。
 *
 * @param credential 登录凭据。
 * @param product    产品配置。
 * @param fetchImpl  注入的 fetch（单测用）。
 * @param signal     中止信号。
 */
export async function fetchQwenworkBalanceDetailed(
  credential: QwenworkCredential,
  product: QwenworkProduct = QWENWORK_INTL,
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<{ balance: CreditBalance | null; error?: string }> {
  const token = typeof credential?.access_token === 'string' ? credential.access_token : ''
  if (token.length === 0) {
    return { balance: null, error: '凭据里没有 access_token —— 请重新登录' }
  }
  let response: Response
  try {
    response = await fetchImpl(qwenworkWalletsUrl(product), {
      headers: qwenworkHeaders(token, 'application/json'),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    // ⚠️ 中止必须原样上抛（铁律：折算/查询链不得把 AbortError 吞成业务失败）。
    if ((error as { name?: unknown })?.name === 'AbortError') throw error
    return {
      balance: null,
      error: `网络错误：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    // ⚠️ 401 是**唯一**需要引导用户重新登录的码；其余按上游原文报出来。
    if (response.status === 401 || response.status === 403) {
      return {
        balance: null,
        error: `登录已失效（HTTP ${response.status}）—— 请在面板重新登录`,
      }
    }
    return {
      balance: null,
      error: `上游返回 HTTP ${response.status}：${text.slice(0, 200) || '（无详情）'}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { balance: null, error: '读数格式变了：响应不是 JSON（上游可能改版）' }
  }
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
  const data = (typeof body.data === 'object' && body.data !== null ? body.data : body) as Record<string, unknown>
  const totalOf = (block: unknown): number | undefined => {
    if (typeof block !== 'object' || block === null) return undefined
    const value = (block as Record<string, unknown>).total_balance
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const daily = totalOf(data.daily_credits)
  if (daily === undefined) {
    // ⚠️ 缺 `daily_credits` 是**格式变化**，不是「没有额度」—— 明确说出来。
    return { balance: null, error: '读数格式变了：响应里没有 daily_credits 字段（上游可能改版）' }
  }
  const rawWallets = typeof data.active_wallets === 'object' && data.active_wallets !== null
    ? (data.active_wallets as Record<string, unknown>).wallets
    : undefined
  const wallets = Array.isArray(rawWallets)
    ? rawWallets.flatMap((w) => {
      if (typeof w !== 'object' || w === null) return []
      const item = w as Record<string, unknown>
      const balance = typeof item.balance === 'number' && Number.isFinite(item.balance) ? item.balance : undefined
      if (balance === undefined) return []
      return [{
        balance,
        ...typeof item.valid_to === 'string' ? { validTo: item.valid_to } : {},
      }]
    })
    : []
  const snapshot: QwenworkWalletsSnapshot = {
    daily,
    monthly: totalOf(data.monthly_credits),
    longterm: totalOf(data.longterm_credits),
    wallets,
  }
  const balance = buildQwenworkBalance(snapshot)
  if (balance === undefined) {
    return { balance: null, error: '读数格式变了：无法装配余额对象' }
  }
  return { balance }
}

/**
 * 聚合轮换的**到期折算原语**（`provider-expiry.ts` 的 `qwenworkintl` 条目调用它）。
 *
 * ## ⚠️⚠️ 本家最关键的语义差异：**只有 daily 会被推理消耗**
 *
 * 实测（2026-11-22 真机，同一账号）：
 * - 钱包里两个池：`daily 200`（次日 00:00 到期）+ `longterm 500`（3 个月后到期）；
 * - 推理前 `daily 200 / longterm 500` → 推理后 `daily 199.8368 / longterm 500`。
 *
 * ⇒ **注册赠送的 500 扣不动**。若照 buddy 那套「按 remaining 之和判可用」，
 * daily 烧光后仍会算出「还有 500」⇒ 该账号被排进候选 ⇒ **每轮先 429 一次**。
 *
 * 故本原语的判据是：
 * 1. **只看 daily**（`daily_credits`）；读不到 daily ⇒ `UNUSABLE`（保守，
 *    与 magicrew 的「查不到不判死」略相反 —— 这里是因为「查不到」在实测里
 *    总是伴随「额度为 0 的临时邮箱账号」那个形态，宁可先剔除；
 *    ⚠️ 若将来发现上游偶发不返回该字段，改回 `NEVER` 而不是 `UNUSABLE`）；
 * 2. daily > 0 ⇒ 按**每日池的到期时刻**（次日 00:00）参与三档分档；
 * 3. daily <= 0 ⇒ `UNUSABLE`（今天确实用不了，明天会自己恢复 —— 这一点与
 *    「额度永久耗尽」不同，但折算层只关心「本轮能不能用」）。
 *
 * ## ⚠️ `cachedBalance` 缺席 / null / undefined 时**必须自己取**
 *
 * 这是 `src/provider-runtime.ts` 的契约：折算可用性不得依赖缓存。
 * ⚠️ `null` 是「查询失败」，**不是** UNUSABLE、更不许让它变成 TypeError。
 *
 * @param params.accessToken     登录 token。
 * @param params.cachedBalance   共享读数（缺席/`null`/`undefined` 时自取）。
 * @param params.fetchBalance    自取实现（注入以便单测）。
 * @param params.now             时钟（可注入，单测不必等真时间）。
 */
export async function qwenworkExpiry(params: {
  accessToken: string
  cachedBalance?: () => Promise<CreditBalance | null | undefined>
  fetchBalance?: (accessToken: string) => Promise<QwenworkWalletsSnapshot | undefined>
  now?: number
}): Promise<number> {
  // ⚠️ 先试共享缓存；`null` / `undefined` 都表示「没有读数」⇒ 都必须回落自取。
  const cached = await params.cachedBalance?.()
  if (cached !== null && cached !== undefined) {
    // ⚠️ 共享缓存的 `total` 已是**可消耗池之和**（daily + longterm），
    //    故这里直接用 `total` 判可用性（见 buildQwenworkBalance 的注释）。
    if (!(cached.total > 0)) return UNUSABLE
    const now = params.now ?? Date.now()
    /**
     * ⚠️ **到期时刻从 `packages` 里挑，而不是只看 `dailyGrantExpiresAt`**：
     *
     * - daily 有额 → 它的到期时刻（次日 00:00）就是可用终点；
     * - daily 为 0、只有 longterm → 可用终点是 longterm 的到期（三个月后）。
     *
     * 若统一用 `dailyGrantExpiresAt`，第二类账号（daily 已耗尽）会被算成
     * 「已过期」⇒ 聚合轮换里被剔除 —— 而它其实是最健康的那类账号
     * （长期额度还剩几百）。
     *
     * ⚠️ 刻意**不给 `CreditBalance` 加字段**：那是全仓共享类型，
     * 为一家 provider 加私有字段会污染公共接口（本仓红线）。
     * 从 `packages`（每个包都带 `expiredTime`）里挑最晚的即可。
     */
    const dailyPositive = packagesHasDaily(cached)
    const expiresAt = dailyPositive
      ? cached.dailyGrantExpiresAt
      : latestPackageExpiry(cached, now)
    // ⚠️ 无到期时刻**不编造** ⇒ 当长期（排最后但可当选）。
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return NEVER
    return expiresAt <= now ? UNUSABLE : expiresAt
  }
  if (params.fetchBalance === undefined) return UNUSABLE
  const snapshot = await params.fetchBalance(params.accessToken)
  if (snapshot === undefined) return UNUSABLE
  const daily = readFinite(snapshot.daily)
  const longterm = readFinite(snapshot.longterm)
  // ⚠️ **两个池都读不到**才算不可用。只读到 longterm 是正常状态
  //    （daily 当天用完），此时账号完全能用。
  if (daily === undefined && longterm === undefined) return UNUSABLE
  if (!((daily ?? 0) + (longterm ?? 0) > 0)) return UNUSABLE
  const now = params.now ?? Date.now()
  const dailyWallet = snapshot.wallets.find((w) => isQwenworkDailyWallet(w, now))
  // ⚠️ daily 有额时用 daily 的到期（次日 00:00）；否则用最晚的那个钱包
  //    （长期额度，三个月后）—— 见上面缓存放的同一段推导。
  const expiresAtRaw = (daily ?? 0) > 0
    ? dailyWallet?.validTo
    : latestWalletValidTo(snapshot.wallets, now)
  const expiresAt = expiresAtRaw === undefined ? Number.NaN : Date.parse(expiresAtRaw)
  // ⚠️ 无到期时刻**不编造** ⇒ 当长期。
  if (!Number.isFinite(expiresAt)) return NEVER
  return expiresAt <= now ? UNUSABLE : expiresAt
}

/**
 * 取所有**未过期**钱包里最晚的那个 `valid_to`（daily 为 0 时用它当可用终点）。
 *
 * ⚠️ 取最晚而不是最早：longterm 才是那个账号真正的可用期；
 * 取最早会得到已过期的 daily 钱包 ⇒ 误判整账号不可用。
 */
function latestWalletValidTo(
  wallets: readonly { readonly validTo?: string }[],
  now: number,
): string | undefined {
  let best: number | undefined
  let bestRaw: string | undefined
  for (const wallet of wallets) {
    if (wallet.validTo === undefined) continue
    const ms = Date.parse(wallet.validTo)
    if (!Number.isFinite(ms) || ms <= now) continue
    if (best === undefined || ms > best) {
      best = ms
      bestRaw = wallet.validTo
    }
  }
  return bestRaw
}

/**
 * 缓存读数里**是否还有 daily 额度**。
 *
 * ⚠️ 判据是「每日包还有剩余」而不是「`total > 0`」：
 * `total` 现在已是两池之和，daily 耗尽时它仍为正。
 *
 * 每日包的识别沿用 `buildQwenworkPackages` 的命名约定（名称含「每日」）——
 * 这是本模块内部约定，不跨模块。
 */
function packagesHasDaily(balance: CreditBalance): boolean {
  for (const item of balance.packages) {
    if (!item.name.includes('每日')) continue
    if (item.remaining > 0) return true
  }
  return false
}

/** 缓存读数里所有未过期包里**最晚**的到期时刻（毫秒）。 */
function latestPackageExpiry(balance: CreditBalance, now: number): number | undefined {
  let best: number | undefined
  for (const item of balance.packages) {
    if (item.remaining <= 0) continue
    if (item.expiredTime === undefined || item.expiredTime.length === 0) continue
    const ms = Date.parse(item.expiredTime)
    if (!Number.isFinite(ms) || ms <= now) continue
    if (best === undefined || ms > best) best = ms
  }
  return best
}
