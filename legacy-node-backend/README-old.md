# Overload — personal workout tracker

A small, mobile-friendly app for logging workouts, tracking progress, and
spotting PRs. No accounts, no cloud, no build step — it runs entirely on
your own computer and keeps your data in one file next to the app.

## Requirements

Just **Node.js version 22.5 or newer** (this app uses Node's built-in
SQLite support, so there's nothing else to install — no `npm install`
needed at all).

Check your version with:

```
node --version
```

If you don't have Node, or have an older version, get it from
https://nodejs.org (grab the current LTS release).

## Running it

From inside this folder:

```
node server.js
```

Then open **http://localhost:3000** in your browser (on your phone too, if
your phone is on the same wifi as your computer — use your computer's local
IP address instead of "localhost" in that case, e.g. http://192.168.1.23:3000).

Press Ctrl+C in the terminal to stop it.

## Your data

The first time you run it, a file called `workout.db` is created in this
folder and seeded with a starter list of common exercises. All your
workouts live in that one file. Back it up by copying `workout.db`
somewhere safe; restore by copying it back before starting the server.

## What it does (v1)

- **Log** — pick an exercise, see what you did last time, log sets
  (weight x reps x RIR) with one tap, and get flagged the moment you hit a
  new PR.
- **History** — a chart of your top-set weight and estimated 1-rep max
  over time for any exercise, plus the full session-by-session log.
- **PRs** — your all-time heaviest set and best estimated 1RM per exercise.
- **Volume** — sets per muscle group per week, so you can keep an eye on
  training volume.

## Ideas for later (not built yet)

- Rest timer between sets
- Body weight log
- Session notes
- CSV export

Just ask if you want any of these added — the codebase is small and
everything above lives in four files: `db.js` (data), `server.js` (API),
and `public/index.html` + `public/app.js` (the app itself).
