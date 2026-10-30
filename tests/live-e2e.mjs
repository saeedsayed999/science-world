// End-to-end check against the real Supabase project, using the synthetic
// accounts in .test-accounts.json (git-ignored). Not part of `npm test`.
// Usage: node tests/live-e2e.mjs [phase]   phase: pending | full
import { readFileSync } from 'node:fs';
import { SUPABASE_URL as U, SUPABASE_KEY as K } from './live-config.mjs';

const creds = JSON.parse(readFileSync(new URL('../.test-accounts.json', import.meta.url)));
const phase = process.argv[2] || 'full';
const log = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) process.exitCode = 1; };

async function login(username) {
  const r = await fetch(`${U}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: K, 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${username}@accounts.scienceworld.app`, password: creds[username] }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login ${username}: ${JSON.stringify(j)}`);
  return j.access_token;
}
function client(token) {
  const h = { apikey: K, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    rpc: async (fn, args = {}) => {
      const r = await fetch(`${U}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(args) });
      const j = await r.json().catch(() => null);
      return r.ok ? { data: j } : { error: j?.message || r.status };
    },
    table: async (path, method = 'GET', body) => {
      const r = await fetch(`${U}/rest/v1/${path}`, { method, headers: { ...h, prefer: 'return=representation' }, body: body && JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      return r.ok ? { data: j } : { error: j?.message || r.status };
    },
  };
}

const ali = client(await login('demo.ali'));
const me = (await ali.rpc('my_profile')).data;
log(me?.username === 'demo.ali', `profile created for demo.ali (status ${me?.status}, role ${me?.role})`);

if (phase === 'pending') {
  const s = await ali.rpc('start_race', { p_set_id: '00000000-0000-0000-0000-000000000000' });
  log(/not approved/.test(s.error || ''), `pending student cannot start a race (${s.error})`);
  const sets = await ali.table('question_sets?select=id');
  log(Array.isArray(sets.data) && sets.data.length === 0, 'student cannot read question_sets table');
  const t = client(await login('demo.teacher'));
  const tp = (await t.rpc('my_profile')).data;
  log(tp.role === 'student', `self-requested accounts are never teachers (demo.teacher role: ${tp.role})`);
  process.exit();
}

// ---- full flow (after demo.teacher is promoted) ----
const teacher = client(await login('demo.teacher'));
const tp = (await teacher.rpc('my_profile')).data;
log(tp.role === 'teacher' && tp.status === 'approved', 'demo.teacher is an approved teacher');

const students = (await teacher.rpc('teacher_students')).data;
const sara = students.find((s) => s.username === 'demo.sara');
const aliRow = students.find((s) => s.username === 'demo.ali');
log(!!sara && !!aliRow, `teacher sees ${students.length} student accounts`);
for (const s of [aliRow, sara]) await teacher.rpc('set_account_status', { p_user: s.id, p_status: 'approved' });

const sample = readFileSync(new URL('../samples/plant-season-set.csv', import.meta.url), 'utf8');
const { parseQuestionFile } = await import('../js/import-sets.js');
const { questions } = parseQuestionFile(sample);
const hidden = await teacher.table('question_sets', 'POST', { title: 'E2E hidden draft', season: 'Test', mode: 'solo', questions, released: false });
const released = await teacher.table('question_sets', 'POST', { title: 'Forest Valley Circuit', season: 'Plant Season', mode: 'solo', questions, released: true, released_at: new Date().toISOString() });
log(!hidden.error && !released.error, 'teacher imported a hidden draft and a released set');
const hiddenId = hidden.data[0].id, setId = released.data[0].id;

const aliNow = client(await login('demo.ali'));
const visible = (await aliNow.rpc('list_released_sets')).data;
log(visible.some((s) => s.id === setId) && !visible.some((s) => s.id === hiddenId), 'student sees the released set only');
const blocked = await aliNow.rpc('start_race', { p_set_id: hiddenId });
log(/not available/.test(blocked.error || ''), 'hidden draft cannot be started by id (AC06)');

const race = (await aliNow.rpc('start_race', { p_set_id: setId })).data;
log(race.questions.length === 10 && race.questions.every((q) => q.answer === undefined), 'race questions arrive without answer keys');

const before = (await aliNow.rpc('my_profile')).data.balance;
const wrong = (await aliNow.rpc('submit_answer', { p_race_id: race.race_id, p_question_id: 'q1', p_choice: 0, p_request_id: `${race.race_id}:1` })).data;
log(wrong.status === 'wrong', 'wrong answer judged by the server');
for (let i = 0; i < 10; i++) {
  const req = { p_race_id: race.race_id, p_question_id: `q${i + 1}`, p_choice: questions[i].answer, p_request_id: `${race.race_id}:c${i}` };
  const r = (await aliNow.rpc('submit_answer', req)).data;
  if (i === 0) {
    const dup = (await aliNow.rpc('submit_answer', req)).data;
    log(dup.duplicate === true, 'repeated request is applied once (AC16)');
  }
  if (i === 9) log(r.finished === true, '10th correct answer finishes the race');
}
const summary = (await aliNow.rpc('race_summary', { p_race_id: race.race_id })).data;
log(summary.balance - before === 2500, `Solo win saved 2,500 O-Bucks (balance ${summary.balance})`);

const replay = (await aliNow.rpc('start_race', { p_set_id: setId })).data;
for (let i = 0; i < 10; i++) await aliNow.rpc('submit_answer', { p_race_id: replay.race_id, p_question_id: `q${i + 1}`, p_choice: questions[i].answer, p_request_id: `${replay.race_id}:${i}` });
const after = (await aliNow.rpc('race_summary', { p_race_id: replay.race_id })).data;
log(after.balance === summary.balance, 'replaying the same set adds no O-Bucks (AC19)');

const saraC = client(await login('demo.sara'));
const peek = await saraC.table(`reward_ledger?student_id=eq.${aliRow.id}&select=amount`);
log(Array.isArray(peek.data) && peek.data.length === 0, 'another student cannot read Ali\'s O-Bucks');
const forge = await saraC.table('reward_ledger', 'POST', { student_id: sara.id, event_key: 'forged', kind: 'adjustment', amount: 99999 });
log(!!forge.error, 'a student cannot write O-Bucks directly');

const listed = (await teacher.rpc('teacher_students')).data.find((s) => s.username === 'demo.ali');
log(Number(listed.balance) === summary.balance, `teacher sees Ali's balance (${listed.balance}) and ${listed.races} races`);

await teacher.table(`question_sets?id=eq.${hiddenId}`, 'DELETE');
