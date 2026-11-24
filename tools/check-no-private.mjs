#!/usr/bin/env node
/**
 * **提 PR 前的自检闸门**：确认当前分支的改动**不含任何 qwenwork 私有内容**。
 *
 * ## 为什么需要
 *
 * 本仓库有两条并行的开发线：
 * - **`upstream-work`**（及其派生的 feature 分支）→ 只放可提 PR 的通用修复；
 * - **`feat/qwenwork-intl-provider`** → qwenworkintl provider（私有，绝不提 PR）。
 *
 * 两者混在一起时，一次不小心的 `git merge` / `cherry-pick` 就会把
 * qwenwork 的接线（registry 条目、index 注册、RPC auth 键…）带进 PR。
 * 那不是「代码错误」，而是**把私有内容公开发布** —— 后果比 bug 严重。
 *
 * ⇒ 本脚本是**结构性的闸门**（不靠人记得），判据三条：
 *
 * 1. diff 涉及的文件路径含 `qwenwork`
 * 2. diff **内容**含 `qwenwork` 字样（含大小写变体）
 * 3. `src/provider-registry.ts` 里出现 `qwenworkintl` 注册项
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-no-private.mjs            # 检查 origin/master...HEAD（默认）
 * node scripts/check-no-private.mjs --staged   # 只查暂存区（提交前用）
 * node scripts/check-no-private.mjs --worktree # 查工作区未暂存改动
 * ```
 *
 * 退出码：0 = 干净（可 push），1 = 命中私有内容（**阻止 PR**）。
 *
 * ## ⚠️ 在私有分支上跑它会「失败」—— 那是**预期行为**
 *
 * 它不该在 `feat/qwenwork-intl-provider` 上跑。若确实要跑（比如确认判据本身），
 * 用 `--allow-private` 忽略退出码、只看报告。
 *
 * @module scripts/check-no-private
 */

import { execSync } from 'node:child_process'

/** 私有标记：全部大小写变体都算命中（`QwenWork` / `QWENWORK` / `qwenwork`）。 */
const PRIVATE_PATTERN = /qwenwork/i

/** registry 里那个必须不出现的注册项。 */
const REGISTRY_MARKER = 'qwenworkintl'

const args = new Set(process.argv.slice(2))
const mode = args.has('--staged')
  ? 'staged'
  : args.has('--worktree')
    ? 'worktree'
    : 'range'

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const hits = []
const record = (kind, detail) => hits.push({ kind, detail })

// ── ① 该比较哪一段 ──
let diffArgs
if (mode === 'staged') {
  diffArgs = ['--cached']
} else if (mode === 'worktree') {
  diffArgs = []
} else {
  // 默认：与上游合流点比（PR 实际提交的内容就是这一段）
  diffArgs = ['origin/master...HEAD']
}

// ── ② 文件路径判据 ──
const nameArgs = mode === 'staged'
  ? ['diff', '--name-only', '--cached']
  : mode === 'worktree'
    ? ['diff', '--name-only']
    : ['diff', '--name-only', 'origin/master...HEAD']

let changedFiles = []
try {
  changedFiles = sh(`git ${nameArgs.join(' ')}`).split('\n').map((l) => l.trim()).filter(Boolean)
} catch (error) {
  console.error(`❌ 无法读取改动清单：${String(error).slice(0, 200)}`)
  process.exit(1)
}

for (const file of changedFiles) {
  if (PRIVATE_PATTERN.test(file)) record('路径', file)
}

// ── ③ 内容判据 ──
let diffText = ''
try {
  diffText = sh(`git diff ${diffArgs.join(' ')}`)
} catch (error) {
  console.error(`❌ 无法读取 diff：${String(error).slice(0, 200)}`)
  process.exit(1)
}

/** 只扫**新增行**（`+` 开头且不是 `+++`）：删掉私有内容是**好事**，不该拦。 */
const addedLines = diffText
  .split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .map((line) => line.slice(1))

for (const line of addedLines) {
  if (PRIVATE_PATTERN.test(line)) {
    record('内容', line.trim().slice(0, 120))
  }
}

// ── ④ registry 注册项判据（差分可能因 merge 而看不出，直接查文件） ──
try {
  const registry = sh('git show HEAD:src/provider-registry.ts')
  if (registry.includes(REGISTRY_MARKER)) {
    record('registry', `src/provider-registry.ts 含 ${REGISTRY_MARKER} 注册项`)
  }
} catch {
  // 文件不存在（极早期分支）⇒ 不判这一格
}

// ── 报告 ──
const scope = mode === 'staged'
  ? '暂存区'
  : mode === 'worktree'
    ? '工作区（未暂存）'
    : 'origin/master...HEAD'

console.log(`检查范围：${scope}`)
console.log(`改动文件：${changedFiles.length} 个`)

if (hits.length === 0) {
  console.log('\n✅ 干净：没有 qwenwork 私有内容，可以提 PR。')
  process.exit(0)
}

console.log(`\n🚫 命中 ${hits.length} 处私有内容 —— **不得提 PR**：\n`)
for (const hit of hits.slice(0, 40)) {
  console.log(`  [${hit.kind}] ${hit.detail}`)
}
if (hits.length > 40) console.log(`  …还有 ${hits.length - 40} 处`)

console.log('\n处理建议：')
console.log('  1. 若这是「通用修复」分支：把该修复**从纯上游重做一遍**（通常 5~20 行），')
console.log('     不要 cherry-pick 私有分支的提交（它们必然带 registry/index 接线）。')
console.log('  2. 若这是私有分支：本检查本就不该在这里跑 —— 切回 feat/qwenwork-intl-provider。')

process.exit(args.has('--allow-private') ? 0 : 1)