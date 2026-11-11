# 合并 upstream 时，这个功能怎么跟

> 本文只讲**本 fork 独有的「默认取最强思考档」功能**在同步上游时的处理方式。
> 功能实现见 `src/reasoning-default.ts`（模块头有完整证据链）。

## 一句话

上游有更新时，**只要 `registerAdapterIdempotent` 这个函数还在**，把那一处
`withStrongestReasoningDefault` 的调用补回去即可，其余代码不用管。

## 改动面一共 7 个文件，其中只有 4 个是「逻辑」

| 文件 | 性质 | 上游也改了这个文件时怎么办 |
|---|---|---|
| `src/reasoning-default.ts` | **纯新增** | 上游不会动它。**直接保留**，冲突概率 0 |
| `tests/unit/reasoning-default.spec.ts` | **纯新增** | 同上，直接保留 |
| `src/llm-register-compat.ts` | 改了 ~23 行（一个 `if` 块 + 一个 import） | ⚠️ **唯一真正需要注意的文件**，见下 |
| `src/session-title.ts` | 改了 ~26 行（关不掉时降档） | 见下 |
| `tests/unit/session-title.spec.ts` | 改了 2 条用例 | 见下 |
| `tests/unit/model-catalog-parity.spec.ts` | **只加**了一个 (j) 判据块 | 见下 |
| `plugin-src/client/jet-hub.js` | **只加**一段 JSX 灰字 | 见下 |

## 逐个文件的最小补丁

### 1. `src/llm-register-compat.ts`（唯一必须补的）

上游若重写了 `registerAdapterIdempotent`，把这两段补回去：

```ts
// ① 文件顶部
import { withStrongestReasoningDefault } from './reasoning-default.js'

// ② registerAdapterIdempotent 内，紧跟 `let target = wrapAdapterWithTokenLedger(...)` 之后
try {
  target = withStrongestReasoningDefault(providers, target)
} catch (error) {
  warn?.(`[llm-register] 思考档位默认最强包装失败，使用原适配器: ${String(error)}`)
}
```

**位置要求（重要）**：

- 必须在 `wrapAdapterWithTokenLedger` **之后**（记账那层会 `{...call, stream}` 重建
  返回对象；在它里面就得处理重建后的形状）；
- 在 `withAnalyzeImageScoping` / `withDeadModelPruning` **之前**即可（顺序不敏感，
  但保持现状最省事）。

**判断「补对了没有」**：跑

```bash
npx vitest run tests/unit/reasoning-default.spec.ts
```

这条用例走**真实** `registerAdapterIdempotent`，断言的正是「两条腿都生效」。
它绿了就是补对了，不需要再读代码。

### 2. `src/session-title.ts`（可选，但不建议丢）

上游若改了这个文件，要保住的是 `planSessionTitleThinking` 里**关不掉思考**
那条分支的两个要素：

```ts
import { weakestThinkingEffort } from './reasoning-default.js'
// …
const weakest = weakestThinkingEffort(input.declaredEfforts)
return {
  isTitle: true,
  effort: weakest ?? input.requestedEffort,   // ← 降档
  thinkingOff: false,
  maxTokens: /* 原有的抬预算逻辑不动 */,        // ← 抬预算
}
```

**为什么不能只保留抬预算**：本功能把默认档抬到最强后，标题请求只给 64 token，
`max`/`extra_high` 会把预算吃满、正文 0 字符（issue IKKVDH 的原始形态）。
而只降档也不行 —— 实测 `effort:low` + 64 token 同样吃满。**两条腿缺一不可**。

对应的两条用例在 `tests/unit/session-title.spec.ts`：
「关不掉 → 档位降到最弱」与「关不掉且没有更弱的档 → 保留调用方档位」。

### 3. `plugin-src/client/jet-hub.js`（纯文案）

模型中心面板里 `React.createElement('p', { className: 'dim-jh-modalHint' }, '思考强度：…')`
那一段。丢了只影响**可发现性**（用户不知道有这个默认值），不影响功能。
上游若重构了那个面板，把这句文案挪到新的说明位置即可。

### 4. `tests/unit/model-catalog-parity.spec.ts`（守卫，建议保）

`(j)` 那一块（`providerWithoutReasoning` + `DISTANT_EFFORTS` 豁免表）。
它守的是面板灰字的**真话性**：名单里的家必须真的没有档位、名单外的至少一家有。

⚠️ **`DISTANT_EFFORTS` 那 5 家必须保留豁免**（`trae` / `lobsterai` / `accio` /
`qiniu` / `opencode`）：它们的档位来自**远端目录**，这份用例不喂远端数据 ⇒
冷缓存下恒为空。把它们判成「不提供档位」会让面板对用户说假话。

## 上游新增了渠道怎么办

1. `src/provider-registry.ts` 加了新渠道 ⇒ 上面的 (j) 判据会**自动**覆盖它
   （用例是表驱动的），不用改名单；
2. 跑 `npx vitest run tests/unit/model-catalog-parity.spec.ts`：
   - 若报「不在名单里但一个档位都没声明」⇒ 把它加进 `PROVIDERS_WITHOUT_REASONING`
     （前提是它**结构上**从不声明 `reasoning`）；
   - 若它只是「远端驱动、冷缓存为空」⇒ 加进 `DISTANT_EFFORTS` 豁免表，**不要**进
     `PROVIDERS_WITHOUT_REASONING`；
3. 新渠道若声明了档位但没有 `defaultEffort`，本功能**自动**给它补最强档
   （无需任何额外接线）。

## 上游自己也开始做「默认最强档」怎么办

先看它落在哪一层：

- 落在**适配器常量**（各家自己写 `defaultEffort = 'max'`）⇒ 与本功能**不冲突**
  （我们只改宿主看到的那份，不改常量），可以并存；嫌重复了就删本功能，
  但要先确认**所有**渠道都被它覆盖（远端驱动的渠道常量改不动，大概率没覆盖全）。
- 落在**请求期**（改 `agent/request` 或 `resolveCallWithInfo`）⇒ 直接改用它的，
  删掉本功能：那是更根本的位置，本功能只是绕开「改声明」的等价手段。
- 落在**客户端**（改 `dsh-client-ui-model-selection`）⇒ 同上，改用它的。

## 回滚

```bash
git revert <本功能提交>
```

不需要任何数据迁移（本功能没有持久化状态，只有进程内的日志去重 Set）。
