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
  assert.deepEqual(out.summary, { sessions: 1, sets: 1, bodyWeight: 0, routines: 0 });
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
