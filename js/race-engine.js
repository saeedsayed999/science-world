// Pure race rules: no rendering, no timers. The same module will run on the
// server in the multiplayer stage, where it becomes the authority that
// accepts answers and declares the finish (R04 proposed implementation).

import { RACE, REWARDS } from './config.js';

export class RaceEngine {
  /**
   * @param {object} opts
   * @param {{id:string,name:string,isBot?:boolean,color?:string}[]} opts.participants
   * @param {{id:string,answer:number}[]} opts.questions
   * @param {'solo'|'friends'|'teacher'} opts.mode
   * @param {string} [opts.playerId] participant placed last on the grid
   */
  constructor({ participants, questions, mode, playerId }) {
    if (questions.length !== RACE.questionsPerRace) {
      throw new Error(`A race needs exactly ${RACE.questionsPerRace} questions`);
    }
    this.mode = mode;
    this.questions = questions;
    this.finished = false;
    this.winnerId = null;
    this.processed = new Map(); // requestId -> result, makes answers idempotent
    this.players = new Map();
    for (const p of participants) {
      this.players.set(p.id, {
        ...p,
        qIndex: 0,
        attempted: new Set(),
        correct: new Set(),
        wrongAttempts: 0,
        firstTryCorrect: 0,
        presentAtEnd: true,
      });
    }
    // Display order: index 0 is 1st place.
    this.order = participants.map((p) => p.id);
    if (playerId && RACE.playerStartsLast) {
      this.order = this.order.filter((id) => id !== playerId).concat(playerId);
    }
  }

  position(id) {
    return this.order.indexOf(id) + 1;
  }

  currentQuestion(id) {
    const p = this.players.get(id);
    return this.finished || p.qIndex >= this.questions.length ? null : this.questions[p.qIndex];
  }

  /**
   * Submit an answer. Duplicate requestIds return the original result and
   * change nothing (AC16). Answers after the finish are ignored (R06).
   */
  answer(id, questionId, choice, requestId) {
    if (requestId && this.processed.has(requestId)) {
      return { ...this.processed.get(requestId), duplicate: true };
    }
    const result = this.#apply(id, questionId, choice);
    if (requestId) this.processed.set(requestId, result);
    return result;
  }

  #apply(id, questionId, choice) {
    const p = this.players.get(id);
    if (!p) return { status: 'rejected', reason: 'unknown-player' };
    if (this.finished) return { status: 'rejected', reason: 'race-finished' };
    const q = this.questions[p.qIndex];
    if (!q || q.id !== questionId) return { status: 'rejected', reason: 'not-current-question' };

    const firstAttempt = !p.attempted.has(q.id);
    p.attempted.add(q.id);

    if (choice === q.answer) {
      p.correct.add(q.id);
      if (firstAttempt) p.firstTryCorrect++;
      p.qIndex++;
      const passed = this.#move(id, -1);
      if (p.correct.size === this.questions.length) {
        this.finished = true;
        this.winnerId = id;
      }
      return { status: 'correct', passed, finished: this.finished, winnerId: this.winnerId };
    }
    p.wrongAttempts++;
    const passedBy = this.#move(id, +1);
    return { status: 'wrong', passedBy, finished: false };
  }

  // Swap with the neighbour ahead (-1) or behind (+1); returns that neighbour's id.
  // At the front/back the car holds its place (boundary rule is PROVISIONAL, O02).
  #move(id, dir) {
    const i = this.order.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= this.order.length) return null;
    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    return this.order[i];
  }

  markLeft(id) {
    if (!this.finished) this.players.get(id).presentAtEnd = false;
  }

  /** Reward breakdown for one participant (E01). Only valid once finished. */
  rewards(id) {
    const p = this.players.get(id);
    const lines = {
      firstAttempts: { count: p.attempted.size, amount: p.attempted.size * REWARDS.firstAttempt },
      correct: { count: p.correct.size, amount: p.correct.size * REWARDS.firstCorrect },
      participation: { amount: this.finished && p.presentAtEnd ? REWARDS.participation : 0 },
      winner: {
        eligible: REWARDS.winnerBonusModes.includes(this.mode),
        amount: this.winnerId === id && REWARDS.winnerBonusModes.includes(this.mode) ? REWARDS.winner : 0,
      },
    };
    const total = Object.values(lines).reduce((s, l) => s + l.amount, 0);
    return { ...lines, total };
  }

  /** Results table: correct answers out of 10, ties share a rank (PROVISIONAL). */
  results() {
    const rows = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, isBot: !!p.isBot, color: p.color,
      correct: p.correct.size, winner: p.id === this.winnerId,
    }));
    rows.sort((a, b) => (b.winner - a.winner) || (b.correct - a.correct));
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      r.rank = prev && !r.winner && !prev.winner && prev.correct === r.correct ? prev.rank : i + 1;
    });
    return rows;
  }
}
