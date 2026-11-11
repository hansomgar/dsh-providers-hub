# 合并 upstream 时，这个功能怎么跟

> 本文只讲**本 fork 独有的「默认取最强思考档」功能**在同步上游时的处理方式。
> 功能实现见 `src/reasoning-default.ts`（模块头有完整证据链）。

## 一句话

上游有更新时，**只要 `registerAdapterIdempotent` 这个函数还在**，把那一处
`withStrongestReasoningDefault` 的调用补回去即可，其余代码不用管。

开关（`reasoningDefault.getEnabled` / `setEnabled`）是**可选项**：丢了它功能仍然
照常工作（只是**恒开、无法关闭**）—— 因为 `strongestReasoningEnabled` 在未接线时
返回 `true`。所以补丁优先级是：**先保提档那一处，再保开关**。

## 改动面一共 9 个文件，其中只有 5 个是「逻辑」

| 文件 | 性质 | 上游也改了这个文件时怎么办 |
|---|---|---|
| `src/reasoning-default.ts` | **纯新增** | 上游不会动它。**直接保留**，冲突概率 0 |
| `src/reasoning-preferences.ts` | **纯新增**（开关的偏好文档） | 同上，直接保留 |
| `tests/unit/reasoning-default.spec.ts` | **纯新增** | 同上 |
| `tests/unit/reasoning-preferences.spec.ts` | **纯新增** | 同上 |
| `src/llm-register-compat.ts` | 改了 ~23 行（一个 `if` 块 + 一个 import） | ⚠️ **最重要的文件**，见下 |
| `src/session-title.ts` | 改了 ~26 行（关不掉时降档） | 见下 |
| `src/jet-hub-rpc.ts` | **只加**两个 RPC 分支 + 两个 import | 见下 |
| `src/index.ts` | **只加** 3 行接线 | 见下 |
| `src/types.ts` | **只加** 3 个类型 | 见下 |
| `tests/unit/session-title.spec.ts` | 改了 2 条用例 | 见下 |
| `tests/unit/model-catalog-parity.spec.ts` | **只加**了一个 (j) 判据块 | 见下 |
| `plugin-src/client/jet-hub.js` | **只加**两段（灰字 + 开关） | 见下 |

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

### 1b. 开关（丢了不致命，但用户就关不掉了）

三处，都是**加性**的：

```ts
// ① src/index.ts —— 装配时接线，必须早于任何 registerXxxLlm
import { configureStrongestReasoningEnabled } from './reasoning-default.js'
import { createReasoningPreferenceStore } from './reasoning-preferences.js'
const reasoningPreferences = createReasoningPreferenceStore(ctx)
configureStrongestReasoningEnabled(() => reasoningPreferences.load())

// ② src/jet-hub-rpc.ts —— handleMethod 里两个分支（照 nativeSearch.* 的形状抄）
//    case 'reasoningDefault.getEnabled' / 'reasoningDefault.setEnabled'
//    外加文件顶部的 createReasoningPreferenceStore import 与三个 RPC 类型 import

// ③ plugin-src/client/jet-hub.js —— 设置弹窗里的「思考强度」一节
//    照「渠道原生搜索」那段逐字同构（它是同一个形状：checkbox + RPC 读写）
```

⚠️ **①里的 `() => reasoningPreferences.load()` 不能写成 `preferences.load()`**：
包一层箭头函数才是「每次现读」；直接传值等于在装配时读一次就锁死，
用户在设置里切了要重启才生效（那正是本仓库反复修的「改了没用」形态）。
变异②守的就是这一条。

### 2. `src/session-title.ts`（可选，但不建议丢）

上游若改了这个文件，要保住的是 `planSessionTitleThinking` 里**关不掉思考**
那条分支的两个要素：

```ts
import { titleEffortWhenStrongest } from './reasoning-default.js'
// …
// ⚠️ 必须走 titleEffortWhenStrongest（它内部判开关）；
//    直接用 weakestThinkingEffort 会让「开关关掉后仍降档」——变异④守的就是这条。
const weakest = titleEffortWhenStrongest(input.declaredEfforts)
return {
  isTitle: true,
  effort: weakest ?? input.requestedEffort,   // ← 降档（开关关时为 undefined ⇒ 原样）
  thinkingOff: false,
  maxTokens: /* 原有的抬预算逻辑不动 */,        // ← 抬预算
}
```

**为什么不能只保留抬预算**：本功能把默认档抬到最强后，标题请求只给 64 token，
`max`/`extra_high` 会把预算吃满、正文 0 字符（issue IKKVDH 的原始形态）。
而只降档也不行 —— 实测 `effort:low` + 64 token 同样吃满。**两条腿缺一不可**。

对应的两条用例在 `tests/unit/session-title.spec.ts`：
「关不掉 → 档位降到最弱」与「关不掉且没有更弱的档 → 保留调用方档位」。

### 3. `plugin-src/client/jet-hub.js`（纯文案 + 一个开关）

设置弹窗里两段，都是**加性**的：

- 「思考强度」一节的 checkbox（照「渠道原生搜索」那段逐字同构，含读取失败
  降级为默认值与「提交中才禁用」两条既有约定）；
- 模型中心面板里那句灰字（「没有思考档位的供应商不参与这一默认值」）。

丢了只影响**可发现性与可关闭性**（用户不知道有这个默认值、也关不掉），
不影响功能本身。上游若重构了那个面板/弹窗，把两段挪到新的说明位置即可。

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
git revert <开关提交> <文档提交> <功能提交>
```

不需要任何数据迁移。⚠️ 唯一残留是磁盘上的 `jet-hub/reasoning-preferences.json`
（一个布尔）：回退后的代码不认识它、也不会读它，**无害**；想干净可以手删。

⚠️ 三个提交要**一起**回退才有意义（单回退功能提交会留下一份讲这个功能的文档，
再单回退开关只会删掉开关而留下功能）。回退后 `git diff <基线>` 应当为空。
