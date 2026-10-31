// Car motion for the distance race. Pure logic (no Three.js) so it can be
// tested and run identically for the player, Solo bots and remote players.
//
// Answers decide most of the race: correct answers unlock 5-second drives at
// high speed, wrong answers slow the car, three wrong answers in a row crash
// it. Steering matters a little: leaving the road costs speed.
// The winner is still the first racer to 10 correct answers (handoff R01).

export const SIM = {
  roadHalf: 7,           // metres from centre line to road edge
  carHalf: 1.0,
  cruise: 11,            // m/s while answering
  drive: 34,             // m/s during a normal 5 s drive
  turbo: 46,             // m/s during a turbo drive (first-try correct)
  slow: 4,               // m/s right after a wrong answer
  slowSeconds: 2,
  driveSeconds: 5,       // provisional: requested by the owner (replaces the handoff's 15 s)
  crashSeconds: 3,
  crashAfterWrongs: 3,
  offRoadFactor: 0.7,    // speed multiplier with a wheel off the road
  accel: 14,             // m/s² towards the target speed
  brake: 26,
  steerSpeed: 7.5,       // lateral m/s at full lock
  drift: 0.35,           // max random lateral wander, m/s
};

export function newCar({ lane = 0, d = 0 } = {}) {
  return { d, v: 0, lat: lane, latV: 0, mode: 'grid', timer: 0, wrongStreak: 0, driftV: 0, offRoad: false, crashSpin: 0 };
}

export function startRace(car) { car.mode = 'cruise'; }

/** A correct answer: turbo on the first try, a normal drive otherwise. */
export function onCorrect(car, firstTry) {
  car.wrongStreak = 0;
  car.mode = firstTry ? 'turbo' : 'drive';
  car.timer = SIM.driveSeconds;
}

/** A wrong answer: brake hard; the third in a row crashes the car. Returns true on crash. */
export function onWrong(car) {
  car.wrongStreak++;
  if (car.wrongStreak >= SIM.crashAfterWrongs) {
    car.wrongStreak = 0;
    car.mode = 'crash';
    car.timer = SIM.crashSeconds;
    car.crashSpin = 0;
    return true;
  }
  if (car.mode !== 'crash') { car.mode = 'slow'; car.timer = SIM.slowSeconds; }
  return false;
}

export function targetSpeed(car) {
  const base = { grid: 0, cruise: SIM.cruise, drive: SIM.drive, turbo: SIM.turbo, slow: SIM.slow, crash: 0, done: SIM.cruise }[car.mode];
  return car.offRoad ? base * SIM.offRoadFactor : base;
}

/**
 * Advance one step. steer is -1..1 (player input or bot AI); rand is 0..1 for drift.
 * Returns true when a timed mode (drive, turbo, slow, crash) has just ended.
 */
export function step(car, dt, steer = 0, rand = Math.random) {
  let ended = false;
  if (car.timer > 0) {
    car.timer -= dt;
    if (car.timer <= 0) {
      car.timer = 0;
      if (car.mode === 'drive' || car.mode === 'turbo' || car.mode === 'slow' || car.mode === 'crash') {
        car.mode = 'cruise';
        ended = true;
      }
    }
  }
  const target = targetSpeed(car);
  const rate = target > car.v ? SIM.accel : SIM.brake;
  car.v += Math.sign(target - car.v) * Math.min(Math.abs(target - car.v), rate * dt);
  car.d += car.v * dt;

  if (car.mode === 'crash') {
    car.crashSpin += dt * 9 * Math.max(0.2, car.timer / SIM.crashSeconds);
    car.latV *= 0.9;
  } else {
    // A slow random wander means an unattended car drifts: nobody is on autopilot.
    car.driftV += (rand() - 0.5) * 2 * dt;
    car.driftV = Math.max(-SIM.drift, Math.min(SIM.drift, car.driftV));
    const moving = Math.min(1, car.v / 10);
    car.latV = (steer * SIM.steerSpeed + car.driftV) * moving;
  }
  car.lat += car.latV * dt;
  const wall = SIM.roadHalf + 3.2;
  if (Math.abs(car.lat) > wall) { car.lat = Math.sign(car.lat) * wall; car.latV = 0; }
  car.offRoad = Math.abs(car.lat) + SIM.carHalf > SIM.roadHalf + 0.4;
  return ended;
}

/** Simple lane-keeping for bots and for gentle assistance. */
export function botSteer(car, lane) {
  return Math.max(-1, Math.min(1, (lane - car.lat) * 0.4));
}

/** Display order: furthest distance first. */
export function rankByDistance(cars) {
  return [...cars].sort((a, b) => b.car.d - a.car.d).map((x) => x.id);
}
