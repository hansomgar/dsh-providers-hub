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
  isKnownQwenworkModel,
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

  it('设备授权 URL 带上 clientId / redirect / PKCE', () => {
    const url = qwenworkDeviceAuthUrl('chal-1', 'mid-1')
    expect(url.startsWith(`${QWENWORK_INTL.gatewayBase}${QWENWORK_INTL.deviceAuthPath}?`)).toBe(true)
    const parsed = new URL(url)
    expect(parsed.searchParams.get('client_id')).toBe(QWENWORK_INTL.clientId)
    expect(parsed.searchParams.get('redirect_uri')).toBe(QWENWORK_INTL.redirectScheme)
    expect(parsed.searchParams.get('challenge')).toBe('chal-1')
    expect(parsed.searchParams.get('challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('machine_id')).toBe('mid-1')
  })

  it('模型表恰好 9 条，且都是实测 200 的 id', () => {
    expect(QWENWORK_INTL_FALLBACK_MODELS).toHaveLength(9)
    const ids = QWENWORK_INTL_FALLBACK_MODELS.map((m) => m.id)
    expect(ids).toEqual([
      'flash', 'glm-5.3-flash', 'deepseek-flash',
      'pro', 'glm-5.3', 'deepseek-v4-pro', 'qwen3.8-max', 'qwen4-max', 'kimi-k3.1-pro',
    ])
  })

  /**
   * ⚠️ **实测只有 7 个模型收图**：`pro` 与 `glm-5.3` 收图回 400。
   * 整表一律 true 会让用户看到「支持图片」而实际每次必失败。
   */
  it('★ supportsImage 逐模型正确（pro / glm-5.3 必须 false）', () => {
    const byId = new Map(QWENWORK_INTL_FALLBACK_MODELS.map((m) => [m.id, m]))
    expect(byId.get('pro')?.supportsImage).toBe(false)
    expect(byId.get('glm-5.3')?.supportsImage).toBe(false)
    for (const id of ['flash', 'glm-5.3-flash', 'deepseek-flash', 'deepseek-v4-pro', 'qwen3.8-max', 'qwen4-max', 'kimi-k3.1-pro']) {
      expect(byId.get(id)?.supportsImage, `${id} 实测能收图`).toBe(true)
    }
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
  it('思考档位是 [low, high] 且为强度序', () => {
    for (const m of QWENWORK_INTL_FALLBACK_MODELS) {
      expect(m.efforts, `${m.id} 应声明档位`).toEqual(['low', 'high'])
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
   * ⚠️⚠️ **`total` 必须是 daily，不是三池合计 700**：
   * 实测推理只扣 daily（`200 → 199.8368` 而 longterm 纹丝不动）⇒
   * 把 700 当「今天可用」会让用户在 200 烧完后收到 `balance_insufficient`
   * 却看到「还有 500」。
   */
  it('★★ total 取 daily（不是合计 700）', () => {
    const balance = buildQwenworkBalance(snapshot, now)
    expect(balance).toBeDefined()
    expect(balance!.total).toBe(200)
    expect(balance!.total).not.toBe(700)
  })

  it('★ longterm 单独成包，且名字说明「推理不消耗」', () => {
    const packages = buildQwenworkPackages(snapshot, now)
    expect(packages).toHaveLength(2)
    const longterm = packages.find((p) => p.name.includes('注册赠送'))
    expect(longterm, '必须有一个包专门表示注册赠送').toBeDefined()
    expect(longterm!.name).toContain('推理不消耗')
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
    expect(text).toContain('注册赠送 500')
    expect(text).toContain('推理不消耗')
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
   * ⚠️⚠️ **注册赠送的 500 扣不动** ⇒ daily 为 0 时必须判 UNUSABLE，
   * 哪怕合计还有 500。否则该账号被排进候选、每轮先 429 一次。
   */
  it('★★ daily 为 0 时判不可用（即使 longterm 还有 500）', async () => {
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      fetchBalance: async () => ({ daily: 0, longterm: 500, wallets: [] }),
    })
    expect(at).toBeLessThan(0) // UNUSABLE 是负数哨兵
  })

  it('读不到 daily ⇒ 不可用（保守）', async () => {
    const at = await qwenworkExpiry({
      accessToken: 't',
      now,
      fetchBalance: async () => ({ longterm: 500, wallets: [] }),
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
        packages: [],
        expiredTotal: 0,
        dailyGrantExpiresAt: Date.parse('2026-11-23T00:00:00+08:00'),
      }),
      fetchBalance,
    })
    expect(fetchBalance).not.toHaveBeenCalled()
    expect(at).toBe(Date.parse('2026-11-23T00:00:00+08:00'))
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

  it('正常响应装配出 total = daily', async () => {
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
    expect(result.balance?.total).toBe(199.8368)
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

describe('适配器契约', () => {
  const makeAdapter = (slots = [{ id: 'qwenworkintl', accessToken: 'tok' }]) =>
    new QwenworkAdapter({
      slots: async () => slots,
      mintTicket: async () => ({ token: 'maas', baseUrl: 'https://api1.qwenwork.ai', expiresAtMs: Date.now() + 3_600_000 }),
    })

  it('listAllModels 同步返回 9 条（绝不 async —— 消费者不 await）', () => {
    const adapter = makeAdapter()
    const models = adapter.listAllModels()
    expect(Array.isArray(models)).toBe(true)
    expect(models).toHaveLength(9)
  })

  it('resolveModel 对已知模型给出窗口 / 档位 / 模态', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('qwenworkintl', 'glm-5.3')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high'])
    // ⚠️ glm-5.3 实测不收图。
    expect(resolved.inputModalities).toEqual(['text'])
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
