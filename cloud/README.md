# cloud/ — B 线服务端（AI 对话 / AI 日记 / 存档上云）

零依赖、Node 18+ 原生 ESM。前端只通过 `state.js` 的返回事件访问本目录的能力，**模型密钥与 Qoder Token 不进仓库、不进前端**。

## 数据流

```
浏览器                         服务端（本目录）
index.html / app.js  视图层，只读状态
      ↓ 调用
   state.js          数据层，返回事件 { ok, reply / text / rev / source }
      ↓ fetch /api/*
server.js ──┬── prompt.js   人设卡 + 语料 + 当下事实 → prompt
            ├── llm.js      驱动选择：OpenAI 兼容端点 / Qoder Cloud Agents
            │   ├── agent.js   api.qoder.com/api/v1/cloud/*（Agent 路线，无模型密钥）
            │   └── local.js   无凭据 / 上游失败时的人设化兜底文案
            ├── store.js    存档读写驱动（memory / file，Sites 数据库待接）
            └── sites/      Sites 函数入口适配 + 上线前现场核对脚本
```

一期全部功能不依赖本目录：未部署、未配凭据、断网时，`state.js` 返回 `ok:false`，前端自动回落到 `app.js` 里既有的 `TALK_RULES` 与规则日记。

## 本地跑

```bash
cd cloud
node server.js             # 默认 :8787，未配凭据时走 local.js 兜底
node test/smoke.js         # 22 条用例：契约兼容、降级、限流、注入、跨设备恢复
node test/agent-mock.js    # 12 条用例：Qoder Cloud Agents 驱动（假网关回放文档响应形状）
npm test                   # 以上两条
```

`test/smoke.js` 用 `node:vm` 加最小浏览器替身加载 `state.js`，因此可以在没有 DOM 的环境下验证数据层契约（也顺带证明 `state.js` 不碰 DOM）。

## 两条 AI 路线

`lib/llm.js` 里有一层驱动选择，优先级是：**显式 `NZZH_AI_DRIVER` > 已配 `NZZH_AI_BASE`+`NZZH_AI_KEY` 走 openai > 已配 Qoder 凭据走 agent > 都没有则 local 兜底**。同一个包因此可以只带 Sites 的 Agent 凭据上线，也可以继续用 OpenAI 兼容端点；对前端的接口完全一致（`source` 仍是 `model` / `local`），换路线不改 `state.js`。

| 路线 | 需要 | 代价 | 说明 |
| --- | --- | --- | --- |
| `openai` | 一个模型 API Key | 按 token 计费，秒级返回 | 只发一句台词，`max_tokens` 锁在 160 |
| `agent` | PAT/SAT + Environment ID，**不需要模型 Key** | 一次对话 = 一个 Agent 回合，按 Credits 计费，首次有沙箱冷启动 | 走 `api.qoder.com/api/v1/cloud/*` |
| `local` | 无 | 零成本 | 人设化语料兜底，演示不中断 |

Agent 路线的实现要点（`lib/agent.js`；12 条用例逐条对着官方 API 参考校验请求与响应形状）：

- 一只宠物（按存档码 `sid`）在 30 分钟内复用同一个 Session，多轮记忆由服务端持有；不同宠物不共享 Session，人设不会互相污染。
- 演绎用的 Agent 名为 `nizouzhihou-voice`，**不配任何工具**：它只负责"照 system.message 里的人设说一句"，不执行命令、不反问。首次调用时自动创建，日志会打出它的 id，建议固定写进 `NZZH_QODER_AGENT_ID` 复用。
- 人设与语料每轮仍由服务端拼装成 `system.message` 下发；若网关版本不收 `system.message`，自动降级为并入 `user.message` 重发一次。
- 回合结束以 `session.status_idle` 为准，回复取本轮最后一条 `agent.message`（多步任务的开场白不会被当成最终回复）；事件分页用 `after_id` + `next_page` 游标。
- 同一宠物的请求在本进程排队：Session 正在处理上一轮时下发会得到 409，不排队就会丢回复。
- 超时（默认 30s）后发 `user.interrupt` 并丢弃该 Session，否则这个访客之后每轮都会撞 409；同时回落 `local`。空回复同理立刻回落，不耗满超时。
- 任何失败都不向上抛错，前端只看得到 `source:'local'`。

## 环境变量（写在 Qoder Sites 的环境变量/Secret 里，不要提交 .env）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `NZZH_AI_DRIVER` | 否 | `openai` / `agent` / `local`；缺省按上面优先级自动判定 |
| `NZZH_AI_BASE` | openai 路线必填 | OpenAI 兼容服务地址，不带尾斜杠，例如百炼兼容模式 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `NZZH_AI_KEY` | openai 路线必填 | **该路线唯一密钥项**；缺省时只用 `local.js` 兜底，功能不中断 |
| `NZZH_AI_MODEL` | 否 | openai 路线缺省 `qwen-plus`；情感短句任务用 turbo 档足够 |
| `NZZH_QODER_TOKEN` | agent 路线必填 | PAT（`Settings → Personal Access Tokens`）或用 SA Key 换取的 SAT。**性质与模型密钥相同，只放 Secret，过期需换**（SAT 最长 12 小时） |
| `NZZH_QODER_ENV_ID` | agent 路线必填 | Cloud Agents Environment id（`GET /api/v1/cloud/environments`；新账号需先建一个） |
| `NZZH_QODER_API` | 否 | 缺省 `https://api.qoder.com` |
| `NZZH_QODER_AGENT_ID` | 否 | 固定复用已创建的演绎 Agent，省掉首轮一次列表请求 |
| `NZZH_QODER_MODEL` | 否 | 自动建 Agent 时用的 model，缺省 `ultimate` |
| `NZZH_QODER_TIMEOUT_MS` | 否 | 单轮等待上限，缺省 30000，最低 5000 |
| `NZZH_QODER_SESSION_TTL_MS` | 否 | Session 复用窗口，缺省 1800000 |
| `NZZH_AI_TIMEOUT_MS` | 否 | openai 路线请求上限，缺省 20000 |
| `NZZH_STORE_DRIVER` | 否 | `memory`（默认进程内）/ `file`（本地开发）/ `sites-db`（待接，见下） |
| `NZZH_STORE_DIR` | 用 file 驱动时必填 | 落盘目录，**必须指向仓库之外**（默认 `os.tmpdir()/nizouzhihou-saves`），避免存档被误提交 |
| `NZZH_PORT` | 否 | 缺省 8787 |
| `NZZH_RATE_AI_PER_MIN` | 否 | 单 IP 每分钟 AI 调用上限，缺省 30 |
| `NZZH_RATE_DATA_PER_MIN` | 否 | 单 IP 每分钟存档读写上限，缺省 60 |
| `NZZH_ALLOW_ORIGIN` | 否 | 跨域调试用；同源部署留空即可（默认不发 CORS 头） |
| `NZZH_DEBUG` | 否 | 置 1 时把服务端异常栈打到日志 |

仓库根的 `.gitignore` 已覆盖 `.env` 与 `.env.*`；本目录不提供 `.env.example`（会被同一条规则忽略），配置项以本表为准。

## 接口

与 立项文档.md §5.2 一一对应，全部 POST + JSON，响应统一带 `ok`。

| 路由 | 入参 | 出参 |
| --- | --- | --- |
| `/api/health` | — | `{ ok, ai, driver, model, store, cards, corpus }` |
| `/api/chat` | `{ sid, name, species, stage, days, hunger, mood, feeds, touches, talks, text, diary[] }` | `{ ok, reply, source }` |
| `/api/diary` | 同上 + `{ kind: return/daily/grow, awayHours }` | `{ ok, text, kind, source }` |
| `/api/save` | `{ sid, rev, save }` | `{ ok, rev }`；`rev` 不回退、`sid` 与存档内不一致、超过 60KB 均拒收 |
| `/api/restore` | `{ sid }` | `{ ok, save, rev, updatedAt }` |

`source` 为 `model`（真走了模型/Agent）或 `local`（兜底），可用于部署后核对凭据是否真的生效。`/api/health` 的 `driver` 用来区分 `openai` / `agent` / `local`，便于两条路线共用同一份部署核对标准。

服务端只做输入裁剪与校验（长度、数值范围、控制字符、存档码字符集），**不接受前端传入的提示词或模型参数**；`prompt.js` / `persona.json` / `corpus.json` 只在服务端使用。用户文本始终以"台词素材"身份进入 prompt，且输出经 `guard()` 拦截泄露类回复。

## 存档码

领养时生成 12 位大写码（`crypto.getRandomValues`，31 字符去歧义字母表，约 59 bit），展示为 `XXXX-XXXX-XXXX`。它是唯一凭据：**知道码即可读走那份存档**，所以后端按码鉴权、不做账号体系（一期范围），码由用户自己抄下来用于跨设备恢复。云端永不静默覆盖本地——`state.js` 只在本地写盘后推送，恢复必须用户显式输入码。

## 部署到 Qoder Sites：已核实的能力边界（2026-11-15，docs.qoder.com）

> 2026-11-16 更新：本节为部署前的文档调研，其中"免费档无数据库"等结论已被实测推翻——本账号成功分配了 database + functions + qoder。实际部署方式见文末《实际部署》一节。

- **个人免费档只支持静态站点托管，不支持数据库与存储服务** → ④ 存档上云在免费档不成立，只能靠付费个人档，或外部 Node。
- **Teams / Enterprise 档不支持公开访问**（只能组织内共享）→ 赛事要求"公开链接可匿名访问"，必须走个人档。
- Sites 的能力形态是"站点调用 Cloud Agents + 站点的数据库与存储"，由内置的 Sites Skills（`sites:sites-building` / `sites-build-agent-app` / `sites-hosting` / `sites-management`）和 `qoder sites <operation>` 驱动；管理动作（发布、删除、改共享策略、删 Secret）带二次确认。
- Secret 通过 Sites 的环境变量配置，**值写入后不可读回**，符合密钥纪律；但要注意 Agent 路线下密钥换成了 PAT/SAT，**同样是密钥**，不能因为"不是模型 Key"就写进仓库或前端。
- Sites 的公开访问需要显式勾选"任何人可访问"并二次确认；发布默认只对本人可见。
- 站点会强制带 AI 生成内容标识（合规要求，不可移除）；上线文案要接受这一点。
- **函数运行时的数据面接口（入口签名、数据库驱动注入方式）没有公开文档**，只能通过 `qoder sites operations` / `describe <operation>` 在已登录环境里现场确认。按猜测实现会产出一版"部署时才暴雷"的代码，所以：
  - `handleApi(pathname, rawBody, ctx)`：无 HTTP 依赖的纯入口，`sites/function.js` 已按常见事件形状做容错转发（`path/body/isBase64Encoded/x-forwarded-for`），真实形状核对后收紧即可；
  - `createApiServer()`：任何能跑 Node 的地方（容器、函数计算 HTTP 触发器）可直接挂载；
  - `store.js` 的 `getSave/putSave` 是驱动边界，`sites-db` 分支留待部署时按真实 SDK 补一个函数；
  - `sites/probe.mjs`：上线前的现场核对脚本，只读探测 environments / agents / Sites 接口面，加 `--agent "话"` 才会真发一轮 Agent 对话（会创建 Session、消耗 Credits，需显式加参数）。Token 只从环境变量读，脚本输出统一脱敏。

本机（Qoder Desktop 会话）没有 `qoder` CLI，也没有 Sites 的 MCP/Skills 入口，因此**建站与发布这一步无法在这里执行**，需要在装有 Qoder CLI 并已登录的环境里跑。

## 部署与公开访问验证清单（11-20）

1. [ ] 确认账号档位是否含数据库/存储。不含则三选一：改用外部 Node 部署 `cloud/`；或砍掉 ④ 并在作品页明示"存档位于本机浏览器，跨设备需输码"；或升级个人付费档。
2. [ ] 在装有 Qoder CLI 的环境里跑 `qoder sites operations` + `describe`，把函数入口与数据库接口的真实形状贴回来，由我收紧 `sites/function.js` 与 `sites-db`。
3. [ ] 配置 Secret：Agent 路线填 `NZZH_QODER_TOKEN` / `NZZH_QODER_ENV_ID`（+建议 `NZZH_QODER_AGENT_ID`）；OpenAI 路线填 `NZZH_AI_BASE` / `NZZH_AI_KEY` / `NZZH_AI_MODEL`。
4. [ ] `node cloud/sites/probe.mjs` 通过；再 `node cloud/sites/probe.mjs --agent "我一个人待着有点难受"` 拿到一句真回复，记录耗时与 Credits 变化。
5. [ ] 把 `handleApi` 接到 Sites 函数入口，路由前缀保持 `/api/*`，与静态页同源；`GET /api/health` 返回 `ai:true` 且 `/api/chat` 的 `source` 为 `model` —— 这是"凭据确实生效"的唯一证据。
6. [ ] `store.info()` 指向持久存储或已切 `sites-db`；**重启/回收实例后** `/api/restore` 仍能取回存档（临时目录会在实例回收时丢失，这一条必须实测）。
7. [ ] 访问策略切到"任何人可访问"并二次确认；用未登录的浏览器/手机流量打开公开链接，走完：领养 → 喂食 → 说话（出 AI 回复）→ 关页面 → 回归问候 + AI 日记 → 抄存档码 → 换设备恢复。
8. [ ] 弱网/断网各试一次，确认前端回落到规则文案且不报错（§5.2 的降级约定）。
9. [ ] 控制台无报错；`/api/chat` 被限流时前端仍能正常对话（返回 `rate` 即视为通过）。
10. [ ] Agent 路线单独压一次"连点 10 下"：确认排队不丢回复、不出现 409 用户可见错误、Credits 消耗可接受；否则把 `NZZH_RATE_AI_PER_MIN` 调低或退回 `local` 演示模式。

## 给 A 的接入点（本次未动 app.js / index.html）

契约变更已在 立项文档.md §5.2 / §5.6 落文，需要前端配合的最小改动：

- 启动时调一次 `aiConfig({ base })`；同源部署可不传。
- `sendTalk()`：先 `const r = await aiSay(input)`，`r.ok` 用 `r.reply`，否则走现有 `TALK_RULES`；`talk()` 的调用位置不变。
- `onReturn()` / 跨天 / `onGrew()`：可选地 `const d = await aiDiary(kind)`，成功则 `addDiary(d.text, 'ai')`，失败保持现有文案。
- 日记渲染可按 `d.by === 'ai'` 加一个极轻的标记；旧条目没有 `by` 字段，视为 `auto`。
- 设置区需要两个新元素（属结构改动，按 §6.3 先打招呼）：展示 `getSaveCode()`、以及一个输入码触发 `cloudPull(code)` 的入口；同步状态用 `cloudStatus()` 轮询即可，不需要读 DOM 之外的东西。
- 关页面时补一次同步：`save()` 的上云是 4 秒防抖，`pagehide` 时定时器不会触发，建议在现有的 `window.addEventListener('pagehide', save)` 旁改成 `() => { save(); cloudPush(); }`（`cloudPush` 自身幂等，失败就留到下次）。`state.js` 不能自己监听 DOM 事件，这一步必须在视图层。

## 实际部署（2026-11-16，A 线在 Qoder Desktop 完成）

站点：https://after-you-leave-nbgg429dc5t.qoder.zone （公开访问）。后端能力 database + functions + qoder 已分配（function_backend 模型），PAT 由平台自动签发为 `QODER_PAT`，不需要手工配任何 Secret。

**真实运行时形状**（推翻 sites/function.js 的事件形状猜测）：Sites Function 是 Deno Edge，入口 `index.ts` + `Deno.serve(Request → Response)`；数据库 SDK 由 Worker 注入 `./_qoder/backend.mjs`（`createDatabaseClient()`，链式 from/select/eq/limit/update/insertIfAbsent）；浏览器走同源 `/functions/v1/app/api/*`，Gateway 把逻辑名 app 换成物理函数名并保留后缀。`sites/function.js` 与 `sites/probe.mjs` 保留作历史参考，不再是部署入口。

**代码组织**：

- `lib/api.js`：从 server.js 抽出的纯逻辑层 `handleApi`（无 Node 依赖），Node 与 Deno 共用；server.js 仍导出 `handleApi`，全部旧测试不变。
- `sites/store-db.js`：sites-db 存档驱动，与 file 驱动同一套校验/rev 语义；已有行用 (sid, rev) 条件更新做 CAS，新行 insertIfAbsent 防重。本地夹具测试 `dev/test-function-store.mjs`（5 用例）。
- `sites/index.ts`：Deno 入口。process.env  shim 后动态 import api.js；QCA origin 固定为 get_context 返回的 `https://api.qoder.com.cn`；首次 AI 请求时懒初始化：读 app.ai_state 绑定 → 缺 Environment 则按名 `nizouzhihou-env` 复用/创建 → 缺模型则 GET /models 选首个 enabled；绑定持久化首写者胜出。QCA 超时压到 10s（前端 12s/15s 先超时），任何失败回落 local。
- `scripts/build-function.mjs`：把 cloud/ 源码组装成自包含 `functions/` 包（prompt.js 的 fs 读 JSON 换成 JSON import attributes，其余逐字复制）。**改 cloud/lib 后必须重跑**。

**数据库**（app schema，function_backend 私有策略，匿名不可直连）：

- `app.saves(sid pk, rev, updated_at, save jsonb)` — 存档码即凭证，rev 单调。
- `app.ai_state(key pk, value jsonb, updated_at)` — QCA Agent/Environment/模型绑定。

**发布**：`node scripts/build-function.mjs` → 同步 dist/ → prepare_site（projectId 复用，functionDirectory: "functions"，databaseAccess: "read_write" + 当次 get_database_schema 的 schemaRef，secretNames 不需要）。前端 app.js 在 *.qoder.zone 域名下自动把 aiConfig base 指到 `/functions/v1/app`，本地仍可用 `?api=` 覆盖。

**已知边界**：QCA 资源发现按名复用 + DB 首写者胜出，跨实例并发冷启动理论上可能建出重复 Agent/Environment（同配置、无用户数据，可接受）；未实现 initialization.md 的完整 durable coordinator（本应用无跨会话历史恢复需求，Session 按 sid 30 分钟 TTL，失败一律降级）。
