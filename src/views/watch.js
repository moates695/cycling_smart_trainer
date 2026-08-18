import { xf } from '../functions.js';

class Watch extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        this.dom = {
            start:   document.querySelector('#watch-start'),
            pause:   document.querySelector('#watch-pause'),
            back:    document.querySelector('#watch-back'),
            forward: document.querySelector('#watch-forward'),
            stop:    document.querySelector('#watch-stop'),
            save:    document.querySelector('#activity-save'),
            // workout: document.querySelector('#start-workout'),
        };

        this.dom.start.addEventListener('pointerup', this.onStart, this.signal);
        this.dom.pause.addEventListener('pointerup', this.onPause, this.signal);
        this.dom.back.addEventListener('pointerup', this.onBack, this.signal);
        this.dom.forward.addEventListener('pointerup', this.onForward, this.signal);
        this.dom.stop.addEventListener('pointerup', this.onStop, this.signal);
        // this.dom.workout.addEventListener('pointerup', this.onWorkoutStart);
        this.dom.save.addEventListener(`pointerup`, this.onSave, this.signal);

        this.status  = 'stopped';
        this.armed   = false;
        this.elapsed = 0;

        this.renderInit(this.dom);

        xf.sub(`db:watchStatus`, this.onWatchStatus.bind(this), this.signal);
        xf.sub(`db:workoutStatus`, this.onWorkoutStatus.bind(this), this.signal);
        xf.sub(`db:watchArmed`, this.onArmed.bind(this), this.signal);
        xf.sub(`db:elapsed`, this.onElapsed.bind(this), this.signal);
        xf.sub(`db:lock`, this.onLock.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onStart(e) {
        xf.dispatch('ui:watchStart');
        xf.dispatch('ui:workoutStart');
    }
    onPause(e) { xf.dispatch('ui:watchPause'); }
    onBack(e)  { xf.dispatch('ui:watchBack'); }
    onForward(e) { xf.dispatch('ui:watchForward'); }
    onStop(e)  { xf.dispatch('ui:watchStop'); }
    onSave(e)  { xf.dispatch('ui:activity:save'); }
    onWorkoutStart(e) { xf.dispatch('ui:workoutStart'); }
    onWatchStatus(status) {
        this.status = status;
        // While armed the transport shows the waiting state instead — the clock
        // has not started, so watchStatus is still paused or stopped.
        if(this.armed) return;
        if(status === 'started') { this.renderStarted(this.dom); }
        if(status === 'paused')  { this.renderPaused(this.dom);  }
        if(status === 'stopped') { this.renderStopped(this.dom); }
    }
    // Play was pressed and the ride is waiting on the pedals. Show pause, which
    // cancels the wait, and mark it so the control bar can say it is waiting.
    onArmed(armed) {
        this.armed = !!armed;
        if(this.armed) { this.renderArmed(this.dom); }
        else           { this.onWatchStatus(this.status); }
    }
    // Stop ends and saves the ride, so it has to stay reachable for as long as
    // there is a ride to end — including while paused. Availability tracks
    // elapsed time, not watchStatus: anything past 0s is a ride in progress.
    onElapsed(elapsed) {
        const was = this.elapsed;
        this.elapsed = elapsed ?? 0;
        if((was > 0) !== (this.elapsed > 0)) this.renderStop(this.dom);
    }
    onWorkoutStatus(status) {
        if(status === 'started') { this.renderWorkoutStarted(this.dom); }
        if(status === 'done')    {  }
    }
    // Prev/next segment navigation is blocked while locked (the back()/forward()
    // handlers in watch.js early-return); grey the buttons to match.
    onLock(lock) {
        this.dom.back.classList.toggle('is-disabled', lock);
        this.dom.forward.classList.toggle('is-disabled', lock);
    }
    // NOTE: reveal buttons with 'grid' (not 'inline-block'). Two legacy rules
    // matter: `.watts-tbtn` is `display:grid; place-items:center` (centres the
    // icon), and an id-specificity rule force-hides pause/lap/stop/save. Inline
    // 'grid' overrides the hide AND keeps the icon centred — 'inline-block'
    // centred nothing (pushed the icon to the top-left) and '' fell back to the
    // hide rule so the buttons never appeared.
    // Stop is always present in the control bar, and enabled whenever the ride
    // has any elapsed time on it — started or paused. It only greys out before
    // the first second is on the clock, and again after a stop resets it to 0.
    renderStop(dom) {
        dom.stop.style.display = 'grid';
        dom.stop.classList.toggle('is-disabled', !(this.elapsed > 0));
    };
    // Back/next stay visible in every state: while stopped the watch is
    // "waiting to start" (same as paused), and prev/next pre-select the
    // interval the workout will start from.
    renderInit(dom) {
        dom.pause.style.display   = 'none';
        dom.save.style.display    = 'none';
        dom.back.style.display    = 'grid';
        dom.forward.style.display = 'grid';
        this.renderStop(dom);
    };
    // Waiting for the rider: pause is the way out, and there is nothing to save
    // yet. Stop stays available if this is a resume of a ride already underway.
    renderArmed(dom) {
        dom.start.style.display   = 'none';
        dom.save.style.display    = 'none';
        dom.pause.style.display   = 'grid';
        dom.pause.classList.add('is-armed');
        dom.back.style.display    = 'grid';
        dom.forward.style.display = 'grid';
        this.renderStop(dom);
    };
    renderStarted(dom) {
        dom.pause.classList.remove('is-armed');
        dom.start.style.display   = 'none';
        dom.save.style.display    = 'none';
        dom.pause.style.display   = 'grid';
        dom.back.style.display    = 'grid';
        dom.forward.style.display = 'grid';
        this.renderStop(dom);
    };
    renderPaused(dom) {
        dom.pause.classList.remove('is-armed');
        dom.pause.style.display    = 'none';
        dom.start.style.display    = 'grid';
        // Keep back/next available while paused so you can skip segments
        // before resuming (workoutStatus stays 'started' through a pause).
        dom.back.style.display     = 'grid';
        dom.forward.style.display  = 'grid';
        this.renderStop(dom);
    };
    renderStopped(dom) {
        dom.pause.classList.remove('is-armed');
        dom.pause.style.display   = 'none';
        dom.back.style.display    = 'grid';
        dom.forward.style.display = 'grid';
        dom.save.style.display    = 'grid';
        dom.start.style.display   = 'grid';
        this.renderStop(dom);
    };
    renderWorkoutStarted(dom) {
        // dom.workout.style.display = 'none';
    };
}

customElements.define('watch-control', Watch);

export { Watch };
