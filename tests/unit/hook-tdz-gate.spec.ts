/**
 * hook TDZ 闸门的守卫（真实缺陷，2026-11-10 真机首启）。
 *
 * ## 事故
 *
 * 面板报「用量徽标渲染失败：Cannot access `loadPreferredAccount`
 * before initialization」。根因：`useEffect` 的**依赖数组在渲染期立即求值**，
 * 而 `const loadPreferredAccount = useCallback(...)` 在求值到那一行之前处于 TDZ。
 *
 * ## 本文件守两件事
 *
 * 1. **真实源码无 TDZ 风险** —— 直接扫 `plugin-src/client/*.js`；
 * 2. **闸门本身有牙** —— 用一段**合成的**问题代码喂给同一个
 *    `checkHookTdz`，确认它真的报得出来。
 *
 * ⚠️ 第 2 条不可省：本仓教训「新写的守卫自己可能是假绿」。若只测第 1 条，
 * 把 `checkHookTdz` 改成 `return { problems: [] }` 全套仍绿 ——
 * 那条用例恒真。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkHookTdz } from '../../plugin-src/client/hook-tdz-check.mjs'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

describe('hook 依赖的 TDZ 闸门', () => {
  it('★ 真实源码无 TDZ 风险（真机事故的防复发守卫）', () => {
    const report = checkHookTdz({ rootDir: REPO_ROOT })
    expect(report.scanned).toBeGreaterThan(50) // 扫到的 hook 数量：防「一个文件都没读到」的假绿
    expect(report.problems).toEqual([])
  })

  /**
   * ⚠️ **合成样例必须真跑同一个 checkHookTdz**（不是另写一份判断）：
   * 这样才能证明「闸门」而非「我手写的期望」。
   */
  describe('闸门有牙（合成样例）', () => {
    const dirs = []
    const makeRepo = (files) => {
      const root = mkdtempSync(join(tmpdir(), 'tdz-'))
      dirs.push(root)
      mkdirSync(join(root, 'plugin-src', 'client'), { recursive: true })
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(root, 'plugin-src', 'client', name), text, 'utf8')
      }
      return root
    }
    afterAll(() => {
      for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ } }
    })

    it('★ 依赖数组引用在 const 声明之前 ⇒ **报出来**', () => {
      const root = makeRepo({
        'bad.js': [
          'function C() {',
          '  React.useEffect(() => { void late(); }, [late]);',
          '  const late = React.useCallback(async () => {}, []);',
          '  return null;',
          '}',
        ].join('\n'),
      })
      const r = checkHookTdz({ rootDir: root })
      expect(r.problems).toHaveLength(1)
      expect(r.problems[0]).toMatchObject({ file: 'bad.js', hook: 'useEffect', dep: 'late' })
    })

    it('★ 声明在引用之前 ⇒ 不报（反向对照，防假红）', () => {
      const root = makeRepo({
        'ok.js': [
          'function C() {',
          '  const early = React.useCallback(async () => {}, []);',
          '  React.useEffect(() => { void early(); }, [early]);',
          '  return null;',
          '}',
        ].join('\n'),
      })
      expect(checkHookTdz({ rootDir: root }).problems).toEqual([])
    })

    it('★ 依赖来自 import ⇒ 不报（import 是提升的，不构成 TDZ）', () => {
      const root = makeRepo({
        'imp.js': [
          "import { helper } from './x.js';",
          'function C() {',
          '  React.useEffect(() => { void helper(); }, [helper]);',
          '  return null;',
          '}',
        ].join('\n'),
      })
      expect(checkHookTdz({ rootDir: root }).problems).toEqual([])
    })

    it('★ 内层同名局部变量（缩进不同）⇒ 不报（挡 jet-hub.js 那类假红）', () => {
      const root = makeRepo({
        'shadow.js': [
          'function C() {',
          '  const snap = React.useMemo(() => 1, [snapshot]);',
          '  function inner() {',
          '    const snapshot = 2;',
          '    return snapshot;',
          '  }',
          '  return inner();',
          '}',
        ].join('\n'),
      })
      expect(checkHookTdz({ rootDir: root }).problems).toEqual([])
    })
  })
})
