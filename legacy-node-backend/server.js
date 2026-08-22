// server.js — the whole backend, using only Node's built-in http module.
// No npm install required: just `node server.js`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- helpers ----------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (chunk) => {
      chunks += chunk;
      if (chunks.length > 1e6) req.destroy(); // guard against absurd bodies
    });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Epley formula for estimated one-rep max.
function estimate1RM(weight, reps) {
  if (reps <= 1) return weight;
  return weight * (1 + reps / 30);
}

// Monday-based ISO week start for a YYYY-MM-DD date string.
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, rel);
  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- route handlers ----------

function listExercises(req, res) {
  const rows = db.prepare('SELECT * FROM exercises ORDER BY muscle_group, name').all();
  sendJson(res, 200, rows);
}

async function createExercise(req, res) {
  const body = await readJsonBody(req);
  const name = (body.name || '').trim();
  const muscleGroup = (body.muscle_group || '').trim();
  if (!name || !muscleGroup) {
    return sendJson(res, 400, { error: 'name and muscle_group are required' });
  }
  try {
    const info = db
      .prepare('INSERT INTO exercises (name, muscle_group) VALUES (?, ?)')
      .run(name, muscleGroup);
    const row = db.prepare('SELECT * FROM exercises WHERE id = ?').get(info.lastInsertRowid);
    sendJson(res, 201, row);
  } catch (err) {
    sendJson(res, 400, { error: 'An exercise with that name already exists' });
  }
}

function getLastSetsForExercise(req, res, exerciseId) {
  const lastSession = db
    .prepare(
      `SELECT s.id, s.date FROM sessions s
       JOIN sets st ON st.session_id = s.id
       WHERE st.exercise_id = ?
       ORDER BY s.date DESC LIMIT 1`
    )
    .get(exerciseId);

  if (!lastSession) return sendJson(res, 200, null);

  const sets = db
    .prepare(
      `SELECT id, weight, reps, rir, set_order FROM sets
       WHERE session_id = ? AND exercise_id = ?
       ORDER BY set_order ASC`
    )
    .all(lastSession.id, exerciseId);

  sendJson(res, 200, { date: lastSession.date, sets });
}

function getExerciseHistory(req, res, exerciseId) {
  const rows = db
    .prepare(
      `SELECT st.id, st.weight, st.reps, st.rir, st.set_order, s.date
       FROM sets st JOIN sessions s ON s.id = st.session_id
       WHERE st.exercise_id = ?
       ORDER BY s.date ASC, st.set_order ASC`
    )
    .all(exerciseId);

  const withEstimate = rows.map((r) => ({ ...r, e1rm: Math.round(estimate1RM(r.weight, r.reps) * 10) / 10 }));
  sendJson(res, 200, withEstimate);
}

function getOrCreateTodaySession(req, res, dateStr) {
  let session = db.prepare('SELECT * FROM sessions WHERE date = ?').get(dateStr);
  if (!session) {
    const info = db.prepare('INSERT INTO sessions (date) VALUES (?)').run(dateStr);
    session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  }
  sendJson(res, 200, session);
}

function listSessions(req, res, limit) {
  const rows = db
    .prepare(
      `SELECT s.id, s.date, s.notes,
              COUNT(st.id) AS set_count,
              COUNT(DISTINCT st.exercise_id) AS exercise_count
       FROM sessions s
       LEFT JOIN sets st ON st.session_id = s.id
       GROUP BY s.id
       ORDER BY s.date DESC
       LIMIT ?`
    )
    .all(limit);
  sendJson(res, 200, rows);
}

function getSessionDetail(req, res, sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return sendJson(res, 404, { error: 'Session not found' });

  const rows = db
    .prepare(
      `SELECT st.id, st.weight, st.reps, st.rir, st.set_order,
              e.id AS exercise_id, e.name AS exercise_name, e.muscle_group
       FROM sets st JOIN exercises e ON e.id = st.exercise_id
       WHERE st.session_id = ?
       ORDER BY e.name, st.set_order`
    )
    .all(sessionId);

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
    byExercise.get(r.exercise_id).sets.push({
      id: r.id,
      weight: r.weight,
      reps: r.reps,
      rir: r.rir,
      set_order: r.set_order,
    });
  }

  sendJson(res, 200, { ...session, exercises: Array.from(byExercise.values()) });
}

async function addSet(req, res, sessionId) {
  const body = await readJsonBody(req);
  const exerciseId = Number(body.exercise_id);
  const weight = Number(body.weight);
  const reps = Number(body.reps);
  const rir = body.rir === '' || body.rir === undefined || body.rir === null ? null : Number(body.rir);

  if (!exerciseId || !Number.isFinite(weight) || weight < 0 || !Number.isInteger(reps) || reps <= 0) {
    return sendJson(res, 400, { error: 'exercise_id, weight, and reps (positive integer) are required' });
  }

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return sendJson(res, 404, { error: 'Session not found' });

  // Figure out PR status BEFORE inserting the new set.
  const priorBestWeightAtOrAboveReps = db
    .prepare(
      `SELECT MAX(weight) AS best FROM sets WHERE exercise_id = ? AND reps >= ?`
    )
    .get(exerciseId, reps).best;
  const priorSets = db.prepare('SELECT weight, reps FROM sets WHERE exercise_id = ?').all(exerciseId);
  const priorBestE1RM = priorSets.reduce((max, s) => Math.max(max, estimate1RM(s.weight, s.reps)), 0);

  const orderRow = db
    .prepare('SELECT COALESCE(MAX(set_order), 0) AS m FROM sets WHERE session_id = ? AND exercise_id = ?')
    .get(sessionId, exerciseId);
  const setOrder = orderRow.m + 1;

  const info = db
    .prepare(
      `INSERT INTO sets (session_id, exercise_id, weight, reps, rir, set_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sessionId, exerciseId, weight, reps, rir, setOrder, new Date().toISOString());

  const newE1RM = estimate1RM(weight, reps);
  const isWeightPR = priorBestWeightAtOrAboveReps == null || weight > priorBestWeightAtOrAboveReps;
  const isE1RMPR = newE1RM > priorBestE1RM;

  const created = db.prepare('SELECT * FROM sets WHERE id = ?').get(info.lastInsertRowid);
  sendJson(res, 201, { ...created, isWeightPR, isE1RMPR });
}

function deleteSet(req, res, setId) {
  const info = db.prepare('DELETE FROM sets WHERE id = ?').run(setId);
  if (info.changes === 0) return sendJson(res, 404, { error: 'Set not found' });
  sendJson(res, 204, {});
}

function getPRs(req, res) {
  const exercises = db.prepare('SELECT * FROM exercises ORDER BY name').all();
  const results = [];
  for (const ex of exercises) {
    const sets = db
      .prepare(
        `SELECT st.weight, st.reps, s.date FROM sets st
         JOIN sessions s ON s.id = st.session_id
         WHERE st.exercise_id = ?`
      )
      .all(ex.id);
    if (sets.length === 0) continue;

    let bestWeightSet = sets[0];
    let bestE1RMSet = sets[0];
    let bestE1RM = estimate1RM(sets[0].weight, sets[0].reps);
    for (const s of sets) {
      if (s.weight > bestWeightSet.weight) bestWeightSet = s;
      const e = estimate1RM(s.weight, s.reps);
      if (e > bestE1RM) {
        bestE1RM = e;
        bestE1RMSet = s;
      }
    }
    results.push({
      exercise_id: ex.id,
      exercise_name: ex.name,
      muscle_group: ex.muscle_group,
      best_weight: bestWeightSet,
      best_e1rm: { ...bestE1RMSet, e1rm: Math.round(bestE1RM * 10) / 10 },
    });
  }
  sendJson(res, 200, results);
}

function getWeeklyVolume(req, res) {
  const rows = db
    .prepare(
      `SELECT s.date, e.muscle_group FROM sets st
       JOIN sessions s ON s.id = st.session_id
       JOIN exercises e ON e.id = st.exercise_id`
    )
    .all();

  const grouped = new Map(); // week -> { muscle_group -> count }
  for (const r of rows) {
    const wk = weekStart(r.date);
    if (!grouped.has(wk)) grouped.set(wk, {});
    const bucket = grouped.get(wk);
    bucket[r.muscle_group] = (bucket[r.muscle_group] || 0) + 1;
  }

  const weeks = Array.from(grouped.keys()).sort();
  const result = weeks.map((wk) => ({ week_start: wk, muscle_groups: grouped.get(wk) }));
  sendJson(res, 200, result);
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    if (!pathname.startsWith('/api/')) {
      return serveStatic(req, res, pathname);
    }

    const parts = pathname.split('/').filter(Boolean); // ['api', ...]

    if (method === 'GET' && pathname === '/api/exercises') {
      return listExercises(req, res);
    }
    if (method === 'POST' && pathname === '/api/exercises') {
      return await createExercise(req, res);
    }
    if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'exercises' && parts[3] === 'last') {
      return getLastSetsForExercise(req, res, Number(parts[2]));
    }
    if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'exercises' && parts[3] === 'history') {
      return getExerciseHistory(req, res, Number(parts[2]));
    }
    if (method === 'GET' && pathname === '/api/sessions/today') {
      const dateStr = url.searchParams.get('date');
      if (!dateStr) return sendJson(res, 400, { error: 'date query param (YYYY-MM-DD) is required' });
      return getOrCreateTodaySession(req, res, dateStr);
    }
    if (method === 'GET' && pathname === '/api/sessions') {
      const limit = Number(url.searchParams.get('limit')) || 30;
      return listSessions(req, res, limit);
    }
    if (method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'sessions') {
      return getSessionDetail(req, res, Number(parts[2]));
    }
    if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'sets') {
      return await addSet(req, res, Number(parts[2]));
    }
    if (method === 'DELETE' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'sets') {
      return deleteSet(req, res, Number(parts[2]));
    }
    if (method === 'GET' && pathname === '/api/prs') {
      return getPRs(req, res);
    }
    if (method === 'GET' && pathname === '/api/volume/weekly') {
      return getWeeklyVolume(req, res);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Workout tracker running at http://localhost:${PORT}`);
});
