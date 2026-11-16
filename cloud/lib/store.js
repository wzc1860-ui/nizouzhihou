import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const SID_RE = /^[A-Z0-9]{8,16}$/;
const MEM = new Map();

const driverOf = () => (process.env.NZZH_STORE_DRIVER || 'file').toLowerCase();
const dirOf = () => process.env.NZZH_STORE_DIR || join(tmpdir(), 'nizouzhihou-saves');
const fileOf = (sid) => join(dirOf(), `${sid}.json`);
const isSid = (sid) => typeof sid === 'string' && SID_RE.test(sid);

async function read(sid) {
  if (driverOf() === 'memory') return MEM.get(sid) || null;
  try {
    return JSON.parse(await readFile(fileOf(sid), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function write(sid, doc) {
  if (driverOf() === 'memory') {
    MEM.set(sid, doc);
    return;
  }
  await mkdir(dirOf(), { recursive: true });
  const tmp = `${fileOf(sid)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(doc), 'utf8');
  await rename(tmp, fileOf(sid));
}

export function newVersion() {
  return Date.now();
}

export async function getSave(sid) {
  if (!isSid(sid)) return { ok: false, reason: 'bad-code' };
  const doc = await read(sid);
  if (!doc) return { ok: false, reason: 'not-found' };
  return { ok: true, save: doc.save || null, rev: doc.rev || 0, updatedAt: doc.updatedAt || 0 };
}

export async function putSave(sid, rev, save) {
  if (!isSid(sid)) return { ok: false, reason: 'bad-code' };
  if (!save || typeof save !== 'object' || typeof save.name !== 'string' || !save.name) {
    return { ok: false, reason: 'bad-save' };
  }
  if (typeof save.sid !== 'string' || !isSid(save.sid)) return { ok: false, reason: 'bad-code' };
  if (save.sid !== sid) return { ok: false, reason: 'code-mismatch' };
  if (JSON.stringify(save).length > 60000) return { ok: false, reason: 'too-large' };

  const incoming = Number.isFinite(+rev) ? Math.max(1, Math.round(+rev)) : 0;
  const current = await read(sid);
  if (current && incoming <= (current.rev || 0)) {
    return { ok: false, reason: 'stale', rev: current.rev || 0 };
  }
  const doc = { sid, rev: incoming, updatedAt: newVersion(), save };
  await write(sid, doc);
  return { ok: true, rev: incoming, updatedAt: doc.updatedAt };
}

export const info = () => ({ driver: driverOf(), dir: driverOf() === 'memory' ? 'memory' : dirOf() });
