// Screen flow and race controller for the student game.
// Signed-in races: the server checks every answer and saves rewards (supabase/schema.sql).
// Guest races: the same engine runs locally with the sample set and saves nothing.
// RaceScene only animates what the engine decides.

import { RaceEngine } from './race-engine.js';
import { RaceScene, loadCarTemplate } from './race-scene.js';
import { RACE, BOTS, PLAYER_COLOR } from './config.js';
import { SAMPLE_SET } from './questions.js';
import { api } from './supabase.js';

const $ = (sel) => document.querySelector(sel);
const LETTERS = ['A', 'B', 'C', 'D'];
const PLAYER = 'you';

const store = {
  get(k, d) { try { const v = localStorage.getItem('sw.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sw.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const settings = {
  quality: store.get('quality', matchMedia('(pointer: coarse)').matches ? 'low' : 'medium'),
  fpsCap: store.get('fpsCap', 60),
  showFps: store.get('showFps', false),
};

let scene, template;
let game = null; // active race controller state
let profile = null; // signed-in student, or null for a guest
let sets = [];

// ---------- boot ----------

async function boot() {
  scene = new RaceScene($('#gl'), { quality: settings.quality, fpsCap: settings.fpsCap });
  template = await loadCarTemplate('assets/car.json');
  await showcaseCars();
  scene.onUpdate = (dt) => tick(dt);
  scene.start();
  await route();
  $('#loading').hidden = true;
}

// ---------- accounts ----------

const fmt = (n) => Number(n).toLocaleString('en-US');

async function route() {
  const session = await api.session().catch(() => null);
  if (!session) { profile = null; return show('auth'); }
  profile = await api.profile();
  if (!profile) { await api.logOut(); return show('auth'); }
  if (profile.role === 'teacher') { location.href = 'teacher.html'; return; }
  if (profile.status !== 'approved') {
    $('#pending-name').textContent = profile.first_name || profile.username;
    return show('pending');
  }
  await loadHome();
}

async function loadHome() {
  if (profile) {
    profile = await api.profile();
    sets = await api.releasedSets();
    $('#who-name').textContent = `${profile.first_name} ${profile.last_name}`.trim();
    $('#balance').textContent = fmt(profile.balance);
    $('#stage-note').textContent = sets.length
      ? 'Stage 2 preview · Solo races save O-Bucks to your account'
      : 'No races are released yet. Your teacher will release one soon.';
  } else {
    sets = [{ id: 'guest', title: SAMPLE_SET.title, season: SAMPLE_SET.season }];
    $('#who-name').textContent = 'Guest';
    $('#balance').textContent = '0';
    $('#stage-note').textContent = 'Guest race · nothing is saved. Log in to earn O-Bucks.';
  }
  const sel = $('#set-select');
  const keep = sel.value;
  sel.replaceChildren(...sets.map((st) => new Option(st.season ? `${st.season} · ${st.title}` : st.title, st.id)));
  if (sets.some((st) => st.id === keep)) sel.value = keep;
  $('#play').disabled = sets.length === 0;
  updateHomeSub();
  show('home');
}

function updateHomeSub() {
  const st = sets.find((x) => x.id === $('#set-select').value);
  $('#home-sub').textContent = st ? [st.season, st.title].filter(Boolean).join(' · ') : 'Racing';
}

function authMessage(text, isError = false) {
  const m = $('#auth-msg');
  m.textContent = text;
  m.classList.toggle('error', isError);
}

function authTab(which) {
  const login = which === 'login';
  $('#tab-login').setAttribute('aria-selected', login);
  $('#tab-signup').setAttribute('aria-selected', !login);
  $('#login-form').hidden = !login;
  $('#signup-form').hidden = login;
  authMessage('');
}

async function showcaseCars() {
  scene.mode = 'attract';
  const list = [{ id: PLAYER, color: PLAYER_COLOR }, ...BOTS.names.map((n, i) => ({ id: n, color: BOTS.colors[i] }))];
  await scene.setCars(list, template);
  scene.setPlayer(PLAYER);
  scene.setStartLights(0);
}

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  document.body.dataset.screen = id;
}

// ---------- race ----------

function rand([a, b]) { return a + Math.random() * (b - a); }

async function startSolo() {
  const setId = $('#set-select').value;
  let questions = SAMPLE_SET.questions, raceId = null;
  if (profile) {
    try {
      const data = await api.startRace(setId);
      questions = data.questions;
      raceId = data.race_id;
    } catch (err) {
      $('#stage-note').textContent = err.message;
      return show('home');
    }
  }
  const participants = [
    ...BOTS.names.map((name, i) => ({ id: name, name, isBot: true, color: BOTS.colors[i] })),
    { id: PLAYER, name: 'You', color: PLAYER_COLOR },
  ];
  const engine = new RaceEngine({ participants, questions, mode: 'solo', playerId: PLAYER });
  game = {
    engine,
    raceId,
    busy: false,
    colors: Object.fromEntries(participants.map((p) => [p.id, p.color])),
    phase: 'countdown',
    timer: 0,
    attempt: 0,
    bots: BOTS.names.map((id) => ({
      id, accuracy: rand(BOTS.accuracy), state: 'thinking', wait: rand(BOTS.thinkSeconds) + 3,
    })),
    moved: {},
  };
  scene.mode = 'race';
  await scene.setCars(engine.order.map((id) => ({ id, color: game.colors[id] })), template);
  scene.setPlayer(PLAYER);
  scene.setOrder(engine.order);
  renderPositions();
  $('#qpanel').hidden = true;
  $('#freedrive').hidden = true;
  $('#banner').hidden = true;
  $('#steer').hidden = true;
  show('hud');
  runCountdown();
}

function runCountdown() {
  const cd = $('#countdown');
  cd.hidden = false;
  let n = 0;
  const stepLights = () => {
    if (!game) return;
    n++;
    scene.setStartLights(Math.min(n, 5));
    cd.textContent = n <= 5 ? '' : 'GO';
    if (n <= 5) setTimeout(stepLights, 550);
    else {
      scene.setStartLights(0);
      setTimeout(() => { cd.hidden = true; }, 700);
      game.phase = 'question';
      showQuestion();
    }
  };
  setTimeout(stepLights, 400);
}

function showQuestion() {
  const q = game.engine.currentQuestion(PLAYER);
  if (!q) return;
  const done = game.engine.players.get(PLAYER).correct.size;
  $('#qcount').textContent = `Question ${String(done + 1).padStart(2, '0')} / ${RACE.questionsPerRace}`;
  $('#qtext').textContent = q.text;
  const opts = $('#opts');
  opts.replaceChildren(...q.options.map((text, i) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.dataset.i = i;
    b.innerHTML = `<span class="key">${LETTERS[i]}</span><span class="txt"></span>`;
    b.querySelector('.txt').textContent = text;
    b.addEventListener('click', () => answer(i));
    return b;
  }));
  $('#feedback').hidden = true;
  $('#qpanel').hidden = false;
}

async function answer(choice) {
  if (!game || game.phase !== 'question' || game.busy) return;
  const g = game;
  const q = g.engine.currentQuestion(PLAYER);
  const btn = $(`#opts .opt[data-i="${choice}"]`);
  if (!q || !btn || btn.disabled) return;
  const requestId = `${g.raceId ?? 'guest'}:${q.id}:${++g.attempt}`;
  let res;
  if (g.raceId) {
    // The server judges the answer; the request id makes a retried request safe.
    g.busy = true;
    btn.classList.add('checking');
    let verdict;
    for (let tries = 0; tries < 3 && !verdict; tries++) {
      verdict = await api.submitAnswer(g.raceId, q.id, choice, requestId).catch(() => null);
    }
    g.busy = false;
    btn.classList.remove('checking');
    if (game !== g) return;
    if (!verdict) return showConnectionProblem();
    if (verdict.status === 'rejected') return;
    res = g.engine.record(PLAYER, q.id, verdict.status === 'correct', requestId);
  } else {
    res = g.engine.answer(PLAYER, q.id, choice, requestId);
  }
  if (game !== g || g.phase !== 'question') return;
  afterMove(PLAYER, res);
  if (res.status === 'correct') {
    btn.classList.add('right');
    $('#feedback').hidden = true;
    for (const b of document.querySelectorAll('#opts .opt')) b.disabled = true;
    if (res.finished) return finishRace();
    game.phase = 'feedback';
    banner('Correct answer', res.passed ? 'Overtake' : 'Holding P1', 'good');
    setTimeout(() => {
      if (!game || game.engine.finished) return;
      $('#qpanel').hidden = true;
      startFreeDrive();
    }, 1600);
  } else if (res.status === 'wrong') {
    btn.classList.add('wrong');
    btn.disabled = true;
    const fb = $('#feedback');
    fb.hidden = false;
    fb.innerHTML = `<span class="pill bad">Try again</span><span class="pill bad">${res.passedBy ? '−1 position' : 'Last place'}</span>`;
    fb.classList.remove('flash'); void fb.offsetWidth; fb.classList.add('flash');
  }
}

function showConnectionProblem() {
  const fb = $('#feedback');
  fb.hidden = false;
  fb.innerHTML = '<span class="pill bad">Connection problem · tap your answer again</span>';
}

function startFreeDrive() {
  game.phase = 'freedrive';
  game.timer = RACE.freeDriveSeconds;
  scene.setFreeDrive(true);
  $('#freedrive').hidden = false;
  $('#steer').hidden = false;
  updateFreeDriveClock();
}

function endFreeDrive() {
  scene.setFreeDrive(false);
  $('#freedrive').hidden = true;
  $('#steer').hidden = true;
  game.phase = 'question';
  showQuestion();
}

function updateFreeDriveClock() {
  const s = Math.max(0, Math.ceil(game.timer));
  $('#fdclock').textContent = `00:${String(s).padStart(2, '0')}`;
}

function banner(top, big, tone) {
  const b = $('#banner');
  b.className = tone;
  b.innerHTML = `<div class="b-top"></div><div class="b-big"></div>`;
  b.querySelector('.b-top').textContent = top;
  b.querySelector('.b-big').textContent = big;
  b.hidden = false;
  clearTimeout(banner._t);
  banner._t = setTimeout(() => { b.hidden = true; }, 1700);
}

function afterMove(id, res) {
  if (res.status === 'correct' && res.passed) { game.moved[id] = { dir: 'up', at: performance.now() }; game.moved[res.passed] = { dir: 'down', at: performance.now() }; }
  if (res.status === 'wrong' && res.passedBy) { game.moved[id] = { dir: 'down', at: performance.now() }; game.moved[res.passedBy] = { dir: 'up', at: performance.now() }; }
  scene.setOrder(game.engine.order);
  renderPositions();
}

function tickBots(dt) {
  for (const b of game.bots) {
    b.wait -= dt;
    if (b.wait > 0) continue;
    const q = game.engine.currentQuestion(b.id);
    if (!q) continue;
    const res = game.engine.record(b.id, q.id, Math.random() < b.accuracy);
    afterMove(b.id, res);
    if (res.finished) return finishRace();
    // Bots follow the same rhythm as the player: 1.6 s overtake + 15 s drive after a correct answer.
    b.wait = res.status === 'correct' ? 1.6 + RACE.freeDriveSeconds + rand(BOTS.thinkSeconds) : rand([2, 5]);
  }
}

function tick(dt) {
  if (settings.showFps) $('#fps').textContent = `${scene.fps} FPS`;
  if (!game) return;
  if (game.phase === 'question' || game.phase === 'feedback' || game.phase === 'freedrive') tickBots(dt);
  if (!game) return;
  if (game.phase === 'freedrive') {
    scene.steerInput = steerValue();
    game.timer -= dt;
    updateFreeDriveClock();
    if (game.timer <= 0) endFreeDrive();
  }
  pollGamepadButtons();
  if (game.phase !== 'finished' && game.phase !== 'countdown' && (game._mm = (game._mm || 0) + 1) % 3 === 0) {
    scene.drawMinimap($('#minimap').getContext('2d'), game.colors);
  }
}

function finishRace() {
  const engine = game.engine;
  game.phase = 'finished';
  scene.setFreeDrive(false);
  $('#qpanel').hidden = true;
  $('#freedrive').hidden = true;
  $('#steer').hidden = true;
  const youWon = engine.winnerId === PLAYER;
  const winner = engine.players.get(engine.winnerId);
  banner('Race complete', youWon ? 'You win!' : `${winner.name} wins`, youWon ? 'good' : 'neutral');
  const g = game;
  const saved = !g.raceId ? Promise.resolve(null)
    : (youWon ? api.raceSummary(g.raceId) : api.finishSolo(g.raceId, winner.name)).catch(() => null);
  Promise.all([saved, new Promise((r) => setTimeout(r, 2200))]).then(([summary]) => renderResults(engine, g, summary));
}

function renderResults(engine, g, summary) {
  const youWon = engine.winnerId === PLAYER;
  const winner = engine.players.get(engine.winnerId);
  $('#res-title').textContent = youWon ? 'You win!' : `${winner.name} wins`;
  $('#res-rows').replaceChildren(...engine.results().map((r) => {
    const tr = document.createElement('tr');
    if (r.id === PLAYER) tr.className = 'me';
    tr.innerHTML = `<td class="rk"></td><td><span class="chip"></span><span class="nm"></span></td><td class="num"></td>`;
    tr.querySelector('.rk').textContent = r.rank;
    tr.querySelector('.chip').style.background = r.color;
    tr.querySelector('.nm').textContent = r.name;
    if (r.isBot) tr.querySelector('.nm').insertAdjacentHTML('beforeend', '<span class="bot">BOT</span>');
    tr.querySelector('.num').textContent = `${r.correct} / ${RACE.questionsPerRace}`;
    return tr;
  }));
  const rw = engine.rewards(PLAYER);
  $('#rw-first').textContent = `${rw.firstAttempts.count} × 100`;
  $('#rw-correct').textContent = `${rw.correct.count} × 100`;
  if (summary) {
    // Show what the server actually saved, which can be less than the race total
    // when this set's rewards were already earned (replays are practice).
    const e = summary.earned || {};
    const total = Object.values(e).reduce((a, b) => a + Number(b), 0);
    $('#rw-label').textContent = 'O-Bucks saved to your account';
    $('#rw-first-v').textContent = fmt(e.first_attempt || 0);
    $('#rw-correct-v').textContent = fmt(e.first_correct || 0);
    $('#rw-part-v').textContent = fmt(e.participation || 0);
    $('#rw-win-v').textContent = 'Not in Solo';
    $('#rw-total').textContent = fmt(total);
    $('#rw-note').textContent = total < rw.total
      ? `Balance: ${fmt(summary.balance)} O-Bucks. Questions and bonuses already rewarded on this set earn nothing again.`
      : `Balance: ${fmt(summary.balance)} O-Bucks. Every start-to-finish participant earns +500.`;
  } else {
    $('#rw-label').textContent = g.raceId ? 'O-Bucks (could not reach the server)' : 'Guest race · not saved';
    $('#rw-first-v').textContent = fmt(rw.firstAttempts.amount);
    $('#rw-correct-v').textContent = fmt(rw.correct.amount);
    $('#rw-part-v').textContent = fmt(rw.participation.amount);
    $('#rw-win-v').textContent = 'Not in Solo';
    $('#rw-total').textContent = fmt(rw.total);
    $('#rw-note').textContent = g.raceId ? 'Your answers were saved as you raced. Reopen the game to see your balance.' : 'Log in to keep O-Bucks.';
  }
  show('results');
  game = null;
  scene.mode = 'attract';
}

function leaveRace() {
  if (game) game.engine.markLeft(PLAYER);
  game = null;
  scene.setFreeDrive(false);
  showcaseCars().then(() => loadHome());
}

function renderPositions() {
  const list = $('#positions ol');
  const now = performance.now();
  list.replaceChildren(...game.engine.order.map((id, i) => {
    const p = game.engine.players.get(id);
    const li = document.createElement('li');
    if (id === PLAYER) li.className = 'me';
    const mv = game.moved[id];
    const arrow = mv && now - mv.at < 2500 ? (mv.dir === 'up' ? '<span class="up">▲</span>' : '<span class="down">▼</span>') : '';
    li.innerHTML = `<span class="pos">${i + 1}${arrow}</span><span class="chip"></span><span class="nm"></span><span class="cc"></span>`;
    li.querySelector('.chip').style.background = p.color;
    li.querySelector('.nm').textContent = p.name;
    if (p.isBot) li.querySelector('.nm').insertAdjacentHTML('beforeend', '<span class="bot">BOT</span>');
    li.querySelector('.cc').textContent = `${p.correct.size}/10`;
    return li;
  }));
  clearTimeout(renderPositions._t);
  renderPositions._t = setTimeout(() => game && renderPositions(), 2600);
}

// ---------- input: keyboard, touch, gamepad ----------

const keys = new Set();
let touchSteer = 0;

addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  if (!game) return;
  if (game.phase === 'question') {
    const map = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
    const k = e.key.toLowerCase();
    if (k in map) { e.preventDefault(); answer(map[k]); }
  }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

for (const [id, dir] of [['#steer-l', -1], ['#steer-r', 1]]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); touchSteer = dir; });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, () => { if (touchSteer === dir) touchSteer = 0; });
}

function steerValue() {
  let v = touchSteer;
  if (keys.has('arrowleft') || keys.has('a')) v -= 1;
  if (keys.has('arrowright') || keys.has('d')) v += 1;
  const pad = navigator.getGamepads?.()[0];
  if (pad && Math.abs(pad.axes[0]) > 0.15) v += pad.axes[0];
  return Math.max(-1, Math.min(1, v));
}

let padPrev = [];
function pollGamepadButtons() {
  const pad = navigator.getGamepads?.()[0];
  if (!pad) return;
  // Standard layout: A, B, X, Y face buttons answer options A–D.
  [0, 1, 2, 3].forEach((b, i) => {
    const pressed = pad.buttons[b]?.pressed;
    if (pressed && !padPrev[b] && game?.phase === 'question') answer(i);
    padPrev[b] = pressed;
  });
}

// Copy/paste/context-menu friction on the question panel only (C01).
for (const ev of ['contextmenu', 'copy', 'cut', 'paste', 'selectstart', 'dragstart']) {
  $('#qpanel').addEventListener(ev, (e) => e.preventDefault());
}

// ---------- settings ----------

function applySettings() {
  scene?.setQuality(settings.quality);
  scene?.setFpsCap(settings.fpsCap);
  $('#fps').hidden = !settings.showFps;
  for (const b of document.querySelectorAll('[data-quality]')) b.setAttribute('aria-pressed', b.dataset.quality === settings.quality);
  for (const b of document.querySelectorAll('[data-fps]')) b.setAttribute('aria-pressed', Number(b.dataset.fps) === settings.fpsCap);
  $('#show-fps').checked = settings.showFps;
  store.set('quality', settings.quality); store.set('fpsCap', settings.fpsCap); store.set('showFps', settings.showFps);
}

document.querySelectorAll('[data-quality]').forEach((b) => b.addEventListener('click', () => { settings.quality = b.dataset.quality; applySettings(); }));
document.querySelectorAll('[data-fps]').forEach((b) => b.addEventListener('click', () => { settings.fpsCap = Number(b.dataset.fps); applySettings(); }));
$('#show-fps').addEventListener('change', (e) => { settings.showFps = e.target.checked; applySettings(); });
$('#open-settings').addEventListener('click', () => { $('#settings').hidden = false; });
$('#close-settings').addEventListener('click', () => { $('#settings').hidden = true; });

// ---------- navigation ----------

$('#play').addEventListener('click', () => show('modes'));
$('#modes-back').addEventListener('click', () => show('home'));
$('#mode-solo').addEventListener('click', () => startSolo());
$('#again').addEventListener('click', () => startSolo());
$('#res-home').addEventListener('click', () => showcaseCars().then(() => loadHome()));
$('#set-select').addEventListener('change', updateHomeSub);

$('#tab-login').addEventListener('click', () => authTab('login'));
$('#tab-signup').addEventListener('click', () => authTab('signup'));
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  authMessage('Logging in…');
  try {
    await api.logIn($('#li-user').value, $('#li-pass').value);
    authMessage('');
    await route();
  } catch (err) { authMessage(err.message, true); }
});
$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  authMessage('Creating your account…');
  try {
    await api.signUp({
      username: $('#su-user').value, password: $('#su-pass').value,
      firstName: $('#su-first').value, lastName: $('#su-last').value,
    });
    authMessage('');
    await route();
  } catch (err) { authMessage(err.message, true); }
});
$('#guest').addEventListener('click', () => { profile = null; loadHome(); });
for (const b of document.querySelectorAll('.sign-out')) {
  b.addEventListener('click', async () => { await api.logOut(); profile = null; authTab('login'); show('auth'); });
}
$('#pending-refresh').addEventListener('click', () => route());
$('#leave').addEventListener('click', () => leaveRace());

// Read-only handle for automated browser checks; it changes no rules.
window.__sw = { get scene() { return scene; }, get game() { return game; } };

applySettings();
boot().catch((err) => {
  console.error(err);
  $('#loading').textContent = 'The 3D scene could not start on this device. Try another browser.';
});
