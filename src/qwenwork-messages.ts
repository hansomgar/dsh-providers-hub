/**
 * 千问办公国际站（QwenWork Intl）的 wire 层形状门禁：工具包装 + payload 装配。
 *
 * ## ⚠️⚠️ 本文件存在的**唯一理由：工具必须包成 OpenAI 形状**
 *
 * DSH 下发的 `GenerateOptions.tools` 是**扁平**结构：
 *
 * ```ts
 * { name: 'ops_bash', description: '...', parameters: {...} }
 * ```
 *
 * 而 OpenAI 兼容上游要求**两层包裹**：
 *
 * ```ts
 * { type: 'function', function: { name, description, parameters } }
 * ```
 *
 * 直接把扁平结构塞进 `tools` ⇒ 上游回 **HTTP 400 `invalid_request`**，
 * 症状是**每一次带工具的对话都失败**（而 DSH 几乎每轮都带工具）⇒
 * 「渠道能加、模型能选、一发消息就报错」，且报文只有一句
 * `invalid_request`，完全指不出是工具形状的问题。
 *
 * 这与本仓 `qiniu-messages.ts` 记录的 `invalid_parameter_error -
 * 'tools.0'` 事故**同型同因**（七牛云那边的原话是
 * `'type' is a required property - 'tools.0'`）。2026-11-22 本家实测复现：
 * 扁平传 ⇒ 400；包成 `{type:'function',function:{…}}` ⇒ 200 且
 * `finish_reason: 'tool_calls'`。
 *
 * ## ⚠️ 工具定义**恒带**（哪怕是空数组）
 *
 * 带工具意图的请求必须让上游看到 `tools` 字段**存在**。这是上面那条事故
 * 修法的另一半（qiniu-messages 的注释逐字记过）：
 * 「`tools` **恒带**（哪怕是空数组）：带工具的请求必须让上游看到 `tools`
 *   字段的存在」。
 *
 * ⚠️ 但本家的实测口径与 qiniu **微差**：本家**不带 `tools` 时也能正常对话**
 * （2026-11-22 实测 `flash` 无工具请求 200）。故本文件的策略是
 * 「**有工具就带、没工具就不带**」—— 与 `openai-compat` 的通用口径一致，
 * 而不是恒带空数组（那样会让不带工具的请求多一个无用字段）。
 *
 * ## ⚠️ `system` 不放顶层，折进 `messages[0]`
 *
 * 与 `qiniu-messages.ts` 同一处理（`foldSystemIntoMessages`）：OpenAI 兼容上游
 * 只从 `messages[]` 读系统提示词，顶层的 `system` 字段被**静默忽略**。
 * 静默忽略的后果是「插件里配的系统提示词完全没生效」而界面上一切正常 ——
 * 极难发现。本家未单独实测顶层 `system`（无必要，折叠形态是安全且通用的）。
 *
 * @module src/qwenwork-messages.ts
 */

import { foldSystemIntoMessages } from './system-prompt-fold.js'

/** DSH 的工具 schema（`GenerateOptions.tools` 的形状，**扁平**）。 */
export interface QwenworkHarnessTool {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** OpenAI wire 侧的工具定义（**两层包裹**）。 */
export interface QwenworkWireTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/**
 * DSH 工具 → wire 工具（**唯一出口**）。
 *
 * ⚠️⚠️ **这是本文件的核心**：不包这一层，每一次带工具的请求都被上游 400
 * （见模块头）。**不要把类型收紧回扁平结构** —— 那会让这个 400 复发，
 * 而症状（一句 `invalid_request`）完全指不出根因。
 *
 * ⚠️ 空描述**整个省略**（不是发空串）：与 `openai-compat` 同口径。
 *
 * ⚠️ `parameters` 缺失时省略该键（不是给 `{}`）：部分上游对空 schema 的
 * 校验比「无该键」更严。
 */
export function buildQwenworkTools(
  tools: readonly QwenworkHarnessTool[] | undefined,
): QwenworkWireTool[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description.length > 0
        ? { description: tool.description }
        : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
}

/** `buildQwenworkPayload` 的入参。 */
export interface QwenworkPayloadInput {
  model: string
  messages: ReadonlyArray<Record<string, unknown>>
  system?: string
  /** DSH 的**扁平**工具列表（本函数负责包装）。 */
  tools?: readonly QwenworkHarnessTool[]
  temperature?: number
  maxTokens?: number
  /**
   * 思考档位（`GenerateOptions.reasoningEffort` 的字符串形态）。
   *
   * ⚠️ 声明了档位就**必须真的发出去**，否则选择器只是 UI 装饰 ——
   * 用户选了「关闭思考」却没有任何效果（issue IKJJ0V 的同款教训）。
   * 本家实测 `reasoning_effort` 生效（high 时 `reasoning_tokens` = 35）。
   */
  reasoningEffort?: string
}

/**
 * 构造一次 chat 请求的完整 body。
 *
 * 契约细节（每条都对齐仓库既有适配器）：
 *
 * - `stream` **恒 true**：本适配器只走 SSE 路径，没有非流式分支；
 * - `system` **不放顶层**：由 `foldSystemIntoMessages` 折成**第一条**
 *   `messages[]` 成员（见模块头）；
 * - **`max_tokens` 只放行安全正整数** —— 0 / 负数 / NaN 会让上游 400，
 *   而 DSH 侧会把它当契约违规抛 `INVALID_MODEL_MAX_TOKENS`，把整轮对话搞崩
 *   （不是降级，是崩）；
 * - `tools` **只在实际有工具时出现**（见模块头）；
 * - `temperature` 只放有限数。
 */
export function buildQwenworkPayload(input: QwenworkPayloadInput): Record<string, unknown> {
  const tools = buildQwenworkTools(input.tools)
  return {
    model: input.model,
    messages: foldSystemIntoMessages(input.messages, input.system),
    stream: true,
    ...tools.length === 0 ? {} : { tools },
    ...typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? { temperature: input.temperature }
      : {},
    ...Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0
      ? { max_tokens: input.maxTokens }
      : {},
    ...typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0
      ? { reasoning_effort: input.reasoningEffort }
      : {},
  }
}
