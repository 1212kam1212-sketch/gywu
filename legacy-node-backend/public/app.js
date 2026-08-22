// app.js — all frontend logic. Plain JS, no build step, no framework.

const state = {
  exercises: [],
  currentExerciseId: null,
  todaySessionId: null,
};

// ---------- small helpers ----------

function todayStr() {
  const d = new Date();
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

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed: ${res.status}`);
  return data;
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
  state.exercises = await api('/api/exercises');
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
    const created = await api('/api/exercises', { method: 'POST', body: JSON.stringify({ name, muscle_group: group }) });
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
  const last = await api(`/api/exercises/${state.currentExerciseId}/last`);
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
  const session = await api(`/api/sessions/today?date=${todayStr()}`);
  state.todaySessionId = session.id;
  return session.id;
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
    const sessionId = await ensureTodaySession();
    const result = await api(`/api/sessions/${sessionId}/sets`, {
      method: 'POST',
      body: JSON.stringify({ exercise_id: state.currentExerciseId, weight, reps, rir }),
    });

    const banner = document.getElementById('pr-banner');
    if (result.isWeightPR || result.isE1RMPR) {
      banner.textContent = '🎉 New PR!';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    document.getElementById('input-reps').value = '';
    document.getElementById('input-rir').value = '';

    await refreshTodaySession();
  } catch (err) {
    alert(err.message);
  }
});

async function refreshTodaySession() {
  const sessionId = await ensureTodaySession();
  const detail = await api(`/api/sessions/${sessionId}`);
  const container = document.getElementById('today-session');
  container.innerHTML = '';

  if (!detail.exercises.length) {
    container.innerHTML = '<div class="empty-note">Nothing logged yet today. Add your first set above.</div>';
    return;
  }

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
        await api(`/api/sets/${s.id}`, { method: 'DELETE' });
        refreshTodaySession();
      });
      row.appendChild(delBtn);
      block.appendChild(row);
    }
    container.appendChild(block);
  }
}

// ---------- HISTORY tab ----------

document.getElementById('history-exercise-select').addEventListener('change', refreshHistory);

async function refreshHistory() {
  const select = document.getElementById('history-exercise-select');
  const exerciseId = Number(select.value);
  if (!exerciseId) return;
  const rows = await api(`/api/exercises/${exerciseId}/history`);
  drawHistoryChart(rows);
  renderHistoryTable(rows);
}

function drawHistoryChart(rows) {
  const canvas = document.getElementById('history-chart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!rows.length) {
    ctx.fillStyle = '#9aa2b1';
    ctx.font = '14px sans-serif';
    ctx.fillText('No sets logged yet for this exercise.', 16, H / 2);
    return;
  }

  // Aggregate to one point per date: best weight & best e1rm that date.
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { weight: 0, e1rm: 0 });
    const b = byDate.get(r.date);
    b.weight = Math.max(b.weight, r.weight);
    b.e1rm = Math.max(b.e1rm, r.e1rm);
  }
  const dates = Array.from(byDate.keys()).sort();
  const points = dates.map((d) => byDate.get(d));

  const padding = { top: 16, right: 16, bottom: 26, left: 40 };
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

  // axes
  ctx.strokeStyle = '#262a33';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotH);
  ctx.lineTo(padding.left + plotW, padding.top + plotH);
  ctx.stroke();

  ctx.fillStyle = '#9aa2b1';
  ctx.font = '11px sans-serif';
  ctx.fillText(Math.round(maxVal).toString(), 4, padding.top + 10);
  ctx.fillText('0', 4, padding.top + plotH);

  function drawLine(key, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = x(i), py = y(p[key]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    points.forEach((p, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x(i), y(p[key]), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawLine('weight', '#4f8cff');
  drawLine('e1rm', '#ff9f43');

  // x-axis labels: first and last date only, to avoid crowding
  ctx.fillStyle = '#9aa2b1';
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
    container.innerHTML = '<div class="empty-note">No sets logged yet.</div>';
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
  const prs = await api('/api/prs');
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

async function refreshVolume() {
  const weeks = await api('/api/volume/weekly');
  const container = document.getElementById('volume-table');
  if (!weeks.length) {
    container.innerHTML = '<div class="empty-note">Log some sets to see weekly volume.</div>';
    return;
  }
  const recent = weeks.slice(-8).reverse();
  let html = '<table><thead><tr><th>Week of</th>' + MUSCLE_GROUPS.map((g) => `<th>${g}</th>`).join('') + '</tr></thead><tbody>';
  for (const w of recent) {
    html += `<tr><td>${prettyDate(w.week_start)}</td>` + MUSCLE_GROUPS.map((g) => `<td>${w.muscle_groups[g] || 0}</td>`).join('') + '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
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
