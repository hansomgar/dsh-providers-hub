/**
 * 千问办公国际站（QwenWork Intl，qwenwork.ai）产品配置、模型表与错误分类。
 *
 * ## 协议形态：**两段式** OpenAI 兼容（不是单一 baseUrl）
 *
 * 与其它 OpenAI 兼容 provider 的**根本差异**：千问办公国际站没有「一个 baseUrl
 * 从头用到尾」的形态，而是**每次会话先换一次 MaaS token**，再用返回的
 * `base_url` 发推理请求。实测链路（2026-11-22 真机，全部 HTTP 200）：
 *
 * ```
 * ① 设备码登录        POST https://gateway.qwenwork.ai/device/selectAccounts
 *                     POST https://gateway.qwenwork.ai/api/v1/deviceToken/poll
 *                     → access_token（JWT，实测有效期 15 天）
 *
 * ② 换 MaaS token     POST https://gateway.qwenwork.ai/api/desktop-sessions
 *                     Header: Authorization: Bearer <access_token>
 *                     Body:   { "session_id": "<uuid>" }
 *                     → 201 { access_token, base_url: "https://api1.qwenwork.ai",
 *                             expires_at_ms, session_id, ttl_ms: 7200000 }
 *
 * ③ 推理              POST {base_url}/v1/chat/completions
 *                     Header: Authorization: Bearer <maas_token>
 * ```
 *
 * ⚠️ **`base_url` 由上游下发，绝不硬编码** —— 实测值是
 * `https://api1.qwenwork.ai`，但那是换 token 那一刻的决定（可能是任意 `apiN`
 * 节点）。硬编码会在上游轮换节点时整条渠道失效，且症状是「所有请求 404」
 * （与「没有这个模型」同形，无法诊断）。
 *
 * ## ⚠️⚠️ 鉴权：**Bearer，不是 cookie**（2026-11-22 实测，两次踩到）
 *
 * 网页域 `qwenwork.ai/user/*` 与网关域 `gateway.qwenwork.ai/api/*` 都只认
 * `Authorization: Bearer <token>`：
 *
 * - 用 `Cookie: token=<jwt>` ⇒ **全部 401**（这是最容易被「网页用 cookie」
 *   这一直觉带偏的地方，实测 4 种 cookie 组合全部 401）；
 * - 用 `Authorization: Bearer <jwt>` ⇒ 200。
 *
 * 唯一例外：换 MaaS token 之后那一段（`{base_url}/v1/*`）用的是 **MaaS token**，
 * 不是登录 token —— 两者不可混用。
 *
 * ## 模型 id：**必须用真实档位名，不能用 `qwork-*`**（实测）
 *
 * | 名称 | 结果 |
 * |---|---|
 * | `qwork-auto` / `qwork-lite` / `qwork-standard` / `qwork-advanced` / `qwork-ultimate` | ❌ 400 |
 * | `flash` / `pro` / `deepseek-flash` / `glm-5.3` … | ✅ 200 |
 *
 * ⚠️ magpie 的 `QWENWORK_MODELS` 里写的 `qwen3.8-max-preview` 也**不是**可用的
 * 名字（400），正确的是 `qwen3.8-max`。故本文件**只登记实测 200 的 id**。
 *
 * ## 上下文窗口：实测 **≥1,000,000** 可用（不是猜测）
 *
 * 2026-11-22 逐档实测（`glm-5.3-flash`，`word ` 近似 1 token）：
 *
 * | 输入 token | 结果 |
 * |---|---|
 * | 5,013 / 20,013 / 80,013 / 300,013 / 400,000 / 500,000 / 700,000 / 1,000,000 | ✅ 200 |
 * | 1,200,000 | ❌ 400 `context_length_exceeded` |
 *
 * ⇒ 兜底表统一记 `1_000_000`（**实测已通过的最大值**，不是上限的精确值）。
 * ⚠️ `context_length_exceeded` 这条错误码**必须**归「上下文超限」而不是额度
 * —— 归额度会让账号被封到次日零点（本仓 loomy 事故同型，见 classify 的顺序注释）。
 *
 * ## ⚠️ 图片：**只有部分模型收图**，且必须按模型区分
 *
 * 2026-11-22 实测（22×22 纯红 PNG，问「什么颜色」）：
 *
 * | 收图 | 模型 |
 * |---|---|
 * | ✅ | `flash`、`glm-5.3-flash`、`deepseek-flash`、`deepseek-v4-pro`、`qwen3.8-max`、`qwen4-max`、`kimi-k3.1-pro` |
 * | ❌ 400 | `pro`、`glm-5.3` |
 *
 * ⇒ 兜底表按模型逐条记 `supportsImage`，**绝不整表一律 true**
 * （本仓硬约定：「声明支持就必须真支持」；漏报 false 会让模型对图片幻觉出答案，
 * HTTP 200 且不报错）。
 *
 * ## 思考档位：`reasoning_effort` 实测**生效**
 *
 * 2026-11-22 实测（`glm-5.3-flash`，问一道需要思考的题）：
 *
 * | 请求 | reasoning_tokens | 有 reasoning_content |
 * |---|---|---|
 * | 不带参数 | 0 | false |
 * | `reasoning_effort: "high"` | **35** | **true** |
 * | `reasoning_effort: "low"` | 0 | false |
 * | `thinking: { type: 'enabled' }` | 19 | true |
 *
 * ⇒ 声明的档位是 `['low', 'high']`（上游**不下发**每模型支持哪几档的内容目录，
 * 但顶层参数通用生效）。⚠️ 档位数组顺序 = **强度序（弱 → 强）**，这是本仓
 * `protocol-wire.md` 的不变式（DSH 把它当展示顺序）。
 *
 * @module src/qwenwork-product.ts
 */

import { retryAfterMsFromRecord } from './retry-after.js'

/** 千问办公国际站的产品配置。 */
export interface QwenworkProduct {
  /** provider id（⚠️ **纯小写字母**：同时是 cordis 服务名与客户端 key）。 */
  readonly id: 'qwenworkintl'
  /**
   * 展示名。
   *
   * ⚠️ 必须与客户端 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` 里
   * 该条 `label` **逐字一致**。
   */
  readonly displayName: string
  /** 网页域（额度查询、用户信息）。**无 `/v1`**。 */
  readonly webBase: string
  /** 网关域（设备码登录、换 MaaS token）。**无 `/v1`**。 */
  readonly gatewayBase: string
  /**
   * 推理 base URL 的**兜底**值。
   *
   * ⚠️ 只在上游换 token 响应里**没有** `base_url` 时才用；正常路径一律用
   * 上游下发的那个（见模块头）。
   */
  readonly fallbackInferBase: string
  /** 额度查询路径（拼在 webBase 之后）。 */
  readonly walletsPath: string
  /** 用户信息路径（拼在 webBase 之后）。 */
  readonly userInfoPath: string
  /** 设备码授权页路径（拼在 gatewayBase 之后）。 */
  readonly deviceAuthPath: string
  /** 设备码轮询路径（拼在 gatewayBase 之后）。 */
  readonly devicePollPath: string
  /** 设备码续期路径（拼在 gatewayBase 之后）。 */
  readonly deviceRefreshPath: string
  /** 换 MaaS token 路径（拼在 gatewayBase 之后）。 */
  readonly maasSessionPath: string
  /** OpenAI 兼容元信息路径（拼在**账号上下文**路径之后，见下）。 */
  readonly accountContextPath: string
  /**
   * 设备码登录的 OAuth `client_id`。
   *
   * ⚠️ **国际站与国内站不同**（2026-11-22 实测）：
   * - 国内站 `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`；
   * - **国际站 `cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a`**。
   *
   * 用错会得到 `400 INVALID_DEVICE_FLOW`（实测确认，两个字段必须成对）。
   */
  readonly clientId: string
  /**
   * 设备码登录的回调协议。
   *
   * ⚠️ 同样两站不同：国内站 `qwenwork-cn://`，**国际站 `qwenwork://`**。
   * 与 clientId 混用同样 `400 INVALID_DEVICE_FLOW`。
   */
  readonly redirectScheme: string
  /** 等首个 token 的空闲超时（毫秒）。 */
  readonly chatHeaderTimeoutMs: number
  /** 两次 chunk 之间的空闲超时（毫秒）。 */
  readonly chunkTimeoutMs: number
  /** 额度/目录等辅助请求超时（毫秒）。 */
  readonly catalogTimeoutMs: number
  /** 单凭据回退 ref。 */
  readonly defaultCredentialRef: string
}

export const QWENWORK_INTL: QwenworkProduct = {
  id: 'qwenworkintl',
  // ⚠️ 与客户端 PROVIDERS 的 label 逐字一致。
  displayName: 'QwenWork (国际版)',
  webBase: 'https://qwenwork.ai',
  gatewayBase: 'https://gateway.qwenwork.ai',
  fallbackInferBase: 'https://api1.qwenwork.ai',
  walletsPath: '/user/wallets',
  userInfoPath: '/user/info',
  deviceAuthPath: '/device/selectAccounts',
  devicePollPath: '/api/v1/deviceToken/poll',
  deviceRefreshPath: '/api/v1/deviceToken/refresh',
  maasSessionPath: '/api/desktop-sessions',
  accountContextPath: '/api/v1/adapter/user/account-context',
  // ⚠️ 国际站专属（与国内站不同，混用即 400 INVALID_DEVICE_FLOW）。
  clientId: 'cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a',
  redirectScheme: 'qwenwork://',
  chatHeaderTimeoutMs: 90_000,
  chunkTimeoutMs: 180_000,
  catalogTimeoutMs: 20_000,
  defaultCredentialRef: 'QWENWORK_INTL_ACCESS_TOKEN',
}

/** 兜底模型目录条目。 */
export interface QwenworkFallbackModel {
  /** 上游真实模型 id（**实测 200 的那个名字**，见模块头的对照表）。 */
  id: string
  /** 展示名。 */
  name: string
  /**
   * 上下文窗口。
   *
   * ⚠️ `0` 是「**不知道**」哨兵，不是合法窗口；
   * `resolveModel` 判 `> 0` 才下发 `context`。
   */
  contextWindow: number
  /** 是否支持图片输入（**逐模型实测**，见模块头的图片矩阵）。 */
  supportsImage: boolean
  /** 支持的思考档位（上游 wire 值，**强度序弱 → 强**）。 */
  efforts?: readonly string[]
}

/**
 * 兜底模型表（**2026-11-22 真机实测快照**）。
 *
 * ## 为什么必须有一张非空的表
 *
 * 国际站的**模型目录端点拿不到**：`gateway.qwenwork.ai/algo/api/v2/model/list`
 * 实测 **403**（需要 WASM 签名，那是 qoder 那套基础设施，国际站此处没有）。
 * 而 `/v1/models` 实测 **404**（换 MaaS token 之后打也没有）。
 *
 * ⇒ 直接把兜底表置空的代价是本仓实测过的（`qiniu-product.ts` 模块头详述）：
 * `listAllModels()` 冷缓存恒 `[]` ⇒ `provider.status` 的 `models.total` 恒 0
 * ⇒ 设置页把整个 provider 误显示为「已关闭」，且模型选择器里无模型可关。
 *
 * 故这张表就是**唯一权威来源**，条目全部来自 9 个模型逐个「发一条真请求拿到
 * 200」的实测（见 `docs/agent-notes/providers-qwenwork-intl.md`）。
 *
 * ## ⚠️ 上游加模型后这张表会腐坏
 *
 * 这是**已知缺陷且已登记**：国际站没有可读的目录端点，无法远端刷新。
 * 缓解手段是「未知模型仍可手填 id 使用」+ 用户在面板上可随时改；
 * 若上游新增模型，需要更新这张表并发版。**不能**靠猜名字来「补全」——
 * 猜错的名字会得到 400，症状与「账号没权限」同形。
 */
export const QWENWORK_INTL_FALLBACK_MODELS: readonly QwenworkFallbackModel[] = [
  // ── 实测最快的档位（0.0933 分/10k 输入，200 分可跑约 2000 轮）──
  { id: 'flash', name: '标准 (flash)', contextWindow: 1_000_000, supportsImage: true, efforts: ['low', 'high'] },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_000_000, supportsImage: true, efforts: ['low', 'high'] },
  { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1_000_000, supportsImage: true, efforts: ['low', 'high'] },
  // ── 高级档位 ──
  // ⚠️ `pro` 与 `glm-5.3` **不收图**（实测 400），故 supportsImage: false。
  { id: 'pro', name: '高级 (pro)', contextWindow: 1_000_000, supportsImage: false, efforts: ['low', 'high'] },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: false, efforts: ['low', 'high'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, supportsImage: true, efforts: ['low', 'high'] },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, efforts: ['low', 'high'] },
  { id: 'qwen4-max', name: 'Qwen4-Max', contextWindow: 1_000_000, supportsImage: true, efforts: ['low', 'high'] },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1_000_000, supportsImage: true, efforts: ['low', 'high'] },
]

/** 该模型是否为兜底表里登记过的。 */
export function isKnownQwenworkModel(id: string): boolean {
  return QWENWORK_INTL_FALLBACK_MODELS.some((m) => m.id === id)
}

export type QwenworkErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'server'
  | 'transport'
  | 'invalid_request'
  // ⚠️ 上下文窗口超限：既不是配额也不是限流 —— 不写冷却标记、不重试，
  //   直接把原文抛出去，让宿主走溢出压缩。
  | 'context_window'

export interface QwenworkErrorInfo {
  kind: QwenworkErrorKind
  /** 服务端要求的等待时长（毫秒）；仅在限流类错误上产出。 */
  retryAfterMs?: number
  /** 面向用户的可读描述（**禁止**裸 JSON）。 */
  detail: string
}

/** 从错误体里抽出人可读片段（禁止把整坨 JSON 抛给用户）。 */
function readableDetail(body: string): string {
  const text = body.trim()
  if (text === '') return '（上游未返回错误详情）'
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown; msg?: unknown; errorMessage?: unknown }
    const nested = typeof data.error === 'object' && data.error !== null
      ? (data.error as { message?: unknown; code?: unknown })
      : undefined
    // 千问办公的形状是 `{ error: { code, message, type } }`，
    // 实测还有 `{ errorCode, errorMessage }`（gateway 侧登录失败）。
    const parts = [
      typeof nested?.message === 'string' ? nested.message : undefined,
      typeof nested?.code === 'string' ? `(${nested.code})` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.msg === 'string' ? data.msg : undefined,
      typeof data.errorMessage === 'string' ? data.errorMessage : undefined,
      typeof data.error === 'string' ? data.error : undefined,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON：直接截断原文
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/**
 * 把一次失败的 HTTP 响应归类为语义化错误。
 *
 * ## ⚠️ 顺序即优先级（与 qiniu 同构，逐条都有实测依据）
 *
 * 1. **上下文超限排最前** —— 实测上游回
 *    `{"error":{"code":"context_length_exceeded",...}}`；
 *    归 quota 会让账号被封到次日零点（本仓 loomy「全池被封」事故同型）。
 * 2. **401/403 先判，恒归 `auth`** —— 认证是**账号态**、不是模型冷却；
 *    落 quota 会被 `markLimited` 写成次日零点冷却，把认证故障放大成封池。
 * 3. **额度判定必须认 `balance_insufficient`**（实测原文）——
 *    这是国际站额度耗尽的确切码，且它是 **HTTP 429**（不是 402）：
 *    ```json
 *    {"error":{"code":"balance_insufficient","type":"insufficient_quota"}}
 *    ```
 *    ⚠️ 所以**不能**只按「429 ⇒ 限流」处理：429 + `balance_insufficient`
 *    是**额度**（冷却到次日 00:00），429 + 其它是**限流**（短退避）。
 *    这与本仓 `AGENTS.md` 的「额度类业务码不是一个值，是一条链」同型。
 * 4. **限流 / 传输 / 形状 / 服务端**依次兜底。
 * 5. `retry-after` 由响应头给出（`retry-after.ts`，`0` 是合法值）。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export function classifyQwenworkError(
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): QwenworkErrorInfo {
  const retryAfterMs = retryAfterMsFromRecord(headers)
  const detail = readableDetail(body)
  const lower = body.toLowerCase()

  // ── 1. 上下文超限（必须最先判，见上）──
  if (
    lower.includes('context_length_exceeded')
    || lower.includes('context length exceeded')
    || lower.includes('maximum context length')
    || lower.includes('context window')
    || (lower.includes('context') && lower.includes('limit'))
    || lower.includes('too many tokens')
    || lower.includes('input tokens exceed')
  ) {
    return { kind: 'context_window', detail }
  }

  // ── 2. 认证先于额度/限流（不变式：宁可漏判额度，不可误判成封号）──
  if (status === 401 || status === 403) return { kind: 'auth', detail }

  // ── 3. 额度：必须认国际站的确切码，且它走 HTTP 429 ──
  // ⚠️ 这一段**必须在** rate_limit 之前：`balance_insufficient` 也是 429。
  if (
    lower.includes('balance_insufficient')
    || lower.includes('insufficient_quota')
    || lower.includes('insufficient balance')
    || lower.includes('insufficient')
    || status === 402
  ) {
    return { kind: 'quota', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }

  // ── 4. 限流 ──
  if (
    status === 429
    || lower.includes('too many requests')
    || lower.includes('rate limit')
    || lower.includes('throttl')
  ) {
    return { kind: 'rate_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }

  // ── 5. 传输层 ──
  if (
    status === 0
    || lower.includes('fetch failed')
    || lower.includes('terminated')
    || lower.includes('econnreset')
    || lower.includes('socket hang up')
    || lower.includes('getaddrinfo')
    || lower.includes('econnrefused')
  ) {
    return { kind: 'transport', detail }
  }

  // ── 6. 形状（400/422：与账号无关，白重试无益）──
  if (status === 400 || status === 422) return { kind: 'invalid_request', detail }
  if (status >= 500) return { kind: 'server', detail }
  return { kind: 'server', detail }
}
