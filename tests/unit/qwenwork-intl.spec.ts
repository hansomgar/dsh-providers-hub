/**
 * 千问办公国际站（QwenWork Intl）的单元测试。
 *
 * 覆盖四组判据，全部来自**真机实测**（2026-11-22）：
 *
 * 1. **凭据与纯函数**：`access_token` 字段名、秒/毫秒兼容、JWT 解析不抛错；
 * 2. **错误分类的顺序**：`context_length_exceeded` 必须最先、`balance_insufficient`
 *    必须在 `rate_limit` 之前（两者都是 HTTP 429，混了会把额度当限流或反过来）；
 * 3. **额度三池分离**：`total` 取 daily（推理只扣它），longterm 单独成包；
 * 4. **适配器契约**：目录恒为兜底表 9 条、`prepareCall` 必须包、图片能力逐模型。
 *
 * ⚠️ **不发任何真实网络请求**：所有 fetch 都是注入了桩的。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  QWENWORK_INTL,
  QWENWORK_INTL_FALLBACK_MODELS,
  classifyQwenworkError,
  displayNameOfQwenworkModel,
  isKnownQwenworkModel,
  parseQwenworkChatModes,
} from '../../src/qwenwork-product.js'
import {
  decodeQwenworkJwt,
  isQwenworkExpired,
  isQwenworkRefreshable,
  maskQwenworkToken,
  normalizeQwenworkModelId,
  qwenworkCredentialExpiresAtMs,
  qwenworkDailyExhausted,
  qwenworkDeviceAuthUrl,
  qwenworkHeaders,
  qwenworkRefreshBody,
} from '../../src/qwenwork.js'
import {
  buildQwenworkBalance,
  buildQwenworkPackages,
  describeQwenworkCredits,
  fetchQwenworkBalanceDetailed,
  formatCredits,
  isQwenworkDailyWallet,
  qwenworkExpiry,
} from '../../src/qwenwork-credits.js'
import { QwenworkAdapter } from '../../src/qwenwork-adapter.js'
import { qwenworkSlotNamesOf, isQwenworkAccountRef } from '../../src/qwenwork-rpc.js'

/** 一个最小的合法 JWT（header.payload.signature），payload 里带 exp/user_id。 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature-part`
}

describe('产品配置', () => {
  it('id 是纯小写字母（registry 的 /^[a-z]+$/ 硬约束）', () => {
    expect(QWENWORK_INTL.id).toMatch(/^[a-z]+$/)
  })

  /**
   * ⚠️ **国际站专属的 OAuth 参数与国内站不同**（2026-11-22 实测）：
   * 混用会得到 `400 INVALID_DEVICE_FLOW`，且两个字段必须**成对**正确。
   * 把它们钉在这里，防止有人「顺手」改成国内站的值。
   */
  it('★ clientId / redirect 是国际站专属值（与国内站不同）', () => {
    expect(QWENWORK_INTL.clientId).toBe('cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a')
    expect(QWENWORK_INTL.redirectScheme).toBe('qwenwork://')
    // 国内站的值绝不能出现在这里。
    expect(QWENWORK_INTL.clientId).not.toBe('e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
    expect(QWENWORK_INTL.redirectScheme).not.toBe('qwenwork-cn://')
  })

  /**
   * ⚠️ **六个 query 字段一个不能多、一个不能少**（2026-11-22 实测）：
   * 任缺一个 ⇒ 400；任多一个（`response_type` / `scope` / `cosyVersion`）⇒ 同样 400。
   * 而那个报错是针对**整条 query** 的通用判据，指不出具体哪个字段错
   * ⇒ 只能靠「集合恰好相等」锁死。完整约束与推导见 `qwenwork-login.spec.ts`。
   */
   it('★ 设备授权 URL：字段恰好六个，且 clientId / redirect 是国际站专属值', () => {
    const url = qwenworkDeviceAuthUrl({
      challenge: 'chal-1',
      nonce: 'n-1',
      machineId: 'mid-1',
    })
    expect(url.startsWith(`${QWENWORK_INTL.gatewayBase}${QWENWORK_INTL.deviceAuthPath}?`)).toBe(true)
    const parsed = new URL(url)
    expect([...parsed.searchParams.keys()].sort()).toEqual([
      'challenge', 'challenge_method', 'client_id', 'machine_id', 'nonce', 'redirect_uri',
    ])
    expect(parsed.searchParams.get('client_id')).toBe(QWENWORK_INTL.clientId)
    expect(parsed.searchParams.get('redirect_uri')).toBe(QWENWORK_INTL.redirectScheme)
    expect(parsed.searchParams.get('challenge')).toBe('chal-1')
    expect(parsed.searchParams.get('challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('machine_id')).toBe('mid-1')
    // ⚠️ 反向：这些多余的字段每一个都会让上游 400。
    for (const forbidden of ['response_type', 'scope', 'cosyVersion', 'state']) {
      expect(parsed.searchParams.has(forbidden), `${forbidden} 会让上游 400`).toBe(false)
    }
  })

  /**
   * ★★ **兜底表必须与上游 `/api/chat-modes` 的真实目录逐条对齐**。
   *
   * ⚠️ 2026-11-22 用 ego-browser 打开 qwenwork.ai/app 后发现真实是 **11 条**，
   * 而我先前只写了 9 条，且有三处错：
   *
   * | 错法 | 真相 |
   * |---|---|
   * | 写了 `deepseek-v4-pro` | **不存在**（那是早期手填测试被接受的野名字）|
   * | `pro` 标 `supportsImage: false` | 上游 `is_vl: true` ⇒ **收图** |
   * | 漏了 `qwen3.8-flash` / `minimax-m3.1-flash` | 两个都在目录里 |
   *
   * ⇒ 这条断言按上游顺序逐条锁死，改表必须同时改这里。
   */
  it('★★ 模型表恰好 11 条，与上游 /api/chat-modes 逐条对齐', () => {
    expect(QWENWORK_INTL_FALLBACK_MODELS).toHaveLength(11)
    const ids = QWENWORK_INTL_FALLBACK_MODELS.map((m) => m.id)
    expect(ids).toEqual([
      'flash', 'advanced', 'pro', 'qwen4-max', 'qwen3.8-max', 'qwen3.8-flash',
      'deepseek-flash', 'glm-5.3', 'glm-5.3-flash', 'kimi-k3.1-pro', 'minimax-m3.1-flash',
    ])
    // ⚠️ 反向：`deepseek-v4-pro` 不在上游目录里，绝不能出现。
    expect(ids, 'deepseek-v4-pro 是野名字').not.toContain('deepseek-v4-pro')
  })

  /**
   * ⚠️ **实测只有 7 个模型收图**：`pro` 与 `glm-5.3` 收图回 400。
   * 整表一律 true 会让用户看到「支持图片」而实际每次必失败。
   */
  /**
   * ★★★ **全部模型一律按「支持图片」处理**（用户 2026-11-22 决定）。
   *
   * ## 为什么不再用任何判据
   *
   * 我的两轮实测结论互相矛盾：
   * - 64×64 小图只问颜色：`deepseek-flash` 答对、`pro` 400；
   * - 512×512 红蓝图各一张（看能否区分 + token 增量）：结果同上。
   *
   * 而用户实测「网页上全部模型都能看图」，且上游 `is_vl` 与任何一方都不一致。
   * ⇒ 用户决定：**一律 true，不读上游字段**。
   *
   * ⚠️ 代价与取舍写在 `QWENWORK_ASSUME_IMAGE_SUPPORT` 的文档里：
   * 「挡住用户能用的能力」比「让用户看到一条可诊断的 400」更糟。
   */
  it('★★★ 全部 11 个模型都声明 supportsImage: true', () => {
    for (const m of QWENWORK_INTL_FALLBACK_MODELS) {
      expect(m.supportsImage, m.id + ' 一律按支持图片处理').toBe(true)
    }
    // ⚠️ 反向：不得有任何一条是 false。
    expect(QWENWORK_INTL_FALLBACK_MODELS.filter((m) => !m.supportsImage)).toEqual([])
  })

  /**
   * ★★ **解析远端时也一律 true**（不看上游 `is_vl`）。
   *
   * 这条锁住「即使上游说 is_vl: false，我们也不采信」。
   */
  it('★★ 解析远端时忽略 is_vl，一律 true', () => {
    const body = {
      qwork: [
        { key: 'a', is_vl: false, max_input_tokens: 1000000, enable: true, i18n: { display_name: { zh: 'A' } } },
        { key: 'b', is_vl: true, max_input_tokens: 1000000, enable: true, i18n: { display_name: { zh: 'B' } } },
      ],
    }
    const parsed = parseQwenworkChatModes(body)
    for (const m of parsed) {
      expect(m.supportsImage, m.id + ' 不看上游 is_vl').toBe(true)
    }
  })

  /**
   * ★★ **上游的 icon / is_new 刻意不取**（2026-11-22 用户决定）。
   *
   * - `icon`：DSH 的 `LlmModelInfo` 没有 logo 渲染位置 ⇒ 死字段；
   * - `is_new`：只能画「新」角标，而网页上并没有 ⇒ 用户不要。
   */
  it('★★ 解析远端时不取 icon / isNew', () => {
    const body = {
      qwork: [{
        key: 'glm-5.3',
        is_vl: false,
        is_new: true,
        icon: 'https://img.example/x.svg',
        max_input_tokens: 1000000,
        enable: true,
        price_factor: 1.3,
        i18n: { display_name: { zh: 'GLM-5.3' } },
      }],
    }
    const m = parseQwenworkChatModes(body)[0]
    expect(m?.priceFactor, '倍率仍要取').toBe(1.3)
    // ⚠️ 反向：这两个字段不该出现。
    expect(m).not.toHaveProperty('icon')
    expect(m).not.toHaveProperty('isNew')
  })

  it('★★ 倍率缺失时不编造（priceFactor 不上、展示名也不拼）', () => {
    const body = {
      qwork: [{
        key: 'no-price',
        is_vl: true,
        max_input_tokens: 1000000,
        enable: true,
        i18n: { display_name: { zh: '无价' } },
      }],
    }
    const m = parseQwenworkChatModes(body)[0]
    expect(m?.priceFactor).toBeUndefined()
    expect(displayNameOfQwenworkModel({ name: '无价' })).toBe('无价')
  })

  it('★★ 展示名把倍率拼进 name（composer 只渲染 name）', () => {
    expect(displayNameOfQwenworkModel({ name: '标准', priceFactor: 0.1 })).toBe('标准 · x0.1')
    // ⚠️ 倍率 1 照拼（1 不是「无」）。
    expect(displayNameOfQwenworkModel({ name: '高级', priceFactor: 1 })).toBe('高级 · x1')
    // ⚠️ 倍率 0 照拼（免费是合法倍率）。
    expect(displayNameOfQwenworkModel({ name: '免费', priceFactor: 0 })).toBe('免费 · x0')
    // ⚠️ 非有限值不拼。
    expect(displayNameOfQwenworkModel({ name: '坏值', priceFactor: Number.NaN })).toBe('坏值')
    expect(displayNameOfQwenworkModel({ name: '无穷', priceFactor: Number.POSITIVE_INFINITY })).toBe('无穷')
  })

  /**
   * ⚠️ **`qwork-*` 全部 400**（实测），`qwen3.8-max-preview` 也是 400。
   * 这些名字绝不能进兜底表 —— 猜错的名字症状与「账号没权限」同形。
   */
  it('★ 兜底表里没有 qwork-* 或 -preview 这类实测会 400 的名字', () => {
    for (const m of QWENWORK_INTL_FALLBACK_MODELS) {
      expect(m.id, `"${m.id}" 实测 400`).not.toMatch(/^qwork-/)
      expect(m.id, `"${m.id}" 实测 400`).not.toMatch(/-preview$/)
    }
    expect(isKnownQwenworkModel('qwork-auto')).toBe(false)
    expect(isKnownQwenworkModel('qwen3.8-max-preview')).toBe(false)
    expect(isKnownQwenworkModel('qwen3.8-max')).toBe(true)
  })

  it('上下文窗口记 1,000,000（实测已通过的最大值）', () => {
    for (const m of QWENWORK_INTL_FALLBACK_MODELS) expect(m.contextWindow).toBe(1_000_000)
  })

  /**
   * ⚠️ **档位顺序 = 强度序（弱 → 强）**（本仓 `protocol-wire.md` 的不变式：
   * DSH 把它当展示顺序，铺成横向轴时顺序反了会变成「左强右弱」）。
   */
  /**
   * ⚠️⚠️ **四档必须全部声明，且是强度序（弱 → 强）**。
   *
   * 2026-11-22 真机实测（每档采样 2~3 次看 reasoning_tokens 均值），
   * 以 `pro` 为例四档严格递增：low 29 → medium 53 → high 67 → **max 419**。
   *
   * ⚠️ 早先只声明 `['low','high']` 是**漏了两档** —— 当时只测了
   * 「high 让 reasoning_tokens 从 0 变正」这一个判据，没意识到还有梯度。
   * 这条断言就是防止再漏。
   */
  it('★★ 思考档位是四档且为强度序（low → medium → high → max）', () => {
    for (const m of QWENWORK_INTL_FALLBACK_MODELS) {
      expect(m.efforts, `${m.id} 应声明四档`).toEqual(['low', 'medium', 'high', 'max'])
      // ⚠️ 反向：绝不能只有两档（那是漏声明）。
      expect(m.efforts, `${m.id} 不能只声明 low/high`).not.toEqual(['low', 'high'])
      // ⚠️ 强度序：max 必须在最后（DSH 按此顺序展示，反了会「左强右弱」）。
      expect(m.efforts?.[m.efforts.length - 1]).toBe('max')
      expect(m.efforts?.[0]).toBe('low')
    }
  })
})

describe('错误分类：顺序即优先级', () => {
  /**
   * ⚠️⚠️ **上下文超限必须最先判**：实测回 **HTTP 400 +
   * `context_length_exceeded`**。若落进 `invalid_request` 或 `quota`，
   * 宿主的 context-overflow 监听器不触发 ⇒ **自动压缩不跑**，
   * 用户只看到「请求无效」而唯一有效动作（压缩重试）被掩盖。
   */
  it('★ context_length_exceeded 归 context_window（且先于 400 的 invalid_request）', () => {
    const info = classifyQwenworkError(400, '{"error":{"code":"context_length_exceeded","message":"context length exceeded"}}')
    expect(info.kind).toBe('context_window')
  })

  /**
   * ⚠️⚠️ **额度拒绝是 HTTP 429 + `balance_insufficient`**（实测原文）。
   * 若按「429 ⇒ rate_limit」处理，额度耗尽会被当成短时限流 ⇒ 账号被反复重试。
   */
  it('★★ 429 + balance_insufficient 归 quota，不是 rate_limit', () => {
    const info = classifyQwenworkError(429, '{"error":{"code":"balance_insufficient","type":"insufficient_quota"}}')
    expect(info.kind).toBe('quota')
  })

  it('429 无额度文案时仍归 rate_limit（两者必须能区分）', () => {
    const info = classifyQwenworkError(429, '{"error":{"code":"rate_limit_exceeded"}}')
    expect(info.kind).toBe('rate_limit')
  })

  /** ⚠️ 认证是**账号态**，不是模型冷却：落 quota 会被写成冷却并放大成封池。 */
  it('401 / 403 恒归 auth（即使报文里带额度字样）', () => {
    expect(classifyQwenworkError(401, '{"error":{"message":"token is invalid"}}').kind).toBe('auth')
    expect(classifyQwenworkError(403, '{"error":{"message":"insufficient balance"}}').kind).toBe('auth')
  })

  it('400 invalid_request 与 5xx server 各自分桶', () => {
    expect(classifyQwenworkError(400, '{"error":{"code":"invalid_request"}}').kind).toBe('invalid_request')
    expect(classifyQwenworkError(500, 'boom').kind).toBe('server')
    expect(classifyQwenworkError(0, 'fetch failed').kind).toBe('transport')
  })

  it('detail 是人可读串，不是裸 JSON', () => {
    const info = classifyQwenworkError(400, '{"error":{"code":"invalid_request","message":"invalid request"}}')
    expect(info.detail).toContain('invalid request')
    expect(info.detail).not.toContain('{"error"')
  })

  it('retry-after 头被读进 retryAfterMs（0 是合法值）', () => {
    const info = classifyQwenworkError(429, 'rate limit', { 'retry-after': '0' })
    expect(info.kind).toBe('rate_limit')
    expect(info.retryAfterMs).toBe(0)
  })
})

describe('凭据与纯函数', () => {
  it('expires_at 兼容秒级与毫秒级（不然秒值会被当成 1970 恒判已过期）', () => {
    const ms = 1_700_000_000_000
    expect(qwenworkCredentialExpiresAtMs({ access_token: 't', expires_at: String(ms) })).toBe(ms)
    expect(qwenworkCredentialExpiresAtMs({ access_token: 't', expires_at: String(ms / 1000) })).toBe(ms)
    expect(qwenworkCredentialExpiresAtMs({ access_token: 't' })).toBeUndefined()
    expect(qwenworkCredentialExpiresAtMs({ access_token: 't', expires_at: 'abc' })).toBeUndefined()
  })

  it('没有 expires_at 时判未过期（读不到 ≠ 已失效）', () => {
    expect(isQwenworkExpired({ access_token: 't' })).toBe(false)
    expect(isQwenworkExpired({ access_token: 't', expires_at: String(Date.now() - 1000) })).toBe(true)
    expect(isQwenworkExpired({ access_token: 't', expires_at: String(Date.now() + 60_000) })).toBe(false)
  })

  it('refreshable 的判据是 refresh_token 非空（读凭据本身）', () => {
    expect(isQwenworkRefreshable({ access_token: 't', refresh_token: 'r' })).toBe(true)
    expect(isQwenworkRefreshable({ access_token: 't' })).toBe(false)
    expect(isQwenworkRefreshable({ access_token: 't', refresh_token: '' })).toBe(false)
  })

  it('JWT 解析不抛错（畸形 token 返回 undefined）', () => {
    expect(decodeQwenworkJwt('not-a-jwt')).toBeUndefined()
    expect(decodeQwenworkJwt(undefined)).toBeUndefined()
    expect(decodeQwenworkJwt('a.b.c')).toBeUndefined()
    const jwt = makeJwt({ exp: 1_800_000_000, user_id: 'uid-1', username: 'bob', email: 'b@x.com' })
    expect(decodeQwenworkJwt(jwt)).toEqual({ exp: 1_800_000_000, user_id: 'uid-1', username: 'bob', email: 'b@x.com' })
  })

  /**
   * ⚠️⚠️ **判据是 `Authorization: Bearer`，不是 cookie**
   * （2026-11-22 实测：4 种 cookie 组合全部 401）。
   */
  it('★ 请求头只发 Bearer，不发 cookie', () => {
    const headers = qwenworkHeaders('tok-1', 'application/json')
    expect(headers.authorization).toBe('Bearer tok-1')
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('cookie')
  })

  it('Accept 按用途区分（目录/辅助用 json，对话用 event-stream）', () => {
    expect(qwenworkHeaders('t', 'application/json').accept).toBe('application/json')
    expect(qwenworkHeaders('t', 'text/event-stream').accept).toBe('text/event-stream')
  })

  /**
   * ⚠️ 续期体必须带 `target`：漏掉会得 401 `INVALID_TOKEN`，
   * 症状与「refresh token 真的失效」同形（极易误诊为要重新登录）。
   */
  it('★ 续期体带 target（漏了会 401 且症状误导）', () => {
    const body = qwenworkRefreshBody('rt-1')
    expect(body).toEqual({ refresh_token: 'rt-1', target: 'c' })
    expect(body.target).toBe('c')
    // biz 形态额外带 client_id / redirect_uri。
    const biz = qwenworkRefreshBody('rt-1', QWENWORK_INTL, { target: 'biz', teamId: 't7' })
    expect(biz).toMatchObject({ refresh_token: 'rt-1', target: 'biz', team_id: 't7' })
    expect(biz.client_id).toBe(QWENWORK_INTL.clientId)
  })

  it('打码取前 6 后 4；形状不合法返回空串（绝不回显原文）', () => {
    const token = 'a'.repeat(40)
    expect(maskQwenworkToken(token)).toBe('aaaaaa…aaaa')
    expect(maskQwenworkToken('short')).toBe('')
    expect(maskQwenworkToken(undefined)).toBe('')
  })

  it('模型 id 只去空白，不剥前缀（剥了会 400）', () => {
    expect(normalizeQwenworkModelId('  glm-5.3  ')).toBe('glm-5.3')
    expect(normalizeQwenworkModelId('a/b/c')).toBe('a/b/c')
  })
})

describe('额度三池分离（本家最容易误导用户的一处）', () => {
  const now = Date.parse('2026-11-22T10:00:00+08:00')
  const snapshot = {
    daily: 200,
    monthly: 0,
    longterm: 500,
    wallets: [
      { balance: 200, validTo: '2026-11-23T00:00:00+08:00' },
      { balance: 500, validTo: '2027-02-22T01:21:29+08:00' },
    ],
  }

  /**
   * ⚠️⚠️ **`total` = daily + longterm（可消耗池之和）**。
   *
   * ⚠️ 这条断言曾被改成「total 只取 daily」，依据是「新账号实测只扣 daily」。
   * 2026-11-22 晚用 **daily 已耗尽的账号** 实测推翻了它：
   * `daily=0 / longterm=378` 时推理照样 200，且扣的是 longterm
   * （`378.0028 → 378.0011`）⇒ 机制是**瀑布扣减**，两个池都真能用。
   *
   * 取 daily 的旧写法会把这类账号显示成 0 并报「查询失败」
   * —— 那正是用户的真实报障。
   */
  it('★★ total = daily + longterm（瀑布扣减 ⇒ 两池都可用）', () => {
    const balance = buildQwenworkBalance(snapshot, now)
    expect(balance).toBeDefined()
    expect(balance!.total).toBe(700)
    // ⚠️ 反向：绝不能只取 daily。
    expect(balance!.total).not.toBe(200)
  })

  /**
   * ★★ **daily 耗尽但 longterm 还有钱** 是最关键的形态（用户当前账号就是）。
   * 这时 total 必须等于 longterm，且**不得**返回 undefined（那会渲染成「查询失败」）。
   */
  it('★★ daily=0 且 longterm>0 ⇒ total=longterm，不是 undefined', () => {
    const balance = buildQwenworkBalance({ daily: 0, longterm: 378.0028, wallets: [] }, now)
    expect(balance, 'daily 用完不等于查不到').toBeDefined()
    expect(balance!.total).toBe(378.0028)
  })

  /**
   * ⚠️ 包名**不能写「推理不消耗」**：daily 用完后推理就扣它（实测）。
   * 「注册赠送」是来源、「长期」是特征，写在一起就够。
   */
  it('★ longterm 单独成包，名字写作「长期额度（注册赠送）」', () => {
    const packages = buildQwenworkPackages(snapshot, now)
    expect(packages).toHaveLength(2)
    const longterm = packages.find((p) => p.name.includes('注册赠送'))
    expect(longterm, '必须有一个包专门表示长期额度').toBeDefined()
    expect(longterm!.name).toBe('长期额度（注册赠送）')
    // ⚠️ 反向：绝不能声称「推理不消耗」（已被实测推翻）。
    expect(longterm!.name).not.toContain('不消耗')
    expect(longterm!.remaining).toBe(500)
  })

  /** ⚠️ 上游只给当前余额、不给初始总额 ⇒ `totalKnown: false`，否则面板显示假分母。 */
  it('★ 每一包都是 totalKnown: false（上游只给 remaining）', () => {
    for (const p of buildQwenworkPackages(snapshot, now)) {
      expect(p.totalKnown, `${p.name} 的总量未知`).toBe(false)
      expect(p.total).toBe(p.remaining)
    }
  })

  it('每日钱包按「36 小时内到期」识别，不按数组下标', () => {
    expect(isQwenworkDailyWallet(snapshot.wallets[0]!, now)).toBe(true)
    expect(isQwenworkDailyWallet(snapshot.wallets[1]!, now)).toBe(false)
    // 顺序颠倒也必须认得出（实测顺序不保证）。
    expect(isQwenworkDailyWallet(snapshot.wallets[1]!, now)).toBe(false)
    expect(isQwenworkDailyWallet({ balance: 1 }, now)).toBe(false)
  })

  it('读不到 daily 时返回 undefined（不得当 0）', () => {
    expect(buildQwenworkBalance({ wallets: [] }, now)).toBeUndefined()
    expect(buildQwenworkBalance({ daily: Number.NaN, wallets: [] }, now)).toBeUndefined()
  })

  it('没有 valid_to 的钱包置 expiryUnknown（绝不反推日期）', () => {
    const packages = buildQwenworkPackages({ wallets: [{ balance: 10 }] }, now)
    expect(packages[0]!.expiryUnknown).toBe(true)
    expect(packages[0]!.expiredTime).toBe('')
  })

  it('摘要把两个池分开写，绝不合成一个数', () => {
    const text = describeQwenworkCredits(snapshot)
    expect(text).toContain('每日 200')
    expect(text).toContain('长期 500')
    // ⚠️ 反向：不能出现「推理不消耗」这种已被推翻的说法。
    expect(text).not.toContain('不消耗')
    // ⚠️ 也不能把两池合并成一个 700。
    expect(text).not.toContain('700')
  })

  it('qwenworkDailyExhausted 三态：true / false / undefined（读不到不判死）', () => {
    expect(qwenworkDailyExhausted(0)).toBe(true)
    expect(qwenworkDailyExhausted(-1)).toBe(true)
    expect(qwenworkDailyExhausted(0.0001)).toBe(false)
    expect(qwenworkDailyExhausted(undefined)).toBeUndefined()
    expect(qwenworkDailyExhausted(Number.NaN)).toBeUndefined()
  })

  it('formatCredits 去掉尾零但保留精度', () => {
    expect(formatCredits(200)).toBe('200')
    expect(formatCredits(199.8368)).toBe('199.8368')
    expect(formatCredits(Number.NaN)).toBe('—')
  })
})

/**
 * ★★★ deductionEndTime 必须写（2026-11-22 用户真机报障）。
 *
 * ## 缺陷
 *
 * 面板显示「临期 200」，但锁定长期积分后报「所有账号的这类额度都已用尽」。
 *
 * ## 根因
 *
 * 分档函数 splitBuddyCreditsByExpiry（buddy-balance-rank.ts:365）
 * **只读 pkg.deductionEndTime**，**完全不读** expiredTime：
 *
 *     const endTime = pkg.deductionEndTime   // ← 唯一入口
 *
 * 我只填了 expiredTime ⇒ deductionEndTime 恒 undefined
 * ⇒ 两个池都被判「永久」⇒ 锁定后 allowPermanent: false ⇒ **所有账号不可用**。
 *
 * ⚠️ 面板之所以显示「临期」：那是**前端** credit-expiry.js 的 packageExpiryMs
 * （优先 deductionEndTime、缺失才回落 expiredTime）
 * ⇒ **前后端两套判据**，同一份数据在面板是「临期」、在选号是「永久」。
 * 这正是本仓红线「同一语义两套判据」的形态。
 */
describe('★★★ 包必须带 deductionEndTime（否则分档恒判「永久」）', () => {
  const now = Date.parse('2026-11-22T10:00:00+08:00')
  const snapshot = {
    daily: 200,
    longterm: 500,
    // daily 次日 00:00（约 0.58 天）、longterm 三个月后（约 92 天）
    wallets: [
      { balance: 200, validTo: '2026-11-23T00:00:00+08:00' },
      { balance: 500, validTo: '2027-02-22T01:21:29+08:00' },
    ],
  }

  it('★★★ 每个带 validTo 的包都写了 deductionEndTime', () => {
    const packages = buildQwenworkPackages(snapshot, now)
    expect(packages).toHaveLength(2)
    for (const pkg of packages) {
      expect(
        pkg.deductionEndTime,
        pkg.name + ' 缺 deductionEndTime ⇒ 后端分档会把它当「永久」',
      ).toBeTypeOf('number')
      // ⚠️ 必须等于 validTo 解析出的毫秒值。
      expect(pkg.deductionEndTime).toBe(Date.parse(pkg.expiredTime))
    }
  })

  /**
   * ★★★ **端到端判据：真的用分档函数跑一遍**。
   *
   * 只断言「字段存在」不够 —— 若两值不一致（比如写成了秒），
   * 字段在、分档仍错。故直接用共享的 splitBuddyCreditsByExpiry 验证。
   */
  it('★★★ 分档结果正确：daily 落「临期」、longterm 落「永久」', async () => {
    const { splitBuddyCreditsByExpiry } = await import('../../src/buddy-balance-rank.js')
    const balance = buildQwenworkBalance(snapshot, now)
    const split = splitBuddyCreditsByExpiry(balance, now, 15 * 86400_000, 5 * 86400_000)
    expect(split).toBeDefined()
    // ⚠️ daily 200 在 15 天窗口内 ⇒ 落 expiring（**这是可用性判据**）。
    expect(split.expiring, 'daily 必须落「临期」，否则锁定后该号不可用').toBe(200)
    // ⚠️ longterm 500 在 92 天后 ⇒ 落 permanent。
    expect(split.permanent).toBe(500)
  })

  /** ⚠️ 没有 validTo 时不写 deductionEndTime（**绝不编造日期**，本仓红线）。 */
  it('★ 没有 validTo 时不写 deductionEndTime（不编造）', () => {
    const packages = buildQwenworkPackages({ wallets: [{ balance: 10 }] }, now)
    expect(packages[0].deductionEndTime).toBeUndefined()
    expect(packages[0].expiryUnknown).toBe(true)
  })

  /**
   * ★★ 反向对照：**只有 expiredTime 而缺 deductionEndTime** ⇒ 分档必判「永久」。
   *
   * 这条把缺陷形态本身钉死 —— 将来谁把 deductionEndTime 删掉，
   * 上面那条会红，而这条解释**为什么**不能删。
   */
  it('★★ 反向：只给 expiredTime 不给 deductionEndTime ⇒ 分档判「永久」', async () => {
    const { splitBuddyCreditsByExpiry } = await import('../../src/buddy-balance-rank.js')
    // 手工构造一个「只有 expiredTime」的包（= 修复前的实现）。
    const broken = {
      total: 200,
      expiredTotal: 0,
      packages: [{
        name: '每日额度',
        unit: '积分',
        remaining: 200,
        total: 200,
        totalKnown: false,
        used: 0,
        active: true,
        cycleStartTime: '',
        cycleEndTime: '',
        expiredTime: '2026-11-23T00:00:00+08:00',
        // ⚠️ 刻意不写 deductionEndTime。
      }],
    }
    const split = splitBuddyCreditsByExpiry(broken, now, 15 * 86400_000, 5 * 86400_000)
    expect(split).toBeDefined()
    expect(split.expiring, '缺 deductionEndTime 时 200 会被误判成永久').toBe(0)
    expect(split.permanent).toBe(200)
  })
})
describe('额度折算原语 qwenworkExpiry', () => {
  const now = Date.parse('2026-11-22T10:00:00+08:00')

  it('有 daily 且未到期 ⇒ 返回每日池的到期时刻', async () => {
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      fetchBalance: async () => ({
        daily: 200,
        wallets: [{ balance: 200, validTo: '2026-11-23T00:00:00+08:00' }],
      }),
    })
    expect(at).toBe(Date.parse('2026-11-23T00:00:00+08:00'))
  })

  /**
   * ⚠️⚠️ **daily 为 0 但 longterm 还有钱 ⇒ 账号可用**（瀑布扣减）。
   *
   * ⚠️ 这条曾被写成「必须判 UNUSABLE」，依据是「新账号实测只扣 daily」。
   * 2026-11-22 晚实测推翻：`daily=0 / longterm=378` 时推理 200 且扣 longterm。
   * 判 UNUSABLE 会把**最健康的账号**（长期额度还剩几百）从聚合轮换里剔除。
   */
  it('★★ daily=0 但 longterm>0 ⇒ 可用（瀑布扣减）', async () => {
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      fetchBalance: async () => ({
        daily: 0,
        longterm: 378.0028,
        wallets: [{ balance: 378.0028, validTo: '2027-02-22T01:21:29+08:00' }],
      }),
    })
    // 应返回 longterm 的到期时刻（三个月后），不是 UNUSABLE。
    expect(at).toBe(Date.parse('2027-02-22T01:21:29+08:00'))
  })

  /** ⚠️ 两池都是 0 才是真的不可用。 */
  it('★ 两池都为 0 ⇒ 不可用', async () => {
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      fetchBalance: async () => ({ daily: 0, longterm: 0, wallets: [] }),
    })
    expect(at).toBeLessThan(0) // UNUSABLE 是负数哨兵
  })

  /** ⚠️ 只读到 longterm 是正常状态（daily 当天用完）⇒ 必须可用。 */
  it('★ 只有 longterm 读得到 ⇒ 可用（不判死）', async () => {
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      fetchBalance: async () => ({ longterm: 500, wallets: [] }),
    })
    expect(at).toBeGreaterThan(0) // NEVER 是正无穷哨兵
  })

  /** ⚠️ 两池都读不到才判不可用。 */
  it('★ 两池都读不到 ⇒ 不可用（保守）', async () => {
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      fetchBalance: async () => ({ wallets: [] }),
    })
    expect(at).toBeLessThan(0)
  })

  it('无到期时刻 ⇒ 当长期（不编造日期）', async () => {
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      fetchBalance: async () => ({ daily: 200, wallets: [{ balance: 200 }] }),
    })
    // NEVER 是正无穷大哨兵。
    expect(at).toBeGreaterThan(Date.parse('2099-01-01'))
  })

  /** ⚠️ `null` 是「查询失败」，必须回落自取（折算不得依赖缓存）。 */
  it('cachedBalance 返回 null 时必须回落自取', async () => {
    const fetchBalance = vi.fn(async () => ({
      daily: 150,
      wallets: [{ balance: 150, validTo: '2026-11-23T00:00:00+08:00' }],
    }))
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      cachedBalance: async () => null,
      fetchBalance,
    })
    expect(fetchBalance).toHaveBeenCalledTimes(1)
    expect(at).toBe(Date.parse('2026-11-23T00:00:00+08:00'))
  })

  it('缓存命中且 total > 0 时不发请求', async () => {
    const fetchBalance = vi.fn(async () => ({ daily: 1, wallets: [] }))
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      cachedBalance: async () => ({
        total: 120,
        // ⚠️ 有「每日」包且 remaining > 0 ⇒ 用 dailyGrantExpiresAt 当可用终点。
        packages: [{ name: '每日额度（次日刷新）', remaining: 120 } as never],
        expiredTotal: 0,
        dailyGrantExpiresAt: Date.parse('2026-11-23T00:00:00+08:00'),
      }),
      fetchBalance,
    })
    expect(fetchBalance).not.toHaveBeenCalled()
    expect(at).toBe(Date.parse('2026-11-23T00:00:00+08:00'))
  })

  /**
   * ⚠️ **缓存里 daily 包为 0、只有长期包** ⇒ 必须用长期包的到期时刻，
   * 而不是 daily 的（daily 那个已经过期了）。
   */
  it('★ 缓存里只有长期包 ⇒ 用长期包的到期时刻', async () => {
    const fetchBalance = vi.fn(async () => ({ daily: 1, wallets: [] }))
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      cachedBalance: async () => ({
        total: 378,
        packages: [
          { name: '每日额度（次日刷新）', remaining: 0, expiredTime: '' } as never,
          { name: '长期额度（注册赠送）', remaining: 378, expiredTime: '2027-02-22T01:21:29+08:00' } as never,
        ],
        expiredTotal: 0,
        dailyGrantExpiresAt: Date.parse('2026-11-23T00:00:00+08:00'),
      }),
      fetchBalance,
    })
    expect(fetchBalance).not.toHaveBeenCalled()
    expect(at, '必须用长期包的到期，不是已过期的 daily').toBe(Date.parse('2027-02-22T01:21:29+08:00'))
  })

  it('中止错误必须原样上抛（不得折成 UNUSABLE）', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    await expect(qwenworkExpiry({
      accessToken: 't',
      now,
      cachedBalance: async () => { throw abort },
    })).rejects.toThrow('aborted')
  })
})

describe('fetchQwenworkBalanceDetailed：失败原因必须可区分', () => {
  const cred = { access_token: 'tok-1' }

  it('401 引导重新登录（其余码按上游原文）', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"errorCode":"INVALID_TOKEN"}', { status: 401 })) as unknown as typeof fetch
    const result = await fetchQwenworkBalanceDetailed(cred, QWENWORK_INTL, fetchImpl)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('重新登录')
  })

  it('缺 daily_credits 时报「读数格式变了」（不是账号问题）', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":{"monthly_credits":{"total_balance":0}}}', { status: 200 })) as unknown as typeof fetch
    const result = await fetchQwenworkBalanceDetailed(cred, QWENWORK_INTL, fetchImpl)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('读数格式变了')
  })

  /**
   * ⚠️ **三元组全 0 不是错误**：那是「临时邮箱没积分」的账号形态，
   * 上游正常回 200。必须正常返回 balance（total: 0），否则用户以为插件坏了。
   */
  it('★ 额度全 0 是正常结果，不是错误', async () => {
    const body = JSON.stringify({
      data: {
        daily_credits: { total_balance: 0 },
        monthly_credits: { total_balance: 0 },
        longterm_credits: { total_balance: 0 },
        active_wallets: { wallets: [] },
      },
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const result = await fetchQwenworkBalanceDetailed(cred, QWENWORK_INTL, fetchImpl)
    expect(result.error).toBeUndefined()
    expect(result.balance?.total).toBe(0)
  })

  it('正常响应装配出 total = daily + longterm', async () => {
    const body = JSON.stringify({
      data: {
        daily_credits: { total_balance: 199.8368 },
        monthly_credits: { total_balance: 0 },
        longterm_credits: { total_balance: 500 },
        active_wallets: { wallets: [
          { balance: 199.8368, valid_to: '2026-11-23T00:00:00+08:00' },
          { balance: 500, valid_to: '2027-02-22T01:21:29+08:00' },
        ] },
      },
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const result = await fetchQwenworkBalanceDetailed(cred, QWENWORK_INTL, fetchImpl)
    // ⚠️ 199.8368（daily）+ 500（longterm）= 699.8368
    expect(result.balance?.total).toBe(699.8368)
    expect(result.balance?.packages).toHaveLength(2)
  })

  it('不含 access_token 的凭据直接给原因，不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await fetchQwenworkBalanceDetailed({ access_token: '' }, QWENWORK_INTL, fetchImpl)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('access_token')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('RPC 的账号 id 派生', () => {
  /**
   * ⚠️⚠️ **前缀必须是 `QWENWORKINTL`（不带下划线）**：全仓约定是
   * `${provider.toUpperCase()}_ACCOUNT_`，而 `tests/unit/jet-hub-store.spec.ts`
   * 的恢复表用例**按这个约定生成 ref** ⇒ 写错会让那条用例红。
   */
  it('★ ref 前缀是 QWENWORKINTL_ACCOUNT_（符合全仓约定）', () => {
    const { id, refName } = qwenworkSlotNamesOf('32ecd704-65f4-4915-b8af-dc6a5e433d6a')
    expect(refName.startsWith('QWENWORKINTL_ACCOUNT_')).toBe(true)
    expect(refName).not.toContain('-') // 必须是合法标识符
    expect(refName).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    expect(id.startsWith('qwenworkintl-')).toBe(true)
  })

  /** ⚠️ id 由 user_id 派生而非 token 尾段：token 会轮换，id 不能跟着变。 */
  it('同一 user_id 恒得同一 id / ref（token 轮换不影响）', () => {
    const a = qwenworkSlotNamesOf('uid-stable-1')
    const b = qwenworkSlotNamesOf('uid-stable-1')
    expect(a).toEqual(b)
    expect(qwenworkSlotNamesOf('uid-other')).not.toEqual(a)
  })

  it('isQwenworkAccountRef 认自己、不认别人', () => {
    const { refName } = qwenworkSlotNamesOf('uid-1')
    expect(isQwenworkAccountRef(refName)).toBe(true)
    expect(isQwenworkAccountRef('QINIU_ACCOUNT_ABCD1234')).toBe(false)
    expect(isQwenworkAccountRef('QWENWORK_INTL_ACCOUNT_X')).toBe(false)
  })
})

describe('★★★ 倍率与徽标（用户报障：providers 列表也要显示倍率）', () => {
  const makeAdapter = () => new QwenworkAdapter({
    slots: async () => [{ id: 'x', accessToken: 'dummy' }],
    mintTicket: async () => ({ token: 't', baseUrl: 'https://api1.qwenwork.ai', expiresAtMs: Date.now() + 3600000 }),
  })

  /**
   * ★★★ **三处名称必须一致**（listAllModels / listModels / resolveModel）。
   *
   * ⚠️ 2026-11-22 用户报障「在 providers 的模型列表也展示倍率」——
   * 根因是 listAllModels() 用了**裸名**（m.name），而 listModels() 走
   * toCatalogEntry 带倍率 ⇒ 同一模型在设置页是「标准」、在选择器是「标准 · x0.1」。
   */
  it('★★★ listAllModels 的名字带倍率（不能是裸名）', () => {
    const models = makeAdapter().listAllModels()
    const flash = models.find((m) => m.id === 'flash')
    expect(flash?.name, '必须带倍率').toBe('标准 · x0.1')
    // ⚠️ 反向：绝不能是裸名。
    expect(flash?.name).not.toBe('标准')
    // 全部 11 条都必须带 x 后缀。
    for (const m of models) {
      expect(m.name, m.id + ' 必须带倍率').toMatch(/ · x[\d.]+$/)
    }
  })

  it('★★★ resolveModel 的名字也带倍率（与 listAllModels 同源）', async () => {
    const r = await makeAdapter().resolveModel('qwenworkintl', 'kimi-k3.1-pro')
    expect(r.name).toBe('Kimi-K3.1-Pro · x2.6')
  })

  it('★★★ 三处名称逐条相等（防再次分叉）', async () => {
    const a = makeAdapter()
    const all = a.listAllModels()
    for (const m of all) {
      const resolved = await a.resolveModel('qwenworkintl', m.id)
      expect(resolved.name, m.id + ' 的 resolveModel 名必须与 listAllModels 相同').toBe(m.name)
    }
  })

  /**
   * ★★ 徽标只在 listModels 上有渲染位置。
   *
   * 宿主 LlmModelInfo.badge 是唯一能画出「名字右侧胶囊」的字段；
   * LlmResolvedModelInfo（resolveModel 的回包）**不带 badge** ——
   * 宿主 normalizeModelInfo 逐字段白名单、明确丢弃它。
   */
  /**
   * ★★ **上游不下发任何促销 ⇒ 绝不编造「限时免费」**（本仓红线）。
   *
   * 实测 11 条 price_factor 最低 0.1、**没有一条为 0**，也没有
   * promotion/discount/promo 字段 ⇒ 做不出「限时免费」徽标。
   */
  it('★★ 所有模型都有非零倍率（上游无免费促销，不编造）', () => {
    for (const m of QWENWORK_INTL_FALLBACK_MODELS) {
      expect(m.priceFactor, m.id + ' 必须有倍率').toBeTypeOf('number')
      expect(m.priceFactor, m.id + ' 倍率非 0（上游无免费模型）').toBeGreaterThan(0)
    }
  })
})
describe('适配器契约', () => {
  const makeAdapter = (slots = [{ id: 'qwenworkintl', accessToken: 'tok' }]) =>
    new QwenworkAdapter({
      slots: async () => slots,
      mintTicket: async () => ({ token: 'maas', baseUrl: 'https://api1.qwenwork.ai', expiresAtMs: Date.now() + 3_600_000 }),
    })

  it('listAllModels 同步返回 11 条（绝不 async —— 消费者不 await）', () => {
    const adapter = makeAdapter()
    const models = adapter.listAllModels()
    expect(Array.isArray(models)).toBe(true)
    expect(models).toHaveLength(11)
  })

  it('resolveModel 对已知模型给出窗口 / 档位 / 模态', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('qwenworkintl', 'glm-5.3')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'max'])
    // ⚠️ glm-5.3 实测不收图。
    // ⚠️ 现在一律按支持图片处理（用户 2026-11-22 决定）。
    expect(resolved.inputModalities).toEqual(['text', 'image'])
  })

  it('支持图片的模型声明 text+image', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('qwenworkintl', 'qwen3.8-max')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
  })

  /**
   * ⚠️⚠️ **必须包 `prepareCall`**（本仓 PR !66 硬纪律）：只包 `stream` 会让宿主
   * 拿到未解析的 model 信息 ⇒ 上下文占用条不渲染、档位菜单不出现。
   */
  it('★ prepareCall 同时给出 model 与 stream', async () => {
    const adapter = makeAdapter()
    const prepared = await adapter.prepareCall('qwenworkintl', 'flash')
    expect(prepared.model.id).toBe('flash')
    expect(prepared.model.context?.contextWindow).toBe(1_000_000)
    expect(typeof prepared.stream).toBe('function')
  })

  it('没有槽位时抛 MISSING_CREDENTIAL 并给出登录入口与邮箱提示', async () => {
    const adapter = makeAdapter([])
    const stream = adapter.stream({ model: 'flash', messages: [] } as never)
    await expect(stream.next()).rejects.toThrow(/没有可用账号/)
    await expect(adapter.stream({ model: 'flash', messages: [] } as never).next())
      .rejects.toThrow(/临时邮箱/)
  })

  it('providerInfo 用产品展示名', () => {
    const adapter = makeAdapter()
    expect(adapter.providerInfo('qwenworkintl').name).toBe(QWENWORK_INTL.displayName)
  })
})
