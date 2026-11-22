/**
 * 千问办公国际站「锁定长期积分」的**接线守卫**。
 *
 * ## 为什么必须有这个文件
 *
 * `provider-registry.ts` 的 `permanentLock: true` **只**让面板渲染开关、让
 * `credits.permanentLock` RPC 接受写入 —— **它不执行任何拦截**。
 * 用户点了锁定、凭据照旧烧长期积分，且**没有任何用例会红**。
 *
 * 这是本仓记录过的缺陷（Gitee IKLTHB ①，officeace 的原始问题）。
 * `permanent-lock-execution.spec.ts` 会点名「声明了却没有任何执行路径」，
 * 而那个普查表要求每个 provider 指向一个**真实存在且内含有判别符号**的 spec
 * —— 本文件就是它。
 *
 * ## 判据分三层（缺一层就会「红得没意义」）
 *
 * 1. **registry 契约**：`permanentLock` / `usesExpiryWindow` / `creditPackages` 都在；
 * 2. **接线**：`index.ts` 里真的建了 selector、真的传了 `resolveCredential`、
 *    真的读了 `pool.permanentLocked`（**源码级切片**，因为选号发生在闭包里，
 *    单测无法直接驱动）；
 * 3. **行为**：`qwenworkLockedError` 按 `reason.kind` **四态分流** ——
 *    混成一句会让「网络抖动」被当成「钱花完了」，用户于是去解锁、白烧长期积分。
 *
 * ⚠️ 第 2 层用**带上下文的锚点**而不是裸符号：`drives` 里只写 `qwenworkLockedError`
 * 对 `src/index.ts` 无牙（符号定义还在文件里，删掉使用点照样 `includes` 为真）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import { QwenworkIntlAuth } from '../../src/qwenwork-auth.js'
import { qwenworkLockedError } from '../../src/qwenwork-lock.js'
import { QWENWORK_INTL } from '../../src/qwenwork-product.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8')

/** 去掉注释，避免注释里的字样被当成「已接线」。 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const indexCode = codeOnly(indexSource)

describe('★ QwenWork：registry 的锁定契约', () => {
  it('登记了 permanentLock / usesExpiryWindow / creditPackages', () => {
    const d = PROVIDER_REGISTRY.find((p) => p.id === 'qwenworkintl')
    expect(d, 'registry 里找不到 qwenworkintl').toBeDefined()
    expect(d?.permanentLock, '缺它会渲染不出锁定开关').toBe(true)
    expect(d?.usesExpiryWindow, '缺它分档文案拿不到窗口天数').toBe(true)
    expect(d?.creditPackages, '缺它没有逐包明细').toBe(true)
  })

  it('后端白名单由 registry 派生且含本家', () => {
    // ⚠️ 断言的是**派生关系**而不是手抄的名单 —— 手抄名单必然腐坏。
    const derived = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id)
    expect(derived).toContain('qwenworkintl')
  })
})

describe('★★ QwenWork：`index.ts` 的执行路径（源码级切片）', () => {
  it('★★ 建了余额分档选号器（`BuddyBalanceSelector` + 本家泛型）', () => {
    expect(
      indexCode,
      '缺少「本家专属」的选号器 ⇒ 锁定没有执行路径（只是个空开关）',
    ).toMatch(
      /const qwenworkintlBalanceSelector =\s*new BuddyBalanceSelector<\s*QwenworkProduct\s*,\s*QwenworkCredential\s*>/,
    )
  })

  it('★★ 选号器注入了 `resolveCredential`（否则选出的号拿不到凭据）', () => {
    expect(indexCode).toMatch(
      /qwenworkintlBalanceSelector[\s\S]{0,600}?resolveCredential:\s*\(refName\)\s*=>\s*qwenworkintl\.currentCredential\(refName\)/,
    )
  })

  it('★★ 选号器注入了 `readCreditWindow`（窗口必须与面板文案同源）', () => {
    expect(indexCode).toMatch(
      /qwenworkintlBalanceSelector[\s\S]{0,400}?readCreditWindow:\s*safeCreditWindowReader\(pool\)/,
    )
  })

  it('★★★ 真的读了 `pool.permanentLocked` 并传给 `allowPermanent`', () => {
    // ⚠️ 这一行是**整个锁定功能的开关点**：删了它，`permanentLock: true`
    //    就退化成纯 UI 装饰，而面板仍会逐字承诺「这类积分用尽后将没有可用账号」。
    expect(
      indexCode,
      '没有读 permanentLocked ⇒ 锁定不生效（officeace 的原始缺陷形态）',
    ).toMatch(/allowPermanent:\s*!pool\.permanentLocked\(QWENWORK_INTL\.id\)/)
  })

  it('★★ 用的是共享的 `pickBuddyAccount`（不另写一套编排）', () => {
    // ⚠️ 另写一套会让「锁定/未锁定的收尾差异」出现第二份实现（本仓红线）。
    expect(indexCode).toMatch(/pickBuddyAccount<\s*QwenworkCredential\s*>/)
  })

  it('★★ 请求路径取号失败时**抛错**，绝不回落「列出全部」', () => {
    // 回落会绕过锁定、照样烧长期积分 —— `buddy-balance-selector.ts` 的
    // `pickBuddyAccount` 注释逐字记录了这条。
    expect(indexCode).toMatch(/throw qwenworkLockedError\(/)
  })

  it('目录路径（modelId 缺省）降级放行，不清空模型列表', () => {
    expect(indexCode).toMatch(/degradeOnUnknown:\s*modelId === undefined/)
  })
})

describe('★★ QwenWork：锁定报错必须按 `reason.kind` 四态分流', () => {
  const err = qwenworkLockedError('QwenWork (国际版)', 'qwenworkintl', 15)

  it('`exhausted` ⇒ QUOTA_EXCEEDED，且文案说清「长期留着、只烧 N 天内」', () => {
    const e = err({ kind: 'exhausted' })
    expect(e.message).toContain('长期积分留着不动')
    expect(e.message).toContain('15 天内到期')
    // ⚠️ 必须告诉用户「解锁后可用」，否则他以为号废了。
    expect(e.message).toContain('解锁')
  })

  it('★ `unknown` ⇒ 提示「可能仍有额度、稍后重试」，不得说成「用尽」', () => {
    const e = err({ kind: 'unknown', errors: ['HTTP 503'] })
    expect(e.message).toContain('无法确认')
    expect(e.message).toContain('HTTP 503')
    // ⚠️ 反向：绝不能把网络抖动说成「钱花完了」（那会推用户去解锁、白烧长期积分）。
    expect(e.message).not.toContain('都已用尽')
  })

  it('★ `no-candidates` ⇒ 提示限流/停用，且明说「与积分无关」', () => {
    const e = err({ kind: 'no-candidates' })
    expect(e.message).toContain('没有可用账号')
    expect(e.message).toContain('与积分无关')
    expect(e.message).not.toContain('都已用尽')
  })

  it('★★ `credential-only` ⇒ 提示重新登录，**不得**说成积分用尽', () => {
    // ⚠️ 这一档最隐蔽：分档刚证明该号有钱，矛盾在凭据上。
    //    报「积分用尽」会把用户推向解锁（不可撤回地烧钱）。
    const e = err({ kind: 'credential-only' })
    expect(e.message).toContain('凭据')
    expect(e.message).toContain('重新登录')
    expect(e.message).not.toContain('都已用尽')
  })

  it('窗口天数来自调用方（与选号同源，不写死）', () => {
    const e31 = qwenworkLockedError('X', 'qwenworkintl', 31)({ kind: 'exhausted' })
    expect(e31.message).toContain('31 天内到期')
    expect(e31.message).not.toContain('15 天内到期')
  })
})

describe('★ QwenWork：auth 暴露了选号所需的读取口', () => {
  it('`currentCredential` 是公开方法（与 private readCredential 共用实现）', () => {
    expect(typeof QwenworkIntlAuth.prototype.currentCredential).toBe('function')
  })

  it('产品 id / 展示名与 registry 一致', () => {
    const d = PROVIDER_REGISTRY.find((p) => p.id === QWENWORK_INTL.id)
    expect(d?.displayName).toBe(QWENWORK_INTL.displayName)
  })
})
