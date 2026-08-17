//
// WATTS overhaul — workout library rows (My Workouts / Default tabs).
//
// Each workout renders as a clickable card: a load-selector radio, mini
// bar-profile thumbnail, name + one-line description, category label,
// duration, a START pill and a chevron. Clicking the row expands it in place
// (accordion, one open at a time) to the full segmented profile graph +
// description + Start Workout. The 3-dot menu keeps the library actions
// (edit / duplicate / delete for the user's workouts, duplicate for the
// built-in ones).
//
import { xf, exists, empty, equals, first, last } from '../functions.js';
import { formatTime } from '../utils.js';
import { models } from '../models/models.js';
import { courseToGraph } from './workout-graph.js';
import { zoneClassByPct, rampGradient, chevronSvg } from './watts.js';
import {
    flattenSteps, shapeSteps, toSegments, rampPolygon,
} from '../workouts/profile-shape.js';
import {
    workoutCategoryColor,
    WORKOUT_CATEGORY_FALLBACK_COLOR,
} from '../workouts/categories.js';

// Interpolated workout text (names, descriptions) comes from user files, so
// never let it carry markup into innerHTML.
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Flatten a workout's intervals into drawable steps:
// [{duration, watts, pct, pctStart, pctEnd, rampId}] where pct is %FTP.
//
// A ramp is stored as a run of short steps (a .zwo <Warmup> expands that way,
// and exported workouts often write one as a series of short blocks), so drawn
// literally it becomes a staircase. profile-shape.js marks those runs and gives
// each step the %FTP of its top edge at its left and right boundary, which lets
// the profiles below draw a whole run as one smooth slope. Steps outside a run
// get pctStart === pctEnd and stay ordinary rectangles.
function workoutToSteps(workout, ftp) {
    const scale  = 100 / (ftp || 200);
    const toWatts = (step) => models.ftp.toAbsolute(step.power, ftp) ?? 0;
    const shaped = shapeSteps(flattenSteps(workout.intervals, toWatts), {ftp});

    return shaped.map((step) => ({
        duration: step.duration,
        watts:    step.power,
        pct:      step.power * scale,
        pctStart: step.powerStart * scale,
        pctEnd:   step.powerEnd * scale,
        rampId:   step.rampId,
    }));
}

// Bar height as % of a 0–150% FTP plot (the design's mapping), with a small
// floor so recovery blocks stay visible.
function stepToHeight(pct) {
    return Math.max(6, Math.min(100, (pct / 150) * 100));
}

// A sloped segment: one element clipped to the run's outline and filled with
// the zone colours it passes through, so the whole run is a single shape with
// no seams between its steps.
function rampSegmentHtml(segment, className, sizing = '') {
    const polygon = rampPolygon(
        segment.steps.map((step) => ({
            duration:   step.duration,
            powerStart: step.pctStart,
            powerEnd:   step.pctEnd,
        })),
        (pct) => stepToHeight(pct) / 100);
    // pct values are already %FTP, so an "ftp" of 100 maps them straight through
    const gradient = rampGradient(segment.steps.map((step) => step.pct), 100);

    return `<div class="${className}"
                 style="${sizing} clip-path: ${polygon};
                        background: linear-gradient(90deg, ${gradient});"></div>`;
}

// mini thumbnail: zone-coloured bars, widths proportional to step duration.
function miniProfileHtml(steps) {
    const segments = toSegments(steps);
    const dense = segments.length > 24 ? ' is-dense' : '';
    const bars = segments.reduce((acc, segment) => {
        if(segment.isRamp) {
            return acc + rampSegmentHtml(segment, 'watts-wmini--ramp',
                                         `flex-grow: ${Math.max(1, segment.duration)};`);
        }
        const step = segment.steps[0];
        const zone = zoneClassByPct(step.pct);
        return acc +
            `<div class="watts-wmini--bar zone-${zone}"
                  style="flex-grow: ${Math.max(1, step.duration)}; height: ${stepToHeight(step.pct)}%;"></div>`;
    }, '');
    return `<div class="watts-wmini${dense}">${bars}</div>`;
}

// Segment duration at the base of a block, matching the live profile on Home:
// mm:ss without the leading zero ("02:00" → "2:00"). Only on blocks wide enough
// for the text to read — narrower ones would overlap their neighbours.
function durationLabelHtml(duration, widthPct) {
    if(!exists(duration) || duration <= 0 || widthPct < 2.5) return '';
    const text = formatTime({value: duration, format: 'mm:ss'}).replace(/^0/, '');
    return `<span class="watts-wprof--dur">${text}</span>`;
}

// full profile for the expanded panel: FTP axis (% + W), zone bars with watt
// labels on the work blocks, per-block durations at the base, and a time axis.
function fullProfileHtml(steps, ftp, totalDuration) {
    const axis = [150, 100, 50, 0].map((pct) => {
        const top = 100 - (pct / 150) * 100;
        const watts = Math.round((pct / 100) * (ftp || 200));
        return `<span style="top: ${top}%;"><b>${pct}%</b><i>${watts}W</i></span>`;
    }).join('');

    const total = totalDuration > 0
        ? totalDuration
        : steps.reduce((acc, s) => acc + s.duration, 0);
    const segments = toSegments(steps);
    const dense = segments.length > 24 ? ' is-dense' : '';

    const bars = segments.reduce((acc, segment) => {
        const widthPct = total > 0 ? (segment.duration / total) * 100 : 0;

        if(segment.isRamp) {
            const from = first(segment.steps);
            const to   = last(segment.steps);
            // One label for the whole run (start→end), sat above its midpoint,
            // instead of one per step. A start→end label is about three times
            // the width of a block's, so it needs more room before it reads.
            const label = (widthPct >= 4)
                ? `<span class="watts-wprof--watt" style="bottom: calc(${stepToHeight((from.pct + to.pct) / 2)}% + 3px);">${Math.round(from.watts)}→${Math.round(to.watts)}</span>`
                : '';
            return acc +
                `<div class="watts-wprof--seg" style="flex-grow: ${Math.max(1, segment.duration)};">
                     ${rampSegmentHtml(segment, 'watts-wprof--ramp')}
                     ${label}
                     ${durationLabelHtml(segment.duration, widthPct)}
                 </div>`;
        }

        const step = first(segment.steps);
        const height = stepToHeight(step.pct);
        const zone = zoneClassByPct(step.pct);
        // every block is labelled, as on the live profile on Home — recovery
        // and warmup wattages matter too. Width is the only gate: below it the
        // label would spill over its neighbours (repeated 60 s efforts in an
        // hour-long workout still qualify).
        const label = (widthPct >= 1.2)
            ? `<span class="watts-wprof--watt" style="bottom: calc(${height}% + 3px);">${Math.round(step.watts)}</span>`
            : '';
        return acc +
            `<div class="watts-wprof--seg" style="flex-grow: ${Math.max(1, step.duration)};">
                 <div class="watts-wprof--bar zone-${zone}" style="height: ${height}%;"></div>
                 ${label}
                 ${durationLabelHtml(step.duration, widthPct)}
             </div>`;
    }, '');

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const mins = Math.round((total * f) / 60);
        return `<span class="watts-wprof--tick" style="left: ${f * 100}%;">${mins}:00</span>`;
    }).join('');

    return `
        <div class="watts-wprof">
            <div class="watts-wprof--axis">${axis}</div>
            <div class="watts-wprof--plot">
                <div class="watts-wprof--grid" style="top: 33.3%;"></div>
                <div class="watts-wprof--grid" style="top: 66.6%;"></div>
                <div class="watts-wprof--bars${dense}">${bars}</div>
            </div>
        </div>
        <div class="watts-wprof--time">
            <div class="watts-wprof--timespacer"></div>
            <div class="watts-wprof--ticks">${ticks}</div>
        </div>`;
}

// Small confirm dialog shared by the row actions that can't simply be undone.
// Every caller-supplied string is written with textContent, so a workout name
// can never inject markup into it.
function confirmModal({head, body, confirmLabel, confirmClass, onConfirm}) {
    const backdrop = document.createElement('div');
    backdrop.className = 'wl-modal-backdrop';
    backdrop.innerHTML = `
        <div class="wl-modal" role="dialog" aria-modal="true">
            <div class="wl-modal-head"></div>
            <div class="wl-modal-body"></div>
            <div class="wl-modal-foot">
                <button class="wl-cancel btn">Cancel</button>
                <button class="wl-confirm btn ${confirmClass ?? ''}"></button>
            </div>
        </div>`;
    backdrop.querySelector('.wl-modal-head').textContent = head;
    backdrop.querySelector('.wl-modal-body').textContent = body;
    backdrop.querySelector('.wl-confirm').textContent = confirmLabel;

    const close = () => backdrop.remove();
    backdrop.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        if(e.target === backdrop || e.target.closest('.wl-cancel')) { close(); return; }
        if(e.target.closest('.wl-confirm')) { close(); onConfirm(); }
    });
    document.body.appendChild(backdrop);
    return backdrop;
}

function durationText(workout) {
    if(workout.meta.distance) {
        return `${(workout.meta.distance / 1000).toFixed(2)} km`;
    }
    if(workout.meta.duration) {
        return `${Math.round(workout.meta.duration / 60)} min`;
    }
    return '';
}

function workoutTemplate(workout, ftp) {
    const isDefault = !!workout.isDefault;
    const name = esc(workout.meta.name);
    const description = esc(workout.meta.description);
    const category = esc(workout.meta.category ?? '');
    const catColor = workoutCategoryColor[workout.meta.category]
        ?? WORKOUT_CATEGORY_FALLBACK_COLOR;
    const duration = durationText(workout);

    const isCourse = !exists(workout.intervals);
    const steps = isCourse ? [] : workoutToSteps(workout, ftp);

    const mini = isCourse
        ? `<div class="watts-wmini">${courseToGraph(workout, {width: 130, height: 40, aspectRatio: 130 / 40})}</div>`
        : miniProfileHtml(steps);

    const profile = isCourse
        ? `<div class="watts-wprof--course">${courseToGraph(workout, {width: 900, height: 170, aspectRatio: 900 / 170})}</div>`
        : fullProfileHtml(steps, ftp, workout.meta.duration ?? 0);

    // Default (built-in) workouts are read-only: their only menu action is
    // "Duplicate" (copy into My Workouts). The user's own workouts can be
    // edited in place, duplicated, or deleted.
    const menuItems = isDefault
        ? `<button class="watts-wmenu--item" data-action="duplicate" title="Copy into My Workouts and open in the designer">Duplicate</button>`
        : `<button class="watts-wmenu--item" data-action="edit" title="Edit this workout in the designer">Edit</button>
           <button class="watts-wmenu--item" data-action="duplicate" title="Save a copy into My Workouts">Duplicate</button>
           <button class="watts-wmenu--item watts-wmenu--item--danger" data-action="delete" title="Delete this workout">Delete</button>`;

    // The load-selector is a radio, not a toggle: exactly one workout is loaded
    // at a time, and db.workout is a single value shared by both library tabs,
    // so selecting here deselects whatever was chosen on the other tab.
    return `<workout-item class="watts-wrow" id="${workout.id}" metric="ftp">
                <div class="watts-wrow--head">
                    <button class="watts-wsel" role="radio" aria-checked="false"
                            title="Load this workout" aria-label="Load ${name}">
                        <span class="watts-wsel--dot"></span>
                    </button>
                    ${mini}
                    <div class="watts-wrow--text">
                        <div class="watts-wrow--name">${name}</div>
                        <div class="watts-wrow--desc">${description}</div>
                    </div>
                    <div class="watts-wrow--cat" style="color: ${catColor};">${category}</div>
                    <div class="watts-wrow--dur">${duration}</div>
                    <button class="watts-start-pill" title="Select this workout and go to the ride screen">START</button>
                    <div class="watts-wrow--options">
                        <button class="watts-dots" title="Options">⋮</button>
                        <div class="watts-wmenu" hidden>${menuItems}</div>
                    </div>
                    <span class="watts-chev">${chevronSvg}</span>
                </div>
                <div class="watts-wrow--expand" hidden>
                    ${profile}
                    <div class="watts-wexp--foot">
                        <div class="watts-wexp--desc">${description}</div>
                        <button class="watts-start-btn">Start Workout</button>
                    </div>
                </div>
            </workout-item>`;
}

class WorkoutList extends HTMLElement {
    constructor() {
        super();
        this.state = [];
        this.ftp = 0;
        this.workout = {};
    }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        // 'default' -> only built-in workouts, 'user' -> only the user's own.
        this.filter = this.getAttribute('filter') || 'user';

        xf.sub(`db:workouts`, this.onWorkouts.bind(this), this.signal);
        xf.sub('db:workout',  this.onWorkout.bind(this), this.signal);
        xf.sub(`db:ftp`,      this.onFTP.bind(this), this.signal);
        // switching library tabs collapses any open expanded row.
        xf.sub('action:nav',  this.onNav.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onNav(action) {
        if(String(action).startsWith('workouts')) {
            this.querySelectorAll('workout-item.is-expanded')
                .forEach((item) => item.collapse?.());
        }
    }
    onWorkout(value) {
        this.workout = value;
    }
    onFTP(value) {
        if(!equals(value, this.ftp)) {
            this.ftp = value;
            if(!empty(this.state)) {
                this.render();
            }
        }
    }
    onWorkouts(value) {
        this.state = value;
        this.render();
    }
    forFilter(state) {
        return (state ?? []).filter((w) =>
            this.filter === 'default' ? w.isDefault : !w.isDefault);
    }
    emptyHtml() {
        const msg = this.filter === 'default'
            ? `No built-in workouts found.`
            : `You have no saved workouts yet. Duplicate a Default workout, load a .zwo/.fit file, or build one in the Editor.`;
        return `<div class="watts-wempty">${msg}</div>`;
    }
    render() {
        const items = this.forFilter(this.state);
        if(empty(items)) {
            this.innerHTML = this.emptyHtml();
            return;
        }
        this.innerHTML = items.reduce((acc, workout) =>
            acc + workoutTemplate(workout, this.ftp), '');
    }
}

class WorkoutListItem extends HTMLElement {
    constructor() {
        super();
        this.isExpanded = false;
        this.isSelected = false;
        this.menuOpen = false;
    }
    connectedCallback() {
        const self = this;
        this.head = this.querySelector('.watts-wrow--head');
        this.expandCont = this.querySelector('.watts-wrow--expand');
        this.selectBtn = this.querySelector('.watts-wsel');
        this.optionsBtn = this.querySelector('.watts-wrow--options');
        this.menu = this.querySelector('.watts-wmenu');
        this.startPill = this.querySelector('.watts-start-pill');
        this.startBtn = this.querySelector('.watts-start-btn');
        this.id = this.getAttribute('id');
        this.workoutStatus = 'stopped';

        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        xf.sub('db:workout', this.onWorkout.bind(this), this.signal);
        // whether a ride is under way decides if loading another workout has
        // to be confirmed first
        xf.sub('db:workoutStatus', this.onWorkoutStatus.bind(this), this.signal);
        this.selectBtn.addEventListener('pointerup', this.onSelect.bind(this), this.signal);
        this.head.addEventListener('pointerup', this.onHeadClick.bind(this), this.signal);
        this.optionsBtn.addEventListener('pointerup', this.toggleMenu.bind(this), this.signal);
        this.menu.addEventListener('pointerup', this.onMenuItem.bind(this), this.signal);
        this.startPill.addEventListener('pointerup', this.onStart.bind(this), this.signal);
        if(exists(this.startBtn)) {
            this.startBtn.addEventListener('pointerup', this.onStart.bind(this), this.signal);
        }
        // clicking anywhere outside an open menu closes it.
        document.addEventListener('pointerup', this.onDocPointerUp.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onHeadClick(e) {
        // the load-selector, START and the 3-dot menu handle their own clicks;
        // closest() catches the inner <svg>/<button> targets too.
        if(e.target.closest('.watts-wsel')) return;
        if(e.target.closest('.watts-start-pill')) return;
        if(e.target.closest('.watts-wrow--options')) return;
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
        // accordion: only one row open at a time across the page.
        document.querySelectorAll('workout-item.is-expanded').forEach((item) => {
            if(!equals(item, this)) item.collapse?.();
        });
        this.expandCont.hidden = false;
        this.classList.add('is-expanded');
        this.isExpanded = true;
    }
    collapse() {
        this.expandCont.hidden = true;
        this.classList.remove('is-expanded');
        this.isExpanded = false;
    }
    onSelect(e) {
        e.stopPropagation();
        this.load();
    }
    onStart(e) {
        e.stopPropagation();
        this.load(() => xf.dispatch('ui:page-set', 'home'));
    }
    // Make this the loaded workout, then run `then` (START also navigates home).
    //
    // Swapping mid-ride would leave the watch running against the intervals of
    // the workout that is no longer loaded, so a ride in progress is stopped —
    // which ends and saves it — and that is worth asking about first.
    load(then) {
        const proceed = () => {
            xf.dispatch('ui:workout:select', this.id);
            then?.();
        };
        if(this.isSelected) { then?.(); return; }
        if(!equals(this.workoutStatus, 'started')) { proceed(); return; }

        const name = (this.querySelector('.watts-wrow--name')?.textContent ?? '').trim()
                  || 'this workout';
        confirmModal({
            head: 'Workout in progress',
            body: `Loading “${name}” will stop and save the workout you are riding. Continue?`,
            confirmLabel: 'Load workout',
            confirmClass: 'wl-confirm--go',
            onConfirm: () => {
                // already confirmed here — don't make the watch ask again
                xf.dispatch('ui:watchStop', {confirmed: true});
                proceed();
            },
        });
    }
    onWorkout(workout) {
        this.isSelected = equals(workout?.id, this.id);
        this.classList.toggle('is-selected', this.isSelected);
        this.selectBtn.setAttribute('aria-checked', String(this.isSelected));
    }
    onWorkoutStatus(status) {
        this.workoutStatus = status;
    }
    toggleMenu(e) {
        // stop the head's pointerup from also toggling the row, and stop the
        // document listener from immediately closing what we just opened.
        e.stopPropagation();
        if(this.menuOpen) {
            this.closeMenu();
        } else {
            this.openMenu();
        }
    }
    openMenu() {
        // only one menu open at a time across the list.
        document.querySelectorAll('.watts-wmenu:not([hidden])')
            .forEach((m) => { m.hidden = true; });
        document.querySelectorAll('.watts-wrow--head.menu-open')
            .forEach((el) => el.classList.remove('menu-open'));
        this.menu.hidden = false;
        this.head.classList.add('menu-open');
        this.menuOpen = true;
    }
    closeMenu() {
        this.menu.hidden = true;
        this.head.classList.remove('menu-open');
        this.menuOpen = false;
    }
    onDocPointerUp(e) {
        if(!this.menuOpen) return;
        if(this.optionsBtn.contains(e.target)) return; // toggleMenu handles this
        this.closeMenu();
    }
    onMenuItem(e) {
        const item = e.target.closest('.watts-wmenu--item');
        if(!item) return;
        e.stopPropagation();
        this.closeMenu();
        const action = item.dataset.action;
        if(action === 'edit') {
            xf.dispatch('ui:workout:edit', this.id);
        } else if(action === 'duplicate') {
            xf.dispatch('ui:workout:duplicate', this.id);
        } else if(action === 'delete') {
            this.confirmDelete();
        }
    }
    // Deleting a user workout is destructive and can't be undone, so confirm it.
    confirmDelete() {
        const name = (this.querySelector('.watts-wrow--name')?.textContent ?? '').trim()
                  || 'this workout';
        confirmModal({
            head: 'Delete workout',
            body: `Delete “${name}”? This can’t be undone.`,
            confirmLabel: 'Delete',
            confirmClass: 'btn--danger',
            onConfirm: () => xf.dispatch('ui:workout:remove', this.id),
        });
    }
}

customElements.define('workout-list', WorkoutList);
customElements.define('workout-item', WorkoutListItem);

export {
    workoutTemplate,
    workoutToSteps,
    miniProfileHtml,
    fullProfileHtml,
};
