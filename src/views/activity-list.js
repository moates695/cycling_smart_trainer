//
// WATTS overhaul — Completed tab (recorded activities).
//
// Renders each saved activity as a summary row (mini recorded-power profile,
// name + date, duration, avg power, NP · TSS, avg HR) that expands in place
// to a Ride Analysis graph: the planned interval bars dimmed underneath the
// recorded power / heart-rate / cadence traces. Activities saved before the
// summary metrics existed render with — placeholders and a "no recorded
// data" note instead of the graph.
//
import { xf, exists, empty, equals } from '../functions.js';
import { models } from '../models/models.js';
import { toPoints, zoneClassByPct } from './watts.js';

// how many activities to reveal per page (initial view and each "Load more").
const ACTIVITY_PAGE = 8;

// number of bars in the mini recorded-power thumbnail.
const MINI_BARS = 18;

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// average-bucket resample of a numeric series down to n points.
function resample(values, n) {
    const len = values?.length ?? 0;
    if(len === 0) return [];
    if(len <= n) return values.slice();
    const out = [];
    for(let i = 0; i < n; i++) {
        const start = Math.floor((i * len) / n);
        const end = Math.max(start + 1, Math.floor(((i + 1) * len) / n));
        let sum = 0;
        for(let j = start; j < end; j++) sum += values[j];
        out.push(sum / (end - start));
    }
    return out;
}

// mini thumbnail of the actually-recorded power, zone-coloured against the
// FTP the ride was done at.
function miniRecordedHtml(data) {
    const powers = data.trace?.p;
    if(empty(powers ?? [])) {
        return `<div class="watts-amini"><div class="watts-amini--none"></div></div>`;
    }
    const ftp = data.ftp || 200;
    const bars = resample(powers, MINI_BARS).map((p) => {
        const pct = (p / ftp) * 100;
        const height = Math.max(8, Math.min(100, (pct / 150) * 100));
        return `<div class="watts-amini--bar zone-${zoneClassByPct(pct)}"
                     style="height: ${height}%;"></div>`;
    }).join('');
    return `<div class="watts-amini">${bars}</div>`;
}

// the vertical zone gradient the recorded-power line is stroked with
// (`actGrad` in the design reference). Ids are global in SVG, so each
// activity gets its own.
function powerGradientDefs(gradId) {
    return `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ef4444"></stop><stop offset="0.12" stop-color="#ef4444"></stop>
        <stop offset="0.25" stop-color="#f97316"></stop><stop offset="0.35" stop-color="#eab308"></stop>
        <stop offset="0.45" stop-color="#22c55e"></stop><stop offset="0.57" stop-color="#3d8bfd"></stop>
        <stop offset="0.80" stop-color="#3b4250"></stop><stop offset="1" stop-color="#3b4250"></stop>
    </linearGradient></defs>`;
}

// Ride Analysis: dimmed planned bars + power/HR/cadence overlays + axes.
function analysisHtml(data) {
    const trace = data.trace;
    if(empty(trace?.p ?? [])) {
        return `<div class="watts-aexp--nodata">No recorded data for this ride.</div>`;
    }

    const ftp = data.ftp || 200;
    const gradId = `actGrad-${data.id}`;

    // FTP axis: 150 / 100 / 50 / 0 %FTP with watt values.
    const axis = [150, 100, 50, 0].map((pct) => {
        const top = 100 - (pct / 150) * 100;
        const watts = Math.round((pct / 100) * ftp);
        return `<span style="top: ${top}%;"><b>${pct}%</b><i>${watts}W</i></span>`;
    }).join('');

    // planned interval bars, dimmed underneath the recorded traces.
    const plan = data.plan ?? [];
    const dense = plan.length > 24 ? ' is-dense' : '';
    const bars = plan.map((seg) => {
        const height = Math.max(4, Math.min(100, (seg.pct / 150) * 100));
        return `<div class="watts-wprof--seg" style="flex-grow: ${Math.max(1, seg.d)};">
                    <div class="watts-wprof--bar zone-${zoneClassByPct(seg.pct)}"
                         style="height: ${height}%;"></div>
                </div>`;
    }).join('');

    const powPts = toPoints(trace.p ?? [], 0, ftp * 1.5);
    const hrPts  = toPoints(trace.h ?? [], 90, 180);
    const cadPts = toPoints(trace.c ?? [], 40, 120);

    const total = data.duration ?? 0;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const mins = Math.round((total * f) / 60);
        return `<span class="watts-wprof--tick" style="left: ${f * 100}%;">${mins}:00</span>`;
    }).join('');

    return `
        <div class="watts-aexp--head">
            <span class="watts-aexp--label">Ride Analysis</span>
            <div class="watts-aexp--legend">
                <span><i class="watts-aexp--swatch watts-aexp--swatch-pow"></i>POWER</span>
                <span><i class="watts-aexp--swatch watts-aexp--swatch-hr"></i>HR</span>
                <span><i class="watts-aexp--swatch watts-aexp--swatch-cad"></i>CAD</span>
            </div>
        </div>
        <div class="watts-aprof">
            <div class="watts-wprof--axis">${axis}</div>
            <div class="watts-aprof--plot">
                <div class="watts-wprof--grid" style="top: 33.3%;"></div>
                <div class="watts-wprof--grid" style="top: 66.6%;"></div>
                <div class="watts-aprof--bars${dense}">${bars}</div>
                <svg class="watts-aprof--overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
                    ${powerGradientDefs(gradId)}
                    <polyline points="${cadPts}" fill="none" stroke="#38bdf8" stroke-width="1.5"
                              vector-effect="non-scaling-stroke" stroke-linejoin="round" opacity="0.85"></polyline>
                    <polyline points="${hrPts}" fill="none" stroke="#ff5470" stroke-width="1.5"
                              vector-effect="non-scaling-stroke" stroke-linejoin="round" opacity="0.9"></polyline>
                    <polyline points="${powPts}" fill="none" stroke="url(#${gradId})" stroke-width="2"
                              vector-effect="non-scaling-stroke" stroke-linejoin="round"></polyline>
                </svg>
            </div>
            <div class="watts-aprof--raxis">
                <span class="is-hr" style="top: -5px;">180</span>
                <span class="is-hr" style="top: calc(50% - 5px);">135</span>
                <span class="is-hr" style="bottom: -2px;">90</span>
                <span class="is-hr is-unit" style="bottom: -16px;">bpm</span>
                <span class="is-cad" style="top: -5px;">120</span>
                <span class="is-cad" style="top: calc(50% - 5px);">80</span>
                <span class="is-cad" style="bottom: -2px;">40</span>
                <span class="is-cad is-unit" style="bottom: -16px;">rpm</span>
            </div>
        </div>
        <div class="watts-aprof--time">
            <div class="watts-wprof--timespacer"></div>
            <div class="watts-wprof--ticks">${ticks}</div>
            <div class="watts-aprof--rspacer"></div>
        </div>`;
}

class ActivityList extends HTMLElement {
    constructor() {
        super();
        this.activities = [];
        this.shown = ACTIVITY_PAGE;
    }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        xf.sub('activity:add', self.onAdd.bind(this), this.signal);
        xf.sub('db:activity', self.onRestore.bind(this), this.signal);
        // switching library tabs collapses any open expanded row.
        xf.sub('action:nav', self.onNav.bind(this), this.signal);
        this.addEventListener('pointerup', self.onClick.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onNav(action) {
        if(String(action).startsWith('workouts')) {
            this.querySelectorAll('activity-item.is-expanded')
                .forEach((item) => item.collapse?.());
        }
    }
    onClick(e) {
        if(e.target.closest('.activity--load-more')) {
            this.shown += ACTIVITY_PAGE;
            this.renderList();
        }
    }
    onAdd(activity) {
        // newest first, and make sure the just-finished ride is visible
        this.activities.unshift(activity);
        this.shown += 1;
        this.renderList();
        xf.dispatch(`action:activity:${this.id(activity)}`, ':toggleExpand');
    }
    onRestore(activities) {
        this.activities = [...(activities ?? [])]
            .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        this.shown = ACTIVITY_PAGE;
        this.renderList();
    }
    renderList() {
        if(empty(this.activities)) {
            this.innerHTML = `<div class="watts-aempty">No completed rides yet. Finished workouts are saved here automatically.</div>`;
            return;
        }
        const shown = Math.min(this.shown, this.activities.length);
        const rows = this.activities
            .slice(0, shown)
            .map((a, i) => this.template(i, a))
            .join('');
        const remaining = this.activities.length - shown;
        const more = remaining > 0
            ? `<button class="activity--load-more">Load more (${remaining})</button>`
            : '';
        this.innerHTML = rows + more;
    }
    id(data) {
        return data.id;
    }
    name(data) {
        return esc(data.name);
    }
    // "Wed · Jul 22", with the year only when it isn't the current year
    // ("Tue · Dec 30, 2025").
    date(data) {
        const d = new Date(data.timestamp);
        const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
        const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const year = equals(d.getFullYear(), new Date().getFullYear())
            ? '' : `, ${d.getFullYear()}`;
        return `${weekday} · ${monthDay}${year}`;
    }
    // total minutes : seconds, e.g. "57:12", "90:31".
    duration(data) {
        const value = Math.max(0, Math.round(data.duration ?? 0));
        const mins = Math.floor(value / 60);
        const secs = String(value % 60).padStart(2, '0');
        return `${mins}:${secs}`;
    }
    metricCell(value, extraClass = '') {
        if(!exists(value)) {
            return `<div class="watts-arow--num is-missing ${extraClass}">—</div>`;
        }
        return `<div class="watts-arow--num ${extraClass}">${value}</div>`;
    }
    template(i, data) {
        const id = this.id(data);
        const avgPower = exists(data.avgPower) ? `${data.avgPower} W` : undefined;
        const npTss = (exists(data.np) && exists(data.tss))
            ? `${data.np} · ${data.tss}` : undefined;
        const avgHr = exists(data.avgHeartRate) ? `${data.avgHeartRate} bpm` : undefined;

        return `
            <activity-item id="i${i}--activity--item" class="watts-arow" data-id="${id}">
                <div class="watts-arow--head">
                    <div class="watts-arow--main">
                        ${miniRecordedHtml(data)}
                        <div>
                            <div class="watts-arow--name">${this.name(data)}</div>
                            <div class="watts-arow--date">${this.date(data)}</div>
                        </div>
                    </div>
                    ${this.metricCell(this.duration(data))}
                    ${this.metricCell(avgPower)}
                    ${this.metricCell(npTss)}
                    ${this.metricCell(avgHr, 'watts-arow--hr')}
                    <span class="watts-chev">⌄</span>
                </div>
                <div class="watts-arow--expand" hidden>
                    ${analysisHtml(data)}
                    <div class="watts-aexp--foot">
                        <view-action
                            class="watts-btn watts-btn--chip"
                            action=":download"
                            topic=":activity:${id}"
                            stoppropagation>Download .fit</view-action>
                        <view-action
                            class="watts-btn watts-btn--danger"
                            action=":remove"
                            topic=":activity:${id}"
                            stoppropagation>Delete</view-action>
                    </div>
                </div>
            </activity-item>
        `;
    }
}

customElements.define('activity-list', ActivityList);

class ActivityItem extends HTMLElement {
    constructor() {
        super();
        this.isExpanded = false;
    }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        this.id = this.dataset.id;
        this.head = this.querySelector('.watts-arow--head');
        this.expandCont = this.querySelector('.watts-arow--expand');
        this.chev = this.querySelector('.watts-chev');

        xf.sub(`action:activity:${self.id}`, this.onAction.bind(this), this.signal);
        this.head.addEventListener('pointerup', this.onHeadClick.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onHeadClick() {
        this.toggleExpand();
    }
    toggleExpand() {
        if(this.isExpanded) {
            this.collapse();
        } else {
            this.expand();
        }
    }
    expand() {
        // accordion: only one row open at a time.
        document.querySelectorAll('activity-item.is-expanded').forEach((item) => {
            if(!equals(item, this)) item.collapse?.();
        });
        this.expandCont.hidden = false;
        this.classList.add('is-expanded');
        this.chev.textContent = '⌃';
        this.isExpanded = true;
    }
    collapse() {
        this.expandCont.hidden = true;
        this.classList.remove('is-expanded');
        this.chev.textContent = '⌄';
        this.isExpanded = false;
    }
    onAction(action) {
        if(action === ':toggleExpand') {
            this.toggleExpand();
            return;
        }
        if(action === ':remove') {
            models.activity.remove(this.id);
            this.remove();
            return;
        }
        if(action === ':download') {
            models.activity.download(this.id);
            return;
        }
    }
}

customElements.define('activity-item', ActivityItem);
