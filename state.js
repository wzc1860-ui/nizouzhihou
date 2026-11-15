const SAVE_KEY = 'nizouzhihou.v2';
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

const SPECIES = [
  { id: 'tuanzi', name: '团子', rarity: '普', w: 22, greet: '（它把脸贴到你手边）',
    voice: ['你过来一点，我够得着你。', '我又圆了一点，你摸摸看。'] },
  { id: 'ajju', name: '阿橘', rarity: '普', w: 20, greet: '喵。（它好像一直饿着）',
    voice: ['你给的东西我都吃，包括你的委屈。', '我在窗台上睡了三觉，都梦见你。'] },
  { id: 'huihui', name: '灰灰', rarity: '普', w: 19, greet: '（它抬了一下头，又低下去）',
    voice: ['我不太会说话，但我一直在。', '今天很安静，我喜欢这种安静。'] },
  { id: 'taitai', name: '苔苔', rarity: '稀', w: 13, greet: '（它头顶的叶子抖了一下）',
    voice: ['我长得慢，你不用急。', '今天晒到了一点光，我替你存着。'] },
  { id: 'xuetuan', name: '雪团', rarity: '稀', w: 11, greet: '（它把自己弄得更圆了一点）',
    voice: ['你手凉，我不嫌弃。', '我刚把毛理顺，现在可以摸你了。'] },
  { id: 'yueliangquan', name: '月亮犬', rarity: '稀', w: 9, greet: '（它额头的月亮亮了一下）',
    voice: ['我夜里醒着，你睡你的。', '有声音是我在走路，别怕。'] },
  { id: 'xingchen', name: '星尘', rarity: '珍', w: 5, greet: '哇，你终于来了！',
    voice: ['我给你数了三十七颗星。', '你身上也有一点亮，我看得见的。'] },
  { id: 'shouyedeng', name: '守夜灯', rarity: '隐藏', w: 3, greet: '（它把光调暗了一点，怕刺到你）',
    voice: ['你几点回来，我就几点亮着。', '灯不灭，是因为你还没回来。'] }
];

const STAGES = [
  { name: '小小', min: 0, s: .62 },
  { name: '渐长', min: 40, s: .75 },
  { name: '半大', min: 130, s: .88 },
  { name: '大人', min: 300, s: 1 },
  { name: '长成', min: 560, s: 1.12 }
];

const HUNGER_DECAY = 3.4;
const OFFLINE_CAP = 90 * DAY;
const MAX_DIARY = 60;

const AI_TIMEOUT = 12 * SEC, DIARY_TIMEOUT = 15 * SEC, CLOUD_TIMEOUT = 10 * SEC;
const AI_PER_DAY = 40, AI_COOLDOWN = 3 * SEC;
const CLOUD_DEBOUNCE = 4 * SEC, CLOUD_MAX_CHARS = 60 * 1024;
const CODE_LEN = 12, CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let S = load();
let resetting = false;
let aiCfg = { base: '', enabled: true };
let lastFp = '', dirty = false, cloudTimer = 0, cloudPending = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (a) => a[(Math.random() * a.length) | 0];
const sp = () => SPECIES.find((x) => x.id === S.species) || SPECIES[0];
const stageIndex = () => { let i = 0; STAGES.forEach((s, k) => { if (S.growth >= s.min) i = k; }); return i; };
const daysTogether = () => Math.floor((Date.now() - S.bornAt) / DAY) + 1;

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return normalize(Object.assign(fresh(), JSON.parse(raw)));
  } catch (e) {}
  return fresh();
}

function fresh() {
  const now = Date.now();
  return { name: null, species: null, bornAt: now, lastSeen: now, hunger: 70, mood: 68, growth: 0,
           feeds: 0, touches: 0, talks: 0, diary: [], lastDay: 0,
           sid: null, rev: 1, syncedAt: 0, ai: { talks: 0, day: 0, lastAt: 0 } };
}

function writeRaw() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) {}
}

function save() {
  if (resetting) return;
  S.lastSeen = Date.now();
  const fp = fingerprint();
  if (fp !== lastFp) { lastFp = fp; S.rev = (S.rev || 0) + 1; dirty = true; }
  writeRaw();
  if (dirty) scheduleCloudPush();
}

function resetSave() {
  resetting = true;
  dirty = false;
  clearTimeout(cloudTimer);
  localStorage.removeItem(SAVE_KEY);
}

function roll() {
  const total = SPECIES.reduce((n, s) => n + s.w, 0);
  let r = Math.random() * total;
  for (const s of SPECIES) { if ((r -= s.w) <= 0) return s; }
  return SPECIES[0];
}

function advance(ms) {
  if (ms <= 0) return false;
  const steps = clamp(Math.ceil(ms / HOUR), 1, 240);
  const dt = ms / steps / HOUR;
  const before = stageIndex();
  for (let i = 0; i < steps; i++) {
    S.hunger = clamp(S.hunger - HUNGER_DECAY * dt, 0, 100);
    const target = S.hunger >= 25 ? 20 + S.hunger * .76 : 12 + S.hunger * .5;
    S.mood += (target - S.mood) * clamp(.16 * dt, 0, .6);
    S.mood = clamp(S.mood, 0, 100);
    S.growth += (S.hunger > 35 && S.mood > 40 ? 1.1 : .2) * dt;
  }
  return stageIndex() > before;
}

function resume() {
  const now = Date.now();
  const away = clamp(now - S.lastSeen, 0, OFFLINE_CAP);
  const grew = advance(away);
  const crossedDay = Math.floor((S.lastSeen - S.bornAt) / DAY) < Math.floor((now - S.bornAt) / DAY);
  return { away, grew, hungry: S.hunger < 30, crossedDay };
}

function feed() {
  if (S.hunger > 93) return { full: true };
  S.hunger = clamp(S.hunger + 18, 0, 100);
  S.mood = clamp(S.mood + 4, 0, 100);
  S.growth += 2; S.feeds++;
  return { full: false };
}

function touch() {
  S.mood = clamp(S.mood + 9, 0, 100);
  S.growth += 1; S.touches++;
}

function talk() {
  S.mood = clamp(S.mood + 3, 0, 100);
  S.growth += 1; S.talks++;
}

function adopt(name, speciesId) {
  const firstTime = !S.name;
  if (firstTime) {
    S.species = speciesId;
    S.name = name;
    S.bornAt = Date.now();
    S.lastSeen = Date.now();
    if (!S.sid) S.sid = makeCode(CODE_LEN);
  } else {
    S.name = name;
  }
  return firstTime;
}

function addDiary(text, by) {
  S.diary.unshift({ t: Date.now(), text, by: by === 'ai' ? 'ai' : 'auto' });
  if (S.diary.length > MAX_DIARY) S.diary.length = MAX_DIARY;
}

function dailyTick() {
  const d = daysTogether() - 1;
  if (d <= 0 || d <= S.lastDay) return 0;
  S.lastDay = d;
  return d;
}

/* ---------- 二期：AI 对话 / AI 日记 / 存档上云（仅数据层，不读取也不写入任何 DOM） ---------- */

function normalize(s) {
  if (typeof s.rev !== 'number' || !isFinite(s.rev) || s.rev < 1) s.rev = 1;
  if (typeof s.syncedAt !== 'number' || !isFinite(s.syncedAt)) s.syncedAt = 0;
  if (typeof s.sid !== 'string' || !s.sid) s.sid = s.name ? makeCode(CODE_LEN) : null;
  if (!s.ai || typeof s.ai !== 'object') s.ai = { talks: 0, day: 0, lastAt: 0 };
  ['talks', 'day', 'lastAt'].forEach((k) => {
    if (typeof s.ai[k] !== 'number' || !isFinite(s.ai[k])) s.ai[k] = 0;
  });
  if (!Array.isArray(s.diary)) s.diary = [];
  return s;
}

function makeCode(n) {
  const bytes = new Uint8Array(n);
  const c = typeof crypto !== 'undefined' ? crypto : null;
  if (c && c.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = (Math.random() * 256) | 0;
  let out = '';
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

const normCode = (c) => String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanText = (s, max) => typeof s === 'string'
  ? s.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '';
const apiRoot = () => (aiCfg.base ? String(aiCfg.base).replace(/\/+$/, '') : '') + '/api';

function fingerprint() {
  const head = S.diary.length ? S.diary[0].t + '|' + S.diary[0].text : '';
  return [S.name, S.species, S.bornAt, S.sid, S.lastDay, S.feeds, S.touches, S.talks,
          Math.round(S.hunger), Math.round(S.mood), Math.round(S.growth), S.diary.length, head].join('~');
}

function facts() {
  return { sid: S.sid, name: S.name, species: S.species, stage: STAGES[stageIndex()].name,
           days: daysTogether(), hunger: Math.round(S.hunger), mood: Math.round(S.mood),
           feeds: S.feeds, touches: S.touches, talks: S.talks };
}

function aiConfig(cfg) {
  if (cfg && typeof cfg.base === 'string') aiCfg.base = cfg.base;
  if (cfg && typeof cfg.enabled === 'boolean') aiCfg.enabled = cfg.enabled;
  return { base: aiCfg.base, enabled: aiCfg.enabled };
}

async function postJSON(path, payload, timeout) {
  if (!aiCfg.enabled) return { ok: false, reason: 'off' };
  let ctl = null;
  try { ctl = new AbortController(); } catch (e) {}
  const timer = setTimeout(() => { if (ctl) { try { ctl.abort(); } catch (e) {} } }, timeout);
  try {
    const res = await fetch(apiRoot() + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl && ctl.signal
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (data && typeof data === 'object') {
      if (data.ok === true) return { ok: true, data };
      if (data.ok === false) return { ok: false, reason: cleanText(data.reason, 24) || 'http', data, status: res.status };
    }
    return { ok: false, reason: res.ok ? 'parse' : 'http', status: res.status };
  } catch (e) {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function aiGate() {
  if (!aiCfg.enabled || !S.name) return 'off';
  const day = Math.floor(Date.now() / DAY);
  if (S.ai.day !== day) { S.ai.day = day; S.ai.talks = 0; }
  if (Date.now() - S.ai.lastAt < AI_COOLDOWN) return 'busy';
  if (S.ai.talks >= AI_PER_DAY) return 'limit';
  return '';
}

async function aiSay(text) {
  const t = cleanText(text, 200);
  if (!t) return { ok: false, reason: 'empty' };
  const gate = aiGate();
  if (gate) return { ok: false, reason: gate };
  S.ai.talks++;
  S.ai.lastAt = Date.now();
  const payload = facts();
  payload.text = t;
  payload.diary = S.diary.slice(0, 2).map((d) => cleanText(d.text, 120));
  const r = await postJSON('/chat', payload, AI_TIMEOUT);
  const reply = r.ok ? cleanText(r.data.reply, 120) : '';
  if (!reply) {
    S.ai.talks = Math.max(0, S.ai.talks - 1);
    return { ok: false, reason: r.ok ? 'empty' : r.reason };
  }
  save();
  return { ok: true, reply };
}

async function aiDiary(kind) {
  const k = kind === 'daily' || kind === 'grow' ? kind : 'return';
  const gate = aiGate();
  if (gate) return { ok: false, reason: gate };
  S.ai.lastAt = Date.now();
  const r = await postJSON('/diary', Object.assign(facts(), { kind: k }), DIARY_TIMEOUT);
  const text = r.ok ? cleanText(r.data.text, 240) : '';
  if (!text) return { ok: false, reason: r.ok ? 'empty' : r.reason };
  return { ok: true, text };
}

function getSaveCode() {
  return S.sid ? normCode(S.sid).replace(/(.{4})(?=.)/g, '$1-') : null;
}

function scheduleCloudPush() {
  if (resetting || !aiCfg.enabled || !S.sid || !S.name) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => cloudPush(), CLOUD_DEBOUNCE);
}

async function cloudPush() {
  if (resetting) return { ok: false, reason: 'off' };
  if (cloudPending) return { ok: false, reason: 'busy' };
  if (!aiCfg.enabled || !S.sid || !S.name) return { ok: false, reason: 'off' };
  const body = { sid: S.sid, rev: S.rev, save: S };
  if (JSON.stringify(body).length > CLOUD_MAX_CHARS) return { ok: false, reason: 'too-large' };
  cloudPending = true;
  try {
    const r = await postJSON('/save', body, CLOUD_TIMEOUT);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (typeof r.data.rev === 'number' && r.data.rev > S.rev) S.rev = r.data.rev;
    S.syncedAt = Date.now();
    dirty = false;
    writeRaw();
    return { ok: true, rev: S.rev };
  } finally {
    cloudPending = false;
  }
}

async function cloudPull(code) {
  const sid = normCode(code == null || code === '' ? S.sid : code);
  if (!sid) return { ok: false, reason: 'empty' };
  if (!aiCfg.enabled) return { ok: false, reason: 'off' };
  const r = await postJSON('/restore', { sid }, CLOUD_TIMEOUT);
  if (!r.ok) return { ok: false, reason: r.reason };
  const doc = r.data.save;
  if (!doc || typeof doc !== 'object' || !doc.name) return { ok: false, reason: 'empty' };
  const incoming = normalize(Object.assign(fresh(), doc));
  incoming.sid = sid;
  if (S.name && sid === S.sid && incoming.rev < S.rev) return { ok: false, reason: 'stale' };
  S = incoming;
  lastFp = fingerprint();
  dirty = false;
  writeRaw();
  return { ok: true, source: S };
}

function cloudStatus() {
  return { code: getSaveCode(), rev: S.rev || 0, syncedAt: S.syncedAt || 0,
           dirty: !!dirty, pending: !!cloudPending, enabled: !!(aiCfg.enabled && S.sid && S.name) };
}

lastFp = fingerprint();
