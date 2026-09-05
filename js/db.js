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

// Rename an exercise and/or move it to a different muscle group. Rejects a
// name already used by a *different* exercise (the by_name index is unique)
// - merge into that one instead.
export async function renameExercise(id, newName, newGroup) {
  id = Number(id);
  newName = (newName || '').trim();
  newGroup = (newGroup || '').trim();
  if (!id) throw new Error('Exercise id is required');
  if (!newName) throw new Error('A new name is required');

  const db = await openDB();
  const tx = db.transaction('exercises', 'readwrite');
  const store = tx.objectStore('exercises');
  const row = await req2promise(store.get(id));
  if (!row) throw new Error('Exercise not found');
  const clash = await req2promise(store.index('by_name').get(newName));
  if (clash && clash.id !== id) {
    throw new Error('Another exercise already has that name - merge into it instead');
  }
  row.name = newName;
  if (newGroup) row.muscle_group = newGroup;
  await req2promise(store.put(row));
  await tx2promise(tx);
  invalidateExerciseCache();
  return { id, name: row.name, muscle_group: row.muscle_group };
}

export async function countSetsForExercise(id) {
  const db = await openDB();
  const tx = db.transaction('sets', 'readonly');
  return req2promise(tx.objectStore('sets').index('by_exercise').count(Number(id)));
}

// Merge sourceId into targetId: every set logged under sourceId is
// reassigned to targetId, set_order is re-sequenced per affected session so
// the target's sets stay 1..n, and the now-empty source exercise row is
// deleted. Sets themselves are never deleted. Not reversible from the app -
// re-importing a backup is the way back.
export async function mergeExercises(sourceId, targetId) {
  sourceId = Number(sourceId);
  targetId = Number(targetId);
  if (!sourceId || !targetId) throw new Error('Two exercises are required');
  if (sourceId === targetId) throw new Error('Pick two different exercises');

  const db = await openDB();

  {
    const tx = db.transaction('exercises', 'readonly');
    const store = tx.objectStore('exercises');
    const [src, tgt] = await Promise.all([
      req2promise(store.get(sourceId)),
      req2promise(store.get(targetId)),
    ]);
    if (!src) throw new Error('Source exercise not found');
    if (!tgt) throw new Error('Target exercise not found');
  }

  // Reassign every source set to the target, collecting affected sessions.
  const affectedSessions = new Set();
  let movedCount = 0;
  {
    const tx = db.transaction('sets', 'readwrite');
    const store = tx.objectStore('sets');
    const srcSets = await req2promise(store.index('by_exercise').getAll(sourceId));
    for (const s of srcSets) {
      s.exercise_id = targetId;
      store.put(s);
      affectedSessions.add(s.session_id);
      movedCount++;
    }
    await tx2promise(tx);
  }

  // Re-sequence set_order for the target within each affected session so two
  // merged-together entries don't share an order number.
  for (const sessionId of affectedSessions) {
    const tx = db.transaction('sets', 'readwrite');
    const store = tx.objectStore('sets');
    const all = await req2promise(store.index('by_session').getAll(sessionId));
    const targetSets = all
      .filter((s) => s.exercise_id === targetId)
      .sort(
        (a, b) =>
          (a.created_at || '').localeCompare(b.created_at || '') || a.set_order - b.set_order
      );
    targetSets.forEach((s, i) => {
      if (s.set_order !== i + 1) {
        s.set_order = i + 1;
        store.put(s);
      }
    });
    await tx2promise(tx);
  }

  {
    const tx = db.transaction('exercises', 'readwrite');
    await req2promise(tx.objectStore('exercises').delete(sourceId));
    await tx2promise(tx);
  }
  invalidateExerciseCache();
  return { movedCount, sessionsAffected: affectedSessions.size };
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

// Sets from the most recent day this exercise was trained. Pass
// { excludeDate } (normally today) so the Log screen's "Last time" card
// always shows the PREVIOUS session to compare against, not the one being
// logged right now - otherwise, as soon as the first set of the day goes
// in, "last time" would flip to today's own numbers.
export async function getLastSetsForExercise(exerciseId, { excludeDate } = {}) {
  const db = await openDB();
  const tx = db.transaction('sets', 'readonly');
  const allForExercise = await req2promise(tx.objectStore('sets').index('by_exercise').getAll(exerciseId));
  const candidates = excludeDate ? allForExercise.filter((s) => s.date !== excludeDate) : allForExercise;
  if (candidates.length === 0) return null;

  const lastDate = candidates.reduce((max, s) => (s.date > max ? s.date : max), candidates[0].date);
  const sets = candidates
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

// All-time PR progression per exercise: every set that set a new heaviest
// weight and/or a new best estimated 1RM, in order. Always all-time (a
// record is a record regardless of any date filter).
export async function getPRHistory() {
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
      rir: s.rir,
      date: s.date,
      set_order: s.set_order,
    };
  });

  const { computePRHistory } = await import('./lib.js');
  return computePRHistory(rows);
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

// ---------- import ----------

// Merge a parsed { sessions, bodyWeight } payload (see lib.parseImportJSON)
// into storage. Strictly additive and idempotent:
//   - sessions are matched by date, created if absent
//   - exercises are matched by name (case-insensitive), created if absent
//   - a set is added only if an identical set (same weight/reps/rir) for the
//     same exercise on the same date isn't already stored; extra duplicates
//     present in the file beyond what's stored are still added
//   - session notes are only filled in when the stored session has none - an
//     existing non-empty note is never overwritten
//   - a body-weight entry is added only for a date that has none yet
// Nothing is ever updated-in-place or deleted, so re-importing the same file
// is a no-op and a half-finished import can just be run again.
export async function importData({ sessions = [], bodyWeight = [] } = {}) {
  const db = await openDB();
  const report = {
    sessionsCreated: 0, sessionsMatched: 0,
    exercisesCreated: 0,
    setsAdded: 0, setsSkipped: 0,
    notesFilled: 0, notesSkipped: 0,
    bodyWeightAdded: 0, bodyWeightSkipped: 0,
  };

  // lowercased name -> exercise id, primed once and kept current as we create.
  const nameToId = new Map();
  for (const ex of await listExercises()) nameToId.set(ex.name.toLowerCase(), ex.id);

  const sig = (w, r, rir) => `${w}|${r}|${rir === null || rir === undefined ? '' : rir}`;

  for (const impSession of sessions) {
    const date = impSession.date;

    // --- session row + notes ---
    let sessionId;
    {
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      let session = await req2promise(store.index('by_date').get(date));
      if (!session) {
        sessionId = await req2promise(store.add({ date, notes: impSession.notes || '' }));
        report.sessionsCreated++;
        if (impSession.notes) report.notesFilled++;
      } else {
        sessionId = session.id;
        report.sessionsMatched++;
        if (impSession.notes) {
          if (!session.notes) {
            session.notes = impSession.notes;
            await req2promise(store.put(session));
            report.notesFilled++;
          } else if (session.notes.trim() !== impSession.notes.trim()) {
            report.notesSkipped++;
          }
        }
      }
      await tx2promise(tx);
    }

    // --- sets, one exercise at a time ---
    for (const impEx of impSession.exercises) {
      let exId = nameToId.get(impEx.name.toLowerCase());
      if (!exId) {
        const created = await createExercise(impEx.name, impEx.muscle_group || 'Other');
        exId = created.id;
        nameToId.set(impEx.name.toLowerCase(), exId);
        report.exercisesCreated++;
      }

      const tx = db.transaction('sets', 'readwrite');
      const store = tx.objectStore('sets');
      const existing = await req2promise(
        store.index('by_exercise_date').getAll(IDBKeyRange.bound([exId, date], [exId, date]))
      );

      const counts = new Map();
      let maxOrder = 0;
      for (const s of existing) {
        const k = sig(s.weight, s.reps, s.rir);
        counts.set(k, (counts.get(k) || 0) + 1);
        if (s.set_order > maxOrder) maxOrder = s.set_order;
      }

      for (const st of impEx.sets) {
        const k = sig(st.weight, st.reps, st.rir);
        const have = counts.get(k) || 0;
        if (have > 0) {
          counts.set(k, have - 1);
          report.setsSkipped++;
          continue;
        }
        maxOrder++;
        store.add({
          session_id: sessionId,
          exercise_id: exId,
          date,
          weight: st.weight,
          reps: st.reps,
          rir: st.rir ?? null,
          set_order: maxOrder,
          created_at: new Date().toISOString(),
        });
        report.setsAdded++;
      }
      await tx2promise(tx);
    }
  }

  // --- body weight ---
  for (const bw of bodyWeight) {
    const tx = db.transaction('bodyWeight', 'readwrite');
    const store = tx.objectStore('bodyWeight');
    const existing = await req2promise(store.index('by_date').get(bw.date));
    if (existing) {
      report.bodyWeightSkipped++;
    } else {
      store.add({ date: bw.date, weight: bw.weight });
      report.bodyWeightAdded++;
    }
    await tx2promise(tx);
  }

  return report;
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
