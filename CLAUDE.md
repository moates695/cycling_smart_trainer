# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A fork of **Auuki** (github.com/dvmarinoff/flux) — a browser-based PWA for running structured
cycling workouts on smart trainers. It talks to hardware directly via Web Bluetooth / Web Serial
(FTMS, Tacx FE-C over BLE, CPS power meters, HR monitors, Moxy), runs ERG / resistance / slope
modes and records `.FIT` activities. The PWA is client-side; `server/` in this repo is the WATTS
accounts and sync backend it talks to.

This fork adds a **graphical `<workout-designer>` sub-tab** (`src/views/workout-designer.js` +
`src/workouts/designer-model.js`) on top of upstream. See `memory/` notes for fork context.

## Commands

```bash
npm start              # Parcel dev server (entry: src/index.html)
npm run starttls       # dev server over HTTPS — needed for some Web Bluetooth flows
npm run build          # Parcel production build → dist/
npm test               # Jest (all tests)
npx jest test/workouts/designer-model.test.js   # single test file
npx jest -t "some describe or it name"          # single test by name
```

Backend (see `server/README.md`):

```bash
cd server                # needs the machine's own Postgres, not a container:
                         # watts_dev on host.docker.internal:5432 (see server/README.md)
uv sync && uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8010   # .proxyrc forwards /api here
uv run pytest
```

Note: the Jest suite has ~52 failures that predate this work (mostly `test/storage`). Diff the
pass/fail set against a clean tree before blaming a change for them.

There is no lint step configured. Tests use `babel-jest` (see `.babelrc` — the `test` env
transforms ES modules to CommonJS) and `fake-indexeddb` for storage tests.

### Riding a workout without hardware

`src/sim.js` (fork addition) fakes a trainer and HR strap. Open the dev server with `?sim=1`
(add `&ride=1` to start pedalling immediately, `&devices=controllable,heartRateMonitor,smo2,coreTemp`
to choose which). It dispatches the same `power`/`cadence`/`speed`/`heartRate` and
`ble:<deviceType>:connected` events `ble/reactive-connectable.js` does, so everything above the BLE
seam — db, models, watch, workout stepping, graphs, FIT recording, uploads — behaves as with real
hardware. `ble/devices.js` skips creating the real connectables while sim mode is on. Console API is
`window.sim` (`ride()`, `coast()`, `power(n)`, `hr(n)`, `dropout(ms)`, `state()`); a red SIM badge
sits bottom-right and toggles pedalling on click.

## Architecture

### The `xf` reactive core (understand this first)

`src/functions.js` exports `xf`, a ~60-line event bus + proxy store that everything is built on.
It is the app's entire state-management layer — there is no framework.

- **`xf.create(obj)`** wraps a plain object in a Proxy. Assigning any property (`db.power = 250`)
  automatically dispatches a DOM `CustomEvent` named `db:<key>` (source prefix is the store name,
  default `db`).
- **`xf.reg(eventType, (payload, db) => { ... })`** registers a *reducer*. The handler receives the
  event payload **and a live reference to the store**, and mutates the store in place. This is how
  intents become state changes.
- **`xf.sub(eventType, handler)`** subscribes a listener (typically a view) to an event.
- **`xf.dispatch(eventType, value)`** fires an event manually.

Everything is wired through `window` DOM events under the hood, so any module can react to any
other without direct imports.

### Event naming convention

- `db:<field>` — the store changed (emitted automatically by the proxy). Views subscribe to these.
- `ui:<intent>` — a user action / command (e.g. `ui:power-target-set`, `ui:workout:create`,
  `ui:page-set`). Reducers in `db.js` listen for these and update the store.
- Device/domain events use their own prefixes (`watch:stopped`, `activity:save:success`, etc.).

Flow: **user interaction → `xf.dispatch('ui:...')` → reducer in `db.js` mutates store →
proxy emits `db:...` → subscribed Web Components re-render.**

### Store and models

- **`src/db.js`** is the single source of truth. It defines the initial `db` object, calls
  `xf.create(db)`, and registers every `xf.reg(...)` reducer. Nearly all state transitions live here.
- **`src/models/models.js`** holds a *model* per store field. A model typically exposes `.default`
  (initial value), `.prop` (its event name), `.setState(...)` (derivation logic, e.g. lap/avg
  accumulation), and `.parse(...)`. `db.js` delegates to these rather than inlining logic.
  Other `models/` files: `api.js`, `strava.js`, `training-peaks.js` (integrations),
  `auth.js`, `config.js`.

  The intervals.icu integration was removed along with the `Planned`/`wod` model it fed
  (workout-of-day, weekly planned workouts, FTP/weight sync, ride upload). The WATTS account in
  `src/sync/` replaced it as the account mechanism; nothing pulls a training calendar now. Note
  that `intervals` still appears throughout the codebase in its unrelated sense — the steps of a
  workout (`workout.intervals`, `watch.js`, `zwo.js`) — so grep accordingly.

### Views are native Web Components

There is no JSX/templating library. Each file in `src/views/` defines
`class Foo extends HTMLElement { ... }` and `customElements.define('foo-tag', Foo)`, used directly
in `src/index.html`. The standard pattern:

- `connectedCallback()` sets up an `AbortController`, then `xf.sub('db:someField', this.onUpdate, this.signal)`.
- `disconnectedCallback()` aborts the controller to tear down all subscriptions.
- User input handlers call `xf.dispatch('ui:...')`.

`src/views/views.js` is the barrel that imports every view module. `data-views.js` is the large
data-tile screen. `index.html` is a single ~100KB file containing the full app shell and tab markup.

### BLE / device layer

`src/ble/` wraps Web Bluetooth. `devices.js` instantiates one `ReactiveConnectable(...)` per device
role (controllable trainer, power meter, HR, speed/cadence, Moxy, core temp). Each BLE service has
its own subfolder (`ftms/`, `fec/`, `cps/`, `hrs/`, `cscs/`, `moxy/`, ...). Incoming measurements are
pushed into the store via `xf.dispatch`. `src/ant/` is the (experimental) ANT+ equivalent.

### Workouts

- **`src/workouts/zwo.js`** parses and serialises Zwift `.ZWO` XML.
- **`src/workouts/workouts.js`** is the built-in workout library.
- **`src/workouts/designer-model.js`** (fork addition) is *pure* conversion logic between draggable
  "segments" and ZWO — deliberately DOM-free and free of heavy app imports so it is unit-testable in
  isolation (`test/workouts/designer-model.test.js`). It emits `<SteadyState>` for flat blocks and
  `<Warmup>`/`<Cooldown>` for rising/falling ramps (Auuki's parser reads both as PowerLow→PowerHigh).
- **`src/views/workout-designer.js`** is the Web Component UI that uses `designer-model.js` and
  dispatches `ui:workout:create` with the generated ZWO string; the reducer in `db.js` parses it and
  adds it to the workout list.

### Accounts and sync (`server/` + `src/sync/`)

`server/` is a FastAPI + Postgres backend for email/password accounts and background sync of custom
workouts, activity summaries, FIT files and the rider profile (FTP and weight). It is a separate
deployable from the PWA — see `server/README.md` for how to run it, and `deploy/deploy-api.sh` for
releases.

The governing rule on the client: **IndexedDB stays the source of truth for the running app.** The
server is a replica that converges in the background, and no UI path blocks on a network call — the
app works signed out, offline, and mid-interval on bad wifi.

- **`src/sync/sync-model.js`** is *pure* — serialisation, last-write-wins merge, tombstone
  precedence, queue batching, backoff. DOM-free, no heavy imports, same convention as
  `designer-model.js`. Covered by `test/sync/sync-model.test.js`.
- **`src/sync/sync-api.js`** is transport only. Same-origin `/api`, session cookie, no merge logic.
- **`src/sync/sync.js`** is the orchestrator wiring those to idb and `xf`. Covered by
  `test/sync/sync.test.js` against fake-indexeddb and a stub server.
- **`src/views/watts-account.js`** is the sign-in UI, in the Account sub-tab.

Every local mutation drains immediately (`schedule(0)`), rather than waiting for the 60 s tick:
workout create / upload / edit / delete, a completed ride, a deleted ride, and an FTP or weight
edit. The reducers in `db.js` are what call sync — a new mutation path that skips them will write
to idb and never leave the device.

Things to keep in mind when touching this:

- **Deletes must write tombstones, never bare `idb.remove`.** A hard delete is silently undone by
  the next pull. `Activity.remove` and `sync.workoutRemoved` do this; anything new must too.
- **The sync cursor only advances on a pull.** A push response's cursor covers only the rows just
  sent and can sit above rows another device uploaded earlier.
- **The rider profile lives in `localStorage`, not idb** — that is where `models.ftp` / `models.weight`
  already keep it, and `app:start` restores it synchronously. `sync:settings` under the key
  `sync:settings` is the sync envelope around those values; the plain `ftp` / `weight` keys are
  untouched, so a signed-out app reads its settings exactly as before.
- **Never route a pulled profile back through `ui:ftp-set`.** That reducer stamps the value as a
  fresh local edit, which would push it straight back and ping-pong between devices. The
  `sync:settings` reducer exists for the incoming direction.
- **Server-side validation of the profile must never be stricter than the client's.** A 4xx is not
  retried (`shouldRetry`), so a value the UI accepts but the API rejects wedges that device's whole
  push queue, workouts included. `schemas.RiderSettings` mirrors the client bounds and drops unknown
  keys for the same reason.

`src/views/watts-account.js` holds five states in one card — sign in, create account, forgot
password, enter the emailed code, signed in — and shows exactly one. Each is its own `<form>` so
password managers see a login form, a registration form and a change-password form rather than one
form that changes meaning.

Password reset is a six digit code typed into the app, not a link followed from the inbox: a link
opens whatever browser handles mail (on iOS always Safari, never the installed PWA), so the session
it produces would land in the wrong browser. `POST /api/auth/password/reset` always answers 204 —
never make it reveal whether an address is registered — and `/reset/confirm` returns the user and
sets the cookie, so the client treats it exactly like a login (`sync.resetPassword` → `adopt` →
`firstSync`). Server-side invariants live in `server/README.md`; the ones easy to break from the
client are that the code is bound to the user id and that a wrong guess costs an attempt, so
retrying blindly burns the code.

### PWA / service worker

`src/sw.js` is a cache-first service worker with an **explicit, hand-maintained resource list** and a
`cacheName` version string (bump it when the cached asset set changes). SW registration in
`src/index.html`/`index.js` is currently commented out ("stable version only") — enable deliberately.

## Conventions when editing

- New JS follows the existing functional style in `functions.js` (small pure helpers like `exists`,
  `first`, `last`, `equals`, `clamp`). Prefer reusing these over ad-hoc checks.
- To add state: add the field + default to the `db` object in `db.js`, add a model in `models.js` if
  it needs derivation, register a `ui:*` reducer, and have views `xf.sub` to the resulting `db:*`.
- Keep testable domain logic out of Web Components and in a pure module (the `designer-model.js`
  pattern) so it can be covered without a DOM.
