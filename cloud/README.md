# cloud/ — B 线服务端（AI 对话 / AI 日记 / 存档上云）

零依赖、Node 18+ 原生 ESM。前端只通过 `state.js` 的返回事件访问本目录的能力，**模型密钥不进仓库、不进前端**。

## 数据流

```
浏览器                         服务端（本目录）
index.html / app.js  视图层，只读状态
      ↓ 调用
   state.js          数据层，返回事件 { ok, reply / text / rev / source }
      ↓ fetch /api/*
server.js ──┬── prompt.js   人设卡 + 语料 + 当下事实 → prompt
            ├── llm.js      OpenAI 兼容 /chat/completions（密钥只在环境变量里）
            ├── local.js    无密钥 / 上游失败时的人设化兜底文案
            └── store.js    存档读写驱动（memory / file，Sites 数据库待接）
```

一期全部功能不依赖本目录：未部署、未配密钥、断网时，`state.js` 返回 `ok:false`，前端自动回落到 `app.js` 里既有的 `TALK_RULES` 与规则日记。

## 本地跑

```bash
cd cloud
node server.js        # 默认 :8787，无密钥时走 local.js 兜底
node test/smoke.js    # 22 条用例：契约兼容、降级、限流、注入、跨设备恢复
npm test              # 同上
```

`test/smoke.js` 用 `node:vm` 加最小浏览器替身加载 `state.js`，因此可以在没有 DOM 的环境下验证数据层契约（也顺带证明 `state.js` 不碰 DOM）。

## 环境变量（在 Qoder Sites Secret 中配置，不要写进 .env 提交）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `NZZH_AI_BASE` | 接真模型时必填 | OpenAI 兼容服务地址，不带尾斜杠，例如百炼兼容模式 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `NZZH_AI_KEY` | 接真模型时必填 | **唯一密钥项**。缺省时服务端只用 `local.js` 兜底，功能不中断 |
| `NZZH_AI_MODEL` | 否 | 缺省 `qwen-plus`；情感短句任务用 turbo 档足够 |
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
| `/api/health` | — | `{ ok, ai, store, cards, corpus }` |
| `/api/chat` | `{ sid, name, species, stage, days, hunger, mood, feeds, touches, talks, text, diary[] }` | `{ ok, reply, source }` |
| `/api/diary` | 同上 + `{ kind: return/daily/grow, awayHours }` | `{ ok, text, kind, source }` |
| `/api/save` | `{ sid, rev, save }` | `{ ok, rev }`；`rev` 不回退、`sid` 与存档内不一致、超过 60KB 均拒收 |
| `/api/restore` | `{ sid }` | `{ ok, save, rev, updatedAt }` |

`source` 为 `model`（走了真模型）或 `local`（兜底），可用于部署后核对密钥是否真的生效。

服务端只做输入裁剪与校验（长度、数值范围、控制字符、存档码字符集），**不接受前端传入的提示词或模型参数**；`prompt.js` / `persona.json` / `corpus.json` 只在服务端使用。用户文本始终以"台词素材"身份进入 prompt，且输出经 `guard()` 拦截泄露类回复。

## 存档码

领养时生成 12 位大写码（`crypto.getRandomValues`，31 字符去歧义字母表，约 59 bit），展示为 `XXXX-XXXX-XXXX`。它是唯一凭据：**知道码即可读走那份存档**，所以后端按码鉴权、不做账号体系（一期范围），码可在设置里由用户抄写用于跨设备恢复。云端永不静默覆盖本地——`state.js` 只在本地写盘后推送，恢复必须用户显式输入码。

## 11-20 部署到 Qoder Sites：能力边界与待办

已核实的官方约束（docs.qoder.com，2026-11-15）：

- 个人免费档**只支持静态站点托管，不支持数据库与存储服务**；
- Teams / Enterprise 档**不支持公开访问**，只能组织内共享 → 赛事要求"公开链接可匿名访问"，必须走个人档（付费才能用数据库）；
- Secret 通过 Sites 的"环境变量"配置，**值写入后不可读回**，符合密钥纪律；
- Sites 官方路径是"站点调用 Cloud Agents 服务"，可以不自己接模型、不要密钥；这与本项目"接 OpenAI 兼容端点 + Sites Secret"的方案二选一，见下方待办 P0。

本机没有 `qoder` CLI，Sites **函数运行时的数据面接口**（函数入口签名、数据库驱动注入方式）无法离线确认。按猜测实现会产生一版部署时才暴雷的代码，因此：

- 已提供 `handleApi(pathname, rawBody, ctx)`：无 HTTP 依赖的纯入口，Sites 函数运行时只需把请求 path/body/IP 转进来、把 `{ status, json }` 转出去；
- 已提供 `createApiServer()`：任何能跑 Node 的地方（含容器、函数计算 HTTP 触发器）可直接挂载；
- `store.js` 的 `getSave/putSave` 是驱动边界，`sites-db` 分支留待部署时按真实 SDK 补一个函数即可。

上线前必须现场核对的三项，已列入下面的清单。

## 部署与公开访问验证清单（11-20）

1. [ ] 确认账号档位是否含数据库/存储；不含则先决定：改用 Sites Agent 服务，或把 `cloud/` 部署到外部 Node，或砍掉 ④ 并在作品页明示"存档位于本机浏览器"。
2. [ ] 在 Sites Secret 配置 `NZZH_AI_BASE` / `NZZH_AI_KEY` / `NZZH_AI_MODEL`（若走 Agent 路线则跳过）。
3. [ ] 把 `handleApi` 接到 Sites 函数入口，路由前缀保持 `/api/*`，与静态页同源。
4. [ ] `GET /api/health` 返回 `ai:true` 且 `/api/chat` 的 `source` 为 `model` —— 这是"密钥确实生效"的唯一证据。
5. [ ] `store.info()` 指向持久卷或已切换 `sites-db`；重启实例后 `/api/restore` 仍能取回存档（临时目录会在实例回收时丢失）。
6. [ ] 访问策略切到"任何人可访问"并二次确认；用未登录的浏览器/手机流量打开公开链接，走完：领养 → 喂食 → 说话（出 AI 回复）→ 关页面 → 回归问候 + AI 日记 → 抄存档码 → 换设备恢复。
7. [ ] 弱网/断网各试一次，确认前端回落到规则文案且不报错（这是 §5.2 的降级约定）。
8. [ ] 控制台无报错，`/api/chat` 被限流时前端仍能正常对话（返回 `rate` 即视为通过）。

## 给 A 的接入点（本次未动 app.js / index.html）

契约变更已在 立项文档.md §5.2 / §5.6 落文，需要前端配合的最小改动：

- 启动时调一次 `aiConfig({ base })`；同源部署可不传。
- `sendTalk()`：先 `const r = await aiSay(input)`，`r.ok` 用 `r.reply`，否则走现有 `TALK_RULES`；`talk()` 的调用位置不变。
- `onReturn()` / 跨天 / `onGrew()`：可选地 `const d = await aiDiary(kind)`，成功则 `addDiary(d.text, 'ai')`，失败保持现有文案。
- 日记渲染可按 `d.by === 'ai'` 加一个极轻的标记；旧条目没有 `by` 字段，视为 `auto`。
- 设置区需要两个新元素（属结构改动，按 §6.3 先打招呼）：展示 `getSaveCode()`、以及一个输入码触发 `cloudPull(code)` 的入口；同步状态用 `cloudStatus()` 轮询即可，不需要读 DOM 之外的东西。
- 关页面时补一次同步：`save()` 的上云是 4 秒防抖，`pagehide` 时定时器不会触发，建议在现有的 `window.addEventListener('pagehide', save)` 旁改成 `() => { save(); cloudPush(); }`（`cloudPush` 自身幂等，失败就留到下次）。`state.js` 不能自己监听 DOM 事件，这一步必须在视图层。
