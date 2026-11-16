import { createDatabaseClient } from './_qoder/backend.mjs';

/*
 * Sites Edge Function 入口（Deno）。逻辑层复用 cloud/lib/api.js（经 scripts/build-function.mjs 组装）。
 * QCA 凭据只读平台注入的 QODER_PAT；origin 来自 sites get_context.runtime.cloudAgents.apiOrigin（cn prod）。
 * Agent/Environment/模型绑定持久化在 app.ai_state（首个写入者胜出），冷启动先读绑定再发现缺失资源。
 * 任何 QCA/数据库失败都不抛给访客：AI 回落本地语料，存档返回安全错误码。
 */

const QCA_ORIGIN = 'https://api.qoder.com.cn';
const ENV_NAME = 'nizouzhihou-env';
const MAX_BODY = 32 * 1024;

const denoEnv = Deno.env.toObject();
const proc: any = (globalThis as any).process || ((globalThis as any).process = {});
proc.env = Object.assign({}, denoEnv, proc.env || {});
proc.env.NZZH_QODER_API = proc.env.NZZH_QODER_API || QCA_ORIGIN;
proc.env.NZZH_QODER_TIMEOUT_MS = proc.env.NZZH_QODER_TIMEOUT_MS || '10000';
if (denoEnv.QODER_PAT) proc.env.NZZH_QODER_TOKEN = denoEnv.QODER_PAT;

const db = createDatabaseClient();
const { handleApi } = await import('./api.js');

const listOf = (r: any) => (Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []));

async function qca(path: string, init: RequestInit = {}) {
  const res = await fetch(`${proc.env.NZZH_QODER_API}/api/v1/cloud${path}`, {
    ...init,
    signal: AbortSignal.timeout(15000),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${proc.env.NZZH_QODER_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!res.ok) throw new Error(`qca ${res.status}`);
  return res.json();
}

let aiBoot: Promise<void> | null = null;
async function ensureAi() {
  if (!proc.env.NZZH_QODER_TOKEN) return;
  aiBoot = aiBoot || (async () => {
    try {
      const row = await db.from('ai_state').select('value').eq('key', 'qca').limit(1);
      const b = (row.data && row.data[0] && row.data[0].value) || {};
      if (b.env) proc.env.NZZH_QODER_ENV_ID = b.env;
      if (b.agent) proc.env.NZZH_QODER_AGENT_ID = b.agent;
      if (b.model) proc.env.NZZH_QODER_MODEL = b.model;
      if (!proc.env.NZZH_QODER_ENV_ID) {
        const hit = listOf(await qca('/environments?limit=100')).find((e: any) => e && e.name === ENV_NAME);
        const env = hit || await qca('/environments', {
          method: 'POST',
          body: JSON.stringify({ name: ENV_NAME, config: { type: 'cloud' } })
        });
        if (env && env.id) proc.env.NZZH_QODER_ENV_ID = env.id;
      }
      if (!proc.env.NZZH_QODER_MODEL) {
        const hit = listOf(await qca('/models')).find((m: any) => m && m.id && m.enabled !== false);
        if (hit) proc.env.NZZH_QODER_MODEL = hit.id;
      }
    } catch (e) {
      console.warn('[ai-boot]', String((e && (e as Error).message) || e));
    }
  })();
  await aiBoot;
  if (!proc.env.NZZH_QODER_ENV_ID) aiBoot = null;
}

let agentMod: any = null;
let persisted = false;
async function persistBindings() {
  if (persisted || !proc.env.NZZH_QODER_TOKEN) return;
  try {
    agentMod = agentMod || await import('./agent.js');
    const info = agentMod.agentInfo();
    const value = {
      agent: info.agent || null,
      env: proc.env.NZZH_QODER_ENV_ID || null,
      model: proc.env.NZZH_QODER_MODEL || null
    };
    if (!value.agent && !value.env) return;
    const i = await db.from('ai_state')
      .insertIfAbsent({ key: 'qca', value, updated_at: Date.now() }, { onConflict: 'key' })
      .select('key');
    if (!i.error) persisted = true;
  } catch (e) {
    console.warn('[ai-bind]', String((e && (e as Error).message) || e));
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

async function readBody(request: Request): Promise<string | null> {
  const reader = request.body && request.body.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(bytes);
}

Deno.serve(async (request: Request) => {
  try {
    const url = new URL(request.url);
    // Gateway 把逻辑名 app 换成物理函数名并保留后缀；Provider 可能剥掉 /functions/v1。
    const m = url.pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
    const path = (m ? (m[1] || '/') : url.pathname).replace(/\/+$/, '');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (!path.startsWith('/api/')) return json(404, { ok: false, reason: 'no-route' });

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'sites';

    if (path === '/api/health') {
      if (request.method !== 'GET') return json(405, { ok: false, reason: 'method' });
      const out = await handleApi(path, '', { ip });
      return json(out.status, out.json);
    }
    if (request.method !== 'POST') return json(405, { ok: false, reason: 'method' });

    const body = await readBody(request);
    if (body === null) return json(413, { ok: false, reason: 'too-large' });

    const isAi = path === '/api/chat' || path === '/api/diary';
    if (isAi) await ensureAi();
    const out = await handleApi(path, body, { ip });
    if (isAi) await persistBindings();
    return json(out.status, out.json);
  } catch (e) {
    console.error('[entry]', String((e && (e as Error).stack) || e));
    return json(500, { ok: false, reason: 'server-error' });
  }
});