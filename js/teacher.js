// Teacher room: approve students, import/preview/release question sets.
// All permissions are enforced by the database; this page only calls it.

import { api } from './supabase.js';
import { parseQuestionFile } from './import-sets.js';

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
  for (const s of ['login', 'students', 'sets']) $('#' + s).hidden = s !== name;
  for (const b of document.querySelectorAll('[data-tab]')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  $('.tabs').hidden = name === 'login';
  $('.me').hidden = name === 'login';
  if (name === 'students') loadStudents();
  if (name === 'sets') loadSets();
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

// ---------- shell ----------

for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
$('#reload-students').addEventListener('click', loadStudents);
$('#sign-out').addEventListener('click', async () => { await api.logOut(); showTab('login'); });
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api.logIn($('#li-user').value, $('#li-pass').value); notice(''); await route(); } catch (err) { notice(err.message, true); }
});

route().catch((e) => notice(e.message, true));
