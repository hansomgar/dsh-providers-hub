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
    ).toMatch(/const slotsFor = async \(modelId\?: string, sessionId\?: string\)/)
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
    expect(adapterCode, 'options 类型必须有 refresh 且接收 slotId').toMatch(/readonly refresh\?: \(slotId: string\) => Promise<void>/)
    // ⚠️ 必须真的在 auth 分支里调（只声明不调用 = 死字段）。
    expect(adapterCode, 'auth 分支必须调用 this.options.refresh(slot.id)').toMatch(
      // ⚠️ 必须**传 slot.id**（B-2）：不传时接线层只能取池里第一个号，会续错账号。
      /this\.options\.refresh !== undefined[\s\S]{0,300}?await this\.options\.refresh\(slot\.id\)/,
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
      /refresh: async \(slotId: string\) => \{[\s\S]{0,400}?pool\.findAccount\(slotId\)[\s\S]{0,300}?qwenworkintl\.refreshAccountCredential\(entry\.credentialRef, pool, entry\.id\)/,
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
    /**
     * ⚠️⚠️ **光给 `config.refresh` 不够**（2026-11-23 终审实测抓到的真漏）：
     *
     * 骨架会产出 `refresh()` 成员，**但适配器必须把它转发出去** ——
     * 否则后台刷新器 `refreshOf(adapter)` 拿到 `undefined` ⇒
     * 「已武装却对这家**空转**，且零日志」（对比 `trae-adapter.ts:1098`）。
     *
     * 我第一版只加了 `config.refresh`、没加转发 ⇒ 运行时 `typeof ad.refresh`
     * 是 `undefined` —— **原来这条守卫是源码文本级的，抓不到它**。
     * ⇒ 判据必须同时钉住两半。
     */
    expect(adapterCode, '适配器必须转发 skeletonCatalog.refresh').toMatch(
      /async refresh\(\): Promise<void> \{[\s\S]{0,120}?await this\.skeletonCatalog\.refresh\?\.\(\)/,
    )
  })

  /**
   * ★★★ **行为级**：`refresh()` 成员必须真的存在（不是源码里有那段字）。
   *
   * ⚠️ 这条是为了堵上一条的漏洞：上一条是源码文本级判据，
   * 而「文本在、运行时没有」正是我第一版踩的坑。
   */
  it('★★★ 运行时 adapter.refresh 必须是函数', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    const ad = new QwenworkAdapter({
      slots: async () => [{ id: 'x', accessToken: 'dummy' }],
      mintTicket: async () => ({
        token: 't',
        baseUrl: 'https://api1.qwenwork.ai',
        expiresAtMs: Date.now() + 3_600_000,
      }),
    })
    expect(
      typeof (ad as { refresh?: unknown }).refresh,
      '没有 refresh 成员 ⇒ 20 分钟后台目录刷新器对本家静默跳过',
    ).toBe('function')
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

describe('★★★ 2026-11-23 终审：两条真缺陷的行为级守卫', () => {
  /**
   * ## B-1 续期后必须**真的重发**请求
   *
   * 子代理审计打穿的形态（实测复现）：
   *
   * ```
   * 修复前: HTTP 1 次 | refresh 1 次 | QUOTA_EXCEEDED「所有账号均受限」
   * 修复后: HTTP 2 次 | refresh 1 次 | AUTH「HTTP 401」
   * ```
   *
   * 根因：`tried.add(slot.id)` 在进循环第一件事就执行，而全仓**没有任何
   * `tried.delete`** ⇒ `continue` 之后 `slots.find(s => !tried.has(s.id))`
   * 找不到该槽 ⇒ 续好的凭据**一次都没被用上**。
   *
   * ⚠️ 而旧的守卫全是**源码文本级**（断言「声明了 refresh」「调了 refresh」
   * 「有 refreshed 去重」），三条在缺陷存在时**全部为真** ⇒ 完全无牙。
   */
  it('★★★ B-1 续期后必须真的重发请求（HTTP 被调 ≥2 次）', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    let httpCalls = 0
    let refreshCalls = 0
    const ad = new QwenworkAdapter({
      slots: async () => [{ id: 'acc-1', accessToken: 'old-token' }],
      mintTicket: async () => ({
        token: 'maas',
        baseUrl: 'https://api1.example.fake',
        expiresAtMs: Date.now() + 3_600_000,
      }),
      refresh: async () => { refreshCalls++ },
    })
    const origFetch = globalThis.fetch
    // 让上游恒回 401 ⇒ 走 auth 分支 ⇒ 触发续期
    globalThis.fetch = (async () => {
      httpCalls++
      return new Response(
        JSON.stringify({ error: { code: 'unauthorized', message: 'invalid token' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    let code: string | undefined
    try {
      for await (const _chunk of ad.stream({
        model: 'flash',
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* 消费 */ }
    } catch (e) {
      code = (e as { code?: string }).code
    } finally {
      globalThis.fetch = origFetch
    }
    expect(refreshCalls, '续期应被调用一次').toBe(1)
    expect(
      httpCalls,
      '续期后必须真的重发请求（=1 说明 refresh 白调、tried 从未撤销）',
    ).toBeGreaterThanOrEqual(2)
    // ⚠️ 401 不得被谎报成「额度用尽」——那会推用户去解锁长期积分（不可撤回）。
    expect(code, '401 不能被归成 QUOTA_EXCEEDED').not.toBe('QUOTA_EXCEEDED')
  })

  /**
   * ## B-3 远端 ≠ 静态表时，三出口必须一致
   *
   * 原实现 `resolveModel` / `resolveImageUrls` 读 `fallbackEntries()`（静态表），
   * 而 `listModels` / `listAllModels` 读远端 ⇒ **同一模型两个答案**。
   *
   * ⚠️ 旧守卫（`model-catalog-parity.spec.ts`）恒真，因为测试里远端失败后
   * 回落到**同一份静态表** ⇒ 两边逐字相等。必须让远端与静态表**不同**才有牙。
   */
  it('★★★ B-3 远端新增模型必须在 resolveModel 上可见', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    const REMOTE_ONLY = 'brand-new-model-2027'
    const ad = new QwenworkAdapter({
      slots: async () => [{ id: 'x', accessToken: 'd' }],
      mintTicket: async () => ({
        token: 't',
        baseUrl: 'https://api1.example.fake',
        expiresAtMs: Date.now() + 3_600_000,
      }),
    })
    const origFetch = globalThis.fetch
    // 远端目录只回一条**静态表里没有**的模型
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/api/chat-modes')) {
        return new Response(JSON.stringify({
          qwork: [{
            key: REMOTE_ONLY,
            enable: true,
            is_vl: true,
            max_input_tokens: 2_000_000,
            price_factor: 0.7,
            i18n: { display_name: { zh: '全新模型' } },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const listed = await ad.listModels('qwenworkintl')
      const remote = listed.find((m) => m.id === REMOTE_ONLY)
      expect(remote, '远端模型应出现在选择器里').toBeDefined()
      // ⚠️ 关键：resolveModel 必须也能解析出它（而不是回裸 id）
      const resolved = await ad.resolveModel('qwenworkintl', REMOTE_ONLY)
      expect(
        resolved.name,
        'resolveModel 必须与 listModels 同源（不再是裸 id）',
      ).toBe(remote?.name)
      expect(resolved.context?.contextWindow, '远端声明的窗口必须透出').toBe(2_000_000)
      expect(resolved.inputModalities, '远端声明的图片能力必须透出').toContain('image')
      expect(
        resolved.reasoning?.efforts?.length ?? 0,
        '档位也必须透出（静态表里没有这个模型 ⇒ 曾恒 0 档）',
      ).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

  /**
   * ## C-1 多账号全认证失败 ⇒ 必须报 AUTH，不得报「额度用尽」
   *
   * ⚠️ 为什么单账号那条守卫抓不到 `authOnly` 分流（变异实测无牙）：
   * 单账号在 auth 分支里走的是 `if (tried.size >= slots.length) throw error`
   * ⇒ **直接透传原始 401**，根本不进 `limited` 收集，也不走到最后的
   * 「所有账号均受限」。
   *
   * 只有**多账号**才会把每个槽 push 进 `limited` 并在循环末尾汇总
   * ⇒ 那才是 `authOnly` 分流的唯一可达路径。
   *
   * 缺陷后果：全部账号令牌都失效时，用户看到「所有账号对该模型均受限」+
   * 码 `QUOTA_EXCEEDED` ⇒ 会去**解锁长期积分**（不可撤回），
   * 而真因与额度毫无关系。
   */
  it('★★★ C-1 多账号全认证失败必须报 AUTH（不是 QUOTA_EXCEEDED）', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    let refreshCalls = 0
    const ad = new QwenworkAdapter({
      // 两个账号，都过期
      slots: async () => [
        { id: 'acc-1', accessToken: 'old-1' },
        { id: 'acc-2', accessToken: 'old-2' },
      ],
      mintTicket: async () => ({
        token: 'maas',
        baseUrl: 'https://api1.example.fake',
        expiresAtMs: Date.now() + 3_600_000,
      }),
      refresh: async () => { refreshCalls++ },
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'unauthorized', message: 'invalid token' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    let code: string | undefined
    let msg = ''
    try {
      for await (const _chunk of ad.stream({
        model: 'flash',
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* 消费 */ }
    } catch (e) {
      code = (e as { code?: string }).code
      msg = String((e as Error).message)
    } finally {
      globalThis.fetch = origFetch
    }
    expect(refreshCalls, '两个号各续期一次').toBe(2)
    // ⚠️ 核心断言：不得退化成 QUOTA_EXCEEDED
    expect(
      code,
      '全部账号认证失败 ≠ 额度用尽；报 QUOTA_EXCEEDED 会推用户解锁长期积分',
    ).toBe('AUTH')
    expect(msg, '文案必须指向「重新登录」').toMatch(/重新登录/)
    expect(msg, '文案必须明确否定「额度」方向').toMatch(/与积分无关|不要为此解锁/)
  })

  /**
   * ## C-2 远端新增模型的图片能力必须从骨架读（不是静态表）
   *
   * `resolveImageUrls` 原先读 `fallbackEntries()` ⇒ 对远端新增模型恒判
   * 「不支持图片」⇒ 发图恒抛 `UNSUPPORTED_CONTENT`，
   * 而选择器里该模型的 `inputModalities` 明明含 `image` —— **两个出口相反**。
   */
  it('★★★ C-2 远端新增模型必须允许发图', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    const REMOTE_ONLY = 'brand-new-model-2027'
    const ad = new QwenworkAdapter({
      slots: async () => [{ id: 'x', accessToken: 'd' }],
      mintTicket: async () => ({
        token: 't',
        baseUrl: 'https://api1.example.fake',
        expiresAtMs: Date.now() + 3_600_000,
      }),
      // 提供一个能返回图片的 readImage，让流程能走到「能力判定之后」
      readImage: async () => ({ mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }),
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes('/api/chat-modes')) {
        return new Response(JSON.stringify({
          qwork: [{
            key: REMOTE_ONLY,
            enable: true,
            is_vl: true,
            max_input_tokens: 2_000_000,
            price_factor: 0.7,
            i18n: { display_name: { zh: '全新模型' } },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      // 先让 listModels 把远端目录读进缓存
      await ad.listModels('qwenworkintl')
      /**
       * 直接调 resolveImageUrls（protected）—— 它在 `streamVia` 里被调用。
       * ⚠️ 判据：**不得**抛 `UNSUPPORTED_CONTENT`（那说明还在读静态表）。
       */
      const call = (ad as unknown as {
        resolveImageUrls(m: string, msgs: readonly { content: unknown }[]): Promise<unknown>
      }).resolveImageUrls.bind(ad)
      // ⚠️ 形状必须是 `{type:'image', attachment:{attachmentId}}` ——
      //    `collectImages`（openai-compat.ts:156）只认 `attachmentId`，
      //    写成 `id` 会收集到 0 张图 ⇒ `resolveImageUrls` 直接返回 undefined
      //    ⇒ 用例红得毫无意义（我第一版就是这样）。
      const msgs = [{ content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }]
      await expect(call(REMOTE_ONLY, msgs)).resolves.toBeDefined()
    } finally {
      globalThis.fetch = origFetch
    }
  })

  /**
   * ## D-1 单账号 401 必须**保留上游原文**（二轮审计抓到的回归）
   *
   * 我上一轮为了让 `authOnly` 分流可达，把 auth 分支的 `throw error` 改成了
   * `continue`（由循环顶部统一汇总）—— **代价是丢了最后一枚上游错误的原文**：
   *
   * ```
   * 改动前: "HTTP 401 — {…"trace_id": "TRACE-123"…}"   ← 原文在
   * 改动后: "全部账号认证失败…请重新登录"              ← trace_id 没了
   * ```
   *
   * 上游 `trace_id` / 原始报文是**用户找客服时唯一的凭据**，
   * 也是我们排查「到底是哪种 401」的唯一线索。
   *
   * ⚠️ 本仓红线说「`AUTH` 码会连 message 一起吞掉」—— 那条针对**宿主**，
   * 所以我们在自己这一层更不能主动扩大信息损失。
   */
  it('★★★ D-1 单账号 401 必须保留上游原文（trace_id 不能丢）', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    const ad = new QwenworkAdapter({
      slots: async () => [{ id: 'a1', accessToken: 't' }],
      mintTicket: async () => ({
        token: 'm',
        baseUrl: 'https://api1.example.fake',
        expiresAtMs: Date.now() + 3_600_000,
      }),
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'unauthorized', trace_id: 'TRACE-XYZ-998' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    let msg = ''
    try {
      for await (const _chunk of ad.stream({
        model: 'flash',
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* 消费 */ }
    } catch (e) {
      msg = String((e as Error).message)
    } finally {
      globalThis.fetch = origFetch
    }
    /**
     * ⚠️ 核心断言：单账号场景必须**原样透传**上游报文（含 trace_id）。
     * 单账号没有「汇总」的必要，包装只会损失信息。
     */
    expect(msg, '单账号 401 必须保留上游 trace_id').toContain('TRACE-XYZ-998')
    expect(msg, '必须带上 HTTP 401 这个关键信号').toContain('401')
  })

  /**
   * ## D-2 多账号全认证失败：汇总文案**也要**带上游原文
   *
   * 多账号时包装是**有价值**的（那句话解释了「为什么全都不行」），
   * 但**不能因此丢掉诊断信息** ⇒ 汇总文案末尾必须附最后一条上游原文。
   */
  it('★★★ D-2 多账号汇总文案也要带上游原文', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    const ad = new QwenworkAdapter({
      slots: async () => [
        { id: 'a1', accessToken: 't1' },
        { id: 'a2', accessToken: 't2' },
      ],
      mintTicket: async () => ({
        token: 'm',
        baseUrl: 'https://api1.example.fake',
        expiresAtMs: Date.now() + 3_600_000,
      }),
      refresh: async () => {},
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'unauthorized', trace_id: 'TRACE-MULTI-42' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    let msg = ''
    let code: string | undefined
    try {
      for await (const _chunk of ad.stream({
        model: 'flash',
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* 消费 */ }
    } catch (e) {
      msg = String((e as Error).message)
      code = (e as { code?: string }).code
    } finally {
      globalThis.fetch = origFetch
    }
    expect(code, '多账号全过期应报 AUTH').toBe('AUTH')
    expect(msg, '汇总文案必须附上游原文（含 trace_id）').toContain('TRACE-MULTI-42')
    expect(msg, '仍要说清「重新登录」这条出路').toMatch(/重新登录/)
  })

describe('★★★ 二轮审计的三个 🔴（行为级，全部落在旧守卫盲区）', () => {
  /**
   * ## E-1 🔴B-1 续期后必须用**新 token** 重发
   *
   * 旧守卫只断言 `httpCalls >= 2` —— **抓不到用哪张 token**。
   * 实测缺陷：
   *
   * ```
   * 换票时的 token 序列: ["OLD-TOKEN"]      ← 续期后仍用它
   * 续期后凭据库:        NEW-TOKEN          ← 库真的改了，但没用上
   * ```
   *
   * 根因：`slots` 是循环**开始前**的一份 `{ id, accessToken }` 快照，
   * 续期改的是**凭据库** ⇒ 快照不会自己变。
   *
   * ⇒ ① 自愈链整条无效；② 每轮白烧一次一次性 `refresh_token` 轮换。
   */
  it('★★★ E-1 续期后重发必须用新 token', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    let store = 'OLD-TOKEN'
    const exchanged: string[] = []
    const ad = new QwenworkAdapter({
      slots: async () => [{ id: 'acc-1', accessToken: store }],
      mintTicket: async (slot) => {
        exchanged.push(slot.accessToken)
        if (slot.accessToken !== 'NEW-TOKEN') {
          const e = new Error('qwenworkintl: 换取推理票据失败（HTTP 401）——INVALID_TOKEN')
          ;(e as { status?: number }).status = 401
          throw e
        }
        return {
          token: 'maas',
          baseUrl: 'https://api1.example.fake',
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      refresh: async () => { store = 'NEW-TOKEN' },
      // ★ 关键：重新取快照
      fetchSlots: async () => [{ id: 'acc-1', accessToken: store }],
    })
    let code: string | undefined
    try {
      for await (const _c of ad.stream({
        model: 'flash',
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* 消费 */ }
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(exchanged, '换票应至少两次（401 后用新 token 重发）').toHaveLength(2)
    expect(exchanged[0], '第一次用旧 token').toBe('OLD-TOKEN')
    expect(
      exchanged[1],
      '第二次必须用续期后的新 token（用旧的说明 slots 快照没刷新）',
    ).toBe('NEW-TOKEN')
    expect(code, '续期成功后不该再报错').toBeUndefined()
  })

  /**
   * ## E-2 🔴B-2 续期必须续**刚失败的那个号**
   *
   * 原接线用 `pool.getAvailableAccount(provider, '')` 取池里**第一个可用**账号，
   * 而失败的可能不是它（实测：轮换起点选 acc-2、却续了 acc-1）。
   * `refresh_token` 一次性轮换 ⇒ 白烧另一个号的凭据。
   */
  it('★★★ E-2 refresh 必须收到失败的 slotId', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    const got: (string | undefined)[] = []
    const ad = new QwenworkAdapter({
      slots: async () => [{ id: 'acc-TARGET', accessToken: 't' }],
      mintTicket: async () => {
        const e = new Error('HTTP 401 INVALID_TOKEN')
        ;(e as { status?: number }).status = 401
        throw e
      },
      refresh: async (slotId) => { got.push(slotId) },
    })
    try {
      for await (const _c of ad.stream({
        model: 'flash',
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* 消费 */ }
    } catch { /* 预期失败 */ }
    expect(got, 'refresh 应被调用一次').toHaveLength(1)
    expect(
      got[0],
      'refresh 必须收到失败的 slotId（不传则接线层会续错账号）',
    ).toBe('acc-TARGET')
  })

  /**
   * ## E-3 🔴B-3 换票 401 必须被识别成 auth（才触发续期、才有 AUTH 码）
   *
   * 换票处原抛**裸 `Error`**（无 `status`）⇒ 分类落到 `transport`：
   *
   * ```
   * 换票 401 归类     → transport   （应为 auth）
   * refresh 调用次数  → 0           （应为 1）
   * 抛出的 code      → undefined   （应为 AUTH）
   * ```
   *
   * ⚠️ 登录 token 只有 15 天、MaaS 票据每请求都换 ⇒ 令牌过期时
   * **第一现场几乎总是换票**，故这一格决定了自愈链在真实场景下是否生效。
   */
  it('★★★ E-3 换票 401 必须归为 auth 并触发续期', async () => {
    const { QwenworkAdapter } = await import('../../src/qwenwork-adapter.js')
    const { classifyQwenworkFailure } = await import('../../src/qwenwork-adapter.js')
    // ① 分类器本身：带 status/body 的裸错误必须判成 auth
    const bare = new Error('qwenworkintl: 换取推理票据失败（HTTP 401）——INVALID_TOKEN')
    ;(bare as { status?: number }).status = 401
    ;(bare as { body?: string }).body = '{"errorCode":"INVALID_TOKEN"}'
    expect(
      classifyQwenworkFailure(bare).kind,
      '带 status 的裸错误必须判 auth（否则不续期且无 AUTH 码）',
    ).toBe('auth')
    // ② 端到端：换票 401 必须真的触发 refresh
    let refreshCalls = 0
    const ad = new QwenworkAdapter({
      slots: async () => [{ id: 'acc-1', accessToken: 't' }],
      mintTicket: async () => {
        const e = new Error('qwenworkintl: 换取推理票据失败（HTTP 401）——INVALID_TOKEN')
        ;(e as { status?: number }).status = 401
        ;(e as { body?: string }).body = '{"errorCode":"INVALID_TOKEN"}'
        throw e
      },
      refresh: async () => { refreshCalls++ },
    })
    let code: string | undefined
    try {
      for await (const _c of ad.stream({
        model: 'flash',
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* 消费 */ }
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(refreshCalls, '换票 401 必须触发续期（原实现 0 次）').toBeGreaterThanOrEqual(1)
    expect(code, '最终错误码必须是 AUTH（不是 undefined/transport）').toBe('AUTH')
  })

  /**
   * ## E-4 🟡B-6 分类器的状态码必须优先于 body 子串
   *
   * 实测误分类（修复前）：
   *
   * ```
   * 401 + "context window"                    → context_window（应为 auth）
   * 429 + "too many requests for this context window" → context_window（应为 rate_limit）
   * 500 + "insufficient capacity"              → quota（应为 server）
   * 400 + "insufficient permissions for model" → quota（应为 invalid_request）
   * ```
   */
  it('★★★ E-4 状态码优先于 body 子串（防误分类）', async () => {
    const { classifyQwenworkError } = await import('../../src/qwenwork-product.js')
    const cases: Array<[string, number, string, string]> = [
      ['401 + context window', 401, '{"error":{"message":"invalid token","detail":"context window rotated"}}', 'auth'],
      ['429 + context window', 429, '{"error":{"message":"too many requests for this context window"}}', 'rate_limit'],
      ['500 + insufficient capacity', 500, '{"error":{"message":"insufficient capacity"}}', 'server'],
      ['400 + insufficient permissions', 400, '{"error":{"message":"insufficient permissions for model"}}', 'invalid_request'],
      ['正常 401', 401, '{"error":{"code":"unauthorized"}}', 'auth'],
      ['正常 429', 429, '{"error":{"code":"rate_limit"}}', 'rate_limit'],
    ]
    for (const [label, status, body, want] of cases) {
      expect(classifyQwenworkError(status, body).kind, label).toBe(want)
    }
  })
})

describe('★★★ 二轮审计：源码文本级守卫的共性弱点（死分支）', () => {
  /**
   * ## 为什么需要这一组
   *
   * 二轮审计做了 16 个变异，其中 **6 个全绿**，共同形态是：
   * **「文本还在、逻辑已死」** ——
   *
   * ```ts
   * allowPermanent: !pool.permanentLocked(id) && false   // 锁定失效，文本仍在
   * if (isPolicyBlockedAccount(entry) && false) return false  // 封禁号仍被选中
   * if (false) throwIfAllAccountsRateLimited(...)        // 全限流谎报「请登录」
   * ```
   *
   * 所有 `toMatch(/…/)` 型守卫对这三类**全部无牙**。
   *
   * ⇒ 这一组用**常量假条件检测**：把 `index.ts` 里 qwenwork 的 `slotsFor`
   *   闭包切出来，扫它里面有没有「恒假」或「恒真」的常量短路。
   *
   * ⚠️ 这不是万能的（真正彻底的做法是把 `slotsFor` 提到可注入的模块里做行为测试），
   * 但它能挡住本仓历史上反复出现的「`&& false` / `if (false)`」这一类。
   */
  it('★★★ F-1 slotsFor 闭包里不得有常量假条件短路', () => {
    // 切出 slotsFor 闭包（从声明到它对应的收尾大括号）
    const startAt = indexCode.indexOf('const slotsFor = async')
    expect(startAt, '找不到 slotsFor（形态变了？）').toBeGreaterThan(-1)
    let depth = 0
    let endAt = -1
    for (let i = indexCode.indexOf('{', startAt); i < indexCode.length; i++) {
      const ch = indexCode[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { endAt = i; break }
      }
    }
    expect(endAt, 'slotsFor 大括号不配对').toBeGreaterThan(startAt)
    const body = indexCode.slice(startAt, endAt)
    /**
     * ⚠️ 判据：**不得出现常量假/真短路**。
     * - `&& false` / `&& 0` / `|| true` ⇒ 恒假/恒真，等于删除该条件
     * - `if (false)` / `if (0)` ⇒ 整块死代码
     */
    const deadPatterns: Array<[RegExp, string]> = [
      [/&&\s*false\b/, '&& false（恒假短路）'],
      [/&&\s*0\s*[,)]/, '&& 0（恒假短路）'],
      [/\|\|\s*true\b/, '|| true（恒真短路）'],
      [/\bif\s*\(\s*false\s*\)/, 'if (false)（死代码块）'],
      [/\bif\s*\(\s*0\s*\)/, 'if (0)（死代码块）'],
      [/!\s*false\b/, '!false（恒真，可疑）'],
    ]
    for (const [re, label] of deadPatterns) {
      expect(
        re.test(body),
        `slotsFor 里出现 ${label} ⇒ 该判据实际不生效（文本在、逻辑死）`,
      ).toBe(false)
    }
  })

  /**
   * ## F-2 关键调用的**参数形态**也要锚住
   *
   * 二轮审计还发现：把 `refreshAccountCredential(entry.credentialRef, pool, entry.id)`
   * 整行包进 `if (false)` 时，只断言函数名的守卫仍然绿。
   * ⇒ 除了 F-1 的死分支检测，还要锚住**三参形态**（少一个参数就会续错账号）。
   */
  it('★★★ F-2 refresh 装配必须是三参形态', () => {
    expect(
      indexCode,
      '必须 refreshAccountCredential(entry.credentialRef, pool, entry.id) 三参',
    ).toMatch(
      /refreshAccountCredential\(\s*entry\.credentialRef,\s*pool,\s*entry\.id,?\s*\)/,
    )
  })

  /**
   * ## F-3 **整段 qwenwork 装配**不得有死分支（F-1 只覆盖 slotsFor 闭包）
   *
   * 二轮审计实测漏网：把 `await qwenworkintl.refreshAccountCredential(...)`
   * 包进 `if (false)` 时，F-1 扫不到 —— 因为 `refresh` 装配在 `slotsFor`
   * **外面**（它是同一个 `registerQwenworkLlm({...})` 对象的另一个字段）。
   *
   * ⇒ 扫的范围从「slotsFor 闭包」扩到「`registerQwenworkLlm` 整个调用」。
   */
  it('★★★ F-3 qwenwork 装配块不得有常量假条件短路', () => {
    const at = indexCode.indexOf('registerQwenworkLlm(ctx, {')
    expect(at, '找不到 registerQwenworkLlm 调用').toBeGreaterThan(-1)
    // 从调用起点数到配对的大括号
    let depth = 0
    let endAt = -1
    for (let i = indexCode.indexOf('{', at); i < indexCode.length; i++) {
      const ch = indexCode[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { endAt = i; break }
      }
    }
    expect(endAt, '装配块大括号不配对').toBeGreaterThan(at)
    const body = indexCode.slice(at, endAt)
    const deadPatterns: Array<[RegExp, string]> = [
      [/&&\s*false\b/, '&& false'],
      [/&&\s*0\s*[,)]/, '&& 0'],
      [/\|\|\s*true\b/, '|| true'],
      [/\bif\s*\(\s*false\s*\)/, 'if (false)'],
      [/\bif\s*\(\s*0\s*\)/, 'if (0)'],
    ]
    for (const [re, label] of deadPatterns) {
      expect(
        re.test(body),
        `qwenwork 装配里出现 ${label} ⇒ 该字段/调用实际不生效（文本在、逻辑死）`,
      ).toBe(false)
    }
  })

})
