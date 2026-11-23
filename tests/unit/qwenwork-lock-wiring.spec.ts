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
import { BALANCE_TIERED_PROVIDERS, isBalanceTieredProvider, PROVIDER_REGISTRY } from '../../src/provider-registry.js'
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

describe('★★★ 轮换起点接线（2026-11-23 真实缺陷：从未接线）', () => {
  /**
   * ## 症状
   *
   * 用户在面板给本家选了「轮换起点」，但完全不起作用 —— 永远从池里第一个号开始。
   *
   * ## 根因
   *
   * 本家的选号是在 index.ts 的 slots() 闭包里直接调 pickBuddyAccount，
   * 而「轮换起点」的四个参数是 credential-resolver.ts 的 buddy 分支读池后传的。
   * 照抄调用形态却漏了这四个字段 ⇒ 起点被静默忽略。
   *
   * ⚠️ 这不是「功能坏了」而是「从未接线」，所以**行为级用例抓不到**
   *（没有任何报错），必须用源码级锚点守。
   */
  it('★★★ slots() 必须接收 sessionId', () => {
    // ⚠️ 起点是按 (provider, sessionId) 存的；没有 sessionId 就无从查起。
    expect(
      indexCode,
      'slots 必须收 sessionId，否则 preferredRotationFor 拿不到起点',
    ).toMatch(/slots:\s*async\s*\(modelId\?:\s*string,\s*sessionId\?:\s*string\)/)
  })

  it('★★★ slots() 必须真的读 pool.preferredRotationFor', () => {
    expect(indexCode, '没读 preferredRotationFor ⇒ 起点完全不生效').toMatch(
      /pool\.preferredRotationFor\?\.\(QWENWORK_INTL\.id,\s*sessionId\)/,
    )
  })

  it('★★★ 四个字段必须同时传给 pickBuddyAccount', () => {
    // ⚠️ 缺任意一个都会静默失效，四种失效形态各不相同：
    //    rotationStartId   → 起点完全不生效
    //    rotationStartTier → 老数据静默走 S5（重选过起点却还先烧自己的）
    //    enabledAccountIds → 起点被限流/封禁时静默回落第一个号
    //    strictManualOrder → 打开严格模式仍按积分档位排
    //
    // ⚠️⚠️ **锚点必须是「传参形态」，不能是裸字段名**（变异验证实测）：
    // 裸 `/rotationStartTier\b/` 会被**注释里**的同名字样命中 ⇒
    // 删掉真正的那行传参、注释留着 ⇒ 守卫仍然绿（M3/M4 无牙）。
    expect(indexCode, 'rotationStartId 必须传').toMatch(
      /\.\.\.\(rotationStartId === undefined \? \{\} : \{ rotationStartId \}\)/,
    )
    expect(indexCode, 'rotationStartTier 必须传').toMatch(
      /\.\.\.\(rotationStartTier === undefined \? \{\} : \{ rotationStartTier \}\)/,
    )
    expect(indexCode, 'enabledAccountIds 必须传').toMatch(
      /\.\.\.\(enabledAccountIds === undefined \? \{\} : \{ enabledAccountIds \}\)/,
    )
    expect(indexCode, 'strictManualOrder 必须传').toMatch(
      /strictManualOrder: pool\.strictManualOrder\?\.\(QWENWORK_INTL\.id\) === true/,
    )
  })

  it('★★ 适配器 stream 必须把 sessionId 透传给 slots', () => {
    // ⚠️ 适配器侧漏传的话，接线层收到了 sessionId 也永远是 undefined。
    const adapterSource = readFileSync(
      resolve(here, '../../src/qwenwork-adapter.ts'),
      'utf8',
    )
    const adapterCode = codeOnly(adapterSource)
    expect(
      adapterCode,
      'stream 里必须 this.options.slots(options.model, options.sessionId)',
    ).toMatch(/this\.options\.slots\(options\.model,\s*options\.sessionId\)/)
  })

  it('★★ 目录路径（无 sessionId）时行为与改动前逐字节相同', () => {
    // ⚠️ 这是本功能唯一的回归面：没有会话上下文时不该查池、不该改选号。
    expect(indexCode).toMatch(
      /const rotationStartId = sessionId === undefined\s*\n\s*\? undefined/,
    )
  })
})

describe('★★★ 2026-11-23 审计：三处 P1 漏接线', () => {
  /**
   * ## 为什么这三条必须单独守
   *
   * 本家为了复用 `BuddyBalanceSelector` 而**绕过**了 `credential-resolver`
   * 的 `balance` 字段、自建 `slots()` 闭包。那个决定本身有注释，
   * 但注释只覆盖了「分档」—— 而 resolver 那套编排**顺带承担**了三条腿：
   *
   * | 腿 | 漏了会怎样 |
   * |---|---|
   * | 账号级封禁过滤 | 被上游封的号仍被选中，错误被误分类 |
   * | 全限流判定 | 全号被限流时报「请登录」（把「等几分钟」谎报成「没账号」）|
   * | `BALANCE_TIERED_PROVIDERS` | 前端「严格手动顺序」开关**整个不渲染** |
   *
   * 三条的共同特征：**tsc 全绿、既有测试全绿、只有用户能发现**。
   * 尤其第三条 —— 既有 `strict-manual-order-wiring.spec.ts` 只扫
   * `kind: 'buddy'` 装配块，而本家是自建闭包 ⇒ 双向差集看不到它。
   */
  it('★★★ 账号级封禁必须过滤（isPolicyBlockedAccount）', () => {
    // ⚠️ 封禁是**整号**不可用、与模型无关，必须与逐模型限流判据分开。
    //    漏了 ⇒ 被封的号仍被选中，每次请求撞上游拒绝且错误分类错。
    expect(
      indexCode,
      '候选筛选必须调 isPolicyBlockedAccount',
    ).toMatch(/isPolicyBlockedAccount\(entry\)/)
  })

  it('★★★ 全限流必须报解禁时刻，不能谎报「请登录」', () => {
    // ⚠️ 漏了 ⇒ 落 MISSING_CREDENTIAL，文案是「点『登录』」——
    //    而账号好得很，解禁时刻早写在 modelRateLimits 里。
    expect(
      indexCode,
      '候选为空且请求路径时必须调 throwIfAllAccountsRateLimited',
    ).toMatch(/throwIfAllAccountsRateLimited\(QWENWORK_INTL,\s*modelId\)/)
  })

  it('★★★ 必须在 BALANCE_TIERED_PROVIDERS 里（否则开关不渲染）', () => {
    // ⚠️ 后端一直读 pool.strictManualOrder(...)，只是前端不给这个开关。
    expect(
      BALANCE_TIERED_PROVIDERS.includes('qwenworkintl'),
      '不在表里 ⇒ 「严格手动顺序」开关静默消失',
    ).toBe(true)
    expect(isBalanceTieredProvider('qwenworkintl')).toBe(true)
  })
})

describe('★★ 2026-11-23 审计 P2/P3 收尾', () => {
  /**
   * ## 这四项都是「基准渠道有、本家没有」的差异
   *
   * | 项 | 后果 |
   * |---|---|
   * | `options.refresh` | 推理 401 时不续期，只能等定时器/回面板手点 |
   * | `claimUnavailableReason` | 点「一键领取」看到 `unsupported provider`（诊断串，不是用户文案）|
   * | `config.refresh` | 不参与 20 分钟后台目录刷新 |
   * | `listAllModels` 委托骨架 | `provider.status` 的 total 恒为静态表条数（上游加模型不跟）|
   */
  it('★★★ 适配器必须支持 options.refresh（推理 401 时续期）', () => {
    // ⚠️ 本家**有**真实 refresh 端点 ⇒ 「这个号救得回来」，
    //    不接就等于让用户看一条本可避免的 401。
    const adapterSource = readFileSync(
      resolve(here, '../../src/qwenwork-adapter.ts'),
      'utf8',
    )
    const adapterCode = codeOnly(adapterSource)
    expect(adapterCode, 'options 类型必须有 refresh').toMatch(/readonly refresh\?: \(\) => Promise<void>/)
    // ⚠️ 必须真的在 auth 分支里调（只声明不调用 = 死字段）。
    expect(adapterCode, 'auth 分支必须调用 this.options.refresh()').toMatch(
      /this\.options\.refresh !== undefined[\s\S]{0,200}?await this\.options\.refresh\(\)/,
    )
    // ⚠️ 每槽只试一次（refresh 是账号级副作用，反复调会重复轮换 refresh_token）。
    expect(adapterCode, '必须用 refreshed 集合去重').toMatch(/refreshed\.has\(slot\.id\)/)
  })

  it('★★ refresh 必须在 index.ts 装配（按账号池里的具体账号）', () => {
    // ⚠️ 必须走 `refreshAccountCredential(ref, pool, id)`，
    //    不能用单凭据的 `service.refresh()`（那会刷到已废弃的默认 ref 上）。
    //
    // ⚠️⚠️ **锚点必须是「本家的组合片段」，不能用裸符号**（变异验证实测无牙）：
    // - 裸 `/qwenworkintl\.refreshAccountCredential\(/` 在 `SELF_HEAL` 等别处也出现；
    // - 裸 `/refresh: async \(\) => \{/` 在**其他渠道**的装配里到处都是。
    // 两条同时被别处的巧合命中 ⇒ 删掉本家的装配，守卫仍然绿。
    // ⇒ 要求「`refresh:` 之后 400 字符内出现 `qwenworkintl.refreshAccountCredential(`」，
    //    且必须带上 `pool,` 与 `available.entry.id` 这两个参数锚点
    //    （证明走的是**账号级**续期而非单凭据 `service.refresh()`）。
    expect(indexCode).toMatch(
      /refresh: async \(\) => \{[\s\S]{0,400}?qwenworkintl\.refreshAccountCredential\([\s\S]{0,200}?available\.entry\.credentialRef,\s*pool,\s*available\.entry\.id/,
    )
  })

  it('★★★ claimUnavailableReason 必须写（否则用户看到 unsupported provider）', async () => {
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    // ⚠️ 表由 `createProviderCredits()` 现造（与运行时同一份工厂）。
    const table = createProviderCredits()
    const entry = table['qwenworkintl']
    expect(entry, 'provider-credits 里必须有 qwenworkintl').toBeDefined()
    expect(
      entry?.claimUnavailableReason,
      '缺它 ⇒ 点「一键领取」看到 unsupported provider 报文',
    ).toBeTypeOf('string')
    // ⚠️ 文案必须说清「服务端自动发放」，不能只说「不支持」。
    expect(entry?.claimUnavailableReason).toMatch(/自动发放|无需手动/)
  })

  it('★★ config.refresh 必须给（否则不进后台目录刷新器）', () => {
    const adapterSource = readFileSync(
      resolve(here, '../../src/qwenwork-adapter.ts'),
      'utf8',
    )
    const adapterCode = codeOnly(adapterSource)
    // ⚠️ 骨架用 `...config.refresh === undefined ? {} : {...}` 决定要不要产出 refresh 成员
    //    ⇒ 不给这一项就整个不在刷新器里。
    expect(adapterCode, 'createModelCatalog 的 config 必须给 refresh').toMatch(
      /refresh: async \(\) => \{[\s\S]{0,200}?this\.remoteCatalog = undefined/,
    )
  })

  it('★★★ listAllModels 必须委托骨架（否则 total 恒为静态表条数）', () => {
    // ⚠️ 原实现恒读 `fallbackEntries()` ⇒ 上游加模型后 provider.status 不跟。
    const adapterSource = readFileSync(
      resolve(here, '../../src/qwenwork-adapter.ts'),
      'utf8',
    )
    const adapterCode = codeOnly(adapterSource)
    expect(adapterCode, 'listAllModels 必须读 skeletonCatalog').toMatch(
      /this\.skeletonCatalog\.listAllModels\(\)/,
    )
    // ⚠️ 反向：不得再直接读兜底表（那是缺陷形态）。
    const body = /listAllModels\(\)[\s\S]{0,900}?\n  \}/.exec(adapterCode)?.[0] ?? ''
    expect(body, 'listAllModels 里不得再出现 fallbackEntries()').not.toMatch(/fallbackEntries\(\)/)
  })
})
