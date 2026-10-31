// Screen flow and race controller for the student game.
//
// Two layers run every race:
//   * RaceEngine — the rules: which question each racer is on, correct counts,
//     rewards and the first-to-10 finish. Signed-in answers are judged by the
//     server; guest races use the local sample set.
//   * race-sim — how each car moves: turbo or normal 5 s drives after correct
//     answers, slow-downs after wrong ones, crashes after three wrong in a row,
//     and steering. Track position comes from real distance driven.
// In live races each player simulates their own car and broadcasts its
// position, so everyone sees everyone's driving.

import { RaceEngine } from './race-engine.js';
import { RaceScene } from './race-scene.js';
import { RACE, BOTS, PLAYER_COLOR } from './config.js';
import { SAMPLE_SET } from './questions.js';
import { api, sb } from './supabase.js';
import { RoomSync } from './room-sync.js';
import { SIM, newCar, startRace, onCorrect, onWrong, step, botSteer, rankByDistance } from './race-sim.js';
import { DEFAULT_CAR } from './cars.js';

const $ = (sel) => document.querySelector(sel);
const LETTERS = ['A', 'B', 'C', 'D'];
const PLAYER = 'you';
const BOT_CARS = ['metro', 'sterling', 'heritage', 'trail', 'vortex'];

const store = {
  get(k, d) { try { const v = localStorage.getItem('sw.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sw.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const settings = {
  quality: store.get('quality', matchMedia('(pointer: coarse)').matches ? 'low' : 'medium'),
  fpsCap: store.get('fpsCap', 60),
  showFps: store.get('showFps', false),
};

let scene;
let game = null;     // active race
let profile = null;  // signed-in student, or null for a guest
let sets = [];
let room = null;     // { id, sync, state } while in a live lobby or race
let lastMode = 'solo';
let showcase = [];   // cruising cars behind the menus

const myCar = () => profile?.equipped_car || store.get('car', DEFAULT_CAR);
const myColor = () => profile?.car_color || store.get('carColor', PLAYER_COLOR);

// ---------- boot ----------

async function boot() {
  scene = new RaceScene($('#gl'), { quality: settings.quality, fpsCap: settings.fpsCap });
  scene.onUpdate = (dt) => tick(dt);
  scene.onCrash = (id) => { if (id === PLAYER) crashFx(); };
  await showcaseCars();
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
  if (profile.role === 'parent') { location.href = 'parent.html'; return; }
  if (profile.status !== 'approved') {
    $('#pending-name').textContent = profile.first_name || profile.username;
    return show('pending');
  }
  await loadHome();
  const active = await api.myActiveRoom().catch(() => null);
  if (active) await enterRoom(active);
}

async function loadHome() {
  if (profile) {
    profile = await api.profile();
    sets = await api.releasedSets();
    $('#who-name').textContent = `${profile.first_name} ${profile.last_name}`.trim();
    $('#balance').textContent = fmt(profile.balance);
    $('#stage-note').textContent = sets.length ? '' : 'No races are released yet. Your teacher will release one soon.';
  } else {
    sets = [{ id: 'guest', title: SAMPLE_SET.title, season: SAMPLE_SET.season }];
    $('#who-name').textContent = 'Guest';
    $('#balance').textContent = '0';
    $('#stage-note').textContent = 'Guest race · nothing is saved. Log in to earn O-Bucks.';
  }
  $('#stage-note').hidden = !$('#stage-note').textContent;
  const sel = $('#set-select');
  const keep = sel.value;
  sel.replaceChildren(...sets.filter((st) => !st.mode || st.mode === 'solo').map((st) => new Option(st.season ? `${st.season} · ${st.title}` : st.title, st.id)));
  if (sets.some((st) => st.id === keep)) sel.value = keep;
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

/** Cars cruising behind the menus, with the player's own car in front of the camera. */
async function showcaseCars() {
  scene.mode = 'attract';
  scene.setStartLights(0);
  const lanes = [0, -3.5, 3.5, -3.5, 3.5, 0];
  showcase = [{ id: PLAYER, car: myCar(), color: myColor() }, ...BOT_CARS.map((c, i) => ({ id: `show${i}`, car: c, color: BOTS.colors[i] }))]
    .map((c, i) => ({ ...c, state: Object.assign(newCar({ lane: lanes[i], d: 400 - i * 14 }), { mode: 'cruise', v: SIM.cruise }) }));
  await scene.setCars(showcase);
  scene.setPlayer(PLAYER);
}

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  document.body.dataset.screen = id;
}

// ---------- race setup ----------

function rand([a, b]) { return a + Math.random() * (b - a); }

/** Grid: two columns, rows 9 m apart. */
function gridSlot(i) { return { lane: i % 2 ? 3.2 : -3.2, d: 60 - Math.floor(i / 2) * 9 }; }

async function beginRace({ participants, questions, mode, raceId = null, roomId = null, key = (x) => x }) {
  const engine = new RaceEngine({ participants, questions, mode });
  const racers = new Map();
  participants.forEach((p, i) => {
    const car = newCar(gridSlot(i));
    racers.set(p.id, { ...p, car, lane: gridSlot(i).lane });
  });
  game = {
    engine, racers, raceId, roomId, key, mode,
    eventResults: {}, busy: false, phase: 'countdown', attempt: 0,
    driveLeft: 0, lockUntil: 0, streak: 0,
    colors: Object.fromEntries(participants.map((p) => [p.id, p.color])),
    sendAt: 0, lastRank: {},
  };
  lastMode = mode === 'solo' ? 'solo' : mode;
  scene.mode = 'race';
  await scene.setCars(participants.map((p) => ({ id: p.id, car: p.car, color: p.color, state: racers.get(p.id).car })));
  scene.setPlayer(PLAYER);
  for (const id of ['#qpanel', '#drive', '#banner', '#crash']) $(id).hidden = true;
  $('#steer').hidden = false;
  renderPositions();
  show('hud');
}

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
      $('#stage-note').hidden = false;
      return show('home');
    }
  }
  const participants = [
    ...BOTS.names.map((name, i) => ({ id: name, name, isBot: true, color: BOTS.colors[i], car: BOT_CARS[i] })),
    { id: PLAYER, name: 'You', color: myColor(), car: myCar() },
  ];
  await beginRace({ participants, questions, mode: 'solo', raceId });
  for (const p of participants) {
    if (p.isBot) game.racers.get(p.id).ai = { accuracy: rand(BOTS.accuracy), wait: rand(BOTS.thinkSeconds) + 3 };
  }
  runCountdown();
}

function runCountdown() {
  const cd = $('#countdown');
  cd.hidden = false;
  let n = 0;
  const g = game;
  const stepLights = () => {
    if (game !== g) return;
    n++;
    scene.setStartLights(Math.min(n, 5));
    cd.textContent = n <= 2 ? '' : n <= 5 ? String(6 - n) : 'GO!';
    if (n <= 5) setTimeout(stepLights, 600);
    else {
      scene.setStartLights(0);
      setTimeout(() => { cd.hidden = true; }, 700);
      for (const r of g.racers.values()) startRace(r.car);
      g.phase = 'question';
      showQuestion();
    }
  };
  setTimeout(stepLights, 400);
}

// ---------- questions ----------

function showQuestion() {
  const q = game.engine.currentQuestion(PLAYER);
  if (!q) return;
  const done = game.engine.players.get(PLAYER).correct.size;
  $('#qcount').textContent = `Question ${String(done + 1).padStart(2, '0')} / ${RACE.questionsPerRace}`;
  $('#qtext').textContent = q.text;
  $('#opts').replaceChildren(...q.options.map((text, i) => {
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
  if (performance.now() < game.lockUntil) return; // recovering from a crash
  const g = game;
  const q = g.engine.currentQuestion(PLAYER);
  const btn = $(`#opts .opt[data-i="${choice}"]`);
  if (!q || !btn || btn.disabled) return;
  const firstTry = !g.engine.players.get(PLAYER).attempted.has(q.id);
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
    if (g.roomId) {
      // Live race: our answer comes back as a room event, in database order.
      await room?.sync.refresh();
      if (verdict.status === 'rejected') return;
      res = g.eventResults[verdict.event_id];
      if (!res) return;
    } else {
      if (verdict.status === 'rejected') return;
      res = g.engine.record(PLAYER, q.id, verdict.status === 'correct', requestId);
    }
  } else {
    res = g.engine.answer(PLAYER, q.id, choice, requestId);
  }
  if (game !== g || g.phase !== 'question') return;
  const me = g.racers.get(PLAYER).car;

  if (res.status === 'correct') {
    btn.classList.add('right');
    for (const b of document.querySelectorAll('#opts .opt')) b.disabled = true;
    $('#feedback').hidden = true;
    if (res.finished) return finishRace();
    onCorrect(me, firstTry);
    g.streak = firstTry ? g.streak + 1 : 0;
    if (firstTry) banner(g.streak >= 3 ? `Streak ×${g.streak}` : 'Perfect answer', 'Turbo boost', 'turbo');
    else banner('Correct', 'Drive!', 'good');
    setTimeout(() => {
      if (game !== g || g.phase === 'finished') return;
      $('#qpanel').hidden = true;
      g.phase = 'drive';
      g.driveLeft = SIM.driveSeconds;
      $('#drive').hidden = false;
      $('#drive').className = firstTry ? 'turbo' : '';
      $('#drive-label').textContent = firstTry ? 'Turbo' : 'Drive';
    }, 700);
  } else if (res.status === 'wrong') {
    btn.classList.add('wrong');
    btn.disabled = true;
    g.streak = 0;
    const crashed = onWrong(me);
    const fb = $('#feedback');
    fb.hidden = false;
    if (crashed) {
      g.lockUntil = performance.now() + SIM.crashSeconds * 1000;
      fb.innerHTML = '<span class="pill bad">Crashed · get back on track</span>';
    } else {
      const left = SIM.crashAfterWrongs - me.wrongStreak;
      fb.innerHTML = `<span class="pill bad">Try again</span><span class="pill warn">${left === 1 ? 'One more wrong = crash' : 'Slowing down'}</span>`;
    }
    fb.classList.remove('flash'); void fb.offsetWidth; fb.classList.add('flash');
  }
}

function showConnectionProblem() {
  const fb = $('#feedback');
  fb.hidden = false;
  fb.innerHTML = '<span class="pill bad">Connection problem · tap your answer again</span>';
}

function banner(top, big, tone) {
  const b = $('#banner');
  b.className = tone;
  b.innerHTML = '<div class="b-top"></div><div class="b-big"></div>';
  b.querySelector('.b-top').textContent = top;
  b.querySelector('.b-big').textContent = big;
  b.hidden = false;
  clearTimeout(banner._t);
  banner._t = setTimeout(() => { b.hidden = true; }, 1500);
}

function crashFx() {
  const c = $('#crash');
  c.hidden = false;
  c.classList.remove('go'); void c.offsetWidth; c.classList.add('go');
  clearTimeout(crashFx._t);
  crashFx._t = setTimeout(() => { c.hidden = true; }, 2200);
  navigator.vibrate?.(250);
}

// ---------- per-frame ----------

function tick(dt) {
  if (settings.showFps) $('#fps').textContent = `${scene.fps} FPS`;
  if (!game) {
    for (const c of showcase) step(c.state, dt, botSteer(c.state, c.state.lat > 0 ? 3.5 : c.state.lat < -1 ? -3.5 : 0), () => 0.5);
    return;
  }
  const g = game;
  pollGamepadButtons();
  const steerIn = steerValue();

  for (const [id, r] of g.racers) {
    if (id === PLAYER) {
      step(r.car, dt, g.phase === 'countdown' ? 0 : steerIn);
    } else if (r.ai) {
      tickBot(id, r, dt);
    } else if (r.remote) {
      tickRemote(r, dt);
    }
  }
  if (game !== g) return;

  if (g.phase === 'drive') {
    g.driveLeft -= dt;
    $('#drive-clock').textContent = `00:0${Math.max(0, Math.ceil(g.driveLeft))}`;
    if (g.driveLeft <= 0) {
      $('#drive').hidden = true;
      g.phase = 'question';
      showQuestion();
    }
  }
  const me = g.racers.get(PLAYER).car;
  $('#speed').textContent = Math.round(me.v * 5.4);
  $('#offroad').hidden = !(me.offRoad && me.v > 3);
  if (g.roomId) {
    $('#net').hidden = room?.sync.online !== false;
    broadcastMyCar(me);
  }
  if ((g._mm = (g._mm || 0) + 1) % 4 === 0) {
    renderPositions();
    scene.drawMinimap($('#minimap').getContext('2d'), g.colors);
  }
}

function tickBot(id, r, dt) {
  const g = game;
  step(r.car, dt, botSteer(r.car, r.lane));
  if (g.phase === 'countdown' || g.phase === 'finished') return;
  r.ai.wait -= dt;
  if (r.ai.wait > 0 || r.car.mode === 'crash') return;
  const q = g.engine.currentQuestion(id);
  if (!q) return;
  const firstTry = !g.engine.players.get(id).attempted.has(q.id);
  const res = g.engine.record(id, q.id, Math.random() < r.ai.accuracy);
  if (res.finished) return finishRace();
  if (res.status === 'correct') {
    onCorrect(r.car, firstTry);
    r.ai.wait = SIM.driveSeconds + 0.7 + rand(BOTS.thinkSeconds);
  } else {
    const crashed = onWrong(r.car);
    r.ai.wait = (crashed ? SIM.crashSeconds : 0) + rand([1.5, 4]);
  }
}

// ---------- live race: car positions over Realtime broadcast ----------

function openCarChannel(roomId) {
  const ch = sb.channel(`cars-${roomId}`, { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'pos' }, ({ payload }) => {
    const r = game?.racers.get(game.key(payload.id));
    if (!r || !r.remote) return;
    r.remote.target = payload;
    r.remote.at = performance.now();
  }).subscribe();
  return ch;
}

function broadcastMyCar(me) {
  const now = performance.now();
  if (!game.carChannel || now < game.sendAt) return;
  game.sendAt = now + 125; // 8 updates a second
  game.carChannel.send({
    type: 'broadcast', event: 'pos',
    payload: { id: room.state.me, d: +me.d.toFixed(2), lat: +me.lat.toFixed(2), latV: +me.latV.toFixed(2), v: +me.v.toFixed(2), mode: me.mode, spin: +me.crashSpin.toFixed(2) },
  });
}

/** Remote cars: run the same physics locally, pulled smoothly towards their broadcast position. */
function tickRemote(r, dt) {
  const c = r.car;
  const t = r.remote.target;
  step(c, dt, 0, () => 0.5);
  if (!t) return;
  const age = (performance.now() - r.remote.at) / 1000;
  if (age > 3) return; // stale: keep simulating from their answers alone
  const d = t.d + t.v * age;
  const k = Math.min(1, dt * 4);
  c.d += (d - c.d) * k;
  c.lat += (t.lat - c.lat) * k;
  c.latV = t.latV;
  c.v = t.v;
  c.mode = t.mode;
  c.crashSpin = t.spin;
  c.offRoad = Math.abs(c.lat) + SIM.carHalf > SIM.roadHalf + 0.4;
}

// ---------- finish ----------

function finishRace() {
  const g = game;
  const engine = g.engine;
  if (g.phase === 'finished') return;
  // Live race finished by an answer this screen has not replayed yet: trust the server's winner.
  if (!engine.winnerId && g.roomId && room?.state?.winner_id) {
    engine.finished = true;
    engine.winnerId = g.key(room.state.winner_id);
  }
  g.phase = 'finished';
  for (const id of ['#qpanel', '#drive', '#steer']) $(id).hidden = true;
  const winnerCar = g.racers.get(engine.winnerId)?.car;
  if (winnerCar) onCorrect(winnerCar, true); // victory lap burst
  const youWon = engine.winnerId === PLAYER;
  const winner = engine.players.get(engine.winnerId);
  banner('Race complete', youWon ? 'You win!' : `${winner.name} wins`, youWon ? 'turbo' : 'neutral');
  const saved = !g.raceId ? Promise.resolve(null)
    : (youWon || g.roomId ? api.raceSummary(g.raceId) : api.finishSolo(g.raceId, winner.name)).catch(() => null);
  Promise.all([saved, new Promise((r) => setTimeout(r, 2600))]).then(([summary]) => renderResults(engine, g, summary));
}

function renderResults(engine, g, summary) {
  const youWon = engine.winnerId === PLAYER;
  const winner = engine.players.get(engine.winnerId);
  $('#res-title').textContent = youWon ? 'You win!' : `${winner.name} wins`;
  $('#res-rows').replaceChildren(...engine.results().map((r) => {
    const tr = document.createElement('tr');
    if (r.id === PLAYER) tr.className = 'me';
    tr.innerHTML = '<td class="rk"></td><td><span class="chip"></span><span class="nm"></span></td><td class="num"></td>';
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
    const e = summary.earned || {};
    const total = Object.values(e).reduce((a, b) => a + Number(b), 0);
    $('#rw-label').textContent = 'O-Bucks saved to your account';
    $('#rw-first-v').textContent = fmt(e.first_attempt || 0);
    $('#rw-correct-v').textContent = fmt(e.first_correct || 0);
    $('#rw-part-v').textContent = fmt(e.participation || 0);
    $('#rw-win-v').textContent = g.roomId ? fmt(e.winner || 0) : 'Not in Solo';
    $('#rw-total').textContent = fmt(total);
    $('#rw-note').textContent = total < rw.total
      ? `Balance: ${fmt(summary.balance)} O-Bucks. Questions and bonuses already rewarded on this set earn nothing again.`
      : `Balance: ${fmt(summary.balance)} O-Bucks. Every start-to-finish racer earns +500.`;
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
  if (g.roomId) stopRoom();
  game = null;
  scene.mode = 'attract';
}

function leaveRace() {
  if (game) game.engine.markLeft(PLAYER);
  if (game?.roomId) { api.leaveRoom(game.roomId).catch(() => {}); stopRoom(); }
  game = null;
  showcaseCars().then(() => loadHome());
}

function renderPositions() {
  const g = game;
  const order = rankByDistance([...g.racers.entries()].map(([id, r]) => ({ id, car: r.car })));
  const now = performance.now();
  order.forEach((id, i) => {
    const prev = g.lastRank[id];
    if (prev !== undefined && prev !== i) g.racers.get(id).moved = { dir: i < prev ? 'up' : 'down', at: now };
    g.lastRank[id] = i;
  });
  const leader = g.racers.get(order[0]).car.d;
  $('#positions ol').replaceChildren(...order.map((id, i) => {
    const r = g.racers.get(id);
    const p = g.engine.players.get(id);
    const li = document.createElement('li');
    if (id === PLAYER) li.className = 'me';
    const mv = r.moved && now - r.moved.at < 2000 ? r.moved.dir : null;
    li.innerHTML = `<span class="pos">${i + 1}${mv === 'up' ? '<span class="up">▲</span>' : mv === 'down' ? '<span class="down">▼</span>' : ''}</span><span class="chip"></span><span class="nm"></span><span class="cc"></span>`;
    li.querySelector('.chip').style.background = r.color;
    li.querySelector('.nm').textContent = p.name;
    if (p.isBot) li.querySelector('.nm').insertAdjacentHTML('beforeend', '<span class="bot">BOT</span>');
    const gap = Math.round(leader - r.car.d);
    li.querySelector('.cc').textContent = i === 0 || gap < 1 ? `${p.correct.size}/10` : `−${gap} m`;
    if (r.car.mode === 'crash') li.classList.add('crashed');
    return li;
  }));
}

// ---------- live rooms (Friends / Teacher) ----------

const RIVAL_COLORS = BOTS.colors.concat(['#ff5fa2', '#9be15d', '#ffffff']);

async function openJoin(kind) {
  if (!profile) {
    $('#stage-note').textContent = 'Log in to race your friends and class. Guest races are Solo only.';
    $('#stage-note').hidden = false;
    return show('home');
  }
  lastMode = kind;
  $('#join-msg').textContent = '';
  $('#join-code').value = '';
  const friends = kind === 'friends';
  $('#create-form').hidden = !friends;
  $('#join-label').textContent = friends ? 'Join a friend’s lobby' : 'Enter the code your teacher shows';
  if (friends) {
    const list = sets.filter((st) => st.mode === 'friends');
    $('#friends-set').replaceChildren(...list.map((st) => new Option([st.season, st.title].filter(Boolean).join(' · '), st.id)));
    $('#create-empty').hidden = list.length > 0;
    $('#create-form button').disabled = list.length === 0;
  }
  show('join');
}

async function enterRoom(roomId) {
  stopRoom();
  room = { id: roomId, state: null, sync: null };
  room.sync = new RoomSync(roomId, onRoomUpdate);
  const st = await room.sync.refresh();
  if (!st && room?.id === roomId) {
    stopRoom();
    $('#join-msg').textContent = 'Could not open that race. Check your connection and try again.';
    show('join');
  }
}

function stopRoom() {
  if (game?.carChannel) { sb.removeChannel(game.carChannel); game.carChannel = null; }
  room?.sync.stop();
  room = null;
}

function onRoomUpdate(st, fresh) {
  if (!room || st.id !== room.id) return;
  room.state = st;
  lastMode = st.mode;
  if (st.status === 'cancelled') {
    stopRoom();
    loadHome().then(() => { $('#stage-note').textContent = 'That lobby was closed by its host.'; $('#stage-note').hidden = false; });
    return;
  }
  if (st.status === 'lobby') return renderLobby(st);
  if (!st.my_race_id) return; // not a racer in this room
  if (!game || game.roomId !== st.id) {
    if (st.status === 'finished') { stopRoom(); return loadHome(); }
    if (!room.starting) { room.starting = true; startLiveRace(st, fresh); }
    return;
  }
  applyRoomEvents(fresh);
  if (st.status === 'finished' && game.phase !== 'finished') finishRace();
}

function renderLobby(st) {
  if (document.body.dataset.screen !== 'lobby') { $('#lobby-msg').textContent = ''; show('lobby'); }
  const teacherRoom = st.mode === 'teacher';
  $('#lobby-kind').textContent = teacherRoom ? `Class race · ${st.host_name}` : 'Friends race';
  $('#lobby-title').textContent = [st.season, st.title].filter(Boolean).join(' · ');
  $('#lobby-code').textContent = st.code;
  $('#lobby-players').replaceChildren(...st.players.map((p) => {
    const li = document.createElement('li');
    if (p.id === st.me) li.className = 'me';
    li.innerHTML = '<span class="nm"></span><span class="state"></span>';
    li.querySelector('.nm').textContent = p.id === st.me ? `${p.name} (you)` : p.name;
    const state = li.querySelector('.state');
    state.textContent = teacherRoom ? 'Joined' : p.ready ? 'Ready' : 'Not ready';
    if (teacherRoom || p.ready) state.classList.add('ready');
    return li;
  }));
  const me = st.players.find((p) => p.id === st.me);
  $('#lobby-ready').hidden = teacherRoom;
  $('#lobby-ready').textContent = me?.ready ? 'Not ready' : 'Ready';
  const allReady = st.players.length >= 2 && st.players.every((p) => p.ready);
  $('#lobby-start').hidden = !st.is_host;
  $('#lobby-start').disabled = !allReady;
  $('#lobby-hint').textContent = teacherRoom ? 'Waiting for your teacher to start the race.'
    : st.is_host ? (allReady ? 'Everyone is ready.' : `Share code ${st.code} with friends in your group. Start when everyone is ready.`)
    : `Waiting for ${st.host_name} to start.`;
}

async function startLiveRace(st, events) {
  const key = (id) => (id === st.me ? PLAYER : id);
  let c = 0;
  const participants = st.players.map((p) => ({
    id: key(p.id), name: p.id === st.me ? 'You' : p.name,
    color: p.id === st.me ? myColor() : (p.car_color || RIVAL_COLORS[c++ % RIVAL_COLORS.length]),
    car: p.id === st.me ? myCar() : (p.car || DEFAULT_CAR),
  }));
  await beginRace({ participants, questions: st.questions, mode: st.mode, raceId: st.my_race_id, roomId: st.id, key });
  for (const [id, r] of game.racers) if (id !== PLAYER) r.remote = { target: null, at: 0 };
  for (const p of st.players) if (p.left) game.engine.markLeft(key(p.id));
  game.carChannel = openCarChannel(st.id);
  applyRoomEvents(events);
  if (game.engine.finished || st.status === 'finished') return finishRace();
  // Joining (or reloading) well after the start skips the start lights.
  const late = st.started_at && Date.now() - Date.parse(st.started_at) > 6000;
  if (late) {
    for (const r of game.racers.values()) startRace(r.car);
    game.phase = 'question';
    showQuestion();
  } else runCountdown();
}

/** Room events update the rules engine, and drive remote cars when their broadcast is missing. */
function applyRoomEvents(events) {
  for (const ev of events) {
    const id = game.key(ev.student_id);
    const p = game.engine.players.get(id);
    const firstTry = p && !p.attempted.has(ev.question_id);
    const res = game.engine.record(id, ev.question_id, ev.correct, `ev${ev.id}`);
    game.eventResults[ev.id] = res;
    const r = game.racers.get(id);
    if (id !== PLAYER && r && res.status !== 'rejected' && !(r.remote?.target && performance.now() - r.remote.at < 3000)) {
      if (res.status === 'correct') onCorrect(r.car, firstTry); else onWrong(r.car);
    }
  }
}

// ---------- input: keyboard, touch, gamepad ----------

const keys = new Set();
let touchSteer = 0;

addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  if (!game) return;
  if (e.key.startsWith('Arrow')) e.preventDefault();
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
  // A/D steer only while driving; during questions they choose answers.
  const letters = game?.phase === 'drive';
  if (keys.has('arrowleft') || (letters && keys.has('a'))) v -= 1;
  if (keys.has('arrowright') || (letters && keys.has('d'))) v += 1;
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

document.querySelectorAll('[data-quality]').forEach((b) => b.addEventListener('click', () => {
  settings.quality = b.dataset.quality;
  applySettings();
  // Paint quality is baked into car materials: rebuild the cars on screen.
  if (!game) showcaseCars();
}));
document.querySelectorAll('[data-fps]').forEach((b) => b.addEventListener('click', () => { settings.fpsCap = Number(b.dataset.fps); applySettings(); }));
$('#show-fps').addEventListener('change', (e) => { settings.showFps = e.target.checked; applySettings(); });
$('#open-settings').addEventListener('click', () => { $('#settings').hidden = false; });
$('#close-settings').addEventListener('click', () => { $('#settings').hidden = true; });

// ---------- navigation ----------

$('#play').addEventListener('click', () => show('modes'));
$('#modes-back').addEventListener('click', () => show('home'));
$('#mode-solo').addEventListener('click', () => startSolo());
$('#mode-friends').addEventListener('click', () => openJoin('friends'));
$('#mode-teacher').addEventListener('click', () => openJoin('teacher'));
$('#join-back').addEventListener('click', () => show('modes'));
$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { const r = await api.createRoom($('#friends-set').value); await enterRoom(r.room_id); }
  catch (err) { $('#join-msg').textContent = err.message; }
});
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { const r = await api.joinRoom($('#join-code').value); await enterRoom(r.room_id); }
  catch (err) { $('#join-msg').textContent = err.message; }
});
$('#lobby-ready').addEventListener('click', async () => {
  const me = room?.state?.players.find((p) => p.id === room.state.me);
  if (!me) return;
  await api.setReady(room.id, !me.ready).catch((err) => { $('#lobby-msg').textContent = err.message; });
  room?.sync.refresh();
});
$('#lobby-start').addEventListener('click', async () => {
  $('#lobby-msg').textContent = '';
  try { await api.startRoom(room.id); room.sync.refresh(); } catch (err) { $('#lobby-msg').textContent = err.message; }
});
$('#lobby-leave').addEventListener('click', async () => {
  const id = room?.id;
  stopRoom();
  if (id) await api.leaveRoom(id).catch(() => {});
  loadHome();
});
$('#again').addEventListener('click', () => (lastMode === 'solo' ? startSolo() : openJoin(lastMode)));
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
    await showcaseCars();
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
