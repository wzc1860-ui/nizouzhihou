import { persona, guard } from './prompt.js';
import { localReply, localDiary } from './local.js';
import { agentReady, agentAsk, agentInfo } from './agent.js';

const BASE = () => (process.env.NZZH_AI_BASE || '').replace(/\/+$/, '');
const KEY = () => process.env.NZZH_AI_KEY || '';
const MODEL = () => process.env.NZZH_AI_MODEL || 'qwen-plus';
const TIMEOUT = () => Math.max(3000, +(process.env.NZZH_AI_TIMEOUT_MS || 20000));

/* 驱动优先级：显式 NZZH_AI_DRIVER > 已配好的 OpenAI 兼容密钥 > 已配好的 Qoder Agent > 无密钥本地兜底。 */
export function driver() {
  const want = String(process.env.NZZH_AI_DRIVER || '').trim().toLowerCase();
  if (want) return want === 'agent' || want === 'qoder-agent' ? 'agent' : want === 'local' ? 'local' : 'openai';
  if (BASE() && KEY()) return 'openai';
  return agentReady() ? 'agent' : 'local';
}

export function aiReady() {
  const d = driver();
  if (d === 'agent') return agentReady();
  return d === 'openai';
}

export function driverInfo() {
  const d = driver();
  return { driver: d, model: d === 'openai' ? MODEL() : (d === 'agent' ? agentInfo().model : null),
    detail: d === 'agent' ? agentInfo() : (d === 'openai' ? { base: BASE() } : null) };
}

async function callOpenai(system, user) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT());
  try {
    const res = await fetch(`${BASE()}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY()}` },
      body: JSON.stringify({
        model: MODEL(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.9,
        top_p: 0.95,
        max_tokens: 160,
        stream: false
      })
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const json = await res.json();
    const text = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    return guard(text);
  } finally {
    clearTimeout(timer);
  }
}

async function generate(prompt, facts) {
  const d = driver();
  if (d === 'agent') return guard(await agentAsk(prompt.system, prompt.user, facts.sid || facts.name || ''));
  if (d === 'openai') return guard(await callOpenai(prompt.system, prompt.user));
  return '';
}

/* 生成失败 / 无凭据时一律回落本地语料，保证公开访问时不会出现"没配密钥就哑掉"。 */
async function run(prompt, facts, local, maxChars) {
  if (aiReady()) {
    try {
      const text = await generate(prompt, facts);
      if (text) return { text: clip(text, maxChars), source: 'model' };
      return { text: clip(local(facts), maxChars), source: 'local', warning: 'empty-model-output' };
    } catch (e) {
      return { text: clip(local(facts), maxChars), source: 'local', warning: String(e.message || e) };
    }
  }
  return { text: clip(local(facts), maxChars), source: 'local' };
}

const clip = (t, max) => String(t).replace(/\s+/g, ' ').trim().slice(0, max);

export const chat = (prompt, facts, maxChars) => run(prompt, facts, localReply, maxChars);

export const diary = (prompt, facts) => run(prompt, facts, localDiary, persona.global.format.maxChars * 5);
