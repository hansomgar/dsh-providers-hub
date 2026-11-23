/**
 * 千问办公国际站（`qwenworkintl`）的**余额分档选号 + 「锁定长期积分」执行路径**。
 *
 * ## ⚠️⚠️ 为什么需要这个文件（而不是只加 `permanentLock: true`）
 *
 * `provider-registry.ts` 的 `permanentLock: true` **只做两件事**：
 * ① 让面板渲染出开关；② 让 `credits.permanentLock` RPC 接受写入。
 * **它不执行任何拦截** —— 用户点了锁定，凭据照旧烧长期积分，且没有任何用例会红。
 *
 * 这是本仓记录过的缺陷形态（Gitee IKLTHB ①，officeace 的原始问题），
 * 守卫 `tests/unit/permanent-lock-execution.spec.ts` 会**点名**「声明了
 * `permanentLock: true` 却没有任何执行路径」。
 *
 * ## 「永久」在本家的准确含义（用户 2026-11-22 澄清）
 *
 * > 「这个按钮不是真的指只锁定永久，它是指锁定**超过环境变量长期或档次窗口**
 * >   指定的长期及以上档次积分」
 *
 * ⇒ 与 `buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` **同一语义**：
 *
 * | 档位 | 判据 | 本家对应 |
 * |---|---|---|
 * | `expiring`（临期） | 到期 < `imminentDays` | 通常为空（daily 是次日 00:00，一般落「短期」）|
 * | `shortTerm`（短期） | `imminentDays` ≤ 到期 < `windowDays` | **daily 额度**（次日 00:00）|
 * | `permanent`（永久） | 到期 ≥ `windowDays`，**或没有到期时间** | **longterm 额度**（三个月后）|
 *
 * ⇒ 锁定后 `allowPermanent: false` ⇒ **longterm 那一档被排除** ⇒ 选号阶段只挑
 * daily 还有余额的账号。这正是用户要的「优先用每天刷新的 200，先别动注册送的 500」。
 *
 * ## ⚠️ 本文件**复用** `BuddyBalanceSelector`，不另写一套
 *
 * 那个类已经是**泛型**的（`<TProduct, TCredential>`），非 buddy provider
 * 只需注入 `fetchBalance` / `fetchBalanceDetailed` 与 `readCreditWindow`。
 * 参考实现：`index.ts` 的 `magicrewBalanceSelector`（同样是非 buddy 系）。
 *
 * ⚠️ **绝不**在本文件重写分档逻辑 —— 那会让「同一语义两套判据」（本仓红线）。
 *
 * @module src/qwenwork-lock.ts
 */

import type { BuddyNoAccountReason } from './buddy-balance-selector.js'
import type { CreditBalance } from './credits.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { QwenworkCredential } from './qwenwork.js'
import { fetchQwenworkBalanceDetailed } from './qwenwork-credits.js'
import { QWENWORK_INTL, type QwenworkProduct } from './qwenwork-product.js'

/**
 * 把本家的余额读成 `CreditBalance`（供 `BuddyBalanceSelector` 分档）。
 *
 * ⚠️ 返回 `null` 表示「查不到」—— 那是 `fetchBalance` 的契约
 * （`undefined` 会被当成类型错误，而抛错会让整条渠道消失）。
 *
 * ⚠️ **用详细变体转接**：`fetchQwenworkBalanceDetailed` 能区分 401 / 格式变化 /
 * 网络异常，而锁定态的报错文案正是靠这个区分才不会把用户引去重登。
 */
export async function fetchQwenworkBalanceForLock(
  credential: QwenworkCredential,
  product: QwenworkProduct = QWENWORK_INTL,
  fetcher?: typeof fetch,
): Promise<CreditBalance | null> {
  const result = await fetchQwenworkBalanceDetailed(
    credential,
    product,
    fetcher ?? globalThis.fetch,
  )
  return result.balance
}

/**
 * 锁定态「没有可用账号」时的报错文案。
 *
 * ## ⚠️ 文案纪律（照抄 `magicrewLockedError` 的三段结构）
 *
 * 必须说清、顺序不许乱：**留什么 → 烧什么 → 烧完怎样**。
 * 且**按 `reason.kind` 分流** —— 把「网络抖动」与「钱真花完了」混成一句，
 * 用户会去解锁或白等到明天，而号其实有钱（`BuddyNoAccountReason` 的四分法
 * 就是为此存在的）。
 *
 * @param displayName 展示名（错误文案用）。
 * @param windowDays  当前生效的窗口天数（**必须与实际筛号同源**，
 *                     否则用户看到「只烧 15 天内的」而实际按 31 天筛）。
 *
 * ⚠️ **刻意不收 `providerId`**（2026-11-23 二轮审计修，⚪B-12）：
 * 原签名有它、注释写「查 per-provider 窗口用」，但函数体内**一次未引用**
 * —— 窗口天数已由调用方用 `resolveCreditWindow(providerId, reader)` 算好传入。
 * 留一个不用形参只会让后人以为「这里面有窗口逻辑」，去别处找不到而困惑。
 */
export function qwenworkLockedError(
  displayName: string,
  windowDays: number,
): (reason: BuddyNoAccountReason) => Error {
  return (reason: BuddyNoAccountReason): Error => {
    /**
     * ⚠️ **四态必须分开报**（`BuddyNoAccountReason` 的四分法就是为此存在的）。
     * 混成一句「额度都已用尽」会让：网络抖动 → 用户去解锁（**不可撤回地烧长期积分**）；
     * 凭据坏 → 用户去解锁；被限流 → 用户去解锁。
     */
    switch (reason.kind) {
      case 'unknown':
        // 余额查不到：可能是网络抖动、上游 5xx、凭据失效 —— 都**不是**「钱花完了」。
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定长期积分，而本次余额查询未全部完成`
          + `（${formatLockReasonErrors(reason.errors)}）。这些账号**可能仍有**`
          + `「${windowDays} 天内到期」的额度 —— 请稍后重试。`,
          'AUTH',
        )
      case 'no-candidates':
        // 一个候选都没有：多半是全部账号被目标模型限流或被停用，**不是**积分问题。
        return new LlmError(
          `${displayName}：没有可用账号（全部被停用，或被当前模型限流）。`
          + '这与积分无关 —— 请检查账号状态或等限流解除。',
          'RATE_LIMIT',
        )
      case 'credential-only':
        // 查到了有钱、但凭据解析失败 ⇒ **恰恰不能**说「积分用尽」。
        return new LlmError(
          `${displayName}：余额显示仍有「${windowDays} 天内到期」的额度，但账号凭据不可用。`
          + '请在 Jet Hub 面板重新登录该账号（这不是积分问题，也不是锁定造成的）。',
          'AUTH',
        )
      case 'exhausted':
      default:
        // 确实查得到、且窗口内的额度都用完了。
        return new LlmError(
          `${displayName}：已锁定长期积分 —— 长期积分留着不动，只消耗「${windowDays} 天内到期」`
          + '的额度。当前**所有账号**的这类额度都已用尽（长期积分仍在，解锁后即可继续使用）。',
          'QUOTA_EXCEEDED',
        )
    }
  }
}

/** 把错误字符串列表压成一句可读文本。 */
function formatLockReasonErrors(errors: readonly string[]): string {
  if (errors.length === 0) return '无详情'
  return errors.slice(0, 3).join('；')
}
