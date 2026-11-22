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
 * ## ⚠️ 图片能力是**逐模型**的（不是整表 true）
 *
 * 实测 `pro` / `glm-5.3` 收图回 **400**，其余 7 个正常。故
 * `supportsImage` 从目录条目读，`resolveImageUrls` 命中不支持的直接抛
 * `UNSUPPORTED_CONTENT`（**不静默丢弃** —— 静默丢弃会让用户以为模型看到了图，
 * 这是 Qoder 图片事故的教训）。
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
  /**
   * 模型图标 URL（上游 `icon`）。
   *
   * ⚠️ **DSH 没有渲染位置**（`LlmModelInfo` 全库无 icon/logo 字段）⇒ 仅留档，
   * `toCatalogEntry` **不传**它（传了也是死字段）。
   */
  icon?: string
  /** 上游 `is_new`：是否新上架（用来画「新」徽标）。 */
  isNew?: boolean
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
  /** 可用槽位（传 `modelId` 时接线层应跳过处于限流窗口的账号）。 */
  readonly slots: (modelId?: string) => Promise<readonly QwenworkSlot[]>
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
     * ⚠️ **徽标（`badge`）** —— 宿主 `LlmModelInfo.badge` 的**唯一**渲染位置是
     * 模型选择器每行的**名字右侧**（`ModelSelect.tsx` 的 `placement: 'option'`），
     * 渲成 `Tag` 胶囊。`tone: 'success'` = 绿字 + 10% 绿底（= 截图那种观感）。
     *
     * ⚠️ **本家上游不下发任何促销信息**（实测 11 条：`price_factor` 最低 0.1、
     * 无一条为 0，也没有 `promotion`/`discount` 字段）⇒ **做不出「限时免费」**。
     * 唯一有的事实性徽标是 `is_new: true`（8 个模型）⇒ 用它画「新」。
     * ⚠️ 绝不为了凑出绿框而编造促销（本仓红线）。
     */
    ...m.isNew === true
      ? { badge: { text: { en: 'New', zh: '新' }, tone: 'info' as const } }
      : {},
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
    ...m.isNew === true ? { isNew: true } : {},
    ...m.priceFactor === undefined ? {} : { priceFactor: m.priceFactor },
    ...m.icon === undefined ? {} : { icon: m.icon },
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
  listAllModels(): readonly { id: string; name: string }[] {
    return fallbackEntries().map((m) => {
      const entry = toCatalogEntry(m)
      return { id: entry.id, name: entry.name }
    })
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
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const id = normalizeQwenworkModelId(model)
    const all = fallbackEntries()
    const entry = all.find((m) => m.id === id)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id,
      /**
       * ⚠️ **必须与 `listModels` 同源**（走 `toCatalogEntry` 的唯一转换点）：
       * 否则「设置页显示裸名、选择器显示带倍率」= 同一模型两个名字。
       * ⚠️ 但 `resolveModel` 的回包类型**不带 `badge`**（宿主
       * `normalizeModelInfo` 逐字段白名单、明确丢弃 badge）⇒ 这里只取 name。
       */
      name: entry === undefined ? id : toCatalogEntry(entry).name,
      inputModalities: entry?.supportsImage === true
        ? (['text', 'image'] as const)
        : (['text'] as const),
    }
    // ⚠️ 窗口未知**不编造**：0 是「不知道」哨兵，不能当合法窗口下发 ——
    //    自动压缩会拿它算阈值并抛 TargetPressureConfigError。
    const contextWindow = entry?.contextWindow ?? 0
    if (contextWindow > 0) resolved.context = { contextWindow }
    // ⚠️ 档位为**空**时**不声明**本字段（而不是给 `efforts: []`）：
    //    声明空数组会让 UI 出现一个没有任何档位的空选择器（opencode IKJJ0V）。
    const efforts = entry?.efforts ?? []
    if (efforts.length > 0) {
      resolved.reasoning = {
        efforts: efforts.map((effort) => ({
          id: ReasoningEffortId(effort),
          name: effort === 'none' ? '关闭' : effort,
        })),
      }
    }
    return resolved
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

    const all = fallbackEntries()
    const entry = all.find((m) => m.id === normalizeQwenworkModelId(model))
    if (entry?.supportsImage !== true) {
      throw new LlmError(
        `qwenworkintl: 模型 "${model}" 不支持图片输入`
        + '（实测 pro / glm-5.3 收图会回 400，其余 7 个模型正常）',
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
    // ⚠️ 传 modelId：接线层据此跳过「该模型正处于限流窗口」的账号。
    const slots = await this.options.slots(options.model)
    if (slots.length === 0) {
      throw new LlmError(
        'qwenworkintl: 没有可用账号。请在 Jet Hub 的千问办公国际版面板点「登录」，'
        + '用**正常邮箱**（Gmail / Outlook 等）注册的账号授权'
        + '（⚠️ 临时邮箱拿不到赠送积分，实测额度恒为 0）。',
        'MISSING_CREDENTIAL',
      )
    }

    const tried = new Set<string>()
    const limited: string[] = []

    for (;;) {
      const slot = slots.find((s) => !tried.has(s.id))
      if (slot === undefined) {
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
          if (tried.size >= slots.length) throw error
          limited.push(`${slot.id}(认证失败)`)
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
  }
  const status = typeof failure.failure?.status === 'number' ? failure.failure.status : 0
  const providerRetryAfterMs = typeof failure.failure?.providerRetryAfterMs === 'number'
    && Number.isFinite(failure.failure.providerRetryAfterMs)
    ? failure.failure.providerRetryAfterMs
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  const info = classifyQwenworkError(status, message)
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
