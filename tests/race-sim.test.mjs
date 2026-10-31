import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM, newCar, startRace, onCorrect, onWrong, step, rankByDistance } from '../js/race-sim.js';

const still = () => 0.5; // no random drift
const run = (car, seconds, steer = 0) => { for (let t = 0; t < seconds; t += 1 / 60) step(car, 1 / 60, steer, still); };

test('first-try correct gives a turbo drive that goes further than a normal drive', () => {
  const a = newCar(), b = newCar();
  startRace(a); startRace(b);
  onCorrect(a, true); onCorrect(b, false);
  run(a, SIM.driveSeconds); run(b, SIM.driveSeconds);
  assert.equal(a.mode, 'cruise');
  assert.ok(a.d > b.d + 20, `turbo ${a.d.toFixed(0)} vs drive ${b.d.toFixed(0)}`);
});

test('the drive lasts exactly the configured seconds', () => {
  const c = newCar(); startRace(c); onCorrect(c, true);
  run(c, SIM.driveSeconds - 0.1);
  assert.equal(c.mode, 'turbo');
  run(c, 0.2);
  assert.equal(c.mode, 'cruise');
});

test('wrong then right does not out-run a racer who was right first time', () => {
  const careful = newCar(), guess = newCar();
  startRace(careful); startRace(guess);
  onCorrect(careful, true);
  onWrong(guess); run(guess, 1); onCorrect(guess, false);
  run(careful, 8); run(guess, 7);
  assert.ok(careful.d > guess.d);
});

test('three wrong answers in a row crash the car and stop it', () => {
  const c = newCar(); startRace(c); run(c, 3);
  assert.equal(onWrong(c), false);
  assert.equal(onWrong(c), false);
  assert.equal(onWrong(c), true);
  assert.equal(c.mode, 'crash');
  run(c, SIM.crashSeconds - 0.5);
  assert.ok(c.v < 1, `speed during crash ${c.v}`);
  run(c, 1);
  assert.equal(c.mode, 'cruise');
});

test('a correct answer resets the wrong streak', () => {
  const c = newCar(); startRace(c);
  onWrong(c); onWrong(c); onCorrect(c, false);
  assert.equal(onWrong(c), false);
});

test('driving off the road costs speed', () => {
  const on = newCar(), off = newCar({ lane: SIM.roadHalf + 1 });
  startRace(on); startRace(off);
  onCorrect(on, true); onCorrect(off, true);
  run(on, 4); run(off, 4, 1);
  assert.ok(off.offRoad);
  assert.ok(on.d > off.d + 15);
});

test('steering moves the car sideways; no steering lets it wander only slowly', () => {
  const c = newCar(); startRace(c); onCorrect(c, true);
  run(c, 1, 1);
  assert.ok(c.lat > 3);
  const w = newCar(); startRace(w);
  let r = 0; const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  for (let t = 0; t < 5; t += 1 / 60) step(w, 1 / 60, 0, rnd);
  assert.ok(Math.abs(w.lat) < 2.5, `wander ${w.lat}`);
});

test('rank follows distance', () => {
  const a = { id: 'a', car: { d: 10 } }, b = { id: 'b', car: { d: 30 } };
  assert.deepEqual(rankByDistance([a, b]), ['b', 'a']);
});
