/**
 * 千问办公国际站（QwenWork Intl）的**设备码登录**（Device Code + PKCE）。
 *
 * ## ⚠️⚠️ 协议是逆向 + 实测确认的（2026-11-22），与直觉完全不同
 *
 * 完整两步，**所有状态码都经真机复现**：
 *
 * ```
 * ① 生成授权 URL（本函数纯拼串，不发请求）
 *    GET {gateway}/device/selectAccounts
 *        ?challenge=<S256(verifier)>&challenge_method=S256
 *        &nonce=<uuid>&machine_id=<uuid>
 *        &client_id=<国际站专属>&redirect_uri=qwenwork%3A%2F%2F
 *    → 302  Location: https://qwenwork.ai/oauth2/auth?...&state=<服务端生成>
 *
 * ② 轮询等用户授权
 *    GET {gateway}/api/v1/deviceToken/poll
 *        ?nonce=<uuid>&verifier=<b64url>&challenge_method=S256
 *    → 404 {}   表示**还没授权**
 *    → 200      { token, refresh_token, expires_at, user_id, user_name, … }
 * ```
 *
 * ## ⚠️⚠️ 六个坑（每一个都实测踩过）
 *
 * ### ① `selectAccounts` 的成功信号是 **302**，不是 200、也不返回 nonce
 *
 * `nonce` 是**客户端自己 `randomUUID()` 生成**的。按「请求 nonce」的思路实现
 * 无论怎么调都拿不到 —— 因为方向就是错的。
 *
 * ### ② 两边的 query 字段集合**严格互斥**，多传一个就 400 `not_allowed`
 *
 * - `selectAccounts`：`challenge` / `challenge_method` / `nonce` / `machine_id` /
 *   `client_id` / `redirect_uri`（**六字段全必需，零容忍多余字段**）
 * - `poll`：`nonce` / `verifier` / `challenge_method`（**只有三个**）
 *
 * ⚠️ `challenge` 属于前者、`verifier` 属于后者。把 `challenge` 传给 `poll`
 * 会得到 `field:"challenge", reason:"not_allowed"` —— 极易误判成「缺字段」。
 *
 * ### ③ ⚠️⚠️ `404 {}` 对「已注册未授权」和「nonce 根本不存在」**返回完全相同**
 *
 * 逐字节比对过（`indistinguishable: true`）⇒ **不能靠 404 判断 flow 是否还有效**，
 * 只能自己设超时。别写「404 就继续等」，那样 flow 失效后会白等到超时。
 *
 * ### ④ 同一 nonce 复用会 **409 `DEVICE_FLOW_REPLAYED`**
 *
 * 每次登录必须重新生成。故 `startQwenworkDeviceLogin` 内部**不接受外部 nonce**。
 *
 * ### ⑤ `cosyVersion`（1.1.71）**完全不参与登录流程**
 *
 * 它只用于聊天请求的 COSY 信封与 `Cosy-Version` 头。塞进 query 会被判 `not_allowed`。
 *
 * ### ⑥ 字段格式约束
 *
 * `nonce` 必须是 **UUID**（`abc123` ⇒ 400）；`machine_id` **不做校验**
 * （`not-a-uuid` ⇒ 仍 302）；`challenge_method` 只接受 `S256`。
 *
 * ## ⚠️ 国际站专属参数（与国内站不同，混用即 400）
 *
 * | 字段 | 国内站 | 国际站 |
 * |---|---|---|
 * | `client_id` | `e883ade2-…` | **`cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a`** |
 * | `redirect_uri` | `qwenwork-cn://` | **`qwenwork://`** |
 *
 * @module src/qwenwork-login.ts
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  qwenworkDeviceAuthUrl,
  qwenworkDevicePollUrl,
  type QwenworkCredential,
} from './qwenwork.js'
import { QWENWORK_INTL, type QwenworkProduct } from './qwenwork-product.js'

/**
 * 凭据库的最小面（只用 `set`）。
 *
 * ⚠️ 与 `codely-auth-service.ts` 的 `CredentialStoreLike` 同款：**不 import 宿主类型**
 * —— 那样会逼单测去造一个完整的 `ctx.credentials`。
 */
interface CredentialStoreLike {
  set(ref: string, value: string): Promise<void>
}

/** 一次登录流程的全部随机量（一次性，**不可复用**，见模块头坑④）。 */
export interface QwenworkDeviceFlow {
  /** PKCE verifier（`poll` 要用）。 */
  readonly verifier: string
  /** PKCE challenge = `base64url(sha256(verifier))`（`selectAccounts` 要用）。 */
  readonly challenge: string
  /** 会话绑定 id，**必须是 UUID**（见模块头坑⑥）。 */
  readonly nonce: string
  /** 机器 id，聊天请求的签名要用 ⇒ 调用方应持久化。 */
  readonly machineId: string
}

/**
 * 生成一次性的登录流程随机量。
 *
 * ⚠️ 每次登录都必须调一次（复用会被 409 `DEVICE_FLOW_REPLAYED` 拦下）。
 *
 * @param machineId 已有的机器 id（持久化过就传进来）；不传则新生成。
 */
export function createQwenworkDeviceFlow(machineId?: string): QwenworkDeviceFlow {
  // ⚠️ verifier 用 64 字节：RFC 7636 要求 43~128 字符的 base64url，
  //    64 字节 ⇒ 86 字符，落在合法区间中部（与参考实现同量级）。
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return {
    verifier,
    challenge,
    // ⚠️ 必须是 UUID 字符串（裸随机串会被判 400）。
    nonce: randomUUID(),
    machineId: machineId !== undefined && machineId.length > 0 ? machineId : randomUUID(),
  }
}

/**
 * 拼出用户要在浏览器打开的**授权 URL**（纯拼串，不发请求）。
 *
 * ⚠️ 这个 URL 打开后是 302 跳到 `qwenwork.ai/oauth2/auth`，用户在那里登录
 * 并确认授权。**不要**去 fetch 它（会把 302 跟掉、还可能消费掉 nonce）。
 *
 * ⚠️ 实现委托给 `qwenwork.ts` 的 `qwenworkDeviceAuthUrl`（**唯一一份拼串实现**）：
 * 两处各写一遍必漂移（本仓红线）。
 */
export function qwenworkSelectAccountsUrl(
  flow: QwenworkDeviceFlow,
  product: QwenworkProduct = QWENWORK_INTL,
): string {
  return qwenworkDeviceAuthUrl(flow, product)
}

/** `poll` 的结果三态。 */
export type QwenworkPollOutcome =
  /** 用户还没授权（HTTP 404 `{}`）。⚠️ 与「nonce 不存在」不可区分。 */
  | { readonly kind: 'pending' }
  /** 授权完成，拿到凭据。 */
  | { readonly kind: 'ready'; readonly credential: QwenworkCredential }
  /**
   * ⚠️ **HTTP 400 且无 `details`** = verifier 不匹配 / flow 已失效。
   *
   * 这类**不值得无限重试**（同一个 flow 再问多少次都一样），但第一次可能是
   * 瞬时抖动 ⇒ 由 `waitForQwenworkCredential` 判「连续 3 次」才判死。
   */
  | { readonly kind: 'broken'; readonly reason: string }

/** `poll` 一次（**不重试**，重试逻辑在 `waitForQwenworkCredential`）。 */
export async function pollQwenworkDeviceToken(
  flow: QwenworkDeviceFlow,
  product: QwenworkProduct = QWENWORK_INTL,
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<QwenworkPollOutcome> {
  const params = new URLSearchParams({
    // ⚠️ **只有这三个字段**。多传 `challenge` 或 `machine_id` ⇒ `not_allowed`。
    nonce: flow.nonce,
    verifier: flow.verifier,
    challenge_method: 'S256',
  })
  const url = `${qwenworkDevicePollUrl(product)}?${params.toString()}`
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    // ⚠️ 中止必须原样逃逸（铁律）。
    if ((error as { name?: unknown })?.name === 'AbortError') throw error
    // 网络抖动**不是** flow 失效 ⇒ 让上层按 pending 继续等。
    return { kind: 'pending' }
  }
  // ⚠️ **先读体**：404 也要读，且 body 只能读一次。
  const text = await response.text().catch(() => '')
  if (response.status === 404) {
    // ⚠️ 404 有两种含义（见模块头坑③），此处一律按 pending 处理，
    //    由 `waitForQwenworkCredential` 的总超时兜底。
    return { kind: 'pending' }
  }
  if (response.status === 409) {
    // 同一 nonce 重放（流程是一次性的，几乎不可能发生），按失效处理。
    return { kind: 'broken', reason: 'nonce 已被使用（DEVICE_FLOW_REPLAYED）' }
  }
  if (!response.ok) {
    return { kind: 'broken', reason: `HTTP ${response.status}：${text.slice(0, 200)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'broken', reason: '响应不是 JSON' }
  }
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
  // ⚠️ 字段名来自三家参考实现交叉印证（**未真机实测 200 响应体** ——
  //    需要一个真实账号在浏览器完成授权）。刻意同时接受 `access_token`
  //    别名：若上游改用那个名字，本实现也不会失效。
  const rawAccess = body.token ?? body.access_token
  const accessToken = typeof rawAccess === 'string' ? rawAccess.trim() : ''
  if (accessToken.length === 0) {
    // 200 但没有 token ⇒ 上游改了字段名。**不要**当成成功
    //（那会写进一张空凭据卡，用户看到「已登录」却用不了）。
    return { kind: 'broken', reason: '200 响应里没有 token 字段（上游可能改了字段名）' }
  }
  const rawRefresh = body.refresh_token
  const refreshToken = typeof rawRefresh === 'string' ? rawRefresh.trim() : ''
  const expiresAt = readExpiresAt(body)
  const userId = readString(body.user_id)
  const userName = readString(body.user_name)
  const credential: QwenworkCredential = {
    access_token: accessToken,
    ...refreshToken.length === 0 ? {} : { refresh_token: refreshToken },
    ...expiresAt === undefined ? {} : { expires_at: expiresAt },
    ...userId === undefined ? {} : { user_id: userId },
    ...userName === undefined ? {} : { nickname: userName },
    // ⚠️ machine_id 必须持久化：聊天请求的 COSY 签名与它绑定。
    machine_id: flow.machineId,
  }
  return { kind: 'ready', credential }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 从响应体读到期时刻（**毫秒**，与 `QwenworkCredential.expires_at` 的约定一致）。
 *
 * ⚠️ 读不到就**不写**，绝不编造（本仓红线）。
 */
function readExpiresAt(body: Record<string, unknown>): number | undefined {
  const at = body.expires_at
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) {
    // ⚠️ 秒/毫秒判别与 `qwenworkCredentialExpiresAtMs` 同一约定：
    //    小于 1e12 视为秒，否则毫秒。
    return at < 1e12 ? at * 1000 : at
  }
  if (typeof at === 'string' && at.length > 0) {
    const ms = Date.parse(at)
    if (Number.isFinite(ms)) return ms
  }
  const inSec = body.expires_in
  if (typeof inSec === 'number' && Number.isFinite(inSec) && inSec > 0) {
    return Date.now() + inSec * 1000
  }
  return undefined
}

/** `waitForQwenworkCredential` 的选项。 */
export interface QwenworkLoginWaitOptions {
  /** 轮询间隔（毫秒）。⚠️ 别太密：上游按 nonce 计数，过密无意义。 */
  readonly intervalMs?: number
  /** 总超时（毫秒）。⚠️ **必须自己设**：404 分不清「未授权」和「flow 失效」。 */
  readonly timeoutMs?: number
  /** 中止信号。 */
  readonly signal?: AbortSignal
  /** 注入 fetch（单测用）。 */
  readonly fetchImpl?: typeof fetch
  /** 轮询心跳（可选，用于日志/进度）。 */
  readonly onTick?: (elapsedMs: number) => void
}

/**
 * 等到用户完成授权（或超时）。
 *
 * ⚠️ **`broken` 要连续命中 3 次才判死**：第一次可能是瞬时抖动。
 * 判据与症状对得上（flow 真失效时必然连续 3 次都 broken），
 * 又不会把一次性抖动误报成「登录失败」。
 */
export async function waitForQwenworkCredential(
  flow: QwenworkDeviceFlow,
  product: QwenworkProduct = QWENWORK_INTL,
  options: QwenworkLoginWaitOptions = {},
): Promise<QwenworkCredential> {
  const intervalMs = options.intervalMs ?? 2_000
  const timeoutMs = options.timeoutMs ?? 15 * 60_000
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const started = Date.now()
  let consecutiveBroken = 0
  for (;;) {
    if (options.signal?.aborted === true) throw abortError()
    const outcome = await pollQwenworkDeviceToken(flow, product, fetchImpl, options.signal)
    if (outcome.kind === 'ready') return outcome.credential
    if (outcome.kind === 'broken') {
      consecutiveBroken += 1
      if (consecutiveBroken >= 3) {
        throw new Error(`登录流程失效：${outcome.reason}（请重新点「新建账号」）`)
      }
    } else {
      consecutiveBroken = 0
    }
    const elapsed = Date.now() - started
    if (elapsed >= timeoutMs) {
      // ⚠️ 超时文案要给出**用户可执行的下一步**，不是干巴巴的「超时」。
      throw new Error(
        `等待授权超时（${Math.round(timeoutMs / 60_000)} 分钟）。`
        + '请重新点「新建账号」并在浏览器里完成授权；'
        + '若不确定是否已授权，先看一眼 qwenwork.ai 网页是否已登录。',
      )
    }
    options.onTick?.(elapsed)
    await sleep(intervalMs, options.signal)
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** 可中止的 sleep。⚠️ 必须能被打断，否则取消登录要等满一个轮询间隔。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(abortError())
    }, { once: true })
  })
}

/** `startQwenworkDeviceLogin` 的选项。 */
export interface QwenworkDeviceLoginOptions {
  /** 凭据 ref（完整 ref，由调用方算好）。 */
  readonly ref: string
  /** 凭据库（成功后立刻落盘）。 */
  readonly credentials: CredentialStoreLike
  readonly product?: QwenworkProduct
  /** 已持久化的 machine_id（聊天签名要用，尽量复用）。 */
  readonly machineId?: string
  readonly intervalMs?: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

/** `startQwenworkDeviceLogin` 的返回值。 */
export interface StartedQwenworkLogin {
  /** 用户要在浏览器打开的授权 URL（**已含全部参数**）。 */
  readonly loginUrl: string
  /**
   * 设备码（本项目上游**不返回展示码** ⇒ 恒为空）。
   *
   * 保留字段是为了与 codely / cline 的 `StartedXxxLoginFlow` 同形
   * （`account.create` 的通用代码会读它，缺了要到处特判）。
   */
  readonly userCode?: string
  /** 后台等授权；成功后凭据已落盘，返回凭据本身。 */
  readonly result: Promise<QwenworkCredential>
  /** 取消流程。 */
  readonly close: () => Promise<void>
}

/**
 * 启动一次完整的设备码登录（两步式的第一步：**立即返回 loginUrl**）。
 *
 * ⚠️ 两步式的理由与 codearts / codely 同款：`window.open` 只在
 * 用户手势窗口内有效，后台等授权不能阻塞返回。
 *
 * ⚠️ 凭据由本函数**自己落盘**（与 codely 的
 * `startCodelyDeviceLogin({ ref, credentials })` 同款）：这样「拿到 token」
 * 与「写进凭据库」是同一个原子步骤，不会出现「poll 成功了但没落盘」的窗口
 * （进程被杀就丢号）。
 */
export async function startQwenworkDeviceLogin(
  options: QwenworkDeviceLoginOptions,
): Promise<StartedQwenworkLogin> {
  const product = options.product ?? QWENWORK_INTL
  const flow = createQwenworkDeviceFlow(options.machineId)
  const loginUrl = qwenworkSelectAccountsUrl(flow, product)
  const controller = new AbortController()
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, options.signal])

  const result = (async (): Promise<QwenworkCredential> => {
    const credential = await waitForQwenworkCredential(flow, product, {
      ...options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs },
      ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
      signal,
    })
    // ⚠️ 先落盘再返回：调用方的 `.then` 只更新账号卡片字段。
    await options.credentials.set(options.ref, JSON.stringify(credential))
    return credential
  })()
  // ⚠️ 这个 Promise 要过一会儿才交给调用方消费，期间可能已被 reject
  //    （例如调用方立刻取消）⇒ 先挂空处理器避免 Node 报「未处理的拒绝」。
  result.catch(() => {})

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    controller.abort()
  }

  return { loginUrl, result, close }
}
