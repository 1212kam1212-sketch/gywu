// db.js — IndexedDB data layer. Replaces the old SQLite backend; this is
// the entire "database" now, running client-side in the browser.
//
// Stores (roughly mirroring the old SQLite tables):
//   exercises   { id, name (unique), muscle_group }
//   sessions    { id, date (unique, YYYY-MM-DD), notes }
//   sets        { id, session_id, exercise_id, date, weight, reps, rir, set_order, created_at }
//   bodyWeight  { id, date, weight }
//
// `date` is denormalized onto each set from its parent session at insert
// time (SQLite could join sessions->sets to filter by date; IndexedDB
// cursors can't cheaply do that join at scale, so a `by_date` /
// `by_exercise_date` index on sets keeps history/volume queries fast
// against a full year of data without loading everything into memory).

import { estimate1RM, roundE1RM, detectPR } from './lib.js';

const DB_NAME = 'gywu';
const DB_VERSION = 1;

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

let dbPromise = null;

function req2promise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx2promise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('exercises')) {
        const store = db.createObjectStore('exercises', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_name', 'name', { unique: true });
      }

      if (!db.objectStoreNames.contains('sessions')) {
        const store = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_date', 'date', { unique: true });
      }

      if (!db.objectStoreNames.contains('sets')) {
        const store = db.createObjectStore('sets', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_session', 'session_id');
        store.createIndex('by_exercise', 'exercise_id');
        store.createIndex('by_date', 'date');
        store.createIndex('by_exercise_date', ['exercise_id', 'date']);
      }

      if (!db.objectStoreNames.contains('bodyWeight')) {
        const store = db.createObjectStore('bodyWeight', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_date', 'date');
      }
    };

    req.onsuccess = async () => {
      const db = req.result;
      await seedExercisesIfEmpty(db);
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function seedExercisesIfEmpty(db) {
  const tx = db.transaction('exercises', 'readwrite');
  const store = tx.objectStore('exercises');
  const count = await req2promise(store.count());
  if (count === 0) {
    for (const [name, muscle_group] of STARTER_EXERCISES) {
      store.add({ name, muscle_group });
    }
  }
  await tx2promise(tx);
}

// ---------- exercises ----------

export async function listExercises() {
  const db = await openDB();
  const tx = db.transaction('exercises', 'readonly');
  const all = await req2promise(tx.objectStore('exercises').getAll());
  all.sort((a, b) => (a.muscle_group + a.name).localeCompare(b.muscle_group + b.name));
  return all;
}

// Cached in-memory since the exercise list is small (tens of rows) and
// changes rarely; used to join muscle_group/name into set-level views
// (volume, export) without a DB round trip per set.
let exerciseCache = null;
export async function getExerciseMap() {
  if (exerciseCache) return exerciseCache;
  const all = await listExercises();
  exerciseCache = new Map(all.map((e) => [e.id, e]));
  return exerciseCache;
}
function invalidateExerciseCache() {
  exerciseCache = null;
}

export async function createExercise(name, muscle_group) {
  name = (name || '').trim();
  muscle_group = (muscle_group || '').trim();
  if (!name || !muscle_group) throw new Error('name and muscle_group are required');

  const db = await openDB();
  const tx = db.transaction('exercises', 'readwrite');
  const store = tx.objectStore('exercises');
  const existing = await req2promise(store.index('by_name').get(name));
  if (existing) throw new Error('An exercise with that name already exists');
  const id = await req2promise(store.add({ name, muscle_group }));
  await tx2promise(tx);
  invalidateExerciseCache();
  return { id, name, muscle_group };
}

// ---------- sessions ----------

export async function getOrCreateSessionForDate(dateStr) {
  const db = await openDB();
  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  let session = await req2promise(store.index('by_date').get(dateStr));
  if (!session) {
    const id = await req2promise(store.add({ date: dateStr, notes: '' }));
    session = { id, date: dateStr, notes: '' };
  }
  await tx2promise(tx);
  return session;
}

export async function updateSessionNotes(sessionId, notes) {
  const db = await openDB();
  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  const session = await req2promise(store.get(sessionId));
  if (!session) throw new Error('Session not found');
  session.notes = notes || '';
  await req2promise(store.put(session));
  await tx2promise(tx);
  return session;
}

// List sessions, most recent first, with set/exercise counts.
// Supports pagination via {limit, offset} and optional {startDate, endDate}
// so the History/Sessions views stay fast at a full year of data.
export async function listSessions({ limit = 30, offset = 0, startDate, endDate } = {}) {
  const db = await openDB();
  const tx = db.transaction(['sessions', 'sets'], 'readonly');
  const sessionStore = tx.objectStore('sessions');
  const index = sessionStore.index('by_date');

  let range;
  if (startDate && endDate) range = IDBKeyRange.bound(startDate, endDate);
  else if (startDate) range = IDBKeyRange.lowerBound(startDate);
  else if (endDate) range = IDBKeyRange.upperBound(endDate);

  const sessions = [];
  await new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(range, 'prev'); // newest first
    let skipped = 0;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      if (skipped < offset) {
        skipped++;
        cursor.continue();
        return;
      }
      if (sessions.length < limit) {
        sessions.push(cursor.value);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  const setsStore = tx.objectStore('sets');
  for (const session of sessions) {
    const sets = await req2promise(setsStore.index('by_session').getAll(session.id));
    session.set_count = sets.length;
    session.exercise_count = new Set(sets.map((s) => s.exercise_id)).size;
  }
  return sessions;
}

export async function getSessionDetail(sessionId) {
  const db = await openDB();
  const tx = db.transaction(['sessions', 'sets'], 'readonly');
  const session = await req2promise(tx.objectStore('sessions').get(sessionId));
  if (!session) return null;

  const sets = await req2promise(tx.objectStore('sets').index('by_session').getAll(sessionId));
  const exMap = await getExerciseMap();

  sets.sort((a, b) => {
    const nameA = exMap.get(a.exercise_id)?.name || '';
    const nameB = exMap.get(b.exercise_id)?.name || '';
    return nameA.localeCompare(nameB) || a.set_order - b.set_order;
  });

  const byExercise = new Map();
  for (const s of sets) {
    if (!byExercise.has(s.exercise_id)) {
      const ex = exMap.get(s.exercise_id);
      byExercise.set(s.exercise_id, {
        exercise_id: s.exercise_id,
        exercise_name: ex ? ex.name : 'Unknown',
        muscle_group: ex ? ex.muscle_group : 'Unknown',
        sets: [],
      });
    }
    byExercise.get(s.exercise_id).sets.push({
      id: s.id,
      weight: s.weight,
      reps: s.reps,
      rir: s.rir,
      set_order: s.set_order,
    });
  }

  return { ...session, exercises: Array.from(byExercise.values()) };
}

// ---------- sets ----------

export async function getLastSetsForExercise(exerciseId) {
  const db = await openDB();
  const tx = db.transaction('sets', 'readonly');
  const allForExercise = await req2promise(tx.objectStore('sets').index('by_exercise').getAll(exerciseId));
  if (allForExercise.length === 0) return null;

  const lastDate = allForExercise.reduce((max, s) => (s.date > max ? s.date : max), allForExercise[0].date);
  const sets = allForExercise
    .filter((s) => s.date === lastDate)
    .sort((a, b) => a.set_order - b.set_order)
    .map((s) => ({ id: s.id, weight: s.weight, reps: s.reps, rir: s.rir, set_order: s.set_order }));

  return { date: lastDate, sets };
}

// History for one exercise, optionally bounded to a date range so charts
// never have to load a full year of raw points at once.
export async function getExerciseHistory(exerciseId, { startDate, endDate } = {}) {
  const db = await openDB();
  const tx = db.transaction('sets', 'readonly');
  const index = tx.objectStore('sets').index('by_exercise_date');

  let range;
  if (startDate && endDate) range = IDBKeyRange.bound([exerciseId, startDate], [exerciseId, endDate]);
  else if (startDate) range = IDBKeyRange.bound([exerciseId, startDate], [exerciseId, '9999-99-99']);
  else if (endDate) range = IDBKeyRange.bound([exerciseId, '0000-00-00'], [exerciseId, endDate]);
  else range = IDBKeyRange.bound([exerciseId, '0000-00-00'], [exerciseId, '9999-99-99']);

  const rows = await req2promise(index.getAll(range));
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.set_order - b.set_order);
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    weight: r.weight,
    reps: r.reps,
    rir: r.rir,
    set_order: r.set_order,
    e1rm: roundE1RM(r.weight, r.reps),
  }));
}

export async function addSet(sessionId, exerciseId, weight, reps, rir) {
  exerciseId = Number(exerciseId);
  weight = Number(weight);
  reps = Number(reps);
  rir = rir === '' || rir === undefined || rir === null ? null : Number(rir);

  if (!exerciseId || !Number.isFinite(weight) || weight < 0 || !Number.isInteger(reps) || reps <= 0) {
    throw new Error('exercise_id, weight, and reps (positive integer) are required');
  }

  const db = await openDB();
  const tx = db.transaction(['sessions', 'sets'], 'readwrite');
  const sessionStore = tx.objectStore('sessions');
  const setsStore = tx.objectStore('sets');

  const session = await req2promise(sessionStore.get(sessionId));
  if (!session) throw new Error('Session not found');

  const priorSets = await req2promise(setsStore.index('by_exercise').getAll(exerciseId));
  const { isWeightPR, isE1RMPR } = detectPR(priorSets, { weight, reps });

  const sameExerciseThisSession = priorSets.filter((s) => s.session_id === sessionId);
  const setOrder = sameExerciseThisSession.reduce((m, s) => Math.max(m, s.set_order), 0) + 1;

  const record = {
    session_id: sessionId,
    exercise_id: exerciseId,
    date: session.date,
    weight,
    reps,
    rir,
    set_order: setOrder,
    created_at: new Date().toISOString(),
  };
  const id = await req2promise(setsStore.add(record));
  await tx2promise(tx);

  return { ...record, id, isWeightPR, isE1RMPR };
}

export async function deleteSet(setId) {
  const db = await openDB();
  const tx = db.transaction('sets', 'readwrite');
  const store = tx.objectStore('sets');
  const existing = await req2promise(store.get(setId));
  if (!existing) throw new Error('Set not found');
  await req2promise(store.delete(setId));
  await tx2promise(tx);
}

// ---------- PRs ----------

export async function getPRs() {
  const db = await openDB();
  const tx = db.transaction('sets', 'readonly');
  const allSets = await req2promise(tx.objectStore('sets').getAll());
  const exMap = await getExerciseMap();

  const rows = allSets.map((s) => {
    const ex = exMap.get(s.exercise_id);
    return {
      exercise_id: s.exercise_id,
      exercise_name: ex ? ex.name : 'Unknown',
      muscle_group: ex ? ex.muscle_group : 'Unknown',
      weight: s.weight,
      reps: s.reps,
      date: s.date,
    };
  });

  const { computePRs } = await import('./lib.js');
  return computePRs(rows).sort((a, b) => a.exercise_name.localeCompare(b.exercise_name));
}

// ---------- weekly volume ----------

// Defaults to a bounded window (weeksBack) so a full year of history
// doesn't force a full-table scan every time the Volume tab opens.
export async function getWeeklyVolume({ startDate, endDate } = {}) {
  const db = await openDB();
  const tx = db.transaction('sets', 'readonly');
  const index = tx.objectStore('sets').index('by_date');

  let range;
  if (startDate && endDate) range = IDBKeyRange.bound(startDate, endDate);
  else if (startDate) range = IDBKeyRange.lowerBound(startDate);
  else if (endDate) range = IDBKeyRange.upperBound(endDate);

  const rows = await req2promise(index.getAll(range));
  const exMap = await getExerciseMap();
  const { groupWeeklyVolume } = await import('./lib.js');

  const withGroup = rows.map((r) => ({
    date: r.date,
    muscle_group: exMap.get(r.exercise_id)?.muscle_group || 'Unknown',
  }));
  return groupWeeklyVolume(withGroup);
}

// ---------- body weight ----------

export async function addBodyWeight(dateStr, weight) {
  weight = Number(weight);
  if (!dateStr || !Number.isFinite(weight) || weight <= 0) {
    throw new Error('date and a positive weight are required');
  }
  const db = await openDB();
  const tx = db.transaction('bodyWeight', 'readwrite');
  const store = tx.objectStore('bodyWeight');
  // One entry per day: overwrite if one already exists for this date.
  const existing = await req2promise(store.index('by_date').get(dateStr));
  let id;
  if (existing) {
    id = existing.id;
    await req2promise(store.put({ id, date: dateStr, weight }));
  } else {
    id = await req2promise(store.add({ date: dateStr, weight }));
  }
  await tx2promise(tx);
  return { id, date: dateStr, weight };
}

export async function listBodyWeight({ startDate, endDate } = {}) {
  const db = await openDB();
  const tx = db.transaction('bodyWeight', 'readonly');
  const index = tx.objectStore('bodyWeight').index('by_date');

  let range;
  if (startDate && endDate) range = IDBKeyRange.bound(startDate, endDate);
  else if (startDate) range = IDBKeyRange.lowerBound(startDate);
  else if (endDate) range = IDBKeyRange.upperBound(endDate);

  const rows = await req2promise(index.getAll(range));
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

export async function deleteBodyWeight(id) {
  const db = await openDB();
  const tx = db.transaction('bodyWeight', 'readwrite');
  await req2promise(tx.objectStore('bodyWeight').delete(id));
  await tx2promise(tx);
}

// ---------- export helpers ----------

// Flat one-row-per-set list for CSV export, optionally bounded by date range.
export async function getAllSetsFlat({ startDate, endDate } = {}) {
  const db = await openDB();
  const tx = db.transaction('sets', 'readonly');
  const index = tx.objectStore('sets').index('by_date');

  let range;
  if (startDate && endDate) range = IDBKeyRange.bound(startDate, endDate);
  else if (startDate) range = IDBKeyRange.lowerBound(startDate);
  else if (endDate) range = IDBKeyRange.upperBound(endDate);

  const rows = await req2promise(index.getAll(range));
  const exMap = await getExerciseMap();
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.set_order - b.set_order);

  return rows.map((r) => {
    const ex = exMap.get(r.exercise_id);
    return {
      date: r.date,
      exercise: ex ? ex.name : 'Unknown',
      muscle_group: ex ? ex.muscle_group : 'Unknown',
      weight: r.weight,
      reps: r.reps,
      rir: r.rir,
    };
  });
}

// Full session objects for JSON "copy data" export, optionally bounded by date range.
export async function getSessionsForExport({ startDate, endDate } = {}) {
  const db = await openDB();
  const tx = db.transaction('sessions', 'readonly');
  const index = tx.objectStore('sessions').index('by_date');

  let range;
  if (startDate && endDate) range = IDBKeyRange.bound(startDate, endDate);
  else if (startDate) range = IDBKeyRange.lowerBound(startDate);
  else if (endDate) range = IDBKeyRange.upperBound(endDate);

  const sessions = await req2promise(index.getAll(range));
  sessions.sort((a, b) => a.date.localeCompare(b.date));

  const details = [];
  for (const s of sessions) {
    const detail = await getSessionDetail(s.id);
    details.push(detail);
  }
  return details;
}
