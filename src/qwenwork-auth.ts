/**
 * 千问办公国际站（QwenWork Intl）认证服务。
 *
 * ## 职责范围
 *
 * 1. **凭据保管与有效期对账**（与其余 provider 同构）；
 * 2. **⚠️ MaaS 票据的换取与缓存**（本家独有，见下）；
 * 3. 设备码续期（`POST /api/v1/deviceToken/refresh`）。
 *
 * ## ⚠️⚠️ MaaS 票据缓存：单飞 + 提前量
 *
 * 推理不能直接用登录 token，必须先换 MaaS 票据（实测 `ttl_ms = 7_200_000`）。
 * 这个缓存**必须**放在 auth 服务里而不是适配器里，理由：
 *
 * - 适配器每个账号可能有多个实例/多次实例化，缓存放在那里会**重复换票**；
 * - 换票是**有副作用的网络调用**（算一次上游请求），重复换票等于白烧额度；
 * - DSH 会并发发主回复 + 标题 + 压缩三条请求 ⇒ 必须**单飞**
 *   （同一 slot 的并发调用共享同一个 Promise），否则三条各换一次票。
 *
 * 这是本仓 `protocol-wire.md` 的「单飞表」教训的直接应用：
 * 调度轮询无 in-flight 闸门 ⇒ 两拍重叠 ⇒ 重复消费一次性资源。
 *
 * ⚠️ **提前量 60 秒**：`ttl_ms` 从签发那刻算，扣掉提前量可避免「正好在过期
 * 边界发请求」⇒ 上游 401 ⇒ 被误判成「登录失效」并清空凭据。
 *
 * ## ⚠️ 换票失败**不得**清空凭据
 *
 * 换票需要登录 token 有效。若 token 过期，换票会 401 —— 但那是**可续期**的
 * 状态（有 `refresh_token`）。把「换票失败」直接判成「账号失效并删号」是本仓
 * `login.poll` 三态契约那轮的**用户数据被销毁**事故形态，绝不复刻。
 * 这里只在**续期也失败**时抛可读错误，由用户决定是否重新登录。
 *
 * @module src/qwenwork-auth.ts
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  decodeQwenworkJwt,
  isQwenworkExpired,
  isQwenworkRefreshable,
  qwenworkCredentialExpiresAtMs,
  qwenworkDeviceRefreshUrl,
  qwenworkHeaders,
  qwenworkIdentityOf,
  qwenworkMaasSessionUrl,
  qwenworkRefreshBody,
  qwenworkUserInfoUrl,
  qwenworkWalletsUrl,
  type QwenworkCredential,
} from './qwenwork.js'
import { QWENWORK_INTL, type QwenworkProduct } from './qwenwork-product.js'
import { AccountPool } from './account-pool.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'
import { SerialQueue } from './serial-queue.js'

/** 票据提前失效的余量（毫秒）。见模块头。 */
const TICKET_EXPIRY_MARGIN_MS = 60_000

/** 换票响应的缺省 TTL（上游未下发 `ttl_ms` 时用；实测下发的是 7_200_000）。 */
const DEFAULT_TICKET_TTL_MS = 6 * 60 * 60_000

/** 一张已缓存的 MaaS 票据。 */
export interface QwenworkTicket {
  token: string
  baseUrl: string
  /** 绝对过期时刻（毫秒）；已扣掉提前量。 */
  expiresAtMs: number
}

/** 额度快照（`/user/wallets` 的解析结果）。 */
export interface QwenworkBalance {
  /** 每日池（**推理只扣这个**）。`undefined` = 读不到。 */
  daily?: number
  /** 月度池。 */
  monthly?: number
  /** 注册赠送的长期池（**推理不扣它**）。 */
  longterm?: number
  /** 各钱包明细（含到期时间）。 */
  wallets: readonly { balance: number; validTo?: string }[]
  /** 套餐名（实测免费账号是 `Free`）。 */
  planName?: string
  /** 三池合计（= `quota.remaining`，⚠️ **不能**当「每日可用」用）。 */
  total?: number
}

/** 用于 Jet Hub 面板的只读登录状态。 */
export interface QwenworkLoginStatus {
  configured: boolean
  /** 恒为 `'device-code'`：凭据由设备码授权换来。 */
  source?: string
  expiresAt?: number
  /** 有 `refresh_token` 即为 `true`。 */
  refreshable: boolean
  /** 最近一次对账失败的原因（如有）。 */
  refreshError?: string
  /** 展示名（如 `ahansogar`）。 */
  nickname?: string
  /** 邮箱（区分同名账号用）。 */
  email?: string
}

/**
 * 凭据 → 账号池有效期的提取器。
 *
 * ⚠️ 这里**提供** `refreshableOf`（与 qiniu 刻意相反）：本家**真的有**
 * refresh 端点，`refreshable` 是凭据材料的真实镜像。
 */
const QWENWORK_EXPIRY_ACCESSORS: ExpiryAccessors<QwenworkCredential> = {
  expiresAtOf: qwenworkCredentialExpiresAtMs,
  identityOf: qwenworkIdentityOf,
  refreshableOf: isQwenworkRefreshable,
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** QwenWork Intl 的认证服务实例。 */
    qwenworkintlAuth: QwenworkIntlAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
export function parseQwenworkCredential(value: string): QwenworkCredential | undefined {
  try {
    const parsed = JSON.parse(value) as QwenworkCredential
    return typeof parsed === 'object'
      && parsed !== null
      && typeof parsed.access_token === 'string'
      && parsed.access_token.length > 0
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** `QwenworkIntlAuth` 的构造选项。 */
export interface QwenworkIntlAuthOptions {
  /** 产品配置；默认 {@link QWENWORK_INTL}。 */
  product?: QwenworkProduct
  /** 服务名覆盖（默认由产品 id 派生为 `qwenworkintlAuth`）。 */
  serviceName?: string
  /** 注入的 fetch（单测用；缺省用全局 fetch）。 */
  fetchImpl?: typeof fetch
}

/**
 * QwenWork Intl 认证服务：凭据保管 + MaaS 票据缓存 + 续期。
 */
export class QwenworkIntlAuth extends Service {
  readonly product: QwenworkProduct
  readonly credentialRefName: string

  /** 票据缓存（key = slot id）。 */
  private readonly tickets = new Map<string, QwenworkTicket>()
  /**
   * 单飞表（key = slot id）。
   *
   * ⚠️ **必须**：DSH 会并发发主回复 + 标题 + 压缩三条请求，没有这张表
   * 就会换三次票（每次都是真实上游调用）。
   */
  private readonly inflight = new Map<string, Promise<QwenworkTicket>>()
  /** per-credentialRef 的续期串行队列（三条续期入口会并发消费同一份 refresh_token）。 */
  private readonly refreshQueues = new SerialQueue()

  constructor(ctx: Context, options: QwenworkIntlAuthOptions = {}) {
    const product = options.product ?? QWENWORK_INTL
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private readonly fetchImpl: typeof fetch

  /** 面板状态：只看**池里有没有该 provider 的凭据**。 */
  async status(pool?: AccountPool): Promise<QwenworkLoginStatus> {
    if (pool === undefined) {
      const credential = await this.readCredential(this.credentialRefName)
      if (credential === undefined) return { configured: false, refreshable: false }
      return this.statusOf(credential)
    }
    for (const entry of pool.listAccountsByProvider(this.product.id)) {
      const credential = await this.readCredential(entry.credentialRef)
      if (credential === undefined) continue
      return this.statusOf(credential)
    }
    return { configured: false, refreshable: false }
  }

  private statusOf(credential: QwenworkCredential): QwenworkLoginStatus {
    const expiresAt = qwenworkCredentialExpiresAtMs(credential)
    const jwt = decodeQwenworkJwt(credential.access_token)
    return {
      configured: true,
      source: 'device-code',
      refreshable: isQwenworkRefreshable(credential),
      ...expiresAt === undefined ? {} : { expiresAt },
      ...(credential.nickname ?? jwt?.username) === undefined
        ? {}
        : { nickname: credential.nickname ?? jwt?.username },
      ...(credential.email ?? jwt?.email) === undefined
        ? {}
        : { email: credential.email ?? jwt?.email },
    }
  }

  /**
   * 取一张可用的 MaaS 票据（**带缓存 + 单飞**）。
   *
   * ⚠️ 缓存命中判据是 `expiresAtMs > now` —— 提前量已在写入时扣掉，
   * 故这里不再重复扣。
   *
   * @param slotId      账号 id（缓存的键）。
   * @param accessToken 登录 token（缓存未命中时用它换票）。
   * @param signal      中止信号。
   */
  async mintTicket(
    slotId: string,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<QwenworkTicket> {
    const cached = this.tickets.get(slotId)
    if (cached !== undefined && cached.expiresAtMs > Date.now()) return cached

    // ── 单飞：同一 slot 的并发调用共享同一个 Promise ──
    const existing = this.inflight.get(slotId)
    if (existing !== undefined) return await existing

    const task = (async (): Promise<QwenworkTicket> => {
      try {
        const ticket = await this.requestTicket(accessToken, signal)
        this.tickets.set(slotId, ticket)
        return ticket
      } finally {
        // ⚠️ 无论成败都清表单飞表：失败时留着会让下一次调用拿到**已拒绝的
        //    Promise**，从此该账号永久换不到票（单向门）。
        this.inflight.delete(slotId)
      }
    })()
    this.inflight.set(slotId, task)
    return await task
  }

  /** 真正发一次换票请求。 */
  private async requestTicket(accessToken: string, signal?: AbortSignal): Promise<QwenworkTicket> {
    const response = await this.fetchImpl(qwenworkMaasSessionUrl(this.product), {
      method: 'POST',
      headers: qwenworkHeaders(accessToken, 'application/json'),
      // ⚠️ `session_id` 必须是 uuid；上游用它做会话标识。
      body: JSON.stringify({ session_id: crypto.randomUUID() }),
      ...signal === undefined ? {} : { signal },
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new Error(
        `qwenworkintl: 换取推理票据失败（HTTP ${response.status}）——`
        + `${text.slice(0, 200) || '（上游未返回详情）'}`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('qwenworkintl: 换取推理票据的响应不是 JSON')
    }
    const data = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
      access_token?: unknown
      base_url?: unknown
      ttl_ms?: unknown
      expires_at_ms?: unknown
    }
    const token = typeof data.access_token === 'string' ? data.access_token : ''
    if (token.length === 0) {
      throw new Error('qwenworkintl: 换取推理票据的响应里没有 access_token')
    }
    // ⚠️ `base_url` 由上游下发，**绝不硬编码**（见 qwenwork-product.ts 模块头）。
    const baseUrl = typeof data.base_url === 'string' && data.base_url.length > 0
      ? data.base_url
      : this.product.fallbackInferBase
    const now = Date.now()
    // ⚠️ 优先用绝对时刻 `expires_at_ms`；否则用 `ttl_ms`；都没有则用缺省值。
    const expiresAtMs = typeof data.expires_at_ms === 'number' && Number.isFinite(data.expires_at_ms)
      ? data.expires_at_ms - TICKET_EXPIRY_MARGIN_MS
      : now + (typeof data.ttl_ms === 'number' && Number.isFinite(data.ttl_ms)
        ? data.ttl_ms
        : DEFAULT_TICKET_TTL_MS) - TICKET_EXPIRY_MARGIN_MS
    return { token, baseUrl, expiresAtMs }
  }

  /** 手动作废某账号的票据缓存（续期成功 / 401 后调用）。 */
  invalidateTicket(slotId: string): void {
    this.tickets.delete(slotId)
    this.inflight.delete(slotId)
  }

  /** 清空全部票据缓存。 */
  clearTickets(): void {
    this.tickets.clear()
    this.inflight.clear()
  }

  /**
   * 用 `refresh_token` 换新凭据。
   *
   * ⚠️ 请求体必须带 `target: 'c'`（见 `qwenworkRefreshBody` 的注释）：
   * 漏掉会得到 401 `INVALID_TOKEN`，症状与「refresh token 真的失效」同形。
   *
   * @returns 新的凭据；失败返回 `undefined`（调用方决定如何表述）。
   */
  async renewCredential(credential: QwenworkCredential, signal?: AbortSignal): Promise<QwenworkCredential | undefined> {
    const refreshToken = credential.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) return undefined
    const response = await this.fetchImpl(qwenworkDeviceRefreshUrl(this.product), {
      method: 'POST',
      headers: qwenworkHeaders(credential.access_token, 'application/json'),
      body: JSON.stringify(qwenworkRefreshBody(refreshToken, this.product)),
      ...signal === undefined ? {} : { signal },
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return undefined
    }
    const data = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    // ⚠️ 信封形状:`{ code:'ok', data:{ access, refresh, … } }` 或裸对象。
    const body = (typeof data.data === 'object' && data.data !== null ? data.data : data) as Record<string, unknown>
    const access = body.access ?? body.access_token
    if (typeof access !== 'string' || access.length === 0) return undefined
    const refresh = body.refresh ?? body.refresh_token
    const jwt = decodeQwenworkJwt(access)
    return {
      access_token: access,
      // ⚠️ 上游可能不轮换 refresh_token；此时**保留旧的**（丢掉会让账号失去续期能力）。
      ...(typeof refresh === 'string' && refresh.length > 0
        ? { refresh_token: refresh }
        : refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      // ⚠️ 统一写**毫秒**；归一化只在这里做一次。
      ...jwt?.exp === undefined ? {} : { expires_at: String(jwt.exp * 1000) },
      ...credential.user_id ?? jwt?.user_id === undefined
        ? {} : { user_id: credential.user_id ?? jwt?.user_id },
      ...credential.nickname ?? jwt?.username === undefined
        ? {} : { nickname: credential.nickname ?? jwt?.username },
      ...credential.email ?? jwt?.email === undefined
        ? {} : { email: credential.email ?? jwt?.email },
    }
  }

  /** 单凭据路径的「续期」（读默认 ref 并尝试续期）。 */
  async refresh(): Promise<void> {
    const credential = await this.readCredential(this.credentialRefName)
    if (credential === undefined) {
      throw new Error(
        `qwenworkintl: 凭据 ${this.credentialRefName} 不可用。`
        + '请在 Jet Hub 的千问办公国际版面板重新登录。',
      )
    }
    if (!isQwenworkExpired(credential) && isQwenworkRefreshable(credential)) return
    const renewed = await this.renewCredential(credential)
    if (renewed === undefined) {
      throw new Error(
        'qwenworkintl: 续期失败（refresh_token 可能已失效）。请在 Jet Hub 的面板重新登录。',
      )
    }
    await this.ctx.credentials
      .set(credentialRef(this.credentialRefName), JSON.stringify(renewed))
      .catch(() => undefined)
  }

  /**
   * 按**凭据 ref** 对账 / 续期指定账号（RPC `account.refresh` 的分派目标）。
   *
   * ⚠️ 签名里的 `pool` / `accountId` **必须接受并透传**给 `syncAccountExpiry`：
   * 它们是「续期后把新的 `expiresAt` 回写账号池」这条链路的唯一入口。
   * 缺参数能编译、类型全绿，但会**静默丢回写**
   * （`tests/unit/refresh-bootstrap-wiring.spec.ts` 会逐个 provider 扫这条不变式）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    // ⚠️ 上串行队列：三条续期入口（定时器 / 推理按需 / 面板按钮）会并发消费
    //    同一份一次性 refresh_token。⚠️ `SerialQueue.run` 的签名是
    //    `(task, options)`，**不是** `(key, task)` —— 全队列串行即可
    //    （本家续期次数很少，串行化的代价可忽略；按 key 分组的收益不值得多一层结构）。
    await this.refreshQueues.run(async () => {
      // ⚠️ **锁内重读**凭据：若在排队期间已被别的入口续好，直接对账返回，
      //    少烧一次 refresh_token（它可能是一次性的）。
      const credential = await this.readCredential(refName)
      if (credential === undefined) {
        throw new Error(
          `qwenworkintl: 凭据 ${refName} 不可用或不是合法的登录凭据。`
          + '请在 Jet Hub 的千问办公国际版面板重新登录。',
        )
      }
      let current = credential
      if (isQwenworkExpired(credential) && isQwenworkRefreshable(credential)) {
        const renewed = await this.renewCredential(credential)
        if (renewed !== undefined) {
          current = renewed
          await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(renewed)).catch(() => undefined)
          // 票据是用旧 token 换的，续期后必须作废，否则会用旧票打新会话。
          if (accountId !== undefined) this.invalidateTicket(accountId)
        }
      }
      await syncAccountExpiry({
        pool,
        provider: this.product.id,
        credential: current,
        accessors: QWENWORK_EXPIRY_ACCESSORS,
        ...accountId === undefined ? {} : { accountId },
        tag: '[qwenworkintl]',
      })
    })
  }

  /**
   * 批量对账（启动首轮 + 每 30 分钟的定时器）。
   *
   * ## ⚠️ 三条必须同时满足（AGENTS.md「续期三件事缺一不可」）
   *
   * 1. **不看 `enabled`**：停用账号的凭据同样要保持新鲜 —— 否则用户重新启用
   *    后拿到死凭据；
   * 2. **不过滤 `refreshable`**：那个布尔只是**凭据材料的镜像**，拿它当门禁会把
   *    一次瞬时失败固化成永久状态；
   * 3. **判据用凭据自己的值，不用池里的 `expiresAt`**：池值正是可能陈旧的那份数据。
   */
  async refreshAll(pool?: AccountPool): Promise<void> {
    if (pool === undefined) return
    for (const entry of pool.listAccountsByProvider(this.product.id)) {
      // ⚠️ 刻意**不判** entry.enabled、**不判** entry.refreshable（见上）。
      try {
        await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
      } catch (error) {
        // 一个坏条目不该让整池停止对账。
        this.ctx.logger?.warn?.(
          `[qwenworkintl] 账号 ${entry.id} 对账失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * 读额度（`/user/wallets` + `/user/info`）。
   *
   * ## ⚠️ 三个池**分开读**，绝不合并成「每日可用」
   *
   * 实测：`quota.remaining = 700`（= 200 daily + 500 longterm），但推理**只扣
   * daily**。把 700 显示成「每天有 700」是错的；把合计当耗尽判据会漏判
   * （daily 已空但合计还有 500 ⇒ 账号实际已不可用）。
   *
   * @param accessToken 登录 token。
   * @returns 解析结果；网络/解析失败返回 `undefined`（调用方当作「读不到」）。
   */
  async fetchBalance(accessToken: string, signal?: AbortSignal): Promise<QwenworkBalance | undefined> {
    const headers = qwenworkHeaders(accessToken, 'application/json')
    try {
      const response = await this.fetchImpl(qwenworkWalletsUrl(this.product), {
        headers,
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) return undefined
      const parsed = JSON.parse(await response.text()) as Record<string, unknown>
      const data = (typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : parsed) as Record<string, unknown>
      const numOf = (block: unknown): number | undefined => {
        if (typeof block !== 'object' || block === null) return undefined
        const value = (block as Record<string, unknown>).total_balance
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined
      }
      const active = data.active_wallets
      const rawWallets = typeof active === 'object' && active !== null
        ? (active as Record<string, unknown>).wallets
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
      const daily = numOf(data.daily_credits)
      const monthly = numOf(data.monthly_credits)
      const longterm = numOf(data.longterm_credits)
      const total = [daily, monthly, longterm]
        .filter((v): v is number => v !== undefined)
        .reduce((sum, v) => sum + v, 0)
      return {
        ...daily === undefined ? {} : { daily },
        ...monthly === undefined ? {} : { monthly },
        ...longterm === undefined ? {} : { longterm },
        wallets,
        ...total > 0 ? { total } : {},
      }
    } catch {
      return undefined
    }
  }

  /** 读套餐名（`/user/info` 的 `plan.name`；实测免费账号是 `Free`）。 */
  async fetchPlanName(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const response = await this.fetchImpl(qwenworkUserInfoUrl(this.product), {
        headers: qwenworkHeaders(accessToken, 'application/json'),
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) return undefined
      const parsed = JSON.parse(await response.text()) as Record<string, unknown>
      const data = (typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : parsed) as Record<string, unknown>
      const plan = data.plan
      if (typeof plan !== 'object' || plan === null) return undefined
      const name = (plan as Record<string, unknown>).name
      return typeof name === 'string' && name.length > 0 ? name : undefined
    } catch {
      return undefined
    }
  }

  /** 凭据是否被判定为已失效（供门控与面板用）。 */
  async checkExpired(pool?: AccountPool): Promise<boolean> {
    const status = await this.status(pool)
    if (!status.configured) return true
    if (status.expiresAt === undefined) return false
    return isQwenworkExpired({ access_token: '', expires_at: String(status.expiresAt) })
  }

  /** 读一个 ref 下的凭据（不可用或非 JSON 时返回 undefined）。 */
  private async readCredential(refName: string): Promise<QwenworkCredential | undefined> {
    const resolved = await this.ctx.credentials
      .resolve(credentialRef(refName))
      .catch(() => undefined)
    if (resolved === undefined) return undefined
    return parseQwenworkCredential(resolved.value)
  }
}

/** 默认凭据 ref（等价于 `QWENWORK_INTL.defaultCredentialRef`）。 */
export const QWENWORK_INTL_CREDENTIAL_REF: CredentialRef = credentialRef(QWENWORK_INTL.defaultCredentialRef)
