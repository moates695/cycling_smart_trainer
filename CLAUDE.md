# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A fork of **Auuki** (github.com/dvmarinoff/flux) — a browser-based PWA for running structured
cycling workouts on smart trainers. It talks to hardware directly via Web Bluetooth / Web Serial
(FTMS, Tacx FE-C over BLE, CPS power meters, HR monitors, Moxy), runs ERG / resistance / slope
modes, records `.FIT` activities, and syncs with Intervals.icu and Strava. Everything runs
client-side; there is no backend in this repo.

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

There is no lint step configured. Tests use `babel-jest` (see `.babelrc` — the `test` env
transforms ES modules to CommonJS) and `fake-indexeddb` for storage tests.

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
  Other `models/` files: `api.js`, `intervals.js`, `strava.js`, `training-peaks.js` (integrations),
  `auth.js`, `config.js`. The `wod` (workout-of-day / weekly planned workouts) logic lives in
  `models.js` and pulls from the Intervals.icu API.

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
