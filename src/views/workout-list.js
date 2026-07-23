import { xf, exists, empty, equals, debounce } from '../functions.js';
import { models } from '../models/models.js';
import { intervalsToGraph, courseToGraph, renderInfo } from './workout-graph.js';

const radioOff = `
        <svg class="radio radio-off">
            <use href="#icon--radio-off">
        </svg>`;

const radioOn = `
        <svg class="radio radio-on">
            <use href="#icon--radio-on">
        </svg>`;

const options = `
        <svg class="workout--options-btn control--btn--icon">
            <use href="#icon--options">
        </svg>`;

function workoutTemplate(workout) {
    let duration = '';
    if(workout.meta.duration) {
        duration = `${Math.round(workout.meta.duration / 60)} min`;
    }
    if(workout.meta.distance) {
        duration = `${(workout.meta.distance / 1000).toFixed(2)} km`;
    }
    // Default (built-in) workouts are read-only: their only menu action is
    // "Duplicate" (copy into My workouts). The user's own workouts can be edited
    // in place, duplicated, or deleted. All of these live in the 3-dot menu.
    const isDefault = !!workout.isDefault;
    const menuItems = isDefault
        ? `<button class="workout--menu-item" data-action="duplicate" title="Copy into My workouts and open in the designer">Duplicate</button>`
        : `<button class="workout--menu-item" data-action="edit" title="Edit this workout in the designer">Edit</button>
                                <button class="workout--menu-item" data-action="duplicate" title="Save a copy into My workouts">Duplicate</button>
                                <button class="workout--menu-item workout--menu-item--danger" data-action="delete" title="Delete this workout">Delete</button>`;
    return `<workout-item class='workout cf' id="${workout.id}" metric="ftp">
                <div class="workout--info">
                    <div class="workout--short-info">
                        <div class="workout--summary">
                            <div class="workout--name">${workout.meta.name}</div>
                            <div class="workout--type">${workout.meta.category}</div>
                            <div class="workout--duration">${duration}</div>
                            <div class="workout--select" id="btn${workout.id}">${workout.selected ? radioOn : radioOff}
                            </div>
                            <div class="workout--options">${options}
                                <div class="workout--menu" hidden>${menuItems}</div>
                            </div>
                        </div>
                    </div>
                    <div class="workout--full-info">
                        <div class="workout-list--graph-cont">${workout.graph}</div>
                        <div class="workout--description">${workout.meta.description}</div>
                    </div>
                </div>
            </workout-item>`;
}

class WorkoutList extends HTMLElement {
    constructor() {
        super();
        this.state = [];
        this.ftp = 0;
        this.items = [];
        this.postInit();
        this.workout = {};
    }
    postInit() { return; }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        // 'default' -> only built-in workouts, 'user' -> only the user's own.
        this.filter = this.getAttribute('filter') || 'user';

        xf.sub(`db:workouts`, this.onWorkouts.bind(this), this.signal);
        xf.sub('db:workout',  this.onWorkout.bind(this), this.signal); // ?
        xf.sub(`db:ftp`,      this.onFTP.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    getWidth() {
        return window.innerWidth;
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
    getViewPort() {
        const self = this;

        const $el = document.querySelector('#workouts-page');
        const fontSize = parseInt(window.getComputedStyle($el).getPropertyValue('font-size'));
        const em = 8;

        const width = self.getWidth();
        const height = fontSize * em;
        const aspectRatio = width / height;


        return {
            height,
            width,
            aspectRatio,
        };
    }
    stateToHtml(state, ftp, selectedWorkout) {
        const self = this;
        const viewPort = this.getViewPort();

        return state.reduce((acc, workout, i) => {
            let graph = '';

            if(exists(workout.intervals)) {
                graph = intervalsToGraph(workout, ftp, viewPort);
            } else {
                graph = courseToGraph(workout, viewPort);
            }

            const selected = equals(workout.id, selectedWorkout.id);
            workout = Object.assign(workout, {graph: graph, selected: selected});
            return acc + workoutTemplate(workout);
        }, '');
    }
    forFilter(state) {
        return (state ?? []).filter((w) =>
            this.filter === 'default' ? w.isDefault : !w.isDefault);
    }
    emptyHtml() {
        const msg = this.filter === 'default'
            ? `No built-in workouts found.`
            : `You have no saved workouts yet. Copy a default workout below, upload a .zwo/.fit, or build one in the Editor.`;
        return `<div class="workout--empty">${msg}</div>`;
    }
    render() {
        const items = this.forFilter(this.state);
        if(empty(items)) {
            this.innerHTML = this.emptyHtml();
            return;
        }
        this.innerHTML = this.stateToHtml(items, this.ftp, this.workout);
    }
}



class WorkoutListItem extends HTMLElement {
    constructor() {
        super();
        this.state = '';
        this.isExpanded = false;
        this.isSelected = false;
        this.menuOpen = false;
    }
    connectedCallback() {
        const self = this;
        this.infoCont = this.querySelector('.workout--info');
        this.summary = this.querySelector('.workout--summary');
        this.description = this.querySelector('.workout--full-info');
        this.selectBtn = this.querySelector('.workout--select');
        this.optionsBtn = this.querySelector('.workout--options');
        this.menu = this.querySelector('.workout--menu');
        this.indicator = this.selectBtn;
        this.id = this.getAttribute('id');

        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        this.debounced = {
            onWindowResize: debounce(
                self.onWindowResize.bind(this), 300, {trailing: true, leading: false},
            ),
        };

        this.dom = {};
        this.dom.info = this.querySelector('.graph--info--cont');
        this.dom.cont = this.querySelector('.workout-list--graph-cont');
        this.viewPort = this.getViewPort();

        xf.sub('db:workout', this.onWorkout.bind(this), this.signal);
        this.summary.addEventListener('pointerup', this.toggleExpand.bind(this), this.signal);
        this.optionsBtn.addEventListener('pointerup', this.toggleMenu.bind(this), this.signal);
        this.menu.addEventListener('pointerup', this.onMenuItem.bind(this), this.signal);
        this.selectBtn.addEventListener('pointerup', this.onRadio.bind(this), this.signal);
        // clicking anywhere outside an open menu closes it.
        document.addEventListener('pointerup', this.onDocPointerUp.bind(this), this.signal);

        this.addEventListener('mouseover', this.onHover.bind(this), this.signal);
        this.addEventListener('mouseout', this.onMouseOut.bind(this), this.signal);
        window.addEventListener('resize', this.debounced.onWindowResize.bind(this), this.signal);

    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    toggleExpand(e) {
        // clicks on the 3-dot menu (icon, button, or the open menu itself) must
        // not toggle the graph. closest() catches the inner <svg>/<use> targets
        // that the old classList check missed.
        if(e.target.closest('.workout--options')) {
            return;
        }
        if(this.isExpanded) {
            this.collapse();
        } else {
            this.expand();
        }
    }
    expand() {
        this.description.style.display = 'block';
        this.isExpanded = true;
    }
    collapse() {
        this.description.style.display = 'none';
        this.isExpanded = false;
    }
    toggleSelect(id) {
        if(equals(this.id, id)) {
            if(!this.isSelected) {
                this.select();
                this.expand();
            }
        } else {
            this.diselect();
        }
    }
    select() {
        this.indicator.innerHTML = radioOn;
        this.isSelected = true;
    }
    diselect() {
        this.indicator.innerHTML = radioOff;
        this.isSelected = false;
    }
    toggleMenu(e) {
        // stop the summary's pointerup from also toggling the graph, and stop
        // the document listener from immediately closing what we just opened.
        e.stopPropagation();
        if(this.menuOpen) {
            this.closeMenu();
        } else {
            this.openMenu();
        }
    }
    openMenu() {
        // only one menu open at a time across the list; also drop any stale
        // row elevation so this row's dropdown sits above its neighbours.
        document.querySelectorAll('.workout--menu:not([hidden])')
            .forEach((m) => { m.hidden = true; });
        document.querySelectorAll('.workout--info.menu-open')
            .forEach((el) => el.classList.remove('menu-open'));
        this.menu.hidden = false;
        this.infoCont.classList.add('menu-open');
        this.menuOpen = true;
    }
    closeMenu() {
        this.menu.hidden = true;
        this.infoCont.classList.remove('menu-open');
        this.menuOpen = false;
    }
    onDocPointerUp(e) {
        if(!this.menuOpen) return;
        if(this.optionsBtn.contains(e.target)) return; // toggleMenu handles this
        this.closeMenu();
    }
    onMenuItem(e) {
        const item = e.target.closest('.workout--menu-item');
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
        const name = (this.querySelector('.workout--name')?.textContent ?? '').trim();
        const backdrop = document.createElement('div');
        backdrop.className = 'wl-modal-backdrop';
        backdrop.innerHTML = `
            <div class="wl-modal" role="dialog" aria-modal="true">
                <div class="wl-modal-head">Delete workout</div>
                <div class="wl-modal-body">Delete “<span class="wl-modal-name"></span>”? This can’t be undone.</div>
                <div class="wl-modal-foot">
                    <button class="wl-cancel btn">Cancel</button>
                    <button class="wl-confirm btn btn--danger">Delete</button>
                </div>
            </div>`;
        // set via textContent so a workout name can never inject markup.
        backdrop.querySelector('.wl-modal-name').textContent = name || 'this workout';
        const close = () => backdrop.remove();
        backdrop.addEventListener('pointerup', (ev) => {
            ev.stopPropagation();
            if(ev.target === backdrop || ev.target.closest('.wl-cancel')) { close(); return; }
            if(ev.target.closest('.wl-confirm')) {
                xf.dispatch('ui:workout:remove', this.id);
                close();
            }
        });
        document.body.appendChild(backdrop);
    }
    onWorkout(workout) {
        this.workout = workout;
        this.toggleSelect(workout.id);
    }
    onRadio(e) {
        e.stopPropagation();
        xf.dispatch('ui:workout:select', this.id);
    }
    onUpdate(value) {
        if(!equals(value, this.state)) {
            this.state = value;
            this.render();
        }
    }
    onHover(e) {
        const self = this;
        const target = this.querySelector('.graph--bar:hover');
        if(exists(target)) {
            const power        = target.getAttribute('power');
            const cadence      = target.getAttribute('cadence');
            const slope        = target.getAttribute('slope');
            const duration     = target.getAttribute('duration');
            const distance     = target.getAttribute('distance');
            const intervalRect = target.getBoundingClientRect();
            this.viewPort      = this.getViewPort(); // move to more sensible event

            this.renderInfo({
                power,
                cadence,
                slope,
                duration,
                distance,
                intervalRect,
                contRect: self.viewPort,
                dom: self.dom,
            });
        }
    }
    onMouseOut(e) {
        this.dom.info.style.display = 'none';
    }
    getViewPort() {
        const rect = this.dom.cont.getBoundingClientRect();
        return {
            width: rect.width,
            height: rect.height,
            left: rect.left,
            aspectRatio: rect.width / rect.height,
        };
    }
    onWindowResize(e) {
        this.viewPort = this.getViewPort();
    }
    render() {}
    renderInfo(args = {}) {
        renderInfo(args);
    }
}

customElements.define('workout-list', WorkoutList);
customElements.define('workout-item', WorkoutListItem);

export {
    radioOff,
    radioOn,
    options,
    workoutTemplate,
};

