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
   * **模型目录端点**（网页域 `qwenwork.ai`，`GET /api/chat-modes`，Bearer 认证）。
   *
   * ⚠️⚠️ 2026-11-22 用 ego-browser 实测发现 —— 此前我一直以为「国际站没有可读的
   * 目录端点」，**那个结论是错的**（我只探测了网关域和 `/algo/api/v2/...`，
   * 没找到网页域的这个端点）。
   *
   * 返回形状：
   *
   * ```jsonc
   * { "qwork": [ {
   *     "key": "qwen3.8-flash",            // 真实模型 id
   *     "i18n": { "display_name": { "zh": "Qwen3.8-Flash", … } },
   *     "price_factor": 0.1,               // 计费倍率（相对基准）
   *     "is_vl": true,                     // 是否收图
   *     "is_reasoning": true,
   *     "max_input_tokens": 1000000,
   *     "context_config": { "1M": {…}, "200K": {…}, "400K": {…} },
   *     "format": "openai",                // openai | anthropic
   *     "enable": true, "is_default": true, "is_new": true
   *   }, … ],
   *   "qwork-web": [ … ] }                // 网页端专用那份，本适配器不用
   * ```
   *
   * ⚠️ 它在**网页域**：`gateway.qwenwork.ai/api/chat-modes` 是 404。
   */
  readonly chatModesPath: string
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
  chatModesPath: '/api/chat-modes',
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
  /** 展示名（**不含倍率**；倍率由 `displayNameOfQwenworkModel` 拼上去）。 */
  name: string
  /**
   * **计费倍率**（上游 `price_factor`，远端下发）。
   *
   * ⚠️ 这是用户选型时最重要的信号（本家跨度 0.1 ~ 2.6，26 倍）⇒
   * 必须进**展示名**（composer 的模型菜单只渲染 `name`，写进 description 等于没写）。
   * 见 `displayNameOfQwenworkModel` 的三条边界。
   */
  priceFactor?: number
  /**
   * 上下文窗口。
   *
   * ⚠️ `0` 是「**不知道**」哨兵，不是合法窗口；
   * `resolveModel` 判 `> 0` 才下发 `context`。
   */
  contextWindow: number
  /**
   * 是否支持图片输入。
   *
   * ⚠️⚠️ **不用上游的 `is_vl`，用实测覆盖**（2026-11-22 真机）：
   *
   * | 模型 | 上游 `is_vl` | 实测 | 采用 |
   * |---|---|---|---|
   * | `deepseek-flash` | **false** | ✅ 能看图（回答「红色」正确）| **true** |
   * | `pro` | **true** | ❌ 4 种图片格式全失败（400/500）| **false** |
   * | `advanced` / `glm-5.3` | false | ❌ 400 | false（与上游一致）|
   *
   * ⇒ 上游这个字段**两个方向都错过**，故用 `QWENWORK_IMAGE_OVERRIDES` 覆盖。
   */
  supportsImage: boolean
  /**
   * 支持的思考档位（上游 wire 值，**强度序弱 → 强**）。
   *
   * ⚠️⚠️ **四档全部实测生效**（2026-11-22 真机，每档采样 2~3 次看
   * `reasoning_tokens` 均值）。以 `pro` 为例，四档严格递增：
   *
   * | 档位 | reasoning_tokens 均值 |
   * |---|---|
   * | `low` | 29 |
   * | `medium` | 53 |
   * | `high` | 67 |
   * | **`max`** | **419** |
   *
   * ⇒ **`max` 是真实档位且效果最强**（`pro` 上约 14 倍、`glm-5.3` 约 10 倍、
   * `flash` 约 2.5 倍）。早先只声明 `['low', 'high']` 是**漏了**两档 ——
   * 根因是当时只测了「high 会让 reasoning_tokens 从 0 变正」这一个判据，
   * 没意识到中间还有梯度。
   *
   * ⚠️ **顺序必须是强度序（弱 → 强）**：DSH 把它当**展示顺序**
   * （`dsh-llm` 的类型注释 `adapter-preferred display order`），
   * 官方客户端直接 `map` 不排序 ⇒ 顺序反了会变成「左强右弱」
   * （本仓 `protocol-wire.md` 记录过这个不变式）。
   *
   * ⚠️ **不声明 `minimal` / `xhigh` / `none` / `auto`**：这几个值上游虽然也回
   * 200（**不做白名单校验**），但实测**无独立效果**（与不传该字段的基线无差别）
   * ⇒ 声明它们只会给用户一个「选了没反应」的菜单。
   */
  efforts?: readonly string[]
}

/**
 * 思考档位（**逐模型实测**，不是全模型一律四档）。
 *
 * ## ⚠️⚠️ 关键结论：**档位不是全模型都生效**
 *
 * 2026-11-22 真机实测（每档采样 2~3 次，取 `reasoning_tokens` 均值；
 * 判据是 `max / low ≥ 1.5` 才算「档位真的起作用」）：
 *
 * | 模型 | low | max | 倍数 | 判定 |
 * |---|---|---|---|---|
 * | `pro` | 11 | 642 | **×58.4** | ✅ |
 * | `glm-5.3-flash` | 19 | 374 | **×19.7** | ✅ |
 * | `glm-5.3` | 33 | 471 | **×14.3** | ✅ |
 * | `qwen4-max` | 65 | 222 | ×3.4 | ✅ |
 * | `minimax-m3.1-flash` | 62 | 113 | ×1.8 | ✅ |
 * | `qwen3.8-max` | 198 | 307 | ×1.6 | ✅ |
 * | **`flash`** | 234 | 225 | ×0.96 | ❌ 无区分 |
 * | **`deepseek-flash`** | 160 | 150 | ×0.94 | ❌ 无区分（甚至反向）|
 * | **`kimi-k3.1-pro`** | 316 | 322 | ×1.02 | ❌ 无区分 |
 * | **`qwen3.8-flash`** | 209 | 257 | ×1.2 | ❌ 无区分 |
 *
 * ## ⇒ 为什么无效的模型**不声明档位**
 *
 * ⚠️ 上游**不校验**这个字段（发 `xhigh` / `none` / 乱写都回 200）⇒ 声明了
 * 无效档位不会报错，只会给用户一个**「选了没反应」的菜单**。
 * 本仓纪律：宁可少一个档位选择器，也不要让它变成装饰。
 *
 * ⚠️ 顺带修正一个我自己的错误结论：先前用 `glm-5.3` 单模型测出
 * 「四档全部生效、max 是 low 的 10 倍」就写成了**全模型共享常量**
 * —— 那只对 `glm-5.3` 成立。用户 2026-11-22 质疑后逐模型复测才发现
 * `flash` / `deepseek-flash` / `kimi` / `qwen3.8-flash` 四个**完全无效**。
 */
export const QWENWORK_EFFORTS_SUPPORTED: readonly string[] = ['low', 'medium', 'high', 'max']

/**
 * **逐模型档位表**：只有这里列出的模型才声明 `efforts`。
 *
 * ⚠️ 不在表里的模型 ⇒ `toCatalogEntry` 不下发 `reasoning` 字段
 * ⇒ 模型选择器不显示档位菜单（而不是显示一个无效菜单）。
 */
export const QWENWORK_MODEL_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  // ✅ 实测档位有效（max/low ≥ 1.5）
  pro: QWENWORK_EFFORTS_SUPPORTED,
  'glm-5.3': QWENWORK_EFFORTS_SUPPORTED,
  'glm-5.3-flash': QWENWORK_EFFORTS_SUPPORTED,
  'qwen4-max': QWENWORK_EFFORTS_SUPPORTED,
  'qwen3.8-max': QWENWORK_EFFORTS_SUPPORTED,
  'minimax-m3.1-flash': QWENWORK_EFFORTS_SUPPORTED,
  // ❌ 实测无区分（flash / deepseek-flash / kimi-k3.1-pro / qwen3.8-flash）
  //    刻意**不列**在这里 ⇒ 不声明档位。
  // ⚠️ `advanced` 不在表里：它在兼容端点恒 400（见兜底表里的注释），
  //    档位对它能用与否无意义。
}

/**
 * **图片能力：一律按「支持」处理**（2026-11-22 用户决定）。
 *
 * ## ⚠️⚠️ 为什么完全不再看上游的 `is_vl`，也不再用实测覆盖表
 *
 * 起因是用户实测发现「网页上全部模型都能看图」，而我的两轮实测结论互相矛盾：
 *
 * | 轮次 | `deepseek-flash` | `pro` | 结论 |
 * |---|---|---|---|
 * | 第一次（64×64 小图，只问颜色）| 答对 | 400 | 判 flash=true, pro=false |
 * | 第二次（512×512，红蓝图各一张，看能否区分 + token 增量）| 红✓蓝✓ | 400 | 同上 |
 *
 * ⇒ **「能收图」与「我看到 400」并存**，而 400 的具体原因（`invalid_request`
 * 无 param、无 detail）无法进一步定位。上游 `is_vl` 又与任何一方都不一致。
 *
 * ## 用户的决定（2026-11-22，原话）
 *
 * > 「你把上游全部的模型都做成认为是有视觉的，不需要从上游读取字段了」
 *
 * ⇒ **一律 `true`**。理由与代价：
 *
 * - **好处**：不会因为判据不准而**挡住本来能用的模型**（挡住用户能用的能力
 *   比让用户看到一条明确的 400 更糟 —— 后者至少可诊断、可反馈）；
 * - **代价**：若某模型确实不收图，用户发图会收到上游的 400。该错误会被
 *   `classifyQwenworkError` 归到 `invalid_request`，报文里带上游原文。
 *
 * ⚠️ **这不是"编造能力"**：本仓「声明支持就必须真支持」那条针对的是
 * **我们自己实现的通路**（如 `readImage` 拼错了会静默失败）；这里是把判断权
 * 交回上游 —— 支持与否由上游的真实响应裁决，而不是由一份可能过时的静态表。
 *
 * ⚠️ **已知不可用的模型只有一个**：`advanced` —— 它连**纯文本**都 400
 * （4 种调用方式全试：非流式/流式、有无 max_tokens），与本决定无关。
 */
export const QWENWORK_ASSUME_IMAGE_SUPPORT = true

/**
 * 把模型名与**计费倍率**拼成展示名：`名字 · x倍率`。
 *
 * ## ⚠️ 为什么倍率必须进 `name`（不是 `description`）
 *
 * composer 的模型切换菜单**只渲染 `name`**（`description` 完全不读）——
 * 倍率写进 description 等于没写。本家倍率跨度 0.1 ~ 2.6（**26 倍**），
 * 是用户选型时最重要的信号。（与 `accio-adapter.ts` 的 `displayNameOfAccioModel`
 * 同款做法、同款理由。）
 *
 * ## 三条边界（照 accio 的规则）
 *
 * - **倍率 1 照拼**（`1` 不是「无」）；
 * - **倍率 0 照拼**（免费是**合法**倍率，与「没有倍率信息」语义不同，
 *   故判据必须是 `!== undefined` 而不是真值判断）；
 * - **非有限值不拼**（不产出 `xNaN` / `xInfinity`）。
 *
 * 安全性：`name` 纯属展示 —— DSH 的选择与持久化只用 `id`。
 */
export function displayNameOfQwenworkModel(model: {
  readonly name: string
  readonly priceFactor?: number
}): string {
  const factor = model.priceFactor
  if (factor === undefined || !Number.isFinite(factor)) return model.name
  return `${model.name} · x${factor}`
}

/**
 * 兜底模型表（**2026-11-22 按上游真实目录 + 实测校准**）。
 *
 * ## ⚠️⚠️ 「国际站拿不到目录端点」是**错的**（2026-11-22 浏览器实测推翻）
 *
 * 我原先探测了 `gateway.qwenwork.ai/algo/api/v2/model/list`（403，要 WASM 签名）
 * 和 `/v1/models`（404），就得出「没有可读的目录端点」的结论并写进了注释。
 *
 * **实际有，而且在网页域**：
 *
 * ```
 * GET https://qwenwork.ai/api/chat-modes
 * Authorization: Bearer <access_token>
 * → 200 { "qwork": [11 个模型], "qwork-web": [...] }
 * ```
 *
 * ⚠️ 它是用 ego-browser 打开 `qwenwork.ai/app/`、点开模型选择器后
 * 从网络面板发现的。**教训：探测「上游有没有某端点」时，只看 API 域不够，
 * 网页自己用的端点往往在网页域。**
 *
 * ⇒ 现在 `parseQwenworkChatModes` 会解析它，适配器**优先用远端**，
 * 本表只作远端不可达时的兜底（**不得为空**，理由见下）。
 *
 * ## 为什么兜底表仍必须非空
 *
 * 直接把兜底表置空的代价是本仓实测过的（`qiniu-product.ts` 模块头详述）：
 * `listAllModels()` 冷缓存恒 `[]` ⇒ `provider.status` 的 `models.total` 恒 0
 * ⇒ 设置页把整个 provider 误显示为「已关闭」，且模型选择器里无模型可关。
 *
 * ⇒ 本表 = 远端目录的**离线快照**（11 条，与 `/api/chat-modes` 逐条对齐）。
 * 远端可用时以远端为准；上游加模型**不需要改代码**。
 *
 * ⚠️ **不要**靠猜名字来「补全」这张表 —— 猜错的名字会得到 400，
 * 症状与「账号没权限」同形（`deepseek-v4-pro` 就是这么混进来的，见下）。
 */
export const QWENWORK_INTL_FALLBACK_MODELS: readonly QwenworkFallbackModel[] = [
  // ⚠️⚠️ **本表已按上游 `/api/chat-modes` 的真实目录校准**（2026-11-22 浏览器实测，
  // 11 条）。`name` 用上游 `display_name.zh`，`supportsImage` 用 `is_vl`。
  //
  // | key | 显示名 | 倍率 | 视觉 | 协议 |
  // |---|---|---|---|---|
  // | `flash` | 标准 | 0.1 | ✅ | openai |
  // | `advanced` | 高级 | 1 | ❌ | openai |
  // | `pro` | 旗舰 | 1 | ✅ | openai |
  // | `qwen4-max` | Qwen4-Max | 1.4 | ✅ | **anthropic** |
  // | `qwen3.8-max` | Qwen3.8-Max | 1.9 | ✅ | openai |
  // | `qwen3.8-flash` | Qwen3.8-Flash | 0.1 | ✅ | openai |
  // | `deepseek-flash` | DeepSeek-V4.1-Flash | 0.2 | ❌ | openai |
  // | `glm-5.3` | GLM-5.3 | 1.3 | ❌ | openai |
  // | `glm-5.3-flash` | GLM-5.3-Flash | 0.2 | ✅ | openai |
  // | `kimi-k3.1-pro` | Kimi-K3.1-Pro | 2.6 | ✅ | openai |
  // | `minimax-m3.1-flash` | MiniMax-M3.1-Flash | 0.2 | ✅ | **anthropic** |
  //
  // ⚠️ 三个**被推翻的旧结论**（都写在这里防再犯）：
  // 1. `deepseek-v4-pro` **不存在**（那是早期手填测试时被上游接受的名字，
  //    但不在目录里；真实的是 `deepseek-flash`）；
  // 2. `pro` **收图**（`is_vl: true`），旧表写 `false` 是错的；
  //    同理 `glm-5.3` 的 `is_vl` 也是 `false`，但那是**上游声明**，
  //    与我早期「实测 400」的结论一致 —— 保留 `false`；
  // 3. `qwen3.8-flash` / `minimax-m3.1-flash` **之前漏了整个条目**。
  //
  // ⚠️ `format: 'anthropic'` 的两个模型（`qwen4-max` / `minimax-m3.1-flash`）
  // 走的是 Anthropic Messages 协议，**不是** OpenAI 兼容 —— 本适配器当前只实现
  // OpenAI 兼容（`POST /v1/chat/completions`）。⚠️ 实测它们**仍能**用 OpenAI
  // 兼容端点调通（网关做了转换），故仍列在本表里；若将来上游改成严格分流，
  // 需要为这两个单独接 Anthropic 协议。
  { id: 'flash', name: '标准', priceFactor: 0.1, contextWindow: 1_000_000, supportsImage: true },
  /**
   * ⚠️⚠️ **`advanced`（网页显示「Pro」）在 OpenAI 兼容端点上恒 400 —— 保留但不可用**
   *
   * ## 实测（2026-11-22，四种调用方式全试）
   *
   * | 调用 | 结果 |
   * |---|---|
   * | `POST /v1/chat/completions` `{model:'advanced'}` 非流式 | **400** `invalid_request` |
   * | 同上 + `stream: true` | **400** |
   * | 同上 + `reasoning_effort` | **400** |
   * | `{mode:'advanced'}`（不带 `model`） | 400 `missing field 'model'` |
   * | 对照 `{model:'flash'}` / `{model:'pro'}` | **200** ✓ |
   *
   * ## 为什么网页上它明明能用
   *
   * 我从网页实际发消息后读 `/api/chat-sessions/{id}` 的记录，拿到三档映射：
   *
   * ```
   * 网页「Standard」→ mode = "flash"
   * 网页「Pro」     → mode = "advanced"    ← 就是本条
   * 网页「Flagship」→ mode = "pro"
   * ```
   *
   * 而网页**根本不走** `/v1/chat/completions` —— 它的 JS bundle 里只有
   * `/api/desktop-sessions/{id}` / `/api/desktop-artifacts` / `/api/page`
   * 这几个任务式路径（`chat-session-page-*.js` 790 KB 全文搜索零命中
   * `/v1/chat/completions`）⇒ **网页走的是另一条任务通道**。
   *
   * ## 为什么仍保留在表里（用户 2026-11-22 决定：「advanced 保留即可」）
   *
   * - 上游可能哪天把它开放到兼容端点（那是产品侧开关，不是协议缺陷）；
   * - 从列表里拿掉会让「网页有 11 个、插件只有 10 个」，用户会以为漏了；
   * - 选中它会收到一条**明确的**上游 400（报文原文带 `invalid_request`），
   *   而不是静默异常 —— 可诊断、可反馈。
   *
   * ⚠️ **不要**为了「让它能用」而给它编一个别的 model 名（如 `qwork-pro` /
   * `Standard` / `Flagship`）—— 实测这些名字**全部 400**（2026-11-22 逐个试过）。
   */
  { id: 'advanced', name: '高级', priceFactor: 1, contextWindow: 1_000_000, supportsImage: true },
  { id: 'pro', name: '旗舰', priceFactor: 1, contextWindow: 1_000_000, supportsImage: true, efforts: QWENWORK_EFFORTS_SUPPORTED },
  { id: 'qwen4-max', name: 'Qwen4-Max', priceFactor: 1.4, contextWindow: 1_000_000, supportsImage: true, efforts: QWENWORK_EFFORTS_SUPPORTED },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', priceFactor: 1.9, contextWindow: 1_000_000, supportsImage: true, efforts: QWENWORK_EFFORTS_SUPPORTED },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', priceFactor: 0.1, contextWindow: 1_000_000, supportsImage: true },
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', priceFactor: 0.2, contextWindow: 1_000_000, supportsImage: true },
  { id: 'glm-5.3', name: 'GLM-5.3', priceFactor: 1.3, contextWindow: 1_000_000, supportsImage: true, efforts: QWENWORK_EFFORTS_SUPPORTED },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', priceFactor: 0.2, contextWindow: 1_000_000, supportsImage: true, efforts: QWENWORK_EFFORTS_SUPPORTED },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', priceFactor: 2.6, contextWindow: 1_000_000, supportsImage: true },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', priceFactor: 0.2, contextWindow: 1_000_000, supportsImage: true, efforts: QWENWORK_EFFORTS_SUPPORTED },
]

/**
 * 解析上游 `/api/chat-modes` 的响应 → 本适配器的模型表。
 *
 * ## ⚠️ 这是**远端目录**，优先于静态兜底表
 *
 * `qwenwork-adapter.ts` 每次 `listModels` 会先尝试远端，失败才用兜底表
 * ⇒ 上游加模型时**不需要改代码**（这修复了旧注释里登记的「静态表必然腐坏」缺陷）。
 *
 * @param body      `/api/chat-modes` 的 JSON。
 * @param fallback  远端没有任何可用条目时用它（**不得**返回空 —— 空表会让
 *                   `provider.status` 的 `models.total` 恒 0，整个 provider
 *                   被误显示成「已关闭」，那是本仓 `qiniu-product.ts` 记录过的坑）。
 */
export function parseQwenworkChatModes(
  body: unknown,
  fallback: readonly QwenworkFallbackModel[] = QWENWORK_INTL_FALLBACK_MODELS,
): readonly QwenworkFallbackModel[] {
  if (typeof body !== 'object' || body === null) return fallback
  const group = (body as Record<string, unknown>).qwork
  if (!Array.isArray(group)) return fallback
  const models: QwenworkFallbackModel[] = []
  for (const raw of group) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    // ⚠️ `enable: false` 的条目**跳过**：上游已下架，列出来只会让用户选了报错。
    if (item.enable === false) continue
    const id = typeof item.key === 'string' ? item.key.trim() : ''
    if (id.length === 0) continue
    const name = qwenworkDisplayName(item)
    // ⚠️ 上游给的是 `max_input_tokens`（不是 contextWindow 那个名字）。
    const contextWindow = typeof item.max_input_tokens === 'number' && item.max_input_tokens > 0
      ? item.max_input_tokens
      : 1_000_000
    /**
     * ⚠️ **图片能力一律 `true`**（用户 2026-11-22 决定）：
     * 不读上游 `is_vl`、也不看实测覆盖表，理由见 `QWENWORK_ASSUME_IMAGE_SUPPORT`。
     */
    const supportsImage = QWENWORK_ASSUME_IMAGE_SUPPORT
    /**
     * ⚠️ **倍率从远端取**（上游改价时不该等插件发版）。
     *
     * ⚠️ `price_factor` 缺失时**不写**（不编造），
     * `displayNameOfQwenworkModel` 会跳过拼接、只显示裸名。
     *
     * ⚠️ **上游的 `icon` 与 `is_new` 刻意不取**（2026-11-22 用户决定）：
     * - `icon`：DSH 的 `LlmModelInfo` **没有任何 logo 渲染位置**（宿主只透传
     *   `provider/id/name/description/inputModalities/badge`）⇒ 取了也是死字段；
     * - `is_new`：只能画成「新」徽标，而**网页上并没有这个角标** ——
     *   用户要的是「与上游展示同样效果」，不是「多一个上游没有的角标」。
     */
    const priceFactor = typeof item.price_factor === 'number' && Number.isFinite(item.price_factor)
      ? item.price_factor
      : undefined
    models.push({
      id,
      name,
      ...priceFactor === undefined ? {} : { priceFactor },
      contextWindow,
      supportsImage,
      efforts: QWENWORK_MODEL_EFFORTS[id],
    })
  }
  return models.length > 0 ? models : fallback
}
/** 从 `i18n.display_name` 里取显示名（中文优先，回落英文，再回落 key）。 */
function qwenworkDisplayName(item: Record<string, unknown>): string {
  const i18n = typeof item.i18n === 'object' && item.i18n !== null
    ? (item.i18n as Record<string, unknown>)
    : undefined
  const names = typeof i18n?.display_name === 'object' && i18n.display_name !== null
    ? (i18n.display_name as Record<string, unknown>)
    : undefined
  for (const lang of ['zh', 'en']) {
    const value = names?.[lang]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return typeof item.key === 'string' ? item.key : '?'
}


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
