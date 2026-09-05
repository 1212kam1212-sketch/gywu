# FORGED — personal workout tracker

A phone-installable, offline-capable workout tracker. Log sets, track PRs,
watch weekly volume, log body weight, and export everything back out — all
running entirely in your phone's browser. No accounts, no server, no
backend to run. Your data lives only in your phone's local browser storage
(IndexedDB) — this repo holds app code only, never your actual workout data.

## Architecture

This is a **static site** — HTML/CSS/JS, zero build step, zero server.
GitHub Pages can only serve static files, so all data storage that used to
live in a SQLite file on a Node server now lives in **IndexedDB**, inside
your phone's (or browser's) own local storage. It's also a installable PWA
(Progressive Web App): add it to your home screen and it opens full-screen,
works offline, and updates itself when you're back online.

```
index.html, style.css        - app shell
js/lib.js                    - pure logic (1RM, PR detection, volume, exports) - unit tested
js/db.js                     - IndexedDB data layer (exercises, sessions, sets, bodyWeight)
js/app.js                    - UI wiring
manifest.json, sw.js, icons/ - PWA install + offline support
tests/                       - node:test unit tests for js/lib.js
.github/workflows/deploy.yml - GitHub Pages deploy on push to main
legacy-node-backend/         - the old Node+SQLite version (v1), kept for reference only, not deployed
```

## Installing on your phone

Once deployed to GitHub Pages (see below), open the site URL on your phone.

### Android (Chrome)

1. Open the site URL in Chrome.
2. Tap the **⋮** menu → **Add to Home screen** (or Chrome may show an
   "Install app" banner automatically — tap it).
3. Confirm. FORGED now opens full-screen from your home screen like a native
   app, and works offline after the first load.

### iOS (Safari)

iOS requires Safari specifically — the install option does not appear in
Chrome or other browsers on iOS.

1. Open the site URL in **Safari** (not Chrome).
2. Tap the **Share** button (square with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. FORGED now opens full-screen from your home screen.

iOS quirks worth knowing: Safari only starts caching offline assets once
you open the installed home-screen app at least once while online, and
iOS is more aggressive about clearing site storage (including IndexedDB)
for apps you haven't opened in a while — open FORGED every so often, and
export your data periodically (see Export below) as a backup regardless.

## Deploying / updating

1. Push to the `main` branch on GitHub. The workflow in
   `.github/workflows/deploy.yml` builds nothing (there's no build step) —
   it just uploads the repo as-is and publishes it to GitHub Pages.
2. GitHub Pages serves the new files within a minute or two of the workflow
   finishing (check the **Actions** tab on GitHub for progress).
3. **How it reaches your phone:** the service worker (`sw.js`) fetches
   fresh copies of the app's files over the network whenever your phone is
   online, so the next time you open FORGED with a connection, you're already
   on the latest version — no manual cache-clearing needed. If `sw.js`
   itself changes (rare — only happens if the caching strategy changes),
   you'll see an in-app "New version available" toast; tap **Reload** to
   pick it up immediately. Offline, FORGED always falls back to whatever was
   last cached, so it keeps working with no connection.

The repo needs to be **public** — GitHub Pages on the free plan only
serves from public repositories. That's fine here since the repo never
contains your actual workout data (see Architecture above).

## Local development

Requires Node.js (used only for running tests and a local preview server —
the deployed app itself needs no server or Node at all).

```
npm test           # runs js/lib.js unit tests (node:test)
npm run serve       # local static server at http://localhost:5500
```

## Data export / backup

Since your data lives only in your phone's browser, back it up periodically
from the **Export** tab:

- **Download CSV** — one row per set: `date, exercise, muscle_group,
  weight, reps, rir, e1rm`. Opens directly in any spreadsheet app.
- **Copy JSON** — copies `{ sessions, bodyWeight, prHistory }` to the
  clipboard, meant to be pasted directly into a chat with Claude (or any
  LLM) for custom graphs/analysis. `prHistory` is always all-time.
- **Download PR history CSV** — one row per PR milestone: `date, exercise,
  muscle_group, weight, reps, rir, e1rm, record` where `record` is
  `weight`, `e1rm`, or `weight + e1rm`. All-time.
- **Download backup (JSON)** — a full `{ app, version, exported_at,
  sessions, bodyWeight }` file covering your entire history regardless of
  the date-range filter. This is the file to keep as a real backup.
  (No `prHistory` here — it's fully derived from `sessions`.)

CSV and Copy JSON support a date-range filter so exporting a full year of
data doesn't mean scrolling through everything at once.

### Import

The **Import JSON** card (Export tab) takes a backup file or pasted JSON —
either the backup shape or the Copy JSON `{ sessions, bodyWeight }` shape
(a `prHistory` key, if present, is ignored — it's derived), or a bare
session array from an older export. Import is **strictly additive and
idempotent**:

- sessions match by date (created if absent); exercises match by name,
  case-insensitively (created if absent)
- a set is added only if an identical set (same weight/reps/RIR) for that
  exercise on that date isn't already stored
- a session's notes are only filled in when it currently has none — an
  existing note is never overwritten
- a body-weight entry is added only for a date that has none yet

Nothing is ever edited in place or deleted, so re-importing the same file
is a no-op and a half-finished import can simply be run again.

## What it does

- **Log** — pick an exercise, see what you did **last session** (today's
  in-progress sets are never shown as "last time"), log sets
  (weight × reps × RIR), get flagged the moment you hit a new PR, and use
  the inline rest timer (90/120/180s presets or custom) without ever
  leaving the logging screen. Add free-text notes for the session.
- **History** — chart of top-set weight and estimated 1RM over time for
  any exercise, with date-range filtering (8wk/12wk/6mo/1yr/all) so it
  stays fast and readable even after a year of heavy training. Also has an
  **Edit exercises** card to rename an exercise or **merge** two entries
  (combines their sets onto one exercise, nothing lost) when the same lift
  got logged under two names.
- **PRs** — all-time heaviest set and best estimated 1RM per exercise,
  each with an expandable **progression** timeline: every set that set a
  new weight and/or e1RM record, with its date.
- **Volume** — sets per muscle group per week, with the same date-range
  filtering.
- **Body Wt** — log body weight by date with a trend chart, kept separate
  from lifting data.
- **Export / Import** — CSV and JSON export, a full downloadable backup
  file, and additive JSON import. See above.

## Scale

The IndexedDB layer is indexed for a full year of heavy use (300+
sessions, several thousand sets): exercise history and weekly volume
queries use compound indexes and date-range bounds rather than scanning
every set on every view.
