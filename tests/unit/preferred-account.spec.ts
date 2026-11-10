/**
 * 「优先帐号」会话级偏好的行为级守卫（用户 2026-11-10 需求）。
 *
 * ## 它在守什么（三条不变量，逐条对应一个 describe）
 *
 * 1. **集合不变** —— 只重排，不增删。任何「顺手过滤掉点什么」的实现都会红。
 * 2. **同档内前移，绝不越档** —— 这是本功能最易写错的一条：
 *    若实现成「无条件提到第 0 位」，会让「只有永久积分」的号抢在
 *    「有临期积分」的号前面，与既有的临期优先设计直接冲突。
 * 3. **默认路径逐字节不变** —— `undefined` 时行为必须与改动前完全一致。
 *    这是本功能的**唯一回归面**：大量单测用结构化替身池，
 *    它们不认识 `preferredAccountFor`。
 *
 * ## ⚠️ 变异验证（本仓纪律，勿删）
 *
 * 下面每条注释里的「变异」都实测过必须变红；「无牙」的会如实登记。
 */
import { describe, expect, it } from 'vitest'
import { orderByPreferredAccount } from '../../src/account-pool.js'
import { applyPreferredAccount } from '../../src/credential-resolver.js'
import { rankBuddyAccountsByBalance } from '../../src/buddy-balance-rank.js'
import { prunePreferredAccounts, sanitizePreferredAccounts } from '../../src/jet-hub-store.js'

interface Row { id: string }

const A: Row = { id: 'a' }
const B: Row = { id: 'b' }
const C: Row = { id: 'c' }
const ids = (rows: readonly Row[]): string[] => rows.map((r) => r.id)

describe('orderByPreferredAccount —— 池选号（无余额分档的渠道）', () => {
  it('不选（undefined）⇒ 顺序与输入**逐字节相同**', () => {
    const out = orderByPreferredAccount([A, B, C], undefined)
    expect(ids(out)).toEqual(['a', 'b', 'c'])
    // 变异：把 `return copy` 改成 `return []` ⇒ 本条红。
  })

  it('空串按「不选」处理（与 undefined 同义）', () => {
    expect(ids(orderByPreferredAccount([A, B, C], ''))).toEqual(['a', 'b', 'c'])
  })

  it('★ 选最后一个 ⇒ 提到最前，其余相对顺序不变', () => {
    const out = orderByPreferredAccount([A, B, C], 'c')
    expect(ids(out)).toEqual(['c', 'a', 'b'])
    // 变异：改成 `sort` 按 id 排 ⇒ 本条红（会得到 a,b,c）。
  })

  it('★ 集合不变：只重排，不增删', () => {
    const input = [A, B, C]
    const out = orderByPreferredAccount(input, 'b')
    expect(out).toHaveLength(input.length)
    expect(new Set(ids(out))).toEqual(new Set(ids(input)))
    // 变异：实现里顺手加 `.filter(...)` ⇒ 本条红。
  })

  it('找不到该 id（已停用/删除）⇒ 原样，不报错也不换号', () => {
    const out = orderByPreferredAccount([A, B, C], 'zzz')
    expect(ids(out)).toEqual(['a', 'b', 'c'])
    // 变异：改成「找不到就取第一个」⇒ 本条不变（已有兜底），
    // 故本条**只挡「抛错」与「乱序」**，如实登记为弱牙。
  })

  it('已在首位 ⇒ 顺序不变（幂等）', () => {
    const out = orderByPreferredAccount([A, B, C], 'a')
    expect(ids(out)).toEqual(['a', 'b', 'c'])
  })

  it('返回新数组，不修改入参', () => {
    const input = [A, B, C]
    const out = orderByPreferredAccount(input, 'c')
    expect(input).toEqual([A, B, C])
    expect(out).not.toBe(input)
  })

  it('单元素候选不炸', () => {
    expect(ids(orderByPreferredAccount([A], 'a'))).toEqual(['a'])
  })

  it('空候选不炸', () => {
    expect(orderByPreferredAccount([], 'a')).toEqual([])
  })
})

describe('applyPreferredAccount —— 泛型版（供其他路径复用）', () => {
  it('无 tierOf ⇒ 等价于「提到最前」', () => {
    expect(ids(applyPreferredAccount([A, B, C], 'c'))).toEqual(['c', 'a', 'b'])
  })

  it('★ 有 tierOf ⇒ **只在同档内**前移，绝不越档', () => {
    // a/b 是档 1，c/d 是档 2。选 d ⇒ 只能在档 2 内前移。
    const rows = [
      { id: 'a', tier: 1 },
      { id: 'b', tier: 1 },
      { id: 'c', tier: 2 },
      { id: 'd', tier: 2 },
    ]
    const out = applyPreferredAccount(rows, 'd', (r) => r.tier)
    expect(ids(out)).toEqual(['a', 'b', 'd', 'c'])
    // ⚠️⚠️ 本条是**最关键的守卫**：
    // 变异「插入位置恒取 0」⇒ 得到 d,a,b,c ⇒ 红。
    // 变异「tierOf 恒返回常数」⇒ 所有档相同 ⇒ 退化成「提到最前」⇒ 红。
  })

  it('选档 2 的号，档 1 仍然全在它前面', () => {
    const rows = [
      { id: 'a', tier: 1 },
      { id: 'b', tier: 2 },
      { id: 'c', tier: 2 },
    ]
    const out = applyPreferredAccount(rows, 'c', (r) => r.tier)
    expect(ids(out)).toEqual(['a', 'c', 'b'])
  })

  it('找不到 / 已在档内首位 ⇒ 原样', () => {
    const rows = [
      { id: 'a', tier: 1 },
      { id: 'b', tier: 2 },
    ]
    expect(ids(applyPreferredAccount(rows, 'zzz', (r) => r.tier))).toEqual(['a', 'b'])
    expect(ids(applyPreferredAccount(rows, 'b', (r) => r.tier))).toEqual(['a', 'b'])
  })

  it('未选 ⇒ 原样', () => {
    const rows = [{ id: 'a', tier: 1 }, { id: 'b', tier: 2 }]
    expect(ids(applyPreferredAccount(rows, undefined, (r) => r.tier))).toEqual(['a', 'b'])
  })
})

describe('rankBuddyAccountsByBalance 的 preferredAccountId', () => {
  const mk = (id: string, expiring: number, permanent: number) => ({
    id,
    expiringBalance: expiring,
    permanentBalance: permanent,
  })

  it('不传 preferredAccountId ⇒ 与既有排序**逐字节相同**（回归面）', () => {
    const accounts = [mk('perm', 0, 100), mk('exp', 50, 0), mk('zero', 0, 0)]
    const out = rankBuddyAccountsByBalance(accounts, { allowPermanent: true })
    // 档 1（exp）→ 档 2（perm）→ 档 3（zero）
    expect(out.map((a) => a.id)).toEqual(['exp', 'perm', 'zero'])
  })

  it('★ 选档 3 的号 ⇒ 它**留在档 3**，不会跑到档 1 前面', () => {
    const accounts = [mk('exp1', 50, 0), mk('exp2', 30, 0), mk('perm', 0, 100), mk('zero', 0, 0)]
    const out = rankBuddyAccountsByBalance(accounts, { allowPermanent: true, preferredAccountId: 'zero' })
    // zero 已是档 3 唯一成员 ⇒ 位置不变
    expect(out.map((a) => a.id)).toEqual(['exp1', 'exp2', 'perm', 'zero'])
    // 变异「插入位置恒 0」⇒ zero 跑到第一 ⇒ 红。
  })

  it('★ 选档 2 的号 ⇒ 提到档 2 最前，但档 1 仍全在它前面', () => {
    const accounts = [mk('exp1', 50, 0), mk('perm1', 0, 100), mk('perm2', 0, 200)]
    const out = rankBuddyAccountsByBalance(accounts, { allowPermanent: true, preferredAccountId: 'perm2' })
    expect(out.map((a) => a.id)).toEqual(['exp1', 'perm2', 'perm1'])
  })

  it('锁定永久积分时，只剩永久的号属 none 档 ⇒ 选了也排在最后', () => {
    const accounts = [mk('exp', 50, 0), mk('perm', 0, 100)]
    const out = rankBuddyAccountsByBalance(accounts, { allowPermanent: false, preferredAccountId: 'perm' })
    // 锁定后 perm 的档位是 none(3)，exp 是 1 ⇒ 仍 exp 在前
    expect(out.map((a) => a.id)).toEqual(['exp', 'perm'])
  })

  it('找不到 ⇒ 原样', () => {
    const accounts = [mk('exp', 50, 0), mk('perm', 0, 100)]
    const withPref = rankBuddyAccountsByBalance(accounts, { allowPermanent: true, preferredAccountId: 'zzz' })
    const without = rankBuddyAccountsByBalance(accounts, { allowPermanent: true })
    expect(withPref.map((a) => a.id)).toEqual(without.map((a) => a.id))
  })
})

describe('sanitizePreferredAccounts —— 读写两侧的唯一判据', () => {
  const at = 1_700_000_000_000

  it('合法输入原样保留', () => {
    const raw = { workbuddy: { 's1': { accountId: 'a1', at } } }
    expect(sanitizePreferredAccounts(raw)).toEqual(raw)
  })

  it('非对象 / 数组 / null ⇒ 空表', () => {
    for (const bad of [undefined, null, 42, 'x', [], [1, 2]]) {
      expect(sanitizePreferredAccounts(bad)).toEqual({})
    }
  })

  it('provider / sessionId 为空串 ⇒ 丢弃', () => {
    expect(sanitizePreferredAccounts({ '': { s: { accountId: 'a', at } } })).toEqual({})
    expect(sanitizePreferredAccounts({ p: { '': { accountId: 'a', at } } })).toEqual({})
  })

  it('accountId 缺失 / 空串 / 非字符串 ⇒ 丢弃该条', () => {
    for (const bad of [undefined, '', 42, null, {}]) {
      const out = sanitizePreferredAccounts({ p: { s: { accountId: bad, at } } })
      expect(out).toEqual({})
    }
  })

  it('at 缺失 / 非有限数 / 负数 ⇒ 丢弃该条（否则无法淘汰）', () => {
    for (const bad of [undefined, 'x', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const out = sanitizePreferredAccounts({ p: { s: { accountId: 'a', at: bad } } })
      expect(out).toEqual({})
    }
  })

  it('清理后为空 ⇒ **连 provider 层一起丢**（不留空对象）', () => {
    expect(sanitizePreferredAccounts({ p: { s: { accountId: '', at } } })).toEqual({})
  })

  it('★ 超过上限 ⇒ 按 at 保留最近的', () => {
    const sessions: Record<string, { accountId: string; at: number }> = {}
    for (let i = 0; i < 70; i += 1) sessions[`s${i}`] = { accountId: `a${i}`, at: at + i }
    const out = sanitizePreferredAccounts({ p: sessions })
    const kept = Object.keys(out.p ?? {})
    expect(kept).toHaveLength(64)
    // 最旧的 s0..s5 被淘汰
    expect(kept).not.toContain('s0')
    expect(kept).toContain('s69')
  })
})

describe('prunePreferredAccounts —— 淘汰（纯函数）', () => {
  const at = 1_000

  it('未超上限 ⇒ 原样', () => {
    const s = { a: { accountId: 'x', at } }
    expect(prunePreferredAccounts(s, 5)).toEqual(s)
  })

  it('超上限 ⇒ 保留 at 最大的 N 个', () => {
    const s: Record<string, { accountId: string; at: number }> = {}
    for (let i = 0; i < 5; i += 1) s[`s${i}`] = { accountId: 'a', at: at + i }
    const out = prunePreferredAccounts(s, 2)
    expect(Object.keys(out)).toEqual(['s3', 's4'])
  })

  it('limit 非正 ⇒ 空（确定性结果，不是「全留」）', () => {
    const s = { a: { accountId: 'x', at } }
    expect(prunePreferredAccounts(s, 0)).toEqual({})
    expect(prunePreferredAccounts(s, -1)).toEqual({})
  })
})
