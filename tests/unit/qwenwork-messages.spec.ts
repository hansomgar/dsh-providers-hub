/**
 * 千问办公国际站的 wire 层形状单测（`qwenwork-messages.ts`）。
 *
 * ## ⚠️ 为什么这个文件必须有
 *
 * 2026-11-22 真机实测：把 DSH 的**扁平**工具定义直接塞进 `tools` ⇒ 上游回
 * **HTTP 400 `invalid_request`**，而这在 DSH 里是**每一次带工具的对话**
 * （DSH 几乎每轮都带工具）⇒ 症状是「渠道能加、模型能选、一发消息就报错」，
 * 报文只有一句 `invalid_request`，完全指不出是工具形状的问题。
 *
 * 这与本仓 `qiniu-messages.ts` 记录的 `'type' is a required property -
 * 'tools.0'` 事故**同型同因**。
 *
 * ⇒ 包装形状必须被**逐字节锁死**，且判据要能区分「包了」与「没包」
 * （不能写成只看 `tools` 存在的同义反复）。
 */
import { describe, expect, it } from 'vitest'
import { buildQwenworkPayload, buildQwenworkTools } from '../../src/qwenwork-messages.js'

/** DSH 下发的**扁平**工具（`ToolSchema` 的形状）。 */
const HARNESS_TOOL = {
  name: 'get_weather',
  description: '查询城市天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}

describe('buildQwenworkTools：扁平 → OpenAI 两层包裹', () => {
  /**
   * ⚠️⚠️ **本文件的核心判据**：必须有 `type: 'function'` 与 `function` 包裹。
   * 只断言「数组非空」是恒真的（扁平数组也非空）—— 那正是这条 400 事故
   * 能长期潜伏的原因。
   */
  it('★★ 每个工具都被包成 { type: "function", function: {...} }', () => {
    const wire = buildQwenworkTools([HARNESS_TOOL])
    expect(wire).toHaveLength(1)
    // 反向对照：不是扁平结构
    expect(wire[0]).not.toHaveProperty('name')
    expect('name' in (wire[0] as object)).toBe(false)
    // 正向：两层包裹齐全
    expect(wire[0]!.type).toBe('function')
    expect(wire[0]!.function.name).toBe('get_weather')
    expect(wire[0]!.function.description).toBe('查询城市天气')
    expect(wire[0]!.function.parameters).toEqual(HARNESS_TOOL.parameters)
  })

  /**
   * ⚠️ 用 `JSON.stringify` 做**逐字节**对照：这条能挡住「包了一层但键名写错」
   * （例如写成 `{ type:'function', params:{…} }` —— TypeScript 挡不住
   * 因为 `function` 是保留字附近的松散结构）。
   */
  it('★ 序列化后逐字节等于 OpenAI 形状', () => {
    const wire = buildQwenworkTools([HARNESS_TOOL])
    expect(JSON.stringify(wire[0])).toBe(JSON.stringify({
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询城市天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }))
  })

  it('空工具列表 ⇒ 空数组（调用方据此决定要不要带 tools 键）', () => {
    expect(buildQwenworkTools(undefined)).toEqual([])
    expect(buildQwenworkTools([])).toEqual([])
  })

  /** ⚠️ 空描述**整个省略**（不是发空串）：与 openai-compat 同口径。 */
  it('空描述省略该键（不发空串）', () => {
    const wire = buildQwenworkTools([{ name: 'noop', description: '', parameters: { type: 'object' } }])
    expect(wire[0]!.function).not.toHaveProperty('description')
    expect(JSON.stringify(wire[0]!.function)).not.toContain('description')
  })

  it('多个工具保持顺序且各自独立包装', () => {
    const wire = buildQwenworkTools([
      { name: 'a', description: 'A', parameters: { type: 'object' } },
      { name: 'b', description: 'B', parameters: { type: 'object' } },
    ])
    expect(wire.map((t) => t.function.name)).toEqual(['a', 'b'])
    expect(wire.every((t) => t.type === 'function')).toBe(true)
  })
})

describe('buildQwenworkPayload：完整 body 契约', () => {
  const base = { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }

  it('stream 恒 true（本适配器只走 SSE）', () => {
    expect(buildQwenworkPayload(base).stream).toBe(true)
  })

  /**
   * ⚠️ **`system` 不得出现在顶层**：OpenAI 兼容上游只从 `messages[]` 读系统
   * 提示词，顶层 `system` 被**静默忽略** ⇒ 「插件里配的系统提示词完全没生效」
   * 而界面上一切正常。
   */
  it('★ system 折叠进 messages[0]，顶层不留该键', () => {
    const payload = buildQwenworkPayload({ ...base, system: '你是助手' })
    expect('system' in payload).toBe(false)
    const messages = payload.messages as Array<Record<string, unknown>>
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toBe('你是助手')
    expect(messages).toHaveLength(2)
  })

  it('无 system 时不凭空插入 system 消息', () => {
    const messages = buildQwenworkPayload(base).messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
  })

  /**
   * ⚠️⚠️ **`max_tokens` 必须是安全正整数**：0 / 负数 / NaN 会让上游 400，
   * 而 DSH 侧会把它当契约违规抛 `INVALID_MODEL_MAX_TOKENS`（整轮崩）。
   */
  it('★ max_tokens 只放行安全正整数', () => {
    expect(buildQwenworkPayload({ ...base, maxTokens: 100 }).max_tokens).toBe(100)
    expect(buildQwenworkPayload({ ...base, maxTokens: 0 })).not.toHaveProperty('max_tokens')
    expect(buildQwenworkPayload({ ...base, maxTokens: -1 })).not.toHaveProperty('max_tokens')
    expect(buildQwenworkPayload({ ...base, maxTokens: Number.NaN })).not.toHaveProperty('max_tokens')
    expect(buildQwenworkPayload({ ...base, maxTokens: 1.5 })).not.toHaveProperty('max_tokens')
    // ⚠️ 健在的键名是 `max_tokens`（不是 `max_completion_tokens`）。
    expect(buildQwenworkPayload({ ...base, maxTokens: 100 })).not.toHaveProperty('max_completion_tokens')
  })

  /**
   * ⚠️ 上游实测用的键名是 `reasoning_effort`（high 时 reasoning_tokens=35）。
   * 写成 `reasoning.effort` 或 `thinking` 都不会生效。
   */
  it('★ 思考档位用 reasoning_effort（实测生效的键名）', () => {
    const payload = buildQwenworkPayload({ ...base, reasoningEffort: 'high' })
    expect(payload.reasoning_effort).toBe('high')
    expect(payload).not.toHaveProperty('reasoning')
    expect(payload).not.toHaveProperty('thinking')
    // 空串不带。
    expect(buildQwenworkPayload({ ...base, reasoningEffort: '' })).not.toHaveProperty('reasoning_effort')
  })

  it('temperature 只放有限数', () => {
    expect(buildQwenworkPayload({ ...base, temperature: 0.3 }).temperature).toBe(0.3)
    expect(buildQwenworkPayload({ ...base, temperature: 0 })).toHaveProperty('temperature', 0)
    expect(buildQwenworkPayload({ ...base, temperature: Number.NaN })).not.toHaveProperty('temperature')
    expect(buildQwenworkPayload({ ...base, temperature: Number.POSITIVE_INFINITY })).not.toHaveProperty('temperature')
  })

  /**
   * ⚠️ **无工具时不带 `tools` 键**（本家实测：无工具请求 200）。
   * 这与 qiniu 的「恒带空数组」**刻意不同** —— 那边上游要求字段存在，
   * 这边不需要，多一个无用字段反而增加上游校验面。
   */
  it('★ 无工具时不出现 tools 键；有工具时是包装后的形状', () => {
    expect(buildQwenworkPayload(base)).not.toHaveProperty('tools')
    expect(buildQwenworkPayload({ ...base, tools: [] })).not.toHaveProperty('tools')
    const payload = buildQwenworkPayload({ ...base, tools: [HARNESS_TOOL] })
    const tools = payload.tools as Array<{ type: string; function: { name: string } }>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('get_weather')
    // ⚠️ 反向对照：绝不能是扁平结构（那正是 400 的成因）。
    expect(tools[0]).not.toHaveProperty('name')
  })

  /**
   * ★★ **端到端形状对照**：把 payload 整体序列化，确认 tools 那一格
   * 是两层包裹 —— 这条能挡住「包装函数被绕过」（例如适配器内联拼 body）。
   */
  it('★★ 整体序列化后 tools 是两层包裹（挡「绕过包装函数」）', () => {
    const payload = buildQwenworkPayload({ model: 'glm-5.3', messages: [], tools: [HARNESS_TOOL] })
    const json = JSON.stringify(payload)
    expect(json).toContain('"tools":[{"type":"function","function":{"name":"get_weather"')
    expect(json).not.toContain('"tools":[{"name":"get_weather"')
  })
})
