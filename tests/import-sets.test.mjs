import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuestionFile, parseCsv } from '../js/import-sets.js';

const sample = readFileSync(new URL('../samples/plant-season-set.csv', import.meta.url), 'utf8');

test('sample CSV imports as 10 questions with letter answers converted', () => {
  const { questions, errors } = parseQuestionFile(sample);
  assert.deepEqual(errors, []);
  assert.equal(questions.length, 10);
  assert.equal(questions[0].answer, 1);
  assert.equal(questions[9].id, 'q10');
});

test('quoted CSV fields keep commas and quotes', () => {
  assert.deepEqual(parseCsv('"a, b","say ""hi""",c\n'), [['a, b', 'say "hi"', 'c']]);
});

test('wrong row count and bad answers are reported, nothing is returned', () => {
  const bad = 'question,a,b,c,d,answer\nQ1,a,b,c,d,E\nQ2,a,a,c,d,A\n';
  const { questions, errors } = parseQuestionFile(bad);
  assert.equal(questions.length, 0);
  assert.ok(errors.some((e) => e.includes('exactly 10')));
  assert.ok(errors.some((e) => e.includes('Question 1: the answer')));
  assert.ok(errors.some((e) => e.includes('Question 2: two options')));
});

test('JSON with letter answers is accepted', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ text: `Q${i}`, options: ['w', 'x', 'y', 'z'], answer: 'C' }));
  const { questions, errors } = parseQuestionFile(JSON.stringify(list), 'set.json');
  assert.deepEqual(errors, []);
  assert.equal(questions[3].answer, 2);
});
