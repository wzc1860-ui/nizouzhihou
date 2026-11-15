import { persona, guard } from './prompt.js';
import { localReply, localDiary } from './local.js';

const BASE = () => (process.env.NZZH_AI_BASE || '').replace(/\/+$/, '');
const KEY = () => process.env.NZZH_AI_KEY || '';
const MODEL = () => process.env.NZZH_AI_MODEL || 'qwen-plus';

export function aiReady() {
  return !!(BASE() && KEY());
}

async function callModel(system, user, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 20000);
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

export async function chat(prompt, facts, maxChars) {
  if (aiReady()) {
    try {
      const text = await callModel(prompt.system, prompt.user);
      if (text) return { text: clip(text, maxChars), source: 'model' };
    } catch (e) {
      return { text: clip(localReply(facts), maxChars), source: 'local', warning: String(e.message || e) };
    }
  }
  return { text: clip(localReply(facts), maxChars), source: 'local' };
}

export async function diary(prompt, facts) {
  const cap = persona.global.format.maxChars * 5;
  if (aiReady()) {
    try {
      const text = await callModel(prompt.system, prompt.user);
      if (text) return { text: clip(text, cap), source: 'model' };
    } catch (e) {
      return { text: clip(localDiary(facts), cap), source: 'local', warning: String(e.message || e) };
    }
  }
  return { text: clip(localDiary(facts), cap), source: 'local' };
}

const clip = (t, max) => String(t).replace(/\s+/g, ' ').trim().slice(0, max);
