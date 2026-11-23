/**
 * 千问办公国际站（QwenWork Intl）LLM 适配器。
 *
 * ## 与 qiniu 的结构关系：**同一范式 + 一个「换票」环节**
 *
 * 模型目录、轮换、错误分类、图片解析、SSE 消费全部照抄 `qiniu-adapter.ts`
 * 的范式（那是本仓「静态凭据 + OpenAI 兼容」的成熟实现）。**唯一的新增**是：
 * 每次（或每 2 小时）先换一次 MaaS token，再用它连带 `base_url` 发推理。
 *
 * ```
 * slot.accessToken ──┐
 *                    ├─→ POST gateway/api/desktop-sessions
 *                    │   → { access_token, base_url, ttl_ms, expires_at_ms }
 *                    │
 *                    └─→ POST {base_url}/v1/chat/completions
 * ```
 *
 * ## ⚠️⚠️ MaaS token 必须缓存，且**不得**在并发下重复换取
 *
 * `ttl_ms` 实测 `7_200_000`（2 小时）。DSH 本身会并发发主回复 + 标题 + 压缩
 * 三条请求 ⇒ 若每轮都换票，会有三个并发换票请求，且**每条都算一次上游调用**。
 *
 * 故这里按 `slot.id` 缓存一个 `{ token, expiresAtMs, baseUrl }`，并上
 * **单飞表（in-flight map）**：同一个 slot 的并发请求共享同一个 Promise。
 * 这是本仓 `protocol-wire.md` 的「单飞表」教训
 * （调度轮询无 in-flight 闸门导致两拍重叠）的直接应用。
 *
 * ⚠️ 缓存**提前量**取 60 秒：`ttl_ms` 是从签发那刻算的，扣掉提前量可避免
 * 「正好在过期边界发请求」⇒ 上游 401 ⇒ 被误判成「登录失效」并清空凭据。
 *
 * ## ⚠️ `base_url` 必须用上游下发的，绝不硬编码
 *
 * 实测值是 `https://api1.qwenwork.ai`，但**那是那一刻的决定**。硬编码会在上游
 * 轮换节点时整条渠道失效，症状是「所有请求 404」—— 与「没有这个模型」同形，
 * 无法诊断。`fallbackInferBase` 只在响应里**没有** `base_url` 时兜底。
 *
 * ## ⚠️ 图片能力**一律按支持处理**（2026-11-22 用户决定）
 *
 * 不读上游 `is_vl`、也不做逐模型覆盖 —— 理由见 `QWENWORK_ASSUME_IMAGE_SUPPORT`
 * 的文档（两轮实测结论互相矛盾 + 用户实测网页全模型都能看图）。
 *
 * ⇒ 声明谁都支持；**真不支持就让上游回 400**（`classifyQwenworkError` 会归
 * `invalid_request` 并带上游原文，用户能看到可诊断的错误）。
 *
 * ⚠️ 但 `resolveImageUrls` 仍会检查**当前解析出的** `inputModalities` 并在
 * 不支持时抛 `UNSUPPORTED_CONTENT`（**不静默丢弃** —— 静默丢弃会让用户
 * 以为模型看到了图，这是 Qoder 图片事故的教训）。
 * 由于现在一律声明支持，该分支实际不会命中，但**保留它**作为将来
 * 若重新引入逐模型能力判定时的安全网。
 *
 * @module src/qwenwork-adapter.ts
 */

import { type Context } from '@deepseek-ai/cordis'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ModelCatalog } from './model-catalog.js'
import { createModelCatalog, type CatalogEntry } from './model-catalog.js'
import {
  collectImages,
  consumeOpenAiSse,
  httpErrorCode,
  serializeMessages,
} from './openai-compat.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { isAbortLike } from './aggregate-adapter.js'
import { reportLedgerAccount } from './token-ledger.js'
import { retryAfterMsFromResponse } from './retry-after.js'
import { buildQwenworkPayload } from './qwenwork-messages.js'
import type { AccountPool } from './account-pool.js'
import {
  QWENWORK_INTL,
  QWENWORK_INTL_FALLBACK_MODELS,
  classifyQwenworkError,
  displayNameOfQwenworkModel,
  parseQwenworkChatModes,
  type QwenworkErrorInfo,
  type QwenworkFallbackModel,
  type QwenworkProduct,
} from './qwenwork-product.js'
import {
  normalizeQwenworkModelId,
  qwenworkHeaders,
  qwenworkMaasSessionUrl,
  type QwenworkCredential,
} from './qwenwork.js'

/**
 * 目录条目（本家形状）。
 *
 * ⚠️ 现由**远端 `/api/chat-modes`** 填充（10 分钟缓存），远端不可用时才回退兜底表。
 */
export interface QwenworkCatalogEntry {
  id: string
  /** 展示名（**不含倍率** —— 倍率由 `toCatalogEntry` 拼上去）。 */
  name: string
  /** 计费倍率（上游 `price_factor`），拼进展示名用。 */
  priceFactor?: number
  contextWindow: number
  supportsImage: boolean
  efforts?: readonly string[]
}

/** 一个可用槽位（接线层解析后交给适配器）。 */
export interface QwenworkSlot {
  /** 账号 id（轮换与限流标记的键）。 */
  id: string
  /** 登录 access token（**不是** MaaS token，见模块头）。 */
  accessToken: string
}

/**
 * 换到的 MaaS 票据。
 *
 * ⚠️ `baseUrl` 与 `token` **必须成对**：上游可能在任一时刻把请求导向不同节点，
 * 拿 A 节点的票打 B 节点会 401（与「token 过期」同形）。
 */
export interface QwenworkMaasTicket {
  token: string
  baseUrl: string
  /** 绝对过期时刻（毫秒）。 */
  expiresAtMs: number
}

/** 适配器构造选项。 */
export interface QwenworkAdapterOptions {
  readonly product?: QwenworkProduct
  /**
   * 单凭据回退 ref：池里没有本家账号时用它（与其余 provider 同约定）。
   *
   * ⚠️ 本家**刻意不实现**「单凭据回退读取」：没有账号就是没有账号，
   * 直接抛 `MISSING_CREDENTIAL` 并给出登录入口（比悄悄读一个可能过期的
   * 默认 ref 更诚实）。字段保留是为了与其余 provider 的接线形态一致 ——
   * `refresh-bootstrap-wiring.spec.ts` 按这个键扫不变式。
   */
  readonly credentialRef?: unknown
  /**
   * 可用槽位。
   *
   * @param modelId 传了就跳过「该模型正处于限流窗口」的账号（目录路径刻意不传）。
   * @param sessionId ★ **轮换起点必需**（2026-11-23 补）：接线层据此查
   *   `pool.preferredRotationFor(provider, sessionId)` 拿到本会话选定的起点账号。
   *
   * ⚠️⚠️ **缺这个入参 = 「轮换起点」对本家完全无效**（真实缺陷）：
   * 起点是按 `(provider, sessionId)` 存的，没有 `sessionId` 就只能传 `undefined`
   * ⇒ `preferredRotationFor` 返回 `undefined` ⇒ 起点被静默忽略、永远用池里第一个号。
   * 症状与「我明明选了起点，怎么还是从第一个开始」完全一致。
   *
   * ⚠️ 可选（`?`）：目录路径（`listAllModels` / 冷启动）没有会话上下文，
   * 那一路传 `undefined` 是对的 —— 它只在「有没有账号」这个层面上用。
   */
  readonly slots: (modelId?: string, sessionId?: string) => Promise<readonly QwenworkSlot[]>
  /**
   * 换 MaaS 票据。
   *
   * ⚠️ **注入而非内置**：单测必须能在**不发真请求**的前提下覆盖「换票失败」
   * 「票据过期」「base_url 缺失」三条分支。本仓 opencode 那轮实测过
   * 「单测真发 HTTPS 拿到上游真表 ⇒ 4 条用例静默变随机真值」的教训。
   */
  readonly mintTicket: (
    slot: QwenworkSlot,
    signal?: AbortSignal,
  ) => Promise<QwenworkMaasTicket>
  /** 读图片附件为 data URL（缺省时不支持图片）。 */
  readonly readImage?: (ref: unknown) => Promise<{ mediaType: string; data: Uint8Array } | undefined>
  /** 账号池（黑名单 / 关闭意图的唯一实现来源，**必须传真池**）。 */
  readonly accountPool?: AccountPool
  /** 标记某账号在某模型上被限流到某时刻。 */
  readonly markLimited?: (slotId: string, modelId: string, resetAtMs: number) => Promise<void>
  /**
   * **静默续期凭据**（2026-11-23 审计 P2 补，基准 `trae` / `buddy` / `qoder` 都有）。
   *
   * ## ⚠️⚠️ **必须接收「刚失败的那个槽 id」**（2026-11-23 二轮审计修，🔴 真缺陷）
   *
   * 原签名是 `() => Promise<void>` —— **不知道续谁**，接线层只能
   * `pool.getAvailableAccount(provider, '')` 取池里**第一个可用**账号。
   * 而失败的可能根本不是它：
   *
   * ```
   * 轮换起点选 acc-2 ⇒ slots() 返回 acc-2
   * 但 refresh() 取到 acc-1 ⇒ 续了 acc-1（还轮换了它的 refresh_token）
   * ⇒ acc-2 一次都没救到，用户仍看到 401
   * ```
   *
   * 而 `refresh_token` 是**一次性轮换**的 ⇒ 每轮失败都白烧另一个号的凭据。
   *
   * ## 与 B-1（旧 token）的关系
   *
   * 光传对账号还不够：`stream()` 在循环**外**只取一次 `slots` 快照，
   * 续期成功后 `continue` 重发用的仍是**快照里的旧 accessToken**。
   * 故本字段与 `fetchSlots`（见下）必须**成对**使用 —— 只修一个仍然无效。
   *
   * @param slotId 刚认证失败的槽 id（接线层据此续**那一个**账号）
   */
  readonly refresh?: (slotId: string) => Promise<void>
  /**
   * ★★★ **重新取一次槽快照**（2026-11-23 二轮审计补，修 🔴B-1）。
   *
   * ## 为什么必须有
   *
   * `stream()` 在循环外 `const slots = await this.options.slots(...)` 只取一次，
   * 里面是 `{ id, accessToken }` 的**快照**。续期成功后 `tried.delete()` 让该槽
   * 重新可被选中，但**重发用的还是快照里的旧 token**：
   *
   * ```
   * 换票时用的 token 序列: ["OLD-TOKEN"]        ← 续期后仍用它
   * 续期后凭据库里的值:    NEW-TOKEN            ← 库真的改了，但没用上
   * ```
   *
   * ⇒ ① 自愈链整条无效（用户仍看到 401）；
   *   ② 每轮失败都**白烧一次一次性 `refresh_token` 轮换**。
   *
   * ## 契约
   *
   * 返回**当前**的槽列表（接线层每次现读凭据库）。缺省时退化为「用旧快照」
   * —— 那是改动前的行为，**只影响续期后的重发**（唯一回归面）。
   */
  readonly fetchSlots?: (modelId?: string, sessionId?: string) => Promise<readonly QwenworkSlot[]>
  /** 诊断日志。 */
  readonly warn?: (message: string) => void
}

/** 兜底重试上限（与 qiniu 同口径）。 */
const RETRY_AFTER_CAP_MS = 30 * 60_000
const RATE_LIMIT_BASE_MS = 60_000

/**
 * 远端目录缓存 TTL（成功）。
 *
 * ⚠️ 10 分钟：上游加模型是低频事件，而 `listModels` 会被面板频繁调用
 * （每次开设置页、每次刷新）⇒ 不缓存等于每点一次打一次上游。
 */
const REMOTE_CATALOG_TTL_MS = 10 * 60_000
/**
 * 远端目录缓存 TTL（**失败**）。
 *
 * ⚠️ 60 秒：不缓存失败的话，上游不可达时每次开面板都白等一个超时，
 * 界面明显卡顿；缓存太久的失败又会让「网络恢复后仍显示旧目录」。
 */
const REMOTE_FAILURE_TTL_MS = 60_000
/** 远端目录请求超时。⚠️ 必须设：桌面版到外部域名的 fetch 可能永不 settle。 */
const REMOTE_CATALOG_TIMEOUT_MS = 10_000

/**
 * 把一次失败折算成「何时可以再试」。
 *
 * ⚠️ **额度类不给次日零点**：国际站的额度**每天 00:00（UTC+8）刷新**，
 * 但这里刻意**不**封到次日零点 —— 因为「额度耗尽」在单账号场景下是最常见形态，
 * 封一整天会让用户当天完全无法再试（而额度可能因上游重算而恢复）。
 * 改为按「退避到下一次自然日 00:00」的上限内取较短值：
 * 首轮 60s、每多试一个号翻倍，上限 30 分钟。
 *
 * ⚠️ `retryAfterMs` 存在时**优先用它**（上游明确给了等待时长）。
 */
export function qwenworkRetryAfterMs(
  kind: QwenworkErrorInfo['kind'],
  retryAfterMs: number | undefined,
  attempt: number,
): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
  }
  const backoff = RATE_LIMIT_BASE_MS * 2 ** Math.max(0, attempt - 1)
  return Math.min(backoff, RETRY_AFTER_CAP_MS)
}

/** 本家私有形状 → 骨架的 `CatalogEntry`（**唯一**转换点）。 */
function toCatalogEntry(m: QwenworkCatalogEntry): CatalogEntry {
  return {
    id: m.id,
    /**
     * ⚠️ **倍率拼进 `name`**（`模型名 · x倍率`）：
     * composer 的模型菜单**只渲染 `name`**，写进 description 等于没写。
     * 本家倍率跨度 0.1 ~ 2.6（26 倍）是选型时最重要的信号。
     * 做法与 `accio-adapter.ts` 的 `displayNameOfAccioModel` 同款。
     */
    name: displayNameOfQwenworkModel(m),
    /**
     * ⚠️ **不传 `icon`**（2026-11-22 用户澄清）：用户要的「图标」是模型名右边的
     * **徽标**（如 CodeBuddy 那个绿色「限时免费」框），**不是模型 logo**。
     * 上游给的那个 `img.alicdn.com` 24×24 SVG 在 DSH 的模型列表里**没有任何
     * 渲染位置** —— `LlmModelInfo` 全库无 icon/logo 字段（宿主只透传
     * `provider/id/name/description/inputModalities/badge`）。
     * ⇒ 传了也是死字段，故移除（数据仍保留在兜底表里，备将来有位置再用）。
     */
    /**
     * ⚠️ **不传 `badge`**（2026-11-22 用户决定）：
     *
     * > 「如果上游不会返回跟徽标相关的，那你就不需要做徽标，我只是你能跟上游
     * >   展示同样效果。现在能展示倍率，那就行了。」
     *
     * 上游 `/api/chat-modes` **不下发任何促销/徽标字段**
     * （实测 11 条：`price_factor` 最低 0.1、无一条为 0，也没有
     * `promotion`/`discount`/`promo`）⇒ 做不出「限时免费」那种效果。
     *
     * ⚠️ 而我上一版用 `is_new` 编了个「新」徽标 —— 那是**自己发明的**，
     * 网页上并没有这个东西 ⇒ **移除**（用户要的是「与上游展示同样效果」，
     * 不是「多一个上游没有的角标」）。
     *
     * ⚠️ 宿主确实支持 `badge`（`{text, tone}`，渲成名字右侧胶囊），
     * 能力是有的 —— 只是本家上游没有可画的内容。将来上游若下发促销
     * （比如 `price_factor === 0` 或 `promotion` 字段），这里再补。
     */
    // ⚠️ 能力表缺失/未知时**一律回退 `['text']`**（硬约定：声明支持就必须真支持）。
    inputModalities: m.supportsImage
      ? (['text', 'image'] as const)
      : (['text'] as const),
    // ⚠️ 窗口未知**不编造**（0 是「不知道」哨兵）⇒ 省略该字段。
    ...(m.contextWindow ?? 0) > 0 ? { contextWindow: m.contextWindow } : {},
    ...(() => {
      const efforts = m.efforts ?? []
      if (efforts.length === 0) return {}
      return {
        reasoning: {
          efforts: efforts.map((effort) => ({
            // ⚠️ `id` 是**品牌类型**（`ReasoningEffortId`），必须经构造函数。
            id: ReasoningEffortId(effort),
            // ⚠️ 没有官方中文名时回退到 id 本身 —— 宁可显示英文原值，也不猜。
            name: effort === 'none' ? '关闭' : effort,
          })),
        },
      }
    })(),
  }
}

/** 兜底表 → 本家形状。 */
function fallbackEntries(): readonly QwenworkCatalogEntry[] {
  return QWENWORK_INTL_FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    ...m.priceFactor === undefined ? {} : { priceFactor: m.priceFactor },
    contextWindow: m.contextWindow,
    supportsImage: m.supportsImage,
    ...m.efforts === undefined ? {} : { efforts: m.efforts },
  }))
}

/** 千问办公国际站适配器。 */
export class QwenworkAdapter extends LlmAdapter {
  private readonly product: QwenworkProduct
  private readonly skeletonCatalog: ModelCatalog
  /**
   * 远端目录缓存。
   *
   * ⚠️ 成功与失败**都**缓存，只是 TTL 不同：成功 10 分钟、失败 60 秒。
   * 不缓存失败的话，上游不可达时每次开面板都要白等一个超时。
   */
  private remoteCatalog: { models: readonly QwenworkFallbackModel[]; at: number; ttl: number } | undefined
  /** 单飞：并发调用共享同一次远端请求（与 `mintTicket` 同款理由）。 */
  private remoteInflight: Promise<readonly QwenworkFallbackModel[]> | undefined

  constructor(private readonly options: QwenworkAdapterOptions) {
    super()
    this.product = options.product ?? QWENWORK_INTL
    // ⚠️⚠️ **`accountPool` 必须是真池**：骨架里 `disabledModelsFor` 与
    //     `providerClosedFor` 全靠它；传 `{}` 或 `undefined` 会让 `?.` 变成
    //     静默 no-op（关掉的模型照样可选、关整个供应商也无效，且零报错零日志）。
    this.skeletonCatalog = createModelCatalog(
      this.options.accountPool === undefined ? {} : { accountPool: this.options.accountPool },
      {
        product: this.product,
        loadCatalog: async () => await this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        /**
         * ★ **强制重拉**（2026-11-23 审计 P3 补）。
         *
         * ⚠️ 不给这一项时骨架**根本不产出 `refresh()` 成员**
         * （`model-catalog.ts:865` 用 `...config.refresh === undefined ? {} : {...}`），
         * 于是 20 分钟后台目录刷新器对本家 `undefined` 跳过
         * ⇒ 本家不在统一刷新里，只能靠自建的 10 分钟 TTL 被动等。
         *
         * ⚠️ 同时它**顺带修好 `listAllModels()` 的时效性**：
         * 骨架的 `refresh()` 会把 `cached` 一起更新（`:873-878`），
         * 而 `listAllModels()` 用的 `syncCatalog()` 在 `cached` 有值时读它
         * ⇒ 刷新之后 `provider.status` 的 `models.total` 不再是旧值。
         *
         * 实现就是把自建缓存的 TTL 清零（`at: 0`），下次 `loadCatalogEntries`
         * 必然真的打一次上游。**不在这里直接发请求**：那会和单飞逻辑抢，
         * 且刷新器的语义是「标记失效、由下一次读触发」。
         */
        refresh: async () => {
          this.remoteCatalog = undefined
        },
        // ⚠️ 未知 id **保守报 `['text']`**：把「未知」当成「支持」会让 DSH 把图片
        //    投影成上游不接受的形态（`glm-5.3` 实测 400）。
        unknownModelInputModalities: () => ['text'] as const,
      },
    )
  }

  /**
   * 异步读目录（骨架入口）。
   *
   * ## ⚠️⚠️ **优先远端 `/api/chat-modes`，失败才回退静态表**
   *
   * 2026-11-22 浏览器实测发现该端点（此前误以为「国际站没有可读的目录端点」）。
   * 走远端后**上游加模型不需要改代码**，这修复了旧实现里登记的
   * 「静态兜底表必然腐坏」缺陷。
   *
   * ⚠️ **远端失败必须回退兜底表，不能返回空**：
   * 空表 ⇒ `provider.status` 的 `models.total` 恒 0 ⇒ 整个 provider 被误显示成
   * 「已关闭」（`qiniu-product.ts` 模块头记录过这个坑）。
   *
   * ⚠️ **没有槽位时仍返回 `[]`**：那是「本 provider 一个账号都没登录」的正常
   * 门控，与「远端失败」是两件事，不能混。
   */
  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const slots = await this.options.slots()
    if (slots.length === 0) return []
    const models = await this.loadRemoteModels(slots[0]!)
    return models.map((m) => toCatalogEntry(m))
  }

  /**
   * 拉远端模型目录（带缓存 + 单飞）。
   *
   * ⚠️ **缓存**：`listModels` 在面板上被频繁调用（每次开设置页、每次刷新），
   * 不缓存会每点一次都打一次上游。
   *
   * ⚠️ **失败也要缓存**（`REMOTE_FAILURE_TTL_MS` 短得多）：否则上游不可达时
   * 每次调用都白等一个超时，面板会明显卡顿。
   */
  private async loadRemoteModels(slot: QwenworkSlot): Promise<readonly QwenworkFallbackModel[]> {
    const now = Date.now()
    const cached = this.remoteCatalog
    if (cached !== undefined && now - cached.at < cached.ttl) return cached.models
    if (this.remoteInflight !== undefined) return await this.remoteInflight

    const task = (async (): Promise<readonly QwenworkFallbackModel[]> => {
      try {
        const response = await fetch(`${this.product.webBase}${this.product.chatModesPath}`, {
          headers: qwenworkHeaders(slot.accessToken, 'application/json'),
          signal: AbortSignal.timeout(REMOTE_CATALOG_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        const models = parseQwenworkChatModes(body)
        this.remoteCatalog = { models, at: Date.now(), ttl: REMOTE_CATALOG_TTL_MS }
        return models
      } catch (error) {
        // ⚠️ **静默回退**：目录拉不到不是用户的错，报错只会让面板显示一条
        //    「目录加载失败」而模型其实还能用（兜底表在）。
        this.options.warn?.(
          `[qwenworkintl] 远端模型目录拉取失败，回退兜底表：${String(error)}`,
        )
        this.remoteCatalog = {
          models: fallbackEntries(),
          at: Date.now(),
          ttl: REMOTE_FAILURE_TTL_MS,
        }
        return fallbackEntries()
      } finally {
        this.remoteInflight = undefined
      }
    })()
    this.remoteInflight = task
    return await task
  }

  /** **同步**全量目录（`listAllModels()` 用）。 */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    return fallbackEntries().map((m) => toCatalogEntry(m))
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**同步**返回数组）。
   *
   * ⚠️ **绝不能写成 async**：`jet-hub-rpc.ts` 的 `ModelCatalogSource` 接口是
   * 同步的且消费者**不 await**（`catalog = [...all]`），返回 Promise 会抛
   * `TypeError: all is not iterable`（minimax 的同款真实缺陷）。
   *
   * ⚠️⚠️ **`name` 必须走 `toCatalogEntry` 那条唯一转换点**（带倍率 + 徽标）。
   *
   * 原先这里直接 `{ id: m.id, name: m.name }` —— 用的是**裸名**
   * ⇒ 设置页 / `provider.status` 那两处显示的是「标准」而模型选择器显示
   * 「标准 · x0.1」，**同一模型两个名字**（2026-11-22 用户报障
   * 「在 providers 的模型列表也展示倍率」）。
   *
   * ⚠️ 徽标**不在这里带**：本方法返回类型只有 `{id, name}`，
   * 而徽标只在 `listModels` 的 `LlmModelInfo.badge` 上有渲染位置。
   */
  /**
   * ★ **强制重拉目录**（2026-11-23 终审补，与 `trae-adapter.ts:1098` 同款转发）。
   *
   * ## ⚠️⚠️ 光给 `config.refresh` 不够（我第一版就漏了这一半）
   *
   * 骨架确实会因此产出 `refresh()` 成员（`model-catalog.ts:865`），
   * **但适配器必须把它转发出去**，否则后台刷新器拿到的是 `undefined`
   * ⇒ 「已武装却对这家空转，且**零日志**」（`refreshOf` 返回 `undefined` 时静默跳过）。
   *
   * ## ⚠️ 与 `options.refresh` **不是同一件事**（同名纯属巧合，不得合并）
   *
   * | | 语义 | 触发源 |
   * |---|---|---|
   * | `options.refresh`（构造参数）| **凭据**续期（HTTP 401 后重取 token）| `stream()` 的 auth 分支 |
   * | `refresh()`（本方法）| **模型目录**重拉 | 20 分钟后台刷新器 / 用户改设置 |
   */
  async refresh(): Promise<void> {
    await this.skeletonCatalog.refresh?.()
  }

  listAllModels(): readonly { id: string; name: string }[] {
    /**
     * ⚠️⚠️ **委托共享骨架**（2026-11-23 审计 P3 修，与 trae / qiniu 同款）。
     *
     * ## 原实现的问题（真实缺陷）
     *
     * 原先这里是 `fallbackEntries().map(...)` —— **恒读静态兜底表**。
     * 后果：上游 `/api/chat-modes` 新增模型后，
     * `provider.status` 的 `models.total` 与「关闭整个 provider」写黑名单用的
     * 全量目录**仍是旧的 11 条**（那个矛盾态正是 `index.ts:6697` 注释要防的）。
     * 当时静态表恰好与远端一致（11 条），所以**尚未显形** —— 属于「定时炸弹」。
     *
     * ## 为什么委托就对
     *
     * 骨架的 `listAllModels()`（`model-catalog.ts:556`）读的是**它自己的 `cached`**：
     * - 未调用过 `listModels` 时回落 `syncCatalog()` ⇒ 仍是兜底表（冷启动，正确）；
     * - 调过一次之后就用远端结果；
     * - 且 `refresh()` 会同步更新 `cached`（`:873-878`）。
     *
     * 这样「远端优先」这条在**三个出口**上一致：
     * `listModels`（选择器）/ `resolveModel`（单模型）/ `listAllModels`（全量）。
     *
     * ⚠️ 保留 `id` + `name` 的形状裁剪：骨架还多一个 `isFree`，
     * 而本家**没有**免费模型（`price_factor` 最低 0.1、无 0 值）⇒ 不传。
     */
    return this.skeletonCatalog.listAllModels().map((m) => ({ id: m.id, name: m.name }))
  }

  /**
   * 模型选择器的目录 —— **委托共享骨架**（`model-catalog.ts`）。
   *
   * 关闭意图 / 黑名单 / 模态回填 / `provider` 回填四条全部由骨架承担，
   * 本家独有的门控（没有可用槽位时隐藏）放在 `loadCatalog` 里。
   */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return await this.skeletonCatalog.listModels(provider)
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    /**
     * ⚠️⚠️ **必须委托骨架**（2026-11-23 终审修，与 `trae-adapter.ts:1193` 同款）。
     *
     * ## 原实现的问题（真实缺陷，注释还宣称「三个出口一致」）
     *
     * 原先这里读 `fallbackEntries()` —— **恒读静态兜底表**，而旁边
     * `listAllModels` 的注释明确宣称「远端优先在三个出口上一致」，
     * **注释与实现相反**。
     *
     * 实测（stub 远端只回一条 `brand-new-model-2027`）：
     *
     * ```
     * 选择器 name : "全新模型 · x0.7"        ← 远端
     * 全量   name : "全新模型 · x0.7"        ← 远端
     * resolve name : "brand-new-model-2027"  ← 静态表（裸 id）
     * resolve contextWindow = undefined      （远端声明 2,000,000）
     * resolve modalities    = ["text"]       （选择器是 ["text","image"]）
     * resolve efforts 数    = 0              （选择器 5 档）
     * ```
     *
     * ⇒ 上游新增的模型：选择器里可选，但发请求时**裸 id、无窗口、无档位、无图片**
     *   ⇒ 用户看到「选了新模型却用不了」。
     *
     * ⚠️ 骨架的 `resolveModel` 会自己跑 `loadCatalog`（内含远端优先 + 单飞 + TTL），
     * 故这里直接委托即可，**不要**在这里再读一次静态表。
     */
    return await this.skeletonCatalog.resolveModel(provider, model, signal)
  }

  /**
   * ⚠️⚠️ **必须包 `prepareCall`，不是 `stream`**（本仓 PR !66 的硬纪律）。
   *
   * 包装适配器时若只包 `stream`，宿主拿到的是**未解析**的 model 信息
   * （缺 `context` / `reasoning` / `inputModalities`），表现为「上下文占用条
   * 不渲染」「思考档位菜单不出现」，而适配器内部一切正常 —— 极难诊断。
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return { model: await this.resolveModel(provider, model, signal), stream: (o) => this.stream(o) }
  }

  /**
   * 解析消息里的图片附件为 data URL。
   *
   * ⚠️ **模型不支持图片时直接抛 `UNSUPPORTED_CONTENT`**（而不是静默丢弃）。
   * 静默丢弃会让用户以为模型看到了图（Qoder 图片事故的教训）。
   * ⚠️ 附件字节读不出来时**不写入该条**：`openai-compat` 的 `userContentParts`
   * 遇到缺失会产出 `[image unavailable]` 占位，至少让模型知道「这里本该有张图」。
   */
  private async resolveImageUrls(
    model: string,
    messages: readonly { content: unknown }[],
  ): Promise<ReadonlyMap<string, string> | undefined> {
    const refs = new Map<string, unknown>()
    for (const message of messages) {
      if (Array.isArray(message.content)) collectImages(message.content, refs)
    }
    if (refs.size === 0) return undefined

    /**
     * ⚠️⚠️ **图片能力也必须读骨架**（2026-11-23 终审修）。
     *
     * 原先读 `fallbackEntries()` ⇒ 对**远端新增的模型**恒判「不支持图片」
     * ⇒ 发图恒抛 `UNSUPPORTED_CONTENT`（实测：「模型 "brand-new-model-2027"
     * 不支持图片输入」），而选择器里该模型的 `inputModalities` 明明含 `image`
     * —— 两个出口给出相反答案。
     *
     * ⚠️ 委托骨架的 `resolveModel` 还顺带保证与 `prepareCall` 同源
     *（宿主拿到的模态与适配器自检的模态来自同一份解析结果）。
     */
    const resolved = await this.skeletonCatalog.resolveModel(this.product.id, model)
    const supportsImage = (resolved.inputModalities ?? []).includes('image')
    if (!supportsImage) {
      throw new LlmError(
        `qwenworkintl: 模型 "${model}" 不支持图片输入`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (this.options.readImage === undefined) {
      throw new LlmError('qwenworkintl: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
    }
    const readImage = this.options.readImage
    const out = new Map<string, string>()
    for (const [id, ref] of refs) {
      const image = await readImage(ref)
      if (image === undefined) continue
      out.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
    }
    return out
  }

  /**
   * 轮换：失败按「语义」标记该槽 → 换下一槽重发。
   *
   * 三条硬规则（与 qiniu 同）：
   * 1. `tried` **跨迭代保留** —— 每次重置会让两个槽之间无限来回；
   * 2. **已交付内容的流不重放**；
   * 3. **认证类不写限流标记**（写它会放大成「全池被封」）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    /**
     * ⚠️ 传 `modelId`：接线层据此跳过「该模型正处于限流窗口」的账号。
     * ⚠️⚠️ 传 `options.sessionId`：**轮换起点必需**（2026-11-23 修）。
     * 不传 ⇒ 起点被静默忽略、永远用池里第一个号（用户报障
     * 「轮换起点对本家不起作用」的真根因）。
     */
    /**
     * ⚠️⚠️ **必须是 `let` 而不是 `const`**（2026-11-23 二轮审计修，🔴B-1）。
     *
     * 续期成功后要**重新取一次快照** —— 否则重发用的是循环开始时那份
     * `{ id, accessToken }` 里的**旧 token**（库已经改了，但这里没看见）。
     */
    let slots = await this.options.slots(options.model, options.sessionId)
    if (slots.length === 0) {
      throw new LlmError(
        'qwenworkintl: 没有可用账号。请在 Jet Hub 的千问办公国际版面板点「登录」，'
        + '用**正常邮箱**（Gmail / Outlook 等）注册的账号授权'
        + '（⚠️ 临时邮箱拿不到赠送积分，实测额度恒为 0）。',
        'MISSING_CREDENTIAL',
      )
    }

    const tried = new Set<string>()
    /**
     * 已经**尝试过续期**的槽（每个槽只试一次）。
     *
     * ⚠️ 与 `tried` **分开**：`tried` 是「不再选这个号」，
     * 而续期成功的号**要能再次被选中**（否则续了也白续）。
     * 故两个集合的语义相反 —— 合并会让续期这条腿彻底失效。
     */
    const refreshed = new Set<string>()
    const limited: string[] = []
    /**
     * **最后一枚认证失败的原始异常**（2026-11-23 二轮审计修）。
     *
     * ⚠️ 用途有两个：
     * 1. **单账号时原样透传**（不包装 ⇒ 上游 `trace_id` / 报文一点不少）；
     * 2. 多账号时把它的 message 尾巴拼进汇总文案。
     *
     * ⚠️ 只保留最后一条：多账号场景下「续期之后仍失败」的那条最能反映现状。
     */
    let lastAuthError: unknown
    /**
     * 上一枚认证失败的上游原文（从 `lastAuthError.message` 摘出来，供汇总文案用）。
     */
    let authErrorDetail = ''

    for (;;) {
      const slot = slots.find((s) => !tried.has(s.id))
      if (slot === undefined) {
        /**
         * ⚠️⚠️ **必须区分「真的用尽」与「全是认证失败」**（2026-11-23 终审修）。
         *
         * ## 原实现的问题（实测 `QUOTA_EXCEEDED`）
         *
         * 无论什么原因耗尽候选，都报「所有账号对该模型均受限」+ 码 `QUOTA_EXCEEDED`。
         * 但 `limited` 里可能装的**全是 `(认证失败)`** —— 那与额度毫无关系。
         *
         * ⇒ 用户看到「额度用尽」会去**解锁长期积分**（不可撤回的副作用），
         *   而真因只是「令牌过期 / 续期也没救回来」。这正是本仓红线点名的形态
         *  （`AUTH` 码会连 message 一起吞掉，让唯一的指路文案消失）。
         *
         * ## 判据
         *
         * `limited` 里**没有任何一条**是限流/额度类（`(auth)` / `(server)` /
         * `(transport)` 之外）⇒ 报 `AUTH`，文案直接指向「重新登录」。
         * 其余情况（至少有一条真限流/额度）⇒ 保持 `QUOTA_EXCEEDED`。
         */
        const authOnly = limited.length > 0 && limited.every((l) => l.endsWith('(认证失败)'))
        /**
         * ⚠️⚠️ **单账号：报 `AUTH` 码，但把上游原文原样带上**
         * （2026-11-23 二轮审计二改 —— 前一版只透传、丢了码）。
         *
         * ## 前一版为什么不够（E-3 用例打穿）
         *
         * 我第一版这里写的是 `throw lastAuthError`（**原样透传裸错误**），
         * 好处是上游 `trace_id` / 报文一点不少，**但 `code` 是 `undefined`**
         * —— 因为换票处抛的是裸 `Error`，构造时根本没带 `code`。
         *
         * 而宿主靠 `code` 分派：没有 `AUTH` 码 ⇒ 客户端**不会**渲染
         * 「重新登录」那句指路文案（本仓红线记录的形态）。
         *
         * ## 正确做法：**两者都要**
         *
         * `new LlmError(带上游原文的 message, 'AUTH')`：
         * - `code` 是 `AUTH` ⇒ 宿主给出正确的指路文案；
         * - `message` 里含上游原文（含 `trace_id`）⇒ 诊断信息一点不少。
         *
         * ⚠️ 与多账号那条**同源**：都保留原文，只是单账号不必加
         * 「全部账号」这类汇总措辞（那句话对单账号没有信息量）。
         */
        if (authOnly && slots.length === 1) {
          const who = limited.length > 0 ? limited[0]!.replace('(认证失败)', '') : ''
          throw new LlmError(
            `qwenworkintl: 账号 ${who} 认证失败（令牌已失效，自动续期也未能恢复）。`
            + '请在 Jet Hub 的千问办公国际版面板重新登录 —— 这与积分无关，'
            + '不要为此解锁长期积分。'
            + `${authErrorDetail.length > 0 ? ` 上游原文：${authErrorDetail}` : ''}`,
            'AUTH',
          )
        }
        if (authOnly) {
          /**
           * ⚠️⚠️ **必须保住上游原文**（2026-11-23 二轮审计修，我上一轮引入的回归）。
           *
           * ## 问题
           *
           * 上一轮把 auth 分支的 `throw error` 改成 `continue`（为了让 `authOnly`
           * 可达），代价是**丢了最后一枚上游错误的原文**：
           *
           * ```
           * 改动前: "qwenworkintl: HTTP 401 — {…"trace_id": "TRACE-123"…}"
           * 改动后: "全部账号认证失败…请重新登录"        ← trace_id 没了
           * ```
           *
           * 上游的 `trace_id` / 原始报文是**用户找客服时唯一的凭据**，
           * 也是我们排查「到底是哪种 401」的唯一线索。
           * 本仓红线里那条「文案本身就是出路」的反面同样成立：
           * **不能为了给出一条出路而抹掉诊断信息**。
           *
           * ## 修法
           *
           * 从 `limited` 的记账里带上原始 message 的尾巴
           *（`authErrorDetail` 在 auth 分支里抓的那个）。
           * 单账号时更直接：**原样透传那条错误**（没有汇总的必要，
           * 保持「上游说什么就是什么」）。
           */
          const detail = authErrorDetail.length > 0
            ? ` 上游原文：${authErrorDetail}`
            : ''
          throw new LlmError(
            'qwenworkintl: 全部账号认证失败（令牌已失效，自动续期也未能恢复）。'
            + '请在 Jet Hub 的千问办公国际版面板重新登录 —— 这与积分无关，'
            + `不要为此解锁长期积分。明细：${limited.join('、')}${detail}`,
            'AUTH',
          )
        }
        throw new LlmError(
          `qwenworkintl: 所有账号对该模型均受限${limited.length > 0 ? `（${limited.join('、')}）` : ''}`,
          'QUOTA_EXCEEDED',
        )
      }
      tried.add(slot.id)
      // Token 账本：回报「本笔请求实际使用的槽」。
      reportLedgerAccount(this.product.id, slot.id)

      let delivered = false
      try {
        for await (const chunk of this.streamVia(slot, options)) {
          // ⚠️ **任何 chunk 产出都算「已交付」**：宁可漏掉一次可切换的机会，
          //    也绝不重放（重复输出比中断更糟）。
          delivered = true
          yield chunk
        }
        return
      } catch (error) {
        if (delivered) throw error
        if (error instanceof LlmError && error.code === 'QUOTA_EXCEEDED') throw error
        // ⚠️⚠️ **取消 / 超时必须在此立刻抛出，且排在所有分类之前**：
        //    否则 AbortError 不命中任何分类关键词 ⇒ 落兜底 server 分支 ⇒
        //    被当成「换个号再试」⇒ 取消之后继续发请求，最终抛「所有账号均受限」——
        //    用户点了取消却看到「额度用尽」。
        if (isAbortLike(error, options.signal)) {
          throw error
        }

        const info = classifyQwenworkFailure(error)
        if (info.kind === 'invalid_request') {
          // 400/422：**换号无益**（每个槽发的是同一个体，形状问题与账号无关）
          // ⇒ 带上服务端原文直接上抛。
          throw new LlmError(
            `qwenworkintl: 请求被上游拒绝（${info.detail}）`,
            'BAD_REQUEST',
          )
        }
        if (info.kind === 'context_window') {
          // ⚠️ 上下文超限**换账号也没用** —— 它是请求本身太大，与哪个账号无关。
          //    ⇒ 不写冷却标记、不换号，直接抛原文让宿主走溢出压缩。
          //    ⚠️ 若漏这一格会落进「限流/额度」默认分支 ⇒ 给账号写一个标记 ⇒
          //    用户只是消息太长却被封账号。
          throw error
        }
        if (info.kind === 'auth') {
          // 认证失败：**标记并切下一个账号是对的，但不写限流标记**。
          // 也不能在试完全部槽后报「所有账号均受限」—— 真实原因通常是
          // 「这枚 token 失效」，与额度无关 ⇒ 最后一次失败**直接透传原文**。
          /**
           * ⚠️⚠️ **先尝试续期，再换号**（2026-11-23 审计 P2 补）。
           *
           * 本家**有**真实 refresh 端点 ⇒ 「这个号救得回来」。
           * 漏了这条腿的后果：令牌一过期，用户就看到 401，
           * 而定时器/积分自愈都不在推理路径上 ⇒ 只能干等或回面板手点。
           *
           * ⚠️ **每个槽只试一次**（`refreshed` 集合去重）：refresh 是**账号级**
           * 副作用（会轮换 refresh_token 并落盘），在循环里反复调既浪费又可能
           * 把刚续好的凭据再轮换一次。
           *
           * ⚠️ 续期失败**不吞异常**（`catch` 里只记日志）—— 它不该掩盖真正的
           * 认证错误，也不该因为「续期这条路也失败了」就变成另一条错误链。
           */
          if (this.options.refresh !== undefined && !refreshed.has(slot.id)) {
            refreshed.add(slot.id)
            try {
              /**
               * ⚠️ 传 `slot.id`：接线层必须续**刚失败的那个号**
               * （2026-11-23 二轮审计修，🔴B-2）。
               *
               * 不传时接线层只能 `getAvailableAccount()` 取池里第一个可用账号
               * ⇒ 实测「轮换起点选 acc-2、却续了 acc-1」，
               * 而 `refresh_token` 一次性轮换 ⇒ 白烧另一个号的凭据。
               */
              await this.options.refresh(slot.id)
              /**
               * ⚠️⚠️ **必须撤销 `tried` 才叫「续期后重试」**（2026-11-23 终审修，真缺陷）。
               *
               * ## 原实现的双重缺陷（实测复现）
               *
               * ```
               * HTTP 请求次数: 1  |  refresh 调用次数: 1  |  错误码: QUOTA_EXCEEDED
               * ```
               *
               * 1. **续期白调**：`tried.add(slot.id)` 在进循环第一件事就执行（`:665`），
               *    而这里是永久集合、**全仓没有任何 `tried.delete`**
               *    ⇒ `continue` 之后 `slots.find(s => !tried.has(s.id))` 找不到该槽
               *    ⇒ `slot === undefined` ⇒ 直接抛「所有账号均受限」
               *    ⇒ **续好的凭据一次都没被用上**。
               * 2. **错误码谎报**：单账号场景下 `tried.size >= slots.length` 立刻成立，
               *    落到 `QUOTA_EXCEEDED`「所有账号对该模型均受限」
               *    ⇒ 用户会去**解锁长期积分**（不可撤回！），而真因只是令牌过期、
               *    而且续期**已经成功**。
               *
               * ## 修法
               *
               * 续期成功后 `tried.delete(slot.id)` —— 让该槽**重新进入候选**
               *（凭据已换新，值得再发一次）。
               * `refreshed` 仍保留 ⇒ 每个槽最多续期一次，不会死循环。
               */
              if (tried.delete(slot.id)) {
                this.options.warn?.(`qwenworkintl: 账号 ${slot.id} 认证失败，已续期并重试`)
              }
              /**
               * ★★★ **必须重新取槽快照**（2026-11-23 二轮审计修，🔴B-1）。
               *
               * ## 不重新取会发生什么（实测）
               *
               * ```
               * 换票时用的 token 序列: ["OLD-TOKEN"]   ← 续期后仍用它
               * 续期后凭据库里的值:    NEW-TOKEN       ← 库真的改了，但没用上
               * ```
               *
               * `slots` 是 `stream()` 循环**开始前**取的一份 `{ id, accessToken }`
               * 快照；续期改的是**凭据库**，快照里的 token 不会自己变
               * ⇒ `tried.delete` 让该槽重新可被选中，但重发仍用旧 token ⇒ 再 401。
               *
               * ⇒ 双重浪费：用户仍看到 401 + 每轮白烧一次一次性 `refresh_token`。
               *
               * ⚠️ `fetchSlots` 未注入时（探针适配器 / 单测替身）保持旧快照，
               * 行为与改动前一致（本功能的唯一回归面）。
               */
              if (this.options.fetchSlots !== undefined) {
                try {
                  slots = await this.options.fetchSlots(options.model, options.sessionId)
                } catch {
                  // ⚠️ 取不到就沿用旧快照（不要让「刷新快照失败」变成新错误）。
                }
              }
              continue
            } catch (refreshError) {
              this.options.warn?.(
                `qwenworkintl: 账号 ${slot.id} 续期失败：${String(refreshError)}`,
              )
            }
          }
          /**
           * ⚠️⚠️ **`limited.push` 必须在 `throw error` 之前**（2026-11-23 终审修）。
           *
           * 原顺序（`throw` 在前）会让循环末尾的 `authOnly` 分流**永远不可达**：
           * 最后一个槽在 `throw` 那一刻就出去了，`limited` 里只剩前面几个，
           * ⇒「全部账号认证失败」这条汇总判据永远等不到它的输入。
           *
           * 变异验证实测：把 `authOnly` 分支改成 `if (false)` 守卫仍然全绿
           * —— 就是因为这段代码走不到。
           *
           * 现在的顺序：**先记账、再决定要不要抛**。
           */
          limited.push(`${slot.id}(认证失败)`)
          /**
           * ⚠️ 抓住上游原文（见 `lastAuthError` 声明的理由）。
           * `error` 是 `streamVia` 抛上来的原始异常，其 message 里带着上游报文。
           */
          lastAuthError = error
          authErrorDetail = String((error as Error).message ?? error)
          /**
           * ⚠️ 最后一个槽**不在这里抛**，而是 `continue` 回循环顶部，
           * 由 `slot === undefined` 那条出口统一汇总 ——
           * 只有这样 `authOnly` 分流才拿得到完整的 `limited`。
           *
           * ⚠️ 这也让「单账号」那一格变成 AUTH 文案（而不是原始 401 报文）：
           * 对单账号用户，那句「重新登录」比裸 401 更有用。
           */
          continue
        }
        if (info.kind === 'server' || info.kind === 'transport') {
          // 上游故障/网络问题：**不写标记**（不是配额问题），只换下一个。
          this.options.warn?.(`qwenworkintl: 账号 ${slot.id} ${info.kind}，换下一个：${info.detail}`)
          // ⚠️ 换号有意义只在「故障是账号级」时：单账号用户看到「额度用尽」
          //    而真因是上游 5xx，排障方向完全错 ⇒ 槽耗尽时把**原始错误**抛出去。
          if (tried.size >= slots.length) throw error
          continue
        }
        // 限流 / 额度：标记该槽后换下一个。
        const resetAtMs = Date.now() + qwenworkRetryAfterMs(info.kind, info.retryAfterMs, tried.size)
        await this.options.markLimited?.(slot.id, options.model, resetAtMs)
        limited.push(`${slot.id}(${info.kind})`)
      }
    }
  }

  /** 指定槽发一次请求（轮换循环的复用单元）。 */
  protected async *streamVia(slot: QwenworkSlot, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const imageUrls = await this.resolveImageUrls(options.model, options.messages)
    const messages = serializeMessages(
      options.messages as readonly { role: string; content: unknown }[],
      imageUrls,
    )

    // ⚠️⚠️ **这一段是本家与 qiniu 的唯一实质差异**：先换 MaaS 票据。
    const ticket = await this.options.mintTicket(slot, options.signal)

    // ⚠️⚠️ **必须走 `buildQwenworkPayload`，绝不内联拼 body**：
    //    工具 + system 折叠 + max_tokens 守卫三件事都在那个函数里，
    //    而 `tools` 漏包装会让**每一次带工具的请求**都 400
    //    （2026-11-22 实测复现，见 qwenwork-messages.ts 模块头）。
    const payload = buildQwenworkPayload({
      model: normalizeQwenworkModelId(options.model),
      messages,
      ...options.system !== undefined && options.system.length > 0
        ? { system: options.system }
        : {},
      ...options.tools !== undefined ? { tools: options.tools } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      ...options.reasoningEffort !== undefined
        ? { reasoningEffort: String(options.reasoningEffort) }
        : {},
    })

    const url = `${ticket.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      // ⚠️ 这里用 **MaaS token**，不是登录 token —— 两者不可混用。
      headers: qwenworkHeaders(ticket.token, 'text/event-stream'),
      body: JSON.stringify(payload),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })

    if (!response.ok) {
      // ⚠️ **必须先读体**：额度/限流的语义在响应体里，而 body 只能读一次。
      const text = await response.text().catch(() => '')
      const retryAfterMs = retryAfterMsFromResponse(response.headers)
      const info = classifyQwenworkError(response.status, text, {
        ...(response.headers.get('retry-after') === null
          ? {}
          : { 'retry-after': response.headers.get('retry-after') as string }),
      })
      // ⚠️⚠️ **额度必须用字面量 `'QUOTA_EXCEEDED'`，不能交给 `httpErrorCode`**：
      //    国际站的额度拒绝是 **HTTP 429 + `balance_insufficient`**，而
      //    `httpErrorCode(429)` = `'RATE_LIMIT'` ⇒ 落错桶；且 harness 的
      //    `QUOTA_EXCEEDED_CODE` 字面值就是 `'QUOTA'`，客户端会丢掉 message
      //    换成「当前请求的额度已用尽」⇒ 额度必须用字面量。
      // ⚠️⚠️ **上下文超限必须归 `CONTEXT_WINDOW_EXCEEDED`**：国际站实测回
      //    **HTTP 400 + `context_length_exceeded`**，落进 `httpErrorCode(400)`
      //    会得到 `'INVALID_REQUEST'` ⇒ 宿主的 context-overflow 监听器
      //    （判据第一行是 `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return`）
      //    **完全不触发** ⇒ 自动压缩不跑，唯一有效动作被掩盖。
      const code = info.kind === 'quota'
        ? 'QUOTA_EXCEEDED'
        : info.kind === 'rate_limit'
          ? 'RATE_LIMIT'
          : info.kind === 'context_window'
            ? CONTEXT_WINDOW_EXCEEDED_CODE
            : info.kind === 'auth'
              ? 'AUTH'
              : httpErrorCode(response.status)
      throw new LlmError(
        `qwenworkintl: HTTP ${response.status} — ${text.slice(0, 300)}`,
        code,
        {
          status: response.status,
          ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        },
      )
    }

    // ⚠️⚠️ **content-type 闸门**：网关返回 **HTTP 200 + `text/html`**
    //    （风控拦截页 / 登录墙）时若被当成正常响应喂给 `consumeOpenAiSse`
    //    ⇒ 解析不出任何帧 ⇒ 抛 `EMPTY_RESPONSE` ⇒ 分类读到 `status = 0`
    //    ⇒ 命中「传输错误」⇒ 轮换把整个账号池白打一遍 ⇒ 最后抛
    //    「所有账号均受限」。⇒ 用户看到的是「额度用尽」而真因是风控。
    //    归类 `SERVER`（**不重试**）：风控是身份/环境问题，原样重发只会再被拦。
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const peek = await response.text().catch(() => '')
      throw new LlmError(
        `qwenworkintl: 上游未返回事件流（content-type: ${contentType || '(空)'}）——`
        + '通常是被风控拦截（网关返回 200 + HTML 拦截页）。'
        + `${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}`,
        'SERVER',
        { status: response.status },
      )
    }

    yield* consumeOpenAiSse(
      response,
      options.signal !== undefined ? { signal: options.signal } : {},
      {
        label: 'qwenworkintl',
        firstTokenTimeoutMs: this.product.chatHeaderTimeoutMs,
        chunkTimeoutMs: this.product.chunkTimeoutMs,
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      },
    )
  }
}

/**
 * 从 `LlmError` 还原成语义化分类。
 *
 * ⚠️ 事实挂在 `error.failure` 上（`LlmFailure` 契约），**不是**展开在 error
 * 自身 —— 早期版本误按「自身属性」读响应头，`retry-after` 因此永远读不到
 * （opencode 写单测时实测到：`expected 590000, got 60000`）。
 */
export function classifyQwenworkFailure(error: unknown): QwenworkErrorInfo {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    failure?: { status?: unknown; providerRetryAfterMs?: unknown }
    /**
     * ⚠️⚠️ **裸错误的 `status` / `body`**（2026-11-23 二轮审计修，🔴B-3）。
     *
     * ## 为什么需要读这两个字段
     *
     * 本函数原先**只读** `error.failure.status`（`LlmError` 的契约形状）。
     * 而**换票**那一步（`QwenworkAuth.mintTicket`）抛的是**裸 `Error`**
     * —— 没有 `failure` 嵌套，于是 `status` 恒 `0` ⇒ 分类落到最后一个
     * `else`（`transport`）：
     *
     * ```
     * 换票 401 归类     → transport   （应为 auth）
     * refresh 调用次数  → 0           （应为 1）
     * 抛出的 code      → undefined   （应为 AUTH）
     * ```
     *
     * ⚠️ 而「登录 token 只有 15 天、MaaS 票据每请求都换」⇒ 令牌过期时
     * **第一现场几乎总是换票**，不是推理。漏了这一格 ⇒ 自愈链在最高频
     * 场景下从未生效，且客户端拿不到 `AUTH` 码 ⇒ 不渲染「重新登录」。
     *
     * ## 判据
     *
     * `failure.status`（`LlmError`）优先；缺席时读 `status`（裸错误）。
     * 两者都没有 ⇒ `0`（与改动前一致）。
     * `body` 也一并读进来：真实的上游报文比 `error.message` 里的前缀更纯
     *（`message` 形如 `"qwenworkintl: 换取推理票据失败（HTTP 401）——{…}"`，
     * 把它当 body 喂给分类器会让子串判据命中包装文案而不是上游原文）。
     */
    status?: unknown
    body?: unknown
  }
  const nestedStatus = typeof failure.failure?.status === 'number' ? failure.failure.status : undefined
  const flatStatus = typeof failure.status === 'number' ? failure.status : undefined
  const status = nestedStatus ?? flatStatus ?? 0
  const providerRetryAfterMs = typeof failure.failure?.providerRetryAfterMs === 'number'
    && Number.isFinite(failure.failure.providerRetryAfterMs)
    ? failure.failure.providerRetryAfterMs
    : undefined
  /**
   * ⚠️ **body 优先**：裸错误带的 `body` 是**纯上游报文**，
   * 而 `error.message` 前面那段包装文案（`"换取推理票据失败（HTTP 401）——"`）
   * 会让分类器的子串判据命中错的地方。
   */
  const body = typeof failure.body === 'string' && failure.body.length > 0
    ? failure.body
    : error instanceof Error ? error.message : String(error)
  const info = classifyQwenworkError(status, body)
  return providerRetryAfterMs === undefined
    ? info
    : { ...info, retryAfterMs: info.retryAfterMs ?? providerRetryAfterMs }
}

/** 在 `ctx.llm` 上注册 qwenworkintl 路由。 */
export function registerQwenworkLlm(
  ctx: Context,
  options: QwenworkAdapterOptions,
): QwenworkAdapter {
  const product = options.product ?? QWENWORK_INTL
  const adapter = new QwenworkAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
