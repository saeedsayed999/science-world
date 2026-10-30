// Two real accounts race each other through the live Supabase project.
// Needs .test-accounts.json (git-ignored) and supabase/multiplayer.sql applied.
// Usage: node tests/live-multiplayer.mjs
import { readFileSync } from 'node:fs';
import { SUPABASE_URL as U, SUPABASE_KEY as K } from './live-config.mjs';
import { parseQuestionFile } from '../js/import-sets.js';

const creds = JSON.parse(readFileSync(new URL('../.test-accounts.json', import.meta.url)));
const log = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function as(username) {
  const r = await fetch(`${U}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: K, 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${username}@accounts.scienceworld.app`, password: creds[username] }),
  });
  const { access_token: t } = await r.json();
  const h = { apikey: K, authorization: `Bearer ${t}`, 'content-type': 'application/json' };
  return {
    async rpc(fn, args = {}) {
      const res = await fetch(`${U}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(args) });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.message || res.status);
      return j;
    },
    async insert(table, row) {
      const res = await fetch(`${U}/rest/v1/${table}`, { method: 'POST', headers: { ...h, prefer: 'return=representation' }, body: JSON.stringify(row) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message);
      return j[0];
    },
  };
}
const fails = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message); } };

const teacher = await as('demo.teacher');
const ali = await as('demo.ali');
const sara = await as('demo.sara');
const { questions } = parseQuestionFile(readFileSync(new URL('../samples/plant-season-set.csv', import.meta.url), 'utf8'));
const stamp = new Date().toISOString().slice(11, 19);
const friendsSet = await teacher.insert('question_sets', { title: `Friends test ${stamp}`, season: 'Test', mode: 'friends', questions, released: true, released_at: new Date().toISOString() });
const classSet = await teacher.insert('question_sets', { title: `Class test ${stamp}`, season: 'Test', mode: 'teacher', questions, released: false });

// Race one player through a room at a given pace; returns the ledger total for their race.
async function racer(client, roomId, { pace, wrongFirst = 0, stopAfter = 10 }) {
  const st = await client.rpc('room_state', { p_room: roomId });
  const race = st.my_race_id;
  for (let w = 0; w < wrongFirst; w++) {
    await client.rpc('submit_answer', { p_race_id: race, p_question_id: 'q1', p_choice: (questions[0].answer + 1) % 4, p_request_id: `${race}:w${w}` });
  }
  for (let i = 0; i < stopAfter; i++) {
    await sleep(pace);
    const r = await client.rpc('submit_answer', { p_race_id: race, p_question_id: `q${i + 1}`, p_choice: questions[i].answer, p_request_id: `${race}:${i}` });
    if (r.status === 'rejected') return { race, stoppedAt: i, reason: r.reason };
    if (r.finished) return { race, finished: true };
  }
  return { race };
}

// ---------- Friends race: Ali hosts, Sara joins; Ali is faster and wins ----------
const room = await ali.rpc('create_room', { p_set_id: friendsSet.id });
log(/^[A-Z2-9]{5}$/.test(room.code), `Ali opened a Friends lobby (code ${room.code})`);
await sara.rpc('join_room', { p_code: room.code.toLowerCase() });
log(await fails(ali.rpc('start_room', { p_room: room.room_id }), /Ready/), 'cannot start until everyone is ready');
await sara.rpc('set_ready', { p_room: room.room_id, p_ready: true });
await ali.rpc('set_ready', { p_room: room.room_id, p_ready: true });
const lobby = await sara.rpc('room_state', { p_room: room.room_id });
log(lobby.players.length === 2 && lobby.players.every((p) => p.ready), 'both players see each other ready in the lobby');
await ali.rpc('start_room', { p_room: room.room_id });

const t0 = Date.now();
const [a, s] = await Promise.all([
  racer(ali, room.room_id, { pace: 150, wrongFirst: 2 }),
  racer(sara, room.room_id, { pace: 420 }),
]);
log(a.finished === true, `Ali reached 10 correct first (${Date.now() - t0} ms, two wrong answers on the way)`);
log(s.reason === 'race-finished', `Sara was stopped mid-race by the finish (after ${s.stoppedAt} answers)`);

const end = await sara.rpc('room_state', { p_room: room.room_id });
const aliProfile = await ali.rpc('my_profile');
log(end.status === 'finished' && end.winner_id === aliProfile.id, 'Sara\'s client sees the race finished with Ali as winner');
const ids = end.events.map((e) => e.id);
log(ids.every((v, i) => i === 0 || v > ids[i - 1]) && end.events.length === 12 + s.stoppedAt, `both players see one ordered event list (${end.events.length} events)`);
const aSum = await ali.rpc('race_summary', { p_race_id: a.race });
const sSum = await sara.rpc('race_summary', { p_race_id: s.race });
const total = (x) => Object.values(x.earned).reduce((m, v) => m + Number(v), 0);
log(total(aSum) === 2700, `winner earned ${total(aSum)} (1,000 + 1,000 + 500 + 200)`);
const sExpected = (s.stoppedAt + 1) * 100 + s.stoppedAt * 100 + 500;
log(total(sSum) === sExpected || total(sSum) === s.stoppedAt * 200 + 500, `Sara earned ${total(sSum)} including the 500 participation bonus`);

// ---------- Class race: teacher hosts, both join with the code ----------
const croom = await teacher.rpc('create_room', { p_set_id: classSet.id });
log(await fails(ali.rpc('create_room', { p_set_id: classSet.id }), /Only teachers/), 'students cannot host a class race');
await ali.rpc('join_room', { p_code: croom.code });
await sara.rpc('join_room', { p_code: croom.code });
const tview = await teacher.rpc('room_state', { p_room: croom.room_id });
log(tview.players.length === 2 && tview.my_race_id === null, 'teacher sees both students and is not a racer');
await teacher.rpc('start_room', { p_room: croom.room_id });
const [ca, cs] = await Promise.all([
  racer(ali, croom.room_id, { pace: 400 }),
  racer(sara, croom.room_id, { pace: 120 }),
]);
log(cs.finished === true && ca.reason === 'race-finished', 'Sara won the class race; Ali\'s race ended at the same moment');
const live = await teacher.rpc('room_state', { p_room: croom.room_id });
log(live.status === 'finished' && live.players.find((p) => p.correct === 10), 'teacher view shows the finished race and the winner\'s 10/10');
const cSum = await sara.rpc('race_summary', { p_race_id: cs.race });
log(total(cSum) === 2700, `class-race winner earned ${total(cSum)}; Friends rewards did not block it (separate banks)`);
