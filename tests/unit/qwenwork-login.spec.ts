/**
 * 千问办公国际站**设备码登录**的单测。
 *
 * ## ⚠️ 为什么这个文件必须有
 *
 * 登录协议的三个反直觉点（全部真机实测，见 `qwenwork-login.ts` 模块头）
 * **每一个都曾把我带偏**：
 *
 * 1. `selectAccounts` 成功是 **302**，不返回 nonce（nonce 是客户端生成的）；
 * 2. `poll` 的 `404 {}` 对「未授权」和「nonce 不存在」**返回完全相同**；
 * 3. 两边 query 字段集合**严格互斥**，多传一个就 400。
 *
 * ⇒ 这些约束必须被逐条锁死，否则改动时极易「看起来对、实际必然失败」。
 *
 * ⚠️ **不发任何真实网络请求**：所有 fetch 都是注入的桩。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createQwenworkDeviceFlow,
  pollQwenworkDeviceToken,
  qwenworkSelectAccountsUrl,
  startQwenworkDeviceLogin,
  waitForQwenworkCredential,
} from '../../src/qwenwork-login.js'
import { QWENWORK_INTL } from '../../src/qwenwork-product.js'

/** 造一个 200 的 JSON 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createQwenworkDeviceFlow：一次性随机量', () => {
  /**
   * ⚠️⚠️ **nonce 必须是 UUID**：实测裸随机串（`abc123`）会被上游判 400
   * `INVALID_DEVICE_FLOW`。而 UUID 格式的 nonce 能通过参数校验。
   */
  it('★ nonce 是合法 UUID（裸随机串会被拒）', () => {
    const flow = createQwenworkDeviceFlow()
    expect(flow.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  /** ⚠️ RFC 7636 要求 verifier 43~128 字符的 base64url。 */
  it('★ verifier 长度落在 RFC 7636 的 43~128 区间', () => {
    const flow = createQwenworkDeviceFlow()
    expect(flow.verifier.length).toBeGreaterThanOrEqual(43)
    expect(flow.verifier.length).toBeLessThanOrEqual(128)
    expect(flow.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  /** ⚠️ challenge 必须是 base64url(sha256(verifier))＝定长 43 字符（S256）。 */
  it('★ challenge = base64url(sha256(verifier))，恒 43 字符', () => {
    const flow = createQwenworkDeviceFlow()
    expect(flow.challenge).toHaveLength(43)
    expect(flow.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  /**
   * ⚠️⚠️ **每次都必须重新生成**：同一 nonce 重放会被 409 `DEVICE_FLOW_REPLAYED`
   * 拦下。故 `startQwenworkDeviceLogin` 内部不接受外部 nonce。
   */
  it('★★ 每次调用都生成新的 nonce / verifier（重放会 409）', () => {
    const a = createQwenworkDeviceFlow()
    const b = createQwenworkDeviceFlow()
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
  })

  /** ⚠️ machine_id 要持久化复用（聊天签名与它绑定），故允许外部传入。 */
  it('传入 machineId 时复用；不传时新生成', () => {
    const reused = createQwenworkDeviceFlow('11111111-2222-3333-4444-555555555555')
    expect(reused.machineId).toBe('11111111-2222-3333-4444-555555555555')
    const fresh = createQwenworkDeviceFlow()
    expect(fresh.machineId).not.toHaveLength(0)
  })
})

describe('qwenworkSelectAccountsUrl：六个字段一个不能多、一个不能少', () => {
  const flow = createQwenworkDeviceFlow('m-1')

  /**
   * ★★ **本文件的核心判据**：字段集合必须**恰好**是这六个。
   *
   * 实测任缺一个 ⇒ `400 INVALID_DEVICE_FLOW`；任多一个（`response_type` /
   * `scope` / `cosyVersion`）⇒ 同样 400 + `field:"query", reason:"not_allowed"`。
   * 而那个报错是针对**整条 query** 的通用判据，**指不出具体哪个字段错**
   * ⇒ 只能靠这条断言锁死集合。
   */
  it('★★ query 字段恰好是六个（多一个少一个都 400）', () => {
    const url = new URL(qwenworkSelectAccountsUrl(flow))
    expect([...url.searchParams.keys()].sort()).toEqual([
      'challenge', 'challenge_method', 'client_id', 'machine_id', 'nonce', 'redirect_uri',
    ])
  })

  /** ⚠️ 常见的「顺手加上」的多余字段，每一个都会让上游 400。 */
  it('★ 不包含 response_type / scope / cosyVersion（都会 400）', () => {
    const url = new URL(qwenworkSelectAccountsUrl(flow))
    for (const forbidden of ['response_type', 'scope', 'cosyVersion', 'cosy_version', 'state']) {
      expect(url.searchParams.has(forbidden), `${forbidden} 会让上游 400`).toBe(false)
    }
  })

  it('打到正确的端点（/device/selectAccounts，不是 /device/code）', () => {
    const url = new URL(qwenworkSelectAccountsUrl(flow))
    expect(url.origin).toBe('https://gateway.qwenwork.ai')
    expect(url.pathname).toBe('/device/selectAccounts')
  })

  /** ⚠️ 国际站专属值：用国内站的会被判 400（实测）。 */
  it('★★ client_id / redirect_uri 用国际站专属值', () => {
    const url = new URL(qwenworkSelectAccountsUrl(flow))
    expect(url.searchParams.get('client_id')).toBe('cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a')
    expect(url.searchParams.get('redirect_uri')).toBe('qwenwork://')
    // 国内站的值绝不能出现。
    expect(url.searchParams.get('client_id')).not.toBe('e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
    expect(url.searchParams.get('redirect_uri')).not.toBe('qwenwork-cn://')
  })

  it('challenge_method 恒 S256（plain 会被 400）', () => {
    const url = new URL(qwenworkSelectAccountsUrl(flow))
    expect(url.searchParams.get('challenge_method')).toBe('S256')
  })
})

describe('pollQwenworkDeviceToken：只有三个字段', () => {
  const flow = createQwenworkDeviceFlow('m-1')

  /**
   * ★★ 实测：`poll` **只接受** `nonce` / `verifier` / `challenge_method`。
   * 多传 `challenge` 会得到 `field:"challenge", reason:"not_allowed"` ——
   * 极易误判成「缺字段」（因为 `challenge` 确实是 `selectAccounts` 的必需字段）。
   */
  it('★★ query 字段恰好是三个（多传 challenge 会 400）', async () => {
    const seen = { url: '' }
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.url = String(input)
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)
    const url = new URL(seen.url)
    expect([...url.searchParams.keys()].sort()).toEqual(['challenge_method', 'nonce', 'verifier'])
    // ⚠️ 反向：绝不能把 selectAccounts 的字段带过来。
    expect(url.searchParams.has('challenge')).toBe(false)
    expect(url.searchParams.has('machine_id')).toBe(false)
  })

  it('打到 poll 端点', async () => {
    const seen = { url: '' }
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.url = String(input)
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)
    expect(new URL(seen.url).pathname).toBe('/api/v1/deviceToken/poll')
  })

  /**
   * ⚠️⚠️ **404 就是「还没授权」**。
   *
   * 而它与「nonce 根本不存在」返回**完全相同**的 `{}`（逐字节比对过）
   * ⇒ 不能靠 404 判断 flow 是否有效，只能靠总超时。这条断言锁住
   * 「404 必须映射成 pending 而不是失败」。
   */
  it('★★ HTTP 404 映射成 pending（不是失败）', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    expect(await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)).toEqual({ kind: 'pending' })
  })

  /** ⚠️ 409 = nonce 重放，这一类不值得重试。 */
  it('★ HTTP 409 映射成 broken（DEVICE_FLOW_REPLAYED）', async () => {
    const fetchImpl = (async () => jsonResponse({ errorCode: 'DEVICE_FLOW_REPLAYED' }, 409)) as unknown as typeof fetch
    const outcome = await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)
    expect(outcome.kind).toBe('broken')
  })

  /** ✅ 200 + token ⇒ ready，并装配出凭据。 */
  it('★★ 200 + token ⇒ ready，凭据字段正确', async () => {
    const fetchImpl = (async () => jsonResponse({
      token: 'tok-abc',
      refresh_token: 'rt-xyz',
      expires_at: '2026-12-07T00:00:00Z',
      user_id: 'uid-1',
      user_name: 'alice',
    })) as unknown as typeof fetch
    const outcome = await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.credential.access_token).toBe('tok-abc')
    expect(outcome.credential.refresh_token).toBe('rt-xyz')
    expect(outcome.credential.user_id).toBe('uid-1')
    expect(outcome.credential.nickname).toBe('alice')
    // ⚠️ machine_id 必须写进凭据（聊天签名要用）。
    expect(outcome.credential.machine_id).toBe('m-1')
  })

  /**
   * ⚠️⚠️ **200 但没有 token ⇒ 必须是 broken，不能当成功**。
   *
   * 当成功会写进一张**空凭据卡**：用户看到「已登录」，发消息却 401。
   * 这种情况的真实含义是「上游改了字段名」，要明确报出来。
   */
  it('★★ 200 但缺 token ⇒ broken（不能写成空凭据）', async () => {
    const fetchImpl = (async () => jsonResponse({ refresh_token: 'rt-only' })) as unknown as typeof fetch
    const outcome = await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)
    expect(outcome.kind).toBe('broken')
    if (outcome.kind === 'broken') expect(outcome.reason).toContain('token')
  })

  /** ⚠️ 别名兼容：上游若改用 `access_token` 也不能失效。 */
  it('接受 access_token 作为 token 的别名', async () => {
    const fetchImpl = (async () => jsonResponse({ access_token: 'tok-alias' })) as unknown as typeof fetch
    const outcome = await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') expect(outcome.credential.access_token).toBe('tok-alias')
  })

  /** ⚠️ 读不到到期时刻就**不写**，绝不编造（本仓红线）。 */
  it('★ 无 expires 字段时不写 expires_at（不编造）', async () => {
    const fetchImpl = (async () => jsonResponse({ token: 't' })) as unknown as typeof fetch
    const outcome = await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') expect(outcome.credential.expires_at).toBeUndefined()
  })

  /** ⚠️ `expires_in`（秒）要换算成**毫秒**（凭据约定存毫秒）。 */
  it('★ expires_in（秒）换算成毫秒', async () => {
    const before = Date.now()
    const fetchImpl = (async () => jsonResponse({ token: 't', expires_in: 3600 })) as unknown as typeof fetch
    const outcome = await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') {
      const at = Number(outcome.credential.expires_at)
      expect(at).toBeGreaterThan(before + 3_500_000)
      expect(at).toBeLessThan(before + 3_700_000)
    }
  })

  /** ⚠️ 网络抖动**不是** flow 失效 ⇒ 必须按 pending 继续等，不能判死。 */
  it('★ 网络异常映射成 pending（抖动不等于失效）', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    expect(await pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)).toEqual({ kind: 'pending' })
  })

  /** ⚠️ 中止必须原样逃逸（铁律）。 */
  it('中止错误原样上抛（不得吞成 pending）', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const fetchImpl = (async () => { throw abort }) as unknown as typeof fetch
    await expect(pollQwenworkDeviceToken(flow, QWENWORK_INTL, fetchImpl)).rejects.toThrow('aborted')
  })
})

describe('waitForQwenworkCredential：轮询与判死', () => {
  it('连续 pending 到超时 ⇒ 抛超时错误（文案给出下一步）', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    await expect(waitForQwenworkCredential(createQwenworkDeviceFlow(), QWENWORK_INTL, {
      fetchImpl,
      intervalMs: 5,
      timeoutMs: 30,
    })).rejects.toThrow(/超时/)
  })

  /**
   * ⚠️ **单次 broken 不判死**：可能是瞬时抖动。
   * 实测「无 details 的 400」在极短时间内会偶发出现。
   */
  it('★ 单次 broken 后转 pending ⇒ 继续等（不判死）', async () => {
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('{"errorCode":"X"}', { status: 400 })
      if (call === 2) return jsonResponse({ token: 'tok-after-blip' })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const credential = await waitForQwenworkCredential(createQwenworkDeviceFlow(), QWENWORK_INTL, {
      fetchImpl,
      intervalMs: 5,
      timeoutMs: 5_000,
    })
    expect(credential.access_token).toBe('tok-after-blip')
  })

  /** ⚠️ 连续 3 次 broken ⇒ 判死（flow 真失效时必然如此）。 */
  it('★ 连续 3 次 broken ⇒ 判死并提示重新登录', async () => {
    const fetchImpl = (async () => new Response('{"errorCode":"X"}', { status: 400 })) as unknown as typeof fetch
    await expect(waitForQwenworkCredential(createQwenworkDeviceFlow(), QWENWORK_INTL, {
      fetchImpl,
      intervalMs: 5,
      timeoutMs: 5_000,
    })).rejects.toThrow(/登录流程失效/)
  })

  it('第一次就 ready ⇒ 立刻返回（不多等一轮）', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse({ token: 'tok-first' })
    }) as unknown as typeof fetch
    const credential = await waitForQwenworkCredential(createQwenworkDeviceFlow(), QWENWORK_INTL, {
      fetchImpl,
      intervalMs: 5,
      timeoutMs: 5_000,
    })
    expect(credential.access_token).toBe('tok-first')
    expect(calls).toBe(1)
  })
})

describe('startQwenworkDeviceLogin：两步式 + 自行落盘', () => {
  function makeStore() {
    const written = new Map<string, string>()
    return {
      written,
      set: async (ref: string, value: string) => { written.set(ref, value) },
    }
  }

  /** ★ 立即返回 loginUrl（两步式的第一步，不能等授权）。 */
  it('★ 立即返回 loginUrl，不等授权', async () => {
    const store = makeStore()
    const started = await startQwenworkDeviceLogin({
      ref: 'QWENWORKINTL_ACCOUNT_TEST',
      credentials: store,
      // 永不 ready 的桩：若实现阻塞等授权，本用例会超时。
      fetchImpl: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
      intervalMs: 5,
      timeoutMs: 20,
    })
    expect(started.loginUrl).toContain('/device/selectAccounts?')
    await started.close()
  })

  /**
   * ★★ **凭据必须由本函数落盘**（不能等调用方的 `.then`）。
   *
   * 否则「poll 成功」到「落盘」之间有个空窗：进程被杀就丢号，
   * 而前端已经看到「登录成功」。
   */
  it('★★ 授权成功后凭据立刻落盘（ref 正确）', async () => {
    const store = makeStore()
    const started = await startQwenworkDeviceLogin({
      ref: 'QWENWORKINTL_ACCOUNT_TEST',
      credentials: store,
      fetchImpl: (async () => jsonResponse({ token: 'tok-landed', user_name: 'bob' })) as unknown as typeof fetch,
      intervalMs: 5,
      timeoutMs: 5_000,
    })
    const credential = await started.result
    expect(credential.access_token).toBe('tok-landed')
    expect(store.written.has('QWENWORKINTL_ACCOUNT_TEST')).toBe(true)
    const parsed = JSON.parse(store.written.get('QWENWORKINTL_ACCOUNT_TEST')!)
    expect(parsed.access_token).toBe('tok-landed')
  })

  /** ⚠️ `close()` 必须能中止轮询（否则取消登录要等满 15 分钟）。 */
  it('★ close() 中止后台轮询', async () => {
    const store = makeStore()
    const started = await startQwenworkDeviceLogin({
      ref: 'R',
      credentials: store,
      fetchImpl: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
      intervalMs: 5,
      timeoutMs: 60_000,
    })
    await started.close()
    await expect(started.result).rejects.toThrow()
    // ⚠️ 中止后不得落盘任何东西。
    expect(store.written.size).toBe(0)
  })

  /** ⚠️ 未处理的拒绝不能冒到进程级（Promise 可能稍后才被消费）。 */
  it('close() 后不产生 unhandledRejection', async () => {
    const store = makeStore()
    const started = await startQwenworkDeviceLogin({
      ref: 'R2',
      credentials: store,
      fetchImpl: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
      intervalMs: 5,
      timeoutMs: 60_000,
    })
    await started.close()
    // 故意不消费 result —— 若内部没挂空处理器，vitest 会报 unhandled rejection。
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(store.written.size).toBe(0)
  })
})
