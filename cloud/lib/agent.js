import { persona } from './prompt.js';

const MODEL = () => process.env.NZZH_QODER_MODEL || 'ultimate';
const API = () => (process.env.NZZH_QODER_API || 'https://api.qoder.com').replace(/\/+$/, '');
const TOKEN = () => process.env.NZZH_QODER_TOKEN || '';
const ENV_ID = () => process.env.NZZH_QODER_ENV_ID || '';
const AGENT_ID = () => process.env.NZZH_QODER_AGENT_ID || '';
const TIMEOUT = () => Math.max(5000, +(process.env.NZZH_QODER_TIMEOUT_MS || 30000));
const SESSION_TTL = Math.max(60000, +(process.env.NZZH_QODER_SESSION_TTL_MS || 30 * 60 * 1000));

/* Agent 本身不配工具：它唯一的工作是把 system.message 里的人设说一句台词，避免它去执行命令或反问。 */
const AGENT_SYSTEM = '你是文本角色扮演执行器。调用方会用 system.message 给出完整人设与台词素材：只按人设输出要说的话本身，不使用工具，不解释，不复述规则，不提问。';
const AGENT_NAME = 'nizouzhihou-voice';

const sessions = new Map();
const locks = new Map();
const state = { agent: AGENT_ID() || null };

export function agentReady() {
  return !!(TOKEN() && ENV_ID());
}

class AgentError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(path, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT());
  try {
    const res = await fetch(`${API()}/api/v1/cloud${path}`, {
      ...init,
      signal: ctl.signal,
      headers: { accept: 'application/json', authorization: `Bearer ${TOKEN()}`, 'content-type': 'application/json', ...(init.headers || {}) }
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const msg = (json && ((json.error && json.error.message) || json.message)) || `qoder ${res.status}`;
      throw new AgentError(`${msg} [${path.split('?')[0]}]`, res.status);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const listOf = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []));
const textOf = (e) => (e.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureAgent() {
  if (state.agent) return state.agent;
  const hit = listOf(await call('/agents?limit=100')).find((a) => a.name === AGENT_NAME);
  if (hit) {
    state.agent = hit.id;
  } else {
    const created = await call('/agents', {
      method: 'POST',
      body: JSON.stringify({ name: AGENT_NAME, model: MODEL(), system: AGENT_SYSTEM })
    });
    state.agent = created && created.id;
    if (!state.agent) throw new AgentError('qoder agent create failed', 500);
    console.warn(`[qoder-agent] 已创建零工具演绎 Agent：${state.agent}（建议写进 NZZH_QODER_AGENT_ID 固定复用）`);
  }
  return state.agent;
}

/* 同一只宠物在 TTL 内复用 Session：多轮对话的记忆由服务端持有，过期才换新的。 */
async function sessionFor(key) {
  const rec = sessions.get(key);
  if (rec && Date.now() - rec.at < SESSION_TTL) return rec;
  const agent = await ensureAgent();
  const created = await call('/sessions', { method: 'POST', body: JSON.stringify({ agent, environment_id: ENV_ID() }) });
  if (!created || !created.id) throw new AgentError('qoder session create failed', 500);
  const fresh = { key, id: created.id, at: Date.now() };
  sessions.set(key, fresh);
  return fresh;
}

async function postEvents(rec, events) {
  return call(`/sessions/${rec.id}/events`, { method: 'POST', body: JSON.stringify({ events }) });
}

async function sendTurn(rec, system, user) {
  const events = [{ type: 'user.message', content: [{ type: 'text', text: user }] },
    { type: 'system.message', content: [{ type: 'text', text: system }] }];
  let sent;
  try {
    sent = await postEvents(rec, events);
  } catch (e) {
    /* 400 多半是这个版本不收 system.message：退回把规则并进 user.message 的写法。 */
    if (e.status !== 400) throw e;
    sent = await postEvents(rec, [{ type: 'user.message', content: [{ type: 'text', text: `${system}\n\n${user}` }] }]);
  }
  const anchor = listOf(sent).find((ev) => ev.type === 'user.message');
  if (!anchor || !anchor.id) throw new AgentError('qoder send returned no event id', 502);
  return anchor.id;
}

/* 本轮结束 = 出现 session.status_idle；取本轮最后一条 agent.message，因为多步任务里开场白不是最终回复。 */
async function readTurn(rec, anchor) {
  let cursor = `after_id=${encodeURIComponent(anchor)}&order=asc`;
  for (let page = 0; page < 5; page++) {
    const r = await call(`/sessions/${rec.id}/events?${cursor}&limit=100`);
    const events = listOf(r);
    if (events.some((e) => e.type === 'session.status_idle')) {
      const reply = events.filter((e) => e.type === 'agent.message' && !e.is_error).pop();
      /* 空回复也算"这轮结束了"：交给上层回落本地语料，别再死等到超时。 */
      return { done: true, text: reply ? textOf(reply) : '' };
    }
    if (!r || !r.has_more || !r.next_page) return { done: false };
    cursor = `page=${encodeURIComponent(r.next_page)}`;
  }
  return { done: false };
}

async function askOnce(rawSystem, user, key) {
  const rec = await sessionFor(key);
  const deadline = Date.now() + TIMEOUT();
  try {
    /* 409 = Session 正被别的实例占用：等它空出来再发，绝不并发开两轮。 */
    for (;;) {
      try {
        const anchor = await sendTurn(rec, rawSystem, user);
        while (Date.now() < deadline) {
          const turn = await readTurn(rec, anchor);
          if (turn.done) {
            rec.at = Date.now();
            if (!turn.text) throw new AgentError('qoder agent returned no text', 502);
            return turn.text;
          }
          await sleep(700);
        }
        throw new AgentError('qoder agent timeout', 504);
      } catch (e) {
        if (e.status === 409 && Date.now() < deadline) {
          await sleep(900);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    if (e.status === 404 || e.status === 410 || e.status === 504) sessions.delete(key);
    /* 超时不回合并弃用 Session，它会一直 running，这个访客之后每轮都撞 409。 */
    if (e.status === 504) {
      try {
        await postEvents(rec, [{ type: 'user.interrupt' }]);
      } catch (e2) {}
    }
    throw e;
  }
}

/* 排队按宠物键而不是按 Session 对象：首次提问并发进来时 Session 还不存在，否则一次点击会建出好几个 Session。 */
export async function agentAsk(rawSystem, user, key) {
  const id = key || 'anonymous';
  let lock = locks.get(id);
  if (!lock) {
    lock = { tail: Promise.resolve(), waiting: 0 };
    locks.set(id, lock);
  }
  lock.waiting++;
  const work = lock.tail.then(() => askOnce(rawSystem, user, id));
  lock.tail = work.then(() => {}, () => {});
  const release = () => {
    if (--lock.waiting === 0 && locks.get(id) === lock) locks.delete(id);
  };
  work.then(release, release);
  return work;
}

export function resetAgent() {
  sessions.clear();
  locks.clear();
  state.agent = AGENT_ID() || null;
}

export const agentInfo = () => ({ api: API(), env: ENV_ID() || null, agent: state.agent, model: MODEL(),
  session_ttl_ms: SESSION_TTL, timeout_ms: TIMEOUT(), cached_sessions: sessions.size, max_chars: persona.global.format.maxChars });
