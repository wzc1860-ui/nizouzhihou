import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildChatPrompt, buildDiaryPrompt, persona, corpus } from './lib/prompt.js';
import { aiReady, chat, diary, driverInfo } from './lib/llm.js';
import * as store from './lib/store.js';

const MAX_BODY = 32 * 1024;
const WINDOW = 60 * 1000;
const AI_LIMIT = +(process.env.NZZH_RATE_AI_PER_MIN || 30);
const DATA_LIMIT = +(process.env.NZZH_RATE_DATA_PER_MIN || 60);
const hits = new Map();

function allow(ip, cap) {
  const now = Date.now();
  const key = `${ip}|${cap}`;
  const rec = hits.get(key);
  if (!rec || now - rec.t0 > WINDOW) {
    hits.set(key, { t0: now, n: 1 });
    return true;
  }
  rec.n++;
  if (rec.n > cap) return false;
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v.t0 > WINDOW) hits.delete(k);
  }
  return true;
}

const s = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
const n = (v, lo, hi, dflt) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : dflt;
};

function factsOf(b) {
  return {
    sid: s(b.sid, 16).toUpperCase(),
    name: s(b.name, 24),
    species: s(b.species, 24),
    stage: s(b.stage, 8),
    days: n(b.days, 1, 100000, 1),
    hunger: n(b.hunger, 0, 100, 50),
    mood: n(b.mood, 0, 100, 50),
    feeds: n(b.feeds, 0, 1e7, 0),
    touches: n(b.touches, 0, 1e7, 0),
    talks: n(b.talks, 0, 1e7, 0)
  };
}

export async function handleApi(pathname, rawBody, ctx = {}) {
  const route = String(pathname || '').replace(/\/+$/, '');

  if (route === '/api/health') {
    const d = driverInfo();
    return { status: 200, json: { ok: true, ai: aiReady(), driver: d.driver, model: d.model,
      store: store.info(), cards: persona.cards.length, corpus: corpus.items.length } };
  }

  if (route !== '/api/chat' && route !== '/api/diary' && route !== '/api/save' && route !== '/api/restore') {
    return { status: 404, json: { ok: false, reason: 'no-route' } };
  }

  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    return { status: 400, json: { ok: false, reason: 'bad-json' } };
  }
  if (!body || typeof body !== 'object') return { status: 400, json: { ok: false, reason: 'bad-json' } };

  const ip = ctx.ip || 'local';

  if (route === '/api/chat' || route === '/api/diary') {
    if (!allow(ip, AI_LIMIT)) return { status: 429, json: { ok: false, reason: 'rate' } };
    const f = factsOf(body);
    if (!f.name) return { status: 400, json: { ok: false, reason: 'no-pet' } };

    if (route === '/api/chat') {
      f.text = s(body.text, 200);
      if (!f.text) return { status: 400, json: { ok: false, reason: 'empty' } };
      f.diary = (Array.isArray(body.diary) ? body.diary : []).slice(0, 2).map((d) => s(d, 120));
      const out = await chat(buildChatPrompt(f), f, persona.global.format.maxChars * 2);
      if (!out.text) return { status: 200, json: { ok: false, reason: 'empty', source: out.source } };
      return { status: 200, json: { ok: true, reply: out.text, source: out.source } };
    }

    f.kind = ['return', 'daily', 'grow'].includes(body.kind) ? body.kind : 'return';
    f.awayHours = n(body.awayHours, 0, 2160, 0);
    const out = await diary(buildDiaryPrompt(f), f);
    if (!out.text) return { status: 200, json: { ok: false, reason: 'empty', source: out.source } };
    return { status: 200, json: { ok: true, text: out.text, kind: f.kind, source: out.source } };
  }

  if (!allow(ip, DATA_LIMIT)) return { status: 429, json: { ok: false, reason: 'rate' } };
  const sid = s(body.sid, 16).toUpperCase();

  if (route === '/api/save') {
    const r = await store.putSave(sid, body.rev, body.save);
    return { status: r.ok ? 200 : 409, json: r };
  }

  const r = await store.getSave(sid);
  return { status: r.ok ? 200 : 404, json: r };
}

export function createApiServer() {
  const origin = process.env.NZZH_ALLOW_ORIGIN || '';
  return createServer(async (req, res) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        reply(res, 413, { ok: false, reason: 'too-large' }, origin);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (tooBig) return;
      const url = new URL(req.url || '/', 'http://local');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        reply(res, 404, { ok: false, reason: 'no-route' }, origin);
        return;
      }
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local';
      let out;
      try {
        out = await handleApi(url.pathname, Buffer.concat(chunks).toString('utf8'), { ip });
      } catch (e) {
        out = { status: 500, json: { ok: false, reason: 'server-error' } };
        if (process.env.NZZH_DEBUG) console.error('[api]', e && e.stack);
      }
      reply(res, out.status, out.json, origin);
    });
  });
}

function corsHeaders(origin) {
  return origin ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' } : {};
}

function reply(res, status, json, origin) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(origin) });
  res.end(JSON.stringify(json));
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain || process.env.NZZH_SERVE === '1') {
  const port = +(process.env.NZZH_PORT || 8787);
  createApiServer().listen(port, () => {
    console.log(`[nizouzhihou] api on :${port} · ai=${aiReady() ? driverInfo().driver : 'local-fallback'} · store=${JSON.stringify(store.info())} · cards=${persona.cards.length}`);
  });
}
