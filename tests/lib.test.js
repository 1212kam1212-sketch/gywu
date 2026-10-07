import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimate1RM,
  roundE1RM,
  weekStart,
  detectPR,
  groupWeeklyVolume,
  computePRs,
  toCSV,
  toJSONExport,
  toBackupJSON,
  parseImportJSON,
  computePRHistory,
  toPRHistoryCSV,
  pickActiveRoutine,
  toRoutinesExport,
  highestMilestone,
  nextMilestone,
  normalizeDailyLog,
  isDailyLogEmpty,
  sumMeals,
  sleepHours,
  buildDailyAnalysis,
  toDailyAnalysisJSON,
  toDailyCSV,
  toDailyLogsExport,
  waterOz,
  isRealDate,
  DAILY_LIMITS,
  normalizeSavedMeal,
  toSavedMealsExport,
  buildMealSuggestions,
  filterMealSuggestions,
  scaleMacros,
  copyMealsInto,
} from '../js/lib.js';

// ---------- estimate1RM ----------

test('estimate1RM: reps <= 1 returns raw weight', () => {
  assert.equal(estimate1RM(225, 1), 225);
  assert.equal(estimate1RM(225, 0), 225);
});

test('estimate1RM: Epley formula for reps > 1', () => {
  // 100 * (1 + 5/30) = 116.666...
  assert.ok(Math.abs(estimate1RM(100, 5) - 116.6667) < 0.001);
});

test('roundE1RM: rounds to 1 decimal place', () => {
  assert.equal(roundE1RM(100, 5), 116.7);
});

// ---------- weekStart ----------

test('weekStart: Monday maps to itself', () => {
  assert.equal(weekStart('2026-08-17'), '2026-08-17'); // a Monday
});

test('weekStart: Sunday maps back to preceding Monday', () => {
  assert.equal(weekStart('2026-08-23'), '2026-08-17'); // Sunday
});

test('weekStart: Wednesday maps back to that week\'s Monday', () => {
  assert.equal(weekStart('2026-08-19'), '2026-08-17');
});

// ---------- detectPR ----------

test('detectPR: first-ever set for an exercise is always a PR', () => {
  const result = detectPR([], { weight: 100, reps: 5 });
  assert.equal(result.isWeightPR, true);
  assert.equal(result.isE1RMPR, true);
});

test('detectPR: heavier weight at same rep count is a weight PR', () => {
  const prior = [{ weight: 100, reps: 5 }];
  const result = detectPR(prior, { weight: 105, reps: 5 });
  assert.equal(result.isWeightPR, true);
});

test('detectPR: lighter weight at same rep count is not a weight PR', () => {
  const prior = [{ weight: 100, reps: 5 }];
  const result = detectPR(prior, { weight: 95, reps: 5 });
  assert.equal(result.isWeightPR, false);
});

test('detectPR: same weight is not a new weight PR (must exceed, not tie)', () => {
  const prior = [{ weight: 100, reps: 5 }];
  const result = detectPR(prior, { weight: 100, reps: 5 });
  assert.equal(result.isWeightPR, false);
});

test('detectPR: weight PR only compares against sets with reps >= new reps', () => {
  // Previously did 60x20 (weight 60), now doing 70x5 - not comparable rep range,
  // so 70 should still count as a weight PR at this rep count.
  const prior = [{ weight: 60, reps: 20 }];
  const result = detectPR(prior, { weight: 70, reps: 5 });
  assert.equal(result.isWeightPR, true);
});

test('detectPR: e1RM PR at a rep range with no prior comparable set', () => {
  // Prior: 100x5 only (e1RM ~116.7). New: 90x10 (e1RM = 90*1.333 = 120).
  // No prior set had reps >= 10, so this also counts as a weight PR at
  // that rep range (nothing to beat) - same semantics as the old backend.
  const prior = [{ weight: 100, reps: 5 }];
  const result = detectPR(prior, { weight: 90, reps: 10 });
  assert.equal(result.isWeightPR, true);
  assert.equal(result.isE1RMPR, true);
});

test('detectPR: non-PR set flags neither', () => {
  const prior = [{ weight: 100, reps: 5 }];
  const result = detectPR(prior, { weight: 80, reps: 5 });
  assert.equal(result.isWeightPR, false);
  assert.equal(result.isE1RMPR, false);
});

// ---------- groupWeeklyVolume ----------

test('groupWeeklyVolume: counts sets per muscle group per week', () => {
  const rows = [
    { date: '2026-08-17', muscle_group: 'Chest' },
    { date: '2026-08-17', muscle_group: 'Chest' },
    { date: '2026-08-18', muscle_group: 'Back' },
    { date: '2026-08-24', muscle_group: 'Chest' }, // next week
  ];
  const result = groupWeeklyVolume(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0].week_start, '2026-08-17');
  assert.deepEqual(result[0].muscle_groups, { Chest: 2, Back: 1 });
  assert.equal(result[1].week_start, '2026-08-24');
  assert.deepEqual(result[1].muscle_groups, { Chest: 1 });
});

test('groupWeeklyVolume: empty input returns empty array', () => {
  assert.deepEqual(groupWeeklyVolume([]), []);
});

// ---------- computePRs ----------

test('computePRs: picks heaviest weight and best e1RM per exercise', () => {
  const rows = [
    { exercise_id: 1, exercise_name: 'Bench', muscle_group: 'Chest', weight: 100, reps: 5, date: '2026-01-01' },
    { exercise_id: 1, exercise_name: 'Bench', muscle_group: 'Chest', weight: 110, reps: 3, date: '2026-02-01' },
    { exercise_id: 1, exercise_name: 'Bench', muscle_group: 'Chest', weight: 90, reps: 10, date: '2026-03-01' },
  ];
  const prs = computePRs(rows);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].best_weight.weight, 110);
  // e1RM: 100x5=116.67, 110x3=121, 90x10=120 -> best is 110x3
  assert.equal(prs[0].best_e1rm.weight, 110);
});

test('computePRs: skips exercises with no sets, handles multiple exercises', () => {
  const rows = [
    { exercise_id: 1, exercise_name: 'Bench', muscle_group: 'Chest', weight: 100, reps: 5, date: '2026-01-01' },
    { exercise_id: 2, exercise_name: 'Squat', muscle_group: 'Legs', weight: 150, reps: 5, date: '2026-01-02' },
  ];
  const prs = computePRs(rows);
  assert.equal(prs.length, 2);
});

// ---------- computePRHistory ----------

const prRow = (o) => ({
  exercise_id: 1,
  exercise_name: 'Bench',
  muscle_group: 'Chest',
  rir: null,
  set_order: 1,
  ...o,
});

test('computePRHistory: first set is always a milestone (weight + e1rm)', () => {
  const [ex] = computePRHistory([prRow({ weight: 100, reps: 5, date: '2026-01-01' })]);
  assert.equal(ex.milestones.length, 1);
  assert.equal(ex.milestones[0].isWeightPR, true);
  assert.equal(ex.milestones[0].isE1RMPR, true);
  assert.equal(ex.milestones[0].e1rm, 116.7);
});

test('computePRHistory: records each new best chronologically, ignoring non-PRs and ties', () => {
  const rows = [
    prRow({ weight: 100, reps: 5, date: '2026-01-01' }),
    prRow({ weight: 100, reps: 5, date: '2026-01-08' }), // exact tie -> not a milestone
    prRow({ weight: 105, reps: 3, date: '2026-01-15' }), // e1rm 115.5 < 116.7 -> weight only
    prRow({ weight: 95, reps: 12, date: '2026-01-22' }), // e1rm 133 -> e1rm only
    prRow({ weight: 80, reps: 5, date: '2026-01-29' }), // nothing
  ];
  const [ex] = computePRHistory(rows);
  assert.deepEqual(ex.milestones.map((m) => m.date), ['2026-01-01', '2026-01-15', '2026-01-22']);
  assert.deepEqual(
    ex.milestones.map((m) => [m.isWeightPR, m.isE1RMPR]),
    [[true, true], [true, false], [false, true]]
  );
});

test('computePRHistory: within a day, set_order decides which set came first', () => {
  const rows = [
    prRow({ weight: 80, reps: 5, date: '2026-01-01', set_order: 2 }),
    prRow({ weight: 100, reps: 5, date: '2026-01-01', set_order: 1 }),
  ];
  const [ex] = computePRHistory(rows);
  assert.equal(ex.milestones.length, 1);
  assert.equal(ex.milestones[0].weight, 100);
});

test('computePRHistory: separates exercises and sorts them by name', () => {
  const rows = [
    prRow({ exercise_id: 2, exercise_name: 'Squat', muscle_group: 'Legs', weight: 150, reps: 5, date: '2026-01-02' }),
    prRow({ weight: 100, reps: 5, date: '2026-01-01' }),
  ];
  assert.deepEqual(computePRHistory(rows).map((e) => e.exercise_name), ['Bench', 'Squat']);
});

// ---------- toPRHistoryCSV ----------

test('toPRHistoryCSV: header + one row per milestone with the record type', () => {
  const rows = [
    prRow({ weight: 100, reps: 5, rir: 2, date: '2026-01-01' }),
    prRow({ weight: 105, reps: 3, rir: 1, date: '2026-01-15' }),
  ];
  const lines = toPRHistoryCSV(computePRHistory(rows)).trim().split('\n');
  assert.equal(lines[0], 'date,exercise,muscle_group,weight,reps,rir,e1rm,record');
  assert.equal(lines[1], '2026-01-01,Bench,Chest,100,5,2,116.7,weight + e1rm');
  assert.equal(lines[2], '2026-01-15,Bench,Chest,105,3,1,115.5,weight');
});

test('toPRHistoryCSV: empty input still returns the header row', () => {
  assert.equal(toPRHistoryCSV([]).trim(), 'date,exercise,muscle_group,weight,reps,rir,e1rm,record');
});

// ---------- toCSV ----------

test('toCSV: produces header + one row per set with correct columns', () => {
  const rows = [
    { date: '2026-08-17', exercise: 'Bench Press', muscle_group: 'Chest', weight: 100, reps: 5, rir: 2 },
  ];
  const csv = toCSV(rows);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'date,exercise,muscle_group,weight,reps,rir,e1rm');
  assert.equal(lines[1], '2026-08-17,Bench Press,Chest,100,5,2,116.7');
});

test('toCSV: escapes commas and quotes in fields', () => {
  const rows = [
    { date: '2026-08-17', exercise: 'Row, Barbell "T"', muscle_group: 'Back', weight: 80, reps: 8, rir: null },
  ];
  const csv = toCSV(rows);
  const lines = csv.trim().split('\n');
  assert.equal(lines[1], '2026-08-17,"Row, Barbell ""T""",Back,80,8,,101.3');
});

test('toCSV: empty input still returns header row', () => {
  const csv = toCSV([]);
  assert.equal(csv.trim(), 'date,exercise,muscle_group,weight,reps,rir,e1rm');
});

// ---------- toJSONExport ----------

test('toJSONExport: matches the {date, notes, exercises:[{name, muscle_group, sets}]} shape', () => {
  const sessions = [
    {
      date: '2026-08-17',
      notes: 'Felt strong',
      exercises: [
        {
          exercise_name: 'Bench Press',
          muscle_group: 'Chest',
          sets: [{ weight: 100, reps: 5, rir: 2 }],
        },
      ],
    },
  ];
  const out = toJSONExport(sessions);
  assert.deepEqual(out, [
    {
      date: '2026-08-17',
      notes: 'Felt strong',
      exercises: [
        {
          name: 'Bench Press',
          muscle_group: 'Chest',
          sets: [{ weight: 100, reps: 5, rir: 2 }],
        },
      ],
    },
  ]);
  // Must be valid JSON when stringified
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
});

test('toJSONExport: missing notes defaults to empty string', () => {
  const sessions = [{ date: '2026-08-17', exercises: [] }];
  const out = toJSONExport(sessions);
  assert.equal(out[0].notes, '');
});

// ---------- parseImportJSON ----------

test('parseImportJSON: accepts the bare toJSONExport array', () => {
  const arr = [
    {
      date: '2026-08-17',
      notes: 'x',
      exercises: [
        { name: 'Bench Press', muscle_group: 'Chest', sets: [{ weight: 100, reps: 5, rir: 2 }] },
      ],
    },
  ];
  const out = parseImportJSON(JSON.stringify(arr));
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].exercises[0].name, 'Bench Press');
  assert.equal(out.sessions[0].exercises[0].sets[0].weight, 100);
  assert.deepEqual(out.summary, { sessions: 1, sets: 1, bodyWeight: 0, routines: 0, dailyLogs: 0, savedMeals: 0 });
});

test('parseImportJSON: accepts a { sessions, bodyWeight } backup object', () => {
  const obj = {
    app: 'FORGED',
    version: 1,
    sessions: [],
    bodyWeight: [{ date: '2026-08-17', weight: 80 }],
  };
  const out = parseImportJSON(JSON.stringify(obj));
  assert.equal(out.sessions.length, 0);
  assert.deepEqual(out.bodyWeight, [{ date: '2026-08-17', weight: 80 }]);
  assert.equal(out.summary.bodyWeight, 1);
});

test('parseImportJSON: tolerates exercise_name instead of name', () => {
  const arr = [
    { date: '2026-08-17', exercises: [{ exercise_name: 'Squat', muscle_group: 'Legs', sets: [] }] },
  ];
  const out = parseImportJSON(JSON.stringify(arr));
  assert.equal(out.sessions[0].exercises[0].name, 'Squat');
});

test('parseImportJSON: normalizes missing rir to null and missing notes to ""', () => {
  const arr = [{ date: '2026-08-17', exercises: [{ name: 'Bench', sets: [{ weight: 100, reps: 5 }] }] }];
  const out = parseImportJSON(JSON.stringify(arr));
  assert.equal(out.sessions[0].notes, '');
  assert.equal(out.sessions[0].exercises[0].sets[0].rir, null);
});

test('parseImportJSON: defaults a missing muscle_group to "Other"', () => {
  const arr = [{ date: '2026-08-17', exercises: [{ name: 'Farmer Carry', sets: [] }] }];
  const out = parseImportJSON(JSON.stringify(arr));
  assert.equal(out.sessions[0].exercises[0].muscle_group, 'Other');
});

test('parseImportJSON: rejects invalid JSON', () => {
  assert.throws(() => parseImportJSON('{not json'), /valid JSON/);
});

test('parseImportJSON: rejects a malformed session date', () => {
  assert.throws(() => parseImportJSON(JSON.stringify([{ date: 'Aug 17', exercises: [] }])), /malformed date/);
});

test('parseImportJSON: rejects a non-positive-integer rep count', () => {
  const arr = [{ date: '2026-08-17', exercises: [{ name: 'Bench', sets: [{ weight: 100, reps: 0 }] }] }];
  assert.throws(() => parseImportJSON(JSON.stringify(arr)), /rep count/);
});

test('parseImportJSON: rejects a negative weight', () => {
  const arr = [{ date: '2026-08-17', exercises: [{ name: 'Bench', sets: [{ weight: -5, reps: 5 }] }] }];
  assert.throws(() => parseImportJSON(JSON.stringify(arr)), /invalid weight/);
});

test('parseImportJSON: rejects a top-level object with no sessions array', () => {
  assert.throws(() => parseImportJSON('{"foo":1}'), /sessions/);
});

// ---------- toBackupJSON ----------

test('toBackupJSON: wraps sessions + body weight with metadata, stripping ids', () => {
  const sessions = [
    {
      date: '2026-08-17',
      notes: '',
      exercises: [
        { exercise_name: 'Bench', muscle_group: 'Chest', sets: [{ weight: 100, reps: 5, rir: null }] },
      ],
    },
  ];
  const bw = [{ id: 3, date: '2026-08-17', weight: 80 }];
  const out = toBackupJSON(sessions, bw, '2026-08-17T00:00:00.000Z');
  assert.equal(out.app, 'FORGED');
  assert.equal(out.version, 1);
  assert.equal(out.exported_at, '2026-08-17T00:00:00.000Z');
  assert.deepEqual(out.sessions, toJSONExport(sessions));
  assert.deepEqual(out.bodyWeight, [{ date: '2026-08-17', weight: 80 }]);
});

test('toBackupJSON: round-trips through parseImportJSON', () => {
  const sessions = [
    {
      date: '2026-08-17',
      notes: 'hi',
      exercises: [
        { exercise_name: 'Bench', muscle_group: 'Chest', sets: [{ weight: 100, reps: 5, rir: 2 }] },
      ],
    },
  ];
  const backup = toBackupJSON(sessions, [{ date: '2026-08-17', weight: 80 }], '2026-08-17T00:00:00.000Z');
  const parsed = parseImportJSON(JSON.stringify(backup));
  assert.equal(parsed.sessions[0].exercises[0].name, 'Bench');
  assert.equal(parsed.sessions[0].exercises[0].sets[0].rir, 2);
  assert.equal(parsed.sessions[0].notes, 'hi');
  assert.deepEqual(parsed.bodyWeight, [{ date: '2026-08-17', weight: 80 }]);
});

// ---------- routines ----------

test('toRoutinesExport: reduces resolved routines to name/day/time/exercise-names', () => {
  const routines = [
    {
      id: 7, name: 'Mon PM - Chest', day: 'Mon', time: 'pm',
      exercises: [
        { id: 1, name: 'Incline Press', muscle_group: 'Chest' },
        { id: 2, name: 'Cable Fly', muscle_group: 'Chest' },
      ],
    },
  ];
  assert.deepEqual(toRoutinesExport(routines), [
    { name: 'Mon PM - Chest', day: 'Mon', time: 'pm', exercises: ['Incline Press', 'Cable Fly'] },
  ]);
});

test('toRoutinesExport: null-safe on empty / missing fields', () => {
  assert.deepEqual(toRoutinesExport(), []);
  assert.deepEqual(toRoutinesExport([{ name: 'x' }]), [{ name: 'x', day: null, time: null, exercises: [] }]);
});

test('pickActiveRoutine: empty -> null, single -> that one', () => {
  assert.equal(pickActiveRoutine([], 9), null);
  const only = { id: 1, time: null };
  assert.equal(pickActiveRoutine([only], 9), only);
});

test('pickActiveRoutine: with two, matches the am/pm tag to the hour', () => {
  const am = { id: 1, time: 'am' };
  const pm = { id: 2, time: 'pm' };
  assert.equal(pickActiveRoutine([am, pm], 8), am);
  assert.equal(pickActiveRoutine([am, pm], 17), pm);
  assert.equal(pickActiveRoutine([am, pm], 12), pm); // noon counts as pm
});

test('pickActiveRoutine: no tag matches the bucket -> falls back to the first', () => {
  const a = { id: 1, time: null };
  const b = { id: 2, time: 'pm' };
  assert.equal(pickActiveRoutine([a, b], 8), a); // 8am, no "am" routine -> first
});

test('parseImportJSON: parses routines from the backup object, ignoring bad day/time', () => {
  const obj = {
    sessions: [],
    routines: [
      { name: 'Mon PM - Chest', day: 'Mon', time: 'pm', exercises: ['Incline Press', 'Cable Fly'] },
      { name: 'Sloppy', day: 'Monday', time: 'evening', exercises: [' Squat ', '', 3] },
    ],
  };
  const out = parseImportJSON(JSON.stringify(obj));
  assert.equal(out.summary.routines, 2);
  assert.deepEqual(out.routines[0], {
    name: 'Mon PM - Chest', day: 'Mon', time: 'pm', exercises: ['Incline Press', 'Cable Fly'],
  });
  // 'Monday'/'evening' aren't valid tokens -> nulled; blank exercise dropped, number coerced
  assert.deepEqual(out.routines[1], { name: 'Sloppy', day: null, time: null, exercises: ['Squat', '3'] });
});

test('parseImportJSON: a routine with no name is rejected', () => {
  assert.throws(
    () => parseImportJSON(JSON.stringify({ sessions: [], routines: [{ exercises: [] }] })),
    /routine 1 has no name/
  );
});

test('parseImportJSON: bare array input yields no routines', () => {
  const out = parseImportJSON(JSON.stringify([{ date: '2026-08-17', exercises: [] }]));
  assert.deepEqual(out.routines, []);
  assert.equal(out.summary.routines, 0);
});

// ---------- weight milestones ----------

test('highestMilestone: 0 below the first threshold', () => {
  assert.equal(highestMilestone(0), 0);
  assert.equal(highestMilestone(9999), 0);
});

test('highestMilestone: lands exactly on a named threshold', () => {
  assert.equal(highestMilestone(10000), 10000);
  assert.equal(highestMilestone(142850), 100000);
  assert.equal(highestMilestone(2000000), 2000000);
});

test('highestMilestone: steps every 500,000 past the last named threshold', () => {
  assert.equal(highestMilestone(2499999), 2000000);
  assert.equal(highestMilestone(2500000), 2500000);
  assert.equal(highestMilestone(3200000), 3000000);
});

test('nextMilestone: the next threshold still ahead', () => {
  assert.equal(nextMilestone(0), 10000);
  assert.equal(nextMilestone(142850), 150000);
  assert.equal(nextMilestone(10000), 25000); // right on a threshold -> the next one, not itself
});

test('nextMilestone: keeps stepping by 500,000 past the last named threshold', () => {
  assert.equal(nextMilestone(2000000), 2500000);
  assert.equal(nextMilestone(2600000), 3000000);
});

// ---------- daily log ----------

const sampleLog = () => ({
  meals: [
    { slot: 'Breakfast', name: 'Oats + whey', time: '07:30', calories: 520, protein: 42, carbs: 60, fat: 9 },
    { slot: 'Snack', name: '', time: '', calories: null, protein: null, carbs: null, fat: null },
    { slot: 'Lunch', name: 'Chicken rice', time: '12:15', calories: 700, protein: 55, carbs: 80, fat: 14 },
  ],
  water: 9,
  supplements: [{ name: 'Creatine', amount: '5g' }, { name: '', amount: '' }],
  sleep: { lights_out: '23:30', wake_up: '06:45', quality: 7 },
  day_rating: 80,
});

test('normalizeDailyLog: drops empty meals/supplements, keeps the rest', () => {
  const n = normalizeDailyLog(sampleLog(), '2026-10-06');
  assert.equal(n.date, '2026-10-06');
  assert.equal(n.meals.length, 2);
  assert.equal(n.supplements.length, 1);
  assert.equal(n.water, 9);
  assert.equal(n.day_rating, 80);
});

test('normalizeDailyLog: an all-blank day, or a bad date, is null', () => {
  assert.equal(normalizeDailyLog({ meals: [], water: 0, sleep: {} }, '2026-10-06'), null);
  assert.equal(normalizeDailyLog(sampleLog(), 'yesterday'), null);
  assert.equal(normalizeDailyLog(null, '2026-10-06'), null);
});

test('normalizeDailyLog: sanitizes junk instead of throwing', () => {
  const n = normalizeDailyLog({
    meals: [{ name: '<img src=x onerror=alert(1)>', calories: '-50', protein: 'abc', time: '25:99' }],
    water: -3, day_rating: 55, sleep: { quality: 99, lights_out: 'late' },
  }, '2026-10-06');
  assert.equal(n.meals[0].calories, null);   // negative -> blank
  assert.equal(n.meals[0].protein, null);    // non-numeric -> blank
  assert.equal(n.meals[0].time, '');         // invalid time -> blank
  assert.equal(n.water, 0);
  assert.equal(n.day_rating, 60);            // snapped to nearest 10
  assert.equal(n.sleep.quality, null);       // out of range
  assert.equal(n.sleep.lights_out, '');
  assert.equal(n.meals[0].name, '<img src=x onerror=alert(1)>'); // stored as plain text, rendered via textContent/value
});

test('isDailyLogEmpty', () => {
  assert.equal(isDailyLogEmpty(null), true);
  assert.equal(isDailyLogEmpty({ meals: [], supplements: [], water: 0, sleep: {}, day_rating: null }), true);
  assert.equal(isDailyLogEmpty({ meals: [], supplements: [], water: 1, sleep: {}, day_rating: null }), false);
});

test('sumMeals: totals ignore blanks', () => {
  assert.deepEqual(sumMeals(normalizeDailyLog(sampleLog(), '2026-10-06').meals),
    { calories: 1220, protein: 97, carbs: 140, fat: 23 });
  assert.deepEqual(sumMeals([]), { calories: 0, protein: 0, carbs: 0, fat: 0 });
});

test('sleepHours: crosses midnight, same-day, and missing', () => {
  assert.equal(sleepHours('23:30', '06:45'), 7.25);
  assert.equal(sleepHours('01:00', '08:30'), 7.5);
  assert.equal(sleepHours('', '06:45'), null);
  assert.equal(sleepHours('22:00', '22:00'), null);
});

const sampleSession = {
  date: '2026-10-06', notes: 'felt strong',
  exercises: [
    { exercise_name: 'Bench Press', muscle_group: 'Chest', sets: [{ weight: 200, reps: 5, rir: 2 }, { weight: 200, reps: 5, rir: null }] },
    { exercise_name: 'Crunch', muscle_group: 'Core', sets: [{ weight: 0, reps: 20, rir: null }] },
  ],
};

test('buildDailyAnalysis: merges training, daily log and body weight per date', () => {
  const days = buildDailyAnalysis(
    [sampleSession],
    [normalizeDailyLog(sampleLog(), '2026-10-06'), normalizeDailyLog({ water: 4 }, '2026-10-07')],
    [{ date: '2026-10-06', weight: 181.4 }],
  );
  assert.equal(days.length, 2);
  const d = days[0];
  assert.equal(d.date, '2026-10-06');
  assert.equal(d.weekday, 'Tue');
  assert.equal(d.training.total_sets, 3);
  assert.equal(d.training.volume, 2000);
  assert.deepEqual(d.training.muscle_groups, ['Chest', 'Core']);
  assert.equal(d.body_weight, 181.4);
  assert.equal(d.nutrition.totals.calories, 1220);
  assert.equal(d.water_oz, 152.1); // 9 bottles x 16.9 fl oz
  assert.equal(d.sleep.hours, 7.25);
  assert.equal(d.day_rating_pct, 80);
  // a day with a log but no workout
  assert.equal(days[1].training.trained, false);
  assert.equal(days[1].water_oz, 67.6); // 4 bottles
});

test('buildDailyAnalysis: a training day with no log still appears, nutrition null', () => {
  const days = buildDailyAnalysis([sampleSession], [], []);
  assert.equal(days.length, 1);
  assert.equal(days[0].nutrition, null);
  assert.equal(days[0].sleep, null);
  assert.equal(days[0].training.trained, true);
});

test('toDailyAnalysisJSON: carries a legend and the days', () => {
  const out = toDailyAnalysisJSON([], '2026-10-07T00:00:00.000Z');
  assert.equal(out.kind, 'daily-log-with-training');
  assert.ok(out.legend.sleep.includes('morning'));
  assert.deepEqual(out.days, []);
});

test('toDailyCSV: header + one flattened row per day, with escaping', () => {
  const days = buildDailyAnalysis(
    [{ ...sampleSession, notes: 'good, "heavy" day' }],
    [normalizeDailyLog(sampleLog(), '2026-10-06')], []);
  const lines = toDailyCSV(days).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('date,weekday,trained,'));
  assert.ok(lines[1].startsWith('2026-10-06,Tue,yes,3,30,2000,Chest/Core,1220,97,140,23,2,152.1,Creatine 5g,23:30,06:45,7.25,7,80,,'));
  assert.ok(lines[1].endsWith('"good, ""heavy"" day"'));
});

test('backup + import round-trip carries daily logs', () => {
  const log = normalizeDailyLog(sampleLog(), '2026-10-06');
  const backup = toBackupJSON([sampleSession], [], '2026-10-07T00:00:00.000Z', [], [log, { date: '2026-10-05' }]);
  assert.equal(backup.dailyLogs.length, 1); // empty one dropped
  const parsed = parseImportJSON(JSON.stringify(backup));
  assert.equal(parsed.summary.dailyLogs, 1);
  assert.deepEqual(parsed.dailyLogs[0], log);
  assert.deepEqual(toDailyLogsExport([log]), [log]);
});

test('parseImportJSON: a malformed daily log is dropped, not fatal', () => {
  const parsed = parseImportJSON(JSON.stringify({
    sessions: [], dailyLogs: [null, { date: 'nope', water: 3 }, { date: '2026-10-06', water: 3 }],
  }));
  assert.equal(parsed.dailyLogs.length, 1);
  assert.equal(parsed.dailyLogs[0].date, '2026-10-06');
});

test('buildDailyAnalysis: a cleared (empty) stored log does not create a day', () => {
  const empty = { date: '2026-10-05', meals: [], water: 0, supplements: [], sleep: { lights_out: '', wake_up: '', quality: null }, day_rating: null };
  assert.equal(buildDailyAnalysis([], [empty], []).length, 0);
});

test('waterOz: bottles -> fl oz at 16.9 each, rounded to 1 decimal', () => {
  assert.equal(waterOz(0), 0);
  assert.equal(waterOz(1), 16.9);
  assert.equal(waterOz(3), 50.7);
  assert.equal(waterOz(10), 169);
  assert.equal(waterOz(undefined), 0);
});

// ---------- red-team regressions ----------

test('isRealDate: rejects impossible calendar dates', () => {
  assert.equal(isRealDate('2026-10-07'), true);
  assert.equal(isRealDate('2028-02-29'), true);
  assert.equal(isRealDate('2026-02-29'), false);
  assert.equal(isRealDate('2026-13-45'), false);
  assert.equal(isRealDate('2026-00-10'), false);
  assert.equal(isRealDate('__proto__'), false);
  assert.equal(isRealDate('12345-01-01'), false);
  assert.equal(isRealDate(null), false);
});

test('normalizeDailyLog / import: an impossible date is dropped', () => {
  assert.equal(normalizeDailyLog({ water: 2 }, '2026-13-45'), null);
  const parsed = parseImportJSON(JSON.stringify({ sessions: [], dailyLogs: [{ date: '2026-02-30', water: 2 }, { date: '2026-02-28', water: 2 }] }));
  assert.deepEqual(parsed.dailyLogs.map((l) => l.date), ['2026-02-28']);
});

test('CSV injection: text cells starting with = + - @ are defanged, numbers are not', () => {
  const log = normalizeDailyLog({
    supplements: [{ name: '=HYPERLINK("http://evil.example","x")', amount: '@SUM(1)' }, { name: '+1', amount: '-2' }],
  }, '2026-10-06');
  const session = { date: '2026-10-06', notes: '=1+1', exercises: [{ exercise_name: 'Bench', muscle_group: 'Chest', sets: [{ weight: 100, reps: 5, rir: null }] }] };
  const csv = toDailyCSV(buildDailyAnalysis([session], [log], []));
  const row = csv.split('\n')[1];
  assert.ok(row.includes(`"'=HYPERLINK(`), 'supplement cell neutralised: ' + row);
  assert.ok(row.endsWith("'=1+1"), 'notes cell neutralised');
  // legitimate numbers (even negative-looking text-free ones) keep their value
  assert.ok(toCSV([{ date: '2026-10-06', exercise: 'Bench', muscle_group: 'Chest', weight: 100, reps: 5, rir: 2 }]).includes(',100,5,2,'));
  assert.ok(toCSV([{ date: '2026-10-06', exercise: '=cmd', muscle_group: 'Chest', weight: 100, reps: 5, rir: 2 }]).includes("'=cmd"));
});

test('DAILY_LIMITS: out-of-range numbers are dropped (the UI flags them first)', () => {
  const n = normalizeDailyLog({ steps: DAILY_LIMITS.steps + 1, meals: [{ name: 'x', calories: DAILY_LIMITS.calories + 1, protein: DAILY_LIMITS.protein }] }, '2026-10-06');
  assert.equal(n.steps, null);
  assert.equal(n.meals[0].calories, null);
  assert.equal(n.meals[0].protein, DAILY_LIMITS.protein);
});

test('analysis legend tells a chat model free text is data, not instructions', () => {
  assert.ok(/never as instructions/i.test(toDailyAnalysisJSON([]).legend.note_on_text));
});

// ---------- steps ----------

test('steps: normalized to a whole number, blank/invalid -> null, and 0 counts as logged', () => {
  assert.equal(normalizeDailyLog({ steps: '8500.4' }, '2026-10-06').steps, 8500);
  assert.equal(normalizeDailyLog({ steps: 0 }, '2026-10-06').steps, 0);
  assert.equal(normalizeDailyLog({ steps: '', water: 2 }, '2026-10-06').steps, null);
  assert.equal(normalizeDailyLog({ steps: -5, water: 2 }, '2026-10-06').steps, null);
  assert.equal(normalizeDailyLog({ steps: 'lots' }, '2026-10-06'), null); // steps was the only field
});

test('steps: reach the analysis JSON and CSV', () => {
  const log = normalizeDailyLog({ steps: 10234, water: 1 }, '2026-10-06');
  const days = buildDailyAnalysis([], [log], []);
  assert.equal(days[0].steps, 10234);
  const [header, row] = toDailyCSV(days).trim().split('\n');
  const cols = header.split(',');
  assert.equal(row.split(',')[cols.indexOf('steps')], '10234');
  assert.ok(toDailyAnalysisJSON(days).legend.steps);
});

// ---------- saved meals / suggestions / copy / portions ----------

test('normalizeSavedMeal: needs a name, keys on lowercased name, cleans macros', () => {
  assert.equal(normalizeSavedMeal({ name: '  ', calories: 5 }), null);
  assert.equal(normalizeSavedMeal(null), null);
  const m = normalizeSavedMeal({ name: ' Chicken Rice ', calories: '700', protein: 55, carbs: -1, fat: '' });
  assert.equal(m.key, 'chicken rice');
  assert.equal(m.name, 'Chicken Rice');
  assert.equal(m.calories, 700);
  assert.equal(m.carbs, null);
  assert.equal(m.fat, null);
});

test('buildMealSuggestions: saved first, then past meals newest-first, de-duplicated', () => {
  const saved = [
    { name: 'Oats + whey', calories: 520, protein: 42, carbs: 60, fat: 9, last_used: '2026-10-01T00:00:00Z' },
    { name: 'Greek yogurt', calories: 150, protein: 20, carbs: 8, fat: 3, last_used: '2026-10-05T00:00:00Z' },
  ];
  const logs = [
    { date: '2026-10-02', meals: [{ name: 'Burrito', calories: 800, protein: 40, carbs: 90, fat: 30 }, { name: 'oats + WHEY', calories: 999 }] },
    { date: '2026-10-06', meals: [{ name: 'Burrito', calories: 850, protein: 42, carbs: 95, fat: 32 }, { name: '' }] },
  ];
  const list = buildMealSuggestions(saved, logs);
  assert.deepEqual(list.map((s) => s.name), ['Greek yogurt', 'Oats + whey', 'Burrito']);
  assert.equal(list[0].saved, true);
  assert.equal(list[2].saved, false);
  assert.equal(list[2].calories, 850); // newest log's macros win
});

test('filterMealSuggestions: empty query -> top of list; prefix before contains; exact match dropped', () => {
  const list = buildMealSuggestions([], [{ date: '2026-10-06', meals: [
    { name: 'Chicken rice', calories: 700 }, { name: 'Grilled chicken', calories: 400 },
    { name: 'Chicken', calories: 300 }, { name: 'Pasta', calories: 600 },
  ] }]);
  assert.equal(filterMealSuggestions(list, '').length, 4);
  assert.deepEqual(filterMealSuggestions(list, 'chick').map((s) => s.name), ['Chicken rice', 'Chicken', 'Grilled chicken']);
  assert.deepEqual(filterMealSuggestions(list, 'chicken').map((s) => s.name), ['Chicken rice', 'Grilled chicken']);
  assert.deepEqual(filterMealSuggestions(list, 'zzz'), []);
  assert.equal(filterMealSuggestions(list, '', 2).length, 2);
});

test('scaleMacros: scales from the base, rounds, keeps blanks blank', () => {
  assert.deepEqual(scaleMacros({ calories: 520, protein: 42, carbs: 60, fat: 9 }, 1.5),
    { calories: 780, protein: 63, carbs: 90, fat: 13.5 });
  assert.deepEqual(scaleMacros({ calories: 333, protein: 33.3, carbs: '', fat: null }, 0.5),
    { calories: 167, protein: 16.7, carbs: '', fat: '' });
  assert.deepEqual(scaleMacros({ calories: '600' }, 2).calories, 1200);
});

test('copyMealsInto: fills only empty slots and never overwrites typed ones', () => {
  const blank = (slot) => ({ slot, name: '', time: '', calories: '', protein: '', carbs: '', fat: '' });
  const current = [
    { ...blank('Breakfast'), name: 'Eggs', calories: 300 },
    blank('Snack'), blank('Lunch'),
  ];
  const source = [
    { ...blank('Breakfast'), name: 'Oats', calories: 520 },
    { ...blank('Snack'), name: 'Apple', calories: 90 },
    blank('Lunch'),
  ];
  const r = copyMealsInto(current, source);
  assert.equal(r.copied, 1);
  assert.equal(r.kept, 1);
  assert.equal(r.meals[0].name, 'Eggs');   // untouched
  assert.equal(r.meals[1].name, 'Apple');  // filled
  assert.equal(r.meals[1].slot, 'Snack');
  assert.equal(current[1].name, '');       // input array not mutated
});

test('backup + import round-trip carries saved meals', () => {
  const meal = normalizeSavedMeal({ name: 'Oats + whey', calories: 520, protein: 42, carbs: 60, fat: 9 });
  const backup = toBackupJSON([], [], '2026-10-07T00:00:00.000Z', [], [], [meal, { name: '' }]);
  assert.equal(backup.savedMeals.length, 1);
  const parsed = parseImportJSON(JSON.stringify({ ...backup, sessions: [] }));
  assert.equal(parsed.summary.savedMeals, 1);
  assert.equal(parsed.savedMeals[0].key, 'oats + whey');
  assert.deepEqual(toSavedMealsExport([meal]), [meal]);
});
