# 交接文档：「轮换起点」功能的维护与同步

> 写给**未来的你**和**未来的 AI 助手**。
> 目的：上游更新后，把本功能安全地重新叠加到新版上游上。
>
> ## ⚠️ 本文档已脱敏
>
> 路径用占位符表示，**使用前先替换成你的实际路径**：
>
> | 占位符 | 替换为 |
> |---|---|
> | `<REPO_ROOT>` | 插件仓库根目录（含 `package.json` 的那层） |
> | `<PROXY_ROOT>` | 仓库的上一级目录（放方案文档的地方） |
> | `<DSH_PROFILE>` | DSH 的 profile 目录（含 `package.json` 与 `node_modules`） |
>
> ⚠️ 若你让 AI 帮忙操作，**只把路径告诉它**，不要让它猜 —— 猜错会改错文件。
>
> ---
>
> ## 🎯 职责边界（**上下文被压缩后必须先读这段**）
>
> 本会话（或接手的 AI）**只负责两件事**：
>
> | # | 职责 | 边界 |
> |---|---|---|
> | **1** | 维护「轮换起点」功能（PR #59） | 只改与 `preferredRotation` / `rotateFromPreferred` / `rotationStartId` 相关的代码 |
> | **2** | 上游更新后 rebase 本功能并保持 PR 可用 | 只做同步，**不借机改功能** |
>
> ### ⚠️ 明确**不负责**的（已经交给其他 AI）
>
> | 需求 | 状态 |
> |---|---|
> | **Token 用量面板按账号归档 + 显示真实账号名 + 最近请求加账号列** | 方案已交付（`<PROXY_ROOT>/方案-Token面板按账号归档.md`），**由其他 AI 执行** |
>
> ⇒ 若有人在本会话提 Token 面板相关的改动，**告知它走另一个执行者**，不要在这里动手。
>
> ### ⚠️ 两个容易混淆的分支
>
> | 分支 | 内容 | 可否混用 |
> |---|---|---|
> | `feat/rotation-start` | 功能代码（**1 个提交**） | ✅ 只有它进 PR #59 |
> | `docs/rotation-handover` | **就是本文档** | ❌ 不要合并进功能分支（会污染 PR diff） |

---

# 第一部分：给 AI 的提示词（直接复制粘贴）

> ⚠️ 下面三份提示词按场景选一份，**连同上文背景一起**发给 AI。

## 场景 A：上游更新了，我要同步本功能（最常用）

```
我有一个 fork 仓库，加了一个「轮换起点」功能，现在上游更新了，我要把
这个功能重新叠加到新版上游上。请按下面步骤帮我操作，**每步做完先给我看
结果，我确认了再继续**。

## 仓库位置
<REPO_ROOT>

## 当前状态（请你先核实，不要假设）
- 功能分支：feat/rotation-start
- 功能提交：**c62ae2c**（`git rev-parse feat/rotation-start` 现查）<br>  基线**已随上游 rebase 过一次**（1d12f80 → 6ad2e24）⇒ 不要硬编码基线，用 `git merge-base`
- 远端：fork = https://github.com/hansomgar/dsh-providers-hub.git
- 上游：origin = iJetLi/dsh-providers-hub

## ⚠️ 重要约束
1. **不要 fetch/push 到 origin**（那是上游，你只能读）
2. **绝对不要用 `git push --force`**，只能用 `--force-with-lease`
3. **不要执行 `pnpm install`**（会重新拉依赖，改动 profile 状态）
4. 任何写文件的操作**必须用 UTF-8 无 BOM**：
   [System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($false))
   （这个仓库因 BOM 出过事故：package.json 带 BOM 会导致 DSH 启动失败）
5. 具体步骤与常见冲突的解法见《交接文档》第二部分

## 执行顺序
1. 先跑 `git log --oneline origin/master..HEAD` 确认当前只有 1 个功能提交
2. `git fetch origin`（只更新远端引用，不合并）
3. `git checkout feat/rotation-start`
4. `git rebase origin/master`
5. 若有冲突 → 按《交接文档》第四节处理，每解决一个文件告诉我
6. 跑《交接文档》第五节的验证清单，**必须全绿**
7. 告诉我结果，我确认后再 push

## 如果 rebase 出问题
`git rebase --abort` 可以完全恢复。
若已搞乱：`git reset --hard $(git rev-parse fork/feat/rotation-start)`（回到远端已推的版本）
```

## 场景 B：上游接受了 PR，我要清理 fork

```
我的 fork 上的「轮换起点」功能已经被上游合并了。请帮我：
1. 确认上游 master 里真的有这个功能（搜索 preferredRotation）
2. 把本地切回 master 并同步上游
3. 删掉本地和远端的 feat/rotation-start 分支
4. 告诉我怎么把 DSH 的插件源改回上游官方版本
仓库位置：<REPO_ROOT>
```

## 场景 C：我想改这个功能，但要先理解它

```
请先读 <PROXY_ROOT>\交接文档-轮换起点.md 的
第三部分（功能实现说明），理解「轮换起点」功能后，再帮我做以下修改：
[你的需求]

⚠️ 改之前请特别确认：
- 旋转的调用点是否仍在 select() 里两种策略排完序**之后**
- 未设置起点（undefined）时行为是否与改动前逐字节相同
```

---

# 第二部分：同步操作手册（给人和 AI）

## 2.1 一分钟版

```powershell
cd <REPO_ROOT>

git fetch origin                                # 1. 拉上游
git checkout feat/rotation-start                # 2. 切功能分支
git rebase origin/master                        # 3. 变基（冲突按 §2.4 处理）

# 4. 验证（必须全绿，见 §2.5）
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npx vitest run tests/unit/rotation-start.spec.ts tests/unit/rotation-free-model.spec.ts `
              tests/unit/rotation-session-id-wiring.spec.ts tests/unit/rotation-expiring-null.spec.ts `
              tests/unit/rotation-storage-cap.spec.ts tests/unit/rotation-tooltip.spec.ts

# 5. 推送
git push --force-with-lease fork feat/rotation-start
```

## 2.2 为什么用 rebase 而不是 merge

本功能压在**单个提交**里（每次 rebase 后 SHA 会变，用 `git rev-parse feat/rotation-start` 现查）。

- `rebase` ⇒ 永远是「上游 + 1 个提交」⇒ `git log origin/master..HEAD` 恒为 1 条，
  diff 干净、冲突面最小；
- `merge` ⇒ 留下合并提交，且上游历史被「埋」进去，下次看不出本功能改了什么。

## 2.3 为什么用 `--force-with-lease`

rebase 改写了历史，必须强推。`--force-with-lease` 会在「远端有别人不知道的提交」时**拒绝**，
避免覆盖掉别处的改动。**绝不用 `--force`。**

## 2.4 冲突处理（按文件，按概率排序）

### 高风险（改了同一处必有冲突）

| 文件 | 冲突位置 | 保留什么 |
|---|---|---|
| `src/account-pool.ts` | `preferredRotationCache` 字段 / `ensureLoaded` 载入 / save 快照 / 两个方法 | 本功能那 4 处**全部保留** |
| `src/jet-hub-rpc.ts` | 两个 `case`（`account.getRotation` / `account.setRotation`） | 整段保留 |
| `plugin-src/client/usage-badge.js` | 大量新增（约 191 行代码） | **整体保留**本功能的新增块 |
| `tests/unit/jet-hub-store.spec.ts` | 三处整文档断言 | 加 `preferredRotation: {}`（若上游加了别的字段，两行都要留） |

### 中风险

| 文件 | 冲突位置 | 保留什么 |
|---|---|---|
| `src/jet-hub-store.ts` | 类型定义 / `sanitizePreferredRotation` / `prunePreferredRotation` / schema 一行 / 3 处 sanitize 调用 / 默认值一行 | 全部保留 |
| `src/buddy-balance-selector.ts` | `const rankedByStrategy` 那一处 + `rotationStartId` 透传 | 保留旋转调用 |

### 低风险（纯新增，几乎不冲突）

```
src/buddy-balance-rank.ts          ← rotateFromPreferred 函数 + rotationStartId 字段
src/credential-resolver.ts         ← rotateFreeCandidates + 免费分支 + rotationStartId 透传
src/{accio,autoclaw,buddy,cline,gemini,lobsterai,loomy,minimax,qoder,raccoon,trae}-adapter.ts
                                   ← 每个只改 2 行（签名 + 调用点）
plugin-src/client/index.js         ← 3 个 prop 注入
plugin-src/client/jet-hub-styles.js ← 5 行 CSS
tests/unit/rotation-*.spec.ts      ← 6 个新文件，永不冲突
```

### ⚠️ 解完冲突必做三件事

**① 核对 `preferredRotation` 的 7 处接线**（少一处就是静默失效）：

| 位置 | 内容 |
|---|---|
| `jet-hub-store.ts` | ① 类型 `PreferredRotationMap` ② `sanitizePreferredRotation` ③ `prunePreferredRotation` ④ schema `preferredRotation: Schema.dict(...)` ⑤ sanitize 调用 ×3 ⑥ 默认值 `preferredRotation: {}` |
| `account-pool.ts` | ⑦ 字段 `preferredRotationCache` ⑧ `ensureLoaded` 载入 ⑨ save 快照 ⑩ `preferredRotationFor` ⑪ `setPreferredRotation` |

**② 核对旋转调用点在正确位置**：

```ts
// src/buddy-balance-selector.ts
const rankedByStrategy = options.strictManualOrder === true
  ? rankBuddyAccountsByManualOrder(balances, options)
  : rankBuddyAccountsByBalance(balances, options)
const ranked = rotateFromPreferred(rankedByStrategy, options)   // ★ 必须在排序之后
```

⚠️ **不能**把 `rotateFromPreferred` 放进那两个 `rankXxx` 函数里 —— 会变成两份同义实现。

**③ 核对 11 个 adapter 的签名 + 调用点**：

```ts
// 签名必须有第二参
resolveCredential: (modelId?: string, sessionId?: string) => Promise<XxxCredential | undefined>
// 调用点必须传
await this.options.resolveCredential(options.model, options.sessionId)
```

⚠️ 这是本功能**最容易复发**的缺陷：类型签名窄于实现时 `tsc` **不报错**，
运行时也不抛，只是功能静默不生效。有守卫（`rotation-session-id-wiring.spec.ts` 23 条）。

## 2.5 验证清单（必须全绿）

```powershell
cd <REPO_ROOT>

# ① 提交数必须是 1
git log --oneline origin/master..HEAD          # 只有 1 条

# ② 工作区干净
git status --porcelain                          # 空

# ③ 双 tsc
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit

# ④ 本功能的 6 个测试文件（81 条）
npx vitest run tests/unit/rotation-start.spec.ts tests/unit/rotation-free-model.spec.ts `
              tests/unit/rotation-session-id-wiring.spec.ts tests/unit/rotation-expiring-null.spec.ts `
              tests/unit/rotation-storage-cap.spec.ts tests/unit/rotation-tooltip.spec.ts

# ⑤ 客户端构建（含 CSS 校验）
node plugin-src/client/build.mjs

# ⑥ 全量（可选，约 70 秒）
npx vitest run
```

⚠️ **全量里有一条恒红**：`autoclawintl-zai-wiring.spec.ts` 的「失败后必须还能重试成功」
—— 那条**真发本机 HTTP**，环境不允许时必然 `UND_ERR_SOCKET`。
**它不是回归**，与本功能无关。

## 2.5.5 先预测会不会冲突（强烈建议先跑这个）

不用真的 rebase 就能知道哪些文件会冲突：

```powershell
cd <REPO_ROOT>
git fetch origin

# 上游改过的文件 ∩ 本功能改过的文件 = 可能冲突的文件
$base = git merge-base HEAD origin/master
$upstream = git diff --name-only $base..origin/master
$mine     = git diff --name-only $base..HEAD
$upstream | Where-Object { $mine -contains $_ }
```

- **输出为空** ⇒ rebase 不会冲突，放心跑；
- **有输出** ⇒ 那些文件要按 §2.4 处理。

⚠️ **用 `git merge-base` 自动算基线，不要硬编码** —— 本功能已 rebase 过一次（1d12f80 → 6ad2e24），写死的基线会立刻过时。
若本功能已 rebase 过多次，基线要换成「上一次 rebase 的目标提交」——
用 `git merge-base HEAD origin/master` 自动算：

```powershell
$base = git merge-base HEAD origin/master
git diff --name-only $base..origin/master | Where-Object { (git diff --name-only $base..HEAD) -contains $_ }
```

## 2.6 出问题怎么回退

```powershell
git rebase --abort                    # rebase 中途取消
git reset --hard $(git rev-parse fork/feat/rotation-start)   # 回到远端已推的版本
git reflog                            # 查所有历史位置
```

---

# 第三部分：功能实现说明（改代码前必读）

## 3.1 它做什么

在用量弹窗里选一个账号作为**轮换起点**：

```
策略顺序：A → B → C → D →（回到 A）
选 C 后： C → D → A → B →（回到 C）
```

⚠️ **只挪起点，不改任何选号策略** —— 档位判据、可用性过滤、失败换号规则全部照旧。

## 3.2 三条不变量（改代码时不能破坏）

1. **集合不变** —— 只旋转，不增删候选；
2. **保序** —— 起点前后各自保持原相对顺序；
3. **默认不变** —— 未设置时与改动前**逐字节相同**（这是唯一的回归面）。

## 3.3 数据流（5 层）

```
① 适配器  options.sessionId  ─┐
                              ↓
② resolver  preferredRotationFor(provider, sessionId) → rotationStartId
                              ↓
③ selector  select() 里 rotateFromPreferred(ranked, options)
                              ↓
④ rank      rotateFromPreferred：旋转 + 起点跳过不可用
                              ↓
⑤ pool      preferredRotationCache（state.json 持久化）
```

⚠️ **任何一层断了，功能静默失效**（不报错）。三层都踩过坑：
- ① 层：11 个适配器原本不传 `sessionId`（本 PR 修复）
- ③ 层：曾经把旋转放进 effect 但 effect 根本不执行（`const` 在组件 `return` 之后）
- ⑤ 层：`locked` 字段曾经没存进 state

## 3.4 三条选号路径（三处实现，刻意不合并）

| 路径 | 函数 | 为什么分开 |
|---|---|---|
| 余额分档（buddy 系 / trae / qoder / minimax / autoclaw / magicrew / astudio / lobsterai） | `rotateFromPreferred`（`buddy-balance-rank.ts`） | 需要 `buddyBalanceTier(..., {allowPermanent})` 才知道哪些号可用 ⇒ **要查余额** |
| 池选号（codearts / cline / gemini / opencode …） | `rotateFromAccountId`（`account-pool.ts`） | 候选已过 enabled/封禁/限流 ⇒ 全是可用项 ⇒ **不需要查余额** |
| 免费模型 | `rotateFreeCandidates`（`credential-resolver.ts`） | 免费路径**刻意不查余额** ⇒ 纯旋转 |

⚠️ **不要合并这三处**：合并会把「需要查余额」带进不需要它的两条路径。

## 3.5 三个刻意不支持的渠道

| 渠道 | 原因 |
|---|---|
| `zcode` | 选号走 rendezvous 会话亲和，优先级由哈希决定 ⇒ 插起点会互相干扰 |
| `loomy` | 分档语义是 `dailyBalance`（今日赠送额度），与 buddy 系不同 ⇒ 本轮未接入 |
| `aggregate` | 虚拟 provider，本身不选号 |

UI 对这些渠道**不渲染**下拉框（`supportsRotation()` 白名单）—— 渲染一个「选了没用」的控件比不渲染更糟。

## 3.6 刻意的设计取舍（**改之前务必理解**）

| # | 取舍 | 为什么这么做 |
|---|---|---|
| 1 | **起点优先于积分档位** | 用户选了谁就用谁。指定「仅永久」的号会先烧永久积分 —— 这是「起点绝对优先」的直接结果，tooltip 已写明 |
| 2 | **起点不可用 ⇒ 循环到下一个**，不是回落默认 | 用户明确要求「按循环池循环到下一个」 |
| 3 | **UI 用 `disabled` 而非「可选+toast」** | 原生 `<select>` 的 `disabled` 项**不触发 `change` 事件** ⇒ 技术上拿不到「用户点了它」 |
| 4 | **`position` 用数组序，不是策略序** | 算策略位次需查余额；且「账号 N」在用户心智里对应面板上第 N 张卡片 |
| 5 | **失败必须可见**，不许静默 `return null` | 这个功能曾因静默失败排查了十几轮 |

## 3.7 存储格式

```jsonc
// ~/.dsh/jet-hub/state.json
"preferredRotation": {
  "qodercn": {
    "session-<EXAMPLE_ID>": {
      "accountId": "qodercn-c5a414d5",
      "at": 1794284557890
    }
  }
}
```

- **两层**：provider → sessionId → `{accountId, at}`
- **存 `accountId` 而非位次**：位次会随拖拽/增删变化
- **`at`**：按会话数上限淘汰最旧的（64/provider）
- **兼容老格式**：值是裸字符串时补 `at = 0`

## 3.8 6 个测试文件守什么

| 文件 | 条数 | 守什么 | 对应的真实缺陷 |
|---|---|---|---|
| `rotation-start.spec.ts` | 14 | 旋转语义 | （核心功能） |
| `rotation-free-model.spec.ts` | 7 | 免费模型也走起点 | 选 0959 却用 4016 |
| `rotation-session-id-wiring.spec.ts` | 23 | 11 个 adapter 签名+调用点 | 同上（真正的根因） |
| `rotation-expiring-null.spec.ts` | 8 | `splitCreditsByExpiry` 三处错误 | 锁定后弹窗崩溃 |
| `rotation-storage-cap.spec.ts` | 16 | 容量上限 + 老格式 | 提 PR 前审计发现 |
| `rotation-tooltip.spec.ts` | 13 | tooltip 必含四件事 | 说明不清导致误解 |

⚠️ 这些守卫**都是真实缺陷换来的**，删任何一个都可能复发。

---

# 第四部分：关键事实备查

## 4.1 仓库与分支

| 项 | 值 |
|---|---|
| 本地路径 | `<REPO_ROOT>` |
| 功能分支 | `feat/rotation-start` |
| 功能提交 | **不写死** —— `git rev-parse feat/rotation-start` 现查（每次 rebase 后变） |
| 上游基线 | **不写死** —— `git merge-base HEAD origin/master` 现查 |
| 上游仓库 | `iJetLi/dsh-providers-hub`（remote 名 `origin`，**只读**） |
| fork 仓库 | `hansomgar/dsh-providers-hub`（remote 名 `fork`） |
| 改动规模 | 28 文件，+1797 / −55（其中注释 751 行、测试 743 行、功能代码约 200 行） |

## 4.2 DSH 安装位置

| 项 | 值 |
|---|---|
| profile | `<DSH_PROFILE>` |
| 插件 | `node_modules\dsh-providers-hub` |
| 源 specifier | `package.json` 的 `dependencies['dsh-providers-hub']` |
| 构建白名单 | `pnpm-workspace.yaml` 的 `allowBuilds`（**新增提交必须加一行**，否则 install 失败） |

### 切换到某个提交的完整流程

```powershell
# 1. 改 package.json 的 specifier（⚠️ 必须无 BOM）
$prof = "<DSH_PROFILE>"
$pkg = "$prof\package.json"
$raw = [System.IO.File]::ReadAllText($pkg, [System.Text.UTF8Encoding]::new($false))
$cur = ($raw | ConvertFrom-Json).dependencies.'dsh-providers-hub'
[System.IO.File]::WriteAllText($pkg, $raw.Replace($cur,
  "github:hansomgar/dsh-providers-hub#<完整SHA>"), [System.Text.UTF8Encoding]::new($false))

# 2. allowBuilds 加一行（key 格式：包名@codeload URL）
#    "dsh-providers-hub@https://codeload.github.com/hansomgar/dsh-providers-hub/tar.gz/<完整SHA>": true

# 3. 安装
cd $prof
pnpm install --no-frozen-lockfile
```

⚠️ **BOM 是致命问题**：`package.json` 带 BOM 会让 DSH 启动失败。
检查：`[System.IO.File]::ReadAllBytes($p) | Select-Object -First 3` 不得是 `EF BB BF`。

## 4.3 已知的恒红测试（不是回归）

```
tests/unit/autoclawintl-zai-wiring.spec.ts
  > ★★ Z.ai OAuth 回调闭环 > ★★ 失败后必须还能重试成功
```

它**真发本机 HTTP**（`127.0.0.1:18432`），环境不允许时必然 `UND_ERR_SOCKET`。
与本功能无关，**每次都会红**，忽略即可。

## 4.4 相关的本地文档（仓库外）

`<PROXY_ROOT>\` 下：

| 文件 | 内容 |
|---|---|
| `交接文档-轮换起点.md` | 本文档 |
| `REBASE-轮换起点.md` | 早期版本（内容已并入本文档，可忽略） |
| `PR-轮换起点.md` | PR 说明（内容已进 commit message） |
| `方案-轮换起点v3.md` / `v4.md` | 设计演进过程（历史） |
| `方案-轮换起点tooltip.md` | tooltip 方案 |

---

# 第五部分：给 AI 的额外提醒（重要）

如果你（AI）在维护这个功能，以下几条是**用真金白银的排查换来的**：

1. **不要相信「静态检查通过」** —— 本功能有 3 个缺陷是 `tsc`、单测、TDZ 闸门**全部通过**的情况下存在的：
   - `const` 定义在组件 `return` 之后 ⇒ 永不执行
   - 11 个 adapter 的签名少了 `sessionId` ⇒ 永不生效
   - `splitCreditsByExpiry` 传错参数 ⇒ 返回 `null` 导致崩溃

2. **不要用 `?.` 掩盖 null** —— 排查时我写过 `loadRotationRef.current?.()`，
   可选链把「ref 是 null」这个事实**又吞了一次**。直接写 `.()` 会立刻抛错定位。

3. **尽量加可观测性** —— 「一直读取中」那次，正是因为失败**没有任何提示**才排查了十几轮。
   现在 `renderRotation()` 的每个分支都会显示具体原因。

4. **单测样例要能区分实现** —— 三元素选末位时，「旋转」与「提到最前」结果**恰好相同**，
   测不出差异。用 **≥5 元素且选中间项**。

5. **改完必须跑变异验证** —— 把实现改坏，确认测试**真的会红**。
   我有两版守卫是假的（一版只查关键词、一版被文案别处命中），都是变异验证抓出来的。
