# Handoff: WATTS — Smart Trainer App UI Overhaul

## Overview
WATTS is a browser-based indoor cycling smart-trainer app (in the "open trainer" family). This handoff covers a full dark-mode UI overhaul that is **data-first and intuitive**. Three primary screens are covered, with a bottom nav switching between them:

- **Home** — the live-ride screen (real-time metrics + workout profile graph + ride controls)
- **Workouts** — library with sub-tabs: My Workouts, Default, Completed, Editor
- **Settings** — sub-tabs: Trainer (rider profile, options, connected devices) and Account (login)

The design replaces the original's full-width segmented rows (with plain-text headings) with grouped cards and clear section headers.

## About the Design Files
The file in this bundle (`Trainer.dc.html`) is a **design reference created in HTML** — a prototype showing intended look and behavior, **not production code to copy directly**. It is a single self-contained streaming component built in a bespoke "Design Component" runtime (a small React-on-the-fly template system); do **not** try to reuse that runtime.

The task is to **recreate these designs in the target codebase's existing environment** (React, Vue, SwiftUI, native, etc.) using its established patterns, component library, and charting approach. If no environment exists yet, choose the most appropriate framework for the project and implement there. The graphs are drawn with plain SVG polylines + flex/absolute-positioned bars; in a real app prefer the codebase's charting library (or keep lightweight SVG) — the important thing is matching the visual result and data mapping described below.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and interactions are specified. Recreate the UI pixel-accurately using the codebase's existing libraries and patterns. Exact hex values, font sizes, and layout metrics are given below.

---

## Design Tokens

### Color — surfaces & text (cool near-black, low saturation)
| Token | Hex | Use |
|---|---|---|
| Page background | `#0e1015` | app background |
| Panel / card | `#15181f` | primary cards |
| Card gradient (hero) | `linear-gradient(135deg,#181c24,#14171e)` and `linear-gradient(180deg,#181c24,#14171e)` | power hero, profile card, sign-in card |
| Inset / control bg | `#171a21` | nav bar, control pills, steppers |
| Sunken field bg | `#12141a` | inputs, expanded-panel background |
| Chip / button bg | `#1c2129` | secondary buttons, chips, toggles-off |
| Divider / grid line | `#22262f` (solid), `rgba(255,255,255,.06–.12)` (borders/gridlines) |
| Text primary | `#eef1f6` | values, headings |
| Text secondary | `#c4cbd6` | labels on controls |
| Text muted | `#8b93a3` | section labels, units |
| Text faint | `#7f8798` / `#626b7a` / `#5f6775` | tick labels, meta |

### Color — accent & data
| Token | Hex | Use |
|---|---|---|
| **Primary accent (volt/lime)** | `#c8f651` (hover `#dcff7a`) | active nav/tabs, primary buttons, key highlights, position marker, "in-zone" indicators, ERG mode |
| Heart rate | `#ff5470` | HR values & trace |
| Cadence | `#38bdf8` | cadence trace & axis |
| Power line (recorded) | zone gradient (below); legend swatch `linear-gradient(90deg,#3b4250,#3d8bfd,#22c55e,#eab308,#f97316,#ef4444)` |

### Power zones (Coggan 7-zone) — used for interval bars, FTP gauge, power-line color
| Zone | %FTP range | Hex |
|---|---|---|
| Z1 recovery | ≤55% | `#3b4250` |
| Z2 endurance | 55–75% | `#3d8bfd` |
| Z3 tempo | 75–90% | `#22c55e` |
| Z4 threshold | 90–105% | `#eab308` |
| Z5 VO2 | 105–120% | `#f97316` |
| Z6 anaerobic | 120–150% | `#ef4444` |
| Z7 neuromuscular | >150% | `#a855f7` |

`colorByPct(p)`: `p<=55→#3b4250, <=75→#3d8bfd, <=90→#22c55e, <=105→#eab308, <=120→#f97316, <=150→#ef4444, else #a855f7`.

### Typography
- **Numerals / labels / UI:** `Barlow Semi Condensed` (weights 500/600/700). Used for all metric numbers, section labels (uppercase, tracked), buttons. Enable `font-variant-numeric: tabular-nums` globally.
- **Body / descriptions:** `Barlow` (400/500/600).
- Both from Google Fonts.
- Section/eyebrow label pattern: `font: 600 11–13px 'Barlow Semi Condensed'; letter-spacing: .12–.16em; text-transform: uppercase; color:#8b93a3` (or `#7f8798`).
- Hero power number: `700 104px 'Barlow Semi Condensed'; line-height:.82; letter-spacing:-.02em`.
- Secondary metric value: `700 44px 'Barlow Semi Condensed'; line-height:.9`.

### Spacing / radius / misc
- Card radius: `18px` (large), `16px`, `14px` (rows/tiles). Pills: `999px`. Buttons: `10–12px`.
- Card padding: `20–28px`. Grid gaps: `12–16px` (cards), `24–28px` (metric grid).
- Card border: `1px solid rgba(255,255,255,.06–.07)`.
- Content max-width: Home `1360px`; Workouts/Settings `1120px`. Horizontal page padding `32px`.
- Keyframes: `rattle` (lock shake): `0/100%{translateX(0) rotate(0)} 15%{-3px,-7deg} 30%{3px,7deg} 45%{-3px,-6deg} 60%{2px,5deg} 75%{-2px,-3deg}`, duration `.52s ease`.

---

## Screens / Views

### App shell
- Full-height flex column: scrollable `<main>` + fixed bottom `<nav>`.
- **Bottom nav** (`#12141a`, top border `rgba(255,255,255,.07)`): three centered items with 64px gap — **Settings** (gear ⚙), **Home** (house ⌂), **Workouts** (list ☰). Icon 20px + uppercase 11px label. Active item colored accent `#c8f651`, inactive `#7f8798`.
- Brand mark: bright-green (`#c8f651`) lightning-bolt SVG + "WATTS" wordmark (`700 20px 'Barlow Semi Condensed'; letter-spacing:.24em`). SVG path: `M13 2 L4 13 h6 l-1 9 l9-12 h-6 z` with `drop-shadow(0 0 8px rgba(200,246,81,.6))`.

### 1. HOME (live ride)
Top bar: brand + `|` divider + current workout name ("Dijon") + category chip ("VO2 MAX" in `#f97316`). Right: connection status pills ("KICKR CORE", "POLAR H10") each with green dot `#22c55e` + glow.

**Data panel** — ONE unified card (`#15181f`, radius 18), NO internal separators between metrics. Flex row: content area (left) + thin vertical FTP gauge (right, `border-left` divider).
- Top sub-row (vertically centered, gap 32): **Power hero** + **Target** + **Power History**.
  - **Power hero:** label "POWER" + zone chip ("Z5 · VO2", `#f97316`, pill). Value `248` at 104px + unit "W" (`#8b93a3`) + "3.31 W/kg" (`#c8f651`).
  - **Target** (compact, width ~150px): label "TARGET"; `240` at 48px in `#f97316` + "W"; sub "120% FTP · +8 W" (delta in `#22c55e`); short adherence bar (height 8px, `#22262f` track, `linear-gradient(90deg,#f97316,#fbbf24)` fill to 74%, white target tick at 75%).
  - **Power History** (flex:1): label "POWER HISTORY" + window buttons `1m / 5m / 30m` (5m active = accent). 100px-tall SVG trace, stroke = **vertical zone gradient** (id `pwrGrad`, top=high power purple→red→orange→yellow→green→blue→gray bottom, blended soft stops); dashed 170% (top) & 100% gridlines.
- Metric grid (4 cols × 2 rows, gap 26×28), label + value (44px). Order: **Heart Rate** (158 bpm, value `#ff5470`, + recent coral sparkline), **Cadence** (96 rpm), **Interval Left** (0:30, `#c8f651`), **Elapsed** (09:30), **Power Lap** (244 W, **value colored by FTP % via colorByPct** → 122%→`#ef4444`), **Speed** (39.4 km/h), **Distance** (6.2 km), **Time Left** (18:30).
- **FTP gauge** (right, width 58, thin 12px bar): vertical zone gradient bottom→top, scale **0%→170%** with Z7 purple band at top; white marker line + "124%" label at current power %; "% FTP" caption. `170%` top / `0%` bottom labels.

**Workout Profile card** (`#15181f`, radius 18):
- Header: "WORKOUT PROFILE" + zoom controls `[−] [+] [FIT] [⌖ NOW]` (pill group; FIT resets zoom to whole workout, NOW scrolls current marker into view). Right: legend POWER (zone-gradient swatch) / HR (`#ff5470`) / CAD (`#38bdf8`) + "FTP 200 W · 28:00".
- Body flex: **left FTP axis** (56px: 150/100/50/0% with W values) + **scroll viewport** (horizontal scroll; inner width = `zoom*100%`, min 100%) + **right axes** (90px: HR coral 180/135/90 bpm, cadence sky 120/80/40 rpm).
- Plot: L-shaped border; dashed 33.3%/66.6% gridlines; **interval bars** (flex-grow by segment duration in seconds, height = `%FTP/150*100` capped 100, colored by zone). ON-blocks show watt label above + duration label below. **Overlays (SVG polylines, `vector-effect:non-scaling-stroke`):** cadence (`#38bdf8`), HR (`#ff5470`), power (stroke `url(#pwrGradProf)` — vertical zone gradient calibrated 0–150%). Traces run from start to the current position only.
- **Position marker:** vertical 2px `#c8f651` line + 10px dot, glow, at `elapsed/total %`.
- Time axis below plot: 0:00 / 5:00 / … ticks (right-spacer matches right-axis width so it aligns).

**Control bar** (centered): transport group `[⏮ prev] [⏸ pause/play (accent, 56px)] [⏹ stop (`#ff5470`)] [⏭ next]` · divider · "ERG" mode label (fixed — ERG only, no resistance/slope) · target stepper `[−] 240 W [+]` · **lock button** (🔒/🔓).

### 2. WORKOUTS
Top bar: brand + tabs `My Workouts | Default | Completed | Editor` (active tab = `#1c2129` bg pill).

- **My Workouts:** heading + subtitle; actions `[Load Workout]` (accent, contains hidden file input) + `[New in Editor]`. Note "Accepts .zwo workouts and .fit course files." List of saved rows.
- **Default Workouts:** list of preset rows.
- Each **workout row** (`#15181f`, radius 14, clickable, `cursor:pointer`): mini bar-profile thumbnail (130px, zone-colored bars) · name + one-line description · category label (zone-colored) · duration · `[START]` pill · chevron `⌄`/`⌃`.
- **Row expands IN PLACE** (accordion) directly beneath the clicked row (chevron flips, `#12141a` panel). Expanded content = the **full segmented workout-profile graph** (same as Home: FTP axis 150/100/50/0%, zone-colored interval bars with watt labels, time axis) + description + `[Start Workout]`.
- **Completed Workouts** (renamed from original "Activities"): column headers (Workout / Duration / Avg Power / NP · TSS / Avg HR). Rows: mini profile of **actually-recorded** power (slightly irregular vs. planned) · name + date (**show year only if not current year**, e.g. "Wed · Jul 22" vs "Tue · Dec 30, 2025") · duration · avg power · NP·TSS · avg HR (`#ff5470`) · chevron.
- **Completed row expands in place** to a **Ride Analysis** graph: the dimmed (opacity .4) planned interval bars with **power (zone gradient `actGrad`), HR (coral), and cadence (sky) line overlays on top**, FTP left axis (150/100/50/0%), **HR right axis** (180/135/90 bpm coral) + **cadence right axis** (120/80/40 rpm sky), time axis, and a POWER/HR/CAD legend.
- **Editor:** name field, category select, Load…/Clear, big editable profile graph (150%/100%/50% gridlines; warmup ramp via clip-path, sweet-spot block green with "176W · 10:00" label, cooldown gray), block table (# / Duration / Start / End / Cadence / Slope / row actions ↑↓✕), "+ ADD BLOCK", `[Save to Library]` + `[Download .zwo]`.

### 3. SETTINGS
Top bar: brand + tabs `Trainer | Account` (Trainer first, default).

- **Trainer tab:**
  - **Rider Profile** card (gradient): three metrics inline separated by **thin vertical dividers** (`1px rgba(255,255,255,.1)`): **FTP** `200 W` (value `#c8f651`, editable in place, `contentEditable`, ~3-digit min-width, accent underline, pencil ✎ button beside label) · **Weight** `75 kg` (editable, white underline, pencil) · **FTP / kg** `2.67 W/kg` (derived).
  - **Options** card: Units (Metric/Imperial segmented, Metric active) · Sound (slider ~40%) · **Lock controls by default** (toggle, ON — accent track).
  - **Connected Devices:** "CONNECTED DEVICES" label + 2-col grid of device cards. Each: BLE icon · type label + device name · status pill (CONNECTED green dot / CONNECT gray) · metric chips (label + value; on-chips accent-tinted, off-chips muted "off"). Devices: Controllable (KICKR CORE — Power 248 W, Cadence 96, Speed 39.4), Power Meter (Assioma DUO — Power 251 W, Cadence 95, Speed off), Heart Rate (Polar H10 — 158 bpm coral), Speed & Cadence (unpaired), Muscle Oxygen (Moxy — SmO₂ 64%, THb 12.4), Core Temp (CORE — connect).
- **Account tab:** two columns. Left = sign-in card (gradient): "SIGN IN TO WATTS" + subtitle; Email field, Password field (Forgot? link accent), `[Sign In]` (accent), "OR" divider, `[Google] [Apple]`, "New here? Create an account". Right = "WHY SIGN IN" benefits (Cloud sync, Auto-upload activities, Training history) + "Not signed in / Riding as a guest" card.

---

## Interactions & Behavior
- **Bottom nav** switches screens; **tabs** switch sub-views (Workouts + Settings). Active state = accent color / pill bg.
- **Workout rows** toggle an inline expansion (only one open at a time); chevron reflects state. Tab change collapses any open row.
- **Home layout toggle:** none (single "Focus" layout — an earlier Cockpit variant was removed).
- **Zoom/scroll (profile):** `−`/`+` step zoom (clamp 1×–6×); FIT → zoom 1× and scrollLeft 0; ⌖ NOW → center current marker (`scrollLeft = pos% * scrollWidth − clientWidth/2`). Zoom change re-centers on current when zoomed in.
- **Lock system:** controls default **locked**. Lock button toggles 🔒/🔓. Prev/next transport + progress-bar seek are only active when unlocked; tapping them while locked triggers a **rattle** shake animation on the lock button (`.52s`, `rattle` keyframes; cleared after ~520ms). The "Lock controls by default" setting reflects/controls this.
- **Editable FTP/Weight:** `contentEditable` spans; commit on blur in a real app.
- Transitions: nav/tab color `.15s`; toggle knob/track `.15s`.

## State Management
- `screen`: `'home' | 'workouts' | 'settings'`.
- `tab` (Workouts): `'my' | 'default' | 'completed' | 'editor'`.
- `stab` (Settings): `'trainer' | 'account'` (default `'trainer'`).
- `expanded`: id of the currently expanded workout row (`null` = none). ids like `p:<name>` (plan) / `a:<name>` (activity).
- `locked`: boolean (default `true`). `rattle`: transient boolean for the shake.
- `zoom`: number 1–6 for the profile graph; plus a ref to the scroll viewport for FIT/NOW.
- Live-ride metrics (power, target, HR, cadence, speed, distance, elapsed, interval-left, power-lap, W/kg) — in the prototype these are static realistic values; in production they stream from BLE sensors.

### Data mapping notes (for graphs)
- Bar height = `min(%FTP / 150 * 100, 100)`; watts = `%FTP/100 * FTP`.
- Marker/trace x = `elapsedSeconds / totalSeconds * 100` (percent of full width).
- Power trace color: map power→%FTP→zone via a vertical SVG gradient so the line color reflects output (see `pwrGrad`/`pwrGradProf`/`actGrad` stop sets in the file).
- HR axis 90–180 bpm; cadence axis 40–120 rpm; both mapped to full plot height.
- Recorded power should visually follow the target segments (ERG) with small realistic variance.

## Assets
- **Fonts:** Google Fonts — Barlow, Barlow Semi Condensed.
- **Logo:** inline SVG lightning bolt (path given above) — no external asset.
- **Icons:** currently Unicode glyphs (⚙ ⌂ ☰ ⏮ ⏸ ⏹ ⏭ 🔒 🔓 ✎ ⌖ ⋮ chevrons) and a BLE glyph. Replace with the codebase's icon set (e.g. Lucide/SF Symbols) in production.
- **Device/product names** (KICKR CORE, Assioma DUO, Polar H10, Moxy, CORE) are illustrative sample data.
- No raster images or logos from third parties are used.

## Files
- `Trainer.dc.html` — the complete design reference (all three screens + sub-tabs + expansions). Open in a browser to inspect exact rendering, colors, and interactions. The template markup shows structure; the logic class at the bottom holds the sample data and the graph/zoom/lock/expansion behavior.
- `screenshots/` — reference renders: `01-home.png`, `02-workouts-my.png`, `03-workouts-default.png`, `04-completed-expanded.png` (ride analysis with power/HR/cadence overlays + axes), `05-editor.png`, `06-settings-trainer.png`, `07-settings-account.png`. Captured at ~900px wide; the design canvas is 1360px (Home) / 1120px (Workouts, Settings), so some right-edge content (e.g. the profile's HR/cadence axes) sits just beyond these crops — see the live file for full width.
