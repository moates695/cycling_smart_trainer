//
// The rules behind play / auto pause / auto resume. watch.js itself constructs
// a Worker at import time and can't be loaded here, which is why these live in
// a pure module (see src/watch-timing.js).
//

import {
    ARM_WINDOW_S, AUTO_PAUSE_S, AUTO_START_S, PEDALLING_WATTS,
    TimingAction, timingDefaults, onPowerSample,
} from '../../src/watch-timing.js';

const COASTING = 0;
const RIDING   = PEDALLING_WATTS + 10;
// A trainer's freewheel trickle: above zero, but nobody is pedalling.
const DRIFTING = PEDALLING_WATTS - 10;

// Feed a run of 1 s samples and collect what the watch would have been told to
// do, so a whole scenario reads as one call.
function ride(samples, {state = timingDefaults(), status = 'stopped', settings = {}} = {}) {
    const actions = [];
    let current = state;
    samples.forEach((power) => {
        const result = onPowerSample({power, status, state: current, settings});
        current = result.state;
        actions.push(result.action);
    });
    return {state: current, actions};
}

function armed(overrides = {}) {
    return {...timingDefaults(), armed: true, ...overrides};
}

// The timing state a running ride leaves behind. Pause and stop are both
// pressed mid-stroke with the pedals still turning, and the 'started' branch
// clears the rest flag on every sample, so this — not the defaults — is what
// either of them is actually entered with.
function running(overrides = {}) {
    return {...timingDefaults(), coastedSinceRunning: false, ...overrides};
}

describe('waiting for the pedals after play', () => {
    test('nothing starts while the rider is still still', () => {
        const {state, actions} = ride(Array(5).fill(COASTING), {state: armed()});

        expect(actions).toEqual(Array(5).fill(TimingAction.none));
        expect(state.armed).toBe(true);
        expect(state.armCounter).toBe(5);
    });

    test('the first turn of the pedals launches the ride', () => {
        const {state, actions} = ride([COASTING, COASTING, RIDING], {state: armed()});

        expect(actions).toEqual([
            TimingAction.none, TimingAction.none, TimingAction.launch,
        ]);
        expect(state.armed).toBe(false);
        expect(state.armCounter).toBe(0);
    });

    test('a freewheeling trickle is not pedalling', () => {
        const {actions} = ride([DRIFTING, DRIFTING], {state: armed()});
        expect(actions).toEqual([TimingAction.none, TimingAction.none]);
    });

    test(`the wait gives up after ${ARM_WINDOW_S}s`, () => {
        const {state, actions} = ride(Array(ARM_WINDOW_S).fill(COASTING), {state: armed()});

        expect(actions.slice(0, -1)).toEqual(Array(ARM_WINDOW_S - 1).fill(TimingAction.none));
        expect(actions[actions.length - 1]).toBe(TimingAction.armExpired);
        expect(state.armed).toBe(false);
    });

    test('pedalling on the last second still counts', () => {
        const samples = Array(ARM_WINDOW_S - 1).fill(COASTING).concat(RIDING);
        const {actions} = ride(samples, {state: armed()});
        expect(actions[actions.length - 1]).toBe(TimingAction.launch);
    });

    test('giving up mid-ride leaves a pause the app can undo itself', () => {
        const {state} = ride(Array(ARM_WINDOW_S).fill(COASTING),
                             {state: armed(), status: 'paused'});
        expect(state.pausedAutomatically).toBe(true);
    });

    test('giving up before the ride has begun leaves nothing to resume', () => {
        const {state} = ride(Array(ARM_WINDOW_S).fill(COASTING),
                             {state: armed(), status: 'stopped'});
        expect(state.pausedAutomatically).toBe(false);
    });

    test('auto pause is not applied while waiting, however long the wait', () => {
        const {actions} = ride(Array(ARM_WINDOW_S - 1).fill(COASTING),
                               {state: armed(), settings: {autoPause: true}});
        expect(actions).not.toContain(TimingAction.autoPause);
    });
});

describe('auto start', () => {
    const stopped = {status: 'stopped', settings: {autoStart: true}};

    test(`begins the ride after ${AUTO_START_S}s of pedalling, with no play press`, () => {
        const {actions} = ride(Array(AUTO_START_S).fill(RIDING), stopped);

        expect(actions.slice(0, -1)).toEqual(Array(AUTO_START_S - 1).fill(TimingAction.none));
        expect(actions[actions.length - 1]).toBe(TimingAction.launch);
    });

    test('a nudge of the cranks is not a start', () => {
        // Wheeling the bike into place, or one turn while clipping in.
        const {actions} = ride([RIDING, COASTING, RIDING, COASTING], stopped);
        expect(actions).not.toContain(TimingAction.launch);
    });

    test('a freewheeling trickle is not a start', () => {
        const {actions} = ride(Array(AUTO_START_S * 2).fill(DRIFTING), stopped);
        expect(actions).not.toContain(TimingAction.launch);
    });

    test('nothing happens when the setting is off', () => {
        const {actions} = ride(Array(AUTO_START_S * 3).fill(RIDING),
                               {status: 'stopped', settings: {autoStart: false}});
        expect(actions).not.toContain(TimingAction.launch);
    });

    test('play still starts on the first stroke, without the wait', () => {
        // Pressing play is the rider saying they mean it, so the confirmation
        // auto start needs isn't wanted on top of it.
        const {actions} = ride([RIDING], {state: armed(), settings: {autoStart: true}});
        expect(actions).toEqual([TimingAction.launch]);
    });

    test('does not restart a ride the rider paused', () => {
        const {actions} = ride(Array(AUTO_START_S * 2).fill(RIDING), {
            status: 'paused', settings: {autoStart: true},
        });
        expect(actions).not.toContain(TimingAction.launch);
    });
});

describe('auto start, after a stop', () => {
    const stopped = {status: 'stopped', settings: {autoStart: true}};

    test('the watts spinning down off the press do not start a new ride', () => {
        // The rider stopped and got off; the flywheel is still turning.
        const {actions} = ride(Array(AUTO_START_S * 2).fill(RIDING),
                               {...stopped, state: running()});
        expect(actions).not.toContain(TimingAction.launch);
    });

    test('getting going again after a halt does start one', () => {
        const samples = [COASTING].concat(Array(AUTO_START_S).fill(RIDING));
        const {actions} = ride(samples, {...stopped, state: running()});
        expect(actions[actions.length - 1]).toBe(TimingAction.launch);
    });

    test('a freewheel drifting below the floor counts as the halt', () => {
        const samples = [DRIFTING].concat(Array(AUTO_START_S).fill(RIDING));
        const {actions} = ride(samples, {...stopped, state: running()});
        expect(actions[actions.length - 1]).toBe(TimingAction.launch);
    });

    test('a standing start is not asked to coast first', () => {
        // Nothing has run yet, so the rider is already at rest and the defaults
        // must not make them stop before they can start.
        const {actions} = ride(Array(AUTO_START_S).fill(RIDING), stopped);
        expect(actions[actions.length - 1]).toBe(TimingAction.launch);
    });
});

describe('auto pause', () => {
    const started = {status: 'started', settings: {autoPause: true}};

    test(`pauses after ${AUTO_PAUSE_S}s of stopped pedals`, () => {
        const {state, actions} = ride(Array(AUTO_PAUSE_S).fill(COASTING), started);

        expect(actions[actions.length - 1]).toBe(TimingAction.autoPause);
        expect(state.pausedAutomatically).toBe(true);
    });

    test('a freewheeling trickle still counts as stopped', () => {
        // Waiting for a clean zero would leave the clock running long after
        // the rider stopped — a trainer coasts down slowly.
        const {actions} = ride(Array(AUTO_PAUSE_S).fill(DRIFTING), started);
        expect(actions[actions.length - 1]).toBe(TimingAction.autoPause);
    });

    test('a single turn of the pedals resets the count', () => {
        const {actions} = ride([COASTING, COASTING, COASTING, RIDING, COASTING], started);
        expect(actions).not.toContain(TimingAction.autoPause);
    });

    test('does nothing at all when the setting is off', () => {
        const {state, actions} = ride(Array(AUTO_PAUSE_S * 2).fill(COASTING),
                                      {status: 'started', settings: {autoPause: false}});

        expect(actions).not.toContain(TimingAction.autoPause);
        expect(state.pausedAutomatically).toBe(false);
    });
});

// Resuming after an auto pause is the same gesture as starting, so it is the
// same setting — auto start covers both.
describe('auto start, after an auto pause', () => {
    const autoPaused = {...timingDefaults(), pausedAutomatically: true};

    test('picks an auto-paused ride back up on the first pedal stroke', () => {
        const {actions} = ride([COASTING, RIDING], {
            state: autoPaused, status: 'paused', settings: {autoStart: true},
        });
        expect(actions).toEqual([TimingAction.none, TimingAction.autoResume]);
    });

    test(`does not make the rider pedal for ${AUTO_START_S}s first`, () => {
        // Unlike a standing start: the ride is already under way.
        const {actions} = ride([RIDING], {
            state: autoPaused, status: 'paused', settings: {autoStart: true},
        });
        expect(actions).toEqual([TimingAction.autoResume]);
    });

    test('stays paused when the setting is off', () => {
        const {actions} = ride([RIDING, RIDING], {
            state: autoPaused, status: 'paused', settings: {autoStart: false},
        });
        expect(actions).toEqual([TimingAction.none, TimingAction.none]);
    });

    test('leaves a pause the rider pressed on the first stroke alone', () => {
        // They pressed pause mid-stroke and never stopped: nothing to pick up.
        const {actions} = ride([RIDING, RIDING], {
            state: timingDefaults(), status: 'paused', settings: {autoStart: true},
        });
        expect(actions).toEqual([TimingAction.none, TimingAction.none]);
    });

    test('is independent of auto pause', () => {
        // Auto pause off, auto start on: the app never pauses on its own, so
        // there is nothing to pick back up.
        const running = ride(Array(AUTO_PAUSE_S * 2).fill(COASTING),
                             {status: 'started', settings: {autoPause: false, autoStart: true}});
        expect(running.actions).not.toContain(TimingAction.autoPause);

        // Auto pause on, auto start off: it pauses and stays paused.
        const settings = {autoPause: true, autoStart: false};
        const paused = ride(Array(AUTO_PAUSE_S).fill(COASTING), {status: 'started', settings});
        expect(paused.actions).toContain(TimingAction.autoPause);

        const after = ride([RIDING], {state: paused.state, status: 'paused', settings});
        expect(after.actions).toEqual([TimingAction.none]);
    });
});

// A pause the rider pressed is theirs, but not forever: once they have come to
// a stop, getting back on the pedals is how they carry on — the same gesture
// that starts a ride from a standstill, and the same confirmation.
describe('auto start, after a pause the rider pressed', () => {
    const riderPaused = {status: 'paused', settings: {autoStart: true}, state: running()};

    test(`coasting, then ${AUTO_START_S}s of pedalling, resumes the ride`, () => {
        const {actions} = ride(
            [COASTING].concat(Array(AUTO_START_S).fill(RIDING)), riderPaused);

        expect(actions.slice(0, -1)).toEqual(Array(AUTO_START_S).fill(TimingAction.none));
        expect(actions[actions.length - 1]).toBe(TimingAction.autoResume);
    });

    test('pedalling on without ever stopping does not undo the press', () => {
        // The trainer is still reporting the stroke they pressed pause on.
        const {actions} = ride(Array(AUTO_START_S * 3).fill(RIDING), riderPaused);
        expect(actions).not.toContain(TimingAction.autoResume);
    });

    test('a freewheeling trickle counts as coasting, and is not pedalling', () => {
        const {actions} = ride(
            [DRIFTING].concat(Array(AUTO_START_S).fill(DRIFTING)), riderPaused);
        expect(actions).not.toContain(TimingAction.autoResume);

        const {actions: after} = ride(
            [DRIFTING].concat(Array(AUTO_START_S).fill(RIDING)), riderPaused);
        expect(after[after.length - 1]).toBe(TimingAction.autoResume);
    });

    test('a nudge of the cranks while stopped is not a resume', () => {
        // Getting off the bike, moving it, climbing back on.
        const {actions} = ride([COASTING, RIDING, COASTING, RIDING, COASTING], riderPaused);
        expect(actions).not.toContain(TimingAction.autoResume);
    });

    test(`the ${AUTO_START_S}s have to be consecutive`, () => {
        const samples = [COASTING].concat(
            Array(AUTO_START_S - 1).fill(RIDING), COASTING, RIDING, RIDING);
        const {actions} = ride(samples, riderPaused);
        expect(actions).not.toContain(TimingAction.autoResume);
    });

    test('stays paused when the setting is off', () => {
        const {actions} = ride([COASTING].concat(Array(AUTO_START_S * 2).fill(RIDING)),
                               {status: 'paused', settings: {autoStart: false}});
        expect(actions).not.toContain(TimingAction.autoResume);
    });

    test('having stopped once is remembered across the whole pause', () => {
        // They stopped, sat there a while, then got going.
        let {state} = ride(Array(30).fill(COASTING), riderPaused);
        expect(state.coastedSinceRunning).toBe(true);

        const {actions} = ride(Array(AUTO_START_S).fill(RIDING), {...riderPaused, state});
        expect(actions[actions.length - 1]).toBe(TimingAction.autoResume);
    });

    test('an auto pause still needs no confirmation', () => {
        // The rules for the two pauses stay apart.
        const autoPaused = {...timingDefaults(), pausedAutomatically: true};
        const {actions} = ride([COASTING, RIDING], {...riderPaused, state: autoPaused});
        expect(actions).toEqual([TimingAction.none, TimingAction.autoResume]);
    });
});

describe('a full session', () => {
    const settings = {autoStart: true, autoPause: true};

    test('play, wait, ride, coast to an auto pause, then pick it up again', () => {
        // Play pressed — the ride has not begun.
        let state = armed();
        let status = 'stopped';

        // Clipping in.
        ({state} = ride(Array(3).fill(COASTING), {state, status, settings}));
        expect(state.armed).toBe(true);

        // Away.
        let result = ride([RIDING], {state, status, settings});
        expect(result.actions).toEqual([TimingAction.launch]);
        state = result.state;
        status = 'started';

        // Stops pedalling at the end of the interval.
        result = ride(Array(AUTO_PAUSE_S).fill(COASTING), {state, status, settings});
        expect(result.actions[result.actions.length - 1]).toBe(TimingAction.autoPause);
        state = result.state;
        status = 'paused';

        // Back on the pedals.
        result = ride([RIDING], {state, status, settings});
        expect(result.actions).toEqual([TimingAction.autoResume]);
    });
});
