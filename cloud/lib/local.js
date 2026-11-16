import { corpus, cardFor } from './prompt.js';

const SCENES = [
  { keys: ['你是谁', '你叫什么', '名字'], ids: [3] },
  { keys: ['模型', '假', 'AI', '机器人', '真的吗'], ids: [4] },
  { keys: ['盒', '盲盒', '怎么来', '从哪来'], ids: [5] },
  { keys: ['晚安', '睡觉', '睡了', '熬', '陪陪我'], ids: [6, 7] },
  { keys: ['累', '加班', 'due', '答辩', '考试', '熬夜'], ids: [8, 9] },
  { keys: ['难过', '不开心', '哭', 'emo', '孤独', '一个人', '烦'], ids: [10, 11] },
  { keys: ['喜欢你', '爱你', '想你', '宝贝', '最好'], ids: [13, 14] },
  { keys: ['饿', '吃', '喂', '饭'], ids: [15] },
  { keys: ['再见', '拜拜', '走了', '我走了'], ids: [16] },
  { keys: ['对不起', '抱歉', '忘了', '忘记'], ids: [17] },
  { keys: ['死', '消失', '会不会没'], ids: [18] },
  { keys: ['长大', '多大', '几岁'], ids: [19] },
  { keys: ['在吗', '你好', '嗨', '无聊'], ids: [1, 2] }
];

const byId = new Map(corpus.items.map((it) => [it.id, it]));
const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

export function matchScene(text, rnd = Math.random) {
  const t = String(text || '');
  for (const s of SCENES) {
    if (s.keys.some((k) => t.includes(k))) return pick(s.ids, rnd);
  }
  return pick([1, 2, 13, 19], rnd);
}

/* 话少的物种也要成句：至少留够 6 个字再收尾，避免只回一个"好。" */
const clipShort = (t) => {
  let out = '';
  for (const piece of String(t).split(/([，。！？])/)) {
    out += piece;
    if (out.replace(/[，。！？]/g, '').length >= 6) break;
  }
  const trimmed = out.trim();
  return /[。！？]$/.test(trimmed) ? trimmed : `${trimmed.replace(/[，、]+$/, '')}。`;
};

/* 无密钥时也要"每只不一样"：话少的物种优先用自己的人设台词，长句只留前半句。 */
const TERSE = new Set(['huihui', 'shouyedeng', 'taitai']);

export function localReply(f, rnd = Math.random) {
  const c = cardFor(f.species);
  const item = byId.get(matchScene(f.text, rnd)) || corpus.items[0];
  const terse = TERSE.has(c.id);
  if (rnd() < (terse ? 0.45 : 0.25)) return pick(c.voice_seed, rnd);
  return (terse ? clipShort(item.out) : item.out).replace(/你取的名字那只/, `叫${f.name || c.name}的那只`);
}

const HOUR_WORD = (h) => (h < 1 ? '不到一个小时' : h < 24 ? `${h} 个小时` : `${Math.round(h / 24)} 天`);

/* persona.json 的 offline 是给模型看的完整句子（prompt.js 里独立成句），
   直接拼到"你不在的时候"后面会写成"你不在的时候主人不在时…。。"：先去句末句号，再去掉自带的主语/时间前缀。 */
const LEAD_CLAUSE = /^(主人不在的?时(候)?|主人睡着以后|把主人不在的时间用来)[，,]?/;
const offlineClause = (c) => String(c.offline || '').replace(/。+$/g, '').replace(LEAD_CLAUSE, '').trim();

export function localDiary(f, rnd = Math.random) {
  const c = cardFor(f.species);
  const day = Math.max(1, Math.round(+f.days || 1));
  const kind = ['return', 'daily', 'grow'].includes(f.kind) ? f.kind : 'return';
  const hungry = +f.hunger < 30;
  const open = `第 ${day} 天。`;
  const away = offlineClause(c);
  const body = {
    return: hungry
      ? `你不在的这段时间我把饭留到最后才吃，还是饿了。${away}。`
      : `你不在的时候${away}。回来这一秒，我这边亮了一下。`,
    daily: `${c.habit}，今天也做了。心情 ${Math.round(+f.mood || 0)}，不算差。`,
    grow: `我又大了一点，现在是「${f.stage || ''}」。你不在的时候${away}，这些都长在身体里。`
  }[kind];
  const tail = rnd() < 0.4 ? `今天想你说的是：${pick(c.voice_seed, rnd)}` : '';
  return (open + body + (tail ? ' ' + tail : '')).slice(0, 120);
}

export { HOUR_WORD };
