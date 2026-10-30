// Parses a teacher's question file (CSV or JSON) into the stored set format
// and reports every problem before anything is saved (handoff I03).

import { RACE } from './config.js';

const LETTERS = ['A', 'B', 'C', 'D'];

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/**
 * @returns {{questions: {id:string,text:string,options:string[],answer:number}[], errors: string[]}}
 */
export function parseQuestionFile(text, filename = '') {
  const errors = [];
  let items = [];
  const trimmed = text.trim();
  if (!trimmed) return { questions: [], errors: ['The file is empty.'] };

  if (filename.endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      const list = Array.isArray(data) ? data : data.questions;
      if (!Array.isArray(list)) throw new Error('no list');
      items = list.map((q) => ({
        text: q.text ?? q.question, options: q.options,
        answer: typeof q.answer === 'string' ? LETTERS.indexOf(q.answer.trim().toUpperCase()) : q.answer,
      }));
    } catch {
      return { questions: [], errors: ['This JSON could not be read. Use a list of {"text", "options", "answer"} objects.'] };
    }
  } else {
    const rows = parseCsv(trimmed);
    if (rows.length && /^question$/i.test(rows[0][0]?.trim())) rows.shift();
    items = rows.map((r, i) => {
      if (r.length !== 6) errors.push(`Row ${i + 1}: expected 6 columns (question, 4 options, answer), found ${r.length}.`);
      return { text: r[0], options: r.slice(1, 5), answer: LETTERS.indexOf((r[5] || '').trim().toUpperCase()) };
    });
  }

  if (items.length !== RACE.questionsPerRace) {
    errors.push(`A race needs exactly ${RACE.questionsPerRace} questions; this file has ${items.length}.`);
  }
  const questions = items.map((q, i) => {
    const n = i + 1;
    const text = String(q.text ?? '').trim();
    const options = Array.isArray(q.options) ? q.options.map((o) => String(o ?? '').trim()) : [];
    if (!text) errors.push(`Question ${n}: the question text is empty.`);
    if (options.length !== 4 || options.some((o) => !o)) errors.push(`Question ${n}: needs 4 non-empty options.`);
    if (!(q.answer >= 0 && q.answer <= 3)) errors.push(`Question ${n}: the answer must be A, B, C or D.`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) errors.push(`Question ${n}: two options are the same.`);
    return { id: `q${n}`, text, options, answer: q.answer };
  });
  return { questions: errors.length ? [] : questions, errors };
}
