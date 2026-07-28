/**
 * @jest-environment jsdom
 */

//
// The whole pedal-to-start path with the device sim driving it, wired the way
// index.js wires the app: sim -> `power` -> db.power -> the 1 s averager in
// models.js -> db.power1s -> the watch. watch.test.js feeds the watch power
// directly; this covers everything between the simulated trainer and it.
//

jest.mock('../../src/timer-worker.js', () => ({
    timer: {
        messages: [],
        running:  false,
        postMessage(message) {
            this.messages.push(message);
            if(message === 'start') this.running = true;
            if(message === 'stop' || message === 'pause') this.running = false;
        },
        addEventListener() {},
        reset() { this.messages = []; this.running = false; },
    },
}));

import { xf } from '../../src/functions.js';
import { timer } from '../../src/timer-worker.js';

// The 1 s power averager in models.js starts its interval at import time, so
// the clock has to be faked before anything is loaded.
jest.useFakeTimers();

const workout = {
    meta: {name: 'Test', duration: 300, category: 'Endurance'},
    intervals: [
        {duration: 120, steps: [{duration: 120, power: 0.5}]},
        {duration: 180, steps: [{duration: 180, power: 0.8}]},
    ],
};

const db = {
    watchStatus:      'stopped',
    workoutStatus:    'stopped',
    watchArmed:       false,
    workout,
    elapsed:          0,
    lapTime:          0,
    stepTime:         0,
    intervalDuration: 0,
    stepDuration:     0,
    intervalIndex:    0,
    stepIndex:        0,
    lock:             false,
    ftp:              250,
    workoutIntensity: 100,
    mode:             'erg',
    power:            0,
    power1s:          0,
    powerTarget:      0,
    slopeTarget:      0,
    resistanceTarget: 0,
    cadenceTarget:    0,
    cadence:          0,
    heartRate:        0,
    lapStartTime:     false,
    records:          [],
    lap:              [],
    laps:             [],
    events:           [],
    rrInterval:       [],
    sources:          {power: 'ble:controllable', virtualState: 'power'},
};

xf.create(db);

// The two reducers from db.js this path depends on.
xf.reg('power',   (power, database) => { database.power   = power; });
xf.reg('power1s', (power, database) => { database.power1s = power; });

require('../../src/watch.js');
const { Sim } = require('../../src/sim.js');

const sim = Sim({devices: ['controllable']});

function seconds(n) {
    jest.advanceTimersByTime(n * 1000);
}

function play() {
    xf.dispatch('ui:watchStart');
    xf.dispatch('ui:workoutStart');
}

beforeAll(() => {
    sim.init();
    seconds(1);            // fake pairing
    sim.coast();           // the badge says COASTING
    seconds(3);
    // Auto start off to begin with, so play is the only thing that can start
    // the ride; it gets its own test at the end.
    xf.dispatch('db:sources', {sources: {autoStart: false, autoPause: true}});
});

afterAll(() => {
    jest.useRealTimers();
});

test('the trainer is connected and reporting nothing', () => {
    expect(sim.state().connected.controllable).toBe(true);
    expect(db.power).toBe(0);
    expect(db.power1s).toBe(0);
    expect(db.watchStatus).toBe('stopped');
});

test('play arms the watch, and coasting keeps it waiting', () => {
    play();
    // play doesn't touch the simulated rider — they were coasting and stay there
    sim.coast();

    seconds(5);

    expect(db.watchArmed).toBe(true);
    expect(db.watchStatus).toBe('stopped');
});

test('pedalling starts the workout', () => {
    sim.ride();

    seconds(4);

    expect(db.power1s).toBeGreaterThan(40);
    expect(db.watchArmed).toBe(false);
    expect(db.watchStatus).toBe('started');
    expect(db.workoutStatus).toBe('started');
    expect(timer.running).toBe(true);
});

test('coasting auto pauses, and pedalling again picks it up', () => {
    // Picking a paused ride back up is auto start's other half.
    xf.dispatch('db:sources', {sources: {autoStart: true}});

    sim.coast();
    // The sim's power decays rather than dropping to a clean zero — under the
    // 40W floor after ~3s, then AUTO_PAUSE_S of it.
    seconds(8);

    expect(db.watchStatus).toBe('paused');

    sim.ride();
    seconds(5);

    expect(db.watchStatus).toBe('started');
    expect(db.workoutStatus).toBe('started');
});

test('with auto start on, the badge alone starts the workout', () => {
    // COASTING -> RIDING with nothing else touched: no play press, no keyboard.
    xf.dispatch('ui:watchStop', {confirmed: true});
    xf.dispatch('db:sources', {sources: {autoStart: true}});
    sim.coast();
    seconds(10);
    expect(db.watchStatus).toBe('stopped');

    sim.ride();
    seconds(6);

    expect(db.watchStatus).toBe('started');
    expect(db.workoutStatus).toBe('started');
});
