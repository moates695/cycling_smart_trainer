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
import { xf, exists, clamp } from '../functions.js';
import { formatTime } from '../utils.js';

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

// Map a series of numbers to an SVG polyline `points` string within a
// (0..100 x 0..100) viewBox, clamped so the stroke never clips the edges.
function toPoints(values, vmin, vmax, x0 = 0, x1 = 100) {
    const n = values.length;
    if(n < 2) return '';
    const span = (vmax - vmin) || 1;
    return values.map((v, i) => {
        const x = x0 + (i / (n - 1)) * (x1 - x0);
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
        xf.sub('db:power1s', (v) => { this.power = v; this.render(); }, this.signal);
        xf.sub('db:weight',  (v) => { this.weight = v || 75; this.render(); }, this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        const wkg = this.power / (this.weight || 75);
        this.textContent = `${wkg.toFixed(2)} W/kg`;
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
                <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                        <linearGradient id="${this.gradId}" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0"    stop-color="#a855f7"/>
                            <stop offset="0.10" stop-color="#a855f7"/>
                            <stop offset="0.21" stop-color="#ef4444"/>
                            <stop offset="0.34" stop-color="#f97316"/>
                            <stop offset="0.43" stop-color="#eab308"/>
                            <stop offset="0.52" stop-color="#22c55e"/>
                            <stop offset="0.62" stop-color="#3d8bfd"/>
                            <stop offset="0.82" stop-color="#3b4250"/>
                            <stop offset="1"    stop-color="#3b4250"/>
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
        const vmax = (this.ftp || 200) * 1.7;
        this.line.setAttribute('points', toPoints(view, 0, vmax));
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
            <span class="watts-gauge--top">170%</span>
            <div class="watts-gauge--bar">
                <div class="watts-gauge--marker"></div>
                <div class="watts-gauge--value">0%</div>
            </div>
            <span class="watts-gauge--bottom">0%</span>
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
const categoryColor = {
    'VO2 Max':    '#f97316',
    'VO2':        '#f97316',
    'HIIT':       '#ef4444',
    'Anaerobic':  '#ef4444',
    'Threshold':  '#eab308',
    'Sweet Spot': '#22c55e',
    'Tempo':      '#22c55e',
    'Base':       '#3d8bfd',
    'Endurance':  '#3d8bfd',
    'Recovery':   '#3b4250',
};
class WorkoutCategory extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        xf.sub('db:workout', (w) => {
            const cat = w?.meta?.category ?? '';
            this.textContent = cat;
            this.style.color = categoryColor[cat] ?? '#8b93a3';
            this.style.display = cat ? '' : 'none';
        }, this.signal);
    }
    disconnectedCallback() { this.abortController.abort(); }
}
customElements.define('workout-category', WorkoutCategory);

export {
    wattsZones,
    zoneByPct,
    zoneClassByPct,
    colorByPct,
    toPoints,
};
