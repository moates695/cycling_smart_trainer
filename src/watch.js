import { equals, exists, empty, first, last, xf, avg, max, clamp, toFixed, print, } from './functions.js';
import { kphToMps, mpsToKph, timeDiff, pad } from './utils.js';
import { models } from './models/models.js';
import { ControlMode, } from './ble/enums.js';
import { TimerStatus, EventType, } from './activity/enums.js';
import { WorkoutCategory } from './workouts/categories.js';
import {
    TimingAction, timingDefaults, onPowerSample,
} from './watch-timing.js';
import { timer } from './timer-worker.js';

// Media-player "prev" grace window (seconds). If the "prev" button is pressed
// within this many seconds of entering the current interval, jump to the start
// of the *previous* interval; past it, restart the *current* interval.
const BACK_TO_PREV_WINDOW_S = 5;

class Watch {
    constructor(args) {
        this.elapsed          = 0;
        this.lapTime          = 0;
        this.stepTime         = 0;

        this.intervalIndex    = 0;
        this.stepIndex        = 0;
        this.intervalDuration = 0;
        this.stepDuration     = 0;

        this.state            = 'stopped';
        this.stateWorkout     = 'stopped';

        // Distance
        this.intervalType      = 'duration';
        // end Distance

        this.intervals         = [];
        this.workoutType       = "workout";
        this.lock              = false;
        // Arming / auto pause / auto resume state — the rules live in
        // watch-timing.js, this is just where they are kept between samples.
        this.timing            = timingDefaults();
        // Latest 1 s power, so the arming clock has something to read even on a
        // second where the trainer sent nothing.
        this.power             = 0;
        this.armClock          = undefined;
        this.autoStart         = true;
        this.autoPause         = true;
        this.init();
    }
    init() {
        const self = this;

        // Data subs
        xf.sub('db:elapsed',       elapsed => { self.elapsed       = elapsed; });
        xf.sub('db:lapTime',          time => { self.lapTime       = time; });
        xf.sub('db:stepTime',         time => { self.stepTime      = time; });
        xf.sub('db:intervalDuration', time => { self.lapDuration   = time; });
        xf.sub('db:stepDuration',     time => { self.stepDuration  = time; });
        xf.sub('db:intervalIndex',   index => { self.intervalIndex = index; });
        xf.sub('db:lock',             lock => { self.lock          = lock; });
        xf.sub('db:stepIndex',       index => { self.stepIndex     = index; });
        xf.sub('db:watchStatus',     state => { self.state         = state; });
        xf.sub('db:workoutStatus',   state => {
            self.stateWorkout = state;

            if(self.isWorkoutDone()) {
                xf.dispatch('watch:lap');
                // reset to slope mode 0% when workout is done
                xf.dispatch('ui:slope-target-set', 0);
                xf.dispatch('ui:mode-set', ControlMode.sim);
                console.log(`Workout done!`);
            }
        });
        xf.sub('db:workout',       workout => {
            self.intervals = workout.intervals;
            // A pre-start prev/next selection points into the old workout's
            // intervals — reset it so start doesn't index out of range.
            if(!self.isWorkoutStarted() && self.isStopped() && self.intervalIndex !== 0) {
                xf.dispatch('watch:intervalIndex', 0);
            }
            if(workout.meta.category?.toLowerCase().includes(WorkoutCategory.test.toLowerCase())) {
                self.workoutType = "test";
                // force turn off auto pausing for Test Category workouts
                xf.dispatch(`sources`, {autoPause: false});
            } else {
                self.workoutType = "workout";
            }
            console.log(`:workout :type ${self.workoutType}`);
        });
        xf.sub('db:power1s', self.onPower1s.bind(this));
        xf.sub('db:sources', self.onSources.bind(this));
        timer.addEventListener('message', self.onTick.bind(self));

        // Fast forward. Only the device sim dispatches this (sim.js), and only
        // in dev — it runs the workout clock faster than real time so a session
        // can be watched end to end without riding it.
        xf.sub('sim:speed', self.onSpeed.bind(self));

        // UI subs. Play dispatches both of these together; arming is idempotent
        // so the pair reads as the single press it is.
        xf.sub('ui:workoutStart', e => { self.onStartPressed();  });
        xf.sub('ui:watchStart',   e => { self.onStartPressed();  });
        xf.sub('workout:restore', e => { self.restoreWorkout(); });
        xf.sub('ui:watchPause',   e => { self.pause();          });
        xf.sub('ui:watchResume',  e => { self.resume();         });
        xf.sub('ui:watchLap',     e => { self.lap();            });
        xf.sub('ui:watchBack',    e => { self.back();           });
        xf.sub('ui:watchForward', e => { self.forward();        });
        xf.sub('ui:watchGoto',  pos => { self.goto(pos?.intervalIndex, pos?.stepIndex, pos?.stepElapsed); });
        xf.sub('ui:watchStop',    e => {
            // callers that have already asked the user — loading a different
            // workout from the library mid-ride — pass {confirmed: true} so we
            // don't prompt twice for the same decision.
            const stop = e?.confirmed || confirm('Confirm Stop?');
            if(stop) {
                self.stop();
            }
        });
    }
    isStarted()        { return this.state        === 'started'; };
    isPaused()         { return this.state        === 'paused'; };
    isStopped()        { return this.state        === 'stopped'; };
    isWorkoutStarted() { return this.stateWorkout === 'started'; };
    isWorkoutDone()    { return this.stateWorkout === 'done'; };
    isIntervalType(type) {
        return equals(this.intervalType, type);
    }
    status() {
        return this.state;
    }
    onSources(value) {
        this.autoStart = value.autoStart ?? this.autoStart;
        this.autoPause = value.autoPause ?? this.autoPause;
    }
    // Tick the workout clock at `rate` x real time. The worker keeps the rate
    // across start/pause/stop, so this can be changed mid-ride.
    onSpeed(rate) {
        timer.postMessage({cmd: 'rate', rate: clamp(1, 20, rate ?? 1)});
    }
    onPower1s(power) {
        this.power = power ?? 0;
        // While armed the wait is driven by its own clock below, so that the
        // 15 s is 15 s of real time: db:power1s only fires while the trainer is
        // actually sending, and a silent one would stall the wait forever.
        if(this.timing.armed) return;
        this.applyTiming(this.power);
    }
    onArmTick() {
        if(!this.timing.armed) return;
        this.applyTiming(this.power);
    }
    applyTiming(power) {
        const wasArmed = this.timing.armed;
        const {state, action} = onPowerSample({
            power,
            status:   this.state,
            state:    this.timing,
            settings: {autoStart: this.autoStart, autoPause: this.autoPause},
        });
        this.timing = state;
        if(!equals(wasArmed, state.armed)) {
            this.stopArmClock();
            xf.dispatch('watch:armed', state.armed);
        }

        // arm-expired needs nothing beyond leaving armed: the clock was never
        // started, so the watch is already back where it was.
        if(equals(action, TimingAction.launch))     this.launch();
        if(equals(action, TimingAction.autoPause))  xf.dispatch('ui:watchPause');
        if(equals(action, TimingAction.autoResume)) xf.dispatch('ui:watchResume');
    }
    stopArmClock() {
        if(!exists(this.armClock)) return;
        clearInterval(this.armClock);
        this.armClock = undefined;
    }
    // Play. Rather than starting the clock, this arms the watch: the ride
    // begins on the rider's first turn of the pedals, and gives up after
    // ARM_WINDOW_S if they never get going. Press pause to cancel the wait.
    onStartPressed() {
        // Play on a running free ride is still the pause toggle it always was.
        if(this.isStarted() && !this.isWorkoutStarted()) {
            this.pause();
            return;
        }
        if(this.isStarted()) return;
        this.arm();
    }
    arm() {
        if(this.timing.armed) return;
        this.timing = {...this.timing, armed: true, armCounter: 0};
        this.stopArmClock();
        this.armClock = setInterval(this.onArmTick.bind(this), 1000);
        xf.dispatch('watch:armed', true);
    }
    disarm() {
        this.stopArmClock();
        if(!this.timing.armed) return;
        this.timing = {...this.timing, armed: false, armCounter: 0};
        xf.dispatch('watch:armed', false);
    }
    // The rider turned the pedals while armed — start for real. Mid-ride that
    // means picking the clock back up; from a standstill it means opening the
    // workout at its first interval.
    launch() {
        if(this.isPaused()) {
            this.resume();
            return;
        }
        this.beginWorkout();
    }
    startTimer() {
        // The clock is running again, so whatever pause the app made is
        // settled — a pause from here on is the rider's until it says otherwise.
        this.timing = {
            ...this.timing,
            pausedAutomatically: false,
            idleCounter: 0,
            startCounter: 0,
            coastedSincePause: false,
        };

        timer.postMessage('start');
        xf.dispatch('watch:started');

        xf.dispatch('watch:event', {
            timestamp: Date.now(),
            type: EventType.start,
        });
    }
    beginWorkout() {
        const self = this;

        const alreadyRunning = self.isWorkoutStarted() || (
            // check for intervalIndex allows for multiple workouts in one session
            self.isWorkoutDone() && self.intervalIndex > 0
        );

        if(!alreadyRunning && exists(self.intervals)) {
            // Start from the interval pre-selected with prev/next while
            // stopped (0 in the default flow — stop() resets the index).
            const i = exists(self.intervals[self.intervalIndex]) ? self.intervalIndex : 0;

            const intervalTime = self.intervals[i]?.duration ?? 0;
            const stepTime     = self.intervals[i]?.steps[0].duration ?? 0;

            xf.dispatch('watch:intervalIndex',  i);
            xf.dispatch('watch:stepIndex', 0);

            xf.dispatch('workout:started');

            xf.dispatch('watch:intervalDuration', intervalTime);
            xf.dispatch('watch:stepDuration',     stepTime);
            xf.dispatch('watch:lapTime',          intervalTime);
            xf.dispatch('watch:stepTime',         stepTime);
        }

        if(exists(self.points)) {
            self.intervalType = 'distance';
        }

        if(!self.isStarted()) {
            self.startTimer();
        }
    }
    restoreWorkout() {
        const self = this;

        if(self.isWorkoutStarted()) {
            xf.dispatch('workout:started');
        }
        if(self.isStarted()) {
            self.pause();
        }
        // A restored ride is parked paused: it was either running or already
        // auto paused when the page went away, and the rider never stopped it.
        // That pause is the app's doing, not theirs, so auto start picks it back
        // up on the first turn of the pedals rather than making them press play
        // to carry on a ride they never ended.
        if(self.isPaused()) {
            self.timing = {...self.timing, pausedAutomatically: true};
        }
    }
    resume() {
        const self = this;
        if(!self.isStarted()) {
            self.startTimer();
        }
    }
    pause() {
        const self = this;
        // Pause also cancels a wait for the pedals — until the watch is
        // actually running there is nothing else to stop.
        self.disarm();
        if(!self.isStarted()) return;

        timer.postMessage('pause');
        xf.dispatch('watch:paused');

        xf.dispatch('watch:event', {
            timestamp: Date.now(),
            type: EventType.stop,
        });
    }
    stop() {
        const self = this;
        self.disarm();
        if(self.isStarted() || self.isPaused()) {
            timer.postMessage('stop');

            xf.dispatch('watch:event', {
                timestamp: Date.now(),
                type: EventType.stop,
            });


            if(self.isWorkoutStarted()) {
                xf.dispatch('workout:stopped');
            }

            self.lap();

            // should be called after event and lap are created
            xf.dispatch('watch:stopped');

            if(exists(self.intervals)) {
                xf.dispatch('watch:intervalIndex', 0);
                xf.dispatch('watch:stepIndex',     0);
            }
            xf.dispatch('watch:elapsed', 0);
            xf.dispatch('watch:lapTime', 0);
        }
    }
    onTick() {
        const self   = this;
        let elapsed  = self.elapsed + 1;
        let lapTime  = self.lapTime;
        let stepTime = self.stepTime;

        if(self.isWorkoutStarted() && !equals(self.stepTime, 0)) {
            lapTime  -= 1;
            stepTime -= 1;
        } else {
            lapTime  += 1;
        }

        if(equals(lapTime, 4) && stepTime > 0) {
            xf.dispatch('watch:beep', 'interval');
        }
        xf.dispatch('watch:elapsed',  elapsed);
        xf.dispatch('watch:lapTime',  lapTime);
        xf.dispatch('watch:stepTime', stepTime);

        if(self.isWorkoutStarted() &&
           (stepTime <= 0) &&
            this.isIntervalType('duration')) {

            self.step();
        }
    }
    lap() {
        const self = this;

        if(self.isWorkoutStarted()) {
            let i             = self.intervalIndex;
            let s             = self.stepIndex;
            let intervals     = self.intervals;
            let moreIntervals = i < (intervals.length - 1);

            if(moreIntervals) {
                i += 1;
                s  = 0;

                self.nextInterval(intervals, i, s);
                self.nextStep(intervals, i, s);
            } else {
                xf.dispatch('workout:done');
            }
        } else {
            xf.dispatch('watch:lap');
            xf.dispatch('watch:lapTime', 0);
        }
    }
    step() {
        const self        = this;
        let i             = self.intervalIndex;
        let s             = self.stepIndex;
        let intervals     = self.intervals;
        let steps         = intervals[i].steps;
        let moreIntervals = i < (intervals.length  - 1);
        let moreSteps     = s < (steps.length - 1);

        if(moreSteps) {
            s += 1;
            self.nextStep(intervals, i, s);
        } else if (moreIntervals) {
            i += 1;
            s  = 0;

            self.nextInterval(intervals, i, s);
            self.nextStep(intervals, i, s);
        } else {
            xf.dispatch('workout:done');
        }
    }
    nextInterval(intervals, intervalIndex, stepIndex) {
        if(exists(intervals[intervalIndex].duration)) {
            return this.nextDurationInterval(intervals, intervalIndex, stepIndex);
        }
        return undefined;
    }
    nextStep(intervals, intervalIndex, stepIndex) {
        if(this.isDurationStep(intervals, intervalIndex, stepIndex)) {
            this.intervalType = 'duration';
            return this.nextDurationStep(intervals, intervalIndex, stepIndex);
        }
        return undefined;
    }
    back() {
        const self = this;

        // Prev/next segment navigation is disabled while the workout is locked.
        if(self.lock) return;

        if(self.isWorkoutStarted()) {
            const i = self.intervalIndex;

            // Media-player style "prev": if we're more than the grace window
            // into the current interval, restart the current interval;
            // otherwise (within the window) jump to the start of the previous.
            const elapsedInInterval = (self.lapDuration ?? 0) - (self.lapTime ?? 0);
            const withinStart       = elapsedInInterval <= BACK_TO_PREV_WINDOW_S;

            let target = i;
            if(withinStart && (i - 1) >= 0) {
                target = i - 1;
            }

            self.goto(target, 0, 0);
        } else if(self.isStopped()) {
            self.seekPending(self.intervalIndex - 1);
        } else {
            xf.dispatch('watch:lap');
            xf.dispatch('watch:lapTime', 0);
        }
    }
    forward() {
        const self = this;

        // Prev/next segment navigation is disabled while the workout is locked.
        if(self.lock) return;

        if(self.isWorkoutStarted()) {
            let i             = self.intervalIndex;
            let intervals     = self.intervals;
            let moreIntervals = (i + 1) <= (intervals.length - 1);

            if(moreIntervals) {
                i += 1;

                self.nextInterval(intervals, i, 0);
                self.nextStep(intervals, i, 0);
            }
        } else if(self.isStopped()) {
            self.seekPending(self.intervalIndex + 1);
        }
    }
    // Pre-start prev/next: while the watch is stopped ("waiting to start")
    // select the interval the workout will start from. Mirrors what
    // startWorkout() dispatches for its starting interval, but must not go
    // through nextInterval() — that dispatches 'watch:lap', which would record
    // a bogus lap (lapStartTime is not set until the watch starts).
    seekPending(intervalIndex) {
        const self      = this;
        const intervals = self.intervals;

        if(!exists(intervals) || !exists(intervals[intervalIndex])) return;

        // A finished session left workoutStatus 'done'; clear it so
        // startWorkout()'s multiple-workouts guard doesn't see the
        // pre-selected index as a restored session and refuse to start.
        if(self.isWorkoutDone()) {
            xf.dispatch('workout:stopped');
        }

        const intervalTime = intervals[intervalIndex]?.duration ?? 0;
        const stepTime     = intervals[intervalIndex]?.steps[0]?.duration ?? 0;

        xf.dispatch('watch:intervalIndex',    intervalIndex);
        xf.dispatch('watch:stepIndex',        0);
        xf.dispatch('watch:intervalDuration', intervalTime);
        xf.dispatch('watch:stepDuration',     stepTime);
        xf.dispatch('watch:lapTime',          intervalTime);
        xf.dispatch('watch:stepTime',         stepTime);
    }
    // Seek to an exact point in the workout (used by dragging the progress
    // handle). stepElapsed lets the drop land anywhere inside a step, not just
    // snap to its leading edge.
    goto(intervalIndex, stepIndex = 0, stepElapsed = 0) {
        const self      = this;
        const intervals = self.intervals;

        if(!self.isWorkoutStarted()) return;
        if(!exists(intervals) || !exists(intervals[intervalIndex])) return;

        const steps = intervals[intervalIndex].steps;
        const s     = Math.max(0, Math.min(steps.length - 1, stepIndex ?? 0));

        self.nextInterval(intervals, intervalIndex, s);
        self.nextStep(intervals, intervalIndex, s);

        // nextInterval/nextStep reset lap/step time to their full durations.
        // Correct them for the exact drop point: how much of this step is left,
        // plus the remaining steps in the interval.
        const stepDuration  = steps[s].duration ?? 0;
        const elapsedInStep = Math.max(0, Math.min(stepDuration, stepElapsed ?? 0));
        const stepRemaining = stepDuration - elapsedInStep;

        let lapTime = stepRemaining;
        for(let k = s + 1; k < steps.length; k += 1) lapTime += steps[k].duration ?? 0;

        xf.dispatch('watch:stepTime', stepRemaining);
        xf.dispatch('watch:lapTime',  lapTime);
    }

    isDurationStep(intervals, intervalIndex, stepIndex) {
        return exists(intervals[intervalIndex].steps[stepIndex].duration);
    }
    nextDurationInterval(intervals, intervalIndex, stepIndex) {
        const intervalDuration = this.intervalsToDuration(intervals, intervalIndex);
        const stepDuration     = this.intervalsToStepDuration(intervals, intervalIndex, stepIndex);
        this.dispatchInterval(intervalDuration, intervalIndex);
    }
    nextDurationStep(intervals, intervalIndex, stepIndex) {
        const stepDuration = this.intervalsToStepDuration(intervals, intervalIndex, stepIndex);
        this.dispatchStep(stepDuration, stepIndex);
    }
    intervalsToDuration(intervals, intervalIndex) {
        return intervals[intervalIndex].duration;
    }
    intervalsToStepDuration(intervals, intervalIndex, stepIndex) {
        const steps = intervals[intervalIndex].steps;
        return steps[stepIndex].duration;
    }
    dispatchInterval(intervalDuration, intervalIndex) {
        xf.dispatch('watch:intervalDuration', intervalDuration);
        xf.dispatch('watch:lapTime',          intervalDuration);
        xf.dispatch('watch:intervalIndex',    intervalIndex);
        xf.dispatch('watch:lap');
    }
    dispatchStep(stepDuration, stepIndex) {
        xf.dispatch('watch:stepDuration', stepDuration);
        xf.dispatch('watch:stepTime',     stepDuration);
        xf.dispatch('watch:stepIndex',    stepIndex);
        xf.dispatch('watch:step');
    }
}

// These regs have access to the global db state and can mutate it
xf.reg('watch:intervalDuration', (time, db) => db.intervalDuration = time);
xf.reg('watch:stepDuration',   (time, db) => db.stepDuration     = time);
xf.reg('watch:lapTime',        (time, db) => db.lapTime          = time);
xf.reg('watch:stepTime',       (time, db) => db.stepTime         = time);
xf.reg('watch:intervalIndex', (index, db) => db.intervalIndex    = index);
xf.reg('watch:stepIndex',     (index, db) => {
    db.stepIndex         = index;
    const intervalIndex  = db.intervalIndex;
    const powerTarget    = db.workout.intervals[intervalIndex].steps[index].power;
    const slopeTarget    = db.workout.intervals[intervalIndex].steps[index].slope;
    const cadenceTarget  = db.workout.intervals[intervalIndex].steps[index].cadence;
    const distanceTarget = db.workout.intervals[intervalIndex].steps[index].distance;

    if(exists(slopeTarget)) {
        xf.dispatch('ui:slope-target-set', slopeTarget);
        if(!equals(db.mode, ControlMode.sim)) {
            xf.dispatch('ui:mode-set', ControlMode.sim);
        }
    }
    if(exists(distanceTarget)) {
        xf.dispatch('ui:distance-target-set', distanceTarget);
    }
    if(exists(cadenceTarget)) {
        xf.dispatch('ui:cadence-target-set', cadenceTarget);
    } else {
        xf.dispatch('ui:cadence-target-set', 0);
    }
    if(exists(powerTarget)) {
        xf.dispatch('ui:power-target-set', models.workoutIntensity.apply(
            db.workoutIntensity ?? 100, models.ftp.toAbsolute(powerTarget, db.ftp)));
        if(!exists(slopeTarget) && !equals(db.mode, ControlMode.erg)) {
            xf.dispatch('ui:mode-set', ControlMode.erg);
        }
    } else {
        xf.dispatch('ui:power-target-set', 0);
    }
});
xf.reg('workout:started', (x, db) => db.workoutStatus = 'started');
xf.reg('workout:stopped', (x, db) => db.workoutStatus = 'stopped');
xf.reg('workout:done',    (x, db) => db.workoutStatus = 'done');
xf.reg('watch:started',   (x, db) => {
    db.watchStatus = 'started';
    if(db.lapStartTime === false) {
        db.lapStartTime = Date.now(); // if first lap
    }
});
xf.reg('watch:paused',  (x, db) => db.watchStatus = 'paused');
xf.reg('watch:stopped', (x, db) => db.watchStatus = 'stopped');
// Play pressed, waiting for the rider to turn the pedals.
xf.reg('watch:armed',   (x, db) => db.watchArmed = x);

xf.reg('watch:elapsed', models.session.elapsed);
xf.reg('watch:lap', models.session.lap);
xf.reg('watch:event', models.session.event);

const watch = new Watch();

export { watch };
