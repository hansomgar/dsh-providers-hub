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
 * ## ⚠️⚠️ 三个池必须**分开呈现**，不得合并（这是本文件存在的全部理由）
 *
 * 实测（同一账号，免费版）：
 * ```json
 * { "daily_credits":    { "total_balance": 200 },   ← 推理**只扣**这个
 *   "monthly_credits":  { "total_balance": 0 },
 *   "longterm_credits": { "total_balance": 500 } }  ← 注册赠送，推理**不扣**
 * ```
 *
 * 而 `quota.remaining` 是**三池合计 700**。推理前后的实测：
 * `daily 200 → 199.8368`，`longterm 500` **纹丝不动**。
 *
 * ⇒ 两条硬规则：
 * 1. 把 700 写成「每天 700」是**错的**（用户以为有 700 可用，实际 200 用完就 429）；
 * 2. 用合计判耗尽会**漏判**（daily 已空但合计还有 500 ⇒ 账号实际已不可用）。
 *
 * 故 `total` 取 **daily**，`longterm` 单独成一个包并标注「推理不消耗」。
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
  return snapshot.wallets.map((wallet, index) => {
    const isDaily = isQwenworkDailyWallet(wallet, now)
    const hasExpiry = typeof wallet.validTo === 'string' && Number.isFinite(Date.parse(wallet.validTo))
    const name = isDaily
      ? `每日额度（推理消耗${index === 0 ? '' : ''}）`
      : '注册赠送（推理不消耗）'
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
      ...hasExpiry ? {} : { expiryUnknown: true },
    } satisfies CreditPackage
  })
}

/**
 * 把钱包快照转成 `CreditBalance`。
 *
 * ## ⚠️ `total` 取 **daily**，不是三池合计
 *
 * 见模块头：合计 700 里有 500 是推理吃不到的。把 700 当「今天可用」会让用户
 * 在 200 烧完后收到 `balance_insufficient` 却看到「还有 500」。
 *
 * @param snapshot 钱包快照。
 * @param now      当前时刻（毫秒；便于单测注入）。
 * @returns 读不到 daily 时返回 `undefined`（调用方按「查不到」呈现，**不得**当 0）。
 */
export function buildQwenworkBalance(
  snapshot: QwenworkWalletsSnapshot,
  now: number = Date.now(),
): CreditBalance | undefined {
  const daily = snapshot.daily
  if (daily === undefined || !Number.isFinite(daily)) return undefined
  const packages = buildQwenworkPackages(snapshot, now)
  const dailyWallet = snapshot.wallets.find((w) => isQwenworkDailyWallet(w, now))
  const expiresAt = dailyWallet?.validTo === undefined ? undefined : Date.parse(dailyWallet.validTo)
  return {
    total: daily,
    packages: [...packages],
    // ⚠️ 没有「已失效包」的概念（上游只回两个活跃钱包）⇒ 恒 0，不是查不到。
    expiredTotal: 0,
    ...expiresAt === undefined || !Number.isFinite(expiresAt)
      ? {}
      : { dailyGrantExpiresAt: expiresAt },
  }
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
    parts.push(`注册赠送 ${formatCredits(snapshot.longterm)}（推理不消耗）`)
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
    // 共享缓存的 `total` 已被 `buildQwenworkBalance` 约束成 **daily**，
    // 故这里直接用 `total` 判可用性，不需要再区分池。
    if (!(cached.total > 0)) return UNUSABLE
    const now = params.now ?? Date.now()
    const expiresAt = cached.dailyGrantExpiresAt
    // ⚠️ 无到期时刻**不编造** ⇒ 当长期（排最后但可当选）。
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return NEVER
    return expiresAt <= now ? UNUSABLE : expiresAt
  }
  if (params.fetchBalance === undefined) return UNUSABLE
  const snapshot = await params.fetchBalance(params.accessToken)
  if (snapshot === undefined) return UNUSABLE
  const daily = snapshot.daily
  // ⚠️ daily 读不到 ⇒ 保守剔除（见函数注释的取舍理由）。
  if (daily === undefined || !Number.isFinite(daily)) return UNUSABLE
  if (!(daily > 0)) return UNUSABLE
  const now = params.now ?? Date.now()
  const dailyWallet = snapshot.wallets.find((w) => isQwenworkDailyWallet(w, now))
  const expiresAt = dailyWallet?.validTo === undefined ? Number.NaN : Date.parse(dailyWallet.validTo)
  // ⚠️ 无到期时刻**不编造** ⇒ 当长期。
  if (!Number.isFinite(expiresAt)) return NEVER
  return expiresAt <= now ? UNUSABLE : expiresAt
}
