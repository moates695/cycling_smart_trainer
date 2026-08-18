/**
 * @jest-environment jsdom
 *
 * What comes back after a reload. The session record is the whole watch state,
 * so restoring the wrong one does not just lose a ride — it puts the app into a
 * state the rider has no obvious way out of.
 */

import indexedDB from 'fake-indexeddb';

window.indexedDB = indexedDB;

import { models } from '../../src/models/models.js';
import { idb } from '../../src/storage/idb.js';

const STORE = 'session';

// Only the fields these rules read. sessionToDb assigns the record wholesale,
// so a marker field is enough to tell a restore from a clear.
function record(overrides = {}) {
    return idb.setId({
        elapsed:       600,
        lapTime:       120,
        intervalIndex: 3,
        watchStatus:   'started',
        workoutStatus: 'started',
        restored:      true,
        ...overrides,
    }, 0);
}

function freshDb() {
    return {elapsed: 0, lapTime: 0, intervalIndex: 0,
            watchStatus: 'stopped', workoutStatus: 'stopped'};
}

beforeAll(async () => {
    await idb.start('store', 3, [STORE, 'workouts', 'activity']);
});

beforeEach(async () => {
    await idb.clear(STORE);
});

describe('session restore', () => {
    test('a ride still under way comes back', async () => {
        await idb.put(STORE, record());

        const db = freshDb();
        await models.session.restore(db);

        expect(db.restored).toBe(true);
        expect(db.elapsed).toBe(600);
        expect(db.workoutStatus).toBe('started');
    });

    test('a session with nothing on the clock is dropped', async () => {
        await idb.put(STORE, record({elapsed: 0}));

        const db = freshDb();
        await models.session.restore(db);

        expect(db.restored).toBe(undefined);
        expect(await idb.getAll(STORE)).toEqual([]);
    });

    // A workout that ran to the end but was never stopped was never saved
    // either, and those recorded seconds are the whole ride. They come back so
    // the rider can still save them.
    test('a workout that ran to the end keeps its ride', async () => {
        await idb.put(STORE, record({workoutStatus: 'done', intervalIndex: 44}));

        const db = freshDb();
        await models.session.restore(db);

        expect(db.restored).toBe(true);
        expect(db.elapsed).toBe(600);
        expect(await idb.getAll(STORE)).not.toEqual([]);
    });

    // The bug this guards: restored as `workoutStatus: 'done'` the watch reads
    // the session as a free ride — the interval clock counts up instead of
    // down, and beginWorkout() will not open the workout again while the
    // finished interval index is still on it. Every reload landed there until
    // the ride was stopped by hand.
    test('a workout that ran to the end comes back paused, not finished', async () => {
        await idb.put(STORE, record({workoutStatus: 'done', intervalIndex: 44}));

        const db = freshDb();
        await models.session.restore(db);

        expect(db.workoutStatus).toBe('stopped');
        expect(db.watchStatus).toBe('paused');
        expect(db.intervalIndex).toBe(0);
        expect(db.stepIndex).toBe(0);
    });

    // Saving is the rider's call, so the app has to ask — and the ride has to
    // still be there when they answer.
    test('a ride that was never saved announces itself', async () => {
        await idb.put(STORE, record({workoutStatus: 'done', elapsed: 1830}));

        const heard = [];
        const onUnsaved = (e) => heard.push(e.detail.data);
        window.addEventListener('session:unsaved', onUnsaved);

        await models.session.restore(freshDb());
        window.removeEventListener('session:unsaved', onUnsaved);

        expect(heard.length).toBe(1);
        expect(heard[0].elapsed).toBe(1830);
    });

    test('a ride still under way asks nothing', async () => {
        await idb.put(STORE, record());

        const heard = [];
        const onUnsaved = (e) => heard.push(e.detail.data);
        window.addEventListener('session:unsaved', onUnsaved);

        await models.session.restore(freshDb());
        window.removeEventListener('session:unsaved', onUnsaved);

        expect(heard).toEqual([]);
    });
});
