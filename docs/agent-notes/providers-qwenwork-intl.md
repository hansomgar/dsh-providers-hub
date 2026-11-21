# QwenWork Intl（千问办公国际版，`qwenworkintl`）

> 接入日期：**2026-11-22**｜首个真机全链路验证完成的日期
> 上游：`qwenwork.ai` / `gateway.qwenwork.ai` / `api1.qwenwork.ai`
> ⚠️ **不是**国内站 `qwenwork.cn` —— 两站的额度机制与合规性**本质不同**（见 §1）

---

## §1 与国内站的本质区别（选型理由）

| 维度 | 国内站 `qwenwork.cn` | **国际站 `qwenwork.ai`** |
|---|---|---|
| 免费额度 | 100/月（另有需「领」的 500/月） | **200/天，服务端自动刷新** |
| 领取动作 | 🔴 **伪造 session/turn 上报**（`/api/marketing/benefits/claim`） | ✅ **无 claim 端点**，纯服务端发放 |
| 官方态度 | 活动页明禁「异常方式套取积分……回收并封号」 | 无此问题 |
| `/api/marketing/benefits/claim` | **401（存在）** | **404** |
| 额度端点 | `/api/v1/adapter/user/wallets` | `/user/wallets`（**网页域**） |
| 鉴权 | Bearer | **Bearer（cookie 一律 401）** |

**⇒ 本 provider 只接国际站，且刻意不实现任何「签到/领取」逻辑。**

## §2 三个必须记住的实测事实

### 2.1 🔴 临时邮箱拿不到积分（最容易误判的一条）

同一天注册的两个账号对照：

| 邮箱 | `daily_credits` | `longterm_credits` | `quota.remaining` |
|---|---|---|---|
| `@mail.airoute.kdns.fr`（临时邮箱） | **0** | **0** | **0**（`exceeded: true`） |
| `@outlook.com`（正常邮箱） | **200** | **500** | **700** |

**⇒ 用户报「看不到额度」时，先问邮箱类型**，不要先怀疑插件。

### 2.2 🔴 三个池只有 daily 会被推理消耗

```json
GET https://qwenwork.ai/user/wallets
{ "daily_credits":    { "total_balance": 200 },   ← 推理**只扣**这个
  "monthly_credits":  { "total_balance": 0 },
  "longterm_credits": { "total_balance": 500 },   ← 注册赠送，推理**扣不动**
  "active_wallets":   { "wallets": [ {balance:200, valid_to:"次日00:00"}, {balance:500, valid_to:"3个月后"} ] } }
```

实测推理前后：`daily 200 → 199.8368`，`longterm 500` **纹丝不动**。

**⇒ 两条硬规则**（`qwenwork-credits.ts` 的模块头有完整推导）：
1. 面板「余额」取 **daily**，不是合计 700 —— 否则用户在 200 烧完后收到
   `balance_insufficient` 却看到「还有 500」；
2. 折算可用性**只看 daily** —— 用合计会漏判（daily 已空但合计还有 500 ⇒
   该账号实际已不可用，却仍被排进聚合候选 ⇒ 每轮先 429 一次）。

### 2.3 🔴 鉴权是 Bearer，**cookie 一律 401**

网页版确实用 `token` cookie，但 API **不认** cookie。
实测 4 种 cookie 组合（仅 token / +`__u` / +`cna,isg` / 全部）**全部 401**，
同一 token 走 `Authorization: Bearer` 立刻 200。

## §3 两段式推理链路（与所有别家都不同）

```
① 设备码登录    POST gateway.qwenwork.ai/device/selectAccounts
                POST gateway.qwenwork.ai/api/v1/deviceToken/poll
                → access_token（JWT，实测 exp 15 天）+ refresh_token

② 换 MaaS 票据  POST gateway.qwenwork.ai/api/desktop-sessions
                Header: Authorization: Bearer <access_token>
                Body:   { "session_id": "<uuid>" }
                → 201 { access_token, base_url: "https://api1.qwenwork.ai",
                        expires_at_ms, session_id, ttl_ms: 7200000 }

③ 推理          POST {base_url}/v1/chat/completions
                Header: Authorization: Bearer <maas_token>
```

### 3.1 ⚠️ `base_url` 由上游下发，**绝不硬编码**

硬编码会在上游轮换 `apiN` 节点时让整条渠道失效，症状是「所有请求 404」——
与「没有这个模型」同形，无法诊断。`fallbackInferBase` 只在上游**没有**下发时才用。

### 3.2 ⚠️ MaaS 票据必须缓存 + 单飞

`ttl_ms = 7_200_000`（2 小时）。DSH 会**并发**发主回复 + 标题 + 压缩三条请求 ⇒
没有单飞表就会换三次票（每次都是真实上游调用）。
实现在 `QwenworkIntlAuth.mintTicket`：按 slot id 缓存 + inflight Map，
**提前 60 秒**失效（避免「正好在过期边界发请求」⇒ 401 ⇒ 被误判成登录失效）。

## §4 国际站专属的 OAuth 参数（与国内站**不同**，混用即 400）

| 字段 | 国内站 | **国际站** |
|---|---|---|
| `client_id` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | **`cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a`** |
| `redirect_uri` | `qwenwork-cn://` | **`qwenwork://`** |
| `cosyVersion` | `1.1.59` | **`1.1.71`** |
| App 版本 | `1.2.1` | **`1.4.0`** |

实测：国际站 client_id + 国内站 scheme ⇒ **`400 INVALID_DEVICE_FLOW`**；反之亦然。
**两个字段必须成对正确。**

## §5 模型目录：**没有可用的远端端点**

| 端点 | 实测 |
|---|---|
| `gateway.qwenwork.ai/algo/api/v2/model/list?Encode=1` | **403**（需 WASM 签名，国际站此处没有） |
| `{base_url}/v1/models` | **404** |
| `qwenwork.ai/api/models` | **404** |

⇒ 目录**恒来自** `QWENWORK_INTL_FALLBACK_MODELS`（9 条，逐个「发一条真请求拿到 200」）。

### 5.1 ⚠️ 模型名必须用真实档位，不能用 `qwork-*`

| 名称 | 结果 |
|---|---|
| `qwork-auto` / `qwork-lite` / `qwork-standard` / `qwork-advanced` / `qwork-ultimate` | ❌ **400** |
| `qwen3.8-max-preview`（magpie 源码里的写法） | ❌ **400** |
| `flash` / `pro` / `deepseek-flash` / `glm-5.3` / `qwen3.8-max` … | ✅ **200** |

⚠️ **已知腐坏风险**：上游加模型后这张表不会自动跟上（无目录端点）。
缓解是「手填 id 仍可用」；**不能**靠猜名字补全（猜错的症状与「账号没权限」同形）。

## §6 能力矩阵（全部实测）

### 6.1 9 个模型 × 4 项能力

| 模型 | HTTP | 工具调用 | 图片 | 上下文 |
|---|---|---|---|---|
| `flash` | 200 | ✅ | ✅ | ≥1M |
| `pro` | 200 | ✅ | ❌ **400** | ≥1M |
| `deepseek-flash` | 200 | ✅ | ✅ | ≥1M |
| `deepseek-v4-pro` | 200 | ✅ | ✅ | ≥1M |
| `glm-5.3` | 200 | ✅ | ❌ **400** | ≥1M |
| `glm-5.3-flash` | 200 | ✅ | ✅ | ≥1M |
| `qwen3.8-max` | 200 | ✅ | ✅ | ≥1M |
| `qwen4-max` | 200 | ✅ | ✅ | ≥1M |
| `kimi-k3.1-pro` | 200 | ✅ | ✅ | ≥1M |

### 6.2 工具调用与流式的实测形态

- **工具调用**：`finish_reason: "tool_calls"`，`tool_calls[].function.arguments` 是
  标准 JSON 串，形状与 OpenAI 完全一致；
- **多轮往返**：带 `role:'tool'` + `tool_call_id` 的请求实测 200 并正确引用结果；
- **流式**：`content-type: text/event-stream; charset=utf-8`，帧格式与 OpenAI 相同，
  以 `[DONE]` 结束；**流式 + 工具**同时开启也正常（增量里带 `tool_calls`）；
- **reasoning**：响应里 `message.reasoning_content` 是思考过程、
  `usage.completion_tokens_details.reasoning_tokens` 是思考 token 数。

### 6.3 ⚠️ `reasoning_effort` 实测生效（与 magpie 的结论不同）

| 请求 | reasoning_tokens | 有 reasoning_content |
|---|---|---|
| 不带参数 | **0** | false |
| `reasoning_effort: "high"` | **35** | **true** |
| `reasoning_effort: "low"` | 0 | false |
| `thinking: { type: 'enabled' }` | 19 | true |

⇒ 声明档位 `['low', 'high']`（**强度序弱 → 强**，本仓 `protocol-wire.md` 的不变式）。

## §7 上下文窗口：实测 ≥1,000,000

逐档实测（`glm-5.3-flash`，`word ` 近似 1 token）：

| 输入 token | 结果 |
|---|---|
| 5,013 / 20,013 / 80,013 / 300,013 | ✅ 200 |
| 400,000 / 500,000 / 700,000 / **1,000,000** | ✅ 200 |
| 1,200,000 | ❌ 400 `context_length_exceeded` |

⇒ 兜底表统一记 `1_000_000`（**实测已通过的最大值**，不是精确上限）。

⚠️ `context_length_exceeded` **必须**归 `context_window` 而不是额度 ——
归额度会让账号被封到次日零点（本仓 loomy「全池被封」事故同型）。

## §8 错误分类：顺序即优先级

`classifyQwenworkError` 的判据顺序（每一条都有实测依据）：

1. **`context_length_exceeded` 最先** —— 实测 HTTP **400**，落进
   `invalid_request` 会让宿主的 context-overflow 监听器不触发 ⇒ 自动压缩不跑；
2. **401/403 恒归 `auth`** —— 认证是**账号态**、不是模型冷却，落 quota 会
   放大成封池；
3. **额度判定必须在 `rate_limit` 之前** —— 额度拒绝是 HTTP **429** +
   `balance_insufficient`，若按「429 ⇒ 限流」处理，额度耗尽会被当短时限流；
4. 限流 / 传输 / 形状 / 服务端依次兜底。

## §9 接线清单（本家涉及的每一处）

| # | 位置 | 改了什么 |
|---|---|---|
| 1 | `src/provider-registry.ts` | 纯数据条目（`credits: {balance:true, dailyCheckin:false}`、`channel:true`） |
| 2 | `src/index.ts` | import / `new QwenworkIntlAuth` / `registerQwenworkLlm` / `pruned()` / registry 数组 / `JetHubAuths` |
| 3 | `src/provider-expiry.ts` | `qwenworkintl` 条目 → `qwenworkExpiry` |
| 4 | `src/aggregate-expiry.ts` | `WIRED_EXPIRY_PROVIDERS` 加 `'qwenworkintl'` |
| 5 | `src/aggregate-adapter.ts` | `AGGREGATE_CHANNELS` 加 `'qwenworkintl'` |
| 6 | `src/jet-hub-store.ts` | `REF_PREFIX_TO_PROVIDER` 加 `['QWENWORKINTL', 'qwenworkintl']` |
| 7 | `src/jet-hub-rpc.ts` | `JetHubAuths` 键 + `SELF_HEAL_REFRESHABLE_PROVIDERS` + RPC 分派分支 |
| 8 | `src/provider-credits.ts` | `fetchBalanceDetailed` 条目 |
| 9 | `plugin-src/client/provider-icons.js` | 图标常量 + 键 |
| 10 | `plugin-src/client/jet-hub.js` | `AGG_WIRED_CHANNEL_IDS` |

### 9.1 ⚠️ ref 前缀必须是 `QWENWORKINTL`（不带下划线）

全仓约定是 `${provider.toUpperCase()}_ACCOUNT_${suffix}`，而
`tests/unit/jet-hub-store.spec.ts` 的「恢复表覆盖」用例**按这个约定生成 ref**。
写成 `QWENWORK_INTL_ACCOUNT_*` 会让那条用例直接红
（实测踩过：`expected [...31] to deeply equal [...32]`）。

### 9.2 ⚠️ `SELF_HEAL_REFRESHABLE_PROVIDERS` 的注释里不能有带引号的单字母

那条 Set 的守卫会**扫描源码里的单引号字符串**当成员。我在注释里写了
`target: 'c'` ⇒ 它被解析成一个叫 `c` 的成员 ⇒ 三条守卫同时红
（`自愈 Set 里的 c 没有声明余额能力` / `Set 里的 c 在 JetHubAuths 里没有对应键`）。
⇒ **注释里提到字面量值时改写成文字描述**。

## §10 未验证 / 已知限制

- ⚠️ **跨日刷新只在 `valid_to` 上看到证据**：实测 `daily` 钱包的
  `valid_to` 是「次日 00:00（UTC+8）」，注册当天的 200 已到账；
  **尚未做跨日实测**（已挂定时任务，2026-11-23 00:30 自动核对）。
- ⚠️ **500 注册赠送的 3 个月到期后是否还有额度**：未验证。
- ⚠️ 国内站的「个人基础版 500/月」与本站的 200/天**不可叠加**（账号体系不同）。
- ⚠️ 上游 `desktop-sessions` 的 `session_id` 语义未深究（每次传新 uuid 实测可用）。
