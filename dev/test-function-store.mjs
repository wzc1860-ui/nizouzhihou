import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// 内存假库：模拟 Sites 注入 SDK 的 from/select/eq/limit/update/insertIfAbsent 链式契约。
function fakeDb(failReads = false) {
  const tables = { saves: new Map(), ai_state: new Map() };
  const match = (row, filters) => filters.every(([k, v]) => row[k] === v);
  return {
    tables,
    from(t) {
      const st = { filters: [], mode: 'select', payload: null, conflict: null, limitN: Infinity };
      const exec = () => {
        const rows = tables[t];
        if (st.mode === 'select') {
          if (failReads) return { data: null, error: { code: 'fake_down' } };
          const hit = [...rows.values()].filter((r) => match(r, st.filters)).slice(0, st.limitN);
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (st.mode === 'update') {
          const hit = [...rows.values()].filter((r) => match(r, st.filters));
          hit.forEach((r) => Object.assign(r, st.payload));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        const key = st.conflict;
        const dup = [...rows.values()].some((r) => r[key] === st.payload[key]);
        if (dup) return { data: [], error: null };
        rows.set(st.payload[key], { ...st.payload });
        return { data: [{ ...st.payload }], error: null };
      };
      const api = {
        select() { return api; },
        eq(k, v) { st.filters.push([k, v]); return api; },
        limit(n) { st.limitN = n; return api; },
        update(p) { st.mode = 'update'; st.payload = p; return api; },
        insertIfAbsent(p, o) { st.mode = 'insert'; st.payload = p; st.conflict = o.onConflict; return api; },
        then(res, rej) { Promise.resolve().then(exec).then(res, rej); }
      };
      return api;
    }
  };
}

// store-db.js 顶部 import 注入模块，本地用替身替换后导入（与部署包同一份逻辑源码）。
const src = await readFile(join(root, 'cloud', 'sites', 'store-db.js'), 'utf8');
const stub = src.replace(
  "import { createDatabaseClient } from './_qoder/backend.mjs';",
  'const createDatabaseClient = () => globalThis.__fakeDb;'
);
const tmp = join(here, '.tmp-store-db.mjs');
await writeFile(tmp, stub, 'utf8');
globalThis.__fakeDb = fakeDb();
const { makeStore } = await import('./.tmp-store-db.mjs');

let pass = 0;
const step = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${pass}. ${name}`); };

const save = (sid, extra = {}) => ({ sid, name: '灰灰', species: 'huihuicangshu', hunger: 60, mood: 70, ...extra });

await step('新存档写入并可读回，rev/updatedAt 正确', async () => {
  const s = makeStore(fakeDb());
  const r = await s.putSave('ABCD2345', 1, save('ABCD2345'));
  assert.equal(r.ok, true); assert.equal(r.rev, 1);
  const g = await s.getSave('ABCD2345');
  assert.equal(g.ok, true); assert.equal(g.save.name, '灰灰'); assert.equal(g.rev, 1);
});

await step('rev 单调：同 rev 与更旧 rev 都判 stale 并带回当前 rev', async () => {
  const s = makeStore(fakeDb());
  await s.putSave('ABCD2345', 3, save('ABCD2345'));
  const same = await s.putSave('ABCD2345', 3, save('ABCD2345'));
  assert.deepEqual(same, { ok: false, reason: 'stale', rev: 3 });
  const old = await s.putSave('ABCD2345', 2, save('ABCD2345'));
  assert.equal(old.reason, 'stale');
  const newer = await s.putSave('ABCD2345', 4, save('ABCD2345', { mood: 90 }));
  assert.equal(newer.ok, true);
  assert.equal((await s.getSave('ABCD2345')).save.mood, 90);
});

await step('非法输入：bad-code / bad-save / code-mismatch / too-large / not-found', async () => {
  const s = makeStore(fakeDb());
  assert.equal((await s.putSave('bad!', 1, save('ABCD2345'))).reason, 'bad-code');
  assert.equal((await s.putSave('ABCD2345', 1, null)).reason, 'bad-save');
  assert.equal((await s.putSave('ABCD2345', 1, { name: '' })).reason, 'bad-save');
  assert.equal((await s.putSave('ABCD2345', 1, save('ZZZZ2345'))).reason, 'code-mismatch');
  assert.equal((await s.putSave('ABCD2345', 1, save('ABCD2345', { blob: 'x'.repeat(60001) }))).reason, 'too-large');
  assert.equal((await s.getSave('ABCD2345')).reason, 'not-found');
  assert.equal((await s.getSave('nope')).reason, 'bad-code');
});

await step('数据库读失败返回安全错误码 store，不抛异常', async () => {
  const s = makeStore(fakeDb(true));
  assert.equal((await s.getSave('ABCD2345')).reason, 'store');
  assert.equal((await s.putSave('ABCD2345', 1, save('ABCD2345'))).reason, 'store');
});

await step('info 报告 sites-db 驱动', async () => {
  assert.equal(makeStore(fakeDb()).info().driver, 'sites-db');
});

await rm(tmp, { force: true });
console.log(`\n${pass} 个用例全部通过（sites-db 存档驱动）`);