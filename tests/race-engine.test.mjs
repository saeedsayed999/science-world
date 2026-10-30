// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaceEngine } from '../js/race-engine.js';
import { SAMPLE_SET } from '../js/questions.js';

const Q = SAMPLE_SET.questions;
const people = [
  { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'me', name: 'Me' },
];
const race = (mode = 'friends') => new RaceEngine({ participants: people, questions: Q, mode, playerId: 'me' });
const right = (e, id) => { const q = e.currentQuestion(id); return e.answer(id, q.id, q.answer); };
const wrong = (e, id) => { const q = e.currentQuestion(id); return e.answer(id, q.id, (q.answer + 1) % 4); };

test('player starts last; correct answer overtakes one place', () => {
  const e = race();
  assert.equal(e.position('me'), 4);
  const r = right(e, 'me');
  assert.equal(r.status, 'correct');
  assert.equal(r.passed, 'c');
  assert.equal(e.position('me'), 3);
  assert.equal(e.position('c'), 4);
});

test('AC11: two wrong answers fall back twice and keep the same question', () => {
  const e = race();
  right(e, 'me'); right(e, 'me'); // now 2nd
  const q = e.currentQuestion('me');
  assert.equal(wrong(e, 'me').status, 'wrong');
  assert.equal(e.position('me'), 3);
  assert.equal(wrong(e, 'me').status, 'wrong');
  assert.equal(e.position('me'), 4);
  assert.equal(e.currentQuestion('me').id, q.id);
});

test('wrong answer in last place holds position (provisional boundary)', () => {
  const e = race();
  assert.equal(wrong(e, 'me').passedBy, null);
  assert.equal(e.position('me'), 4);
});

test('AC09: players progress independently', () => {
  const e = race();
  for (let i = 0; i < 4; i++) right(e, 'a');
  right(e, 'me');
  assert.equal(e.currentQuestion('a').id, 'q5');
  assert.equal(e.currentQuestion('me').id, 'q2');
  assert.equal(e.currentQuestion('b').id, 'q1');
});

test('AC13/AC14: first to 10 correct ends the race for everyone, even after wrong answers', () => {
  const e = race();
  wrong(e, 'me'); wrong(e, 'me');
  right(e, 'b');
  for (let i = 0; i < 9; i++) right(e, 'me');
  const last = right(e, 'me');
  assert.equal(last.finished, true);
  assert.equal(e.winnerId, 'me');
  assert.equal(e.answer('b', 'q2', 0).status, 'rejected');
  assert.equal(e.currentQuestion('b'), null);
});

test('AC16: duplicate request is applied once', () => {
  const e = race();
  const q = e.currentQuestion('me');
  e.answer('me', q.id, q.answer, 'req-1');
  const dup = e.answer('me', q.id, q.answer, 'req-1');
  assert.equal(dup.duplicate, true);
  assert.equal(e.players.get('me').correct.size, 1);
  assert.equal(e.position('me'), 3);
});

test('stale answer for an earlier question is rejected', () => {
  const e = race();
  right(e, 'me');
  assert.equal(e.answer('me', 'q1', Q[0].answer).status, 'rejected');
});

test('AC17: multiplayer winner with 10 new attempts earns 2,700', () => {
  const e = race('friends');
  for (let i = 0; i < 10; i++) right(e, 'me');
  assert.equal(e.rewards('me').total, 2700);
});

test('solo winner gets no winner bonus (bots)', () => {
  const e = race('solo');
  for (let i = 0; i < 10; i++) right(e, 'me');
  const r = e.rewards('me');
  assert.equal(r.winner.amount, 0);
  assert.equal(r.total, 2500);
});

test('AC18/AC20: nonwinner keeps 500 participation; unfinished questions stay unfinished', () => {
  const e = race('friends');
  for (let i = 0; i < 5; i++) right(e, 'me');
  wrong(e, 'me'); // attempted 6th question
  for (let i = 0; i < 10; i++) right(e, 'a');
  const r = e.rewards('me');
  assert.equal(r.firstAttempts.count, 6);
  assert.equal(r.correct.count, 5);
  assert.equal(r.participation.amount, 500);
  assert.equal(r.total, 600 + 500 + 500);
  assert.equal(e.players.get('me').correct.size, 5);
});

test('AC19: repeated wrong attempts do not mint more first-attempt rewards', () => {
  const e = race('friends');
  for (let i = 0; i < 5; i++) wrong(e, 'me');
  right(e, 'me');
  for (let i = 0; i < 10; i++) right(e, 'a');
  assert.equal(e.rewards('me').firstAttempts.amount, 100);
});

test('player who left before the finish gets no participation bonus', () => {
  const e = race('friends');
  e.markLeft('b');
  for (let i = 0; i < 10; i++) right(e, 'a');
  assert.equal(e.rewards('b').participation.amount, 0);
});

test('results list correct counts with shared ranks for ties', () => {
  const e = race('friends');
  right(e, 'b'); right(e, 'c');
  for (let i = 0; i < 10; i++) right(e, 'a');
  const rows = e.results();
  assert.equal(rows[0].id, 'a');
  assert.equal(rows[0].correct, 10);
  const b = rows.find((r) => r.id === 'b'), c = rows.find((r) => r.id === 'c');
  assert.equal(b.rank, c.rank);
});
