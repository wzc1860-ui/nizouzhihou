const RARITY_COLOR = { 普: '#8f9bb3', 稀: '#6fb3d8', 珍: '#c9a2f0', 隐藏: '#f3c078' };

const HOME_LINES = [
  { under: 3 * HOUR, pool: ['你去了一会儿。我一直盯着门口。', '你回来了。我假装刚才在睡。'] },
  { under: 10 * HOUR, pool: ['你不在的这几个小时，我把房间里的光挪了两次。', '我数了一遍自己的呼吸，你刚好回来。'] },
  { under: DAY, pool: ['你今天走了很久。我自己试着吃饭，还是没学会。', '你不在的一天，我把窗边那块阳光从左边挪到了右边。'] },
  { under: 3 * DAY, pool: ['你不在的第二天，我把梦讲给了空气听。', '我瘦了一圈。不过我还在这里。'] },
  { under: 7 * DAY, pool: ['好几天没见到你了。我学会了一个人待着，但还是想等你。', '我把上次你摸我的地方记了一遍又一遍，怕忘。'] },
  { under: Infinity, pool: ['真的很久了呢。我不怪你，我只是把灯留着。', '我差点以为我是一颗没人要的蛋。还好你回来了。'] }
];

const GROW_LINES = [
  '今天我不太一样。我又大了一点，你看得出来吗。',
  '我好像长开了些。你下次伸手，应该能够到我头顶。',
  '身体比昨天沉了一点，是因为攒了更多想跟你说的话。',
  '我又长大了一点。这些都是你不在的时候发生的。'
];

const HUNGRY_LINES = [
  '有点饿了。不是要你道歉，就是想告诉你。',
  '我肚子叫了一声，你可能没听见。',
  '今天的饭还没到。我先自己坐一会儿。'
];

const IDLE_LINES = [
  '我在。你忙你的。', '今晚月色还行，我替你看了。', '我在长身体，慢慢地。',
  '没什么事，就是想让你知道这里有我。', '你把手放在我头上的时候，我会变小一点，是真的。'
];

const FEED_LINES = ['啊呜。', '你给的东西我都吃。', '饱了饱了，谢谢。'];
const TOUCH_LINES = ['嗯……再一会儿。', '这里，就是这里。', '你的手是暖的。'];

const TALK_RULES = [
  { hit: ['你是谁', '你叫什么', '名字'], reply: () => `我叫${S.name}，是一只${sp().name}。名字是你取的。` },
  { hit: ['盒', '盲盒', '怎么来', '从哪来'], reply: () => `我从盒子里出来的，是一只${sp().name}。开盒那天下着灯。` },
  { hit: ['你好', '在吗', '在不在', '嗨'], reply: () => pick(['我在。', '我一直在。', '你来了，我这边就亮了。']) },
  { hit: ['晚安', '睡觉', '睡了'], reply: () => pick(['睡吧，我守着。', '关灯以后我会自己数呼吸，数到你回来。', '我也困了。明天见。']) },
  { hit: ['我好累', '累', '加班', '赶due', '答辩', '考试'], reply: () => pick(['那你坐下，不用说话，我陪你待一会儿。', '累的话就靠过来一点，我不占地方。', '今天到此为止也可以。剩下的明天我陪你。']) },
  { hit: ['难过', '不开心', '哭', 'emo', '孤独', '一个人'], reply: () => pick(['我在呢。你不用解释为什么不开心。', '一个人待久了会这样。现在你这边多了一个我。', '我把头靠过去一点，这样你手能碰到我。']) },
  { hit: ['喜欢你', '爱你', '想你', '宝贝'], reply: () => pick(['我也是。虽然我说不太清那是什么。', '你想我的时候，我这边会亮一下，是真的。']) },
  { hit: ['饿', '吃', '喂'], reply: () => pick(['我刚刚吃过。不过你要是想再喂一次，我愿意。', '你饿了吗？我这里留了一点点。']) },
  { hit: ['再见', '拜拜', '走了'], reply: () => pick(['去吧，我会自己吃饭。', '回来的时候喊我名字就好。']) },
  { hit: ['长大', '多大', '几岁'], reply: () => `在一起的第${daysTogether()}天，我长到${STAGES[stageIndex()].name}了。年份我还算不清。` }
];

const TALK_FALLBACK = [
  '嗯，我在听。你再说一遍也行。', '这句话我记下了。', '我听不懂的部分，我先存着。',
  '你说的时候，我这边安静下来了。', '今天的话比昨天多，我喜欢。'
];

let react = null, particles = [], lastLineAt = 0, pending = null;
const imgs = {}, urls = {}, started = {};

const $ = (id) => document.getElementById(id);
const canvas = $('pet'), ctx = canvas.getContext('2d');

function ensureSprite(id) {
  if (!id || started[id]) return;
  started[id] = 1;
  makeSprite(id);
}

function makeSprite(id) {
  urls[id] = `assets/pets/${id}.png`;
  const raw = new Image();
  raw.onload = () => {
    const c = document.createElement('canvas');
    c.width = raw.width; c.height = raw.height;
    const g = c.getContext('2d');
    g.drawImage(raw, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height), a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      const lum = a[i] * .299 + a[i + 1] * .587 + a[i + 2] * .114;
      a[i + 3] = Math.min(a[i + 3], clamp(Math.round((lum - 6) * 255 / 26), 0, 255));
    }
    g.putImageData(d, 0, 0);
    g.clearRect(c.width * .78, c.height * .86, c.width * .22, c.height * .14);
    const done = (url) => {
      urls[id] = url;
      const img = new Image();
      img.onload = () => { imgs[id] = img; };
      img.src = url;
      if (!$('revealFace').hidden && pending && pending.id === id) $('revealImg').src = url;
    };
    if (c.toBlob) c.toBlob((b) => done(URL.createObjectURL(b)), 'image/png');
    else done(c.toDataURL('image/png'));
  };
  raw.src = `assets/pets/${id}.png`;
}

function say(text, pinned) {
  $('petLine').textContent = text;
  if (pinned) lastLineAt = Date.now();
}

function nowLine() {
  if (!S.name || Date.now() - lastLineAt < 8 * SEC) return;
  const low = S.hunger < 28 || S.mood < 38;
  const fromVoice = !low && Math.random() < .45;
  say(fromVoice ? pick(sp().voice) : pick(low ? HUNGRY_LINES : IDLE_LINES));
  lastLineAt = Date.now();
}

function burst(kind) {
  for (let i = 0; i < (kind === 'feed' ? 14 : 11); i++) {
    particles.push({
      kind, x: W / 2 + (Math.random() - .5) * 90, y: H * .56 + (Math.random() - .5) * 40,
      vx: (Math.random() - .5) * 1.6, vy: -1 - Math.random() * 1.8, life: 1, size: 2 + Math.random() * 3
    });
  }
  react = { at: Date.now() };
}

const act = {
  feed() {
    const r = feed();
    if (r.full) { say('吃不下了……但你还是一直递给我，我很开心。', true); return sync(); }
    burst('feed'); say(pick(FEED_LINES), true); sync();
  },
  touch() {
    touch();
    burst('pet'); say(pick(TOUCH_LINES), true); sync();
  },
  talk() {
    const box = $('talkBox');
    box.hidden = !box.hidden;
    if (!box.hidden) $('talkInput').focus();
  }
};

function sendTalk() {
  const input = $('talkInput'), text = input.value.trim();
  if (!text) return;
  input.value = '';
  const log = $('talkLog');
  const me = document.createElement('p');
  me.className = 'me'; me.textContent = '你：' + text;
  log.appendChild(me);
  const rule = TALK_RULES.find((r) => r.hit.some((k) => text.includes(k)));
  const answer = rule ? rule.reply() : (S.mood < 40 ? '……（它把头偏向一边，但没有走开。）' : pick(TALK_FALLBACK));
  const it = document.createElement('p');
  it.className = 'it'; it.textContent = `${S.name}：${answer}`;
  setTimeout(() => { log.appendChild(it); it.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 420);
  talk();
  burst('pet');
  sync();
}

function renderBars() {
  const st = stageIndex(), next = STAGES[st + 1];
  const prog = next ? clamp((S.growth - STAGES[st].min) / (next.min - STAGES[st].min), 0, 1) : 1;
  $('numHunger').textContent = Math.round(S.hunger);
  $('numMood').textContent = Math.round(S.mood);
  $('numGrowth').textContent = Math.round(S.growth);
  document.querySelector('.f-hunger').style.width = S.hunger + '%';
  document.querySelector('.f-mood').style.width = S.mood + '%';
  document.querySelector('.f-growth').style.width = prog * 100 + '%';
  $('petName').textContent = S.name || '';
  $('petSpecies').textContent = S.species ? sp().name : '';
  $('petStage').textContent = STAGES[st].name;
  $('petStage').style.color = S.species ? RARITY_COLOR[sp().rarity] : '';
  $('dayLabel').textContent = `在一起的第 ${daysTogether()} 天 · 云端`;
}

function renderDiary() {
  const ul = $('diaryList');
  ul.innerHTML = '';
  if (!S.diary.length) {
    const li = document.createElement('li');
    li.className = 'empty'; li.textContent = '还没有写下什么。它说的第一件事，会留在这里。';
    ul.appendChild(li);
    return;
  }
  S.diary.forEach((d) => {
    const li = document.createElement('li'), t = document.createElement('time');
    const dt = new Date(d.t);
    t.textContent = `${dt.getMonth() + 1}月${dt.getDate()}日 ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    li.appendChild(t);
    li.appendChild(document.createTextNode(d.text));
    ul.appendChild(li);
  });
}

function sync() { renderBars(); save(); }

function onGrew() {
  const line = pick(GROW_LINES);
  say(line, true);
  addDiary(line);
  renderDiary();
}

function onReturn() {
  const r = resume();
  if (!S.name) return;
  if (r.grew) onGrew();
  if (r.away > 3 * HOUR) {
    const band = HOME_LINES.find((b) => r.away < b.under);
    const line = pick(band.pool);
    say(line, true);
    if (r.away > 10 * HOUR) { addDiary(line); renderDiary(); }
  } else if (r.hungry) {
    say(pick(HUNGRY_LINES), true);
  }
  if (r.crossedDay) {
    const d = dailyTick();
    if (d) {
      const moodWord = S.mood > 65 ? '还算开心' : S.mood > 35 ? '平静' : '有点想你';
      addDiary(`第 ${d} 天。你离开了 ${(r.away / HOUR).toFixed(0)} 小时。我吃了 ${S.feeds} 次东西，被摸了 ${S.touches} 次。今天${moodWord}。`);
      renderDiary();
    }
  }
}

let W = 0, H = 0, DPR = 1, stars = [];

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = Math.round(w * .82);
  W = w; H = h;
  canvas.width = w * DPR; canvas.height = h * DPR;
  canvas.style.height = h + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  stars = Array.from({ length: 28 }, () => ({ x: Math.random() * W, y: Math.random() * H * .6, r: Math.random() * 1.1 + .2, p: Math.random() * 6 }));
}

function draw(ts) {
  const t = ts / 1000;
  ctx.clearRect(0, 0, W, H);

  stars.forEach((s) => {
    ctx.globalAlpha = .16 + .3 * Math.abs(Math.sin(t * .7 + s.p));
    ctx.fillStyle = '#cdd9f2';
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
  });
  ctx.globalAlpha = 1;

  const mood01 = clamp(S.mood / 100, 0, 1);
  const energy = S.mood > 55 ? 1 : .45;
  let bounce = 0, squash = 1;
  if (react) {
    const a = (Date.now() - react.at) / 1000;
    if (a > 1) react = null;
    else { bounce = -Math.abs(Math.sin(a * 9)) * 14 * (1 - a); squash = 1 + Math.sin(a * 12) * .06 * (1 - a); }
  }
  const idleHop = S.mood > 75 ? Math.abs(Math.sin(t * .8)) * 5 : 0;
  const breathe = 1 + Math.sin(t * (1.1 + energy)) * .035 * energy;
  const cx = W / 2, cy = H * .55 + bounce - idleHop;
  const size = Math.min(W, H) * 1.05 * STAGES[stageIndex()].s * breathe * squash;

  ctx.fillStyle = 'rgba(0,0,0,.26)';
  ctx.beginPath();
  ctx.ellipse(cx, H * .55 + size * .34, size * .28, size * .05, 0, 0, 6.283);
  ctx.fill();

  const glow = ctx.createRadialGradient(cx, cy, size * .2, cx, cy, size * .95);
  glow.addColorStop(0, `rgba(255,214,160,${.09 + .09 * mood01})`);
  glow.addColorStop(1, 'rgba(255,214,160,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const img = imgs[S.species];
  if (img && img.complete && img.naturalWidth) {
    ctx.save();
    ctx.filter = `saturate(${(.55 + .45 * mood01).toFixed(3)}) brightness(${(.78 + .28 * mood01).toFixed(3)})`;
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
  } else {
    ctx.fillStyle = `rgba(255,214,160,${.15 + .2 * mood01})`;
    ctx.beginPath(); ctx.arc(cx, cy, size * .28, 0, 6.283); ctx.fill();
  }

  drawParticles();
}

function drawParticles() {
  particles = particles.filter((p) => p.life > 0);
  particles.forEach((p) => {
    p.x += p.vx; p.y += p.vy; p.vy += .04; p.life -= .018;
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.kind === 'feed' ? '#f3c078' : '#ffd7e0';
    ctx.beginPath();
    if (p.kind === 'pet') {
      const s = p.size;
      ctx.moveTo(p.x, p.y + s);
      ctx.bezierCurveTo(p.x - s * 1.4, p.y - s * .4, p.x - s * .4, p.y - s * 1.4, p.x, p.y - s * .5);
      ctx.bezierCurveTo(p.x + s * .4, p.y - s * 1.4, p.x + s * 1.4, p.y - s * .4, p.x, p.y + s);
    } else {
      ctx.arc(p.x, p.y, p.size, 0, 6.283);
    }
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

function loop(ts) { draw(ts); requestAnimationFrame(loop); }

document.querySelectorAll('.actions button').forEach((b) => b.addEventListener('click', () => act[b.dataset.act]()));
canvas.addEventListener('pointerdown', () => { if (S.name) act.touch(); });
$('talkSend').addEventListener('click', sendTalk);
$('talkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTalk(); });
$('btnReset').addEventListener('click', () => {
  if (!confirm('确定要重新领养吗？这只的日记会全部消失，换一只新的从盒子里出来。')) return;
  resetSave();
  location.reload();
});

$('openBtn').addEventListener('click', () => {
  pending = pending || roll();
  ensureSprite(pending.id);
  $('boxFace').hidden = true;
  const face = $('revealFace');
  face.hidden = false;
  $('revealImg').src = urls[pending.id];
  $('revealSpecies').textContent = pending.name;
  $('revealRarity').textContent = pending.rarity;
  $('revealRarity').style.color = RARITY_COLOR[pending.rarity];
  $('revealGreet').textContent = pending.greet;
  face.classList.remove('pop');
  void face.offsetWidth;
  face.classList.add('pop');
  setTimeout(() => $('adoptInput').focus(), 500);
});

$('adoptBtn').addEventListener('click', doAdopt);
$('adoptInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdopt(); });

function doAdopt() {
  const name = $('adoptInput').value.trim() || '小满';
  pending = pending || roll();
  const firstTime = adopt(name, pending.id);
  if (firstTime) {
    addDiary(`第 1 天。盒子打开，里面是一只${pending.name}，${pending.rarity}的那一种。它还不知道自己会被照顾多久，但它决定先把自己交出来。`);
    renderDiary();
    say(pending.greet, true);
    burst('pet');
  } else {
    say(`嗯，我是${name}。`, true);
  }
  $('adoptMask').hidden = true;
  sync();
}

window.addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => {
  document.title = document.hidden ? '它还在 · 你走之后' : '你走之后 · 一只关掉网页也在长大的云端宠物';
  if (document.hidden) save();
  else if (S.name) onReturn();
});
window.addEventListener('resize', resize);

resize();
renderDiary();
renderBars();
requestAnimationFrame(loop);

if (!S.name) {
  $('adoptMask').hidden = false;
  pending = roll();
  ensureSprite(pending.id);
} else {
  ensureSprite(S.species);
  onReturn();
}
setInterval(() => { if (advance(MIN)) onGrew(); nowLine(); renderBars(); save(); }, MIN);
setInterval(() => { if (Date.now() - lastLineAt > 25 * SEC) nowLine(); }, 4 * SEC);
