/**
 * 千问办公国际站（QwenWork Intl）的 RPC 处理器。
 *
 * ## 与 qiniu 的**根本差异**：没有「粘贴 Key」主路径
 *
 * 七牛云的入口是「粘贴一个长期 Key」；国际站的入口是**设备码授权**
 * （`account.create` 分支走登录流程，见 `index.ts` 的同名 case）。故本文件
 * 不提供 `addAccount` 作为主入口，只提供两个**补救**入口：
 *
 * - `qwenworkintl.setToken`：用户从浏览器手工取了一枚 token（或某个自动化流程
 *   拿到了），想直接灌进来。⚠️ 这是**兜底**路径，正常用户不需要；
 * - `qwenworkintl.removeAccount`：清掉一个坏账号。
 *
 * ## ⚠️⚠️ **已知缺口登记：`setToken` 没有客户端入口**（2026-11-23 二轮审计）
 *
 * 后端这两个 RPC 在 `jet-hub-rpc.ts` 已分派，但 `plugin-src/client/` 对
 * `setToken` **零命中** ⇒ 界面上**没有**「手工粘贴 token」的入口。
 *
 * ### 现状影响
 *
 * - **自动化流程不受影响**：任何能发 RPC 的工具都能直接调，这正是它的第二种用途；
 * - **用户手工自救做不到**：设备码登录一旦坏掉（上游改协议 / 授权页 404），
 *   用户**没有任何界面入口**把手工取到的 token 灌进来 ⇒ 只能等插件更新。
 *
 * ### 为什么这次**不补 UI**（不是因为难，是因为风险/收益不划算）
 *
 * 客户端弹窗是本仓**白屏事故最高发**的区域（hook #310 / `window.prompt` 不可用 /
 * `notice` 形状 …详见 `docs/agent-notes/client-ui.md`）。补一个组件需要：
 * 新文件 + 「+新建账号」分流改造 + 面板挂载 + 行为级守卫。
 * 而当前主路径（设备码）**工作正常**，`setToken` 又是「正常用户不需要」的兜底
 * ⇒ **收益是「上游坏掉时能自救」，代价是一次高风险的客户端改造**。
 *
 * ### 什么时候该补
 *
 * ① 设备码登录**真的坏过一次**（有过一次「等插件更新」的用户报障）；
 * ② 或用户明确要求「我要能自己灌 token」。
 *
 * ### 补的时候必须做的（照 `baizhi-key-modal.js` 的范式）
 *
 * - 独立组件文件（**不要**复用 `BaizhiKeyModal`：契约不同，那文件头有分流表）；
 * - 用 `React.createElement(Comp, props)` 渲染，**绝不**直接函数调用（hook #310）；
 * - 输入框值走 `inputRef` + DOM 读值，**不进 `useState`**（凭据口径）；
 * - 挂载点：`keyModal.provider === 'qwenworkintl'` 分支 + 一个独立的次要按钮
 *   （**不改**主路径「+ 新建账号」的设备码行为）；
 * - 守卫：`tests/unit/jet-hub-panel-wiring.spec.ts` 那类**行为级**（真渲染 + 真回调），
 *   源码文本级挡不住 `if (false)`。
 *
 * ⚠️ 这条说明**必须留着**：删掉它，下一个人会以为「已经接了 UI」而不再去查。
 *（守卫在 `tests/unit/qwenwork-lock-wiring.spec.ts` 的 G-8 用例。）
 *
 * ## ⚠️⚠️ token 形状闸**不绑死前缀**，但要挡「明显不是 token」的输入
 *
 * 本仓库 opencode 的 Issue IKPLRU 实测过绑死前缀的代价：上游换发格式后旧闸门把
 * 新 token 全数拒收，用户一个账号都加不进来且无法自救。故判据取与上游命名
 * 无关的共性：**至少 40 位、无空白、`[A-Za-z0-9_.-]`**（实测的 JWT 是 399 位，
 * 全是 `[A-Za-z0-9_-]` 加两个 `.`）。
 *
 * ⚠️ 但这只是**形状**校验，**不是**有效性验证 —— 真 token 仍要等第一次真实
 * 请求才知道。故灌进来之后**立刻读一次额度**：读到了才算成功（避免用户以为
 * 加成功了、实际是死的）。
 *
 * ## ⚠️ 账号 id 由 `user_id` 派生，**不是** token 尾段
 *
 * token 会轮换（`exp` 15 天，续期后 `access` 完全变样）。若 id 由 token 尾段
 * 派生，同一个账号续期一次就会变成「两个账号」，旧的那个永远拿不到额度更新。
 * 故 id 取 `user_id`（JWT 的 `sub` / `user_id` 声明，续期后不变）。
 *
 * @module src/qwenwork-rpc.ts
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ProviderAccountEntry } from './types.js'
import {
  decodeQwenworkJwt,
  isQwenworkRefreshable,
  qwenworkCredentialExpiresAtMs,
  type QwenworkCredential,
} from './qwenwork.js'
import { QWENWORK_INTL } from './qwenwork-product.js'
import type { QwenworkIntlAuth } from './qwenwork-auth.js'

/** `qwenworkintl.setToken` 的请求体。 */
export interface RpcQwenworkSetTokenRequest {
  /** 登录 access token（JWT）。 */
  token: string
  /** 可选：续期令牌（有它才能自动续期）。 */
  refreshToken?: string
  /** 可选展示名。 */
  nickname?: string
}

/** `qwenworkintl.setToken` 的响应。 */
export interface RpcQwenworkSetTokenResponse {
  accountId: string
  /** 是否复用了已存在的同 `user_id` 账号。 */
  existed: boolean
  /** 读到额度时给出摘要（如 `每日 200 · 注册赠送 500（推理不消耗）`）。 */
  credits?: string
}

/** `qwenworkintl.removeAccount` 的请求体。 */
export interface RpcQwenworkRemoveAccountRequest {
  accountId: string
}

/** RPC 需要的账号池子集（便于单测注入替身）。 */
export interface QwenworkPoolLike {
  listAccountsByProvider(provider: string): Array<{ id: string; enabled: boolean; credentialRef: string; nickname?: string }>
  addAccount(entry: ProviderAccountEntry): Promise<void>
  removeAccount(accountId: string): Promise<void>
}

/**
 * token 形状：至少 40 位、无空白、`[A-Za-z0-9_.-]`。
 *
 * ⚠️ **刻意不写 `^eyJ`**（JWT 的 base64 头）：上游可能换发非 JWT 的
 * opaque token，绑死前缀会让新格式全数拒收（opencode IKPLRU）。
 * 实测 JWT 长度 399，故 40 位下界足够宽松又能挡住手滑。
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]{40,}$/

/**
 * 账号 id / credentialRef 由 **`user_id`** 派生（不是 token 尾段）。
 *
 * ## ⚠️⚠️ 为什么必须用 `user_id`
 *
 * token 会轮换：`exp` 15 天，续期后 `access` 完全变样。若 id 由 token 尾段
 * 派生，同一个账号续期一次就会变成「两个账号」，旧的那个永远拿不到额度更新
 * （用户会看到「两个同邮箱账号，一个还有额度、一个是 0」）。
 *
 * `user_id` 来自 JWT 的 `user_id` 声明（实测续期后不变）。
 *
 * ## ⚠️ ref 名必须是合法标识符
 *
 * 宿主的 `credentialRef()` 只认 `/^[A-Za-z_][A-Za-z0-9_]*$/`。而 `user_id` 是
 * UUID（含 `-`）⇒ 必须剥掉非标识符字符 + 追加短哈希，否则会抛
 * `credential ref "…" must match …`，账号**根本写不进去**
 * （opencode IKPLRU 的同型坑，修法照抄 `qiniu-rpc.ts`）。
 *
 * 剥 + 加哈希（而不是纯剥）的理由：纯剥会让两个不同 UUID 撞成同一个 ref，
 * 后者覆盖前者的凭据。
 *
 * @param userId 上游 `user_id`（UUID）。
 */
export function qwenworkSlotNamesOf(userId: string): { id: string; refName: string } {
  const trimmed = userId.trim()
  // 尾段取 8 位（UUID 是 36 位，取尾部足够区分）。
  const tail = trimmed.replace(/-/g, '').slice(-8).toUpperCase()
  const refName = /^[A-Z0-9]*$/.test(tail) && tail.length > 0
    ? `QWENWORKINTL_ACCOUNT_${tail}`
    : `QWENWORKINTL_ACCOUNT_${tail.replace(/[^A-Z0-9_]/g, '')}_${createHash('sha256').update(trimmed).digest('hex').slice(0, 8).toUpperCase()}`
  return { id: `${QWENWORK_INTL.id}-${tail.toLowerCase()}`, refName }
}

/**
 * 判断一个 ref 名是不是本家的账号 ref。
 *
 * ⚠️ 前缀必须与 {@link qwenworkSlotNamesOf} 逐字一致 ——
 * `jet-hub-store.ts` 的 `REF_PREFIX_TO_PROVIDER` 按它反推 provider。
 */
export function isQwenworkAccountRef(ref: string): boolean {
  return typeof ref === 'string' && ref.startsWith('QWENWORKINTL_ACCOUNT_')
}

/**
 * 处理一个 qwenworkintl RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（语义归属清晰）。
 *
 * ⚠️ 不认识时**必须**返回 `undefined` 而不是 `{ok:false}`：主 switch 会在
 * `default` 之前调用本函数，若对未知方法也回信封，别的 provider 的方法名
 * 就会被误判成「格式错误」而不是「没这个方法」。
 */
export async function handleQwenworkRpc(
  ctx: Context,
  pool: QwenworkPoolLike,
  auth: QwenworkIntlAuth,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const fail = (message: string) => ({ ok: false as const, error: { code: 'bad-request', message } })
  const done = <T>(value: T) => ({ ok: true as const, value })

  try {
    switch (method) {
      case 'qwenworkintl.setToken': {
        const req = (payload ?? {}) as RpcQwenworkSetTokenRequest
        const token = typeof req.token === 'string' ? req.token.trim() : ''
        if (!TOKEN_PATTERN.test(token)) {
          return fail(
            'token 形状不对（应是至少 40 位的登录 token）。'
            + '请从千问办公国际站网页的 `token` cookie 或 `/user/wallets` 请求的'
            + ' `Authorization` 头里复制完整值。',
          )
        }
        const jwt = decodeQwenworkJwt(token)
        // ⚠️ 解不出 `user_id` 就**拒绝**：没有它无法稳定派生账号 id，
        //    只能退化成「按 token 尾段」，那会让每次续期都产生新账号。
        if (jwt?.user_id === undefined || jwt.user_id.length === 0) {
          return fail(
            'token 里没有 user_id 声明 —— 无法稳定标识账号。'
            + '请确认复制的是**登录 access token**（JWT 三段式），不是刷新令牌或其它字段。',
          )
        }
        const { id, refName } = qwenworkSlotNamesOf(jwt.user_id)
        const existed = pool.listAccountsByProvider(QWENWORK_INTL.id).some((a) => a.id === id)
        const expiresAt = jwt.exp === undefined ? undefined : String(jwt.exp * 1000)
        const nickname = typeof req.nickname === 'string' && req.nickname.trim().length > 0
          ? req.nickname.trim()
          : jwt.username ?? jwt.email ?? `QwenWork ${jwt.user_id.slice(0, 8)}`
        const credential: QwenworkCredential = {
          // ⚠️ 字段名必须是 `access_token`（AccountPool 身份反查用，见 qwenwork.ts）。
          access_token: token,
          ...typeof req.refreshToken === 'string' && req.refreshToken.length > 0
            ? { refresh_token: req.refreshToken }
            : {},
          ...expiresAt === undefined ? {} : { expires_at: expiresAt },
          user_id: jwt.user_id,
          nickname,
          ...jwt.email === undefined ? {} : { email: jwt.email },
        }
        await ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))
        // ⚠️ **立刻读一次额度**：形状对 ≠ token 有效。读到了才算真的加成功
        //    （否则用户以为加好了、实际每次请求都 401）。
        const snapshot = await auth.fetchBalance(token)
        if (snapshot === undefined) {
          // ⚠️ 凭据已写入（保留，便于用户排查），但**如实报告**读不到额度。
          //    不删号：删号是不可逆操作，而「读不到」可能是瞬时网络问题。
          return fail(
            'token 已保存，但读不到额度（上游拒绝或网络失败）。'
            + '请确认 token 未过期；若刚在别处刷新过登录态，旧 token 会立即失效。',
          )
        }
        const credits = [
          snapshot.daily === undefined ? undefined : `每日 ${snapshot.daily}`,
          snapshot.longterm === undefined || snapshot.longterm <= 0
            ? undefined
            : `注册赠送 ${snapshot.longterm}（推理不消耗）`,
        ].filter((v): v is string => v !== undefined).join(' · ')
        await pool.addAccount({
          id,
          provider: QWENWORK_INTL.id,
          nickname,
          enabled: true,
          credentialRef: refName,
          // ⚠️ 有 `refresh_token` 才是真的可续期（本家**有** refresh 端点，
          //    与 qiniu 的恒 false 相反）。
          refreshable: isQwenworkRefreshable(credential),
          ...qwenworkCredentialExpiresAtMs(credential) === undefined
            ? {}
            : { expiresAt: qwenworkCredentialExpiresAtMs(credential) },
          createdAt: Date.now(),
        })
        // 票据是用旧 token 换的，换号后必须作废。
        auth.invalidateTicket(id)
        return done({
          accountId: id,
          existed,
          ...credits.length === 0 ? {} : { credits },
        } satisfies RpcQwenworkSetTokenResponse)
      }

      case 'qwenworkintl.removeAccount': {
        const req = (payload ?? {}) as RpcQwenworkRemoveAccountRequest
        if (typeof req.accountId !== 'string' || req.accountId.length === 0) {
          return fail('缺少 accountId')
        }
        const target = pool.listAccountsByProvider(QWENWORK_INTL.id)
          .find((a) => a.id === req.accountId)
        if (target === undefined) return fail(`未找到账号 ${req.accountId}`)
        await pool.removeAccount(req.accountId)
        auth.invalidateTicket(req.accountId)
        return done({ accountId: req.accountId })
      }

      default:
        // ⚠️ 不认识时返回 `undefined`（见函数注释）。
        return undefined
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
