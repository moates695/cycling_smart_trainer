// Graphical drag-and-drop workout designer.
//
// A self-contained Web Component that lets you build a structured workout by
// directly manipulating an SVG chart, and edit the same data as an ordered
// list of intervals below it. It produces standard .ZWO which is fed back
// through Auuki's existing parser (models.workout.parse) so saved workouts
// behave identically to imported ones.
//
// Editing model:
//   - click a bar's body   -> select it (does NOT change power)
//   - drag the top edge     -> shift the whole bar's power up/down (keeps ramp)
//   - drag a top corner     -> change just that end's power (makes a ramp)
//   - drag the right edge    -> change this bar's duration (pushes later bars)
//   - drag the left edge     -> move the boundary with the bar to its left
//                               (squishes/grows the immediate left neighbour)

import { xf, exists, first, empty } from '../functions.js';
import { models } from '../models/models.js';
import { uuid } from '../storage/uuid.js';
import { formatTime } from '../utils.js';
import {
    clamp,
    snapDuration,
    snapPower,
    Segment,
    segmentsFromIntervals,
    segmentsToZwo,
    copyName,
    MIN_DURATION,
    DURATION_SNAP,
} from '../workouts/designer-model.js';

// --- geometry -------------------------------------------------------------

function Geometry(args = {}) {
    const padL = 48;
    const padR = 16;
    const padT = 16;
    const padB = 30;
    const height = 320;

    let pxPerSec = args.pxPerSec ?? 0.5;
    let yMaxFrac = 1.6;

    function setPxPerSec(v) { pxPerSec = clamp(0.05, 6, v); }
    function getPxPerSec() { return pxPerSec; }

    function setYMaxFrac(segments) {
        const maxPower = segments.reduce(
            (m, s) => Math.max(m, s.powerStart, s.powerEnd), 0);
        yMaxFrac = Math.max(1.6, maxPower * 1.12);
    }

    function totalDuration(segments) {
        return segments.reduce((acc, s) => acc + s.duration, 0);
    }
    function contentWidth(segments) {
        return padL + padR + totalDuration(segments) * pxPerSec;
    }
    function xAt(seconds) { return padL + seconds * pxPerSec; }
    function yAt(frac) {
        const plot = height - padT - padB;
        return padT + plot - (frac / yMaxFrac) * plot;
    }
    function yBase() { return height - padB; }
    function pxToSeconds(px) { return px / pxPerSec; }
    function pxToFrac(px) {
        const plot = height - padT - padB;
        return ((height - padB - px) / plot) * yMaxFrac;
    }

    return {
        padL, padR, padT, padB, height,
        setPxPerSec, getPxPerSec, setYMaxFrac,
        totalDuration, contentWidth, xAt, yAt, yBase,
        pxToSeconds, pxToFrac,
        get yMaxFrac() { return yMaxFrac; },
    };
}

// pick a "nice" spacing (seconds) for time-axis ticks given the zoom level,
// aiming for roughly one tick every ~90px.
function niceTickSeconds(pxPerSec) {
    const target = 90;
    const raw = target / pxPerSec;
    const steps = [10, 15, 20, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600];
    for(const s of steps) { if(s >= raw) return s; }
    return steps[steps.length - 1];
}

// categories used by the built-in library (workouts.js) + the zwo.js default.
// The select also picks up any extra categories found in the user's library.
const CATEGORIES = [
    'Base', 'Recovery', 'Sweet Spot', 'Threshold', 'VO2 Max', 'HIIT', 'Test', 'Custom',
];

// --- component ------------------------------------------------------------

class WorkoutDesigner extends HTMLElement {
    constructor() {
        super();
        this.segments = [];
        this.selectedId = null;
        this.meta = {
            name: 'New Workout',
            author: 'Auuki',
            category: 'Sweet Spot',
            description: '',
        };
        this.ftp = 200;
        this.geometry = Geometry({});
        this.drag = null; // {id, role, start, startValue, edgeSeconds, ...}
        this.undoStack = [];
        this.redoStack = [];
        this._dragSnapshot = null;
        this._lastCornerTap = null;
        this.workouts = [];
        // library id of the entry this session saves to. null = the next save
        // creates a fresh (numbered) entry; set after the first save so later
        // saves update the same entry in place instead of piling up copies.
        this.currentWorkoutId = null;
        // true when the buffer holds edits not yet written to the library.
        this.dirty = false;
    }

    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };

        this.injectStyles();
        this.innerHTML = this.template();

        this.$svg = this.querySelector('.wd-svg');
        this.$summary = this.querySelector('.wd-summary');
        this.$list = this.querySelector('.wd-list');

        // toolbar
        this.on('.wd-load', 'click', () => this.openLoadPicker());
        this.on('.wd-clear', 'click', () => this.clearAll());
        this.on('.wd-undo', 'click', () => this.undo());
        this.on('.wd-redo', 'click', () => this.redo());
        this.on('.wd-fit', 'click', () => this.fitToWidth());
        this.on('.wd-zoom-in', 'click', () => this.zoom(1.4));
        this.on('.wd-zoom-out', 'click', () => this.zoom(1 / 1.4));
        this.on('.wd-save', 'click', () => this.save());
        this.on('.wd-download', 'click', () => this.download());
        this.$undo = this.querySelector('.wd-undo');
        this.$redo = this.querySelector('.wd-redo');

        // undo/redo keyboard shortcuts (ignored while typing in a field)
        window.addEventListener('keydown', this.onKeyDown.bind(this), this.signal);

        // meta fields (author is kept in this.meta but has no input — it is
        // written into the .ZWO silently)
        this.renderCategorySelect();
        ['name', 'category', 'description'].forEach((key) => {
            const el = this.querySelector(`.wd-meta-${key}`);
            if(el) {
                el.value = this.meta[key];
                el.addEventListener('input', (e) => {
                    this.meta[key] = e.target.value;
                    this.markDirty();
                }, this.signal);
            }
        });

        // pointer editing (listeners live on the svg for down, window for move/up)
        this.$svg.addEventListener('pointerdown', this.onPointerDown.bind(this), this.signal);
        this._onMove = this.onPointerMove.bind(this);
        this._onUp = this.onPointerUp.bind(this);

        // interval list is re-rendered often, so use delegated listeners on the
        // container (they survive innerHTML replacement).
        this.$list.addEventListener('click', this.onListClick.bind(this), this.signal);
        this.$list.addEventListener('change', this.onListChange.bind(this), this.signal);

        xf.sub('db:ftp', (ftp) => { this.ftp = ftp ?? this.ftp; this.render(); }, this.signal);
        xf.sub('db:workouts', (workouts) => {
            this.workouts = workouts ?? [];
            this.renderCategorySelect();
        }, this.signal);
        // "Edit" from a user workout row opens it here for in-place editing;
        // "Duplicate" (any workout) always loads it as a fresh, unsaved copy.
        xf.sub('ui:workout:edit', (id) => this.onEditRequest(id), this.signal);
        xf.sub('ui:workout:duplicate', (id) => this.onDuplicateRequest(id), this.signal);

        // guard against leaving with unsaved edits. Nav buttons switch tabs/pages
        // via pointerup; a capture-phase listener runs first so we can block the
        // switch and prompt before it happens.
        document.addEventListener('pointerup', this.onNavGuard.bind(this),
            { capture: true, signal: this.abortController.signal });

        if(empty(this.segments)) {
            this.segments = [
                Segment({ duration: 300, powerStart: 0.4, powerEnd: 0.6 }),
                Segment({ duration: 600, powerStart: 0.88 }),
                Segment({ duration: 300, powerStart: 0.5 }),
            ];
        }
        this.render();
    }

    disconnectedCallback() {
        this.abortController.abort();
        window.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup', this._onUp);
    }

    on(selector, type, handler) {
        const el = this.querySelector(selector);
        if(el) el.addEventListener(type, handler, this.signal);
    }

    // --- data operations --------------------------------------------------

    indexOf(id) { return this.segments.findIndex((s) => s.id === id); }
    selected() { return this.segments.find((s) => s.id === this.selectedId); }
    segById(id) { return this.segments.find((s) => s.id === id); }

    select(id) { this.selectedId = id; this.render(); }

    addBlock() {
        this.pushHistory();
        const seg = Segment({ duration: 300, powerStart: 0.6 });
        const i = this.indexOf(this.selectedId);
        if(i >= 0) this.segments.splice(i + 1, 0, seg);
        else this.segments.push(seg);
        this.selectedId = seg.id;
        this.render();
    }

    addIntervalSet() {
        this.pushHistory();
        const repeat = 4;
        const additions = [];
        for(let i = 0; i < repeat; i++) {
            additions.push(Segment({ duration: 30, powerStart: 1.2 }));
            additions.push(Segment({ duration: 30, powerStart: 0.5 }));
        }
        const i = this.indexOf(this.selectedId);
        if(i >= 0) this.segments.splice(i + 1, 0, ...additions);
        else this.segments.push(...additions);
        this.selectedId = first(additions).id;
        this.render();
    }

    duplicate(id) {
        const i = this.indexOf(id);
        if(i < 0) return;
        this.pushHistory();
        // omit id so Segment() assigns a fresh one
        const copy = Segment({ ...this.segments[i], id: undefined });
        this.segments.splice(i + 1, 0, copy);
        this.selectedId = copy.id;
        this.render();
    }

    remove(id) {
        const i = this.indexOf(id);
        if(i < 0) return;
        this.pushHistory();
        this.segments.splice(i, 1);
        if(this.selectedId === id) this.selectedId = null;
        this.render();
    }

    move(id, dir) {
        const i = this.indexOf(id);
        const j = i + dir;
        if(i < 0 || j < 0 || j >= this.segments.length) return;
        this.pushHistory();
        const [seg] = this.segments.splice(i, 1);
        this.segments.splice(j, 0, seg);
        this.render();
    }

    clearAll() {
        if(empty(this.segments)) return;
        this.pushHistory();
        this.segments = [];
        this.selectedId = null;
        this.render();
    }

    // known categories + any found in the library + the current value, so a
    // loaded workout with an unlisted category is never silently reassigned.
    categoryOptions() {
        const fromLibrary = (this.workouts ?? [])
            .map((w) => w.meta && w.meta.category)
            .filter(Boolean);
        return [...new Set([...CATEGORIES, ...fromLibrary, this.meta.category])]
            .filter(Boolean);
    }

    renderCategorySelect() {
        const el = this.querySelector('.wd-meta-category');
        if(!el) return;
        el.innerHTML = this.categoryOptions()
            .map((c) => `<option value="${this.esc(c)}">${this.esc(c)}</option>`)
            .join('');
        el.value = this.meta.category;
    }

    esc(s) {
        return `${s ?? ''}`
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // open a picker to replace the current design with a saved workout
    openLoadPicker() {
        const list = this.workouts ?? [];
        const items = empty(list)
            ? `<p class="wd-hint">No workouts in your library yet. Upload or create one first.</p>`
            : list.map((w, i) => {
                const name = (w.meta && w.meta.name) || `Workout ${i + 1}`;
                const dur = w.meta && w.meta.duration
                    ? formatTime({ value: Math.round(w.meta.duration), format: 'mm:ss' })
                    : '';
                return `<button class="wd-pick" data-i="${i}"><span>${this.esc(name)}</span><span class="wd-pick-dur">${dur}</span></button>`;
            }).join('');

        const backdrop = document.createElement('div');
        backdrop.className = 'wd-modal-backdrop';
        backdrop.innerHTML = `
            <div class="wd-modal" role="dialog" aria-modal="true">
                <div class="wd-modal-head">Load workout <span class="wd-modal-warn">— this replaces the current design</span></div>
                <div class="wd-modal-list">${items}</div>
                <div class="wd-modal-foot"><button class="wd-modal-cancel btn">Cancel</button></div>
            </div>`;

        const close = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => {
            if(e.target === backdrop || e.target.closest('.wd-modal-cancel')) { close(); return; }
            const pick = e.target.closest('.wd-pick');
            if(pick) {
                const w = list[Number(pick.getAttribute('data-i'))];
                close();
                if(w) this.requestLoad(w);
            }
        }, this.signal);
        this.appendChild(backdrop);
    }

    // low-level load. Two modes:
    //   asCopy=true  -> fresh copy: library-unique name, no bound id, so the
    //                   first save creates a new entry (never touches the source).
    //   asCopy=false -> edit in place: keep the name, bind currentWorkoutId to
    //                   this workout so saves update it. Buffer starts clean.
    loadWorkout(workout, { asCopy = true } = {}) {
        if(!workout || empty(workout.intervals)) {
            this.flash('That workout has no intervals to load.');
            return;
        }
        this.pushHistory();
        this.segments = segmentsFromIntervals(workout.intervals);
        this.selectedId = null;
        const meta = workout.meta ?? {};
        this.meta = {
            name: asCopy
                ? copyName(meta.name ?? 'Workout', this.libraryNames())
                : (meta.name ?? 'Workout'),
            author: meta.author ?? 'Auuki',
            category: meta.category ?? 'Sweet Spot',
            description: meta.description ?? '',
        };
        this.renderCategorySelect();
        ['name', 'category', 'description'].forEach((key) => {
            const el = this.querySelector(`.wd-meta-${key}`);
            if(el) el.value = this.meta[key];
        });
        this.currentWorkoutId = asCopy ? null : workout.id;
        // a copy is unsaved (dirty); an in-place edit matches its saved form.
        this.dirty = asCopy;
        this.render();
    }

    // "Edit"/"Copy" pressed on a workout row: load it here and reveal the editor.
    // Read-only default workouts always come in as a copy; the user's own
    // workouts open bound for in-place editing.
    onEditRequest(id) {
        const w = (this.workouts ?? []).find((x) => x.id === id);
        if(!w) return;
        this.requestLoad(w, { asCopy: !!w.isDefault, navigate: true });
    }

    // "Duplicate" from a workout row: load as a fresh copy regardless of whether
    // it's a built-in or one of the user's own, so saving creates a new entry.
    onDuplicateRequest(id) {
        const w = (this.workouts ?? []).find((x) => x.id === id);
        if(!w) return;
        this.requestLoad(w, { asCopy: true, navigate: true });
    }

    // load a workout, first guarding any unsaved edits in the current buffer.
    requestLoad(workout, { asCopy = true, navigate = false } = {}) {
        const proceed = () => {
            this.loadWorkout(workout, { asCopy });
            if(navigate) {
                xf.dispatch('ui:page-set', 'workouts');
                xf.dispatch('action:nav', 'workouts:editor');
            }
        };
        if(this.dirty) this.openLeaveGuard(proceed);
        else proceed();
    }

    // --- leave guard (unsaved changes) ------------------------------------

    // work out where a nav/page button intends to send us, and whether that
    // keeps the editor on screen.
    navDestination(link) {
        if(link.tagName.toLowerCase() === 'page-btn') {
            const param = link.getAttribute('param');
            return { type: 'page', param, stays: param === 'workouts' };
        }
        const action = link.getAttribute('action');
        return { type: 'nav', action, stays: action === 'workouts:editor' };
    }

    performNav(dest) {
        if(dest.type === 'page') xf.dispatch('ui:page-set', dest.param);
        else xf.dispatch('action:nav', dest.action);
    }

    // capture-phase pointerup: block a tab/page switch that would abandon
    // unsaved edits, and prompt instead.
    onNavGuard(e) {
        if(!this.dirty) return;
        if(this.offsetParent === null) return; // editor not visible => not editing
        const link = e.target.closest('navigation-action, page-btn');
        if(!link) return;
        const dest = this.navDestination(link);
        if(!dest || dest.stays) return;
        e.preventDefault();
        e.stopPropagation();
        this.openLeaveGuard(() => this.performNav(dest));
    }

    openLeaveGuard(proceed) {
        const backdrop = document.createElement('div');
        backdrop.className = 'wd-modal-backdrop';
        backdrop.innerHTML = `
            <div class="wd-modal" role="dialog" aria-modal="true">
                <div class="wd-modal-head">Unsaved changes <span class="wd-modal-warn">— edits aren't saved to your library</span></div>
                <div class="wd-modal-body">Save this workout, discard your edits, or keep editing?</div>
                <div class="wd-modal-foot wd-guard-foot">
                    <button class="wd-guard-stay btn">Stay</button>
                    <button class="wd-guard-discard btn btn--danger">Discard edits</button>
                    <button class="wd-guard-save btn btn--primary">Save</button>
                </div>
            </div>`;
        const close = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => {
            if(e.target === backdrop || e.target.closest('.wd-guard-stay')) { close(); return; }
            if(e.target.closest('.wd-guard-save')) { this.save(); close(); proceed(); return; }
            if(e.target.closest('.wd-guard-discard')) { this.dirty = false; close(); proceed(); return; }
        }, this.signal);
        this.appendChild(backdrop);
    }

    zoom(factor) {
        this.geometry.setPxPerSec(this.geometry.getPxPerSec() * factor);
        this.render();
    }

    // --- persistence ------------------------------------------------------

    toZwo() { return segmentsToZwo(this.meta, this.segments); }

    // names of every workout in the library, optionally excluding one id
    libraryNames(exceptId) {
        return (this.workouts ?? [])
            .filter((w) => w.id !== exceptId)
            .map((w) => w.meta && w.meta.name)
            .filter(Boolean);
    }

    save() {
        if(empty(this.segments)) { this.flash('Add at least one block first.'); return; }
        // first save of this buffer -> new entry with a library-unique name
        if(!this.currentWorkoutId) {
            const unique = copyName(this.meta.name, this.libraryNames());
            if(unique !== this.meta.name) {
                this.meta.name = unique;
                const el = this.querySelector('.wd-meta-name');
                if(el) el.value = unique;
            }
            this.currentWorkoutId = uuid();
        }
        xf.dispatch('ui:workout:save', { zwo: this.toZwo(), id: this.currentWorkoutId });
        this.dirty = false;
        this.flash(`Saved "${this.meta.name}" to your Workouts library.`);
    }

    download() {
        if(empty(this.segments)) { this.flash('Add at least one block first.'); return; }
        const blob = new Blob([this.toZwo()], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.meta.name || 'workout'}.zwo`;
        a.click();
        URL.revokeObjectURL(url);
    }

    flash(message) {
        if(!this.$summary) return;
        this.$summary.textContent = message;
        this.$summary.classList.add('wd-flash');
        setTimeout(() => {
            this.$summary.classList.remove('wd-flash');
            this.updateSummary();
        }, 2200);
    }

    watts(frac) { return Math.round(frac * this.ftp); }

    // --- pointer editing --------------------------------------------------

    localPoint(e) {
        const rect = this.$svg.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // seconds offset of a segment's left edge from the workout start
    edgeSecondsOf(index) {
        let acc = 0;
        for(let k = 0; k < index; k++) acc += this.segments[k].duration;
        return acc;
    }

    onPointerDown(e) {
        const target = e.target.closest('[data-role]');
        if(!target) return;
        const id = target.getAttribute('data-id');
        const role = target.getAttribute('data-role');
        const seg = this.segById(id);
        if(!seg) return;

        this.selectedId = id;

        // a plain body click only selects — it never edits power
        if(role === 'body') { this.render(); return; }

        // double-tap a top corner to align it to the opposite corner (flattening
        // the top). Detected by hand because render() replaces the SVG nodes on
        // every pointerdown, which stops the browser's native dblclick firing.
        if(role === 'power-start' || role === 'power-end') {
            const now = Date.now();
            const last = this._lastCornerTap;
            if(last && last.id === id && last.role === role && (now - last.t) < 350) {
                this.pushHistory();
                if(role === 'power-start') seg.powerStart = seg.powerEnd;
                else seg.powerEnd = seg.powerStart;
                this._lastCornerTap = null;
                this.render();
                e.preventDefault();
                return;
            }
            this._lastCornerTap = { id, role, t: now };
        }

        const index = this.indexOf(id);
        const leftSeg = index > 0 ? this.segments[index - 1] : null;

        // snapshot before a drag so the whole drag is a single undo step,
        // committed on pointerup only if something actually changed.
        this._dragSnapshot = this.cloneSegments();

        this.drag = {
            id, role,
            start: this.localPoint(e),
            startValue: {
                duration: seg.duration,
                powerStart: seg.powerStart,
                powerEnd: seg.powerEnd,
            },
            edgeSeconds: this.edgeSecondsOf(index),
            leftId: leftSeg ? leftSeg.id : null,
            leftDuration: leftSeg ? leftSeg.duration : 0,
        };
        window.addEventListener('pointermove', this._onMove, this.signal);
        window.addEventListener('pointerup', this._onUp, this.signal);
        this.render();
        e.preventDefault();
    }

    onPointerMove(e) {
        if(!this.drag) return;
        const seg = this.segById(this.drag.id);
        if(!seg) return;
        const p = this.localPoint(e);
        const g = this.geometry;
        const { role, start, startValue } = this.drag;

        if(role === 'duration-right') {
            const seconds = g.pxToSeconds(p.x - g.xAt(this.drag.edgeSeconds));
            seg.duration = snapDuration(seconds);
        } else if(role === 'duration-left') {
            // drag the boundary shared with the left neighbour: total time of the
            // two bars is preserved, only the split point moves.
            const leftSeg = this.segById(this.drag.leftId);
            if(!leftSeg) return;
            const leftStart = this.drag.edgeSeconds - this.drag.leftDuration;
            const thisEnd = this.drag.edgeSeconds + startValue.duration;
            let boundary = Math.round(g.pxToSeconds(p.x - g.padL) / DURATION_SNAP) * DURATION_SNAP;
            boundary = clamp(leftStart + MIN_DURATION, thisEnd - MIN_DURATION, boundary);
            leftSeg.duration = boundary - leftStart;
            seg.duration = thisEnd - boundary;
        } else if(role === 'power-top') {
            // shift the whole bar up/down by the pointer's vertical delta,
            // preserving any ramp between start and end power.
            const dyFrac = g.pxToFrac(p.y) - g.pxToFrac(this.drag.start.y);
            seg.powerStart = snapPower(startValue.powerStart + dyFrac);
            seg.powerEnd = snapPower(startValue.powerEnd + dyFrac);
        } else if(role === 'power-start') {
            seg.powerStart = snapPower(g.pxToFrac(p.y));
        } else if(role === 'power-end') {
            seg.powerEnd = snapPower(g.pxToFrac(p.y));
        }
        this.render();
    }

    onPointerUp() {
        if(this.drag && this._dragSnapshot &&
           JSON.stringify(this._dragSnapshot) !== JSON.stringify(this.segments)) {
            this.undoStack.push(this._dragSnapshot);
            this.redoStack = [];
            this.trimHistory();
            this.markDirty();
        }
        this._dragSnapshot = null;
        this.drag = null;
        window.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup', this._onUp);
        this.render();
    }

    // --- history (undo / redo) --------------------------------------------

    cloneSegments() { return JSON.parse(JSON.stringify(this.segments)); }

    trimHistory() { if(this.undoStack.length > 50) this.undoStack.shift(); }

    markDirty() {
        this.dirty = true;
        this.updateSummary();
    }

    pushHistory() {
        this.undoStack.push(this.cloneSegments());
        this.redoStack = [];
        this.trimHistory();
        this.markDirty();
    }

    restore(segs) {
        this.segments = JSON.parse(JSON.stringify(segs));
        if(!this.segments.some((s) => s.id === this.selectedId)) this.selectedId = null;
        this.markDirty();
        this.render();
    }

    undo() {
        if(empty(this.undoStack)) return;
        this.redoStack.push(this.cloneSegments());
        this.restore(this.undoStack.pop());
    }

    redo() {
        if(empty(this.redoStack)) return;
        this.undoStack.push(this.cloneSegments());
        this.restore(this.redoStack.pop());
    }

    onKeyDown(e) {
        if(!(e.ctrlKey || e.metaKey)) return;
        if(this.offsetParent === null) return; // designer not visible
        const tag = (e.target.tagName || '').toLowerCase();
        if(tag === 'input' || tag === 'textarea') return; // let fields use native undo
        const key = e.key.toLowerCase();
        if(key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
        else if((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); this.redo(); }
    }

    fitToWidth() {
        const total = this.geometry.totalDuration(this.segments);
        if(total <= 0) return;
        const wrap = this.querySelector('.wd-chart-wrap');
        const outer = wrap ? wrap.clientWidth : (this.$svg.clientWidth || 600);
        const avail = outer - this.geometry.padL - this.geometry.padR - 2;
        if(avail <= 0) return;
        this.geometry.setPxPerSec(avail / total);
        this.render();
    }

    // --- interval list editing --------------------------------------------

    parseDuration(value) {
        const parts = `${value}`.split(':').map((n) => Number(n));
        if(parts.length === 2 && !parts.some(isNaN)) return parts[0] * 60 + parts[1];
        const n = Number(value);
        return isNaN(n) ? null : n;
    }

    onListChange(e) {
        const el = e.target.closest('.wd-li');
        if(!el) return;
        const seg = this.segById(el.getAttribute('data-id'));
        if(!seg) return;
        this.pushHistory();
        const field = el.getAttribute('data-f');
        const value = el.value;
        if(field === 'duration') {
            const sec = this.parseDuration(value);
            if(sec != null) seg.duration = snapDuration(sec);
        } else if(field === 'pstart') {
            seg.powerStart = snapPower(Number(value) / 100);
        } else if(field === 'pend') {
            seg.powerEnd = snapPower(Number(value) / 100);
        } else if(field === 'cadence') {
            seg.cadence = value === '' ? undefined : Math.round(Number(value));
        } else if(field === 'slope') {
            seg.slope = value === '' ? undefined : Number(value);
        }
        this.render();
    }

    onListClick(e) {
        const btn = e.target.closest('button[data-act]');
        if(btn) {
            const id = btn.getAttribute('data-id');
            const act = btn.getAttribute('data-act');
            if(act === 'add') { this.addBlock(); return; }
            if(act === 'up') { this.move(id, -1); return; }
            if(act === 'down') { this.move(id, +1); return; }
            if(act === 'dup') { this.duplicate(id); return; }
            if(act === 'del') { this.remove(id); return; }
            return;
        }
        // clicking a row (but not an input) selects that segment
        const row = e.target.closest('.wd-lrow');
        if(row && !e.target.closest('input')) {
            this.select(row.getAttribute('data-id'));
        }
    }

    // --- rendering --------------------------------------------------------

    zoneColor(frac) {
        const zone = models.ftp.percentageToZone(frac);
        return models.ftp.zoneToColor(zone);
    }

    render() {
        if(!this.$svg) return;
        const g = this.geometry;
        g.setYMaxFrac(this.segments);

        const width = Math.max(this.$svg.clientWidth || 600, g.contentWidth(this.segments));
        this.$svg.setAttribute('width', width);
        this.$svg.setAttribute('height', g.height);
        this.$svg.setAttribute('viewBox', `0 0 ${width} ${g.height}`);

        this.$svg.innerHTML = this.gridSvg(g, width) + this.segmentsSvg(g);
        this.updateSummary();
        this.renderList();
        if(this.$undo) this.$undo.disabled = empty(this.undoStack);
        if(this.$redo) this.$redo.disabled = empty(this.redoStack);
    }

    gridSvg(g, width) {
        const out = [];
        // horizontal power gridlines — labelled with both %FTP and watts
        [0.5, 1.0, 1.5].forEach((frac) => {
            if(frac > g.yMaxFrac) return;
            const y = g.yAt(frac);
            out.push(`<line class="wd-grid" x1="${g.padL}" y1="${y}" x2="${width - g.padR}" y2="${y}"/>`);
            out.push(`<text class="wd-axis" x="${g.padL - 6}" y="${y - 1}" text-anchor="end">${Math.round(frac * 100)}%</text>`);
            out.push(`<text class="wd-axis-w" x="${g.padL - 6}" y="${y + 9}" text-anchor="end">${this.watts(frac)}W</text>`);
        });

        const base = g.yBase();
        // vertical time-axis ticks + mm:ss labels (the timescale)
        const total = g.totalDuration(this.segments);
        const tick = niceTickSeconds(g.getPxPerSec());
        for(let t = 0; t <= total + 0.5; t += tick) {
            const x = g.xAt(t);
            out.push(`<line class="wd-tick" x1="${x}" y1="${g.padT}" x2="${x}" y2="${base}"/>`);
            out.push(`<text class="wd-axis wd-tick-label" x="${x}" y="${base + 14}" text-anchor="middle">${formatTime({ value: t, format: 'mm:ss' })}</text>`);
        }

        out.push(`<line class="wd-axis-line" x1="${g.padL}" y1="${base}" x2="${width - g.padR}" y2="${base}"/>`);
        return out.join('');
    }

    segmentsSvg(g) {
        let x = g.padL;
        const base = g.yBase();
        const bodies = [];
        let sel = null; // geometry of the selected bar, drawn last so it sits on top

        this.segments.forEach((seg, index) => {
            const x0 = x;
            const x1 = x + seg.duration * g.getPxPerSec();
            const yS = g.yAt(seg.powerStart);
            const yE = g.yAt(seg.powerEnd);
            const selected = seg.id === this.selectedId;
            const avg = (seg.powerStart + seg.powerEnd) / 2;
            const fill = this.zoneColor(avg);
            const points = `${x0},${base} ${x0},${yS} ${x1},${yE} ${x1},${base}`;

            bodies.push(`<polygon class="wd-bar${selected ? ' wd-selected' : ''}" data-role="body" data-id="${seg.id}" points="${points}" fill="${fill}"/>`);

            if(selected) sel = { seg, index, x0, x1, yS, yE, points };
            x = x1;
        });

        if(!sel) return bodies.join('');

        // second pass: the selected bar's outline + handles, painted over every
        // body polygon so an adjacent block can never cover its edges/corners.
        const { seg, index, x0, x1, yS, yE, points } = sel;
        const handles = [];
        handles.push(`<polygon class="wd-selected-outline" points="${points}" fill="none"/>`);
        // left edge — only when there is a neighbour to squish
        if(index > 0) {
            handles.push(`<rect class="wd-edge" data-role="duration-left" data-id="${seg.id}" x="${x0 - 4}" y="${g.padT}" width="8" height="${base - g.padT}"/>`);
        }
        // right edge — this bar's duration
        handles.push(`<rect class="wd-edge" data-role="duration-right" data-id="${seg.id}" x="${x1 - 4}" y="${g.padT}" width="8" height="${base - g.padT}"/>`);
        // top edge — shift whole-bar power
        handles.push(`<line class="wd-edge-top" data-role="power-top" data-id="${seg.id}" x1="${x0}" y1="${yS}" x2="${x1}" y2="${yE}"/>`);
        // top corners — per-end power (ramps)
        handles.push(`<circle class="wd-handle" data-role="power-start" data-id="${seg.id}" cx="${x0}" cy="${yS}" r="6"/>`);
        handles.push(`<circle class="wd-handle" data-role="power-end" data-id="${seg.id}" cx="${x1}" cy="${yE}" r="6"/>`);

        return bodies.join('') + handles.join('');
    }

    updateSummary() {
        if(!this.$summary || this.$summary.classList.contains('wd-flash')) return;
        const total = this.geometry.totalDuration(this.segments);
        const count = this.segments.length;
        const unsaved = this.dirty ? ' · ● unsaved' : '';
        this.$summary.textContent =
            `${count} block${count === 1 ? '' : 's'} · ${formatTime({ value: total, format: 'mm:ss' })} · FTP ${this.ftp}W${unsaved}`;
    }

    renderList() {
        if(!this.$list) return;
        if(empty(this.segments)) {
            this.$list.innerHTML = `
                <p class="wd-hint">No blocks yet. Use <strong>+ Add block</strong> below, or <strong>Load workout…</strong> to start from a saved one.</p>
                <button class="wd-list-add btn" data-act="add">+ Add block</button>`;
            return;
        }
        const rows = this.segments.map((seg, i) => {
            const selected = seg.id === this.selectedId;
            const durStr = formatTime({ value: Math.round(seg.duration), format: 'mm:ss' });
            const startW = this.watts(seg.powerStart);
            const endW = this.watts(seg.powerEnd);
            return `
            <tr class="wd-lrow${selected ? ' wd-lsel' : ''}" data-id="${seg.id}">
                <td class="wd-lidx">${i + 1}</td>
                <td><input class="wd-li" data-f="duration" data-id="${seg.id}" value="${durStr}"/></td>
                <td class="wd-lpow">
                    <input class="wd-li" type="number" step="1" data-f="pstart" data-id="${seg.id}" value="${Math.round(seg.powerStart * 100)}"/>
                    <span class="wd-unit">% · ${startW}W</span>
                </td>
                <td class="wd-lpow">
                    <input class="wd-li" type="number" step="1" data-f="pend" data-id="${seg.id}" value="${Math.round(seg.powerEnd * 100)}"/>
                    <span class="wd-unit">% · ${endW}W</span>
                </td>
                <td><input class="wd-li" type="number" step="1" data-f="cadence" data-id="${seg.id}" value="${exists(seg.cadence) ? seg.cadence : ''}" placeholder="—"/></td>
                <td><input class="wd-li" type="number" step="0.5" data-f="slope" data-id="${seg.id}" value="${exists(seg.slope) ? seg.slope : ''}" placeholder="—"/></td>
                <td class="wd-lactions">
                    <button data-act="up" data-id="${seg.id}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
                    <button data-act="down" data-id="${seg.id}" title="Move down" ${i === this.segments.length - 1 ? 'disabled' : ''}>↓</button>
                    <button data-act="dup" data-id="${seg.id}" title="Duplicate">⧉</button>
                    <button data-act="del" data-id="${seg.id}" title="Delete">✕</button>
                </td>
            </tr>`;
        }).join('');

        this.$list.innerHTML = `
            <table class="wd-table">
                <thead>
                    <tr>
                        <th>#</th><th>Duration</th><th>Start</th><th>End</th>
                        <th>Cadence</th><th>Slope</th><th></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <button class="wd-list-add btn" data-act="add">+ Add block</button>`;
    }

    template() {
        return `
        <div class="wd-cont">
            <div class="wd-meta">
                <label>Name<input class="wd-meta-name" type="text"/></label>
                <label>Category<select class="wd-meta-category"></select></label>
                <label class="wd-meta-desc-wrap">Description<input class="wd-meta-description" type="text"/></label>
            </div>

            <div class="wd-toolbar">
                <button class="wd-load btn btn--danger" title="Replace the current design with a saved workout">Load workout…</button>
                <button class="wd-clear btn">Clear</button>
                <span class="wd-spacer"></span>
                <button class="wd-undo btn" title="Undo (Ctrl+Z)">↶ Undo</button>
                <button class="wd-redo btn" title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
                <button class="wd-fit btn" title="Zoom to fit">Fit</button>
                <button class="wd-zoom-out btn" title="Zoom out">−</button>
                <button class="wd-zoom-in btn" title="Zoom in">+</button>
            </div>

            <div class="wd-chart-wrap">
                <svg class="wd-svg" xmlns="http://www.w3.org/2000/svg"></svg>
            </div>

            <div class="wd-summary"></div>
            <div class="wd-list"></div>

            <div class="wd-footer">
                <button class="wd-save btn btn--primary">Save to library</button>
                <button class="wd-download btn">Download .zwo</button>
            </div>
        </div>`;
    }

    injectStyles() {
        if(document.getElementById('workout-designer-styles')) return;
        const style = document.createElement('style');
        style.id = 'workout-designer-styles';
        style.textContent = `
        workout-designer { display: block; }
        .wd-cont { padding: 1em; max-width: 1100px; margin: 0 auto; }
        .wd-meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75em; margin-bottom: 1em; }
        .wd-meta .wd-meta-desc-wrap { grid-column: 1 / -1; }
        .wd-meta label { display: flex; flex-direction: column; font-size: 0.8em; opacity: 0.85; gap: 0.25em; }
        .wd-meta input, .wd-meta select { padding: 0.4em 0.5em; border-radius: 6px; border: 1px solid var(--border-color, #444);
            background: var(--input-bg, #1c1c1e); color: inherit; font-size: 1rem; }
        .wd-toolbar { display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.5em; flex-wrap: wrap; }
        .wd-toolbar .wd-spacer { flex: 1; }
        .wd-chart-wrap { overflow-x: auto; border: 1px solid var(--border-color, #333); border-radius: 8px;
            background: var(--surface, #161618); }
        .wd-svg { display: block; touch-action: none; }
        .wd-bar { cursor: pointer; opacity: 0.85; stroke: rgba(0,0,0,0.25); stroke-width: 1; }
        .wd-bar:hover { opacity: 1; }
        .wd-bar.wd-selected { opacity: 1; }
        .wd-selected-outline { stroke: #fff; stroke-width: 2; pointer-events: none; }
        .wd-edge { fill: rgba(255,255,255,0.001); cursor: ew-resize; }
        .wd-edge-top { stroke: rgba(255,255,255,0.001); stroke-width: 12; cursor: ns-resize; pointer-events: stroke; }
        .wd-handle { fill: #fff; stroke: #328AFF; stroke-width: 2; cursor: ns-resize; }
        .wd-grid { stroke: rgba(255,255,255,0.08); stroke-width: 1; }
        .wd-tick { stroke: rgba(255,255,255,0.05); stroke-width: 1; }
        .wd-tick-label { opacity: 0.55; }
        .wd-axis-line { stroke: rgba(255,255,255,0.25); stroke-width: 1; }
        .wd-axis { fill: rgba(255,255,255,0.55); font-size: 10px; }
        .wd-axis-w { fill: rgba(255,255,255,0.35); font-size: 9px; }
        .wd-summary { margin: 0.6em 0; font-size: 0.85em; opacity: 0.8; }
        .wd-summary.wd-flash { opacity: 1; color: #57C057; font-weight: 600; }
        .wd-list { margin-top: 0.25em; }
        .wd-hint { font-size: 0.85em; opacity: 0.7; max-width: 55ch; }
        .wd-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .wd-table th { text-align: left; font-weight: 600; opacity: 0.6; font-size: 0.75em;
            text-transform: uppercase; letter-spacing: 0.03em; padding: 0.35em 0.5em; }
        .wd-table td { padding: 0.3em 0.5em; border-top: 1px solid var(--border-color, #2a2a2e); vertical-align: middle; }
        .wd-lrow { cursor: pointer; }
        .wd-lrow:hover { background: rgba(255,255,255,0.03); }
        .wd-lrow.wd-lsel { background: rgba(50,138,255,0.12); }
        .wd-lidx { opacity: 0.5; width: 1.5em; text-align: right; }
        .wd-table input { width: 4.2em; padding: 0.3em 0.4em; border-radius: 5px; border: 1px solid var(--border-color, #444);
            background: var(--input-bg, #1c1c1e); color: inherit; font-size: 0.9rem; }
        .wd-lpow { white-space: nowrap; }
        .wd-lpow .wd-unit { font-size: 0.72em; opacity: 0.55; margin-left: 0.35em; }
        .wd-lactions { white-space: nowrap; text-align: right; }
        .wd-lactions button { background: transparent; border: 1px solid var(--border-color, #444); color: inherit;
            border-radius: 5px; cursor: pointer; padding: 0.15em 0.45em; margin-left: 0.2em; font-size: 0.85rem; }
        .wd-lactions button:hover:not(:disabled) { border-color: #666; }
        .wd-lactions button:disabled { opacity: 0.3; cursor: default; }
        .wd-list-add { margin-top: 0.6em; }
        .wd-footer { display: flex; gap: 0.5em; margin-top: 1.25em; }
        .wd-cont .btn { padding: 0.45em 0.8em; border-radius: 6px; border: 1px solid var(--border-color, #444);
            background: var(--btn-bg, #2a2a2e); color: inherit; cursor: pointer; font-size: 0.9rem; }
        .wd-cont .btn:hover { border-color: #666; }
        .wd-cont .btn:disabled { opacity: 0.4; cursor: default; }
        .wd-cont .btn:disabled:hover { border-color: var(--border-color, #444); }
        .wd-cont .btn--primary { background: #328AFF; border-color: #328AFF; color: #fff; }
        .wd-cont .btn--danger { background: #C0392B; border-color: #C0392B; color: #fff; }
        .wd-cont .btn--danger:hover { background: #d84636; border-color: #d84636; }
        .wd-modal-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.55);
            display: flex; align-items: center; justify-content: center; padding: 1em; }
        .wd-modal { background: var(--surface, #1c1c1e); border: 1px solid var(--border-color, #333);
            border-radius: 10px; width: min(420px, 100%); max-height: 80vh; display: flex; flex-direction: column; }
        .wd-modal-head { padding: 0.9em 1em; font-weight: 600; border-bottom: 1px solid var(--border-color, #2a2a2e); }
        .wd-modal-warn { color: #E7776B; font-weight: 500; font-size: 0.85em; }
        .wd-modal-body { padding: 0.9em 1em; font-size: 0.9em; opacity: 0.85; line-height: 1.4; }
        .wd-guard-foot { display: flex; gap: 0.5em; justify-content: flex-end; }
        .wd-modal-list { padding: 0.6em; overflow-y: auto; display: flex; flex-direction: column; gap: 0.35em; }
        .wd-pick { display: flex; justify-content: space-between; align-items: center; gap: 1em; text-align: left;
            padding: 0.6em 0.75em; border-radius: 6px; border: 1px solid var(--border-color, #444);
            background: var(--btn-bg, #2a2a2e); color: inherit; cursor: pointer; font-size: 0.95rem; }
        .wd-pick:hover { border-color: #C0392B; background: rgba(192,57,43,0.12); }
        .wd-pick-dur { opacity: 0.55; font-size: 0.85em; font-variant-numeric: tabular-nums; }
        .wd-modal-foot { padding: 0.75em 1em; border-top: 1px solid var(--border-color, #2a2a2e); text-align: right; }
        @media (max-width: 640px) {
            .wd-meta { grid-template-columns: 1fr 1fr; }
            .wd-table { font-size: 0.78rem; }
        }`;
        document.head.appendChild(style);
    }
}

customElements.define('workout-designer', WorkoutDesigner);

export { WorkoutDesigner };
