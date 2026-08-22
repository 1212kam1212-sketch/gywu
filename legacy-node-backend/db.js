// db.js — database setup for the workout tracker.
// Uses Node's built-in SQLite module (node:sqlite), so there is nothing to
// install: just Node.js 22.5+ is required. Data lives in workout.db, a
// single file next to this script, and persists across restarts.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'workout.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    muscle_group TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE, -- YYYY-MM-DD, one session per calendar day
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    weight REAL NOT NULL,
    reps INTEGER NOT NULL,
    rir INTEGER,
    set_order INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sets_exercise ON sets(exercise_id);
  CREATE INDEX IF NOT EXISTS idx_sets_session ON sets(session_id);
`);

// Seed a starter exercise library the first time the app runs.
const STARTER_EXERCISES = [
  ['Bench Press', 'Chest'],
  ['Incline Dumbbell Press', 'Chest'],
  ['Push-Up', 'Chest'],
  ['Barbell Row', 'Back'],
  ['Pull-Up', 'Back'],
  ['Lat Pulldown', 'Back'],
  ['Deadlift', 'Back'],
  ['Squat', 'Legs'],
  ['Leg Press', 'Legs'],
  ['Romanian Deadlift', 'Legs'],
  ['Leg Curl', 'Legs'],
  ['Leg Extension', 'Legs'],
  ['Hip Thrust', 'Legs'],
  ['Overhead Press', 'Shoulders'],
  ['Lateral Raise', 'Shoulders'],
  ['Bicep Curl', 'Arms'],
  ['Tricep Pushdown', 'Arms'],
  ['Plank', 'Core'],
];

const countRow = db.prepare('SELECT COUNT(*) AS c FROM exercises').get();
if (countRow.c === 0) {
  const insert = db.prepare('INSERT INTO exercises (name, muscle_group) VALUES (?, ?)');
  for (const [name, group] of STARTER_EXERCISES) {
    insert.run(name, group);
  }
}

module.exports = db;
