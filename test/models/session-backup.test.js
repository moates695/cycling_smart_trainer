/**
 * @jest-environment jsdom
 *
 * What a reload has to come back to. Restore is only as good as the last
 * backup, so these cover the writing side: how often a running ride is written,
 * and that a ride which is not running still gets written when it stops
 * ticking.
 */

import indexedDB from 'fake-indexeddb';

window.indexedDB = indexedDB;

import { models } from '../../src/models/models.js';
import { idb } from '../../src/storage/idb.js';

const STORE = 'session';

function ridingDb(overrides = {}) {
    return {
        watchStatus:   'started',
        workoutStatus: 'started',
        elapsed:       0,
        records:       [],
        lap:           [],
        rrInterval:    [],
        sources:       {virtualState: 'speed'},
        speed:         30,
        speedVirtual:  30,
        power1s:       200,
        cadence:       90,
        heartRate:     150,
        ...overrides,
    };
}

// One second of riding, the way watch.js drives it.
function tick(db) {
    models.session.elapsed(db.elapsed + 1, db);
}

async function stored() {
    return await idb.get(STORE, 0);
}

beforeAll(async () => {
    await idb.start('store', 3, [STORE, 'workouts', 'activity']);
});

beforeEach(async () => {
    await idb.clear(STORE);
});

describe('session backup', () => {
    // The bug this guards: backups ran once a minute, so a refresh in the first
    // minute of a ride found nothing to restore and lost the ride outright.
    test('a ride is on disk within the first few seconds', async () => {
        const db = ridingDb();

        for(let i = 0; i < 10; i++) tick(db);

        const session = await stored();
        expect(session.elapsed).toBe(10);
        expect(session.records.length).toBe(10);
    });

    test('a running ride is backed up every 10 s', async () => {
        const db = ridingDb();

        for(let i = 0; i < 25; i++) tick(db);

        // 25 s in, the last boundary crossed was 20 s.
        expect((await stored()).elapsed).toBe(20);

        for(let i = 0; i < 5; i++) tick(db);

        expect((await stored()).elapsed).toBe(30);
    });

    // A paused ride has no clock, so nothing else would write it.
    test('a pause is written straight away', async () => {
        const db = ridingDb();

        for(let i = 0; i < 15; i++) tick(db);
        db.watchStatus = 'paused';
        models.session.backup(db);

        const session = await stored();
        expect(session.elapsed).toBe(15);
        expect(session.watchStatus).toBe('paused');
    });

    // The ride is saved as an activity, so the session copy has done its job.
    // Left behind, it comes back on the next reload as a ride to carry on with.
    test('a finished and saved ride is taken off disk', async () => {
        const db = ridingDb();

        for(let i = 0; i < 10; i++) tick(db);
        expect(await stored()).toBeDefined();

        models.session.reset(db);

        expect(await idb.getAll(STORE)).toEqual([]);
    });

    // backup() is also called from the page lifecycle, which fires whenever the
    // tab is switched away from — riding or not.
    test('nothing on the clock is not written', async () => {
        models.session.backup(ridingDb({watchStatus: 'stopped', elapsed: 0}));

        expect(await idb.getAll(STORE)).toEqual([]);
    });
});
