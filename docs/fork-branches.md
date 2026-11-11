# 本 fork 的分支地图与上游同步手册

> 写给**未来的你**和**未来的 AI 助手**。
>
> 一句话：**`integration/desktop` 是本机跑的那份；`feat/*` 是给上游的 PR；两者都永远
> 由「上游 master + 若干提交」构成，所以上游一更新，各分支各自 `rebase origin/master`
> 即可，我改的东西一个都不会丢。**

---

## 一、两个 remote

| remote | 地址 | 用途 |
|---|---|---|
| `origin` | `github.com/iJetLi/dsh-providers-hub` | **上游，只读**。绝不 push |
| `fork` | `github.com/hansomgar/dsh-providers-hub` | 自己的，PR 从这里出 |

```powershell
git remote -v          # 确认这两条
```

## 二、分支地图

| 分支 | 是什么 | 相对上游 | 上游状态 |
|---|---|---|---|
| `master` | 上游镜像 | 与 `origin/master` **逐字节相同** | 只 `--ff-only`，绝不本地提交 |
| `feat/rotation-start` | 会话级「轮换起点」+ 积分位次编号 | +2 提交 | **PR #59 open** |
| `feat/ledger-account-name` | Token 面板按账号归档 | +1 提交 | 待发 PR |
| `feat/codearts-account-name` | CodeArts 卡片显示真实 IAM 用户名 | +1 提交 | **PR #64 open** |
| `feat/sidebar-ledger-tab` | 右侧栏「Token 用量」标签页 | +2 提交 | **PR #65 open**（2026-11-12 新增） |
| `integration/desktop` | **本机装的那份** = 上游 + 上面 4 个功能 + 9 个视觉/交互定制 | +20 提交 | 不发 PR |

### 四条纪律

1. **`feat/*` 只放一个功能**，且必须基于 `origin/master`。这样 PR 的 diff 干净、
   评审看得懂，`rebase` 最多冲突一次。
2. **`feat/rotation-start` 的名字不可改** —— GitHub PR 的 head 绑定的是**分支名字符串**
   （`hansomgar:feat/rotation-start`），改名会让 #59 立刻变成「head 分支不存在」。
3. **`integration/desktop` 是唯一会被 checkout 的分支**，因为 profile 用的是
   `link:E:/…/dsh-providers-hub`（**不是 SHA 锁定**）⇒ **checkout 什么、构建什么，
   本机就跑什么**。
4. **`lib/` 是 gitignore 的**。切分支后**不重建 = 静默跑旧代码**，这是本仓最容易中的陷阱。

### 为什么 `integration/desktop` 里有 9 个「不发 PR」的提交

它们是**只对本机有意义**的视觉/交互定制（Token 面板三层视觉语言、明细表列宽、
单模型账号合并成行、空账号哨兵文案…）。上游有自己的 UI 审美标准，这些提上去
大概率被拒且会拖慢真正的功能 PR。**保持它们只在 `integration/desktop` 上**，
既不污染 PR，也不影响同步。

---

## 三、上游更新后怎么同步（每次都是这三步）

```powershell
cd E:\Data\data_dsh\2026\dsh-agent-proxy\dsh-providers-hub
$enc = [System.Text.UTF8Encoding]::new($false)   # 本仓文件全 LF，别让 PS 写 BOM

# ── 步骤 0：先看上游改了什么、会不会与我冲突（不用真 rebase 就能预测）
git fetch origin
$base = git merge-base integration/desktop origin/master
Write-Host "可能的冲突文件（上游改过 ∩ 我改过）："
git diff --name-only $base..origin/master |
  Where-Object { (git diff --name-only $base..integration/desktop) -contains $_ }
# 输出为空 ⇒ 不会冲突，放心跑

# ── 步骤 1：master 镜像走快进
git checkout master
git merge --ff-only origin/master
git push fork master

# ── 步骤 2：四条 PR 分支各自 rebase（它们互相独立）
foreach ($b in @('feat/rotation-start','feat/ledger-account-name','feat/codearts-account-name','feat/sidebar-ledger-tab')) {
  git checkout $b
  git rebase origin/master
  # 若有冲突：按第四节处理，然后 git rebase --continue
  git push --force-with-lease fork $b      # PR 自动更新，不需要重开
}

# ── 步骤 3：汇总分支最后走
git checkout integration/desktop
git rebase origin/master
# 若有冲突：按第四节处理
git push --force-with-lease fork integration/desktop
```

### 为什么用 rebase 而不是 merge

`rebase` 之后，任何时刻 `git log --oneline origin/master..<branch>` 都只列出
**我自己加的那几个提交** —— 一眼就能看出「我改了什么」。`merge` 会把上游历史埋进来，
下次再看就分不清哪些是我写的。

⚠️ `--force-with-lease` 而不是 `--force`：前者在远端有你不知道的提交时**拒绝**，
避免覆盖掉别处（比如另一台机器）的改动。

---

## 四、冲突怎么解（按文件，按概率排序）

| 文件 | 谁会改 | 冲突时保留什么 |
|---|---|---|
| `plugin-src/client/jet-hub.js` | 上游 + 我的 Token 面板/视觉定制 + 两种外壳 | **我的改法**（新增块整体保留）；上游改的**同一函数之外的**部分照抄。⚠️ 见下方「TokenLedgerPanel 的固定冲突点」 |
| `plugin-src/client/jet-hub-styles.js` | 上游 + 我的 9 列/StatGroup + `@container` 块 | 两边都要（我的是**纯追加**，落在 `.dim-jh-ledgerPagination` 之后） |
| `plugin-src/client/ledger-tab.js` | **纯新增**（PR #65 带来） | 上游不会动它，冲突概率 0 |
| `src/jet-hub-rpc.ts` | 上游 + 轮换起点 + codearts 显示名 | 三条腿**都在**：上游的新 case、`account.getRotation`/`setRotation`、`enrichCodeartsIdentity` |
| `src/index.ts` | 上游 + 最强思考档开关 | 上游的 import 与**我的 13 行接线**都要（位置：`configureDeadModelStore(ctx)` 之后） |
| `AGENTS.md` | 上游 + 最强思考档 / codearts 显示名两条索引 | **两段摘要都留**（上游那行 + 我的两段） |
| `src/account-pool.ts` / `src/jet-hub-store.ts` | 上游 + 轮换起点持久化 | 我的 `preferredRotation` 五处 + 上游新增字段 |
| `plugin-src/client/usage-badge.js` | 上游 + 轮换起点 UI | 我的位次编号块 |
| `src/llm-register-compat.ts` | 上游 + 最强思考档 | **`withStrongestReasoningDefault` 必须补回去**（见 `docs/reasoning-default-upstream-merge.md`） |

### 解完冲突必做的四件事

```powershell
# ① 双 tsc
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit

# ② 三个功能的守卫用例（缺一个 hunk 就会红）
npx vitest run tests/unit/rotation-start.spec.ts `
              tests/unit/token-ledger-panel.spec.ts `
              tests/unit/codearts-identity.spec.ts `
              tests/unit/codearts-account-name-rpc.spec.ts `
              tests/unit/reasoning-default.spec.ts

# ③ 全量（约 70 秒）
npx vitest run

# ④ 重建客户端 bundle（不做这一步 = 界面还是旧的）
pnpm run build:all
```

⚠️ **已确认的既有失败（不是回归）**：`tests/unit/autoclawintl-zai-wiring.spec.ts`
的「失败后必须还能重试成功」= `UND_ERR_SOCKET`（真发本机 HTTP `127.0.0.1:18432`），
**上游基线 `5581d40` 同样红**（2026-11-12 在干净 worktree 上复现过）。

---

## 四之二、`TokenLedgerPanel` 的**固定冲突点**（PR #65 / 每次同步必看）

这是本 fork 目前**唯一会稳定冲突**的地方 —— 每次 rebase / cherry-pick 大概率都要碰它。
共三处，都有明确的处置规则（**2026-11-12 实测过**，见本节末尾）。

| # | 冲突形态 | 处置 | 自证 |
|---|---|---|---|
| 1 | **函数签名上方**：上游没有任何东西，但 fork 在 `TokenLedgerPanel` 之前插了两个常量（`LEDGER_ENTRY_COLUMNS` / `LEDGER_ENTRY_CSV_COLUMNS`），而 PR #65 在签名上方加了一段注释 ⇒ 两边落在同一位置 | **两边都保留**：fork 的常量与说明在前，PR 的注释 + `function TokenLedgerPanel({ rpcCall, onClose, chrome = 'modal' }) {` 在后。⚠️ 解完确认**只有一个** `function TokenLedgerPanel(` | `grep -c "function TokenLedgerPanel(" plugin-src/client/jet-hub.js` = **1** |
| 2 | **文件尾**的 `__tokenLedgerPanelForTest` 导出注释：fork 与 PR 各写了一段 | **合并成一段**（fork 的「为什么需要导出」技术理由 + PR 的「两种外壳的支点」）。⚠️ 导出语句本身只留**一行** | `grep -c "export const __tokenLedgerPanelForTest" plugin-src/client/jet-hub.js` = **1** |
| 3 | **`package.json` 的 `dsh.client.inject` 数组**：双方都在**末尾**追加一项 ⇒ 经典的「同一位置各加一行」冲突（配置见兄弟条目 `tests/unit/usage-badge-client.spec.ts` 那条放宽后的判据） | **两项都留**，给**前一项补逗号**、后一项不加。顺序无关（该字段只影响模块到达顺序） | 用 `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` 验证可解析，且 `inject` 里含 `@deepseek-ai/dsh-client-ui-sidebar-right` |

### 为什么只在这三处（刻意设计的）

PR #65 对 `jet-hub.js` 的改动**全部落在 `TokenLedgerPanel` 的首尾**：签名 1 行、
`if (chrome === 'pane') { … }` 早退块（在 modal `return` 之前）、文件尾 1 行导出。
**函数体一行未动**，而 fork 的 9 个视觉定制提交全在函数体里 ⇒ 二者结构性不重叠。
`package.json` 那处与 `jet-hub.js` 无关，纯粹是「双方都在数组末尾追加」。

### 解完必查的三件事

```powershell
cd E:\Data\data_dsh\2026\dsh-agent-proxy\dsh-providers-hub
# ① 导出只有一行、签名只有一个
(Select-String -Path plugin-src/client/jet-hub.js -Pattern 'export const __tokenLedgerPanelForTest').Count   # 必须 1
(Select-String -Path plugin-src/client/jet-hub.js -Pattern 'function TokenLedgerPanel\(').Count              # 必须 1
# ② 冲突标记归零
Select-String -Path plugin-src/client/jet-hub.js -Pattern '^(<<<<<<<|=======|>>>>>>>)'
# ③ **modal 分支必须保持逐字节等于上游**（这条最容易被「顺手重构」破坏）
npx vitest run tests/unit/token-ledger-panel.spec.ts    # 32 条，里面有按源码切窗口的断言
```

⚠️⚠️ **第 ③ 条是硬约束**：`token-ledger-panel.spec.ts` 用
`client.slice(modalIdx, client.indexOf('dim-jh-modalBody', modalIdx))` 切窗口断言
modal 的 `dim-jh-modalHint` 与 `createElement('p', {…title:`。**别**把 modal 的 JSX
抽成变量「为了共用」—— 那会让窗口切空、**上游自己的用例当场变红**，而症状看起来
像「测试坏了」。

---

## 四之三、上游前进时的**实测同步演练**（2026-11-12 做过一次，两条轨都通过）

上面那张表不是推演出来的，是**真跑过**的。方法可复现，上游下次真的动了就照这个来。

### 演练怎么做的

在一个 detached worktree 里造一个「模拟上游提交」——刻意挑**最容易撞车**的形态：

| 模拟改动 | 为什么挑它 |
|---|---|
| 往 `TokenLedgerPanel` **函数体**里插入一个 helper（`renderUpstreamExtra`）并调用它 | 函数体正是 PR #65 **刻意避开**的区域 ⇒ 若连它都能过，说明「结构上不重叠」这个设计成立 |
| 往 `package.json` 的 `inject` **末尾追加**一项 | 制造上面第 3 类冲突（双方同位置追加） |

```powershell
# 复现（在任何临时目录，不影响真分支）
git worktree add --detach ..\_sim-upstream origin/master
# …在 worktree 里改 jet-hub.js 的函数体 + package.json 的 inject，提交…
git checkout -b _test-a <PR 分支 tip>   ; git rebase <模拟上游 tip>
git checkout -b _test-b <integration tip>; git rebase <模拟上游 tip>
```

### 实测结果（2026-11-12）

| | 冲突处 | 结果 |
|---|---|---|
| **A 轨**（`feat/sidebar-ledger-tab`，2 提交） | 只有 `package.json` 那 1 处 | rebase 成功；功能标记全在；**57 条守卫全绿** |
| **B 轨**（`integration/desktop`，22 提交） | `jet-hub.js` 1 处（fork 的「单模型合并」提交与模拟上游的 helper 同位置插入）+ `package.json` 1 处 | rebase 成功；**13031 条全量绿**；导出/签名各 1 份 |

两处冲突的解法都是**两边都保留**（互不依赖），没有任何「二选一」的判断。

### 演练踩出来的两个真教训

1. ⚠️⚠️ **`package.json` 那处原来漏记了** —— 我第一版文档只写了 `jet-hub.js` 的首尾两处。
   是这次实测把它找出来的。**以后别只信文档，照上面那段跑一遍**（20 分钟）。
2. ⚠️⚠️ **别用 PowerShell 写回 `jet-hub.js`**：`Set-Content -Encoding utf8` 会加 **BOM**
   并把行尾改成 CRLF。本次实测中招一次（BOM 被写进文件）。用 `node -e` + `fs.writeFileSync`
   按行号/正则处理，改完立刻验「前 3 字节 + 中文是否完整」：

```powershell
node -e "const fs=require('fs');const b=fs.readFileSync('plugin-src/client/jet-hub.js');console.log('BOM:',b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF,'中文:',b.toString('utf8').includes('单模型合并'))"
```

3. ⚠️ **`zcode-captcha-spawn-guard.spec.ts` 会假红**：它读 `lib/zcode-captcha.js`，
   在只跑客户端构建的 worktree 里必然失败（报「请先执行 pnpm build」）。先
   `tsc -p tsconfig.json` 再跑全量，否则会把它误判成 rebase 回归。

### 本 fork 专有的四条 `@container` 规则

`jet-hub-styles.js` 的 `@container (max-width: 720px)` 块里，**后四条是 fork 专有的**
（9 列的 StatGroup 300px / 账号 14px / 模型 26px / 账号列 72px + 表格横向滚动）；
PR #65 只带前七条（8 列口径）。cherry-pick 后**若发现 fork 那四条丢了**，
按 PR 描述里那七条的风格补回即可 —— 它们只作用于 `.dim-jh-ledgerPaneBody` 之内，
**不影响 modal 弹窗**（弹窗宽 960px，那套 9 列正是为它调的）。

---

## 五、上游合并了某个 PR 之后怎么办

假设上游合了 `feat/codearts-account-name`：

```powershell
git fetch origin
git checkout integration/desktop
git rebase origin/master                 # 先同步到含该功能的上游

# 把「我的那份」drop 掉（否则与上游重复）
git rebase -i origin/master
#   把标题为 "feat(codearts): 账号卡片显示真实 IAM 用户名…" 的那一行
#   从 pick 改成 drop
#   ⚠️ cherry-pick 时带了 -x，提交信息末尾有 "(cherry picked from commit …)"，好认

# 冲突一般出现在 src/jet-hub-rpc.ts（两边都加了 codearts 分支）⇒ 保留上游那份
git push --force-with-lease fork integration/desktop
```

**判断上游实现是否等价**：跑**同一条**守卫用例

```powershell
npx vitest run tests/unit/codearts-account-name-rpc.spec.ts
```

- 绿 ⇒ 上游做对了，删掉我们的模块（`src/codearts-identity.ts` 及其 spec）；
- 红（尤其「存量账号拿到真名」那条）⇒ 上游只覆盖了**新登录**的账号、没管存量
  ⇒ 保留我们的 `enrichCodeartsIdentity` 分支（这是最可能的「半实现」形态）。

`feat/rotation-start`（PR #59）同理：合并后把对应的 2 个提交 drop。

---

## 六、装到本机

profile 用的是软链，**不需要改 `package.json`、不需要 `pnpm install` 到 profile**：

```powershell
git checkout integration/desktop
pnpm run build:all
# 然后重启 DSH（客户端 bundle 是启动时加载的）
```

### ⚠️ 装完必须确认「跑的是新代码」

```powershell
# 功能标记自检：三个功能的关键符号都必须在构建产物里
node -e "
const fs=require('fs');
const checks=[
  ['lib/account-pool.js','preferredRotation','轮换起点'],
  ['lib/llm-register-compat.js','withStrongestReasoningDefault','最强思考档'],
  ['lib/jet-hub-rpc.js','enrichCodeartsIdentity','codearts 显示名'],
  ['lib/codearts-identity.js',null,'codearts 显示名模块存在'],
];
let bad=0;
for(const [f,needle,label] of checks){
  if(!fs.existsSync(f)){console.log('MISS',f,label);bad++;continue}
  if(needle===null){console.log('OK  ',f,label);continue}
  const t=fs.readFileSync(f,'utf8');
  console.log(t.includes(needle)?'OK  ':'MISS', f, label); if(!t.includes(needle))bad++;
}
process.exit(bad?1:0);
"
```

`MISS` ⇒ 构建没跑 / 跑在了别的分支上，**别继续**。

---

## 七、回滚

```powershell
# 单分支层面
git rebase --abort                      # rebase 中途取消
git reflog                              # 查所有历史位置
git reset --hard archive/20261112-before-restructure   # 回到重构前

# 功能层面（只撤某一个功能）
git checkout integration/desktop
git rebase -i origin/master             # 把该提交改成 drop
```

**已知良好的 tag 序列**（越新越靠下，都推到 fork 上了）：

```
archive/20261111-rotation      轮换起点
archive/20261111-ledger        Token 面板按账号归档
archive/20261111-combined      两功能合并
archive/20261111-handover      轮换起点交接文档
archive/20261111-preferred     「优先帐号」（已被轮换起点取代）
archive/20261111-reasoning     最强思考档
archive/20261112-rotation-ledger        轮换+归档合并分支（重构前）
archive/20261112-before-restructure     重构前的 integration（15 提交）
```

---

## 八、给 AI 的提醒（本轮实测换来的，别重犯）

1. **PowerShell 回写 UTF-8 源码会毁中文** —— `Get-Content -Raw` 按 ANSI 解码，
   `Set-Content`/`WriteAllText` 回写就是一片乱码，而且**换行全丢**。改源码/文档
   一律用编辑器工具或 `node -e` + `fs.writeFileSync(path, text)`（Node 默认 UTF-8）。
   本轮踩了一次，`src/codearts-identity.ts` 整份重写才救回来。
2. **变异验证的备份必须存原始字节**（`fs.readFileSync` → `Buffer`），
   还原后做 `Buffer.compare` 逐字节校验。用文本往返「还原」会把 CRLF/编码一起改掉。
3. **`feat/rotation-start` 的 SHA 会随 rebase 变，但 PR 不会失效** ——
   GitHub 跟踪的是分支名。强推后 PR 的 `mergeable_state` 会重算（本轮实测仍是 `clean`）。
4. **不要 `git push origin`** —— `origin` 是上游，只读。所有推送走 `fork`。
5. **`AGENTS.md` 已被上游 `gitignore` 之外的机制影响**：它是**指令文件**，
   长度会影响每轮注入的预算（本仓实测 15 万字符）。往里面加内容要加在索引行里，
   别另起大段。
