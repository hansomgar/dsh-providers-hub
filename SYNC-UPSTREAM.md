# 同步上游并保留本地改动（feat/default-max-reasoning）

本仓库现在有**两条长期并存的线**：

| 分支 | 用途 | 与上游关系 |
|---|---|---|
| `master` | 只镜像上游 | **必须**与 `iJetLi/dsh-providers-hub` 的 master 逐字节一致，不提交任何本地改动 |
| `feat/default-max-reasoning` | 本地改动（默认思考档 = 最强档） | 基于某个上游 commit，在上游发版后**变基**到新版本 |

DSH 的 `package.json` 里 specifier 指向**你的 fork + feature 分支的 commit**：

```
github:hansomgar/dsh-providers-hub#<feature 分支的 commit>
```

---

## 一、上游更新后的标准同步流程（四步）

在仓库根目录执行（`E:\DATA\data_dsh\2026\dsh-agent-proxy\dsh-providers-hub`）：

### 第 1 步：更新 master（只镜像上游）

```powershell
git checkout master
git fetch origin
git merge --ff-only origin/master      # ⚠️ 必须能快进；失败说明 master 被污染了
git push fork master:master            # 让 fork 的 master 也跟上
```

### 第 2 步：把 feature 分支**变基**到新 master

```powershell
git checkout feat/default-max-reasoning
git rebase master
```

变基可能冲突。本改动的冲突通常出现在：

| 文件 | 冲突原因 | 处理办法 |
|---|---|---|
| `src/reasoning-ladder.ts` | 上游也改了这张表 / 加了函数 | **保留上游的 `REASONING_EFFORT_RANK` 与既有函数**，只把本改动的两个新函数（`strongestReasoningEffort` / `defaultReasoningEffortOf`）追加进去 |
| 各 `*-adapter.ts` 的 `reasoningFor` / `toCatalogEntry` | 上游改了同名函数 | 保留上游结构，把 `defaultEffort` 那一行换成 `defaultReasoningEffortOf(...)` 调用 |
| `tests/unit/*.spec.ts` | 断言值 `high` vs `max` | 按**新的上游默认值**重新判断该断言该改成什么；本改动只保证「默认档 = 集合内最强档」 |

冲突解决后：

```powershell
git add -A
git rebase --continue
```

**若变基乱了想重来**：

```powershell
git rebase --abort
```

### 第 3 步：验证（必须全绿才继续）

```powershell
pnpm install
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npx vitest run
pnpm run build:all
```

⚠️ 全量单测里 `autoclawintl-zai-wiring.spec.ts` 有一条会**真发本机 HTTP**，
在沙箱/无网络环境下会报 `UND_ERR_SOCKET` —— 那是环境问题，与本改动无关。

### 第 4 步：推送并更新 DSH 的 specifier

```powershell
git push fork feat/default-max-reasoning --force-with-lease   # 变基后必须 force
git rev-parse HEAD                                            # 拿到新 commit
```

然后把 `~/.dsh/profiles/desktop/package.json` 里的 specifier 换成新 commit，
并在 `pnpm-workspace.yaml` 的 `allowBuilds` 里加对应的 codeload 行：

```yaml
allowBuilds:
  "dsh-providers-hub@https://codeload.github.com/hansomgar/dsh-providers-hub/tar.gz/<新commit>": true
```

然后：

```powershell
cd ~/.dsh/profiles/desktop
pnpm install --no-frozen-lockfile
```

---

## 二、⚠️ 写配置文件必须防 BOM

本机 pnpm / Node 解析 `package.json` 时**对 BOM 敏感**（曾因此启动失败一次）。

**绝对不要**用：

```powershell
# ❌ PowerShell 5.x 的 -Encoding UTF8 会写入 BOM
$text | Set-Content -Path $path -Encoding UTF8
```

**必须**用：

```powershell
# ✅ 显式指定无 BOM 的 UTF8Encoding
[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
```

写完**立刻回读首 3 字节自检**：

```powershell
$b = [System.IO.File]::ReadAllBytes($path)
if ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
  Write-Host "❌ 有 BOM，必须修复" -ForegroundColor Red
} else {
  Write-Host "✓ 无 BOM" -ForegroundColor Green
}
```

⚠️ 同理，`git commit -F <file>` 的 message 文件也不能带 BOM
（会变成提交信息首字符的一个不可见 `U+FEFF`）—— 用上面同一个 `WriteAllText` 写法。

---

## 三、本改动到底改了什么（便于冲突时判断）

**核心判据**在 `src/reasoning-ladder.ts`（强度序的**唯一权威**）：

- `strongestReasoningEffort(declared)` — 取声明里 rank 最大的一档。
  ①未登记的私有 id 不参与；②`off`/`none` 永不当选（除非它是唯一选项）；
  ③同 rank 取声明顺序里的后者。
- `defaultReasoningEffortOf(remote, declared)` — 远端值在集合内就用它，
  否则回落到 `strongestReasoningEffort`，**保证落在 declared 内**。

**接入点**（10 处）：accio / astudio / buddy / lobsterai / loomy / modelscope /
qiniu / qoder / zcode + cline 与 autoclaw 的常量。

**刻意保留的例外**（不要"顺手统一"）：

| provider | 保留值 | 理由 |
|---|---|---|
| `autoclaw` | `high` | 用户 2026-10-17 拍板：`max` 实测单次 170~192 秒，日常对话等不起；2026-11-10 复查后确认保留 |
| `minimax` M3 | 不声明 | 上游无 `default_effort`，实测服务端默认 = 不思考；代码明文写「不要擅自设成 `on`」 |
| `opencode` | 不声明 | models.dev 无 `is_default` 字段，不编造 |
| `raccoon` / `codearts` / `magicrew` | 原值已是集合最强 | 只有两档（`on`/`high`），无需改 |

---

## 四、常用检查命令

```powershell
# 当前 specifier
(Get-Content ~/.dsh/profiles/desktop/package.json -Raw | ConvertFrom-Json).dependencies.'dsh-providers-hub'

# 已安装产物是否含新函数
Select-String -Path ~/.dsh/profiles/desktop/node_modules/dsh-providers-hub/lib/reasoning-ladder.js -Pattern 'strongestReasoningEffort'

# feature 分支与上游的差距
git log --oneline master..feat/default-max-reasoning
```
