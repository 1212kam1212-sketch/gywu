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
