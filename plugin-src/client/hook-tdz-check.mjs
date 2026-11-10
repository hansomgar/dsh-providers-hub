/**
 * hook 依赖数组的 **TDZ 风险**检查（安装期闸门 + 单测共用的唯一实现）。
 *
 * ## 事故（2026-11-10，真机首启复现）
 *
 * 面板报「用量徽标渲染失败：Cannot access `loadPreferredAccount`
 * before initialization」，整枚徽标被错误边界接住。
 *
 * ## 根因：`useEffect` 的依赖数组**立即求值**
 *
 * ```js
 * // ❌ 抛 TDZ：依赖数组在每次渲染时立即求值，此刻 const 还没初始化
 * React.useEffect(() => { void loadPreferredAccount(); }, [loadPreferredAccount]);
 * const loadPreferredAccount = React.useCallback(async () => { … }, []);
 * ```
 *
 * ```js
 * // ✅ 声明在前
 * const loadPreferredAccount = React.useCallback(async () => { … }, []);
 * React.useEffect(() => { void loadPreferredAccount(); }, [loadPreferredAccount]);
 * ```
 *
 * 这与「回调体里的引用」是**两件事**：体内引用在**调用时**才求值（那时通常已过
 * TDZ），而**依赖数组在渲染期同步求值**。故本检查**只看依赖数组**。
 *
 * ## ⚠️ 为什么必须是「能进安装期闸门」的判据
 *
 * `pnpm add git+…` 走的是 `prepare → build:all`，**不跑 vitest** ——
 * 只有能在 `build.mjs` 里跑的断言才会在安装路径上生效。而 TDZ 是**求值顺序**
 * 问题：定义与引用**都在**源码里，源码文本断言挡不住（本仓已有
 * 「`if (false)` 短路 / 三元字面量 / `['length']` 三种旁路骗过文本断言」的事故史）。
 *
 * ## 局限（如实登记）
 *
 * - 只认 `const` / `let` 声明与 `React.use*` hook（本仓客户端即此形态）；
 * - **按缩进近似作用域**：内层同名局部变量会因缩进不同而被跳过（这是刻意的 ——
 *   第一版没做作用域判断，把 `jet-hub.js` 里一个函数内局部 `const snapshot`
 *   误报成 `useMemo([snapshot, selected])` 的声明处）；
 * - 跨文件（`import`）不查：`import` 是提升的，不构成 TDZ。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 找 `const|let NAME =` 的声明位置（同一名字可能多处声明，全部记下）。 */
function declarationsOf(text) {
  const map = new Map()
  const re = /^[ \t]*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm
  for (const m of text.matchAll(re)) {
    const name = m[1]
    if (!map.has(name)) map.set(name, [])
    // ⚠️⚠️ **必须用 `m.index + m[0].indexOf(name)`，不能用 `m.index`**
    // （真实缺陷，2026-11-10 本脚本首版即错）：`m.index` 指向**行首的空白**，
    // 而 `indentOf()` 取「行首到该下标之间的空白长度」⇒ 恒得 0 ⇒
    // 与 hook 的真实缩进（如 2）永不相等 ⇒ 同作用域判定全空 ⇒
    // **闸门静默失效**（一条都报不出来，而 `scanned` 看起来一切正常）。
    const nameOffset = m[0].indexOf(name)
    map.get(name).push(m.index + (nameOffset < 0 ? 0 : nameOffset))
  }
  return map
}

/** 某个下标所在行的缩进宽度（用于近似判断「同一作用域」）。 */
function indentOf(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const m = /^[ \t]*/.exec(text.slice(lineStart, index))
  return m === null ? 0 : m[0].length
}

/** 找出所有 `React.use*(` 调用，并解析其**最后一个 `[...]`** 作为依赖数组。 */
function hooksOf(text) {
  const out = []
  const re = /React\.(useEffect|useLayoutEffect|useCallback|useMemo)\s*\(/g
  for (const m of text.matchAll(re)) {
    const openIdx = m.index + m[0].length - 1
    // 括号配对取完整实参
    let depth = 0
    let end = -1
    for (let i = openIdx; i < text.length; i += 1) {
      const ch = text[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) continue
    const args = text.slice(openIdx + 1, end).trim()
    const depsMatch = /\[\s*([^[\]]*)\]\s*,?\s*$/.exec(args)
    const deps = depsMatch === null
      ? []
      : depsMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s))
    out.push({ hook: m[1], at: m.index, deps })
  }
  return out
}

/**
 * 扫描一个目录下的 `*.js`，返回问题清单。
 *
 * @param {{ rootDir: string, relativeDir?: string }} options
 *   `rootDir` = 仓库根；`relativeDir` 默认 `plugin-src/client`。
 * @returns {{ scanned: number, problems: Array<{ file: string, hook: string,
 *   dep: string, hookLine: number, declLine: number }> }}
 */
export function checkHookTdz(options) {
  const rootDir = options?.rootDir
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new Error('checkHookTdz: rootDir 必填')
  }
  const dir = join(rootDir, options.relativeDir ?? 'plugin-src/client')
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  const problems = []
  let scanned = 0

  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8')
    const decls = declarationsOf(text)
    for (const h of hooksOf(text)) {
      scanned += 1
      const hookIndent = indentOf(text, h.at)
      for (const dep of h.deps) {
        const positions = decls.get(dep)
        // import 的、或别人声明的 ⇒ 不构成 TDZ。
        if (positions === undefined) continue
        // ⚠️ 只认同缩进（近似同作用域）：内层同名局部变量不是同一个绑定。
        const sameScope = positions.filter((p) => indentOf(text, p) === hookIndent)
        if (sameScope.length === 0) continue
        const first = sameScope[0]
        if (first > h.at) {
          problems.push({
            file,
            hook: h.hook,
            dep,
            hookLine: text.slice(0, h.at).split('\n').length,
            declLine: text.slice(0, first).split('\n').length,
          })
        }
      }
    }
  }

  return { scanned, problems }
}
