import { createDatabaseClient } from './_qoder/backend.mjs';

/*
 * Sites function_backend 存档驱动。与 cloud/lib/store.js 同一套校验与 rev 语义：
 * 存档码即凭证（知道码的人可读写），rev 单调递增，旧 rev 一律 stale。
 * 并发安全靠数据库本身：已有行用 (sid, rev) 条件更新做 CAS，新行用 insertIfAbsent 防重。
 */

const SID_RE = /^[A-Z0-9]{8,16}$/;
const isSid = (sid) => typeof sid === 'string' && SID_RE.test(sid);

export function makeStore(db) {
  const newVersion = () => Date.now();

  async function read(sid) {
    const r = await db.from('saves').select('sid,rev,updated_at,save').eq('sid', sid).limit(1);
    if (r.error) throw new Error('store-unavailable');
    return (r.data && r.data[0]) || null;
  }

  async function getSave(sid) {
    if (!isSid(sid)) return { ok: false, reason: 'bad-code' };
    let doc;
    try { doc = await read(sid); } catch (e) { return { ok: false, reason: 'store' }; }
    if (!doc) return { ok: false, reason: 'not-found' };
    return { ok: true, save: doc.save || null, rev: doc.rev || 0, updatedAt: doc.updated_at || 0 };
  }

  async function putSave(sid, rev, save) {
    if (!isSid(sid)) return { ok: false, reason: 'bad-code' };
    if (!save || typeof save !== 'object' || typeof save.name !== 'string' || !save.name) {
      return { ok: false, reason: 'bad-save' };
    }
    if (typeof save.sid !== 'string' || !isSid(save.sid)) return { ok: false, reason: 'bad-code' };
    if (save.sid !== sid) return { ok: false, reason: 'code-mismatch' };
    if (JSON.stringify(save).length > 60000) return { ok: false, reason: 'too-large' };

    const incoming = Number.isFinite(+rev) ? Math.max(1, Math.round(+rev)) : 0;
    let current;
    try { current = await read(sid); } catch (e) { return { ok: false, reason: 'store' }; }
    if (current && incoming <= (current.rev || 0)) {
      return { ok: false, reason: 'stale', rev: current.rev || 0 };
    }
    const doc = { sid, rev: incoming, updated_at: newVersion(), save };

    try {
      if (current) {
        const u = await db.from('saves')
          .update({ rev: doc.rev, updated_at: doc.updated_at, save: doc.save })
          .eq('sid', sid).eq('rev', current.rev).select('sid');
        if (u.error) throw new Error('store-unavailable');
        if (u.data && u.data.length) return { ok: true, rev: incoming, updatedAt: doc.updated_at };
        const again = await read(sid);
        return { ok: false, reason: 'stale', rev: (again && again.rev) || 0 };
      }
      const i = await db.from('saves').insertIfAbsent(doc, { onConflict: 'sid' }).select('sid');
      if (i.error) throw new Error('store-unavailable');
      if (i.data && i.data.length) return { ok: true, rev: incoming, updatedAt: doc.updated_at };
      const again = await read(sid);
      if (!again) return { ok: false, reason: 'store' };
      if (incoming <= (again.rev || 0)) return { ok: false, reason: 'stale', rev: again.rev || 0 };
      const u = await db.from('saves')
        .update({ rev: doc.rev, updated_at: doc.updated_at, save: doc.save })
        .eq('sid', sid).eq('rev', again.rev).select('sid');
      if (u.error) throw new Error('store-unavailable');
      if (u.data && u.data.length) return { ok: true, rev: incoming, updatedAt: doc.updated_at };
      const last = await read(sid);
      return { ok: false, reason: 'stale', rev: (last && last.rev) || 0 };
    } catch (e) {
      return { ok: false, reason: 'store' };
    }
  }

  const info = () => ({ driver: 'sites-db' });
  return { getSave, putSave, info, newVersion };
}

const d = makeStore(createDatabaseClient());
export const getSave = d.getSave;
export const putSave = d.putSave;
export const info = d.info;
export const newVersion = d.newVersion;