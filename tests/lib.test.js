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
