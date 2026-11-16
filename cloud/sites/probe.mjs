/*
 * 上线前现场核对脚本。只读为主；--agent 会真的创建一个 Cloud Agents Session（消耗 Credits），需显式带参数。
 *
 *   export QODER_ACCESS_TOKEN=pt-xxxx                      # 只放在本机环境变量，不要写进文件、不要提交
 *   node cloud/sites/probe.mjs                             # 只读探测：环境 / Agent / Sites 接口面
 *   node cloud/sites/probe.mjs --agent "我一个人待着有点难受"  # 走一遍真实 Agent 对话链路
 */
import { buildChatPrompt } from '../lib/prompt.js';
import { agentAsk, agentInfo, agentReady } from '../lib/agent.js';

const TOKEN = process.env.QODER_ACCESS_TOKEN || process.env.NZZH_QODER_TOKEN || '';
const API = (process.env.NZZH_QODER_API || 'https://api.qoder.com').replace(/\/+$/, '');
process.env.NZZH_QODER_TOKEN = TOKEN;

const mask = (s) => String(s).replace(/(pt-|sk-|Bearer\s+)[A-Za-z0-9_-]{6,}/g, '$1***');
const show = (label, value) => console.log(`${label.padEnd(22)} ${mask(typeof value === 'string' ? value : JSON.stringify(value))}`);

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { accept: 'application/json', authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text: text.slice(0, 300) };
}
const get = (path) => req('GET', path);

if (!TOKEN) {
  console.log('缺少 QODER_ACCESS_TOKEN：请在本机环境变量里放 PAT，脚本不会把它写进任何文件。');
  process.exit(2);
}

show('endpoint', API);
const envs = await get('/api/v1/cloud/environments');
show('environments', envs.status === 200 ? (envs.json.data || []).map((e) => [e.id, e.name]) : `${envs.status} ${envs.text}`);
if (!process.env.NZZH_QODER_ENV_ID && envs.json && envs.json.data && envs.json.data[0]) {
  process.env.NZZH_QODER_ENV_ID = envs.json.data[0].id;
  show('use environment', process.env.NZZH_QODER_ENV_ID);
}

const agents = await get('/api/v1/cloud/agents');
show('agents', agents.status === 200 ? (agents.json.data || []).map((a) => [a.name, a.id, a.model]) : `${agents.status} ${agents.text}`);

const health = await get('/api/v1/cloud/sessions');
show('sessions list', `${health.status}${health.json && health.json.code ? ' ' + health.json.code : ''}`);

/* Sites 的操作目录是这套能力的真实入口：GET 拿到 4xx 就换 POST 再试一次。 */
const dumpOps = (json) => {
  const list = (json && (json.data || json.operations || json.items)) || [];
  if (!Array.isArray(list) || !list.length) return null;
  console.log(`\noperations（共 ${list.length} 项，${list.map((o) => (typeof o === 'string' ? o : o.name)).join(', ')}）`);
  return list;
};

let ops = null;
for (const attempt of [{ m: 'GET', p: '/api/v1/sites/operations' }, { m: 'POST', p: '/api/v1/sites/operations', b: {} },
  { m: 'GET', p: '/api/v1/sites' }]) {
  const r = await req(attempt.m, attempt.p, attempt.b);
  show(`${attempt.m} ${attempt.p}`, `${r.status}${r.json && r.json.code ? ' ' + r.json.code : ''}`);
  if (r.status === 200) ops = dumpOps(r.json);
  if (ops) break;
}

if (process.argv.includes('--describe')) {
  const target = process.argv[process.argv.indexOf('--describe') + 1];
  if (!target) console.log('用法：node probe.mjs --describe <operation>');
  for (const p of [`/api/v1/sites/${target}`, `/api/v1/sites/${target}/schema`, '/api/v1/sites/get_operation']) {
    const r = await req('GET', p, p === '/api/v1/sites/get_operation' ? { name: target } : undefined);
    console.log(`\n${p} -> ${r.status}\n${mask(r.text)}`);
  }
}

if (process.argv.includes('--agent')) {
  if (!agentReady()) {
    show('agent', '未就绪：需要 NZZH_QODER_ENV_ID（上面的 environments 探测会给出）');
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const text = argv.slice(argv.indexOf('--agent') + 1).join(' ').trim() || '我一个人待着有点难受';
  const facts = { sid: 'PROBE0000000', name: '小满', species: 'tuanzi', stage: '幼体', days: 3, hunger: 52, mood: 61,
    feeds: 2, touches: 4, talks: 1, text };
  const t0 = Date.now();
  try {
    const reply = await agentAsk(buildChatPrompt(facts).system, buildChatPrompt(facts).user, facts.sid);
    show('agent reply', reply);
    show('round trip ms', Date.now() - t0);
  } catch (e) {
    show('agent failed', `${e.status || ''} ${e.message}`);
    process.exitCode = 1;
  }
  show('agent state', agentInfo());
} else {
  console.log('\n未带 --agent：只做只读探测。要验证真实对话链路，再跑一次并加 --agent "想说的话"。');
}
