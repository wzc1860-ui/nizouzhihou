import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { handleApi } from './lib/api.js';
import { aiReady, driverInfo } from './lib/llm.js';
import { persona } from './lib/prompt.js';
import * as store from './lib/store.js';

export { handleApi };

const MAX_BODY = 32 * 1024;

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