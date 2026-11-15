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

let S = load();
let resetting = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (a) => a[(Math.random() * a.length) | 0];
const sp = () => SPECIES.find((x) => x.id === S.species) || SPECIES[0];
const stageIndex = () => { let i = 0; STAGES.forEach((s, k) => { if (S.growth >= s.min) i = k; }); return i; };
const daysTogether = () => Math.floor((Date.now() - S.bornAt) / DAY) + 1;

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return Object.assign(fresh(), JSON.parse(raw));
  } catch (e) {}
  return fresh();
}

function fresh() {
  const now = Date.now();
  return { name: null, species: null, bornAt: now, lastSeen: now, hunger: 70, mood: 68, growth: 0,
           feeds: 0, touches: 0, talks: 0, diary: [], lastDay: 0 };
}

function save() {
  if (resetting) return;
  S.lastSeen = Date.now();
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) {}
}

function resetSave() {
  resetting = true;
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
  } else {
    S.name = name;
  }
  return firstTime;
}

function addDiary(text) {
  S.diary.unshift({ t: Date.now(), text });
  if (S.diary.length > MAX_DIARY) S.diary.length = MAX_DIARY;
}

function dailyTick() {
  const d = daysTogether() - 1;
  if (d <= 0 || d <= S.lastDay) return 0;
  S.lastDay = d;
  return d;
}
