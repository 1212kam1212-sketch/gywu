// lib.js — pure logic functions, no DOM / no IndexedDB dependency.
// Kept separate from app.js and db.js so it can be unit-tested with
// Node's built-in test runner (see tests/lib.test.js).

// Epley formula for estimated one-rep max.
export function estimate1RM(weight, reps) {
  if (reps <= 1) return weight;
  return weight * (1 + reps / 30);
}

export function roundE1RM(weight, reps) {
  return Math.round(estimate1RM(weight, reps) * 10) / 10;
}

// ---------- lifetime weight-moved milestones ----------

// Named thresholds; beyond the last one, milestones continue every 500,000.
export const WEIGHT_MILESTONES = [
  10000, 25000, 50000, 100000, 150000, 200000, 300000, 400000, 500000,
  750000, 1000000, 1500000, 2000000,
];
const MILESTONE_STEP_BEYOND_LAST = 500000;

// The highest milestone already reached at this total (0 if none yet).
export function highestMilestone(total) {
  const top = WEIGHT_MILESTONES[WEIGHT_MILESTONES.length - 1];
  if (total >= top) {
    return top + Math.floor((total - top) / MILESTONE_STEP_BEYOND_LAST) * MILESTONE_STEP_BEYOND_LAST;
  }
  let best = 0;
  for (const m of WEIGHT_MILESTONES) {
    if (total >= m) best = m;
    else break;
  }
  return best;
}

// The next milestone still ahead of this total.
export function nextMilestone(total) {
  for (const m of WEIGHT_MILESTONES) {
    if (total < m) return m;
  }
  const top = WEIGHT_MILESTONES[WEIGHT_MILESTONES.length - 1];
  return top + (Math.floor((total - top) / MILESTONE_STEP_BEYOND_LAST) + 1) * MILESTONE_STEP_BEYOND_LAST;
}

// Monday-based ISO week start for a YYYY-MM-DD date string.
export function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Given prior sets for an exercise (array of {weight, reps}) and a new
// set, determine whether the new set is a weight PR and/or an e1RM PR.
// "Weight PR" = heaviest weight ever lifted for >= this many reps.
export function detectPR(priorSets, newSet) {
  const priorBestWeightAtOrAboveReps = priorSets
    .filter((s) => s.reps >= newSet.reps)
    .reduce((max, s) => Math.max(max, s.weight), -Infinity);
  const priorBestE1RM = priorSets.reduce(
    (max, s) => Math.max(max, estimate1RM(s.weight, s.reps)),
    0
  );

  const newE1RM = estimate1RM(newSet.weight, newSet.reps);
  const isWeightPR =
    priorBestWeightAtOrAboveReps === -Infinity || newSet.weight > priorBestWeightAtOrAboveReps;
  const isE1RMPR = newE1RM > priorBestE1RM;

  return { isWeightPR, isE1RMPR };
}

// Group a flat list of { date, muscle_group } rows (one per set) into
// weekly volume: [{ week_start, muscle_groups: { group: count } }], sorted
// by week ascending.
export function groupWeeklyVolume(rows) {
  const grouped = new Map();
  for (const r of rows) {
    const wk = weekStart(r.date);
    if (!grouped.has(wk)) grouped.set(wk, {});
    const bucket = grouped.get(wk);
    bucket[r.muscle_group] = (bucket[r.muscle_group] || 0) + 1;
  }
  const weeks = Array.from(grouped.keys()).sort();
  return weeks.map((wk) => ({ week_start: wk, muscle_groups: grouped.get(wk) }));
}

// Build all-time PRs (best weight set + best e1RM set) per exercise from
// a flat list of { exercise_id, exercise_name, muscle_group, weight, reps, date } rows.
export function computePRs(rows) {
  const byExercise = new Map();
  for (const r of rows) {
    if (!byExercise.has(r.exercise_id)) {
      byExercise.set(r.exercise_id, {
        exercise_id: r.exercise_id,
        exercise_name: r.exercise_name,
        muscle_group: r.muscle_group,
        sets: [],
      });
    }
    byExercise.get(r.exercise_id).sets.push(r);
  }

  const results = [];
  for (const ex of byExercise.values()) {
    if (ex.sets.length === 0) continue;
    let bestWeightSet = ex.sets[0];
    let bestE1RMSet = ex.sets[0];
    let bestE1RM = estimate1RM(ex.sets[0].weight, ex.sets[0].reps);
    for (const s of ex.sets) {
      if (s.weight > bestWeightSet.weight) bestWeightSet = s;
      const e = estimate1RM(s.weight, s.reps);
      if (e > bestE1RM) {
        bestE1RM = e;
        bestE1RMSet = s;
      }
    }
    results.push({
      exercise_id: ex.exercise_id,
      exercise_name: ex.exercise_name,
      muscle_group: ex.muscle_group,
      best_weight: bestWeightSet,
      best_e1rm: { ...bestE1RMSet, e1rm: Math.round(bestE1RM * 10) / 10 },
    });
  }
  return results;
}

// ---------- PR history ----------

// rows: flat sets [{ exercise_id, exercise_name, muscle_group, weight,
//   reps, rir, date, set_order }]
// Returns one entry per exercise (sorted by name):
//   { exercise_id, exercise_name, muscle_group,
//     milestones: [{ date, weight, reps, rir, e1rm, isWeightPR, isE1RMPR }] }
// A milestone is any set that beat the running best weight (heaviest ever,
// any rep count) and/or the running best estimated 1RM. Ties don't count,
// same "must exceed" rule as detectPR. Milestones are chronological; within
// a day, set_order decides which set came first.
export function computePRHistory(rows) {
  const byExercise = new Map();
  for (const r of rows) {
    if (!byExercise.has(r.exercise_id)) {
      byExercise.set(r.exercise_id, {
        exercise_id: r.exercise_id,
        exercise_name: r.exercise_name,
        muscle_group: r.muscle_group,
        sets: [],
      });
    }
    byExercise.get(r.exercise_id).sets.push(r);
  }

  const results = [];
  for (const ex of byExercise.values()) {
    const sorted = [...ex.sets].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.set_order || 0) - (b.set_order || 0)
    );
    let bestWeight = -Infinity;
    let bestE1RM = -Infinity;
    const milestones = [];
    for (const s of sorted) {
      const e = estimate1RM(s.weight, s.reps);
      const isWeightPR = s.weight > bestWeight;
      const isE1RMPR = e > bestE1RM;
      if (isWeightPR || isE1RMPR) {
        milestones.push({
          date: s.date,
          weight: s.weight,
          reps: s.reps,
          rir: s.rir ?? null,
          e1rm: Math.round(e * 10) / 10,
          isWeightPR,
          isE1RMPR,
        });
      }
      if (isWeightPR) bestWeight = s.weight;
      if (isE1RMPR) bestE1RM = e;
    }
    results.push({
      exercise_id: ex.exercise_id,
      exercise_name: ex.exercise_name,
      muscle_group: ex.muscle_group,
      milestones,
    });
  }
  return results.sort((a, b) => a.exercise_name.localeCompare(b.exercise_name));
}

// ---------- export formatting ----------

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// setsRows: [{ date, exercise, muscle_group, weight, reps, rir }]
// Returns a CSV string with header: date,exercise,muscle_group,weight,reps,rir,e1rm
export function toCSV(setsRows) {
  const header = ['date', 'exercise', 'muscle_group', 'weight', 'reps', 'rir', 'e1rm'];
  const lines = [header.join(',')];
  for (const r of setsRows) {
    const e1rm = roundE1RM(r.weight, r.reps);
    lines.push(
      [
        csvEscape(r.date),
        csvEscape(r.exercise),
        csvEscape(r.muscle_group),
        csvEscape(r.weight),
        csvEscape(r.reps),
        csvEscape(r.rir ?? ''),
        csvEscape(e1rm),
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

// prHistory: the output of computePRHistory. One row per milestone.
// header: date,exercise,muscle_group,weight,reps,rir,e1rm,record
export function toPRHistoryCSV(prHistory) {
  const header = ['date', 'exercise', 'muscle_group', 'weight', 'reps', 'rir', 'e1rm', 'record'];
  const lines = [header.join(',')];
  for (const ex of prHistory) {
    for (const m of ex.milestones) {
      const record = m.isWeightPR && m.isE1RMPR ? 'weight + e1rm' : m.isWeightPR ? 'weight' : 'e1rm';
      lines.push(
        [
          csvEscape(m.date),
          csvEscape(ex.exercise_name),
          csvEscape(ex.muscle_group),
          csvEscape(m.weight),
          csvEscape(m.reps),
          csvEscape(m.rir ?? ''),
          csvEscape(m.e1rm),
          csvEscape(record),
        ].join(',')
      );
    }
  }
  return lines.join('\n') + '\n';
}

// sessions: [{ date, notes, exercises: [{ exercise_name, muscle_group, sets: [{weight,reps,rir}] }] }]
// Returns array of { date, notes, exercises: [{ name, muscle_group, sets: [{weight,reps,rir}] }] }
export function toJSONExport(sessions) {
  return sessions.map((s) => ({
    date: s.date,
    notes: s.notes || '',
    exercises: s.exercises.map((ex) => ({
      name: ex.exercise_name,
      muscle_group: ex.muscle_group,
      sets: ex.sets.map((st) => ({ weight: st.weight, reps: st.reps, rir: st.rir ?? null })),
    })),
  }));
}

// ---------- routines ----------

export const ROUTINE_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// From the routines already filtered to today, pick the one to auto-open:
// with several, prefer the one whose time tag ('am' / 'pm') matches the
// current hour; otherwise just the first. Returns null for an empty list.
export function pickActiveRoutine(todaysRoutines, hour) {
  const list = todaysRoutines || [];
  if (list.length <= 1) return list[0] || null;
  const bucket = hour < 12 ? 'am' : 'pm';
  return list.find((r) => r.time === bucket) || list[0];
}

// Shape routines for export: exercise ids become names, in order.
export function toRoutinesExport(routines) {
  return (routines || []).map((r) => ({
    name: r.name,
    day: r.day || null,
    time: r.time || null,
    exercises: (r.exercises || []).map((e) => e.name),
  }));
}

// ---------- import / backup ----------

// Wrap the JSON-export session array plus body-weight rows and routines
// into one self-describing object for the downloadable full backup.
// toJSONExport stays a bare array (that output also gets pasted straight
// into chats), so the file that must round-trip *everything* gets its own
// shape here. `routines` is optional and last so older callers are unaffected.
export function toBackupJSON(sessions, bodyWeight, exportedAtISO, routines, dailyLogs) {
  return {
    app: 'FORGED',
    version: 1,
    exported_at: exportedAtISO || new Date().toISOString(),
    sessions: toJSONExport(sessions),
    bodyWeight: (bodyWeight || []).map((b) => ({ date: b.date, weight: b.weight })),
    routines: toRoutinesExport(routines),
    dailyLogs: toDailyLogsExport(dailyLogs),
  };
}

// Daily logs as stored, minus anything empty, oldest first.
export function toDailyLogsExport(dailyLogs) {
  return (dailyLogs || [])
    .map((l) => normalizeDailyLog(l, l && l.date))
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const IMPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function importFail(msg) {
  throw new Error('Import failed: ' + msg);
}

// Parse + validate a pasted / loaded import payload. Accepts either the
// bare session array produced by toJSONExport, or a
// { sessions, bodyWeight, routines } object (the toBackupJSON shape).
// Returns a normalized { sessions, bodyWeight, routines, summary } with
// every field type-checked, or throws an Error with a human-readable
// reason. Touches no storage - the caller hands the result to
// db.importData().
export function parseImportJSON(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    importFail('that is not valid JSON.');
  }

  let sessionsIn, bodyWeightIn, routinesIn, dailyLogsIn;
  if (Array.isArray(raw)) {
    sessionsIn = raw;
    bodyWeightIn = [];
    routinesIn = [];
    dailyLogsIn = [];
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.sessions)) {
    sessionsIn = raw.sessions;
    bodyWeightIn = Array.isArray(raw.bodyWeight) ? raw.bodyWeight : [];
    routinesIn = Array.isArray(raw.routines) ? raw.routines : [];
    dailyLogsIn = Array.isArray(raw.dailyLogs) ? raw.dailyLogs : [];
  } else {
    importFail('expected a JSON array of sessions, or an object with a "sessions" array.');
  }

  const sessions = sessionsIn.map((s, i) => {
    const where = `session ${i + 1}`;
    if (!s || typeof s !== 'object') importFail(`${where} is not an object.`);
    if (!IMPORT_DATE_RE.test(s.date)) importFail(`${where} has a missing or malformed date (expected YYYY-MM-DD).`);

    const exercisesRaw = Array.isArray(s.exercises) ? s.exercises : [];
    const exercises = exercisesRaw.map((ex, j) => {
      const exWhere = `${where}, exercise ${j + 1}`;
      if (!ex || typeof ex !== 'object') importFail(`${exWhere} is not an object.`);
      const name = String(ex.name ?? ex.exercise_name ?? '').trim();
      if (!name) importFail(`${exWhere} has no name.`);
      const muscle_group = String(ex.muscle_group ?? '').trim() || 'Other';

      const setsRaw = Array.isArray(ex.sets) ? ex.sets : [];
      const sets = setsRaw.map((st, k) => {
        const stWhere = `${exWhere}, set ${k + 1}`;
        if (!st || typeof st !== 'object') importFail(`${stWhere} is not an object.`);
        const weight = Number(st.weight);
        const reps = Number(st.reps);
        if (!Number.isFinite(weight) || weight < 0) importFail(`${stWhere} has an invalid weight.`);
        if (!Number.isInteger(reps) || reps <= 0) importFail(`${stWhere} has an invalid rep count.`);
        let rir = st.rir;
        rir = rir === '' || rir === undefined || rir === null ? null : Number(rir);
        if (rir !== null && (!Number.isFinite(rir) || rir < 0 || rir > 10)) importFail(`${stWhere} has an invalid RIR.`);
        return { weight, reps, rir };
      });

      return { name, muscle_group, sets };
    });

    const notes = typeof s.notes === 'string' ? s.notes : '';
    return { date: s.date, notes, exercises };
  });

  const bodyWeight = bodyWeightIn.map((b, i) => {
    const where = `body-weight entry ${i + 1}`;
    if (!b || typeof b !== 'object') importFail(`${where} is not an object.`);
    if (!IMPORT_DATE_RE.test(b.date)) importFail(`${where} has a missing or malformed date.`);
    const weight = Number(b.weight);
    if (!Number.isFinite(weight) || weight <= 0) importFail(`${where} has an invalid weight.`);
    return { date: b.date, weight };
  });

  const routines = routinesIn.map((r, i) => {
    const where = `routine ${i + 1}`;
    if (!r || typeof r !== 'object') importFail(`${where} is not an object.`);
    const name = String(r.name ?? '').trim();
    if (!name) importFail(`${where} has no name.`);
    const day = ROUTINE_DAY_LABELS.includes(r.day) ? r.day : null;
    const time = r.time === 'am' || r.time === 'pm' ? r.time : null;
    const exercises = (Array.isArray(r.exercises) ? r.exercises : [])
      .map((e) => String(e ?? '').trim())
      .filter(Boolean);
    return { name, day, time, exercises };
  });

  // Daily logs are sanitized rather than rejected: a malformed row is dropped
  // (normalizeDailyLog returns null) instead of failing the whole import.
  const dailyLogs = dailyLogsIn
    .map((l) => normalizeDailyLog(l, l && l.date))
    .filter(Boolean);

  const setCount = sessions.reduce(
    (n, s) => n + s.exercises.reduce((m, e) => m + e.sets.length, 0),
    0
  );
  return {
    sessions,
    bodyWeight,
    routines,
    dailyLogs,
    summary: {
      sessions: sessions.length,
      sets: setCount,
      bodyWeight: bodyWeight.length,
      routines: routines.length,
      dailyLogs: dailyLogs.length,
    },
  };
}

// ---------- daily log (nutrition / water / supplements / sleep / day rating) ----------
//
// One record per date, modeled on a paper training-journal page:
//   { date, meals: [{ slot, name, time, calories, protein, carbs, fat }],
//     water, supplements: [{ name, amount }],
//     sleep: { lights_out, wake_up, quality }, day_rating }
// `water` counts 8-oz servings. `sleep` is the night that ended on the
// morning of `date`. `day_rating` is "on track with goals" in 10% steps.

export const MEAL_SLOTS = ['Breakfast', 'Snack', 'Lunch', 'Snack', 'Dinner', 'Snack'];
export const WATER_SERVING_OZ = 8;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAILY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

// Blank / non-numeric / negative -> null; otherwise a number rounded to 1 dp.
function cleanNum(v, max = 100000) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 10) / 10;
}

function cleanTime(v) {
  const s = String(v ?? '').trim();
  return TIME_RE.test(s) ? s : '';
}

// Coerce anything (UI state, imported JSON) into a clean daily-log shape, or
// null if there is nothing worth keeping. Never throws.
export function normalizeDailyLog(raw, date) {
  if (!raw || typeof raw !== 'object') return null;
  const d = date || raw.date;
  if (!DAILY_DATE_RE.test(String(d))) return null;

  const meals = (Array.isArray(raw.meals) ? raw.meals : [])
    .slice(0, 20)
    .map((m) => ({
      slot: cleanText(m && m.slot, 40) || 'Meal',
      name: cleanText(m && m.name, 300),
      time: cleanTime(m && m.time),
      calories: cleanNum(m && m.calories, 20000),
      protein: cleanNum(m && m.protein, 2000),
      carbs: cleanNum(m && m.carbs, 5000),
      fat: cleanNum(m && m.fat, 2000),
    }))
    .filter((m) => m.name || m.time || m.calories !== null || m.protein !== null || m.carbs !== null || m.fat !== null);

  const supplements = (Array.isArray(raw.supplements) ? raw.supplements : [])
    .slice(0, 40)
    .map((s) => ({ name: cleanText(s && s.name, 80), amount: cleanText(s && s.amount, 60) }))
    .filter((s) => s.name || s.amount);

  const sl = raw.sleep && typeof raw.sleep === 'object' ? raw.sleep : {};
  let quality = cleanNum(sl.quality, 10);
  if (quality !== null) quality = Math.round(quality);
  if (quality !== null && quality < 1) quality = null;
  const sleep = { lights_out: cleanTime(sl.lights_out), wake_up: cleanTime(sl.wake_up), quality };

  let water = cleanNum(raw.water, 100);
  water = water === null ? 0 : Math.round(water);

  let day_rating = cleanNum(raw.day_rating, 100);
  if (day_rating !== null) day_rating = Math.round(day_rating / 10) * 10;
  if (day_rating !== null && day_rating < 10) day_rating = null;

  const log = { date: d, meals, water, supplements, sleep, day_rating };
  return isDailyLogEmpty(log) ? null : log;
}

export function isDailyLogEmpty(log) {
  if (!log) return true;
  const sleep = log.sleep || {};
  return (
    !(log.meals && log.meals.length) &&
    !(log.supplements && log.supplements.length) &&
    !log.water &&
    !sleep.lights_out && !sleep.wake_up && sleep.quality == null &&
    log.day_rating == null
  );
}

// Sum calories / protein / carbs / fat across meals, ignoring blanks.
export function sumMeals(meals) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const m of meals || []) {
    for (const k of Object.keys(t)) {
      if (typeof m[k] === 'number' && Number.isFinite(m[k])) t[k] += m[k];
    }
  }
  for (const k of Object.keys(t)) t[k] = Math.round(t[k] * 10) / 10;
  return t;
}

// Hours slept between lights-out and wake-up ("HH:MM" strings), crossing
// midnight when wake-up is earlier than lights-out. null if either is missing
// or they are identical (ambiguous: 0h or 24h).
export function sleepHours(lightsOut, wakeUp) {
  if (!TIME_RE.test(lightsOut || '') || !TIME_RE.test(wakeUp || '')) return null;
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  let diff = toMin(wakeUp) - toMin(lightsOut);
  if (diff === 0) return null;
  if (diff < 0) diff += 24 * 60;
  return Math.round((diff / 60) * 100) / 100;
}

// Combine training sessions, daily logs and body weight into one record per
// date (every date that has a training session OR a daily log), oldest first.
//   sessions: getSessionsForExport() shape
//   dailyLogs: stored daily-log rows
//   bodyWeight: [{date, weight}]
export function buildDailyAnalysis(sessions, dailyLogs, bodyWeight) {
  const byDate = new Map();
  const slot = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date });
    return byDate.get(date);
  };
  for (const s of sessions || []) slot(s.date).session = s;
  for (const l of dailyLogs || []) if (!isDailyLogEmpty(l)) slot(l.date).log = l;
  const bwByDate = new Map((bodyWeight || []).map((b) => [b.date, b.weight]));

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return days.map(({ date, session, log }) => {
    const [y, m, d] = date.split('-').map(Number);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(y, m - 1, d).getDay()];

    let training = { trained: false, total_sets: 0, total_reps: 0, volume: 0, muscle_groups: [], exercises: [], notes: '' };
    if (session) {
      const groups = new Set();
      let sets = 0, reps = 0, volume = 0;
      const exercises = (session.exercises || []).map((ex) => {
        groups.add(ex.muscle_group);
        for (const st of ex.sets) { sets++; reps += st.reps; volume += st.weight * st.reps; }
        return {
          name: ex.exercise_name,
          muscle_group: ex.muscle_group,
          sets: ex.sets.map((st) => ({ weight: st.weight, reps: st.reps, rir: st.rir ?? null })),
        };
      });
      training = {
        trained: sets > 0,
        total_sets: sets,
        total_reps: reps,
        volume: Math.round(volume * 10) / 10,
        muscle_groups: [...groups].sort(),
        exercises,
        notes: session.notes || '',
      };
    }

    const out = { date, weekday, training, body_weight: bwByDate.has(date) ? bwByDate.get(date) : null };
    if (log) {
      const sl = log.sleep || {};
      out.nutrition = { meals: log.meals || [], totals: sumMeals(log.meals) };
      out.water_oz = (log.water || 0) * WATER_SERVING_OZ;
      out.supplements = log.supplements || [];
      out.sleep = {
        lights_out: sl.lights_out || null,
        wake_up: sl.wake_up || null,
        hours: sleepHours(sl.lights_out, sl.wake_up),
        quality_1_to_10: sl.quality ?? null,
      };
      out.day_rating_pct = log.day_rating ?? null;
    } else {
      out.nutrition = null;
      out.water_oz = null;
      out.supplements = [];
      out.sleep = null;
      out.day_rating_pct = null;
    }
    return out;
  });
}

// Wrap the per-day records with a short legend so a chat model can read the
// file cold, without needing to be told what the fields mean.
export function toDailyAnalysisJSON(days, exportedAtISO) {
  return {
    app: 'FORGED',
    kind: 'daily-log-with-training',
    exported_at: exportedAtISO || new Date().toISOString(),
    legend: {
      training: 'Lifting done that date. volume = sum of weight x reps over all sets (lb). rir = reps in reserve.',
      nutrition: 'meals as logged (calories in kcal, protein/carbs/fat in grams); totals = sum of the logged meals. Days with nothing logged have nutrition: null.',
      water_oz: 'Water in ounces (logged as 8-oz servings).',
      sleep: 'The night that ended on the morning of this date. hours is computed from lights_out to wake_up.',
      day_rating_pct: 'Self-rated "on track with goals" for the day, 10-100.',
      body_weight: 'Body weight logged that date, if any.',
    },
    days,
  };
}

// One row per day, spreadsheet-ready.
export function toDailyCSV(days) {
  const header = [
    'date', 'weekday', 'trained', 'sets', 'reps', 'volume', 'muscle_groups',
    'calories', 'protein_g', 'carbs_g', 'fat_g', 'meals_logged', 'water_oz',
    'supplements', 'lights_out', 'wake_up', 'sleep_hours', 'sleep_quality',
    'day_rating_pct', 'body_weight', 'session_notes',
  ];
  const lines = [header.join(',')];
  for (const d of days) {
    const n = d.nutrition;
    const sl = d.sleep || {};
    const row = [
      d.date,
      d.weekday,
      d.training.trained ? 'yes' : 'no',
      d.training.total_sets,
      d.training.total_reps,
      d.training.volume,
      d.training.muscle_groups.join('/'),
      n ? n.totals.calories : '',
      n ? n.totals.protein : '',
      n ? n.totals.carbs : '',
      n ? n.totals.fat : '',
      n ? n.meals.length : '',
      d.water_oz ?? '',
      (d.supplements || []).map((s) => (s.amount ? `${s.name} ${s.amount}` : s.name)).join('; '),
      sl.lights_out ?? '',
      sl.wake_up ?? '',
      sl.hours ?? '',
      sl.quality_1_to_10 ?? '',
      d.day_rating_pct ?? '',
      d.body_weight ?? '',
      d.training.notes,
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}
