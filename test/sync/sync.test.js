/**
 * @jest-environment jsdom
 *
 * The sync orchestrator against a real IndexedDB (fake-indexeddb) and a stub
 * server that reproduces the API's merge rules. sync-model.test.js covers the
 * pure decisions; this covers the thing that actually moves data — the drain
 * loop, the cursor, tombstone sweeping, and the promise that a FIT blob this
 * device holds is never thrown away.
 */

import indexedDB from 'fake-indexeddb';

window.indexedDB = indexedDB;

// -- a stand-in for the WATTS API ----------------------------------------
//
// Defined inside the jest.mock factory: the factory is hoisted above every
// import, so anything it closes over has to be created in there. The stub is
// handed back as `__server` so the tests can drive it.

jest.mock('../../src/sync/sync-api.js', () => {
    class ApiError extends Error {
        constructor(message, status) {
            super(message);
            this.status = status;
        }
    }

    const server = {
        workouts: new Map(),
        activities: new Map(),
        settings: undefined,
        seq: 0,
        user: {id: 'user-1', email: 'rider@example.com'},
        signedIn: true,
        failNext: undefined,
        pendingFit: [],
        uploaded: [],
        resetRequests: [],

        reset() {
            this.workouts = new Map();
            this.activities = new Map();
            this.settings = undefined;
            this.seq = 0;
            this.signedIn = true;
            this.failNext = undefined;
            this.pendingFit = [];
            this.uploaded = [];
            this.resetRequests = [];
        },

        // One row, last-write-wins, no tombstone: a profile is replaced, never
        // deleted.
        applySettings(incoming) {
            const at = (value) => Date.parse(value ?? 0);
            const stored = this.settings;

            if(stored && at(incoming.client_updated_at) <= at(stored.client_updated_at)) {
                return stored;
            }

            this.seq += 1;
            this.settings = {
                settings: Object.assign({}, stored?.settings, incoming.settings),
                client_updated_at: incoming.client_updated_at,
                updated_at: new Date().toISOString(),
                seq: this.seq,
            };
            return this.settings;
        },

        // Last-write-wins on the client clock; a tombstone always wins.
        apply(store, incoming) {
            const stored = store.get(incoming.id);
            const at = (value) => Date.parse(value ?? 0);

            if(stored && stored.deleted_at && !incoming.deleted) return stored;
            if(stored && !incoming.deleted &&
               at(incoming.client_updated_at) <= at(stored.client_updated_at)) {
                return stored;
            }

            this.seq += 1;
            const row = Object.assign({}, stored, incoming, {
                seq: this.seq,
                deleted_at: incoming.deleted ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
            });
            delete row.deleted;
            store.set(row.id, row);
            return row;
        },
    };

    function guard() {
        if(!server.signedIn) throw new ApiError('Not signed in.', 401);
        if(server.failNext !== undefined) {
            const status = server.failNext;
            server.failNext = undefined;
            throw new ApiError('boom', status);
        }
    }

    return {
        ApiError,
        __server: server,
        api: {
            auth: {
                me: async () => { guard(); return server.user; },
                login: async () => { server.signedIn = true; return server.user; },
                register: async () => { server.signedIn = true; return server.user; },
                logout: async () => { server.signedIn = false; },
                // 204 whether or not the address has an account, so the stub
                // records the ask and answers nothing.
                requestPasswordReset: async (email) => { server.resetRequests.push(email); },
                confirmPasswordReset: async () => { server.signedIn = true; return server.user; },
            },
            sync: {
                pull: async (since = 0) => {
                    guard();
                    const after = (m) => Array.from(m.values()).filter((r) => r.seq > since);
                    const workouts = after(server.workouts);
                    const activities = after(server.activities);
                    const settings = server.settings?.seq > since ? server.settings : undefined;
                    const seqs = workouts.concat(activities).map((r) => r.seq)
                          .concat(settings ? [settings.seq] : []);
                    return {
                        cursor: seqs.length ? Math.max(...seqs) : since,
                        workouts,
                        activities,
                        settings,
                        has_more: false,
                    };
                },
                push: async (workouts = [], activities = [], settings = undefined) => {
                    guard();
                    const w = workouts.map((r) => server.apply(server.workouts, r));
                    const a = activities.map((r) => server.apply(server.activities, r));
                    const s = settings ? server.applySettings(settings) : undefined;
                    const seqs = w.concat(a).map((r) => r.seq).concat(s ? [s.seq] : []);
                    return {
                        cursor: seqs.length ? Math.max(...seqs) : 0,
                        workouts: w,
                        activities: a,
                        settings: s,
                        has_more: false,
                    };
                },
            },
            fit: {
                pending: async () => { guard(); return server.pendingFit; },
                presign: async (id) => ({url: `https://spaces.test/${id}`, key: id, expires_in: 900}),
                put: async (url) => { server.uploaded.push(url); },
                complete: async (id) => {
                    server.pendingFit = server.pendingFit.filter((r) => r.id !== id);
                },
                downloadUrl: (id) => `/api/activities/${id}/fit`,
            },
        },
    };
});

import { __server as server } from '../../src/sync/sync-api.js';
import { idb } from '../../src/storage/idb.js';
import { Sync } from '../../src/sync/sync.js';
import { SyncState } from '../../src/sync/sync-model.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function clearStores() {
    await idb.clear('workouts');
    await idb.clear('activity');
}

function workout(id, name = 'Threshold', at = '2026-01-01T00:00:00.000Z') {
    return {id, name, intervals: [{duration: 600}], updated_at: at, dirty: true};
}

function activity(id, at = '2026-01-01T00:00:00.000Z', blob = undefined) {
    return {
        id,
        blob,
        summary: {id, name: 'Ride', timestamp: Date.parse(at), duration: 3600, avgPower: 200},
        updated_at: at,
        dirty: true,
    };
}

describe('sync orchestrator', () => {
    let sync;

    beforeAll(async () => {
        await idb.start('sync-test', 1, ['workouts', 'activity']);
    });

    beforeEach(async () => {
        server.reset();
        window.localStorage.clear();
        await clearStores();
        sync = Sync();
        await sync.login('rider@example.com', 'correct-horse-battery');
    });

    test('signing in pushes the whole local library', async () => {
        // Set up before signing in, the way an existing user's browser looks.
        server.reset();
        await clearStores();
        await idb.put('workouts', workout('w1'));
        await idb.put('workouts', workout('w2', 'Sweet spot'));
        await idb.put('activity', activity('a1'));

        const fresh = Sync();
        await fresh.login('rider@example.com', 'correct-horse-battery');

        expect(server.workouts.size).toBe(2);
        expect(server.activities.size).toBe(1);
        expect(server.workouts.get('w1').workout.intervals).toEqual([{duration: 600}]);
    });

    test('a reset code can be asked for while signed out', async () => {
        server.reset();
        server.signedIn = false;
        const fresh = Sync();

        await fresh.requestPasswordReset('rider@example.com');

        // Resolving says nothing about whether the account exists; the server
        // answers the same either way, and the inbox is what tells the rider.
        expect(server.resetRequests).toEqual(['rider@example.com']);
        expect(fresh.state).toBe(SyncState.signedOut);
    });

    test('completing a reset signs this device in and syncs like a sign in', async () => {
        server.reset();
        await clearStores();
        await idb.put('workouts', workout('w-reset'));
        server.signedIn = false;

        const fresh = Sync();
        const me = await fresh.resetPassword('rider@example.com', '123456', 'a-brand-new-secret');

        expect(me.id).toBe('user-1');
        expect(fresh.user).toEqual(server.user);
        expect(fresh.state).toBe(SyncState.idle);
        expect(server.workouts.has('w-reset')).toBe(true);
    });

    test('a record with no timestamp at all still gets pushed', async () => {
        // Everything created before the sync layer existed looks like this.
        await idb.put('workouts', {id: 'legacy', name: 'Old one', intervals: []});
        await sync.drain();

        expect(server.workouts.has('legacy')).toBe(true);
        expect(server.workouts.get('legacy').client_updated_at).toBeTruthy();
    });

    test('a pushed record is marked clean so it is not sent twice', async () => {
        await idb.put('workouts', workout('w1'));
        await sync.drain();
        const seqAfterFirst = server.seq;

        await sync.drain();
        expect(server.seq).toBe(seqAfterFirst);

        const stored = await idb.get('workouts', 'w1');
        expect(stored.dirty).toBe(false);
    });

    test('the built-in library is never pushed', async () => {
        await idb.put('workouts', Object.assign(workout('builtin'), {isDefault: true}));
        await sync.drain();

        expect(server.workouts.size).toBe(0);
    });

    test('a record created on another device arrives locally', async () => {
        server.apply(server.workouts, {
            id: 'remote-1',
            name: 'From the phone',
            workout: {intervals: [{duration: 300}]},
            zwo: null,
            client_updated_at: '2026-02-01T00:00:00.000Z',
        });

        await sync.drain();

        const stored = await idb.get('workouts', 'remote-1');
        expect(stored.name).toBe('From the phone');
        expect(stored.intervals).toEqual([{duration: 300}]);
        expect(stored.dirty).toBe(false);
    });

    test('deleting a workout tombstones it, propagates, then sweeps the tombstone', async () => {
        const w = workout('w1');
        await idb.put('workouts', w);
        await sync.drain();

        await sync.workoutRemoved(w);
        expect((await idb.get('workouts', 'w1')).deleted_at).toBeTruthy();

        await sync.drain();

        expect(server.workouts.get('w1').deleted_at).toBeTruthy();
        // Once the server has it, the local tombstone has done its job.
        expect(await idb.get('workouts', 'w1')).toBe(undefined);
    });

    test('a delete from another device removes the local copy', async () => {
        await idb.put('workouts', workout('w1'));
        await sync.drain();

        server.apply(server.workouts, {
            id: 'w1',
            client_updated_at: '2026-03-01T00:00:00.000Z',
            deleted: true,
        });
        await sync.drain();

        expect(await idb.get('workouts', 'w1')).toBe(undefined);
    });

    test('a deleted workout is not resurrected by a second device pushing an older copy', async () => {
        const w = workout('w1', 'Threshold', '2026-01-01T00:00:00.000Z');
        await idb.put('workouts', w);
        await sync.drain();

        // Device A deletes.
        server.apply(server.workouts, {id: 'w1', client_updated_at: '2026-02-01T00:00:00.000Z', deleted: true});

        // Device B, offline meanwhile, pushes a newer edit.
        const other = Sync();
        await other.login('rider@example.com', 'x');
        await idb.put('workouts', workout('w1', 'Edited later', '2026-06-01T00:00:00.000Z'));
        await other.drain();

        expect(server.workouts.get('w1').deleted_at).toBeTruthy();
        expect(await idb.get('workouts', 'w1')).toBe(undefined);
    });

    test('a newer local edit survives an older copy coming down', async () => {
        server.apply(server.workouts, {
            id: 'w1',
            name: 'Server copy',
            workout: {},
            client_updated_at: '2026-01-01T00:00:00.000Z',
        });
        await idb.put('workouts', workout('w1', 'Local edit', '2026-05-01T00:00:00.000Z'));

        await sync.drain();

        const stored = await idb.get('workouts', 'w1');
        expect(stored.name).toBe('Local edit');
        expect(server.workouts.get('w1').name).toBe('Local edit');
    });

    test('a FIT blob already on this device is never dropped by an incoming summary', async () => {
        const blob = {size: 4096, marker: 'the real ride file'};
        await idb.put('activity', activity('a1', '2026-01-01T00:00:00.000Z', blob));
        await sync.drain();

        // The summary is edited elsewhere and comes back down.
        server.apply(server.activities, {
            id: 'a1',
            name: 'Renamed on the phone',
            started_at: '2026-01-01T00:00:00.000Z',
            duration_sec: 3600,
            summary: {avgPower: 200},
            client_updated_at: '2026-07-01T00:00:00.000Z',
        });
        await sync.drain();

        const stored = await idb.get('activity', 'a1');
        expect(stored.summary.name).toBe('Renamed on the phone');
        expect(stored.blob).toEqual(blob);
    });

    test('an interrupted FIT upload is retried on the next drain', async () => {
        const blob = {size: 2048};
        await idb.put('activity', activity('a1', '2026-01-01T00:00:00.000Z', blob));
        server.pendingFit = [{id: 'a1'}];

        await sync.drain();

        expect(server.uploaded).toEqual(['https://spaces.test/a1']);
        expect(server.pendingFit).toEqual([]);
    });

    test('a ride recorded elsewhere is not uploaded from a device that has no blob', async () => {
        await idb.put('activity', Object.assign(activity('a1'), {blob: undefined}));
        server.pendingFit = [{id: 'a1'}];

        await sync.drain();

        expect(server.uploaded).toEqual([]);
    });

    test('a lost session signs out cleanly and leaves local data dirty', async () => {
        await idb.put('workouts', workout('w1'));
        server.signedIn = false;

        await sync.drain();
        await flush();

        expect(sync.user).toBe(undefined);
        expect(sync.state).toBe(SyncState.signedOut);
        // Nothing was discarded, so signing back in resumes from here.
        expect((await idb.get('workouts', 'w1')).dirty).toBe(true);
    });

    test('a server error leaves the record queued rather than losing it', async () => {
        await idb.put('workouts', workout('w1'));
        server.failNext = 500;

        await sync.drain();

        expect(server.workouts.size).toBe(0);
        expect((await idb.get('workouts', 'w1')).dirty).toBe(true);
        expect(sync.state).toBe(SyncState.error);
    });

    test('the cursor is not advanced by a push, so an earlier device is not skipped', async () => {
        // Device B got in first, at a lower sequence.
        server.apply(server.workouts, {
            id: 'from-b',
            name: 'From device B',
            workout: {},
            client_updated_at: '2026-01-01T00:00:00.000Z',
        });

        // This device signs in fresh and pushes its own library.
        await clearStores();
        const fresh = Sync();
        await fresh.login('rider@example.com', 'x');
        await idb.put('workouts', workout('from-a', 'From device A'));
        await fresh.drain();

        expect(await idb.get('workouts', 'from-b')).toBeDefined();
    });

    // -- rider profile ---------------------------------------------------

    // What db.js's reducer would do with the dispatch, so a test can assert on
    // what the app would actually end up showing.
    function watchProfile() {
        const seen = [];
        const handler = (e) => seen.push(e.detail.data);
        window.addEventListener('sync:settings', handler);
        return {seen, stop: () => window.removeEventListener('sync:settings', handler)};
    }

    test('editing FTP or weight pushes the profile straight away', async () => {
        sync.settingsChanged({ftp: 283, weight: 71});
        await sync.drain();

        expect(server.settings.settings).toEqual({ftp: 283, weight: 71});
    });

    test('a pushed profile is marked clean so it is not sent twice', async () => {
        sync.settingsChanged({ftp: 283, weight: 71});
        await sync.drain();
        const seqAfterFirst = server.seq;

        await sync.drain();
        expect(server.seq).toBe(seqAfterFirst);
    });

    test('nothing is pushed for a rider who has never touched the profile', async () => {
        await sync.drain();
        expect(server.settings).toBe(undefined);
    });

    test('a profile set on another device arrives and is handed to the app', async () => {
        const watch = watchProfile();

        server.applySettings({settings: {ftp: 300, weight: 68}, client_updated_at: '2026-02-01T00:00:00.000Z'});
        await sync.drain();

        expect(watch.seen).toEqual([{ftp: 300, weight: 68}]);
        watch.stop();
    });

    test('an unchanged profile is not re-announced on every drain', async () => {
        server.applySettings({settings: {ftp: 300, weight: 68}, client_updated_at: '2026-02-01T00:00:00.000Z'});
        await sync.drain();

        const watch = watchProfile();
        await sync.drain();
        await sync.drain();

        expect(watch.seen).toEqual([]);
        watch.stop();
    });

    test('a local edit made offline beats an older profile coming down', async () => {
        server.applySettings({settings: {ftp: 250}, client_updated_at: '2026-01-01T00:00:00.000Z'});

        sync.settingsChanged({ftp: 283, weight: 71});
        await sync.drain();

        expect(server.settings.settings).toEqual({ftp: 283, weight: 71});
    });

    test('an edit that loses the comparison learns the winning values from its own push', async () => {
        // Another device wrote a profile from the future while this one was offline.
        server.applySettings({settings: {ftp: 300, weight: 68}, client_updated_at: '2100-01-01T00:00:00.000Z'});
        // The pull that follows the push will not return the row — its seq did
        // not move — so the push response is the only place this can be learnt.
        await sync.drain();

        const watch = watchProfile();
        sync.settingsChanged({ftp: 283, weight: 71});
        await sync.drain();

        expect(server.settings.settings).toEqual({ftp: 300, weight: 68});
        expect(watch.seen).toEqual([{ftp: 300, weight: 68}]);
        watch.stop();
    });

    test('a rider who set an FTP before profile sync existed is seeded on sign in', async () => {
        server.reset();
        window.localStorage.clear();

        const fresh = Sync();
        fresh.seedFromLocal({ftp: 283, weight: 75}, {ftp: 200, weight: 75});
        await fresh.login('rider@example.com', 'x');

        expect(server.settings.settings).toEqual({ftp: 283, weight: 75});
    });

    test('a seed never overwrites a profile the account already carries', async () => {
        server.reset();
        window.localStorage.clear();
        server.applySettings({settings: {ftp: 300, weight: 68}, client_updated_at: '2026-02-01T00:00:00.000Z'});

        const watch = watchProfile();
        const fresh = Sync();
        fresh.seedFromLocal({ftp: 283, weight: 75}, {ftp: 200, weight: 75});
        await fresh.login('rider@example.com', 'x');

        expect(server.settings.settings).toEqual({ftp: 300, weight: 68});
        expect(watch.seen).toEqual([{ftp: 300, weight: 68}]);
        watch.stop();
    });

    test('untouched factory values are not seeded over a real profile', async () => {
        server.reset();
        window.localStorage.clear();

        const fresh = Sync();
        fresh.seedFromLocal({ftp: 200, weight: 75}, {ftp: 200, weight: 75});
        await fresh.login('rider@example.com', 'x');

        expect(server.settings).toBe(undefined);
    });

    test('a failed drain leaves the profile queued rather than losing it', async () => {
        sync.settingsChanged({ftp: 283, weight: 71});
        server.failNext = 500;

        await sync.drain();
        expect(server.settings).toBe(undefined);

        server.failNext = undefined;
        await sync.drain();
        expect(server.settings.settings).toEqual({ftp: 283, weight: 71});
    });

    test('signing out stops the queue and clears the session', async () => {
        await sync.logout();

        expect(sync.user).toBe(undefined);
        expect(sync.state).toBe(SyncState.signedOut);
    });
});
