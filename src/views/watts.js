//
// WATTS UI overhaul — Home screen derived-data components
//
// These are small custom elements that compute the "data-first" values the
// WATTS design (design_handoff_watts_trainer) asks for but that the app did not
// previously surface: live W/kg, a rolling power-history trace, an FTP gauge, a
// target-adherence bar, the power zone chip, and remaining workout time.
//
// They follow the same conventions as the rest of src/views: a native
// HTMLElement that sets up an AbortController in connectedCallback, subscribes
// to `db:*` events on the xf store, and tears the subscriptions down in
// disconnectedCallback. Pure/DOM-free maths is kept in tiny helpers so it stays
// readable.
//
import { xf, exists, clamp, last } from '../functions.js';
import { formatTime } from '../utils.js';
import { workoutCategoryColor, WORKOUT_CATEGORY_FALLBACK_COLOR } from '../workouts/categories.js';

//
// Coggan 7-zone model, expressed as %FTP upper bounds + the design's colours.
// See README "Power zones (Coggan 7-zone)" / `colorByPct`.
//
const wattsZones = [
    { max: 55,       color: '#3b4250', short: 'Z1', name: 'Recovery'  },
    { max: 75,       color: '#3d8bfd', short: 'Z2', name: 'Endurance' },
    { max: 90,       color: '#22c55e', short: 'Z3', name: 'Tempo'     },
    { max: 105,      color: '#eab308', short: 'Z4', name: 'Threshold' },
    { max: 120,      color: '#f97316', short: 'Z5', name: 'VO2'       },
    { max: 150,      color: '#ef4444', short: 'Z6', name: 'Anaerobic' },
    { max: Infinity, color: '#a855f7', short: 'Z7', name: 'Neuro'     },
];

function zoneByPct(pct) {
    return wattsZones.find((z) => pct <= z.max) ?? wattsZones[0];
}

function colorByPct(pct) {
    return zoneByPct(pct).color;
}

// The legacy `.zone-*` CSS classes (one..seven) map 1:1 to --watts-z1..z7,
// which are the same Coggan colours as `wattsZones`. Expose the class name for
// a given %FTP so other views (e.g. the workout profile) can colour by these
// boundaries instead of the older `models.ftp` zone model.
const zoneClasses = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];

function zoneClassByPct(pct) {
    const i = wattsZones.findIndex((z) => pct <= z.max);
    return zoneClasses[i] ?? zoneClasses[zoneClasses.length - 1];
}

// Gradient stops for the zone colours along a sloped block, so a ramp that
// climbs through several zones is coloured by the zone it is in at each point
// rather than by one flat colour. One stop sits at the centre of each run of
// same-zone steps, which reads solid per zone and blends over about one step.
// `stepPowers` is in the same unit as `ftp` (watts).
function rampGradient(stepPowers, ftp) {
    const n      = stepPowers.length;
    const colors = stepPowers.map((p) => colorByPct((p / (ftp || 200)) * 100));
    const stops  = [];
    for(let i = 0; i < n; i += 1) {
        // Interior repeats add nothing to the blend — keep run endpoints only.
        if(colors[i] === colors[i - 1] && colors[i] === colors[i + 1]) continue;
        stops.push(`${colors[i]} ${(((i + 0.5) / n) * 100).toFixed(1)}%`);
    }
    // A single-colour ramp still needs two stops for a valid gradient.
    if(stops.length < 2) return `${colors[0] ?? '#3b4250'}, ${last(colors) ?? '#3b4250'}`;
    return stops.join(', ');
}

// Map a series of numbers to an SVG polyline `points` string within a
// (0..100 x 0..100) viewBox, clamped so the stroke never clips the edges.
// `xSpan` is how many samples the x-axis represents: pass a rolling window's
// capacity so a partly-filled buffer draws across its share of the width and
// fills in over time, instead of being stretched across the whole plot.
function toPoints(values, vmin, vmax, x0 = 0, x1 = 100, xSpan = values.length) {
    const n = values.length;
    if(n < 2) return '';
    const denom = Math.max(1, xSpan - 1);
    const span = (vmax - vmin) || 1;
    return values.map((v, i) => {
        const x = clamp(x0, x1, x0 + (i / denom) * (x1 - x0));
        const y = clamp(2, 98, 100 - ((v - vmin) / span) * 100);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
}

//
// <power-zone-chip> — "Z5 · VO2" pill, coloured by the current 1s power as a
// percentage of FTP.
//
class PowerZoneChip extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.power = 0;
        this.ftp = 200;
        xf.sub('db:power1s', (v) => { this.power = v; this.render(); }, this.signal);
        xf.sub('db:ftp',     (v) => { this.ftp = v || 200; this.render(); }, this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        const pct = (this.power / (this.ftp || 200)) * 100;
        const zone = zoneByPct(pct);
        this.textContent = `${zone.short} · ${zone.name}`;
        this.style.color = zone.color;
        this.style.borderColor = `${zone.color}66`;
        this.style.background = `${zone.color}1a`;
    }
}
customElements.define('power-zone-chip', PowerZoneChip);

//
// <zoned-value prop="db:powerLap"> — an integer metric whose text colour tracks
// its power zone (used for the Power Lap tile per the design).
//
class ZonedValue extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.prop = this.getAttribute('prop') || 'db:powerLap';
        this.value = 0;
        this.ftp = 200;
        xf.sub(this.prop,  (v) => { this.value = v; this.render(); }, this.signal);
        xf.sub('db:ftp',   (v) => { this.ftp = v || 200; this.render(); }, this.signal);
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        const v = Math.round(this.value ?? 0);
        this.textContent = isFinite(v) ? `${v}` : '--';
        const pct = (v / (this.ftp || 200)) * 100;
        this.style.color = v > 0 ? colorByPct(pct) : '';
    }
}
customElements.define('zoned-value', ZonedValue);

//
// <w-per-kg> — live power-to-weight, "3.31" style (unit lives in the markup).
//
class WPerKg extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.power = 0;
        this.weight = 75;
        this.innerHTML =
            `<span class="watts-hero--wkg-num">0.00</span>` +
            `<span class="watts-hero--wkg-unit">W/kg</span>`;
        this.num = this.querySelector('.watts-hero--wkg-num');
        xf.sub('db:power1s', (v) => { this.power = v; this.render(); }, this.signal);
        xf.sub('db:weight',  (v) => { this.weight = v || 75; this.render(); }, this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        const wkg = isFinite(this.power / (this.weight || 75))
              ? (this.power / (this.weight || 75)) : 0;
        // Number and unit are separate spans so the number can be right-aligned
        // in a fixed-width box (see .watts-hero--wkg-num) — otherwise "W/kg"
        // slides sideways every time the value gains or loses a digit. Double
        // figures drop a decimal to stay inside that 4-character box.
        this.num.textContent = wkg < 10 ? wkg.toFixed(2) : wkg.toFixed(1);
    }
}
customElements.define('w-per-kg', WPerKg);

//
// <target-info> — "120% FTP · +8 W": target as %FTP and the live power delta
// versus target (green when at/above, coral when below).
//
class TargetInfo extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.power = 0;
        this.target = 0;
        this.ftp = 200;
        xf.sub('db:power1s',    (v) => { this.power = v; this.render(); }, this.signal);
        xf.sub('db:powerTarget',(v) => { this.target = v; this.render(); }, this.signal);
        xf.sub('db:ftp',        (v) => { this.ftp = v || 200; this.render(); }, this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        const pct = Math.round((this.target / (this.ftp || 200)) * 100);
        const delta = Math.round(this.power - this.target);
        const sign = delta >= 0 ? '+' : '';
        const deltaColor = delta >= 0 ? '#22c55e' : '#ff5470';
        this.innerHTML =
            `${pct}% FTP · <span style="color:${deltaColor};">${sign}${delta} W</span>`;
    }
}
customElements.define('target-info', TargetInfo);

//
// <target-adherence> — thin bar showing live power as a fraction of a nominal
// scale, with a white tick at the target. Fill uses the design's amber gradient.
//
class TargetAdherence extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.power = 0;
        this.target = 0;
        this.ftp = 200;
        this.innerHTML =
            `<div class="watts-adherence--fill"></div>` +
            `<div class="watts-adherence--tick"></div>`;
        this.fill = this.querySelector('.watts-adherence--fill');
        this.tick = this.querySelector('.watts-adherence--tick');
        xf.sub('db:power1s',    (v) => { this.power = v; this.render(); }, this.signal);
        xf.sub('db:powerTarget',(v) => { this.target = v; this.render(); }, this.signal);
        xf.sub('db:ftp',        (v) => { this.ftp = v || 200; this.render(); }, this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        // Scale the bar to 0..(target * 1.35) so a well-matched effort sits at
        // ~74% with the target tick just ahead, matching the design proportion.
        const scaleMax = Math.max(this.target * 1.35, this.ftp * 0.5, 1);
        const fillPct = clamp(0, 100, (this.power / scaleMax) * 100);
        const tickPct = clamp(0, 100, (this.target / scaleMax) * 100);
        this.fill.style.width = `${fillPct}%`;
        this.tick.style.left = `${tickPct}%`;
    }
}
customElements.define('target-adherence', TargetAdherence);

//
// <power-history-graph> — a rolling power trace with 1m / 5m / 30m windows.
// Renders its own window switch and an SVG polyline stroked with the vertical
// zone gradient so the line's colour reflects output. The plot scales 0..170%
// FTP with dashed 100% / 170% gridlines drawn in CSS by the parent.
//

// Top of the power-history plot, in %FTP. Must match the gridline offsets in
// .watts-hist--grid-{top,mid,low}.
const HIST_MAX_PCT = 170;

// The zone bands a vertical trace is stroked with, top (`maxPct` %FTP) to
// bottom (0), as `<stop>` markup. Each band gets two stops at its own
// boundaries so the colours read as discrete zones rather than one smeared
// blend, and they are derived from `wattsZones` so they cannot drift from the
// zone model the chip, gauge and profile bars use. Shared by the power-history
// graph and the workout profile's recorded-power line, which have different
// ceilings — hence the parameter.
function zoneGradientStops(maxPct) {
    const top   = maxPct > 0 ? maxPct : HIST_MAX_PCT;
    const stops = [];
    let upper = top;
    // wattsZones runs low→high; walk it high→low so offset 0 is the top.
    for(let i = wattsZones.length - 1; i >= 0; i -= 1) {
        const lower = i === 0 ? 0 : wattsZones[i - 1].max;
        if(lower >= top) continue; // band sits entirely above the plot
        const from = (top - Math.min(upper, top)) / top;
        const to   = (top - lower) / top;
        const color = wattsZones[i].color;
        stops.push(`<stop offset="${from.toFixed(4)}" stop-color="${color}"/>`);
        stops.push(`<stop offset="${to.toFixed(4)}" stop-color="${color}"/>`);
        upper = lower;
    }
    return stops.join('');
}

let pwrGradSeq = 0;
class PowerHistoryGraph extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.buffer = [];       // one sample per power1s tick (~1s)
        this.maxLen = 1800;     // 30 min
        this.window = 300;      // 5 min default (active)
        this.ftp = 200;
        this.gradId = `pwrGrad${pwrGradSeq++}`;
        this.build();
        xf.sub('db:power1s', (v) => { this.push(v); }, this.signal);
        xf.sub('db:ftp',     (v) => { this.ftp = v || 200; this.render(); }, this.signal);
    }
    disconnectedCallback() { this.abortController.abort(); }
    build() {
        this.innerHTML = `
            <div class="watts-hist--head">
                <span class="watts-label">Power History</span>
                <div class="watts-seg watts-hist--windows">
                    <span data-window="60">1m</span>
                    <span data-window="300" class="active">5m</span>
                    <span data-window="1800">30m</span>
                </div>
            </div>
            <div class="watts-hist--plot">
                <div class="watts-hist--grid watts-hist--grid-top"><span>170%</span></div>
                <div class="watts-hist--grid watts-hist--grid-mid"><span>100%</span></div>
                <div class="watts-hist--grid watts-hist--grid-low"><span>50%</span></div>
                <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                        <!-- userSpaceOnUse pins the zone bands to the plot's own
                             0..170% FTP scale. The default (objectBoundingBox)
                             stretches them over the *stroke's bounding box*, so
                             a flat 150 W trace was painted with the whole
                             purple→grey ramp instead of its one zone colour. -->
                        <linearGradient id="${this.gradId}" gradientUnits="userSpaceOnUse"
                                        x1="0" y1="0" x2="0" y2="100">
                            ${zoneGradientStops(HIST_MAX_PCT)}
                        </linearGradient>
                    </defs>
                    <polyline fill="none" stroke="url(#${this.gradId})" stroke-width="2"
                              vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
                </svg>
            </div>`;
        this.line = this.querySelector('polyline');
        this.windows = this.querySelector('.watts-hist--windows');
        this.windows.addEventListener('pointerup', (e) => {
            const btn = e.target.closest('[data-window]');
            if(!btn) return;
            this.window = parseInt(btn.dataset.window, 10);
            this.windows.querySelectorAll('span').forEach((s) =>
                s.classList.toggle('active', s === btn));
            this.render();
        }, this.signal);
    }
    push(v) {
        this.buffer.push(v ?? 0);
        if(this.buffer.length > this.maxLen) this.buffer.shift();
        this.render();
    }
    render() {
        if(!this.line) return;
        const view = this.buffer.slice(-this.window);
        // top of the plot = 170% FTP so the dashed gridlines line up.
        const vmax = (this.ftp || 200) * (HIST_MAX_PCT / 100);
        // x is scaled by the *window*, not by how many samples we happen to
        // have, so the trace grows in from the left at 1 px/sec of real time
        // rather than being re-stretched across the plot on every tick.
        this.line.setAttribute('points', toPoints(view, 0, vmax, 0, 100, this.window));
    }
}
customElements.define('power-history-graph', PowerHistoryGraph);

//
// <metric-sparkline prop="db:heartRate" color="#ff5470" min="90" max="180"> —
// a tiny rolling trace for a single metric (used under Heart Rate).
//
class MetricSparkline extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.prop = this.getAttribute('prop') || 'db:heartRate';
        this.color = this.getAttribute('color') || '#ff5470';
        this.min = parseFloat(this.getAttribute('min') || '90');
        this.max = parseFloat(this.getAttribute('max') || '180');
        this.buffer = [];
        this.maxLen = 60;
        this.innerHTML = `
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <polyline fill="none" stroke="${this.color}" stroke-width="1.5"
                          vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
            </svg>`;
        this.line = this.querySelector('polyline');
        xf.sub(this.prop, (v) => { this.push(v); }, this.signal);
    }
    disconnectedCallback() { this.abortController.abort(); }
    push(v) {
        if(!isFinite(v) || v <= 0) return;
        this.buffer.push(v);
        if(this.buffer.length > this.maxLen) this.buffer.shift();
        this.line.setAttribute('points', toPoints(this.buffer, this.min, this.max));
    }
}
customElements.define('metric-sparkline', MetricSparkline);

//
// <ftp-gauge> — thin vertical zone-coloured gauge (0..170% FTP) with a white
// marker + "%" label at the current 1s power.
//
class FtpGauge extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.power = 0;
        this.ftp = 200;
        this.innerHTML = `
            <span class="watts-gauge--top">170</span>
            <div class="watts-gauge--bar">
                <div class="watts-gauge--marker"></div>
                <div class="watts-gauge--value">0%</div>
            </div>
            <span class="watts-gauge--bottom">0</span>
            <span class="watts-gauge--caption">% FTP</span>`;
        this.marker = this.querySelector('.watts-gauge--marker');
        this.valueEl = this.querySelector('.watts-gauge--value');
        xf.sub('db:power1s', (v) => { this.power = v; this.render(); }, this.signal);
        xf.sub('db:ftp',     (v) => { this.ftp = v || 200; this.render(); }, this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        const pct = (this.power / (this.ftp || 200)) * 100;
        const pos = clamp(0, 100, (pct / 170) * 100);
        this.marker.style.bottom = `${pos}%`;
        this.valueEl.style.bottom = `${pos}%`;
        this.valueEl.textContent = `${Math.round(pct)}%`;
    }
}
customElements.define('ftp-gauge', FtpGauge);

//
// <time-left> — remaining workout time (total workout duration − elapsed),
// mm:ss. Falls back to "--:--" for a free ride with no loaded workout.
//
class TimeLeft extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.elapsed = 0;
        this.duration = 0;
        xf.sub('db:elapsed', (v) => { this.elapsed = v; this.render(); }, this.signal);
        xf.sub('db:workout', (w) => {
            this.duration = w?.meta?.duration ?? 0;
            this.render();
        }, this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        if(!this.duration) { this.textContent = '--:--'; return; }
        const left = Math.max(0, this.duration - this.elapsed);
        this.textContent = formatTime({ value: left, format: 'mm:ss', unit: 'seconds' });
    }
}
customElements.define('time-left', TimeLeft);

//
// <workout-category> — the current workout's category label (e.g. "VO2 Max"),
// coloured by a simple category→zone-colour map, used in the Home top bar.
//
const categoryColor = workoutCategoryColor;
class WorkoutCategory extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        xf.sub('db:workout', (w) => {
            const cat = w?.meta?.category ?? '';
            this.textContent = cat;
            this.style.color = categoryColor[cat] ?? WORKOUT_CATEGORY_FALLBACK_COLOR;
            this.style.display = cat ? '' : 'none';
        }, this.signal);
    }
    disconnectedCallback() { this.abortController.abort(); }
}
customElements.define('workout-category', WorkoutCategory);

//
// <profile-avatar> — top-bar account button. Shows "?" when signed out and the
// account's first letter when signed in (the backend only knows an email, so
// that's the letter shown). Click opens Settings → Account.
//
class ProfileAvatar extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.signedIn = false;
        this.email = '';
        xf.sub('db:authState', this.onAuthState.bind(this), this.signal);
        xf.sub('db:accountEmail', this.onEmail.bind(this), this.signal);
        this.addEventListener('pointerup', this.onEffect.bind(this), this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    onAuthState(state) {
        this.signedIn = state === ':password:profile';
        this.render();
    }
    onEmail(email) {
        this.email = email ?? '';
        this.render();
    }
    onEffect() {
        xf.dispatch('ui:page-set', 'settings');
        xf.dispatch('action:nav', 'settings:profile');
    }
    render() {
        const known = this.signedIn && this.email.length > 0;
        this.textContent = known ? this.email[0].toUpperCase() : '?';
        this.classList.toggle('is-signed-in', known);
    }
}
customElements.define('profile-avatar', ProfileAvatar);

export {
    wattsZones,
    zoneByPct,
    zoneClassByPct,
    colorByPct,
    rampGradient,
    zoneGradientStops,
    toPoints,
};
