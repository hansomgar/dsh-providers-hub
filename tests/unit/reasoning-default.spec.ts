/**
 * 「选择模型后默认取最强思考档」的行为守卫（2026-11-11 用户功能）。
 *
 * ## 被锁死的两个缺陷方向
 *
 * ① **只包 `resolveModel`、漏掉 `prepareCall`** —— 选择器显示 Max、请求仍按 high
 *    发。生产路径是 `adapter.prepareCall(...)` → `normalizeModelInfo(call.model)`，
 *    **从不**调用顶层 `resolveModel`（见 `reasoning-default.ts` 模块头）。这条
 *    与 `token-ledger-wiring.spec.ts` 的「两层包装」是同一条踩坑史。
 * ② **强档算错** —— 把「取最大」写成 `efforts[0]`、或忘了排除 `off`/`none`、
 *    或选了未登记的私有名。这类错误在界面上表现为「档位没变强」，而**零报错**。
 *
 * ## 为什么既有 156 处 `defaultEffort` 断言一条都不用改
 *
 * 它们全都直接 `new XxxAdapter(...)`（`model-catalog-parity.spec.ts` 的整份对拍
 * 也是），**绕过注册漏斗** ⇒ 测的是「模型默认」语义，而本层改的是「注册后
 * 宿主看到的那份元数据」。两条口径必须分开，否则「模型默认」会被偏好污染、
 * 将来审查「这家该给什么默认」时无从对照。
 */
import { describe, expect, it, beforeEach } from 'vitest'

import { registerAdapterIdempotent } from '../../src/llm-register-compat.js'
import {
  PROVIDERS_WITHOUT_REASONING,
  providerWithoutReasoning,
  registeredChannelIds,
  resetReasoningDefaultAnnouncements,
  strongestDeclaredEffort,
  weakestThinkingEffort,
  withStrongestDefaultEffort,
  withStrongestReasoningDefault,
} from '../../src/reasoning-default.js'
import { reasoningRankOf } from '../../src/reasoning-ladder.js'

// ⚠️ 日志去重态是**进程级**的（见 `reasoning-default.ts` 的 `announced`）：
//    用例之间必须复位，否则「只在首次打日志」那几条会随执行顺序变化。
beforeEach(() => { resetReasoningDefaultAnnouncements() })

// ───────────────────── ① 纯函数：最强档的选择 ─────────────────────

describe('strongestDeclaredEffort：档位选择表', () => {
  /**
   * ⚠️ 每行都对应**真实渠道的声明**（注释里点名），不是编的形态。
   * `efforts` 用真实顺序（远端下发的顺序，故意不排序 —— 本函数必须顺序无关）。
   */
  const TABLE: ReadonlyArray<{ name: string; efforts: readonly string[]; want: string | undefined }> = [
    // trae 远端 `reasoning_effort_config.options` 实测形态。
    { name: 'trae（无 max，最高 extra_high）', efforts: ['light', 'high', 'extra_high'], want: 'extra_high' },
    // buddy / workbuddy / zcode / autoclaw 的产品级三档。
    { name: 'buddy/zcode（low/high/max）', efforts: ['low', 'high', 'max'], want: 'max' },
    // loomy 五档。
    { name: 'loomy（none 在列）', efforts: ['none', 'low', 'medium', 'high', 'xhigh'], want: 'xhigh' },
    // cline 五档，`max` 的 UI 名是 Extra。
    { name: 'cline（含 none）', efforts: ['none', 'low', 'medium', 'high', 'max'], want: 'max' },
    // codearts / raccoon 的两档：on 与 high 同 rank，规范名更靠后的 high 胜。
    { name: 'codearts/raccoon（off/on）', efforts: ['off', 'on'], want: 'on' },
    // magicrew 只有两档，最强就是 high。
    { name: 'magicrew（none/high）', efforts: ['none', 'high'], want: 'high' },
    // gemini：`tiered` 未登记强度 ⇒ 不参与，`high` 才是最高。
    { name: 'gemini（tiered 不参与）', efforts: ['low', 'medium', 'high', 'tiered'], want: 'high' },
    // minimax M3.1：`default` 未登记 ⇒ 不参与；`max` 胜。
    { name: 'minimax（default 不参与）', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], want: 'max' },
    // 聚合：8 个规范档全在，**封顶 max**（ultra 不选）。
    {
      name: 'aggregate（封顶 max，不选 ultra）',
      efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      want: 'max',
    },
    // 只声明了 ultra 的极端形态 ⇒ 退回它（总比不动强）。
    { name: '只有 ultra（超出封顶）', efforts: ['ultra'], want: 'ultra' },
    // 只有关闭档 ⇒ 没有可提的档。
    { name: '只有 none（modelscope）', efforts: ['none'], want: undefined },
    { name: '只有 off', efforts: ['off'], want: undefined },
    // 全是未登记的私有名 ⇒ 不猜。
    { name: '全未登记', efforts: ['adaptive', 'turbo'], want: undefined },
    { name: '空数组', efforts: [], want: undefined },
  ]

  for (const row of TABLE) {
    it(`⚠️ ${row.name} → ${String(row.want)}`, () => {
      expect(strongestDeclaredEffort(row.efforts)).toBe(row.want)
    })
  }

  it('⚠️ 顺序无关：同一组档位打乱后结果不变', () => {
    const base = ['light', 'high', 'extra_high']
    expect(strongestDeclaredEffort([...base].reverse())).toBe('extra_high')
    expect(strongestDeclaredEffort([base[1]!, base[0]!, base[2]!])).toBe('extra_high')
  })

  it('⚠️ 同 rank 取规范名更靠后的（high 胜 on），且与输入顺序无关', () => {
    // 两者 rank 都是 5（`REASONING_EFFORT_RANK`），必须稳定落到 `high`。
    expect(reasoningRankOf('on')).toBe(reasoningRankOf('high'))
    expect(strongestDeclaredEffort(['on', 'high'])).toBe('high')
    expect(strongestDeclaredEffort(['high', 'on'])).toBe('high')
  })
})

describe('weakestThinkingEffort：标题请求用的最弱档', () => {
  it('⚠️ 跳过关闭档，取最弱的「开思考」档', () => {
    expect(weakestThinkingEffort(['none', 'low', 'high', 'max'])).toBe('low')
    expect(weakestThinkingEffort(['off', 'light', 'high', 'extra_high'])).toBe('light')
    // gemini 的 `medium` 是已登记的最弱一跳（`low` 也在，故取 low）。
    expect(weakestThinkingEffort(['low', 'medium', 'high', 'tiered'])).toBe('low')
    // 只有 medium 时就是它（不能被 tiered 这种未登记名顶替）。
    expect(weakestThinkingEffort(['medium', 'tiered'])).toBe('medium')
  })

  it('⚠️ 没有可用的「开思考」档 ⇒ undefined（调用方保留原档位）', () => {
    expect(weakestThinkingEffort(['none'])).toBeUndefined()
    expect(weakestThinkingEffort(['off', 'none'])).toBeUndefined()
    expect(weakestThinkingEffort([])).toBeUndefined()
    expect(weakestThinkingEffort(['adaptive'])).toBeUndefined()
  })
})

// ───────────────────── ② 纯函数：元数据改写 ─────────────────────

/** 造一份最小元数据（形状与 `LlmResolvedModelInfo` 一致）。 */
function info(defaultEffort: string | undefined, efforts: readonly string[]): {
  provider: string
  id: string
  name: string
  reasoning: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
} {
  return {
    provider: 'p',
    id: 'm',
    name: 'M',
    reasoning: {
      efforts: efforts.map((id) => ({ id, name: id })),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    },
  }
}

describe('withStrongestDefaultEffort：改写规则', () => {
  it('⚠️ 把 high 提到 max', () => {
    const out = withStrongestDefaultEffort(info('high', ['low', 'high', 'max']))
    expect(out.reasoning.defaultEffort).toBe('max')
    // 档位列表本身**不得**被改动（顺序是展示顺序，Issue IKLIDV）。
    expect(out.reasoning.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
  })

  it('⚠️ 原本没声明 defaultEffort 的模型也被补上最强档', () => {
    // opencode 等渠道正是这种形态（刻意不下发默认档）。
    const out = withStrongestDefaultEffort(info(undefined, ['low', 'high']))
    expect(out.reasoning.defaultEffort).toBe('high')
  })

  it('⚠️ 已经是最高档 ⇒ **返回同一对象**（下游按身份比较）', () => {
    const input = info('max', ['low', 'high', 'max'])
    expect(withStrongestDefaultEffort(input)).toBe(input)
  })

  it('⚠️ 没有可提的档 ⇒ 返回同一对象', () => {
    const onlyOff = info('none', ['none'])
    expect(withStrongestDefaultEffort(onlyOff)).toBe(onlyOff)
    const noReasoning = { provider: 'p', id: 'm', name: 'M' }
    expect(withStrongestDefaultEffort(noReasoning)).toBe(noReasoning)
    const emptyEfforts = { provider: 'p', id: 'm', name: 'M', reasoning: { efforts: [] } }
    expect(withStrongestDefaultEffort(emptyEfforts)).toBe(emptyEfforts)
  })

  it('⚠️ 改写后的档位**必定**来自已声明集合（否则 DSH 抛 INVALID_MODEL_REASONING）', () => {
    for (const efforts of [
      ['low', 'high', 'max'],
      ['light', 'high', 'extra_high'],
      ['xhigh', 'high', 'low', 'max', 'medium'],
      ['off', 'on'],
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    ]) {
      const out = withStrongestDefaultEffort(info(undefined, efforts))
      expect(efforts).toContain(String(out.reasoning.defaultEffort))
    }
  })
})

// ───────────────────── ③ 漏斗行为级（两腿都要） ─────────────────────

/**
 * 忠实模拟真实适配器的形状（14 家同款）：
 * - `resolveModel` 在**原型**上（对象展开会丢，Proxy 才不会）；
 * - `prepareCall` 返回 `{ model, stream }`，且 `model` 是**另一份**元数据。
 */
class FakeAdapter {
  constructor(private readonly efforts: readonly string[], private readonly declared?: string) {}

  async resolveModel(provider: string, model: string): Promise<Record<string, unknown>> {
    return {
      provider,
      id: model,
      name: 'M',
      reasoning: {
        efforts: this.efforts.map((id) => ({ id, name: id })),
        ...(this.declared === undefined ? {} : { defaultEffort: this.declared }),
      },
    }
  }

  async prepareCall(provider: string, model: string): Promise<{
    model: Record<string, unknown>
    stream: (options: unknown) => AsyncIterable<unknown>
  }> {
    return {
      model: await this.resolveModel(provider, model),
      stream: () => (async function* () { /* 本用例不跑流 */ })(),
    }
  }

  async listModels(): Promise<readonly { id: string; name: string }[]> {
    return [{ id: 'm', name: 'M' }]
  }
}

/** 假 llm：记下注册进去的那个对象（`registerAdapterIdempotent` 的返回值是 dsh 的 handle）。 */
function fakeLlm(): { llm: { registerAdapter(providers: readonly string[], adapter: unknown): unknown }, registered(): unknown } {
  let captured: unknown
  return {
    llm: { registerAdapter: (_providers, adapter) => { captured = adapter; return adapter } },
    registered: () => captured,
  }
}

describe('★★ 注册漏斗：resolveModel 与 prepareCall 两条腿都必须生效', () => {
  it('★★ 经真实 registerAdapterIdempotent：两条腿的 defaultEffort 都是最强档', async () => {
    const { llm, registered } = fakeLlm()
    registerAdapterIdempotent(llm, ['p'], new FakeAdapter(['low', 'high', 'max'], 'high'), () => {})
    const adapter = registered() as {
      resolveModel(p: string, m: string): Promise<{ reasoning?: { defaultEffort?: unknown } }>
      prepareCall(p: string, m: string): Promise<{ model: { reasoning?: { defaultEffort?: unknown } } }>
    }
    expect(adapter, 'registerAdapterIdempotent 必须真的注册了对象').toBeDefined()

    const resolved = await adapter.resolveModel('p', 'm')
    expect(String(resolved.reasoning?.defaultEffort), '选择器读的是这一条').toBe('max')

    const call = await adapter.prepareCall('p', 'm')
    expect(String(call.model.reasoning?.defaultEffort), '⚠️ 生产请求读的是这一条 —— 漏了就是「显示 Max、实发 high」')
      .toBe('max')
  })

  it('⚠️ 该渠道声明无档位时，两条腿都原样透传（不编造 reasoning）', async () => {
    /** officeace / marvis 那类：`resolveModel` 从不返回 `reasoning`。 */
    class NoReasoningAdapter {
      async resolveModel(provider: string, model: string): Promise<Record<string, unknown>> {
        return { provider, id: model, name: 'M' }
      }
      async prepareCall(provider: string, model: string): Promise<Record<string, unknown>> {
        return { model: await this.resolveModel(provider, model), stream: () => (async function* () {})() }
      }
    }
    const { llm, registered } = fakeLlm()
    registerAdapterIdempotent(llm, ['officeace'], new NoReasoningAdapter(), () => {})
    const adapter = registered() as {
      resolveModel(p: string, m: string): Promise<Record<string, unknown>>
      prepareCall(p: string, m: string): Promise<{ model: Record<string, unknown> }>
    }
    expect(await adapter.resolveModel('officeace', 'm')).not.toHaveProperty('reasoning')
    const call = await adapter.prepareCall('officeace', 'm')
    expect(call.model).not.toHaveProperty('reasoning')
  })

  it('⚠️ 包装保留原型方法与 `this`（私有字段可见）', async () => {    class PrivateAdapter {
      readonly #secret = 's3cr3t'
      async resolveModel(provider: string, model: string): Promise<Record<string, unknown>> {
        return { provider, id: model, name: this.#secret }
      }
      async listModels(): Promise<readonly { id: string; name: string }[]> {
        return [{ id: 'm', name: 'M' }]
      }
    }
    const wrapped = withStrongestReasoningDefault(['p'], new PrivateAdapter()) as unknown as {
      resolveModel(p: string, m: string): Promise<Record<string, unknown>>
      listModels(): Promise<readonly { id: string; name: string }[]>
    }
    // 展开成普通对象会让原型方法全部消失（`listModels is not a function`）。
    expect(await wrapped.listModels()).toEqual([{ id: 'm', name: 'M' }])
    expect((await wrapped.resolveModel('p', 'm')).name).toBe('s3cr3t')
  })
})

// ───────────────────── ⑤ 日志：只在首次提升时打一条 ─────────────────────

describe('日志去重：每步 prepareCall 不得刷屏', () => {
  it('⚠️ 同一模型第二次起不再打日志（否则每轮每一步一条）', async () => {
    const calls: string[] = []
    const original = console.info
    console.info = (...args: unknown[]) => { calls.push(args.join(' ')) }
    try {
      const wrapped = withStrongestReasoningDefault(['p'], new FakeAdapter(['low', 'high', 'max'], 'high')) as unknown as {
        prepareCall(p: string, m: string): Promise<unknown>
      }
      // 模拟同一模型的三个连续步骤（真实对话就是这样）。
      await wrapped.prepareCall('p', 'm')
      await wrapped.prepareCall('p', 'm')
      await wrapped.prepareCall('p', 'm')
    } finally {
      console.info = original
    }
    expect(calls.filter((line) => line.includes('思考档位默认取最强')).length, '应只有首次一条').toBe(1)
  })
})

// ───────────────────── ④ 「哪些渠道没有档位」的行为守卫 ─────────────────────

/**
 * ⚠️ **双向**守卫（缺任一个方向都会让面板灰字变成假话）：
 * - 名单内的渠道必须真的一个档位都没有；
 * - 名单外的每个已注册渠道必须**至少一家有档位**。
 *
 * 这里走的是**真实适配器**（不经漏斗），故断言的是「模型默认」语义 ——
 * 灰字讲的是「这个渠道提不提供档位选择器」，与默认值多强无关。
 */
describe('⚠️ PROVIDERS_WITHOUT_REASONING 与实际声明对拍', () => {
  it('名单与已注册渠道全集自洽（不重复、不含虚拟 provider）', () => {
    const channels = registeredChannelIds()
    for (const id of PROVIDERS_WITHOUT_REASONING) {
      expect(channels, `${id} 不在 PROVIDER_REGISTRY 里（名单写错或渠道已改名）`).toContain(id)
    }
    expect(new Set(PROVIDERS_WITHOUT_REASONING).size, '名单有重复项').toBe(PROVIDERS_WITHOUT_REASONING.length)
    for (const virtual of ['aggregate', 'jet-hub-auto', 'auto']) {
      expect(PROVIDERS_WITHOUT_REASONING, `${virtual} 是虚拟 provider，不该进名单`).not.toContain(virtual)
    }
  })

  it('providerWithoutReasoning 只认名单（其余一律 false）', () => {
    for (const id of PROVIDERS_WITHOUT_REASONING) expect(providerWithoutReasoning(id)).toBe(true)
    for (const id of ['trae', 'buddy', 'zcode', 'aggregate', '', 'unknown-provider']) {
      expect(providerWithoutReasoning(id)).toBe(false)
    }
  })
})
