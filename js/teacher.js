// Teacher room: approve students, import/preview/release question sets.
// All permissions are enforced by the database; this page only calls it.

import { api } from './supabase.js';
import { parseQuestionFile } from './import-sets.js';
import { RoomSync } from './room-sync.js';
import { RaceEngine } from './race-engine.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n).toLocaleString('en-US');
const LETTERS = ['A', 'B', 'C', 'D'];
let draft = null;

function notice(text, isError = false) {
  const n = $('#notice');
  n.textContent = text;
  n.classList.toggle('error', isError);
  n.hidden = !text;
  clearTimeout(notice._t);
  if (text && !isError) notice._t = setTimeout(() => { n.hidden = true; }, 4000);
}

function showTab(name) {
  for (const s of ['login', 'students', 'sets', 'live']) $('#' + s).hidden = s !== name;
  for (const b of document.querySelectorAll('[data-tab]')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  $('.tabs').hidden = name === 'login';
  $('.me').hidden = name === 'login';
  if (name === 'students') loadStudents();
  if (name === 'sets') loadSets();
  if (name === 'live') loadLive();
}

async function route() {
  const session = await api.session();
  if (!session) return showTab('login');
  const me = await api.profile();
  if (!me || me.role !== 'teacher' || me.status !== 'approved') {
    notice('This page is for teacher accounts. Students race on the game page.', true);
    await api.logOut();
    return showTab('login');
  }
  $('#me-name').textContent = `${me.first_name} ${me.last_name}`.trim() || me.username;
  showTab('students');
}

// ---------- students ----------

const STATUS_LABEL = { pending: 'Waiting for approval', approved: 'Approved', revoked: 'Access ended' };

async function loadStudents() {
  let rows;
  try { rows = await api.students(); } catch (e) { return notice(e.message, true); }
  const pending = rows.filter((r) => r.status === 'pending').length;
  $('#pending-count').textContent = pending;
  $('#pending-count').hidden = pending === 0;
  $('#no-students').hidden = rows.length > 0;
  $('#student-rows').replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="name"></td><td class="mono"></td><td><span class="pill"></span></td>
      <td class="num"></td><td class="num"></td><td class="when"></td><td class="actions"></td>`;
    tr.children[0].textContent = `${r.first_name} ${r.last_name}`.trim();
    tr.children[1].textContent = r.username;
    const pill = tr.querySelector('.pill');
    pill.textContent = STATUS_LABEL[r.status];
    pill.dataset.status = r.status;
    tr.children[3].textContent = fmt(r.balance);
    tr.children[4].textContent = r.races;
    tr.children[5].textContent = r.last_race ? new Date(r.last_race).toLocaleString() : '—';
    const act = tr.querySelector('.actions');
    const add = (label, status, cls) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await api.setStatus(r.id, status); notice(`${r.first_name}: ${STATUS_LABEL[status]}`); } catch (e) { notice(e.message, true); }
        loadStudents();
      });
      act.append(b);
    };
    if (r.status === 'pending') add('Approve', 'approved', 'primary small');
    if (r.status === 'approved') add('End access', 'revoked', 'ghost small');
    if (r.status === 'revoked') add('Restore', 'approved', 'ghost small');
    return tr;
  }));
}

// ---------- question sets ----------

async function loadSets() {
  let sets;
  try { sets = await api.sets(); } catch (e) { return notice(e.message, true); }
  $('#no-sets').hidden = sets.length > 0;
  $('#set-list').replaceChildren(...sets.map(renderSet));
}

function renderSet(set) {
  const el = document.createElement('article');
  el.className = 'card set';
  el.innerHTML = `<div class="set-head">
      <div><h3></h3><div class="muted meta"></div></div>
      <span class="pill"></span>
      <div class="set-actions"></div>
    </div>
    <details><summary>Preview questions</summary><ol class="qlist"></ol></details>`;
  el.querySelector('h3').textContent = set.title;
  el.querySelector('.meta').textContent = [set.season, `${set.mode} bank`, `added ${new Date(set.created_at).toLocaleDateString()}`].filter(Boolean).join(' · ');
  const pill = el.querySelector('.pill');
  pill.textContent = set.released ? 'Released' : 'Hidden draft';
  pill.dataset.status = set.released ? 'approved' : 'pending';
  el.querySelector('.qlist').replaceChildren(...set.questions.map(renderQuestion));
  const actions = el.querySelector('.set-actions');
  const btn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.className = cls;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); } catch (e) { notice(e.message, true); }
      loadSets();
    });
    actions.append(b);
    return b;
  };
  if (set.released) {
    btn('Hide', 'ghost small', async () => { await api.updateSet(set.id, { released: false }); notice(`“${set.title}” is hidden from students.`); });
  } else {
    btn('Release to students', 'primary small', async () => {
      await api.updateSet(set.id, { released: true, released_at: new Date().toISOString() });
      notice(`“${set.title}” is now available to approved students.`);
    });
    // Two-step delete instead of confirm(), which some embedded browsers block.
    const del = document.createElement('button');
    del.textContent = 'Delete draft';
    del.className = 'ghost small danger';
    del.addEventListener('click', async () => {
      if (!del.dataset.armed) {
        del.dataset.armed = '1';
        del.textContent = 'Click again to delete';
        setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete draft'; }, 3000);
        return;
      }
      del.disabled = true;
      try { await api.deleteSet(set.id); notice(`Deleted “${set.title}”.`); } catch (e) { notice(e.message, true); }
      loadSets();
    });
    actions.append(del);
  }
  return el;
}

function renderQuestion(q) {
  const li = document.createElement('li');
  li.innerHTML = '<div class="qtext"></div><ul class="qopts"></ul>';
  li.querySelector('.qtext').textContent = q.text;
  li.querySelector('.qopts').replaceChildren(...q.options.map((o, i) => {
    const x = document.createElement('li');
    x.textContent = `${LETTERS[i]}. ${o}`;
    if (i === q.answer) x.className = 'correct';
    return x;
  }));
  return li;
}

function previewImport(text, filename = '') {
  const { questions, errors } = parseQuestionFile(text, filename);
  $('#import-errors').hidden = errors.length === 0;
  $('#import-errors').replaceChildren(...errors.map((e) => Object.assign(document.createElement('div'), { textContent: e })));
  draft = errors.length ? null : questions;
  $('#import-preview').hidden = !draft;
  if (draft) $('#preview-list').replaceChildren(...draft.map(renderQuestion));
}

$('#set-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const text = await f.text();
  $('#set-text').value = f.name.endsWith('.json') ? '' : text;
  if (!$('#set-title').value) $('#set-title').value = f.name.replace(/\.(csv|json)$/i, '').replace(/[-_]+/g, ' ');
  previewImport(text, f.name);
});
$('#set-text').addEventListener('input', () => previewImport($('#set-text').value));
$('#load-sample').addEventListener('click', async () => {
  const text = await (await fetch('samples/plant-season-set.csv')).text();
  $('#set-text').value = text;
  $('#set-title').value ||= 'Forest Valley Circuit';
  $('#set-season').value ||= 'Plant Season';
  previewImport(text);
});
$('#save-set').addEventListener('click', async () => {
  const title = $('#set-title').value.trim();
  if (!title) return notice('Give the set a title first.', true);
  if (!draft) return;
  $('#save-set').disabled = true;
  try {
    await api.createSet({ title, season: $('#set-season').value.trim(), mode: $('#set-mode').value, questions: draft, released: false });
    notice(`Saved “${title}” as a hidden draft. Release it when you are ready.`);
    draft = null;
    for (const id of ['#set-title', '#set-season', '#set-text', '#set-file']) $(id).value = '';
    $('#import-preview').hidden = true;
    loadSets();
  } catch (e) { notice(e.message, true); }
  $('#save-set').disabled = false;
});

// ---------- live races ----------

let hosting = null; // { sync, engine, applied }

async function loadLive() {
  let list = [];
  try { list = (await api.sets()).filter((x) => x.mode === 'teacher'); } catch (e) { notice(e.message, true); }
  $('#host-set').replaceChildren(...list.map((x) => new Option([x.season, x.title].filter(Boolean).join(' · '), x.id)));
  $('#host-empty').hidden = list.length > 0;
  $('#host-form button').disabled = list.length === 0;
  if (!hosting) {
    const active = await api.myActiveRoom().catch(() => null);
    if (active) watchRoom(active);
  }
}

function watchRoom(roomId) {
  hosting?.sync.stop();
  hosting = { engine: null, applied: 0 };
  hosting.sync = new RoomSync(roomId, renderRoom);
  hosting.sync.refresh();
  $('#host-form').hidden = true;
  $('#host-room').hidden = false;
}

function stopHosting() {
  hosting?.sync.stop();
  hosting = null;
  $('#host-form').hidden = false;
  $('#host-room').hidden = true;
}

const ROOM_STATUS = { lobby: 'Lobby open', racing: 'Racing now', finished: 'Finished', cancelled: 'Closed' };

function renderRoom(st, fresh) {
  if (!hosting) return;
  if (st.status === 'cancelled') { stopHosting(); return; }
  $('#room-status').textContent = ROOM_STATUS[st.status];
  $('#room-title').textContent = [st.season, st.title].filter(Boolean).join(' · ');
  $('#room-code').textContent = st.code;

  // Replay answers with the same engine students use, so positions match their screens.
  if (st.status !== 'lobby' && !hosting.engine) {
    hosting.engine = new RaceEngine({
      participants: st.players.map((p) => ({ id: p.id, name: p.name })),
      questions: Array.from({ length: 10 }, (_, i) => ({ id: `q${i + 1}` })),
      mode: 'teacher',
    });
  }
  if (hosting.engine) for (const ev of fresh) hosting.engine.record(ev.student_id, ev.question_id, ev.correct, `ev${ev.id}`);
  const order = hosting.engine ? hosting.engine.order : st.players.map((p) => p.id);
  const byId = Object.fromEntries(st.players.map((p) => [p.id, p]));
  $('#room-rows').replaceChildren(...order.map((id, i) => {
    const p = byId[id];
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="num"></td><td class="name"></td><td class="num"></td><td></td>';
    tr.children[0].textContent = st.status === 'lobby' ? '' : i + 1;
    tr.children[1].textContent = p.name;
    tr.children[2].textContent = st.status === 'lobby' ? '' : `${p.correct} / 10`;
    tr.children[3].textContent = st.winner_id === id ? 'Winner' : p.left ? 'Left the race' : st.status === 'lobby' ? 'Joined' : 'Racing';
    return tr;
  }));
  if (!st.players.length) $('#room-rows').innerHTML = '<tr><td colspan="4" class="muted">No students yet. Show them the code.</td></tr>';
  $('#room-start').hidden = st.status !== 'lobby';
  $('#room-start').disabled = st.players.length < 1;
  $('#room-cancel').hidden = st.status !== 'lobby';
  $('#room-done').hidden = st.status !== 'finished';
  $('#room-hint').textContent = st.status === 'lobby' ? 'Students choose Play with Teacher and type the code. Start when everyone has joined.'
    : st.status === 'racing' ? 'Each student answers at their own pace. The first to 10 correct ends the race for everyone.'
    : `Winner: ${byId[st.winner_id]?.name ?? '—'}. Rewards were added to each student's account.`;
}

$('#host-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { const r = await api.createRoom($('#host-set').value); watchRoom(r.room_id); } catch (err) { notice(err.message, true); }
});
$('#room-start').addEventListener('click', async () => {
  try { await api.startRoom(hosting.sync.roomId); hosting.sync.refresh(); } catch (err) { notice(err.message, true); }
});
$('#room-cancel').addEventListener('click', async () => {
  try { await api.cancelRoom(hosting.sync.roomId); } catch (err) { notice(err.message, true); }
  stopHosting();
});
$('#room-done').addEventListener('click', stopHosting);

// ---------- shell ----------

for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
$('#reload-students').addEventListener('click', loadStudents);
$('#sign-out').addEventListener('click', async () => { await api.logOut(); showTab('login'); });
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api.logIn($('#li-user').value, $('#li-pass').value); notice(''); await route(); } catch (err) { notice(err.message, true); }
});

route().catch((e) => notice(e.message, true));
