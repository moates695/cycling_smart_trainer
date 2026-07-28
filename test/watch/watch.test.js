/**
 * @jest-environment jsdom
 */

//
// The watch state machine end to end: play arms it, the first turn of the
// pedals starts the ride, and the clock stops and picks itself up again as the
// rider does. watch-timing.test.js covers the rules; this covers the wiring
// around them — the arm clock, the timer worker and the events views listen to.
//
// The timer worker is mocked (it is a real Worker in the browser) and ticks are
// driven by hand.
//

jest.mock('../../src/timer-worker.js', () => {
    const listeners = [];
    return {
        timer: {
            messages: [],
            running:  false,
            postMessage(message) {
                this.messages.push(message);
                if(message === 'start') this.running = true;
                if(message === 'stop' || message === 'pause') this.running = false;
            },
            addEventListener(type, handler) { listeners.push(handler); },
            tick() { listeners.forEach((handler) => handler({data: 'tick'})); },
            reset() { this.messages = []; this.running = false; },
        },
    };
});

import { xf } from '../../src/functions.js';
import { timer } from '../../src/timer-worker.js';

const workout = {
    meta: {name: 'Test', duration: 300, category: 'Endurance'},
    intervals: [
        {duration: 120, steps: [{duration: 120, power: 0.5}]},
        {duration: 180, steps: [{duration: 180, power: 0.8}]},
    ],
};

// A minimal store, so the reducers watch.js registers have something to write
// to and the views' db:* events actually fire. db.js is not imported: it pulls
// in storage and the whole model layer, and the watch only ever reads these.
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
    power1s:          0,
    lapStartTime:     false,
    records:          [],
    lap:              [],
    laps:             [],
    events:           [],
    rrInterval:       [],
    sources:          {power: 'ble:controllable', virtualState: 'power'},
};

// create() proxies the object in place, so `db` reads back what the reducers wrote.
xf.create(db);

// The proxy itself, which is what reducers are handed and what
// models.session.restore() writes a restored session through. Writing to the
// bare `db` above would skip the set trap and fire no db:* events.
let store;
xf.reg('test:store', (_, database) => { store = database; });
xf.dispatch('test:store');

require('../../src/watch.js');

// The sim (and the BLE layer) push a 1 s power average into the store; this is
// the same event, with the store-shaped payload a db: subscriber reads.
function power(watts) {
    xf.dispatch('db:power1s', {power1s: watts});
}

// One second of the arm clock / auto pause clock.
function second(watts) {
    if(watts !== undefined) power(watts);
    jest.advanceTimersByTime(1000);
}

function play() {
    // What the play button dispatches, both events, as views/watch.js does.
    xf.dispatch('ui:watchStart');
    xf.dispatch('ui:workoutStart');
}

// Back to a cold page: these go through the reducers watch.js registers, so the
// store really is written and the db:* events really do fire.
function reset() {
    xf.dispatch('ui:watchStop', {confirmed: true});
    xf.dispatch('watch:stopped');
    xf.dispatch('workout:stopped');
    xf.dispatch('watch:armed', false);
    xf.dispatch('watch:elapsed', 0);
    xf.dispatch('db:workout', {workout});
    settings({autoStart: false, autoPause: true});
    timer.reset();
}

// Auto start is off for most of these so that what play does is unambiguous;
// it has its own describe below.
function settings(sources) {
    xf.dispatch('db:sources', {sources});
}

beforeAll(() => {
    jest.useFakeTimers();
    // No confirm() in jsdom by default, and stop() asks for one.
    window.confirm = () => true;
});

afterAll(() => {
    jest.useRealTimers();
});

beforeEach(() => {
    reset();
});

describe('play', () => {
    test('arms the watch instead of starting the clock', () => {
        play();

        expect(db.watchArmed).toBe(true);
        expect(db.watchStatus).toBe('stopped');
        expect(timer.running).toBe(false);
    });

    test('the first turn of the pedals starts the ride', () => {
        play();

        // Coasting: the sim's badge says COASTING and nothing happens.
        second(0);
        second(0);
        expect(db.watchStatus).toBe('stopped');

        // Riding.
        second(220);

        expect(db.watchArmed).toBe(false);
        expect(db.watchStatus).toBe('started');
        expect(db.workoutStatus).toBe('started');
        expect(timer.running).toBe(true);
    });

    test('starts on the pedals even while power reads zero the whole wait', () => {
        // The trainer stops notifying when nobody is pedalling, so db:power1s
        // stops arriving too — the wait has to run on its own clock or it would
        // never time out, and never see the rider turn up.
        play();

        power(0);
        jest.advanceTimersByTime(5000);   // five silent seconds
        expect(db.watchArmed).toBe(true);

        second(180);
        expect(db.watchStatus).toBe('started');
    });

    test('gives up after 15s and leaves the watch where it was', () => {
        play();

        for(let i = 0; i < 14; i += 1) second(0);
        expect(db.watchArmed).toBe(true);

        second(0);

        expect(db.watchArmed).toBe(false);
        expect(db.watchStatus).toBe('stopped');
        expect(db.workoutStatus).toBe('stopped');
        expect(timer.running).toBe(false);
    });

    test('pedalling after the wait has closed does nothing', () => {
        play();
        for(let i = 0; i < 15; i += 1) second(0);

        second(250);

        expect(db.watchStatus).toBe('stopped');
    });

    test('pause cancels the wait', () => {
        play();
        second(0);

        xf.dispatch('ui:watchPause');

        expect(db.watchArmed).toBe(false);

        // and the arm clock is gone with it: pedalling no longer starts anything
        second(250);
        expect(db.watchStatus).toBe('stopped');
    });
});

describe('auto start', () => {
    beforeEach(() => {
        settings({autoStart: true, autoPause: true});
    });

    test('pedalling begins the ride without touching play', () => {
        second(230);
        second(230);
        expect(db.watchStatus).toBe('stopped');

        second(230);

        expect(db.watchStatus).toBe('started');
        expect(db.workoutStatus).toBe('started');
        expect(timer.running).toBe(true);
    });

    test('nothing starts on its own when the setting is off', () => {
        settings({autoStart: false});

        for(let i = 0; i < 10; i += 1) second(230);

        expect(db.watchStatus).toBe('stopped');
    });

    test('stopping mid-pedal does not immediately start again', () => {
        for(let i = 0; i < 3; i += 1) second(230);
        expect(db.watchStatus).toBe('started');

        // Still pedalling as the rider reaches for stop.
        xf.dispatch('ui:watchStop', {confirmed: true});
        expect(db.watchStatus).toBe('stopped');

        second(230);
        expect(db.watchStatus).toBe('stopped');
    });
});

describe('riding', () => {
    beforeEach(() => {
        settings({autoStart: true, autoPause: true});
    });

    // Get to a running ride the way a rider does.
    function start() {
        play();
        second(220);
        expect(db.watchStatus).toBe('started');
    }

    test('auto pause stops the clock once the pedals do', () => {
        start();

        second(0);
        second(0);
        second(0);
        expect(db.watchStatus).toBe('started');

        second(0);

        expect(db.watchStatus).toBe('paused');
        expect(timer.running).toBe(false);
    });

    test('auto start picks a paused ride up again on the first stroke', () => {
        start();
        for(let i = 0; i < 4; i += 1) second(0);
        expect(db.watchStatus).toBe('paused');

        second(200);

        expect(db.watchStatus).toBe('started');
        expect(timer.running).toBe(true);
        // the workout was never stopped, only its clock
        expect(db.workoutStatus).toBe('started');
    });

    test('a pause the rider pressed is not undone by pedalling on', () => {
        start();

        xf.dispatch('ui:watchPause');
        expect(db.watchStatus).toBe('paused');

        // Never off the pedals — the trainer is still reporting the stroke the
        // button was pressed on.
        second(240);
        second(240);

        expect(db.watchStatus).toBe('paused');
    });

    test('a pause the rider pressed picks itself up once they stop and ride again', () => {
        start();

        xf.dispatch('ui:watchPause');
        second(0);
        expect(db.watchStatus).toBe('paused');

        // Back on the pedals: the ride carries on once they have held it.
        second(240);
        second(240);
        expect(db.watchStatus).toBe('paused');

        second(240);

        expect(db.watchStatus).toBe('started');
        expect(timer.running).toBe(true);
        expect(db.workoutStatus).toBe('started');
    });

    test('a rider pause stays put with auto start off', () => {
        settings({autoStart: false});
        start();

        xf.dispatch('ui:watchPause');
        for(let i = 0; i < 4; i += 1) second(0);
        for(let i = 0; i < 6; i += 1) second(240);

        expect(db.watchStatus).toBe('paused');
    });

    test('play after a rider pause waits for the pedals again', () => {
        start();
        xf.dispatch('ui:watchPause');

        play();
        expect(db.watchArmed).toBe(true);
        expect(db.watchStatus).toBe('paused');

        second(240);

        expect(db.watchArmed).toBe(false);
        expect(db.watchStatus).toBe('started');
    });

    test('a rider pause after an auto pause is still the rider\'s', () => {
        // The app pausing once must not leave the ride permanently
        // self-resuming: stopping and starting again clears that.
        start();
        for(let i = 0; i < 4; i += 1) second(0);
        expect(db.watchStatus).toBe('paused');

        xf.dispatch('ui:watchStop', {confirmed: true});
        play();
        second(220);
        expect(db.watchStatus).toBe('started');

        xf.dispatch('ui:watchPause');
        second(240);

        expect(db.watchStatus).toBe('paused');
    });

    // A refresh mid-workout brings the session back and parks it paused, with
    // the workout mid-way rather than at its start. The rider never stopped it,
    // so their next turn of the pedals should carry on. Whether the session was
    // saved running or already auto paused is an accident of when the page went
    // away, and must not decide whether they have to press play.
    //
    // What app:start does on a cold page: models.session.restore() assigns the
    // saved session onto the store and db.js then dispatches 'workout:restore'.
    // Key order is dbToSession()'s, since that is the object idb gives back.
    function restoreSession(watchStatus) {
        Object.assign(store, {
            elapsed:          200,
            lapTime:          100,
            stepTime:         100,
            intervalIndex:    1,
            stepIndex:        0,
            intervalDuration: 180,
            stepDuration:     180,
            lapStartTime:     Date.now(),
            watchStatus,
            workoutStatus:    'started',
            workout,
        });

        xf.dispatch('workout:restore');
    }

    test('a ride restored still running picks itself up on the pedals', () => {
        restoreSession('started');
        expect(db.watchStatus).toBe('paused');

        second(230);

        expect(db.watchStatus).toBe('started');
        expect(db.workoutStatus).toBe('started');
        expect(db.intervalIndex).toBe(1);
    });

    test('a ride restored already auto paused picks itself up too', () => {
        restoreSession('paused');
        expect(db.watchStatus).toBe('paused');

        second(230);

        expect(db.watchStatus).toBe('started');
        expect(db.workoutStatus).toBe('started');
        expect(db.intervalIndex).toBe(1);
    });

    test('the clock counts the workout down', () => {
        start();

        timer.tick();
        timer.tick();

        expect(db.elapsed).toBe(2);
        expect(db.stepTime).toBe(118);
        expect(db.lapTime).toBe(118);
    });
});
