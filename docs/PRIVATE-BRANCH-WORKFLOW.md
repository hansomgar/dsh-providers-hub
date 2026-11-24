# 私有分支与上游 PR 并行工作的方案

> 目标：**能持续给上游提 PR，同时本机始终有 qwenworkintl 可用。**
>
> 本文是操作手册。新会话接手时读这一份即可。

---

## 一、事实基础（决定方案形态）

### 1.1 qwenworkintl **无法**拆成独立插件包

它在 9 个自有文件之外，**必须**改这 10 个共享文件（插件系统的硬约束）：

| 共享文件 | 为什么必须改 |
|---|---|
| `src/provider-registry.ts` | 不登记 ⇒ 客户端 `unknown provider` |
| `src/index.ts` | 不注册 ⇒ 不进 `provider-runtime` 注册表 ⇒ 续期/积分/探测三条链全静默失效 |
| `src/jet-hub-rpc.ts` | 不加 `JetHubAuths` 键 ⇒ 该 provider 所有 RPC 报 `bad-request` |
| `src/aggregate-adapter.ts` / `src/aggregate-expiry.ts` | 不登记 ⇒ 聚合轮换里静默消失 |
| `src/provider-credits.ts` / `src/provider-expiry.ts` | 不登记 ⇒ 积分/到期两条链失效 |
| `src/jet-hub-store.ts` | ref 前缀表（`QWENWORKINTL` → provider id） |
| `plugin-src/client/jet-hub.js` / `provider-icons.js` | 侧边栏 rail 与图标 |
| `tests/helpers/*` | 按 registry 派生的清单 |

⇒ **拆包不可行**（除非上游支持「外部 provider 注册」这个能力，目前没有）。

### 1.2 但「通用修复」可以**完全不含** qwenwork

反例证明：`rotationStartTier` 那个修复（PR #148）只碰
`src/buddy-balance-selector.ts` + 一个新测试文件，**零 qwenwork 字样**，
已被上游合并。

⇒ 两者在**文件层面可分**。问题只在于：现在它们混在同一个分支历史里。

### 1.3 当前分支的实际构成（2026-11-24 统计）

`feat/qwenwork-intl-provider` 相对 `origin/master` 共 **38 个提交**：

| 类别 | 数量 | 能否提 PR |
|---|---|---|
| merge 提交（空 diff） | 6 | — |
| 纯 qwenwork（只碰 qwenwork 文件） | 11 | ❌ |
| 接线（碰共享文件且 diff 含 qwenwork） | 20 | ❌ |
| **通用修复** | **1** | ✅ **已提 PR #148，已合并** |

⚠️ **关键结论：当前分支已经是「纯私有」状态** —— 唯一的通用修复已经贡献出去了。
剩下的 31 个提交全是私有资产，本来就不该提 PR。

⇒ 所以本方案要解决的是**未来**，而不是清理历史。

---

## 二、方案：双层分支

```
origin/master（上游，只读跟踪）
      │
      ├──→ upstream-work                 ← 只放「可提 PR 的通用修复」
      │         │
      │         └──(merge)──→ feat/qwenwork-intl-provider   ← 私有叠加层，DSH 挂这个
      │
      └──(提 PR：从 upstream-work 切 feature/xxx → push fork → PR)
```

### 为什么两层而不是一层

- **一层**（现状）：通用修复和 qwenwork 接线混在一起 ⇒ 每次提 PR 都要手工挑拣、
  且容易把 qwenwork 带上去（这是真实风险，我前几轮每次都要小心翼翼地
  从纯上游切分支）。
- **两层**：`upstream-work` 里**物理上不存在** qwenwork 文件 ⇒
  从它切出来的任何分支都**不可能**带上 qwenwork。风险从「靠纪律」变成「靠结构」。

### 三层职责

| 分支 | 存放什么 | 谁能看 |
|---|---|---|
| `origin/master` | 上游代码 | 公开 |
| `upstream-work` | 通用修复（可提 PR）+ 上游最新 | 可推 fork（提 PR 用） |
| `feat/qwenwork-intl-provider` | qwenwork + 其接线 + 通用修复（merge 进来） | 只在你 fork（**不提 PR**） |

---

## 三、三条日常规则

### 规则 1：通用修复在 `upstream-work` 上开发

```bash
git checkout upstream-work
git fetch origin && git merge origin/master     # 先对齐上游

git checkout -b fix/某个通用缺陷
# 只改共享文件；提交前自检：不得出现 qwenwork 字样
git commit -m "fix(...): ..."
git push fork fix/某个通用缺陷
gh pr create --repo iJetLi/dsh-providers-hub --base master --head hansomgar:fix/某个通用缺陷
```

**提 PR 前必跑的自检**（脚本见 §六）：

```bash
node tools/check-no-private.mjs            # 当前分支
```

### 规则 2：私有开发在 `feat/qwenwork-intl-provider` 上

```bash
git checkout feat/qwenwork-intl-provider
# 随便改 —— 包括共享文件里的接线、registry 条目、README
```

### 规则 3：同步上游用 **merge**，不用 rebase

```bash
git checkout feat/qwenwork-intl-provider
git fetch origin
git merge origin/master
# 解冲突（通常只在「两边各加各的」位置，如 registry 数组、spec 清单）
```

**为什么 merge 不 rebase**：

| | merge | rebase |
|---|---|---|
| 私有分支 38 个提交 | 只解一次冲突 | **每次都要重解 20 处** |
| 已推送的 fork 分支 | 直接 push | 必须 force push |
| 历史可读性 | 有 merge 节点，能看出「哪批来自上游」 | 线性但失真 |

⚠️ 本仓的 sharable 文件（registry 数组、`AGGREGATE_CHANNELS`、
spec 里的 provider 清单）是冲突高发区，rebase 会反复撞。

---

## 四、DSH 必须一直挂着私有分支 ⇒ 用 worktree

**约束**：DSH profile 用 `link:` 指向主目录
（`C:\Users\HSG\.dsh\profiles\desktop\package.json` 的
`"dsh-providers-hub": "link:E:/.../dsh-providers-hub"`）。
在主目录切分支 ⇒ DSH 下次重启会加载**另一个分支的代码**（可能起不来）。

**解法**：用 git worktree 让两个分支**同时存在**：

```
E:\Data\data_dsh\2026\dsh-agent-proxy\
    dsh-providers-hub\       ← 主目录，DSH 挂这里，长期停 feat/qwenwork-intl-provider
    dsh-providers-hub-pr\    ← 提 PR 专用，检出 upstream-work 或临时 feature 分支
```

⚠️ worktree 共享 `.git` 对象库，**不占额外空间**（只有工作区文件）。
⚠️ 新 worktree 需要 `node_modules` —— 用 junction 指回主目录的（见 §六 脚本）。
⚠️ **同一个分支不能同时检出到两个 worktree** —— 这是 git 的限制，
也是「主目录必须独占私有分支」的原因。

---

## 五、一次性搭建

```bash
cd E:/Data/data_dsh/2026/dsh-agent-proxy/dsh-providers-hub

# ① 建 upstream-work（从上游最新）
git fetch origin
git branch upstream-work origin/master

# ② 建 worktree（提 PR 用）
git worktree add ../dsh-providers-hub-pr upstream-work

# ③ 给 worktree 接上 node_modules（junction，不复制）
cd ../dsh-providers-hub-pr
cmd /c mklink /J node_modules "..\dsh-providers-hub\node_modules"

# ④ 验证
git worktree list
npx tsc --noEmit        # 应通过
```

⚠️ **不要**把 worktree 建在 `dsh-providers-hub` 目录里面（会造成嵌套，git 会混乱）。

---

## 六、驻场脚本

### 6.1 `tools/check-no-private.mjs` —— 提 PR 前的自检

判据（任一命中即拒绝）：

1. 工作区/暂存区文件路径含 `qwenwork`
2. 相对 `origin/master` 的 diff 内容含 `qwenwork` 字样
3. `src/provider-registry.ts` 里出现 `qwenworkintl`

用途：在 `upstream-work` 派生的 feature 分支上跑，**必须**输出 ✅ 才能 push。

### 6.2 用法

⚠️⚠️ **脚本本身住在私有分支上，PR worktree 里没有它** —— 这是刻意的：
它引用了本方案（私有工作流），不该进上游。

**正确用法：从 PR worktree 用相对路径调主目录的脚本。**

```bash
# 在 PR worktree（../dsh-providers-hub-pr）里：
node ../dsh-providers-hub/tools/check-no-private.mjs

# 或从主目录（私有分支）看报告（加 --allow-private 只看不拦）：
node tools/check-no-private.mjs --allow-private
```

**为什么跨目录调用能成立**：`git` 命令按 **cwd** 定位仓库，
而 worktree 是**独立的工作区**（有自己的 HEAD / index）。
⇒ 脚本文件从主目录读，但 `git diff` 在 PR worktree 上执行 ⇒ 检查的正是 PR 的内容。

⚠️ 所以**绝不能** `cd` 到主目录再跑想检查 PR —— 那查的是私有分支（必然命中）。

### 6.3 建议挂到 pre-push（可选）

`.git/hooks/pre-push`（**不入库**，本机专用）：

```sh
#!/bin/sh
# 只在非私有分支上检查
branch=$(git rev-parse --abbrev-ref HEAD)
case "$branch" in
  feat/qwenwork-intl-provider) exit 0 ;;
esac
node tools/check-no-private.mjs || exit 1
```

---

## 七、常见问题

### Q1：我在私有分支写了个通用修复，想提 PR 怎么办？

两条路：

**A（推荐）**：在 `upstream-work` 上**重做一遍**（通常 5~20 行，比挑拣便宜）。
这正是 PR #148 的做法 —— 从纯上游切分支，只把那 3 行 + 测试带过去。

**B**：`git cherry-pick <hash>` 到 `upstream-work` 派生分支，
然后**逐 hunk 剔除** qwenwork 相关内容。⚠️ 私有分支的提交大多改了
registry/index 的接线，cherry-pick 必然带进来，需要手工剔 —— 通常比 A 更慢。

### Q2：上游合并了我的 PR，私有分支怎么拿到？

```bash
git checkout feat/qwenwork-intl-provider
git fetch origin && git merge origin/master
```
merge 进来即可。⚠️ 如果上游**改了我的实现**（如 #148 上游补了 e2e 守卫、
收编了我的用例），merge 会带来他们的版本 —— **以他们的为准**，
本地改动如与之冲突要重解。

### Q3：私有分支的 merge 冲突为什么总是那几处？

因为本仓有若干「按 provider 追加清单」的结构：
- `PROVIDER_REGISTRY` 数组
- `AGGREGATE_CHANNELS` / `WIRED_EXPIRY_PROVIDERS`
- 各 spec 里的 provider 名单
- `tests/helpers/provider-sets.ts` / `rpc-refresh.ts`

上游每加一家 provider 就会碰这些 ⇒ 我们每加一家 qwenwork（只加一次）
也会碰。冲突形态恒为「两边各加各的」⇒ **双保留**即可，不需要取舍。

### Q4：能不能干脆不提 PR，只同步上游？

可以 —— 那就是现在这个分支的日常（`git merge origin/master`）。
本方案只是**额外**给你一条「想贡献时怎么贡献」的通路，不改变私有分支的用法。

---

## 八、已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 忘记切回私有分支就重启 DSH | DSH 加载上游代码 ⇒ qwenwork 消失（**用户已遇到过一次**） | worktree 隔离；重启前 `git branch --show-current` |
| 在 `upstream-work` 上误改 qwenwork 接线 | PR 带上私有代码 | `check-no-private.mjs` 闸门 |
| 两处 worktree 的 `lib/` 产物流串 | DSH 加载到过期产物 | 只在主目录构建；`lib/` 已 gitignore |
| 上游改了同型逻辑（如 `pinnedFirst` 与 `rotationStartTier`） | merge 冲突且语义要重核 | 见 Q3，双保留 + 跑全量 |
| 私有分支长期不 merge 上游 | 越拖越难合并 | 每次上游有动静就 merge（本仓上游很活跃，几乎每天有新提交） |