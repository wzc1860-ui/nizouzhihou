import { createServer } from 'node:http';
import assert from 'node:assert/strict';

process.env.NZZH_STORE_DRIVER = 'memory';
process.env.NZZH_AI_DRIVER = 'agent';
delete process.env.NZZH_AI_BASE;
delete process.env.NZZH_AI_KEY;
process.env.NZZH_QODER_TOKEN = 'pat-test';
process.env.NZZH_QODER_ENV_ID = 'env_test';
process.env.NZZH_QODER_TIMEOUT_MS = '6000';

const agent = await import('../lib/agent.js');
const { buildChatPrompt, buildDiaryPrompt, cardFor } = await import('../lib/prompt.js');
const { chat, diary, driver, aiReady, driverInfo } = await import('../lib/llm.js');

/* 按 cloud-agents API 参考复刻的假网关：只验证我们的调用形状，不代表线上行为。 */
function makeMock(rules = {}) {
  const seen = { posts: [], gets: 0 };
  const state = { running: false, seq: 0, events: [], sessionId: null };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock.local');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.method === 'GET') seen.gets++; else seen.posts.push({ path: url.pathname, method: req.method, body, auth: req.headers.authorization });
      if (req.method === 'GET' && url.pathname.endsWith('/agents')) return send(200, { data: rules.agents || [] });
      if (req.method === 'POST' && url.pathname.endsWith('/agents')) return send(200, { type: 'agent', id: 'agent_mock' });
      if (req.method === 'POST' && url.pathname.endsWith('/sessions')) {
        state.sessionId = `sess_${++state.seq}`;
        state.events = [];
        state.running = false;
        return send(200, { type: 'session', id: state.sessionId });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/events')) {
        const types = (body.events || []).map((e) => e.type);
        if (types.includes('user.interrupt')) { state.running = false; state.interrupted = true; return send(200, { data: [] }); }
        if (state.running && !rules.allowConcurrent) { state.conflicts = (state.conflicts || 0) + 1; return send(409, { type: 'error', error: { message: 'Session is currently processing a turn.' } }); }
        if (rules.conflictOnce && !state.conflicted) { state.conflicted = true; return send(409, { type: 'error', error: { message: 'Session is currently processing a turn.' } }); }
        if (rules.rejectSystem && types.includes('system.message')) return send(400, { type: 'error', error: { message: "Field 'system.message' is not supported." } });
        if (!Array.isArray(body.events) || body.events.length === 0) return send(400, { type: 'error', error: { message: 'empty events' } });
        const um = body.events.find((e) => e.type === 'user.message');
        if (!um || !Array.isArray(um.content) || !um.content.length) return send(400, { type: 'error', error: { message: "Field 'content' must be a non-empty array of content blocks." } });
        const ev = { id: `evt_u${state.events.length + 1}`, type: 'user.message', content: um.content, processed_at: new Date().toISOString() };
        state.events.push(ev);
        if (rules.neverFinish) { state.running = true; return send(200, { data: [ev] }); }
        if (rules.preamble) state.events.push({ id: `evt_p${ev.id}`, type: 'agent.message', content: [{ type: 'text', text: '（先想了想）' }], processed_at: new Date().toISOString() });
        state.events.push({ id: `evt_a${state.events.length + 1}`, type: 'agent.message', content: [{ type: 'text', text: rules.silent ? '' : (rules.reply || '嗯，我在。') }], processed_at: new Date().toISOString() });
        const finish = () => {
          state.events.push({ id: `evt_i${ev.id}`, type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: new Date().toISOString() });
          state.running = false;
        };
        if (rules.slow) { state.running = true; setTimeout(finish, rules.slow); } else finish();
        return send(200, { data: [ev] });
      }
      if (req.method === 'GET' && /\/events$/.test(url.pathname)) {
        seen.gets++;
        const after = url.searchParams.get('after_id');
        const idx = after ? state.events.findIndex((e) => e.id === after) : -1;
        const data = idx >= 0 ? state.events.slice(idx + 1) : state.events.slice();
        return send(200, { data, first_id: data[0] && data[0].id, last_id: data[data.length - 1] && data[data.length - 1].id, has_more: false, next_page: null });
      }
      return send(404, { type: 'error', error: { message: 'no route' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      state, seen,
      close: () => new Promise((r) => server.close(r))
    }));
  });
}

/* 每个用例都换一个干净的模块状态，避免 Session 缓存跨用例串味。 */
async function withMock(rules, fn) {
  const mock = await makeMock(rules);
  process.env.NZZH_QODER_API = `http://127.0.0.1:${mock.port}`;
  process.env.NZZH_QODER_TOKEN = 'pat-test';
  process.env.NZZH_QODER_ENV_ID = 'env_test';
  agent.resetAgent();
  try {
    await fn(mock);
  } finally {
    await mock.close();
  }
}

const F = (over) => ({ sid: 'ABCDABCDABCD', name: '小满', species: 'tuanzi', stage: '幼体', days: 3,
  hunger: 55, mood: 60, feeds: 2, touches: 4, talks: 1, text: '在吗', ...over });

const results = [];
let n = 0;
const step = async (label, fn) => {
  n++;
  try {
    await fn();
    results.push(`  ok   ${n}. ${label}`);
  } catch (e) {
    results.push(`  FAIL ${n}. ${label}\n       ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')}`);
    process.exitCode = 1;
  }
};

await step('只有 Qoder 凭据也算 AI 就绪，且不需要模型密钥', () => withMock({}, async () => {
  assert.equal(driver(), 'agent');
  assert.equal(aiReady(), true);
  assert.equal(driverInfo().model, 'ultimate');
  assert.equal(driverInfo().detail.agent, null, '未发过请求时不该已经建好 Agent');
}));

await step('首轮形状：建零工具 Agent → 建 Session → user.message 在前、system.message 在后', async () => {
  const f = F({});
  await withMock({ reply: '我在。你来了，我这边就亮了。' }, async (mock) => {
    const out = await chat(buildChatPrompt(f), f, 48);
    assert.equal(out.source, 'model', JSON.stringify(out));
    assert.equal(out.text, '我在。你来了，我这边就亮了。');
    const [agentPost, sessionPost, turnPost] = mock.seen.posts;
    assert.equal(agentPost.method, 'POST');
    assert.deepEqual(Object.keys(agentPost.body).sort(), ['model', 'name', 'system'], 'Agent 不配工具，人设每轮现发');
    assert.equal(agentPost.body.name, 'nizouzhihou-voice');
    assert.deepEqual(sessionPost.body, { agent: 'agent_mock', environment_id: 'env_test' });
    assert.deepEqual(turnPost.body.events.map((e) => e.type), ['user.message', 'system.message']);
    assert.match(turnPost.body.events[0].content[0].text, /主人说/);
    assert.match(turnPost.body.events[1].content[0].text, /性格内核/);
    assert.ok(mock.seen.posts.every((p) => p.auth === 'Bearer pat-test'));
    assert.ok(mock.seen.gets >= 1, '应通过 list events 读取回复，而不是解析 POST 返回');
  });
});

await step('多步回合并未把开场白当最终回复', () => withMock({ preamble: true, reply: '最终那句。' }, async (mock) => {
  const f = F({});
  const out = await chat(buildChatPrompt(f), f, 48);
  assert.equal(out.text, '最终那句。', JSON.stringify(out));
}));

await step('同一只宠物第二轮复用 Session，不再重复建 Agent/Session', async () => {
  const f = F({});
  await withMock({ reply: '我一直在。' }, async (mock) => {
    await chat(buildChatPrompt(f), f, 48);
    mock.seen.posts.length = 0;
    const second = await chat(buildChatPrompt(F({ text: '你是谁' })), f, 48);
    assert.equal(second.text, '我一直在。');
    assert.equal(mock.seen.posts.filter((p) => /\/agents$/.test(p.path)).length, 0);
    assert.equal(mock.seen.posts.filter((p) => /\/sessions$/.test(p.path)).length, 0, '不应重复建 Session');
    assert.equal(mock.state.sessionId, 'sess_1');
  });
});

await step('网关不收 system.message 时自动降级为合并下发', async () => {
  const f = F({});
  await withMock({ rejectSystem: true, reply: '嗯，我在听。' }, async (mock) => {
    const out = await chat(buildChatPrompt(f), f, 48);
    assert.equal(out.source, 'model', JSON.stringify(out));
    const turns = mock.seen.posts.filter((p) => /\/events$/.test(p.path));
    assert.deepEqual(turns.map((p) => p.body.events.length), [2, 1], '应先试双事件，被拒后单事件重发');
    assert.match(turns[1].body.events[0].content[0].text, /性格内核[\s\S]*主人说/);
  });
});

await step('不同宠物各占一个 Session，人设不互相污染', async () => {
  await withMock({ reply: '（点头）' }, async (mock) => {
    const a = F({});
    const b = F({ sid: 'EFGHEFGHEFGH', species: 'huihui' });
    await chat(buildChatPrompt(a), a, 48);
    await chat(buildChatPrompt(b), b, 48);
    assert.equal(mock.state.sessionId, 'sess_2', '两只宠物应各建一个 Session');
    const turns = mock.seen.posts.filter((p) => /\/sessions\/.+\/events$/.test(p.path));
    assert.ok(JSON.stringify(turns[0].body).includes(cardFor('tuanzi').core));
    assert.ok(JSON.stringify(turns[1].body).includes(cardFor('huihui').core));
    assert.equal(agent.agentInfo().cached_sessions, 2);
  });
});

await step('并发同一只宠物排队执行，服务端不会看到两轮同时在跑', async () => {
  const f = F({});
  await withMock({ slow: 400, reply: '排队后的回复。' }, async (mock) => {
    const all = await Promise.all([chat(buildChatPrompt(f), f, 48), chat(buildChatPrompt(f), f, 48),
      diary(buildDiaryPrompt({ ...f, kind: 'return', awayHours: 5 }), { ...f, kind: 'return', awayHours: 5 })]);
    assert.deepEqual(all.map((r) => r.source), ['model', 'model', 'model'], JSON.stringify(all));
    assert.equal(mock.state.conflicts || 0, 0, '并发下发会撞 409，说明进程内排队没生效');
    assert.equal(mock.state.sessionId, 'sess_1', '排队应复用同一个 Session');
  });
});

await step('409 视为 Session 忙：等待后重发，不丢回复', () => withMock({ conflictOnce: true, reply: '重试成功。' }, async (mock) => {
  const f = F({});
  const out = await chat(buildChatPrompt(f), f, 48);
  assert.equal(out.text, '重试成功。', JSON.stringify(out));
  assert.equal(mock.seen.posts.filter((p) => /\/sessions\/.+\/events$/.test(p.path)).length, 2, '应恰好重发一次');
}));

await step('超时：发 user.interrupt 并丢弃坏 Session，回落本地语料且下一轮换新 Session', async () => {
  const f = F({});
  await withMock({ neverFinish: true }, async (mock) => {
    const t0 = Date.now();
    const out = await chat(buildChatPrompt(f), f, 48);
    assert.equal(out.source, 'local', JSON.stringify(out));
    assert.ok(/timeout/.test(out.warning || ''), `回落原因应指向超时，实际 ${out.warning}`);
    assert.ok(Date.now() - t0 < 15000, '不应无限等待');
    assert.ok(mock.state.interrupted, '超时后必须打断回合，否则这个访客之后每轮 409');
    assert.equal(agent.agentInfo().cached_sessions, 0, '坏 Session 应被丢弃');
  });
});

await step('Agent 回空文本时立刻回落本地，不死等到超时', async () => {
  const f = F({});
  await withMock({ silent: true }, async () => {
    const t0 = Date.now();
    const out = await chat(buildChatPrompt(f), f, 48);
    assert.equal(out.source, 'local', JSON.stringify(out));
    assert.match(out.warning || '', /no text/, `回落原因应指向空回复，实际 ${out.warning}`);
    assert.ok(Date.now() - t0 < 4000, '一轮结束就该回落，不该耗满超时');
  });
});

await step('Token / Env 缺失时判为未就绪，接口整体回落本地而不是报错', async () => {
  const f = F({});
  delete process.env.NZZH_QODER_ENV_ID;
  assert.equal(driver(), 'agent');
  assert.equal(aiReady(), false);
  const out = await chat(buildChatPrompt(f), f, 48);
  assert.equal(out.source, 'local');
  assert.equal(out.warning, undefined, '未配置属正常状态，不该记成警告');
  const { handleApi } = await import('../server.js');
  const r = await handleApi('/api/chat', JSON.stringify(f), { ip: 'agent-unset' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.source, 'local');
  const h = await handleApi('/api/health', '', { ip: 'agent-unset' });
  assert.equal(h.json.ai, false);
  process.env.NZZH_QODER_ENV_ID = 'env_test';
});

await step('人设与语料在 Agent 路线下仍是服务端拼装，客户端参数不参与', async () => {
  const f = F({ species: 'yueliangquan' });
  await withMock({}, async (mock) => {
    await chat(buildChatPrompt(f), f, 48);
    const sys = mock.seen.posts.filter((p) => /\/events$/.test(p.path)).pop().body.events[1].content[0].text;
    assert.ok(sys.includes(cardFor('yueliangquan').core));
    assert.ok(sys.includes('绝对不可以说'));
    assert.doesNotMatch(JSON.stringify(mock.seen.posts), /api\.qoder\.com|NZZH_|sk-/);
  });
});

console.log(results.join('\n'));
console.log(process.exitCode ? `\n存在失败用例` : `\n${results.length} 个用例全部通过`);
