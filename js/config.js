// Race rules and tunable settings. Every value marked PROVISIONAL is an
// open decision in the handoff (Section 17) and must be confirmed before
// real pupils earn rewards with it.

export const RACE = {
  questionsPerRace: 10,          // Confirmed (R01)
  freeDriveSeconds: 15,          // Confirmed (R03)
  questionTimerSeconds: null,    // PROVISIONAL (R05/O06): untimed answering
  playerStartsLast: true,        // PROVISIONAL (O02): starting grid slot
  uniquePositions: true,         // PROVISIONAL (O02/AC15): ties not displayed yet
};

export const REWARDS = {
  firstAttempt: 100,             // Starting value (E01)
  firstCorrect: 100,             // Starting value (E01)
  participation: 500,            // Starting value (E01)
  winner: 200,                   // Starting value (E01)
  winnerBonusModes: ['friends', 'teacher'], // Confirmed: not automatic for solo bots
};

// Simulated rivals for Solo mode. They are always labeled as bots (Section 04).
export const BOTS = {
  names: ['Leo', 'Kai', 'Omar', 'Ben', 'Noah'],
  colors: ['#f2c230', '#e0322f', '#8b46e6', '#2fbf4f', '#f07a1a'],
  thinkSeconds: [3, 14],         // PROVISIONAL demo tuning
  accuracy: [0.5, 0.85],          // PROVISIONAL demo tuning
};

export const PLAYER_COLOR = '#18c6e8';

export const QUALITY = {
  low:    { pixelRatio: 0.75, shadows: false, antialias: false, scenery: 0.35, fogFar: 380 },
  medium: { pixelRatio: 1.25, shadows: false, antialias: true,  scenery: 0.7,  fogFar: 600 },
  high:   { pixelRatio: 2.0,  shadows: true,  antialias: true,  scenery: 1.0,  fogFar: 900 },
};
