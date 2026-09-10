// app.js — UI wiring. Imports pure logic from lib.js and storage from db.js.

import {
  toCSV, toJSONExport, toBackupJSON, parseImportJSON, toPRHistoryCSV,
  toRoutinesExport, pickActiveRoutine,
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
  activeRoutineId: null,  // routine currently shown as the Log-tab checklist
  routineManuallyPicked: false, // true once the user taps a chip (stops clock auto-pick)
  routineStripHidden: false,    // true after the user hits the strip's ✕
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

function setActivePreset(containerEl, btnEl) {
  containerEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
  btnEl.classList.add('active');
}

// ---------- tab switching ----------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'view-history') {
      refreshHistory();
      refreshSessionNotesList();
      refreshExerciseEditor();
      renderRoutinesEditor();
    }
    if (btn.dataset.view === 'view-prs') refreshPRs();
    if (btn.dataset.view === 'view-volume') refreshVolume();
    if (btn.dataset.view === 'view-bodyweight') refreshBodyWeight();
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
      h4.innerHTML = `${ex.exercise_name} <span class="muscle-tag" data-group="${ex.muscle_group}">${ex.muscle_group}</span>`;
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
  const n = await db.countSetsForExercise(fromId);
  const ok = confirm(
    `Move ${n} set${n === 1 ? '' : 's'} from "${fromEx.name}" into "${intoEx.name}", then delete "${fromEx.name}"?\n\n` +
    `Every set is kept - only the extra exercise entry is removed. This can't be undone from the app (re-import a backup to revert).`
  );
  if (!ok) return;

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
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

  if (!state.routines.length || state.routineStripHidden) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');

  const todayLabel = db.todayDayLabel();
  dayEl.textContent = `Today · ${todayLabel}`;
  const todays = state.routines.filter((r) => r.day === todayLabel);

  // Until the user taps a chip themselves, the strip follows the clock:
  // today's routine whose time tag matches morning/evening. After a manual
  // pick, that choice sticks for the session.
  let active = state.routines.find((r) => r.id === state.activeRoutineId) || null;
  if (!state.routineManuallyPicked || !active) {
    active = pickActiveRoutine(todays, new Date().getHours()) || active;
    state.activeRoutineId = active ? active.id : null;
  }

  if (!todays.length && !active) {
    const pick = document.createElement('select');
    pick.className = 'routine-strip-pick';
    pick.innerHTML =
      '<option value="">Start a routine…</option>' +
      state.routines.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    pick.addEventListener('change', () => { if (pick.value) activateRoutine(Number(pick.value)); });
    chipsEl.appendChild(pick);
    return;
  }

  const chipRoutines = [...todays];
  if (active && !chipRoutines.some((r) => r.id === active.id)) chipRoutines.unshift(active);
  for (const r of chipRoutines) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'routine-chip' + (active && r.id === active.id ? ' active' : '');
    b.textContent = r.time ? `${r.name} · ${TIME_FULL[r.time]}` : r.name;
    b.addEventListener('click', () => activateRoutine(r.id));
    chipsEl.appendChild(b);
  }
  clearBtn.classList.remove('hidden');

  if (!active) return;
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
  state.routineStripHidden = false;
  renderRoutineStrip();
}

function selectRoutineExercise(exId) {
  const sel = document.getElementById('exercise-select');
  sel.value = String(exId);
  onExerciseChange();
  document.getElementById('input-weight').focus();
}

document.getElementById('routine-strip-clear').addEventListener('click', () => {
  state.routineStripHidden = true;
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
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'secondary';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete the routine "${r.name}"? Your logged workouts are not affected.`)) return;
    await db.deleteRoutine(r.id);
    if (state.activeRoutineId === r.id) state.activeRoutineId = null;
    if (state.expandedRoutineId === r.id) state.expandedRoutineId = null;
    await loadRoutines();
    renderRoutinesEditor();
    renderRoutineStrip();
    setRoutineStatus('Deleted.');
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
    card.innerHTML = `
      <h4>${p.exercise_name} <span class="muscle-tag" data-group="${p.muscle_group}">${p.muscle_group}</span></h4>
      <div class="pr-line">Heaviest set: ${p.best_weight.weight} x ${p.best_weight.reps} on ${prettyDate(p.best_weight.date)}</div>
      <div class="pr-line">Best est. 1RM: ${p.best_e1rm.e1rm} (from ${p.best_e1rm.weight} x ${p.best_e1rm.reps} on ${prettyDate(p.best_e1rm.date)})</div>`;

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
  const data = {
    sessions: toJSONExport(sessions),
    bodyWeight: bodyWeight.map((b) => ({ date: b.date, weight: b.weight })),
    routines: toRoutinesExport(routines),
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

// ---------- backup file download ----------

document.getElementById('backup-json-btn').addEventListener('click', async () => {
  const status = document.getElementById('backup-status');
  status.classList.remove('error');
  try {
    const sessions = await db.getSessionsForExport(); // no range = all time
    const bodyWeight = await db.listBodyWeight();      // no range = all time
    const routines = await db.listRoutines();
    const backup = toBackupJSON(sessions, bodyWeight, new Date().toISOString(), routines);
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
    status.textContent =
      `Saved ${sCount} session${sCount === 1 ? '' : 's'}, ${bCount} body-weight entr${bCount === 1 ? 'y' : 'ies'}` +
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
})();
