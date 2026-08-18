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

    // The bug this guards: a finished workout restores as `workoutStatus:
    // 'done'`, which the watch reads as a free ride — the interval clock counts
    // up instead of down, and startWorkout() will not open the workout again
    // while the finished interval index is still on it. Every reload landed
    // there until the ride was stopped by hand.
    test('a workout that ran to the end is dropped, not resumed', async () => {
        await idb.put(STORE, record({workoutStatus: 'done', intervalIndex: 44}));

        const db = freshDb();
        await models.session.restore(db);

        expect(db.restored).toBe(undefined);
        expect(db.workoutStatus).toBe('stopped');
        expect(db.intervalIndex).toBe(0);
        expect(await idb.getAll(STORE)).toEqual([]);
    });
});
