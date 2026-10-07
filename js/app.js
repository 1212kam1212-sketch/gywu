// app.js — UI wiring. Imports pure logic from lib.js and storage from db.js.

import {
  toCSV, toJSONExport, toBackupJSON, parseImportJSON, toPRHistoryCSV,
  toRoutinesExport, pickActiveRoutine, highestMilestone, nextMilestone,
  MEAL_SLOTS, waterOz, normalizeDailyLog, sumMeals, sleepHoursOf,
  buildDailyAnalysis, toDailyAnalysisJSON, toDailyCSV, toDailyLogsExport,
  normalizeSavedMeal, toSavedMealsExport, buildMealSuggestions, filterMealSuggestions,
  scaleMacros, copyMealsInto, isRealDate, DAILY_LIMITS,
} from './lib.js';
import * as db from './db.js';

const state = {
  exercises: [],
  currentExerciseId: null,
  todaySessionId: null,
  historyRangeWeeks: 52,
  volumeRangeWeeks: 8,
  exportRangeWeeks: 0,
  routines: [],
  todayExerciseIds: [],   // exercise_ids that already have a set logged today
  activeRoutineId: null,  // routine shown as the Log-tab checklist; 0 = "none for now"
  routineManuallyPicked: false, // true once the user taps a chip (stops clock auto-pick)
  expandedRoutineId: null, // which routine's editor is open on History
};

// ---------- small helpers ----------

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function rangeFromWeeks(weeks) {
  if (!weeks) return {}; // 0 / falsy = all time
  return { startDate: daysAgoStr(weeks * 7), endDate: todayStr() };
}

// Exercise names and muscle groups are free text (typed via "+ Add custom
// exercise", or arbitrary in an imported JSON file) - build the little
// colored tag with DOM methods rather than string-interpolated innerHTML,
// so an exercise/group name can never be parsed as markup.
function muscleTag(group) {
  const tag = document.createElement('span');
  tag.className = 'muscle-tag';
  tag.dataset.group = group;
  tag.textContent = group;
  return tag;
}

function setActivePreset(containerEl, btnEl) {
  containerEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
  btnEl.classList.add('active');
}

// ---------- tab switching ----------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    flushDaily(); // write any pending Daily-tab edits before leaving it
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'view-log') renderRoutineStrip();
    if (btn.dataset.view === 'view-history') {
      refreshHistory();
      refreshSessionNotesList();
      refreshExerciseEditor();
      renderRoutinesEditor();
    }
    if (btn.dataset.view === 'view-prs') refreshPRs();
    if (btn.dataset.view === 'view-volume') { refreshVolume(); refreshLifetimeStats(); }
    if (btn.dataset.view === 'view-bodyweight') refreshBodyWeight();
    if (btn.dataset.view === 'view-daily') loadDaily(daily.date);
  });
});

// ---------- exercise list / selects ----------

function populateExerciseSelect(selectEl, exercises, selectedId) {
  selectEl.innerHTML = '';
  const groups = {};
  for (const ex of exercises) {
    if (!groups[ex.muscle_group]) groups[ex.muscle_group] = [];
    groups[ex.muscle_group].push(ex);
  }
  for (const group of Object.keys(groups)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const ex of groups[group]) {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = ex.name;
      if (String(ex.id) === String(selectedId)) opt.selected = true;
      optgroup.appendChild(opt);
    }
    selectEl.appendChild(optgroup);
  }
}

async function loadExercises(selectAfterId) {
  state.exercises = await db.listExercises();
  const logSelect = document.getElementById('exercise-select');
  const historySelect = document.getElementById('history-exercise-select');
  const chosen = selectAfterId || (state.exercises[0] && state.exercises[0].id);
  populateExerciseSelect(logSelect, state.exercises, chosen);
  populateExerciseSelect(historySelect, state.exercises, chosen);
  return chosen;
}

// ---------- LOG tab ----------

document.getElementById('add-exercise-btn').addEventListener('click', () => {
  document.getElementById('add-exercise-form').classList.remove('hidden');
});
document.getElementById('cancel-new-exercise').addEventListener('click', () => {
  document.getElementById('add-exercise-form').classList.add('hidden');
});
document.getElementById('save-new-exercise').addEventListener('click', async () => {
  const name = document.getElementById('new-ex-name').value.trim();
  const group = document.getElementById('new-ex-group').value;
  if (!name) return alert('Give the exercise a name.');
  try {
    const created = await db.createExercise(name, group);
    document.getElementById('new-ex-name').value = '';
    document.getElementById('add-exercise-form').classList.add('hidden');
    await loadExercises(created.id);
    onExerciseChange();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('exercise-select').addEventListener('change', onExerciseChange);

async function onExerciseChange() {
  const select = document.getElementById('exercise-select');
  state.currentExerciseId = Number(select.value);
  const last = await db.getLastSetsForExercise(state.currentExerciseId, { excludeDate: todayStr() });
  const card = document.getElementById('last-time-card');
  if (!last) {
    card.classList.remove('hidden');
    document.getElementById('last-time-date').textContent = 'none yet';
    document.getElementById('last-time-sets').innerHTML =
      '<span class="empty-note" style="padding:0">No previous sessions logged for this exercise. If you know you have trained it before, it may have been saved under a slightly different exercise name.</span>';
  } else {
    card.classList.remove('hidden');
    document.getElementById('last-time-date').textContent = prettyDate(last.date);
    const chips = document.getElementById('last-time-sets');
    chips.innerHTML = '';
    // last.sets is already ordered by set_order, i.e. the order they were done
    last.sets.forEach((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const idx = document.createElement('span');
      idx.className = 'chip-idx';
      idx.textContent = `${i + 1}) `;
      chip.appendChild(idx);
      const rir = s.rir !== null && s.rir !== undefined ? ` @${s.rir}RIR` : '';
      chip.appendChild(document.createTextNode(`${s.weight} x ${s.reps}${rir}`));
      chips.appendChild(chip);
    });
  }
  document.getElementById('pr-banner').classList.add('hidden');
  renderRoutineStrip(); // keep the checklist's "current" marker in sync
}

async function ensureTodaySession() {
  const session = await db.getOrCreateSessionForDate(todayStr());
  state.todaySessionId = session.id;
  return session;
}

document.getElementById('add-set-btn').addEventListener('click', async () => {
  const weight = Number(document.getElementById('input-weight').value);
  const reps = Number(document.getElementById('input-reps').value);
  const rirVal = document.getElementById('input-rir').value;
  const rir = rirVal === '' ? null : Number(rirVal);

  if (!state.currentExerciseId) return alert('Pick an exercise first.');
  if (!Number.isFinite(weight) || weight < 0) return alert('Enter a valid weight.');
  if (!Number.isInteger(reps) || reps <= 0) return alert('Enter a valid rep count.');

  try {
    const session = await ensureTodaySession();
    const result = await db.addSet(session.id, state.currentExerciseId, weight, reps, rir);

    const banner = document.getElementById('pr-banner');
    banner.classList.add('hidden');
    if (result.isWeightPR || result.isE1RMPR) {
      void banner.offsetWidth; // force reflow so the glow animation replays every time
      banner.textContent = '✨ NEW PR!';
      banner.classList.remove('hidden');
    }

    document.getElementById('input-reps').value = '';
    document.getElementById('input-rir').value = '';

    await refreshTodaySession();
    startRestTimer(getPreferredRestSecs());
  } catch (err) {
    alert(err.message);
  }
});

async function refreshTodaySession() {
  const session = await ensureTodaySession();
  const detail = await db.getSessionDetail(session.id);
  const container = document.getElementById('today-session');
  container.innerHTML = '';

  if (!detail.exercises.length) {
    container.innerHTML = '<div class="empty-note">Nothing logged yet today. Add your first set above.</div>';
  } else {
    for (const ex of detail.exercises) {
      const block = document.createElement('div');
      block.className = 'exercise-block';
      const h4 = document.createElement('h4');
      h4.appendChild(document.createTextNode(ex.exercise_name + ' '));
      h4.appendChild(muscleTag(ex.muscle_group));
      block.appendChild(h4);
      for (const s of ex.sets) {
        const row = document.createElement('div');
        row.className = 'set-row';
        row.innerHTML = `<span>Set ${s.set_order}: ${s.weight} x ${s.reps}${s.rir !== null && s.rir !== undefined ? ` @${s.rir}RIR` : ''}</span>`;
        const delBtn = document.createElement('button');
        delBtn.className = 'del-btn';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async () => {
          await db.deleteSet(s.id);
          refreshTodaySession();
        });
        row.appendChild(delBtn);
        block.appendChild(row);
      }
      container.appendChild(block);
    }
  }

  document.getElementById('session-notes').value = detail.notes || '';

  // routine checklist ticks off exercises that now have a set today
  state.todayExerciseIds = detail.exercises.map((ex) => ex.exercise_id);
  renderRoutineStrip();
}

// ---------- session notes (feature 3) ----------
//
// Every notes textarea (today's, and past-session ones in History) shares
// this autosave helper: a 500ms debounce on typing, plus an immediate flush
// on blur/visibilitychange/pagehide so a note is never lost to timing if the
// tab or app closes mid-debounce. `pendingNoteSaves` tracks one in-flight
// save per textarea element, keyed with the sessionId already resolved -
// flushing is then a synchronous db.updateSessionNotes() call, no awaiting
// session lookup at exit time.

const pendingNoteSaves = new Map(); // textarea element -> { sessionId, value, timer }

function scheduleNotesSave(textareaEl, sessionId, value) {
  const existing = pendingNoteSaves.get(textareaEl);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => flushNotesSave(textareaEl), 500);
  pendingNoteSaves.set(textareaEl, { sessionId, value, timer });
}

function flushNotesSave(textareaEl) {
  const pending = pendingNoteSaves.get(textareaEl);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingNoteSaves.delete(textareaEl);
  db.updateSessionNotes(pending.sessionId, pending.value).catch((err) => {
    console.error('Failed to save session notes', err);
  });
}

function flushAllPendingNoteSaves() {
  Array.from(pendingNoteSaves.keys()).forEach(flushNotesSave);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAllPendingNoteSaves();
});
window.addEventListener('pagehide', flushAllPendingNoteSaves);

// Explicit "Save Note" button: cancels any pending debounce (so it can't be
// clobbered by a delayed autosave firing right after) and writes immediately,
// showing a confirmation in statusEl.
async function saveNotesNow(textareaEl, sessionId, statusEl) {
  const pending = pendingNoteSaves.get(textareaEl);
  if (pending) {
    clearTimeout(pending.timer);
    pendingNoteSaves.delete(textareaEl);
  }
  try {
    await db.updateSessionNotes(sessionId, textareaEl.value);
    if (statusEl) {
      statusEl.textContent = 'Saved.';
      clearTimeout(statusEl._clearTimer);
      statusEl._clearTimer = setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }
  } catch (err) {
    console.error('Failed to save session notes', err);
    if (statusEl) statusEl.textContent = 'Could not save - try again.';
  }
}

const todayNotesEl = document.getElementById('session-notes');
todayNotesEl.addEventListener('input', async (e) => {
  const value = e.target.value;
  const sessionId = state.todaySessionId ?? (await ensureTodaySession()).id;
  scheduleNotesSave(todayNotesEl, sessionId, value);
});
todayNotesEl.addEventListener('blur', () => flushNotesSave(todayNotesEl));

document.getElementById('session-notes-save').addEventListener('click', async () => {
  const sessionId = state.todaySessionId ?? (await ensureTodaySession()).id;
  await saveNotesNow(todayNotesEl, sessionId, document.getElementById('session-notes-status'));
});

// ---------- rest timer (feature 1: inline on Log screen only) ----------

const REST_SECS_KEY = 'gywu_last_rest_secs';
const restTimer = { intervalId: null, doneTimeoutId: null, endTime: 0, totalSecs: 0 };

function getPreferredRestSecs() {
  return Number(localStorage.getItem(REST_SECS_KEY)) || 120;
}
function setPreferredRestSecs(secs) {
  localStorage.setItem(REST_SECS_KEY, String(secs));
}

function formatMMSS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function startRestTimer(secs) {
  secs = Math.max(1, Math.round(secs));
  setPreferredRestSecs(secs);
  clearInterval(restTimer.intervalId);
  clearTimeout(restTimer.doneTimeoutId); // a pending "done" reset from a prior countdown must not cancel this new one
  restTimer.totalSecs = secs;
  restTimer.endTime = Date.now() + secs * 1000;

  const bar = document.getElementById('rest-timer-bar');
  bar.classList.remove('done');
  document.getElementById('rest-timer-presets').classList.add('hidden');
  document.getElementById('rest-timer-active').classList.remove('hidden');

  tickRestTimer();
  restTimer.intervalId = setInterval(tickRestTimer, 250);
}

function tickRestTimer() {
  const remainingMs = restTimer.endTime - Date.now();
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
  const bar = document.getElementById('rest-timer-bar');
  const display = document.getElementById('rest-timer-display');
  const progressBar = document.getElementById('rest-timer-progress-bar');

  display.textContent = formatMMSS(remaining);
  const pct = restTimer.totalSecs > 0 ? (remaining / restTimer.totalSecs) * 100 : 0;
  progressBar.style.width = `${Math.max(0, pct)}%`;

  if (remaining <= 3 && remaining > 0) {
    bar.classList.add('critical');
  } else {
    bar.classList.remove('critical');
  }

  if (remaining <= 0) {
    clearInterval(restTimer.intervalId);
    bar.classList.remove('critical');
    bar.classList.add('done');
    playRestDoneChime();
    restTimer.doneTimeoutId = setTimeout(() => {
      bar.classList.remove('done');
      cancelRestTimer();
    }, 1800);
  }
}

function cancelRestTimer() {
  clearInterval(restTimer.intervalId);
  clearTimeout(restTimer.doneTimeoutId);
  document.getElementById('rest-timer-active').classList.add('hidden');
  document.getElementById('rest-timer-presets').classList.remove('hidden');
  document.getElementById('rest-timer-bar').classList.remove('critical', 'done');
}

function playRestDoneChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // audio not available - visual pulse alone still satisfies the alert requirement
  }
}

document.querySelectorAll('.rest-preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => startRestTimer(Number(btn.dataset.secs)));
});
document.getElementById('rest-timer-custom-start').addEventListener('click', () => {
  const val = Number(document.getElementById('rest-timer-custom').value);
  if (!Number.isFinite(val) || val <= 0) return;
  startRestTimer(val);
});
document.getElementById('rest-timer-cancel').addEventListener('click', cancelRestTimer);

// ---------- HISTORY tab ----------

document.getElementById('history-exercise-select').addEventListener('change', refreshHistory);
document.querySelectorAll('#history-range-presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setActivePreset(document.getElementById('history-range-presets'), btn);
    state.historyRangeWeeks = Number(btn.dataset.weeks);
    refreshHistory();
  });
});

async function refreshHistory() {
  const select = document.getElementById('history-exercise-select');
  const exerciseId = Number(select.value);
  if (!exerciseId) return;
  const rows = await db.getExerciseHistory(exerciseId, rangeFromWeeks(state.historyRangeWeeks));
  drawHistoryChart(rows);
  renderHistoryTable(rows);
}

function drawHistoryChart(rows) {
  const canvas = document.getElementById('history-chart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!rows.length) {
    ctx.fillStyle = '#8a8f98';
    ctx.font = '14px sans-serif';
    ctx.fillText('No sets logged yet in this range.', 16, H / 2);
    return;
  }

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { weight: 0, e1rm: 0 });
    const b = byDate.get(r.date);
    b.weight = Math.max(b.weight, r.weight);
    b.e1rm = Math.max(b.e1rm, r.e1rm);
  }
  const dates = Array.from(byDate.keys()).sort();
  const points = dates.map((d) => byDate.get(d));

  const padding = { top: 16, right: 16, bottom: 26, left: 42 };
  const plotW = W - padding.left - padding.right;
  const plotH = H - padding.top - padding.bottom;

  const allVals = points.flatMap((p) => [p.weight, p.e1rm]);
  const maxVal = Math.max(...allVals) * 1.1 || 1;
  const minVal = 0;

  function x(i) {
    return padding.left + (dates.length === 1 ? plotW / 2 : (i / (dates.length - 1)) * plotW);
  }
  function y(v) {
    return padding.top + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;
  }

  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotH);
  ctx.lineTo(padding.left + plotW, padding.top + plotH);
  ctx.stroke();

  ctx.fillStyle = '#8a8f98';
  ctx.font = '11px sans-serif';
  ctx.fillText(Math.round(maxVal).toString(), 4, padding.top + 10);
  ctx.fillText('0', 4, padding.top + plotH);

  function drawLine(key, color) {
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = x(i), py = y(p[key]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
    points.forEach((p, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x(i), y(p[key]), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawLine('weight', '#ff1744');
  drawLine('e1rm', '#aeff00');

  ctx.fillStyle = '#8a8f98';
  ctx.font = '11px sans-serif';
  ctx.fillText(prettyDate(dates[0]), padding.left, H - 8);
  if (dates.length > 1) {
    const lastLabel = prettyDate(dates[dates.length - 1]);
    const textWidth = ctx.measureText(lastLabel).width;
    ctx.fillText(lastLabel, padding.left + plotW - textWidth, H - 8);
  }
}

function renderHistoryTable(rows) {
  const container = document.getElementById('history-table');
  if (!rows.length) {
    container.innerHTML = '<div class="empty-note">No sets logged yet in this range.</div>';
    return;
  }
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : -1));
  let html = '<table><thead><tr><th>Date</th><th>Weight</th><th>Reps</th><th>RIR</th><th>Est. 1RM</th></tr></thead><tbody>';
  for (const r of sorted) {
    html += `<tr><td>${prettyDate(r.date)}</td><td>${r.weight}</td><td>${r.reps}</td><td>${r.rir ?? '-'}</td><td>${r.e1rm}</td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

// Past-session notes: browse recent sessions and view/edit notes for any of
// them, not just today's. Uses the existing listSessions()/getSessionDetail()/
// updateSessionNotes() - no new data access, same autosave helper as today's
// notes textarea (debounce + blur/visibilitychange/pagehide flush).
async function refreshSessionNotesList() {
  const sessions = await db.listSessions({ limit: 30 });
  const container = document.getElementById('session-notes-list');
  container.innerHTML = '';

  if (!sessions.length) {
    container.innerHTML = '<div class="empty-note">No sessions logged yet.</div>';
    return;
  }

  for (const session of sessions) {
    const item = document.createElement('div');
    item.className = 'session-notes-item';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'session-notes-toggle';
    const setLabel = `${session.set_count} set${session.set_count === 1 ? '' : 's'}`;
    toggle.innerHTML = `<span>${prettyDate(session.date)}</span><span class="session-notes-summary">${setLabel}${session.notes ? ' · has notes' : ''}</span>`;

    const body = document.createElement('div');
    body.className = 'session-notes-body hidden';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Session notes...';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'blue full-width';
    saveBtn.textContent = 'Save Note';
    const status = document.createElement('div');
    status.className = 'notes-save-status';
    body.appendChild(textarea);
    body.appendChild(saveBtn);
    body.appendChild(status);

    let loaded = false;
    toggle.addEventListener('click', async () => {
      const opening = body.classList.contains('hidden');
      if (opening && !loaded) {
        const detail = await db.getSessionDetail(session.id);
        textarea.value = (detail && detail.notes) || '';
        loaded = true;
      }
      body.classList.toggle('hidden');
    });

    textarea.addEventListener('input', () => {
      scheduleNotesSave(textarea, session.id, textarea.value);
    });
    textarea.addEventListener('blur', () => flushNotesSave(textarea));
    saveBtn.addEventListener('click', () => saveNotesNow(textarea, session.id, status));

    item.appendChild(toggle);
    item.appendChild(body);
    container.appendChild(item);
  }
}

// ---------- Edit exercises (History tab) ----------
//
// Rename fixes typos; merge combines two entries when the same lift got
// logged under two names (e.g. "Incline DB Press" vs "Incline Dumbbell
// Press"), so the "Last time" comparison and history aren't split. Uses
// db.renameExercise / db.mergeExercises - both keep every set.

function populatePlainExerciseSelect(selectEl, exercises, selectedId) {
  selectEl.innerHTML = '';
  for (const ex of exercises) {
    const opt = document.createElement('option');
    opt.value = ex.id;
    opt.textContent = `${ex.name} (${ex.muscle_group})`;
    if (String(ex.id) === String(selectedId)) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function syncEditExerciseFields() {
  const id = Number(document.getElementById('edit-ex-select').value);
  const ex = state.exercises.find((e) => e.id === id);
  if (!ex) return;
  document.getElementById('edit-ex-name').value = ex.name;
  const groupSel = document.getElementById('edit-ex-group');
  const hasOption = Array.from(groupSel.options).some((o) => o.value === ex.muscle_group);
  groupSel.value = hasOption ? ex.muscle_group : 'Other';
}

function refreshExerciseEditor() {
  const list = state.exercises;
  const editSel = document.getElementById('edit-ex-select');
  const prevEdit = editSel.value;
  populatePlainExerciseSelect(editSel, list, prevEdit);
  populatePlainExerciseSelect(document.getElementById('merge-from-select'), list);
  populatePlainExerciseSelect(document.getElementById('merge-into-select'), list);
  syncEditExerciseFields();
}

document.getElementById('edit-ex-select').addEventListener('change', syncEditExerciseFields);

document.getElementById('edit-ex-rename-btn').addEventListener('click', async () => {
  const status = document.getElementById('edit-ex-status');
  status.classList.remove('error');
  const id = Number(document.getElementById('edit-ex-select').value);
  const name = document.getElementById('edit-ex-name').value.trim();
  const group = document.getElementById('edit-ex-group').value;
  if (!id) return;
  if (!name) {
    status.classList.add('error');
    status.textContent = 'Enter a name.';
    return;
  }
  try {
    await db.renameExercise(id, name, group);
    const keep = state.currentExerciseId;
    await loadExercises(keep);
    document.getElementById('exercise-select').value = keep;
    document.getElementById('history-exercise-select').value = keep;
    refreshExerciseEditor();
    status.textContent = 'Renamed.';
    clearTimeout(status._t);
    status._t = setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    status.classList.add('error');
    status.textContent = err.message;
  }
});

let mergeArmed = false;
let mergeArmTimer;
document.getElementById('merge-ex-btn').addEventListener('click', async () => {
  const status = document.getElementById('merge-ex-status');
  status.classList.remove('error');
  const btn = document.getElementById('merge-ex-btn');
  const fromId = Number(document.getElementById('merge-from-select').value);
  const intoId = Number(document.getElementById('merge-into-select').value);
  if (!fromId || !intoId || fromId === intoId) {
    status.classList.add('error');
    status.textContent = 'Pick two different exercises.';
    return;
  }
  const fromEx = state.exercises.find((e) => e.id === fromId);
  const intoEx = state.exercises.find((e) => e.id === intoId);

  // Two-tap confirm instead of confirm() - some installed-PWA contexts
  // suppress the dialog, which would make Merge silently do nothing.
  if (!mergeArmed) {
    const n = await db.countSetsForExercise(fromId);
    mergeArmed = true;
    btn.textContent = `Tap again: move ${n} set${n === 1 ? '' : 's'} & delete "${fromEx.name}"`;
    btn.classList.add('danger-armed');
    clearTimeout(mergeArmTimer);
    mergeArmTimer = setTimeout(() => {
      mergeArmed = false;
      btn.textContent = 'Merge';
      btn.classList.remove('danger-armed');
    }, 5000);
    return;
  }
  clearTimeout(mergeArmTimer);
  mergeArmed = false;
  btn.classList.remove('danger-armed');
  btn.textContent = 'Merge';

  btn.disabled = true;
  status.textContent = 'Merging...';
  try {
    const r = await db.mergeExercises(fromId, intoId);
    const keep = state.currentExerciseId === fromId ? intoId : state.currentExerciseId;
    state.currentExerciseId = keep;
    await loadExercises(keep);
    document.getElementById('exercise-select').value = keep;
    document.getElementById('history-exercise-select').value = keep;
    refreshExerciseEditor();
    await onExerciseChange();
    await refreshHistory();
    status.textContent =
      `Merged - ${r.movedCount} set${r.movedCount === 1 ? '' : 's'} moved across ` +
      `${r.sessionsAffected} session${r.sessionsAffected === 1 ? '' : 's'}.`;
  } catch (err) {
    status.classList.add('error');
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- routines ----------
//
// A routine is an ordered exercise list tagged with a weekday and (for
// two-a-days) a morning/evening slot. It holds NO training data. On the
// Log tab it renders as a checklist strip (renderRoutineStrip): tapping an
// item just selects that exercise in the picker you already use, and items
// tick off as sets get logged. Editing lives on the History tab
// (renderRoutinesEditor). See db.js for storage + the v2 upgrade.

const DAY_FULL = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};
const TIME_FULL = { am: 'Morning', pm: 'Evening' };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadRoutines() {
  state.routines = await db.listRoutines();
}

// ----- Log-tab strip -----

function renderRoutineStrip() {
  const strip = document.getElementById('routine-strip');
  const chipsEl = document.getElementById('routine-strip-chips');
  const checklistEl = document.getElementById('routine-strip-checklist');
  const dayEl = document.getElementById('routine-strip-day');
  const clearBtn = document.getElementById('routine-strip-clear');

  chipsEl.innerHTML = '';
  checklistEl.innerHTML = '';
  clearBtn.classList.add('hidden');

  if (!state.routines.length) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');

  const todayLabel = db.todayDayLabel();
  const todays = state.routines.filter((r) => r.day === todayLabel);
  const others = state.routines.filter((r) => r.day !== todayLabel);

  // Until the user taps a chip themselves, the strip follows the clock:
  // today's routine whose time tag matches morning/evening. After a manual
  // pick that choice sticks; the strip's x sets activeRoutineId to 0
  // ("none for now") without auto-picking again.
  let active = null;
  if (state.activeRoutineId !== 0) {
    active = state.routines.find((r) => r.id === state.activeRoutineId) || null;
    if (!state.routineManuallyPicked || !active) {
      active = pickActiveRoutine(todays, new Date().getHours()) || active;
      state.activeRoutineId = active ? active.id : null;
    }
  }

  dayEl.textContent = todays.length
    ? `Today · ${todayLabel}`
    : `Today · ${todayLabel} · no routine set — tap one to use it`;

  const mkChip = (r, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'routine-chip' + cls;
    b.textContent = r.time ? `${r.name} · ${TIME_FULL[r.time]}` : r.name;
    b.addEventListener('click', () => activateRoutine(r.id));
    return b;
  };
  for (const r of todays) {
    chipsEl.appendChild(mkChip(r, active && r.id === active.id ? ' active' : ''));
  }
  // routine that's active but isn't one of today's (a manual pick) shows too
  if (active && !todays.some((r) => r.id === active.id)) {
    chipsEl.appendChild(mkChip(active, ' active'));
  }
  for (const r of others) {
    if (active && r.id === active.id) continue;
    chipsEl.appendChild(mkChip(r, ' other'));
  }

  if (!active) {
    checklistEl.innerHTML =
      '<span class="empty-note" style="padding:0">Tap a routine above to load it as a checklist.</span>';
    return;
  }
  clearBtn.classList.remove('hidden');

  const selVal = document.getElementById('exercise-select').value;
  active.exercises.forEach((ex, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'routine-check-item';
    const done = state.todayExerciseIds.includes(ex.id);
    if (done) item.classList.add('done');
    if (String(ex.id) === String(selVal)) item.classList.add('current');
    const mark = document.createElement('span');
    mark.className = 'rci-mark';
    mark.textContent = done ? '✓' : `${i + 1})`;
    item.appendChild(mark);
    item.appendChild(document.createTextNode(ex.name));
    if (ex.missing) {
      item.disabled = true;
      item.classList.add('missing');
    } else {
      item.addEventListener('click', () => selectRoutineExercise(ex.id));
    }
    checklistEl.appendChild(item);
  });
}

function activateRoutine(id) {
  state.activeRoutineId = id;
  state.routineManuallyPicked = true;
  renderRoutineStrip();
}

function selectRoutineExercise(exId) {
  const sel = document.getElementById('exercise-select');
  sel.value = String(exId);
  onExerciseChange();
  document.getElementById('input-weight').focus();
}

document.getElementById('routine-strip-clear').addEventListener('click', () => {
  state.activeRoutineId = 0; // "none for now" - chips stay so you can re-pick
  state.routineManuallyPicked = true;
  renderRoutineStrip();
});

// ----- History-tab editor -----

function setRoutineStatus(msg, isErr) {
  const el = document.getElementById('routine-status');
  el.classList.toggle('error', !!isErr);
  el.textContent = msg || '';
  clearTimeout(el._t);
  if (msg) el._t = setTimeout(() => { el.textContent = ''; el.classList.remove('error'); }, 3000);
}

function routineSummary(r) {
  const bits = [];
  if (r.day) bits.push(DAY_FULL[r.day]);
  if (r.time) bits.push(TIME_FULL[r.time]);
  bits.push(`${r.exercises.length} exercise${r.exercises.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

function fieldLabel(text) {
  const l = document.createElement('label');
  l.className = 'field-label';
  l.textContent = text;
  return l;
}

function renderRoutinesEditor() {
  const list = document.getElementById('routines-list');
  list.innerHTML = '';
  if (!state.routines.length) {
    list.innerHTML = '<div class="empty-note" style="text-align:left;padding:0 0 10px;">No routines yet.</div>';
    return;
  }
  for (const r of state.routines) list.appendChild(buildRoutineEditorItem(r));
}

function buildRoutineEditorItem(r) {
  const item = document.createElement('div');
  item.className = 'routine-item';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'routine-item-toggle';
  toggle.innerHTML =
    `<span>${esc(r.name)}</span><span class="routine-item-summary">${esc(routineSummary(r))}</span>`;
  toggle.addEventListener('click', () => {
    state.expandedRoutineId = state.expandedRoutineId === r.id ? null : r.id;
    renderRoutinesEditor();
  });
  item.appendChild(toggle);
  if (state.expandedRoutineId !== r.id) return item;

  const body = document.createElement('div');
  body.className = 'routine-item-body';

  // name
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = r.name;
  const commitName = async () => {
    const v = nameInput.value.trim();
    if (!v || v === r.name) { nameInput.value = r.name; return; }
    try {
      await db.updateRoutine(r.id, { name: v });
      await loadRoutines();
      renderRoutinesEditor();
      renderRoutineStrip();
    } catch (err) {
      setRoutineStatus(err.message, true);
      nameInput.value = r.name;
    }
  };
  nameInput.addEventListener('blur', commitName);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  // day
  const daySel = document.createElement('select');
  daySel.innerHTML =
    '<option value="">Any day</option>' +
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      .map((d) => `<option value="${d}"${r.day === d ? ' selected' : ''}>${DAY_FULL[d]}</option>`)
      .join('');
  daySel.addEventListener('change', async () => {
    await db.updateRoutine(r.id, { day: daySel.value || null });
    await loadRoutines();
    renderRoutinesEditor();
    renderRoutineStrip();
  });

  // time of day
  const timeSel = document.createElement('select');
  timeSel.innerHTML =
    '<option value="">Any time</option>' +
    `<option value="am"${r.time === 'am' ? ' selected' : ''}>Morning</option>` +
    `<option value="pm"${r.time === 'pm' ? ' selected' : ''}>Evening</option>`;
  timeSel.addEventListener('change', async () => {
    await db.updateRoutine(r.id, { time: timeSel.value || null });
    await loadRoutines();
    renderRoutinesEditor();
    renderRoutineStrip();
  });

  // exercise rows
  const exList = document.createElement('div');
  exList.className = 'routine-ex-list';
  r.exercises.forEach((ex, i) => {
    const row = document.createElement('div');
    row.className = 'routine-ex-row';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'routine-ex-btn';
    up.textContent = '▲';
    up.disabled = i === 0;
    up.addEventListener('click', () => reorderRoutineExercise(r, i, i - 1));

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'routine-ex-btn';
    down.textContent = '▼';
    down.disabled = i === r.exercises.length - 1;
    down.addEventListener('click', () => reorderRoutineExercise(r, i, i + 1));

    const nm = document.createElement('span');
    nm.className = 'routine-ex-name' + (ex.missing ? ' missing' : '');
    nm.textContent = `${i + 1}. ${ex.name}`;

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'del-btn';
    rm.textContent = '✕';
    rm.addEventListener('click', () => removeRoutineExercise(r, i));

    row.append(up, down, nm, rm);
    exList.appendChild(row);
  });

  // add exercise
  const addSel = document.createElement('select');
  addSel.innerHTML =
    '<option value="">Add an exercise…</option>' +
    state.exercises
      .map((e) => `<option value="${e.id}">${esc(e.name)} (${esc(e.muscle_group)})</option>`)
      .join('');
  addSel.addEventListener('change', async () => {
    if (addSel.value) await addRoutineExercise(r, Number(addSel.value));
  });

  // actions
  const actions = document.createElement('div');
  actions.className = 'routine-item-actions';
  const dupBtn = document.createElement('button');
  dupBtn.type = 'button';
  dupBtn.className = 'secondary';
  dupBtn.textContent = 'Duplicate';
  dupBtn.addEventListener('click', async () => {
    const { id, name } = await db.duplicateRoutine(r.id);
    await loadRoutines();
    state.expandedRoutineId = id;
    renderRoutinesEditor();
    renderRoutineStrip();
    setRoutineStatus(`Photocopied to "${name}" — edit the copy freely, the original is untouched.`);
  });
  // Inline two-tap delete - no confirm() dialog, which some installed-PWA
  // contexts silently suppress (that's the "Delete does nothing" bug).
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'secondary';
  delBtn.textContent = 'Delete';
  let armed = false;
  let armTimer;
  delBtn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      delBtn.textContent = 'Tap again to delete';
      delBtn.classList.add('danger-armed');
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = false;
        delBtn.textContent = 'Delete';
        delBtn.classList.remove('danger-armed');
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    try {
      await db.deleteRoutine(r.id);
      if (state.activeRoutineId === r.id) state.activeRoutineId = null;
      if (state.expandedRoutineId === r.id) state.expandedRoutineId = null;
      await loadRoutines();
      renderRoutinesEditor();
      renderRoutineStrip();
      setRoutineStatus('Deleted. Your logged workouts are not affected.');
    } catch (err) {
      setRoutineStatus(err.message, true);
    }
  });
  actions.append(dupBtn, delBtn);

  body.append(
    fieldLabel('Name'), nameInput,
    fieldLabel('Day'), daySel,
    fieldLabel('Time of day (for two-a-days)'), timeSel,
    fieldLabel('Exercises — in order'), exList, addSel,
    actions
  );
  item.appendChild(body);
  return item;
}

function routineExerciseIds(r) {
  return r.exercises.map((e) => e.id);
}

async function persistRoutineExercises(r, ids) {
  try {
    await db.updateRoutine(r.id, { exercise_ids: ids });
    await loadRoutines();
    renderRoutinesEditor();
    renderRoutineStrip();
  } catch (err) {
    setRoutineStatus(err.message, true);
  }
}

async function reorderRoutineExercise(r, from, to) {
  const ids = routineExerciseIds(r);
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  await persistRoutineExercises(r, ids);
}

async function removeRoutineExercise(r, i) {
  const ids = routineExerciseIds(r);
  ids.splice(i, 1);
  await persistRoutineExercises(r, ids);
}

async function addRoutineExercise(r, exId) {
  const ids = routineExerciseIds(r);
  if (ids.includes(exId)) {
    setRoutineStatus('That exercise is already in this routine.');
    return;
  }
  ids.push(exId);
  await persistRoutineExercises(r, ids);
}

document.getElementById('routine-new-btn').addEventListener('click', async () => {
  const names = new Set(state.routines.map((r) => r.name));
  let name = 'New routine';
  let n = 2;
  while (names.has(name)) name = `New routine ${n++}`;
  try {
    const id = await db.createRoutine({ name, day: null, time: null, exercise_ids: [] });
    await loadRoutines();
    state.expandedRoutineId = id;
    renderRoutinesEditor();
    renderRoutineStrip();
    setRoutineStatus('Created — set its day, time, and exercises below.');
  } catch (err) {
    setRoutineStatus(err.message, true);
  }
});

// ---------- PRS tab ----------

async function refreshPRs() {
  const [prs, history] = await Promise.all([db.getPRs(), db.getPRHistory()]);
  const milestonesById = new Map(history.map((h) => [h.exercise_id, h.milestones]));
  const container = document.getElementById('prs-list');
  container.innerHTML = '';

  if (!prs.length) {
    container.innerHTML = '<div class="empty-note">Log some sets to start tracking PRs.</div>';
    return;
  }

  for (const p of prs) {
    const card = document.createElement('div');
    card.className = 'pr-card';
    const h4 = document.createElement('h4');
    h4.appendChild(document.createTextNode(p.exercise_name + ' '));
    h4.appendChild(muscleTag(p.muscle_group));
    const line1 = document.createElement('div');
    line1.className = 'pr-line';
    line1.textContent =
      `Heaviest set: ${p.best_weight.weight} x ${p.best_weight.reps} on ${prettyDate(p.best_weight.date)}`;
    const line2 = document.createElement('div');
    line2.className = 'pr-line';
    line2.textContent =
      `Best est. 1RM: ${p.best_e1rm.e1rm} (from ${p.best_e1rm.weight} x ${p.best_e1rm.reps} on ${prettyDate(p.best_e1rm.date)})`;
    card.append(h4, line1, line2);

    const milestones = milestonesById.get(p.exercise_id) || [];
    if (milestones.length > 1) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'pr-history-toggle';
      const label = (open) => `${open ? '▾' : '▸'} Progression (${milestones.length} milestones)`;
      toggle.textContent = label(false);

      const body = document.createElement('div');
      body.className = 'pr-history-body hidden';
      body.innerHTML = renderMilestonesTable(milestones);

      toggle.addEventListener('click', () => {
        const open = body.classList.toggle('hidden') === false;
        toggle.textContent = label(open);
      });
      card.appendChild(toggle);
      card.appendChild(body);
    }
    container.appendChild(card);
  }
}

function renderMilestonesTable(milestones) {
  let html = '<table><thead><tr><th>Date</th><th>Set</th><th>Est. 1RM</th><th>Record</th></tr></thead><tbody>';
  for (const m of [...milestones].reverse()) {
    const cls = m.isWeightPR && m.isE1RMPR ? 'rec-both' : m.isWeightPR ? 'rec-weight' : 'rec-e1rm';
    const tag = m.isWeightPR && m.isE1RMPR ? 'weight + 1RM' : m.isWeightPR ? 'weight' : '1RM';
    const rir = m.rir !== null && m.rir !== undefined ? ` @${m.rir}RIR` : '';
    html += `<tr><td>${prettyDate(m.date)}</td><td>${m.weight} x ${m.reps}${rir}</td><td>${m.e1rm}</td><td class="${cls}">${tag}</td></tr>`;
  }
  html += '</tbody></table>';
  return html;
}

// ---------- lifetime stats (Volume tab) ----------
//
// Total weight moved, total sets, total reps, and the streak are all
// computed live from sets you've already logged (db.getLifetimeStats /
// db.getCurrentStreak) - nothing here is a separately-stored counter, so
// your full history counts from the moment this ships, nothing starts at
// zero, and no schema change was needed for any of it. The flip-clock
// reveal plays every time this tab is opened, on purpose - it's meant to
// be seen, not just to exist.

const reducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function buildTonnageDigits(total) {
  const wrap = document.getElementById('tonnage-flip');
  wrap.innerHTML = '';
  const str = Math.round(total).toLocaleString('en-US');
  const digitEls = [];
  for (const ch of str) {
    if (ch === ',') {
      const comma = document.createElement('span');
      comma.className = 'flip-comma';
      comma.textContent = ',';
      wrap.appendChild(comma);
    } else {
      const d = document.createElement('div');
      d.className = 'flip-digit';
      d.textContent = reducedMotion() ? ch : '0';
      d.dataset.final = ch;
      wrap.appendChild(d);
      digitEls.push(d);
    }
  }
  return digitEls;
}

function restartFlip(el) {
  el.classList.remove('flipping');
  void el.offsetWidth; // force reflow so the animation replays
  el.classList.add('flipping');
}

function flipDigitTo(el, finalDigit, extraSpins, startDelay) {
  if (reducedMotion()) {
    el.textContent = finalDigit;
    return;
  }
  const seq = [];
  for (let i = 0; i < extraSpins; i++) seq.push(String(Math.floor(Math.random() * 10)));
  seq.push(finalDigit);
  let step = 0;
  function run() {
    if (step >= seq.length) return;
    const current = step; // snapshot now - the timeout must not read the live, later `step`
    restartFlip(el);
    setTimeout(() => { el.textContent = seq[current]; }, 140);
    step++;
    setTimeout(run, 280);
  }
  setTimeout(run, startDelay);
}

function countUpNumber(el, target, duration) {
  if (reducedMotion()) {
    el.textContent = target.toLocaleString('en-US');
    return;
  }
  let start = null;
  function tick(ts) {
    if (start === null) start = ts;
    const p = Math.min(1, (ts - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(eased * target).toLocaleString('en-US');
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function refreshLifetimeStats() {
  const [stats, streak] = await Promise.all([db.getLifetimeStats(), db.getCurrentStreak()]);

  const digits = buildTonnageDigits(stats.totalWeight);
  digits.forEach((el, idxFromLeft) => {
    const idxFromRight = digits.length - 1 - idxFromLeft;
    const extraSpins = idxFromRight === 0 ? 3 : idxFromRight === 1 ? 2 : idxFromRight === 2 ? 1 : 0;
    flipDigitTo(el, el.dataset.final, extraSpins, idxFromLeft * 60);
  });

  countUpNumber(document.getElementById('stat-sets'), stats.totalSets, 900);
  countUpNumber(document.getElementById('stat-reps'), stats.totalReps, 900);
  countUpNumber(document.getElementById('stat-streak'), streak, 900);

  // Progress bar is measured from 0 lbs to the next milestone - a plain
  // "how close am I to that number" readout rather than a segment-relative
  // one between the previous and next milestone.
  const next = nextMilestone(stats.totalWeight);
  const remaining = next - stats.totalWeight;
  document.getElementById('milestone-text').textContent =
    `${Math.max(0, remaining).toLocaleString('en-US')} lbs to ${next.toLocaleString('en-US')}`;
  const fill = document.getElementById('milestone-fill');
  fill.style.width = '0%';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.width = `${Math.min(100, (stats.totalWeight / next) * 100)}%`;
    });
  });

  // Milestone celebration: only for a threshold crossed *since we last
  // checked*, and only shown on the visit where it happened - it hides
  // itself again on every other visit rather than staying up forever. The
  // very first time this ever runs, silently remember whatever milestone
  // is already behind you - it doesn't retroactively celebrate a milestone
  // you passed before this feature existed.
  const banner = document.getElementById('milestone-banner');
  banner.classList.add('hidden');
  const reached = highestMilestone(stats.totalWeight);
  const alreadyCelebrated = await db.getMeta('highestMilestoneCelebrated', null);
  if (alreadyCelebrated === null) {
    await db.setMeta('highestMilestoneCelebrated', reached);
  } else if (reached > alreadyCelebrated) {
    await db.setMeta('highestMilestoneCelebrated', reached);
    void banner.offsetWidth; // force reflow so the glow animation replays
    banner.textContent = `\u{1F3C6} Milestone: ${reached.toLocaleString('en-US')} lbs moved!`;
    banner.classList.remove('hidden');
  }
}

// ---------- VOLUME tab ----------

const MUSCLE_GROUPS = ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core'];

document.querySelectorAll('#volume-range-presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setActivePreset(document.getElementById('volume-range-presets'), btn);
    state.volumeRangeWeeks = Number(btn.dataset.weeks);
    refreshVolume();
  });
});

async function refreshVolume() {
  const weeks = await db.getWeeklyVolume(rangeFromWeeks(state.volumeRangeWeeks));
  const container = document.getElementById('volume-table');
  if (!weeks.length) {
    container.innerHTML = '<div class="empty-note">Log some sets to see weekly volume.</div>';
    return;
  }
  const recent = [...weeks].reverse();
  let html = '<table><thead><tr><th>Week of</th>' + MUSCLE_GROUPS.map((g) => `<th>${g}</th>`).join('') + '</tr></thead><tbody>';
  for (const w of recent) {
    html += `<tr><td>${prettyDate(w.week_start)}</td>` + MUSCLE_GROUPS.map((g) => `<td>${w.muscle_groups[g] || 0}</td>`).join('') + '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

// ---------- BODY WEIGHT tab (feature 2) ----------

document.getElementById('bw-date').value = todayStr();

document.getElementById('bw-save-btn').addEventListener('click', async () => {
  const date = document.getElementById('bw-date').value;
  const weight = Number(document.getElementById('bw-weight').value);
  if (!date) return alert('Pick a date.');
  if (!Number.isFinite(weight) || weight <= 0) return alert('Enter a valid weight.');
  try {
    await db.addBodyWeight(date, weight);
    document.getElementById('bw-weight').value = '';
    await refreshBodyWeight();
  } catch (err) {
    alert(err.message);
  }
});

async function refreshBodyWeight() {
  const rows = await db.listBodyWeight();
  drawBodyWeightChart(rows);
  renderBodyWeightTable(rows);
}

function drawBodyWeightChart(rows) {
  const canvas = document.getElementById('bw-chart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!rows.length) {
    ctx.fillStyle = '#8a8f98';
    ctx.font = '14px sans-serif';
    ctx.fillText('No body weight logged yet.', 16, H / 2);
    return;
  }

  const padding = { top: 16, right: 16, bottom: 26, left: 42 };
  const plotW = W - padding.left - padding.right;
  const plotH = H - padding.top - padding.bottom;

  const vals = rows.map((r) => r.weight);
  const maxVal = Math.max(...vals) * 1.05;
  const minVal = Math.min(...vals) * 0.95;
  const span = maxVal - minVal || 1;

  function x(i) {
    return padding.left + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  }
  function y(v) {
    return padding.top + plotH - ((v - minVal) / span) * plotH;
  }

  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotH);
  ctx.lineTo(padding.left + plotW, padding.top + plotH);
  ctx.stroke();

  ctx.fillStyle = '#8a8f98';
  ctx.font = '11px sans-serif';
  ctx.fillText(maxVal.toFixed(1), 4, padding.top + 10);
  ctx.fillText(minVal.toFixed(1), 4, padding.top + plotH);

  ctx.strokeStyle = '#2dd4c8';
  ctx.shadowColor = '#2dd4c8';
  ctx.shadowBlur = 6;
  ctx.lineWidth = 2;
  ctx.beginPath();
  rows.forEach((r, i) => {
    const px = x(i), py = y(r.weight);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;
  rows.forEach((r, i) => {
    ctx.fillStyle = '#2dd4c8';
    ctx.beginPath();
    ctx.arc(x(i), y(r.weight), 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#8a8f98';
  ctx.font = '11px sans-serif';
  ctx.fillText(prettyDate(rows[0].date), padding.left, H - 8);
  if (rows.length > 1) {
    const lastLabel = prettyDate(rows[rows.length - 1].date);
    const textWidth = ctx.measureText(lastLabel).width;
    ctx.fillText(lastLabel, padding.left + plotW - textWidth, H - 8);
  }
}

function renderBodyWeightTable(rows) {
  const container = document.getElementById('bw-table');
  if (!rows.length) {
    container.innerHTML = '<div class="empty-note">No body weight logged yet.</div>';
    return;
  }
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : -1));
  let html = '<table><thead><tr><th>Date</th><th>Weight</th><th></th></tr></thead><tbody>';
  for (const r of sorted) {
    html += `<tr><td>${prettyDate(r.date)}</td><td>${r.weight}</td><td><button class="del-btn" data-id="${r.id}">✕</button></td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
  container.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await db.deleteBodyWeight(Number(btn.dataset.id));
      refreshBodyWeight();
    });
  });
}

// ---------- DAILY LOG tab ----------
//
// One journal page per date: meals + macros, water, supplements, sleep, and a
// "rate your day" score, shown next to that day's workout (read-only, pulled
// from the sessions already logged). Everything autosaves a moment after the
// last keystroke; nothing here touches sessions/sets.
//
// All user-typed text is written into inputs via .value / elements via
// .textContent - never interpolated into innerHTML.

const WATER_DOTS = 10; // 10 bottles x 16.9 fl oz

const daily = {
  date: todayStr(),
  meals: [],
  water: 0,
  steps: '',
  supplements: [],
  sleep: { hours: '', quality: null },
  day_rating: null,
  savedMeals: [],   // "My meals" library rows
  suggestList: [],  // saved meals + distinct past meals, for the description box
  existed: false,   // a row for this date is already stored
  pending: false,   // edits not yet written
  timer: null,
  token: 0,         // guards against out-of-order loads when paging quickly
};

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return fmtDate(new Date(y, m - 1, d + delta));
}

function blankMeal(slot) {
  return { slot, name: '', time: '', calories: '', protein: '', carbs: '', fat: '' };
}

// Lay stored meals back onto the fixed slot list (Breakfast, Snack, Lunch,
// Snack, Dinner, Snack). Stored meals keep slot order, so match each one to the
// next slot with the same label; anything unmatched gets an extra row.
function dailyStateFromStored(stored) {
  const meals = MEAL_SLOTS.map(blankMeal);
  let from = 0;
  for (const m of (stored && stored.meals) || []) {
    let idx = -1;
    for (let i = from; i < meals.length; i++) {
      if (meals[i].slot === m.slot) { idx = i; break; }
    }
    if (idx === -1) { meals.push(blankMeal(m.slot)); idx = meals.length - 1; }
    meals[idx] = {
      slot: m.slot, name: m.name || '', time: m.time || '',
      calories: m.calories ?? '', protein: m.protein ?? '', carbs: m.carbs ?? '', fat: m.fat ?? '',
    };
    from = idx + 1;
  }
  const sl = (stored && stored.sleep) || {};
  return {
    meals,
    water: (stored && stored.water) || 0,
    steps: stored && stored.steps != null ? stored.steps : '',
    supplements: ((stored && stored.supplements) || []).map((s) => ({ name: s.name, amount: s.amount })),
    // sleepHoursOf also converts older entries saved with lights-out/wake-up times
    sleep: { hours: sleepHoursOf(sl) ?? '', quality: sl.quality ?? null },
    day_rating: stored && stored.day_rating != null ? stored.day_rating : null,
  };
}

function setDailySaved(text, ok) {
  const el = document.getElementById('daily-saved');
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}

function scheduleDailySave() {
  daily.pending = true;
  setDailySaved('Saving…');
  clearTimeout(daily.timer);
  daily.timer = setTimeout(persistDaily, 500);
}

async function persistDaily() {
  clearTimeout(daily.timer);
  daily.timer = null;
  if (!daily.pending) return;
  daily.pending = false;
  const date = daily.date;
  const normalized = normalizeDailyLog(
    { meals: daily.meals, water: daily.water, steps: daily.steps, supplements: daily.supplements, sleep: daily.sleep, day_rating: daily.day_rating },
    date
  );
  try {
    if (normalized) {
      await db.saveDailyLog(date, normalized);
      daily.existed = true;
    } else if (daily.existed) {
      // The user cleared everything: overwrite the old row with an empty one
      // so the old values don't reappear on the next load.
      await db.saveDailyLog(date, {
        date, meals: [], water: 0, steps: null, supplements: [],
        sleep: { hours: null, quality: null }, day_rating: null,
      });
    }
    setDailySaved('Saved ✓', true);
    refreshMealSuggestions().catch(() => {}); // newly typed meals become suggestions right away
  } catch (err) {
    setDailySaved('Could not save: ' + err.message);
  }
}

async function refreshMealSuggestions() {
  const [saved, logs] = await Promise.all([db.listSavedMeals(), db.listDailyLogs()]);
  daily.savedMeals = saved;
  daily.suggestList = buildMealSuggestions(saved, logs);
  renderSavedMeals();
}

async function flushDaily() {
  if (daily.pending) await persistDaily();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDaily();
});
window.addEventListener('pagehide', () => { flushDaily(); });

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Numbers outside what a day can hold are dropped on save. Flag the box in
// red as you type so that never happens silently.
function flagRange(input, key) {
  const v = input.value;
  const bad = v !== '' && !(Number(v) >= 0 && Number(v) <= DAILY_LIMITS[key]);
  input.classList.toggle('bad', bad);
  input.title = bad ? `Out of range (0–${DAILY_LIMITS[key].toLocaleString()}) - this value won't be saved` : '';
}

function updateDailyTotals() {
  const t = sumMeals(daily.meals.map((m) => ({
    calories: numOrNull(m.calories), protein: numOrNull(m.protein),
    carbs: numOrNull(m.carbs), fat: numOrNull(m.fat),
  })));
  const box = document.getElementById('daily-totals');
  box.textContent = '';
  const cells = [['Calories', t.calories], ['Protein g', t.protein], ['Carbs g', t.carbs], ['Fat g', t.fat]];
  for (const [label, val] of cells) {
    const cell = document.createElement('div');
    const v = document.createElement('div');
    v.className = 'tot-val';
    v.textContent = String(val);
    const l = document.createElement('div');
    l.className = 'tot-lbl';
    l.textContent = label;
    cell.append(v, l);
    box.appendChild(cell);
  }
}

function renderDailyMeals() {
  const host = document.getElementById('daily-meals');
  host.textContent = '';
  daily.meals.forEach((meal, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'meal';

    const head = document.createElement('div');
    head.className = 'meal-head';
    const slot = document.createElement('span');
    slot.className = 'meal-slot';
    slot.textContent = meal.slot;
    const time = document.createElement('input');
    time.type = 'time';
    time.value = meal.time;
    time.setAttribute('aria-label', meal.slot + ' time');
    time.addEventListener('input', () => { meal.time = time.value; scheduleDailySave(); });
    head.append(slot, time);

    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'What did you eat?';
    name.maxLength = 300;
    name.value = meal.name;
    name.setAttribute('aria-label', meal.slot + ' description');
    // Quick-fill: suggestions panel under the description box. Tapping one
    // fills the name and all four macros; the ×0.5/×1/×1.5/×2 chips then scale
    // them from that starting point; ★ Save adds the meal to My meals.
    const sug = document.createElement('div');
    sug.className = 'suggest hidden';
    const macroInputs = {};
    const chipBtns = [];
    let saveBtn = null;

    const paintChips = () => chipBtns.forEach((b) => b.classList.toggle('on', meal._mult === Number(b.dataset.f)));
    const paintSaveBtn = () => { if (saveBtn) saveBtn.disabled = !meal.name.trim(); };
    const hideSuggestions = () => sug.classList.add('hidden');

    function applySuggestion(s) {
      const macros = { calories: s.calories ?? '', protein: s.protein ?? '', carbs: s.carbs ?? '', fat: s.fat ?? '' };
      meal.name = s.name;
      name.value = s.name;
      Object.assign(meal, macros);
      for (const k of Object.keys(macros)) macroInputs[k].value = macros[k];
      meal._base = macros;
      meal._mult = 1;
      paintChips();
      paintSaveBtn();
      hideSuggestions();
      name.blur();
      updateDailyTotals();
      scheduleDailySave();
      if (s.saved) db.touchSavedMeal(s.key).then(refreshMealSuggestions).catch(() => {});
    }

    function showSuggestions() {
      const items = filterMealSuggestions(daily.suggestList, name.value);
      sug.textContent = '';
      if (!items.length) { hideSuggestions(); return; }
      for (const s of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'suggest-item';
        const nm = document.createElement('span');
        nm.className = 'sg-name';
        if (s.saved) {
          const star = document.createElement('span');
          star.className = 'sg-star';
          star.textContent = '★';
          nm.appendChild(star);
        }
        nm.appendChild(document.createTextNode(s.name));
        const mac = document.createElement('span');
        mac.className = 'sg-macros';
        mac.textContent = s.calories != null ? `${s.calories} cal · ${s.protein ?? '–'}P` : '';
        btn.append(nm, mac);
        // Keep focus in the input so the panel isn't dismissed before the tap lands.
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => applySuggestion(s));
        sug.appendChild(btn);
      }
      sug.classList.remove('hidden');
    }

    name.addEventListener('input', () => { meal.name = name.value; paintSaveBtn(); showSuggestions(); scheduleDailySave(); });
    name.addEventListener('focus', showSuggestions);
    name.addEventListener('blur', () => setTimeout(hideSuggestions, 250));

    const grid = document.createElement('div');
    grid.className = 'macro-grid';
    for (const [key, label] of [['calories', 'Cal'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']]) {
      const cell = document.createElement('div');
      const lab = document.createElement('label');
      lab.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.inputMode = 'decimal';
      inp.min = '0';
      inp.step = 'any';
      inp.value = meal[key];
      inp.setAttribute('aria-label', `${meal.slot} ${label}`);
      macroInputs[key] = inp;
      inp.addEventListener('input', () => {
        meal[key] = inp.value;
        meal._base = null; // hand-edited numbers become the new starting point for the portion chips
        meal._mult = null;
        flagRange(inp, key);
        paintChips();
        updateDailyTotals();
        scheduleDailySave();
      });
      cell.append(lab, inp);
      grid.appendChild(cell);
    }

    const tools = document.createElement('div');
    tools.className = 'meal-tools';
    const toolsLabel = document.createElement('span');
    toolsLabel.className = 'tools-label';
    toolsLabel.textContent = 'Portion';
    tools.appendChild(toolsLabel);
    for (const f of [0.5, 1, 1.5, 2]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'portion-btn';
      b.dataset.f = String(f);
      b.textContent = '×' + f;
      b.addEventListener('click', () => {
        if (!meal._base) meal._base = { calories: meal.calories, protein: meal.protein, carbs: meal.carbs, fat: meal.fat };
        if (!Object.values(meal._base).some((v) => v !== '' && v !== null && v !== undefined)) return;
        const scaled = scaleMacros(meal._base, f);
        Object.assign(meal, scaled);
        for (const k of Object.keys(scaled)) { macroInputs[k].value = scaled[k]; flagRange(macroInputs[k], k); }
        meal._mult = f;
        paintChips();
        updateDailyTotals();
        scheduleDailySave();
      });
      chipBtns.push(b);
      tools.appendChild(b);
    }
    saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'save-meal-btn';
    saveBtn.textContent = '★ Save';
    saveBtn.setAttribute('aria-label', 'Save to My meals');
    saveBtn.addEventListener('click', async () => {
      const n = normalizeSavedMeal({
        name: meal.name, calories: meal.calories, protein: meal.protein, carbs: meal.carbs, fat: meal.fat,
      });
      if (!n) return;
      await db.saveMeal(n);
      await refreshMealSuggestions();
      saveBtn.textContent = '★ Saved ✓';
      setTimeout(() => { saveBtn.textContent = '★ Save'; }, 1500);
    });
    tools.appendChild(saveBtn);
    paintSaveBtn();
    paintChips();

    wrap.append(head, name, sug, grid, tools);
    host.appendChild(wrap);
  });
  updateDailyTotals();
}

function paintWater() {
  document.querySelectorAll('#daily-water .water-dot').forEach((b, i) => {
    b.classList.toggle('on', i < daily.water);
  });
  document.getElementById('daily-water-label').textContent =
    daily.water ? `${waterOz(daily.water)} fl oz · ${daily.water} bottle${daily.water === 1 ? '' : 's'}` : 'None logged yet';
}

function renderDailyWater() {
  const host = document.getElementById('daily-water');
  host.textContent = '';
  for (let i = 0; i < WATER_DOTS; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'water-dot';
    b.setAttribute('aria-label', `${waterOz(i + 1)} fl oz`);
    b.addEventListener('click', () => {
      // Tapping the last filled circle steps back one, so a mis-tap is undoable.
      daily.water = daily.water === i + 1 ? i : i + 1;
      paintWater();
      scheduleDailySave();
    });
    host.appendChild(b);
  }
  paintWater();
}

function renderDailySupps() {
  const host = document.getElementById('daily-supps');
  host.textContent = '';
  if (!daily.supplements.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'None added.';
    host.appendChild(note);
    return;
  }
  daily.supplements.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'supp-row';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'supp-name';
    name.placeholder = 'Supplement';
    name.maxLength = 80;
    name.setAttribute('list', 'supp-names');
    name.value = s.name;
    name.addEventListener('input', () => { s.name = name.value; scheduleDailySave(); });
    const amt = document.createElement('input');
    amt.type = 'text';
    amt.className = 'supp-amt';
    amt.placeholder = 'Amount';
    amt.maxLength = 60;
    amt.value = s.amount;
    amt.addEventListener('input', () => { s.amount = amt.value; scheduleDailySave(); });
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove supplement');
    del.addEventListener('click', () => {
      daily.supplements.splice(i, 1);
      renderDailySupps();
      scheduleDailySave();
    });
    row.append(name, amt, del);
    host.appendChild(row);
  });
}

function paintToggleRow(containerId, current) {
  document.querySelectorAll(`#${containerId} button`).forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.value) === current);
  });
}

function renderDailyToggleRows() {
  const q = document.getElementById('sleep-quality');
  q.textContent = '';
  for (let n = 1; n <= 10; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dot-btn';
    b.dataset.value = String(n);
    b.textContent = String(n);
    b.addEventListener('click', () => {
      daily.sleep.quality = daily.sleep.quality === n ? null : n;
      paintToggleRow('sleep-quality', daily.sleep.quality);
      scheduleDailySave();
    });
    q.appendChild(b);
  }
  const r = document.getElementById('day-rating');
  r.textContent = '';
  for (let p = 10; p <= 100; p += 10) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rate-btn';
    b.dataset.value = String(p);
    b.textContent = p + '%';
    b.addEventListener('click', () => {
      daily.day_rating = daily.day_rating === p ? null : p;
      paintToggleRow('day-rating', daily.day_rating);
      scheduleDailySave();
    });
    r.appendChild(b);
  }
  paintToggleRow('sleep-quality', daily.sleep.quality);
  paintToggleRow('day-rating', daily.day_rating);
}

function renderDailyTraining(t) {
  const el = document.getElementById('daily-training');
  el.textContent = '';
  if (!t || !t.totalSets) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'No workout logged this day.';
    el.appendChild(note);
    return;
  }
  const line = document.createElement('div');
  line.className = 'daily-train-line';
  line.textContent =
    `${t.exercises.length} exercise${t.exercises.length === 1 ? '' : 's'} · ` +
    `${t.totalSets} set${t.totalSets === 1 ? '' : 's'} · ${t.volume.toLocaleString()} lb moved`;
  el.appendChild(line);
  for (const ex of t.exercises) {
    const row = document.createElement('div');
    row.className = 'daily-train-ex';
    const left = document.createElement('span');
    left.append(ex.name + ' ', muscleTag(ex.muscle_group));
    const right = document.createElement('span');
    right.className = 'muted';
    right.textContent = `${ex.sets} set${ex.sets === 1 ? '' : 's'}`;
    row.append(left, right);
    el.appendChild(row);
  }
  if (t.notes) {
    const notes = document.createElement('div');
    notes.className = 'daily-train-notes';
    notes.textContent = t.notes;
    el.appendChild(notes);
  }
}

function renderDaily() {
  document.getElementById('daily-date').value = daily.date;
  document.getElementById('sleep-hours').value = daily.sleep.hours;
  document.getElementById('daily-steps').value = daily.steps;
  renderDailyMeals();
  renderDailyWater();
  renderDailySupps();
  renderDailyToggleRows();
}

async function loadDaily(date) {
  await flushDaily();
  const token = ++daily.token;
  const [stored, training, names, savedMeals, allLogs] = await Promise.all([
    db.getDailyLog(date),
    db.getTrainingSummary(date),
    db.listSupplementNames(),
    db.listSavedMeals(),
    db.listDailyLogs(),
  ]);
  if (token !== daily.token) return; // a newer load superseded this one
  // The user may have typed while the reads above were in flight. Write that
  // out and reload, rather than overwrite it (or save it onto the wrong day).
  if (daily.pending) {
    await flushDaily();
    return loadDaily(date);
  }
  // From here to renderDaily() there is no await, so nothing can interleave:
  // state and screen switch to the new day together.
  daily.date = date;
  Object.assign(daily, dailyStateFromStored(stored));
  daily.existed = !!stored;
  daily.pending = false;
  daily.savedMeals = savedMeals;
  daily.suggestList = buildMealSuggestions(savedMeals, allLogs);
  renderSavedMeals();
  document.getElementById('copy-meals-date').value = shiftDate(date, -1);
  document.getElementById('copy-meals-note').textContent = '';
  renderDaily();
  renderDailyTraining(training);
  const list = document.getElementById('supp-names');
  list.textContent = '';
  for (const n of names) {
    const opt = document.createElement('option');
    opt.value = n;
    list.appendChild(opt);
  }
  setDailySaved(stored ? 'Saved ✓' : 'Saves automatically', !!stored);
}

// My meals list (the library behind the ★ Save buttons). Removing one is a
// two-tap confirm; it only removes the shortcut, never any logged day.
function renderSavedMeals() {
  const host = document.getElementById('saved-meals');
  host.textContent = '';
  if (!daily.savedMeals.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'Nothing saved yet.';
    host.appendChild(note);
    return;
  }
  for (const s of daily.savedMeals) {
    const row = document.createElement('div');
    row.className = 'saved-row';
    const info = document.createElement('div');
    info.className = 'saved-info';
    const nm = document.createElement('div');
    nm.className = 'saved-name';
    nm.textContent = s.name;
    const mac = document.createElement('div');
    mac.className = 'saved-macros';
    mac.textContent = `${s.calories ?? '–'} cal · ${s.protein ?? '–'}P · ${s.carbs ?? '–'}C · ${s.fat ?? '–'}F`;
    info.append(nm, mac);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Remove';
    let armed = null;
    del.addEventListener('click', async () => {
      if (!armed) {
        del.textContent = 'Sure?';
        del.classList.add('danger-armed');
        armed = setTimeout(() => { armed = null; del.textContent = 'Remove'; del.classList.remove('danger-armed'); }, 3000);
        return;
      }
      clearTimeout(armed);
      await db.deleteSavedMeal(s.key);
      await refreshMealSuggestions();
    });
    row.append(info, del);
    host.appendChild(row);
  }
}

// Copy another day's meals into today's empty slots (never overwrites a slot
// that already has something in it).
document.getElementById('copy-meals-btn').addEventListener('click', async () => {
  const note = document.getElementById('copy-meals-note');
  const from = document.getElementById('copy-meals-date').value;
  if (!from) { note.textContent = 'Pick a day to copy from.'; return; }
  if (from === daily.date) { note.textContent = 'That is the day you are on.'; return; }
  const stored = await db.getDailyLog(from);
  const source = dailyStateFromStored(stored).meals;
  const r = copyMealsInto(daily.meals, source);
  if (!r.copied && !r.kept) { note.textContent = 'No meals logged on that day.'; return; }
  if (r.copied) {
    daily.meals = r.meals;
    renderDailyMeals();
    scheduleDailySave();
  }
  note.textContent =
    `Copied ${r.copied} meal${r.copied === 1 ? '' : 's'}` +
    (r.kept ? `; kept ${r.kept} slot${r.kept === 1 ? '' : 's'} you'd already filled.` : '.');
});

document.getElementById('daily-date').addEventListener('change', (e) => {
  // Ignore cleared / out-of-range picks (e.g. a 6-digit year) and snap back.
  if (!isRealDate(e.target.value)) { e.target.value = daily.date; return; }
  loadDaily(e.target.value);
});
document.getElementById('daily-prev').addEventListener('click', () => loadDaily(shiftDate(daily.date, -1)));
document.getElementById('daily-next').addEventListener('click', () => loadDaily(shiftDate(daily.date, 1)));

document.getElementById('sleep-hours').addEventListener('input', (e) => {
  daily.sleep.hours = e.target.value;
  flagRange(e.target, 'sleep_hours');
  scheduleDailySave();
});

document.getElementById('daily-steps').addEventListener('input', (e) => {
  daily.steps = e.target.value;
  flagRange(e.target, 'steps');
  scheduleDailySave();
});

document.getElementById('supp-add').addEventListener('click', () => {
  daily.supplements.push({ name: '', amount: '' });
  renderDailySupps();
  const inputs = document.querySelectorAll('#daily-supps .supp-name');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

// Pull the previous day's supplements into today's list (skipping any already
// there), since most people take the same stack every day.
document.getElementById('supp-copy').addEventListener('click', async () => {
  const prev = await db.getDailyLog(shiftDate(daily.date, -1));
  const have = new Set(daily.supplements.map((s) => s.name.trim().toLowerCase()));
  const toAdd = ((prev && prev.supplements) || []).filter((s) => s.name && !have.has(s.name.toLowerCase()));
  if (!toAdd.length) {
    setDailySaved(prev && prev.supplements && prev.supplements.length
      ? 'Already have yesterday’s supplements.'
      : 'No supplements logged the day before.');
    return;
  }
  for (const s of toAdd) daily.supplements.push({ name: s.name, amount: s.amount });
  renderDailySupps();
  scheduleDailySave();
});

// ---------- EXPORT tab ----------

document.querySelectorAll('#export-range-presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setActivePreset(document.getElementById('export-range-presets'), btn);
    state.exportRangeWeeks = Number(btn.dataset.weeks);
  });
});

document.getElementById('export-csv-btn').addEventListener('click', async () => {
  const rows = await db.getAllSetsFlat(rangeFromWeeks(state.exportRangeWeeks));
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `forged-export-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const status = document.getElementById('export-status');
  status.textContent = `Downloaded ${rows.length} set${rows.length === 1 ? '' : 's'}.`;
});

document.getElementById('export-json-btn').addEventListener('click', async () => {
  const range = rangeFromWeeks(state.exportRangeWeeks);
  const sessions = await db.getSessionsForExport(range);
  const bodyWeight = await db.listBodyWeight(range);
  const prHistory = await db.getPRHistory(); // all-time by nature
  const routines = await db.listRoutines();
  const dailyLogs = toDailyLogsExport(await db.listDailyLogs(range));
  const data = {
    sessions: toJSONExport(sessions),
    bodyWeight: bodyWeight.map((b) => ({ date: b.date, weight: b.weight })),
    routines: toRoutinesExport(routines),
    dailyLogs,
    savedMeals: toSavedMealsExport(await db.listSavedMeals()),
    prHistory: prHistory
      .filter((h) => h.milestones.length)
      .map((h) => ({ exercise: h.exercise_name, muscle_group: h.muscle_group, milestones: h.milestones })),
  };
  const json = JSON.stringify(data, null, 2);
  const status = document.getElementById('export-status');
  const summary =
    `Copied ${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'}` +
    ` + ${data.bodyWeight.length} body-weight entr${data.bodyWeight.length === 1 ? 'y' : 'ies'}` +
    ` + ${data.routines.length} routine${data.routines.length === 1 ? '' : 's'}` +
    ` + ${data.dailyLogs.length} daily log${data.dailyLogs.length === 1 ? '' : 's'}` +
    ` + PR history for ${data.prHistory.length} exercise${data.prHistory.length === 1 ? '' : 's'} to clipboard.`;
  try {
    await navigator.clipboard.writeText(json);
    status.textContent = summary;
  } catch {
    // Clipboard API unavailable/blocked - fall back to a manual copy via textarea.
    const ta = document.createElement('textarea');
    ta.value = json;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      status.textContent = summary;
    } catch {
      status.textContent = 'Could not copy automatically - select and copy the data manually.';
    }
    document.body.removeChild(ta);
  }
});

document.getElementById('export-pr-history-btn').addEventListener('click', async () => {
  const status = document.getElementById('export-pr-status');
  status.classList.remove('error');
  try {
    const history = await db.getPRHistory();
    const csv = toPRHistoryCSV(history);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forged-pr-history-${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const rows = history.reduce((n, h) => n + h.milestones.length, 0);
    status.textContent = `Downloaded ${rows} PR milestone${rows === 1 ? '' : 's'}.`;
  } catch (err) {
    status.classList.add('error');
    status.textContent = 'Could not build the PR history: ' + err.message;
  }
});

// ---------- daily log + training export ----------

async function buildDailyExportDays() {
  const range = rangeFromWeeks(state.exportRangeWeeks);
  const [sessions, logs, bodyWeight] = await Promise.all([
    db.getSessionsForExport(range),
    db.listDailyLogs(range),
    db.listBodyWeight(range),
  ]);
  return buildDailyAnalysis(sessions, logs, bodyWeight);
}

document.getElementById('export-daily-json-btn').addEventListener('click', async () => {
  await flushDaily();
  const status = document.getElementById('export-daily-status');
  status.classList.remove('error');
  try {
    const days = await buildDailyExportDays();
    const json = JSON.stringify(toDailyAnalysisJSON(days, new Date().toISOString()), null, 2);
    const summary = `Copied ${days.length} day${days.length === 1 ? '' : 's'} to clipboard.`;
    try {
      await navigator.clipboard.writeText(json);
      status.textContent = summary;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = json;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        status.textContent = summary;
      } catch {
        status.classList.add('error');
        status.textContent = 'Could not copy automatically - use the CSV download instead.';
      }
      document.body.removeChild(ta);
    }
  } catch (err) {
    status.classList.add('error');
    status.textContent = 'Could not build the export: ' + err.message;
  }
});

document.getElementById('export-daily-csv-btn').addEventListener('click', async () => {
  await flushDaily();
  const status = document.getElementById('export-daily-status');
  status.classList.remove('error');
  try {
    const days = await buildDailyExportDays();
    const blob = new Blob([toDailyCSV(days)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forged-daily-log-${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    status.textContent = `Downloaded ${days.length} day${days.length === 1 ? '' : 's'}.`;
  } catch (err) {
    status.classList.add('error');
    status.textContent = 'Could not build the export: ' + err.message;
  }
});

// ---------- backup file download ----------

document.getElementById('backup-json-btn').addEventListener('click', async () => {
  const status = document.getElementById('backup-status');
  status.classList.remove('error');
  try {
    const sessions = await db.getSessionsForExport(); // no range = all time
    const bodyWeight = await db.listBodyWeight();      // no range = all time
    const routines = await db.listRoutines();
    const dailyLogs = await db.listDailyLogs();        // no range = all time
    const savedMeals = await db.listSavedMeals();
    const backup = toBackupJSON(sessions, bodyWeight, new Date().toISOString(), routines, dailyLogs, savedMeals);
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forged-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const sCount = backup.sessions.length;
    const bCount = backup.bodyWeight.length;
    const rCount = backup.routines.length;
    const dCount = backup.dailyLogs.length;
    status.textContent =
      `Saved ${sCount} session${sCount === 1 ? '' : 's'}, ${bCount} body-weight entr${bCount === 1 ? 'y' : 'ies'}` +
      `${dCount ? `, ${dCount} daily log${dCount === 1 ? '' : 's'}` : ''}` +
      `${rCount ? `, and ${rCount} routine${rCount === 1 ? '' : 's'}` : ''}.`;
  } catch (err) {
    status.classList.add('error');
    status.textContent = 'Could not build the backup: ' + err.message;
  }
});

// ---------- import ----------

const importFileEl = document.getElementById('import-file');
const importTextEl = document.getElementById('import-text');

importFileEl.addEventListener('change', () => {
  const file = importFileEl.files && importFileEl.files[0];
  if (!file) return;
  const status = document.getElementById('import-status');
  const reader = new FileReader();
  reader.onload = () => {
    importTextEl.value = String(reader.result || '');
    status.classList.remove('error');
    status.textContent = `Loaded ${file.name}. Review, then tap Import.`;
  };
  reader.onerror = () => {
    status.classList.add('error');
    status.textContent = 'Could not read that file.';
  };
  reader.readAsText(file);
});

document.getElementById('import-btn').addEventListener('click', async () => {
  const status = document.getElementById('import-status');
  const btn = document.getElementById('import-btn');
  status.classList.remove('error');
  status.textContent = '';

  const text = importTextEl.value.trim();
  if (!text) {
    status.classList.add('error');
    status.textContent = 'Choose a file or paste some JSON first.';
    return;
  }

  let parsed;
  try {
    parsed = parseImportJSON(text);
  } catch (err) {
    status.classList.add('error');
    status.textContent = err.message;
    return;
  }

  const { summary } = parsed;
  const extras = [];
  if (summary.bodyWeight) extras.push(`${summary.bodyWeight} body-weight entr${summary.bodyWeight === 1 ? 'y' : 'ies'}`);
  if (summary.routines) extras.push(`${summary.routines} routine${summary.routines === 1 ? '' : 's'}`);
  if (summary.savedMeals) extras.push(`${summary.savedMeals} saved meal${summary.savedMeals === 1 ? '' : 's'}`);
  if (summary.dailyLogs) extras.push(`${summary.dailyLogs} daily log${summary.dailyLogs === 1 ? '' : 's'}`);
  const extraPhrase = extras.length ? ` plus ${extras.join(' and ')}` : '';
  const ok = confirm(
    `Import ${summary.sessions} session${summary.sessions === 1 ? '' : 's'} ` +
    `(${summary.sets} set${summary.sets === 1 ? '' : 's'})${extraPhrase}?\n\n` +
    `This only adds data - nothing already saved is changed or deleted.`
  );
  if (!ok) return;

  btn.disabled = true;
  status.textContent = 'Importing...';
  try {
    const r = await db.importData(parsed);
    const parts = [`${r.setsAdded} set${r.setsAdded === 1 ? '' : 's'} added`];
    if (r.sessionsCreated) parts.push(`${r.sessionsCreated} new session${r.sessionsCreated === 1 ? '' : 's'}`);
    if (r.exercisesCreated) parts.push(`${r.exercisesCreated} new exercise${r.exercisesCreated === 1 ? '' : 's'}`);
    if (r.bodyWeightAdded) parts.push(`${r.bodyWeightAdded} body-weight entr${r.bodyWeightAdded === 1 ? 'y' : 'ies'}`);
    if (r.setsSkipped) parts.push(`${r.setsSkipped} duplicate set${r.setsSkipped === 1 ? '' : 's'} skipped`);
    if (r.notesFilled) parts.push(`${r.notesFilled} note${r.notesFilled === 1 ? '' : 's'} filled in`);
    if (r.notesSkipped) parts.push(`${r.notesSkipped} existing note${r.notesSkipped === 1 ? '' : 's'} kept`);
    if (r.bodyWeightSkipped) parts.push(`${r.bodyWeightSkipped} body-weight date${r.bodyWeightSkipped === 1 ? '' : 's'} already present`);
    if (r.savedMealsAdded) parts.push(`${r.savedMealsAdded} saved meal${r.savedMealsAdded === 1 ? '' : 's'} added`);
    if (r.savedMealsSkipped) parts.push(`${r.savedMealsSkipped} saved meal${r.savedMealsSkipped === 1 ? '' : 's'} already present`);
    if (r.dailyLogsAdded) parts.push(`${r.dailyLogsAdded} daily log${r.dailyLogsAdded === 1 ? '' : 's'} added`);
    if (r.dailyLogsSkipped) parts.push(`${r.dailyLogsSkipped} daily log date${r.dailyLogsSkipped === 1 ? '' : 's'} already present`);
    if (r.routinesAdded) parts.push(`${r.routinesAdded} routine${r.routinesAdded === 1 ? '' : 's'} added`);
    if (r.routinesSkipped) parts.push(`${r.routinesSkipped} routine${r.routinesSkipped === 1 ? '' : 's'} skipped (name already used)`);
    status.textContent = 'Done - ' + parts.join(', ') + '.';
    importTextEl.value = '';
    importFileEl.value = '';
    await loadExercises(state.currentExerciseId);
    document.getElementById('exercise-select').value = state.currentExerciseId;
    document.getElementById('history-exercise-select').value = state.currentExerciseId;
    refreshExerciseEditor();
    await loadRoutines();
    renderRoutinesEditor();
    await onExerciseChange();
    await refreshTodaySession();
  } catch (err) {
    status.classList.add('error');
    status.textContent = 'Import error: ' + err.message + ' - fix the file and try again (already-imported rows are kept).';
  } finally {
    btn.disabled = false;
  }
});

// ---------- database upgrade coordination across windows ----------

function showDbNotice(message, canReload) {
  const toast = document.getElementById('update-toast');
  toast.querySelector('span').textContent = message;
  const btn = document.getElementById('update-reload-btn');
  btn.classList.toggle('hidden', !canReload);
  btn.onclick = () => window.location.reload();
  toast.classList.remove('hidden');
}
// Another window is on a newer version and needs this one out of the way.
window.addEventListener('forged-db-stale', () => showDbNotice('FORGED was updated in another window.', true));
// This window can't finish upgrading until an older window is closed.
window.addEventListener('forged-db-blocked', () => showDbNotice('Finishing an update - close any other FORGED windows or tabs.', false));

// ---------- PWA: service worker registration + update flow ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            document.getElementById('update-toast').classList.remove('hidden');
            document.getElementById('update-reload-btn').onclick = () => {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            };
          }
        });
      });
      // Check for a new version whenever the app is reopened/foregrounded.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update();
      });
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}

// ---------- init ----------

(async function init() {
  document.getElementById('today-label').textContent = prettyDate(todayStr());
  const chosen = await loadExercises();
  document.getElementById('exercise-select').value = chosen;
  document.getElementById('history-exercise-select').value = chosen;
  await loadRoutines();
  await onExerciseChange();
  await refreshTodaySession(); // also renders the routine strip
  // Tell the safety net in index.html that startup worked.
  window.__forgedBooted = true;
  try { sessionStorage.removeItem('forged-auto-repair'); } catch { /* storage blocked - fine */ }
})();
