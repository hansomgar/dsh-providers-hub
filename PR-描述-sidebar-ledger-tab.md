## 这个 PR 做什么

在 DSH 右侧边栏的「开始」页加一张卡片：**JetHub 插件 Token 用量**。点它就在该面板新建一个标签页，直接看本机的 Token 账本。

| | 改动前 | 改动后 |
|---|---|---|
| 入口 | 只有 Jet Hub 页头那个**覆盖整屏**的弹窗 | 右侧栏「开始」页多一张卡 + 该面板内的标签页 |
| 与对话的关系 | 弹窗一开就得关，来回切换 | 与对话并排，写代码时瞄一眼 |
| 数据 | `usage.tokenLedger` / `history` / `deleteDay` | **同一份**（没有第二个数据源） |

> ⚠️ **本 PR 不含任何真实账号名、邮箱、地址或凭据**。所有示例值都是虚构的（见「关于样本」）。

---

## 为什么走 `sidebarRightTabs`

右侧栏的引导页（guide）与标签页是宿主**一等公民的扩展位**，三个官方/第三方包走的就是它：

| 包 | 用法 |
|---|---|
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | `sidebarRightTabs.register({ id, kind, guide: [...] })` |
| `@deepseek-ai/dsh-experimental-session-inspector` | 同上 + `slots.inject('sidebar.right.pane.tab', …)` |
| 第三方 `dsh-context` | 同上，两处槽位成对注册 |

引导卡被点时宿主自己执行 `tab.actions.openTab(kind, { replaceTab: true })` 再关掉引导页 —— 正是「就地换成新标签页」这个交互，**不需要自建浮层或 iframe**。

### 三处必须成对（缺一个就静默失效）

1. `sidebarRightTabs.register({ id, kind, guide })` —— 类型 + 那张卡；
2. `slots.inject('sidebar.right.pane.tab', …)`，且 **`key` 必须是 `definition.id`**
   （宿主按 `entryKey = definition.id` 精确查 keyed 槽；写 `kind` 时槽位**注册成功但永不被派发**，
   表现是「卡片点了正文空白」）；
3. `package.json` 的 `dsh.client.inject` 声明该包（只影响客户端模块**到达顺序**）。

### 对 `sidebarRightTabs` 是**软**依赖

`export const inject` **不**加 `sidebarRightTabs`：那是 cordis 的硬服务依赖，缺它的宿主上
**整条插件会不激活**（连账号面板都没了）。改用 `ctx.inject([...])`：服务不在就整段跳过，
插件其余功能照常。这与仓库既有的 `panel-entry.js`（`ctx.inject(['layout'], …)`）同一条写法。

---

## ⚠️ 窄面板必须用 `@container`，不能用 `@media`

右侧栏宽度是**视口**的 45%（`dsh-client-ui-layout` 的 `RIGHTBAR_DEFAULT_RATIO = .45`；
1440 视口 ≈ 648px，最低可拖到 300px）。

而账本现有的窄屏降级写的是 `@media (max-width: 700px)` —— **媒体查询看视口宽**，
1440 视口下这块面板**永远不触发它**。故内嵌形态下明细表（定宽列 + 模型列 `auto`）
会横向溢出、汇总树被挤变形。

新增的 `.dim-jh-ledgerPane` 用 `container-type: inline-size` +
`@container (max-width: 720px)` 按**面板**宽适配。本文件已在 `.dim-jh-accountMeta`
处采用同一手法（那里是为设置页窄卡片）。

---

## 改动面：6 个文件（+2 新增）

| 文件 | 改动 | 性质 |
|---|---|---|
| `plugin-src/client/ledger-tab.js` | **新增** | 注册接线（类型 + 引导卡 + 正文槽位） |
| `plugin-src/client/jet-hub.js` | +77 行 | 面板加 `chrome` 参数 + pane 外壳 + 测试导出 |
| `plugin-src/client/jet-hub-styles.js` | +45 行 | `.dim-jh-ledgerPane` + `@container` 块（**纯追加**） |
| `plugin-src/client/index.js` | +16 行 | 一处 import + 一次调用 |
| `package.json` | +1 行 | `dsh.client.inject` |
| `tests/unit/ledger-tab-wiring.spec.ts` | **新增** 12 条 | 注册接线行为守卫 |
| `tests/unit/ledger-pane-chrome.spec.ts` | **新增** 9 条 | 两种外壳的渲染守卫 |
| `tests/unit/index-entry-wiring.spec.ts` | +27 行 | 替身 `ctx` 补 `inject` 面 |
| `tests/unit/usage-badge-client.spec.ts` | +23/-4 行 | 放宽死写法（见下） |

### ⚠️ `modal` 分支**逐字节未改**

`tests/unit/token-ledger-panel.spec.ts` 用
`client.slice(modalIdx, client.indexOf('dim-jh-modalBody', modalIdx))`
切窗口断言 `dim-jh-modalHint` 与 `createElement('p', {…title:` —— 把 modal 的 JSX
抽成变量会让那个窗口立刻切空、**上游自己的用例当场变红**。

所以这里**不**做「共用同一份 JSX」的重构：两支各写一份外壳，内容三件套
（`renderHistory` / `renderSummary` / `renderEntries`）仍是同一份实现。
实测：modal 返回块 36 行与 `origin/master` 逐行相同（脚本比对）。

### ⚠️ 一处既有测试的放宽（放宽的是**写法**，不是**意图**）

`usage-badge-client.spec.ts` 原来用 `toEqual([...])` 把 `dsh.client.inject` 锁成
**精确数组** ⇒ 「加一条合法依赖」必然变红。改成逐条 `toContain`：仍锁「少一条就红」，
只是不再禁止新增。变异实测：删掉新增那行 ⇒ 精确变红并指出缺哪一条。

---

## 守卫与变异验证

| 守卫 | 条数 | 变异验证 |
|---|---|---|
| `ledger-tab-wiring.spec.ts` | 12 | **10 个变异，10 有牙，0 无牙** |
| `ledger-pane-chrome.spec.ts` | 9 | **10 个变异，10 有牙，0 无牙** |

覆盖的静默失效形态（每一条都是**不会报错**的）：

- `key` 用 `kind` ⇒ 卡片点了正文空白
- 正文组件去掉 `withErrorBoundary` ⇒ 渲染期异常卸载整棵树
- 引导卡 `order` 跑出邻居区间 ⇒ 卡片位置错乱
- `priority: 'builtin'` ⇒ 与宿主自带类型抢带宽
- 去掉「无 `ctx.inject`」「无服务」两处守卫 ⇒ 老宿主上抛 `TypeError`
- `keepMounted: false` ⇒ 每次切标签重拉账本
- 标题写成快照字符串 ⇒ 不跟随语言
- 不返回 disposer ⇒ 宿主无法注销
- `inject` 不下发 `rpcCall` ⇒ 正文拿不到数据
- pane 漏掉内容三件套之一 / 加回「完成」/ 包遮罩 / 用错容器类名 / 默认 chrome 改成 pane

⚠️ 其中 **一条变异第一轮是无牙的**（pane 把 `dim-jh-modalOverlay` 拼进**同一个**
`className` 字符串 ⇒ 整串不等于目标词）。判据已改为**按空白切词**再比，
复测有牙 —— 这条如实记录，因为「判据看着在、其实绕过了」正是本仓库记录过的形态。

## 全量验证

```
Test Files  535 passed | 2 skipped (537)
Tests      12811 passed | 26 skipped (12837)
tsc -p tsconfig.json --noEmit   exit 0
node plugin-src/client/build.mjs  注册 id = dsh-providers-hub
```

---

## 关于样本（PII）

| 位置 | 用什么 |
|---|---|
| 本 PR 正文 | 只有类名与端点名，**无任何账号数据** |
| `ledger-tab-wiring.spec.ts` | `session-1`（占位） |
| `ledger-pane-chrome.spec.ts` | `codearts-89d2d92a`（**形状示意**，与真实池 id 无关）、`deepseek-v4.1-flash`（公开模型名） |

实测用的真实账号名/地址/端口不写进任何公开位置。

---

## 兼容性

- **老宿主**（无 `sidebarRightTabs`）：整段跳过，插件其余功能**完全不受影响**；
- **没有账本数据**：沿用既有空态文案（「还没有任何请求记录」），不新增分支；
- **不改任何 RPC**：客户端只调已有的三个端点，宿主侧零改动；
- `chrome` 默认 `'modal'`，既有调用点（Jet Hub 页头）行为**逐字节不变**。
