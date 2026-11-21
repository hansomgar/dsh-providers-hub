/**
 * 千问办公国际站（QwenWork Intl）的凭据结构、过期判定、请求头与错误映射。
 *
 * ## 凭据形态：**设备码 OAuth（有 refresh），不是静态 Key**
 *
 * 与 qiniu / modelscope 那类「用户手工粘贴的长期 Key」不同，国际站走标准
 * 设备码授权，拿到的是**一对** `access` / `refresh`（2026-11-22 实测）：
 *
 * - `access`：JWT，`exp` 实测 15 天，用于 `Authorization: Bearer`；
 * - `refresh`：设备令牌，用于 `POST /api/v1/deviceToken/refresh`。
 *
 * ⇒ 本 provider 与 codearts / buddy / qoder / raccoon / minimax 同属
 * 「有续期链」那一类，**不是**静态材料类。
 *
 * ## ⚠️ 字段名必须是 `access_token`（不能是 `access`）
 *
 * `AccountPool.findAccountIdByCredential` 对**非 codearts** 的 provider 统一
 * 取 `access_token` 作身份标识（`src/account-pool.ts`）：
 *
 * ```ts
 * const identifierKey = provider === 'codearts' ? 'access_key_id' : 'access_token'
 * ```
 *
 * 若写成上游原样的 `access`，限流记录的账号归属会**恒匹配失败且静默** ——
 * 重测/重置按钮清不掉任何标记。故对外统一用 `access_token`，
 * 只在与上游往返时映射成 `access`（见 {@link qwenworkRefreshBody}）。
 *
 * ## ⚠️ 额度是**每日刷新**，且**只有 `daily_credits` 会被推理消耗**
 *
 * 2026-11-22 真机实测（同一账号）：
 *
 * ```json
 * GET https://qwenwork.ai/user/wallets
 * {
 *   "daily_credits":    { "total_balance": 200 },   ← 每日池，次日 00:00（UTC+8）刷新
 *   "monthly_credits":  { "total_balance": 0 },
 *   "longterm_credits": { "total_balance": 500 }    ← 注册赠送，实测有效期 3 个月
 * }
 * ```
 *
 * 推理前后的实测：`daily 200 → 199.8368`，而 `longterm` **纹丝不动**。
 * ⇒ **注册赠送的 500 不是「额外每日额度」，推理吃不到它**。这个区别决定了
 * 界面上该怎么表述（写「700/天」是错的）。
 *
 * ## ⚠️ 「临时邮箱拿不到积分」是实测事实，不是猜测
 *
 * 同一天注册的两个账号对照（2026-11-22）：
 *
 * | 邮箱 | daily | longterm | quota.remaining |
 * |---|---|---|---|
 * | `@mail.airoute.kdns.fr`（临时邮箱） | **0** | **0** | **0**（`exceeded: true`） |
 * | `@outlook.com`（正常邮箱） | **200** | **500** | **700** |
 *
 * ⇒ 用户若看不到额度，**先问邮箱类型**，不要急着怀疑插件
 * （这条要写进 README 的「各渠道的能力与限制要点」）。
 *
 * @module src/qwenwork.ts
 */

import { QWENWORK_INTL, type QwenworkProduct } from './qwenwork-product.js'

/** 一份可持久化的千问办公国际站凭据。 */
export interface QwenworkCredential {
  /**
   * 登录 access token（JWT，身份本体）。
   *
   * ⚠️ 字段名 **必须**是 `access_token`（见模块头），不要改成 `access` / `api_key`。
   */
  access_token: string
  /** 续期用的设备令牌（`POST /api/v1/deviceToken/refresh`）。 */
  refresh_token?: string
  /**
   * 毫秒时间戳（数字或数字串都行）。
   *
   * ⚠️ 统一存**毫秒**；归一化只在兑换/续期返回处做一次
   * （见 {@link qwenworkCredentialExpiresAtMs} 的秒/毫秒判别）。
   */
  expires_at?: string | number
  /** 上游用户 id（如实测的 `32ecd704-65f4-…`）；用于账号去重与卡片副标题。 */
  user_id?: string
  /** 展示名（如 `ahansogar`）。 */
  nickname?: string
  /** 邮箱（卡片上用于区分同名账号）。 */
  email?: string
  /**
   * 机器 id（设备码登录时生成，**聊天请求的 COSY 签名要用**）。
   *
   * ⚠️ 首次登录生成后必须持久化：换一个值等于换一台机器，
   * 上游可能会把同一账号当成两个设备（且签名与它绑定）。
   */
  machine_id?: string
}

/**
 * 解析凭据里的过期时刻（毫秒）。
 *
 * ⚠️ **兼容秒级时间戳**（`> 1e12` 视为毫秒，否则视为秒）—— 与 `src/buddy.ts` 的
 * `credentialExpiresAtMs` 同一约定。不兼容会让「上游/历史误写成秒」的值被当成
 * 1970 年 ⇒ **恒判已过期**、每轮无谓续期。
 *
 * @returns 毫秒时间戳；字段缺失或不可解析时 `undefined`。
 */
export function qwenworkCredentialExpiresAtMs(
  credential: QwenworkCredential | undefined,
): number | undefined {
  const raw = credential?.expires_at
  if (raw === undefined || raw === null) return undefined
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  // 秒级（10 位）与毫秒级（13 位）的分界取 1e12。
  return parsed > 1e12 ? parsed : parsed * 1000
}

/**
 * 凭据是否已过期。
 *
 * ⚠️ **没有 `expires_at` 时恒返回 `false`（= 未过期）**：读不到就说读不到，
 * 不把未知当失效（与 qiniu / loomy 同口径）。真正的失效由上游 401 反映。
 */
export function isQwenworkExpired(credential: QwenworkCredential | undefined): boolean {
  const expiresAt = qwenworkCredentialExpiresAtMs(credential)
  if (expiresAt === undefined) return false
  return expiresAt <= Date.now()
}

/**
 * 凭据是否**具备可续期的材料**。
 *
 * ⚠️ 判据是「`refresh_token` 非空」——**读凭据本身**，不读账号池里的
 * `refreshable` 布尔（那个只是镜像，拿它当门禁会把一次瞬时失败固化成永久状态，
 * 见 AGENTS.md「账号池的 `refreshable` 只是凭据材料的镜像」）。
 */
export function isQwenworkRefreshable(credential: QwenworkCredential | undefined): boolean {
  return typeof credential?.refresh_token === 'string' && credential.refresh_token.length > 0
}

/** 凭据的身份串（限流记录归属用；取不到时返回空串）。 */
export function qwenworkIdentityOf(credential: QwenworkCredential | undefined): string {
  return typeof credential?.access_token === 'string' ? credential.access_token : ''
}

/**
 * 把 token 打码成 `前 6 位…尾 4 位`（UI 一律用它，**绝不**展示明文）。
 *
 * ⚠️ 形状不合法的**返回空串**而不是回显原文 —— 打码函数绝不能成为
 * 「把任意输入原样显示」的通道。
 */
export function maskQwenworkToken(token: string | undefined | null): string {
  if (typeof token !== 'string') return ''
  const trimmed = token.trim()
  if (trimmed.length < 20) return ''
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`
}

/**
 * 解析一份 JWT 的载荷（**不验签**，只用于读 `exp` / `user_id` 等声明）。
 *
 * ⚠️ 刻意**不抛错**：JWT 结构异常时返回 `undefined`，由调用方当作「读不到」。
 * 登录落库时若因为一个畸形 token 抛错，会把「已经成功的登录」判成失败并删号
 * （本仓 `login.poll` 三态契约那轮的真实教训）。
 */
export function decodeQwenworkJwt(
  token: string | undefined,
): { exp?: number; iat?: number; user_id?: string; username?: string; email?: string } | undefined {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as Record<string, unknown>
    const out: { exp?: number; iat?: number; user_id?: string; username?: string; email?: string } = {}
    if (typeof parsed.exp === 'number') out.exp = parsed.exp
    if (typeof parsed.iat === 'number') out.iat = parsed.iat
    if (typeof parsed.user_id === 'string') out.user_id = parsed.user_id
    if (typeof parsed.username === 'string') out.username = parsed.username
    if (typeof parsed.email === 'string') out.email = parsed.email
    return out
  } catch {
    return undefined
  }
}

/**
 * 构造发往**网页域 / 网关域**的请求头。
 *
 * ## ⚠️⚠️ 只认 `Authorization: Bearer`，**cookie 一律 401**（实测）
 *
 * 这是本 provider 最容易写错的一处：网页版确实用 `token` cookie，但 API
 * **不认** cookie。2026-11-22 实测 4 种 cookie 组合（仅 token / +`__u` /
 * +`cna,isg` / 全部）**全部 401**，而同一个 token 走 Bearer 立刻 200。
 *
 * ## ⚠️ `Accept` 必须**按用途区分**
 *
 * `/models` 与 `/chat/completions` 共用 `text/event-stream` 会让部分平台的
 * 目录端点回 406（本仓实测过 ChatAnywhere）⇒ 该上游模型列表永远失败且症状隐蔽。
 * 国际站这里目录端点不可用，但辅助请求仍按用途分开，判据不依赖「某平台碰巧不校验」。
 *
 * @param accessToken  登录 access token（空串时仍产出合法头，由调用方先判有无凭据）。
 * @param accept       `'application/json'` 或 `'text/event-stream'`。
 */
export function qwenworkHeaders(
  accessToken: string,
  accept: 'application/json' | 'text/event-stream' = 'application/json',
): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept,
    authorization: `Bearer ${accessToken}`,
  }
}

/** 额度查询全 URL（网页域）。 */
export function qwenworkWalletsUrl(product: QwenworkProduct = QWENWORK_INTL): string {
  return `${product.webBase}${product.walletsPath}`
}

/** 用户信息全 URL（网页域）。 */
export function qwenworkUserInfoUrl(product: QwenworkProduct = QWENWORK_INTL): string {
  return `${product.webBase}${product.userInfoPath}`
}

/** 换 MaaS token 全 URL（网关域）。 */
export function qwenworkMaasSessionUrl(product: QwenworkProduct = QWENWORK_INTL): string {
  return `${product.gatewayBase}${product.maasSessionPath}`
}

/** 设备码轮询全 URL（网关域）。 */
export function qwenworkDevicePollUrl(product: QwenworkProduct = QWENWORK_INTL): string {
  return `${product.gatewayBase}${product.devicePollPath}`
}

/** 设备码续期全 URL（网关域）。 */
export function qwenworkDeviceRefreshUrl(product: QwenworkProduct = QWENWORK_INTL): string {
  return `${product.gatewayBase}${product.deviceRefreshPath}`
}

/** 设备码**发起**全 URL（网关域）。⚠️ 见 `qwenworkDeviceAuthUrl` 的字段约束。 */
export function qwenworkDeviceSelectUrl(product: QwenworkProduct = QWENWORK_INTL): string {
  return `${product.gatewayBase}${product.deviceAuthPath}`
}

/**
 * 设备码**发起** URL（`GET /device/selectAccounts`）。
 *
 * ## ⚠️⚠️ 六个 query 字段**一个不能少、一个不能多**（2026-11-22 实测）
 *
 * | 字段 | 说明 |
 * |---|---|
 * | `challenge` | PKCE S256 = `base64url(sha256(verifier))`，**定长格式有校验** |
 * | `challenge_method` | 只接受 `S256`（`plain` ⇒ 400） |
 * | `nonce` | **必须是 UUID 字符串**（裸随机串 ⇒ 400）；每次登录重新生成 |
 * | `machine_id` | 机器 id，**不做格式校验**（`not-a-uuid` 也 302） |
 * | `client_id` | 国际站专属值，国内站的值 ⇒ 400 |
 * | `redirect_uri` | 国际站 `qwenwork://`，国内站 `qwenwork-cn://` ⇒ 400 |
 *
 * ⚠️ **不要加 `response_type` / `scope` / `cosyVersion`** —— 任一多余字段都会
 * 得到 `400 INVALID_DEVICE_FLOW` + `field:"query", reason:"not_allowed"`
 * （那个报错是针对**整条 query** 的通用判据，指不出具体哪个字段错）。
 *
 * ⚠️ **成功信号是 302**（跳到 `qwenwork.ai/oauth2/auth`），不是 200 JSON。
 * 本函数只拼串、**不发请求** —— 由用户在浏览器打开。
 *
 * @param flow PKCE 三件套 + nonce + machine_id（见 `createQwenworkDeviceFlow`）。
 * @param product 产品配置。
 */
export function qwenworkDeviceAuthUrl(
  flow: {
    readonly challenge: string
    readonly challengeMethod?: string
    readonly nonce: string
    readonly machineId: string
  },
  product: QwenworkProduct = QWENWORK_INTL,
): string {
  const params = new URLSearchParams({
    challenge: flow.challenge,
    challenge_method: flow.challengeMethod ?? 'S256',
    nonce: flow.nonce,
    machine_id: flow.machineId,
    client_id: product.clientId,
    redirect_uri: product.redirectScheme,
  })
  return `${qwenworkDeviceSelectUrl(product)}?${params.toString()}`
}

/**
 * 续期请求体。
 *
 * ## ⚠️ 必须带 `target: 'c'`（实测）
 *
 * 国际站的续期体是 `{ refresh_token, target: 'c' }`。
 * 浏览器登录形态额外带 `target: 'biz'` + `team_id` / `client_id` / `redirect_uri`。
 * **漏掉 `target` 会得到 401 `INVALID_TOKEN`**，症状与「refresh token 真的失效」
 * 同形（本仓 minimax「把上游故障窗口当成设计」那轮的教训：先让参考实现复现）。
 *
 * @param refreshToken 续期令牌。
 * @param product      产品配置（用于 `client_id` / `redirect_uri`）。
 * @param opts         `biz` 形态所需的附加字段。
 */
export function qwenworkRefreshBody(
  refreshToken: string,
  product: QwenworkProduct = QWENWORK_INTL,
  opts: { target?: 'c' | 'biz'; teamId?: string } = {},
): Record<string, string> {
  const target = opts.target ?? 'c'
  if (target === 'biz') {
    return {
      refresh_token: refreshToken,
      target: 'biz',
      ...opts.teamId === undefined ? {} : { team_id: opts.teamId },
      client_id: product.clientId,
      redirect_uri: product.redirectScheme,
    }
  }
  return { refresh_token: refreshToken, target: 'c' }
}

/**
 * 归一化模型 id。
 *
 * ⚠️ 本函数**只做去空白**，**刻意不做**任何前缀剥离/大小写归一 ——
 * 国际站的模型 id 是 `flash` / `glm-5.3` 这种裸档位名，剥任何东西都会 400。
 * 存在的意义是把「调用方忘了 trim」收敛到一处，并让「不剥前缀」这条判据
 * 有一处可被单测点名的地方。
 */
export function normalizeQwenworkModelId(raw: string): string {
  return raw.trim()
}

/**
 * 判断一份额度响应里「每日可用」是不是真的耗尽。
 *
 * ## ⚠️ 为什么不能只看 `quota.remaining`
 *
 * `quota.remaining` 是**三个池的合计**（实测 `700 = 200 daily + 500 longterm`），
 * 而推理**只扣 daily**。⇒ 合计 500 的账号实际上**已经用不了**（daily 已空），
 * 但 `remaining` 仍显示 500。拿合计判耗尽会**漏判**，拿它判「还能用」会**误放行**。
 *
 * @param daily  `daily_credits.total_balance`；读不到时传 `undefined`。
 * @returns `true` = 确定耗尽；`false` = 还有余量；`undefined` = 读不到（**不得**判耗尽）。
 */
export function qwenworkDailyExhausted(daily: number | undefined): boolean | undefined {
  if (daily === undefined || !Number.isFinite(daily)) return undefined
  return daily <= 0
}
