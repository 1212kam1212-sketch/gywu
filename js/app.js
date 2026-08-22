// app.js — UI wiring. Imports pure logic from lib.js and storage from db.js.

import { toCSV, toJSONExport } from './lib.js';
import * as db from './db.js';

const state = {
  exercises: [],
  currentExerciseId: null,
  todaySessionId: null,
  historyRangeWeeks: 52,
  volumeRangeWeeks: 8,
  exportRangeWeeks: 0,
  notesSaveTimer: null,
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
    if (btn.dataset.view === 'view-history') refreshHistory();
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
  const last = await db.getLastSetsForExercise(state.currentExerciseId);
  const card = document.getElementById('last-time-card');
  if (!last) {
    card.classList.add('hidden');
  } else {
    card.classList.remove('hidden');
    document.getElementById('last-time-date').textContent = prettyDate(last.date);
    const chips = document.getElementById('last-time-sets');
    chips.innerHTML = '';
    for (const s of last.sets) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${s.weight} x ${s.reps}${s.rir !== null && s.rir !== undefined ? ` @${s.rir}RIR` : ''}`;
      chips.appendChild(chip);
    }
  }
  document.getElementById('pr-banner').classList.add('hidden');
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
      h4.innerHTML = `${ex.exercise_name} <span class="muscle-tag">${ex.muscle_group}</span>`;
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
}

// ---------- session notes (feature 3) ----------

document.getElementById('session-notes').addEventListener('input', (e) => {
  const value = e.target.value;
  clearTimeout(state.notesSaveTimer);
  state.notesSaveTimer = setTimeout(async () => {
    const session = await ensureTodaySession();
    await db.updateSessionNotes(session.id, value);
  }, 500);
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

// ---------- PRS tab ----------

async function refreshPRs() {
  const prs = await db.getPRs();
  const container = document.getElementById('prs-list');
  if (!prs.length) {
    container.innerHTML = '<div class="empty-note">Log some sets to start tracking PRs.</div>';
    return;
  }
  container.innerHTML = prs
    .map(
      (p) => `
    <div class="pr-card">
      <h4>${p.exercise_name} <span class="muscle-tag">${p.muscle_group}</span></h4>
      <div class="pr-line">Heaviest set: ${p.best_weight.weight} x ${p.best_weight.reps} on ${prettyDate(p.best_weight.date)}</div>
      <div class="pr-line">Best est. 1RM: ${p.best_e1rm.e1rm} (from ${p.best_e1rm.weight} x ${p.best_e1rm.reps} on ${prettyDate(p.best_e1rm.date)})</div>
    </div>`
    )
    .join('');
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

  ctx.strokeStyle = '#aeff00';
  ctx.shadowColor = '#aeff00';
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
    ctx.fillStyle = '#aeff00';
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
  a.download = `gywu-export-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const status = document.getElementById('export-status');
  status.textContent = `Downloaded ${rows.length} set${rows.length === 1 ? '' : 's'}.`;
});

document.getElementById('export-json-btn').addEventListener('click', async () => {
  const sessions = await db.getSessionsForExport(rangeFromWeeks(state.exportRangeWeeks));
  const data = toJSONExport(sessions);
  const json = JSON.stringify(data, null, 2);
  const status = document.getElementById('export-status');
  try {
    await navigator.clipboard.writeText(json);
    status.textContent = `Copied ${data.length} session${data.length === 1 ? '' : 's'} to clipboard.`;
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
      status.textContent = `Copied ${data.length} session${data.length === 1 ? '' : 's'} to clipboard.`;
    } catch {
      status.textContent = 'Could not copy automatically - select and copy the data manually.';
    }
    document.body.removeChild(ta);
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
  await onExerciseChange();
  await refreshTodaySession();
})();
