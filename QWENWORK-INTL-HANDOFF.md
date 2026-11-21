# 千问办公国际站 provider —— 交接文档

> **文件**：`dsh-providers-hub/QWENWORK-INTL-HANDOFF.md`
> **分支**：`feat/qwenwork-intl-provider`
> **最后更新**：2026-11-22
>
> 📌 **怎么用**：每次新会话开始、或要动这个分支时，让 AI **先读这份文档**。
> 它自成体系——读完不需要再看别处就能接手。

---

## 0. 一句话背景

`dsh-providers-hub` 是把二十几家 AI 编码产品的私有 API 逆向成 DSH provider 的插件。
这个分支给它加了**第 34 家**：千问办公国际站（`qwenwork.ai`），
**免费每日 200 积分自动刷新**，是本插件里免费额度最充裕的一档。

---

## 1. ⚠️ 最重要：这是私有分支，不提 PR

| 项 | 值 |
|---|---|
| 分支 | **`feat/qwenwork-intl-provider`** |
| provider id | **`qwenworkintl`**（`/^[a-z]+$/` 硬约束，不能带连字符） |
| 展示名 | `QwenWork (国际版)` |
| 推送目标 | **`fork`** = `hansomgar/dsh-providers-hub` |
| 上游 | `origin` = `iJetLi/dsh-providers-hub`（**只读**） |

### 🚫 三条铁律

1. **绝不提 PR** 给上游 `iJetLi/dsh-providers-hub`；
2. **绝不推 `origin`**（只能 `git push fork ...`）；
3. 上游更新时 → **同步进这个分支**（不是反过来）。

**用户原话**：
> 「这个 providers 是不提交 PR 给上游的，专门属于我自己使用的，不过你可以提交到我
> 仓库单独一个分支，后续如果上游有更新，需要先同步上游更新，然后再把这个分支合并到
> 新版本，这样可以保证我既能用到上游的新版本，又可以用到这个 providers。」

---

## 2. 分支现状（2026-11-22 推送时）

```
基点      098de904（= origin/master 当时的 HEAD）
ahead     5 个提交（全部是这个 provider 的改动）
behind    0 个提交
```

> ⚠️ **基点干净是刻意的**：`merge-base == origin/master`
> ⇒ 后续每次 `merge origin/master` 的冲突面最小。

五个提交：

| 提交 | 内容 |
|---|---|
| `08b0083c` | 新增 provider（6 个源文件 + 八处接线 + 单测 + 文档） |
| `e0826e0a` | 补两个构造 `JetHubAuths` 的测试 |
| `7a3c3336` | **修工具包装缺陷**（关键，见 §4.1） |
| `c6b38adc` | 补 agent-notes（缺陷记录 + 加载验证） |
| `471d425c` | 修正脚本位置说明 |

---

## 3. ★★ 同步上游（这是这个分支存在的意义）

### 3.1 两条命令

```sh
cd E:\Data\data_dsh\2026\dsh-agent-proxy

node sync-upstream.cjs --check     # ① 体检（随时可跑，不改任何文件）
node sync-upstream.cjs             # ② 同步上游（11 步全自动）
node sync-upstream.cjs --dry-run   # 只预演，不动文件
```

### 3.2 ⚠️ 为什么必须有「接线体检」

本仓的 provider 接入是「**往 8 张表里逐行新增**」的形态：

```
①  src/provider-registry.ts    纯数据条目
②  src/index.ts                import + new Auth + registerLlm + registry 数组
③  src/provider-expiry.ts      折算条目
④  src/aggregate-expiry.ts     WIRED_EXPIRY_PROVIDERS
⑤  src/aggregate-adapter.ts    AGGREGATE_CHANNELS
⑥  src/jet-hub-store.ts        REF_PREFIX_TO_PROVIDER
⑦  src/jet-hub-rpc.ts          JetHubAuths 键 + SELF_HEAL_REFRESHABLE_PROVIDERS
⑧  src/provider-credits.ts     credits 表
```

**git 通常能自动合入这些新增行，但会把新增行「合丢」而不报冲突**
（上游在同一位置也加了行时，3-way merge 会选它那侧）。

丢了的症状是 **编译全绿、功能缺一块**：

- ✅ `tsc --noEmit` 通过
- ✅ 大部分测试通过
- ❌ 但面板不出现 / 积分行空白 / 聚合轮换里看不到 / 账号重启后静默消失

⇒ `sync-upstream.cjs` 的**第 8 步**逐文件核对 **23 处接线**，丢一处就 exit 1 并点名。

### 3.3 体检的有效性已验证（不是恒真断言）

**负向验证**：手工删掉 `src/aggregate-adapter.ts` 里的 `'qwenworkintl'` ⇒

```
❌ 接线体检失败：1 / 23 处缺失
   src/aggregate-adapter.ts  [⑤ AGGREGATE_CHANNELS]  —— 找不到 "'qwenworkintl"
exit code: 1
```

### 3.4 同步脚本的 11 步

```
1  检查工作区（有未提交改动就拒绝合并）
2  切到 feat/qwenwork-intl-provider
3  fetch origin + fork
4  算领先/落后多少提交
5  列出上游新提交
6  ★ 冲突面预演（点名哪些文件两边都改过，标出「八处接线」里的高危项）
7  merge origin/master
8  ★★ 接线体检（23 处，丢一处即中止）
9  tsc（src + tests）+ provider 67 条单测
10 全量测试（失败只警告不中止——可能是上游本来就有的）
11 推送到 fork
```

### 3.5 冲突了怎么办

```sh
git status                         # 1) 看哪些文件冲突
git diff <冲突文件>                 # 2) ⚠️「八处接线」的表：两边改动都要保留
git add -A && git commit           # 3) 解决完标记
node sync-upstream.cjs --check     # 4) 体检（抓「以为合对了但其实丢了行」）
npx tsc -p tsconfig.json --noEmit  # 5) 全跑一遍
npx tsc -p tsconfig.tests.json
npx vitest run
git push fork feat/qwenwork-intl-provider   # 6) 推
```

### 3.6 ⚠️ 体检抓不到的情况

上游**重构了本 provider 依赖的内部 API**（例如 `openai-compat.ts` 的
`serializeMessages` 改签名）时，`tsc` 会红——正常修即可。

更隐蔽的是**上游改了默认行为但签名不变**，只能靠全量测试 + 真机验证兜。

---

## 4. ★ 实现要点（改这个 provider 前必读）

### 4.0 文件清单

```
src/qwenwork-product.ts    产品配置 + 9 模型表 + 错误分类（顺序即优先级）
src/qwenwork.ts            凭据结构、JWT 解析、请求头、续期体
src/qwenwork-auth.ts       ★ MaaS 票据单飞缓存 + 续期 + 三池额度读取
src/qwenwork-credits.ts    ★ 三池分离装配 + 折算原语 qwenworkExpiry
src/qwenwork-messages.ts   ★ wire 形状门禁（工具包装 + system 折叠）
src/qwenwork-adapter.ts    LLM 适配器
src/qwenwork-rpc.ts        setToken / removeAccount 补救入口

tests/unit/qwenwork-intl.spec.ts      54 条
tests/unit/qwenwork-messages.spec.ts  13 条
docs/agent-notes/providers-qwenwork-intl.md   完整实测记录
```

### 4.1 ⚠️⚠️ 工具定义必须包成 OpenAI 两层（最严重的一个坑）

**DSH 下发的 `tools` 是扁平结构** `{name, description, parameters}`。
直接塞进 body ⇒ 上游回 **HTTP 400 `invalid_request`**。

而 DSH 几乎**每轮**都带工具 ⇒ 症状是「渠道能加、模型能选、**一发消息就报错**」，
报文只有一句 `invalid_request`，**完全指不出根因**。

```json
// ❌ 扁平（会 400）
{"tools":[{"name":"get_weather","description":"…","parameters":{…}}]}

// ✅ 两层包裹（实测 200 + finish_reason: tool_calls）
{"tools":[{"type":"function","function":{"name":"get_weather",…}}]}
```

⚠️ 这与本仓 `qiniu-messages.ts` 记录的
**`'type' is a required property - 'tools.0'`** 是**同型同因**。

**守卫**：`qwenwork-messages.spec.ts` 有 13 条，其中两条专挡这个坑
（逐字节断言两层包裹、整体序列化断言含 `"tools":[{"type":"function"`）。
**变异验证**：改回扁平 ⇒ 6 条变红（已实测）。

### 4.2 ⚠️ 另两处 wire 契约

| 项 | 错法 | 后果 | 正确做法 |
|---|---|---|---|
| `system` | 放**顶层** | OpenAI 兼容上游只从 `messages[]` 读系统提示词，顶层被**静默忽略** ⇒ 插件里配的系统提示词**完全没生效**而界面一切正常 | `foldSystemIntoMessages` 折进 `messages[0]` |
| `max_tokens` | 写 `max_completion_tokens` | 上游不认 | 用 `max_tokens`，且只放行**安全正整数**（0/负数/NaN 会让 DSH 抛 `INVALID_MODEL_MAX_TOKENS` 把整轮搞崩） |

### 4.3 ⚠️ 设备码登录（Device Code + PKCE）—— 协议是重新逆向的

**用户操作**：面板点「+ 新建账号」→ 弹出授权网址 → 浏览器打开 → 登录
qwenwork.ai → 确认授权 → 插件后台轮询自动拿到 token。

```
① GET {gateway}/device/selectAccounts
     ?challenge=<S256(verifier)>&challenge_method=S256
     &nonce=<uuid>&machine_id=<uuid>
     &client_id=<国际站>&redirect_uri=qwenwork%3A%2F%2F
   → 302 Location: qwenwork.ai/oauth2/auth?...&state=<服务端生成>

② GET {gateway}/api/v1/deviceToken/poll
     ?nonce=<uuid>&verifier=<b64url>&challenge_method=S256
   → 404 {}   还没授权
   → 200      { token, refresh_token, expires_at, user_id, user_name }
```

#### ⚠️⚠️ 三个反直觉点（每一个都实测踩过）

**① `selectAccounts` 成功是 302，不返回 nonce。**

`nonce` 是**客户端自己 `randomUUID()` 生成**的。按「请求 nonce」的思路实现，
无论怎么调都拿不到 —— 因为方向就是错的。

**② `poll` 的 `404 {}` 对「未授权」和「nonce 不存在」返回完全相同。**

逐字节比对过（`indistinguishable: true`）⇒ **不能靠 404 判断 flow 是否还有效**，
只能自己设总超时（当前 15 分钟）。

**③ 两边 query 字段集合严格互斥，多一个就 400。**

| 端点 | 允许的字段（**恰好这些**） |
|---|---|
| `selectAccounts` | `challenge` / `challenge_method` / `nonce` / `machine_id` / `client_id` / `redirect_uri` |
| `poll` | `nonce` / `verifier` / `challenge_method` |

⚠️ `challenge` 属于前者、`verifier` 属于后者。把 `challenge` 传给 `poll` 会得到
`field:"challenge", reason:"not_allowed"` —— 极易误判成「缺字段」。

⚠️ `field:"query", reason:"not_allowed"` 是**针对整条 query 的通用报错**，
`valueSummary.length` 是整条串的字节长度，**指不出具体哪个字段错**。

#### 其它实测约束

| 探测 | 结果 |
|---|---|
| 六字段齐全 | **302** ✅ |
| **完全不发任何 header** | **302** ✅（headers 非必需） |
| `POST` 到任一端点 | **404**（只接受 GET） |
| `nonce="abc123"`（非 UUID） | 400 |
| `machine_id="not-a-uuid"` | **302**（不做格式校验） |
| `challenge_method=plain` | 400 |
| 同一 nonce 重复用 | **409 `DEVICE_FLOW_REPLAYED`** |
| 多传 `code=abc` / `response_type` / `scope` / `cosyVersion` | 400 |
| 国内站 `client_id` / `redirect_uri` | 400 |

⚠️ `cosyVersion`（1.1.71）**完全不参与登录**，只用于聊天请求的 COSY 信封。

#### 代码位置

```
src/qwenwork-login.ts   createQwenworkDeviceFlow / qwenworkSelectAccountsUrl
                        pollQwenworkDeviceToken / waitForQwenworkCredential
                        startQwenworkDeviceLogin（凭据由自己落盘，与 codely 同款）
src/qwenwork.ts         qwenworkDeviceAuthUrl（唯一一份拼串实现）
src/jet-hub-rpc.ts      account.create 的 qwenworkintl 分支
tests/unit/qwenwork-login.spec.ts   29 条（逐条锁死上面三个坑）
```

⚠️ **「连续 3 次 broken 才判死」是刻意的**：单次 HTTP 400 可能是瞬时抖动，
一次就判死会把抖动误报成「登录失败」。

⚠️ **200 但响应里没有 `token` 必须判 broken**：当成功会写进一张空凭据卡，
用户看到「已登录」却发消息 401。

### 4.4 ⚠️ 两段式推理（与所有别家不同）

```
① 设备码登录    POST gateway.qwenwork.ai/device/selectAccounts
                POST gateway.qwenwork.ai/api/v1/deviceToken/poll
                → access_token（JWT，实测 15 天）+ refresh_token

② 换 MaaS 票据  POST gateway.qwenwork.ai/api/desktop-sessions
                Header: Authorization: Bearer <access_token>
                Body:   {"session_id": "<uuid>"}
                → 201 {access_token, base_url:"https://api1.qwenwork.ai", ttl_ms:7200000}

③ 推理          POST {base_url}/v1/chat/completions
                Header: Authorization: Bearer <maas_token>
```

⚠️ **`base_url` 由上游下发，绝不硬编码**（节点轮换时硬编码会让整条渠道 404）。

⚠️ **MaaS 票据必须缓存 + 单飞**：`ttl_ms` = 2 小时，而 DSH 会**并发**发
主回复 + 标题 + 压缩三条请求 ⇒ 没有单飞表就会换三次票。
实现在 `QwenworkIntlAuth.mintTicket`（按 slot id 缓存 + inflight Map，**提前 60 秒**失效）。

### 4.5 ⚠️⚠️ 额度是**瀑布扣减**，`total` 取两池之和

```
推理前  daily=0   longterm=378.0028
推理后  daily=0   longterm=378.0011   ← 扣 0.0017，daily 纹丝不动
HTTP 200 ✅
```

⇒ **先扣 daily，daily 空了扣 longterm**。

#### ⚠️⚠️ 这里有一个我踩过并纠正过的坑（别重犯）

**2026-11-22 早**，我用**刚注册的新账号**实测：`daily 200 / longterm 500`，
发一次请求后 `daily 200 → 199.8368` 而 `longterm 500` 纹丝不动
⇒ 错误地得出「推理**只扣** daily，longterm 永远扣不到」，把 `total` 取成了 `daily`。

**同一天晚**，用 daily 已耗尽的账号实测推翻了它 —— 用户随即报障
「登录成功但积分显示 0 且查询失败，实际有 378」。

**教训**：那次观察窗口太窄（只测了新账号 daily 未耗尽的那一段）。
判定扣费口径时，**必须覆盖两个状态**：daily 有额、daily 已耗尽。

#### 现在的实现

- `buildQwenworkBalance` 的 `total` = **daily + longterm**
  （`monthly_credits` 不计入 —— 那是订阅额度，免费版恒 0）
- `qwenworkExpiry` 看**两池之和**（旧写法只看 daily ⇒ 把长期额度还剩几百的
  **最健康账号**从聚合轮换里剔除）
- 到期时刻：daily 有额用 daily 的（次日 00:00），否则用**最晚**那个钱包
  （长期额度，三个月后）
  ⚠️ 刻意**不给 `CreditBalance` 加字段**（全仓共享类型，不该为一家加私有字段），
  改为从 `packages` 里挑
- 包名：`每日额度（次日刷新）` / `长期额度（注册赠送）`
  ⚠️ **不得写「推理不消耗」**（已被实测推翻）

### 4.6 ⚠️ 鉴权是 Bearer，**cookie 一律 401**

网页版确实用 `token` cookie，但 API **不认** cookie。
实测 4 种 cookie 组合**全部 401**；同一 token 走 `Authorization: Bearer` 立刻 200。

### 4.7 ⚠️ 国际站专属 OAuth 参数（与国内站**不同**，混用即 400）

| 字段 | 国内站 `qwenwork.cn` | **国际站 `qwenwork.ai`** |
|---|---|---|
| `client_id` | `e883ade2-…` | **`cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a`** |
| `redirect_uri` | `qwenwork-cn://` | **`qwenwork://`** |

实测混用 ⇒ `400 INVALID_DEVICE_FLOW`。**必须成对正确**。

### 4.8 ⚠️ 本仓通用硬约束（踩过的）

| 纪律 | 后果 |
|---|---|
| provider id 只能 `/^[a-z]+$/` | 带连字符会被 `provider-registry.spec.ts` 判红 |
| 凭据字段必须叫 `access_token` | `AccountPool.findAccountIdByCredential` 统一取它 |
| 适配器要包 `prepareCall`（不能只包 `stream`） | 上下文占用条不渲染、档位菜单不出现 |
| `LlmModelInfo` 只有**平坦** `contextWindow` | 写 `m.info.context?.contextWindow` 会「假红」（`LlmResolvedModelInfo` 才有 `context`） |
| `REF_PREFIX_TO_PROVIDER` 前缀 = `${id.toUpperCase()}_ACCOUNT_` | 写错 ⇒ `state.json` 缺失时账号**静默消失** |
| `SELF_HEAL_REFRESHABLE_PROVIDERS` 注释里别写带引号的单字母 | 守卫扫源码单引号串当成员（`target: 'c'` ⇒ 多出一个叫 `c` 的成员，三条守卫同时红） |
| 图片附件必须带 `attachmentId` | 只给 `{mediaType,data}` ⇒ `collectImages` 认不出，等于没发图 |

---

## 5. 实测数据（全部真机，2026-11-22）

### 5.1 能力矩阵

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

⚠️ `qwork-auto` / `qwork-lite` / `qwork-standard` / `qwork-advanced` / `qwork-ultimate`
**全部 400**；magpie 源码里的 `qwen3.8-max-preview` 也是 400。

### 5.2 成本（10k 输入 / 200 输出一轮）

| 模型 | 单轮消耗 | 200 分可跑 |
|---|---|---|
| `flash` | 0.0933 | ≈ 2,143 轮 |
| `glm-5.3-flash` | 0.0996 | ≈ 2,008 轮 |
| `deepseek-flash` | 0.1568 | ≈ 1,275 轮 |
| `glm-5.3` | 0.2468 | ≈ 810 轮 |
| `deepseek-v4-pro` | 0.6873 | ≈ 290 轮 |
| `kimi-k3.1-pro` | 1.9311 | ≈ 103 轮 |

### 5.3 三个必须知道的坑

**① 临时邮箱拿不到积分**（同一天注册的两个账号对照）

| 邮箱 | daily | longterm | quota.remaining |
|---|---|---|---|
| `@mail.airoute.kdns.fr`（临时） | **0** | **0** | **0** |
| `@outlook.com`（正常） | **200** | **500** | **700** |

⇒ 用户报「看不到额度」时**先问邮箱类型**，不要先怀疑插件。

**② 没有签到端点**：逐个探测 16 个候选领取端点**全部 404**
（国内站那套 `/api/marketing/benefits/claim` 在国际站也是 404）
⇒ 额度由服务端**每日自动发放**，故 `dailyCheckin: false` **不是缺口**。

**③ 上下文窗口**：逐档实测 5k/20k/80k/300k/400k/500k/700k/**1M** 全 200，
**1.2M → 400 `context_length_exceeded`**。兜底表统一记 `1_000_000`。

---

## 6. 装到 DSH 用

```sh
dsh plugin --profile desktop add "file:E:\Data\data_dsh\2026\dsh-agent-proxy\dsh-providers-hub"
```

装完重启 DSH，模型选择器里出现「**QwenWork (国际版)**」分组，9 个模型。

⚠️ **首次使用必须在面板里登录**（设备码授权），且**必须用正常邮箱注册的账号**。

---

## 7. 当前状态与未闭环事项

| # | 事项 | 状态 |
|---|---|---|
| 0 | ~~积分显示 0 / 查询失败~~ | ✅ **已修**（2026-11-22，commit 784e1d01）：根因是 	otal 只取 daily，而额度是**瀑布扣减** ⇒ 改为两池之和。真实凭据实测 378.0011 正确 |
| 1 | **「每日 200 是否真补满」** | ⚠️ 只有结构证据（`valid_to` = 次日 00:00，注册当天 200 已到账）。已挂定时任务 **2026-11-23 00:30** 自动核对 |
| 2 | 全量测试 8 条红 | 全部是**改动前基线就有的**（`qoder-web-usage`×4、`balance-disk-cache`×2 flaky、`raccoon-authorize`×1、`autoclawintl-zai`×1）。已用 `git stash` 在基线上复现 |
| 3 | `autoclaw` 端口缺陷 | 修复在 `fix/baseline-test-failures` 的 `83b54059`，**未并入本分支**（刻意保持基于干净上游）|

**验证结果**：`tsc`（src + tests）全绿；**14996 passed / 8 failed**（那 8 条即上表第 2 项）；
新增 67 条单测全通过；真机端到端 6/6 通过。

---

## 8. 环境注意（踩过的）

| 项 | 事实 |
|---|---|
| PowerShell | **5.1**，`pwsh` **不在 PATH** |
| 执行策略 | `RemoteSigned` ⇒ 自己写的 `.ps1` 会被拒（`PSSecurityException`）⇒ 自动化一律用 **`.cjs`/`.mjs`** |
| 含中文的脚本 | 用 `.ps1` 会因 BOM 丢失按 GBK 解码 ⇒ 满屏乱码 + **假语法错误** ⇒ 用 Node 写 |
| `$host` | PowerShell 只读变量，别当循环变量名 |
| 验证脚本 | 在 `C:\Users\HSG\ego\qwenwork-verify\`（**刻意不入库**，`.gitignore` 的 `scripts/*` 会挡） |

---

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| `docs/agent-notes/providers-qwenwork-intl.md` | ★ 完整实测记录（本文件的详细版） |
| `E:\...\实测-千问办公国际站成功验证.md` | 真机实测原始数据 |
| `E:\...\结论-千问办公国际站最终核查.md` | 选型依据 |
| `E:\...\报告-千问办公QwenWork深度分析.md` | 深度分析 |

---

## 10. 给接手的 AI 的话

1. **先确认当前分支**：`git branch --show-current` 应为 `feat/qwenwork-intl-provider`；
2. **动代码前**先读懂 §4（尤其 §4.1 工具包装、§4.4 三池分离）；
3. **同步上游后必做**：`node sync-upstream.cjs --check`；
4. **报测试结果时说清归属**：是我引入的，还是基线就有的
   （判定：`git stash` 后在基线上复现；flaky 连跑 5 次看波动）；
5. **写守卫必须做负向验证**：故意改坏实现，确认断言真变红；
6. **不确定就停下问**，不要猜。
