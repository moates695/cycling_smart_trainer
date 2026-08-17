import {
    toIso,
    toMillis,
    isNewer,
    stampLocal,
    markSynced,
    markDeleted,
    isDeleted,
    isSyncable,
    workoutToPayload,
    workoutFromPayload,
    activityToPayload,
    activityFromPayload,
    pickSettings,
    settingsToPayload,
    settingsFromPayload,
    mergeSettings,
    seedSettings,
    isSettingsDirty,
    mergeRecord,
    mergeCollection,
    collectDirty,
    prepareForFirstSync,
    batch,
    nextBackoffMs,
    shouldRetry,
    isAuthFailure,
    advanceCursor,
    BACKOFF_MAX_MS,
} from '../../src/sync/sync-model.js';

describe('time helpers', () => {
    test('accepts a millisecond epoch, a Date and an ISO string', () => {
        const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
        const expected = '2026-01-02T03:04:05.000Z';

        expect(toIso(ms)).toBe(expected);
        expect(toIso(new Date(ms))).toBe(expected);
        expect(toIso(expected)).toBe(expected);
    });

    test('returns undefined rather than throwing on junk', () => {
        expect(toIso(undefined)).toBe(undefined);
        expect(toIso(null)).toBe(undefined);
        expect(toIso('not a date')).toBe(undefined);
        expect(toIso({})).toBe(undefined);
    });

    test('toMillis round trips', () => {
        const ms = Date.UTC(2026, 5, 1);
        expect(toMillis(toIso(ms))).toBe(ms);
        expect(toMillis(undefined)).toBe(0);
    });

    test('isNewer compares across representations', () => {
        const earlier = Date.UTC(2026, 0, 1);
        const later = Date.UTC(2026, 0, 2);

        expect(isNewer(later, earlier)).toBe(true);
        expect(isNewer(toIso(later), earlier)).toBe(true);
        expect(isNewer(earlier, later)).toBe(false);
    });

    test('a tie is not newer, so repeating a push is a no-op', () => {
        const at = Date.UTC(2026, 0, 1);
        expect(isNewer(at, at)).toBe(false);
    });

    test('anything is newer than nothing', () => {
        expect(isNewer(Date.now(), undefined)).toBe(true);
        expect(isNewer(undefined, Date.now())).toBe(false);
    });
});

describe('local record envelopes', () => {
    test('stampLocal marks the record dirty without mutating the original', () => {
        const original = {id: 'a', name: 'Threshold'};
        const stamped = stampLocal(original, Date.UTC(2026, 0, 1));

        expect(stamped.dirty).toBe(true);
        expect(stamped.updated_at).toBe('2026-01-01T00:00:00.000Z');
        expect(original.dirty).toBe(undefined);
    });

    test('markSynced clears dirty and adopts the server cursor', () => {
        const record = stampLocal({id: 'a'}, Date.UTC(2026, 0, 1));
        const synced = markSynced(record, {seq: 42, client_updated_at: '2026-01-01T00:00:00.000Z'});

        expect(synced.dirty).toBe(false);
        expect(synced.seq).toBe(42);
    });

    test('markDeleted writes a tombstone and leaves it dirty so it gets pushed', () => {
        const deleted = markDeleted({id: 'a'}, Date.UTC(2026, 0, 1));

        expect(isDeleted(deleted)).toBe(true);
        expect(deleted.dirty).toBe(true);
        expect(deleted.deleted_at).toBe('2026-01-01T00:00:00.000Z');
    });

    test('the built-in library is never syncable', () => {
        expect(isSyncable({id: 'a', isDefault: true})).toBe(false);
        expect(isSyncable({id: 'a'})).toBe(true);
    });
});

describe('workout serialisation', () => {
    const workout = {
        id: 'w1',
        name: 'Threshold 2x20',
        zwo: '<workout_file/>',
        updated_at: '2026-01-01T00:00:00.000Z',
        dirty: true,
        meta: {name: 'Threshold 2x20', duration: 2400},
        intervals: [{duration: 1200, steps: [{duration: 1200, power: 0.95}]}],
    };

    test('sync bookkeeping is stripped out of the payload body', () => {
        const payload = workoutToPayload(workout);

        expect(payload.id).toBe('w1');
        expect(payload.name).toBe('Threshold 2x20');
        expect(payload.zwo).toBe('<workout_file/>');
        expect(payload.client_updated_at).toBe('2026-01-01T00:00:00.000Z');
        expect(payload.deleted).toBe(false);
        expect(payload.workout.intervals).toEqual(workout.intervals);
        expect(payload.workout.dirty).toBe(undefined);
        expect(payload.workout.updated_at).toBe(undefined);
        expect(payload.workout.id).toBe(undefined);
    });

    test('the parsed form round trips, which is why it is stored and not just the ZWO', () => {
        const payload = workoutToPayload(workout);
        const restored = workoutFromPayload(Object.assign({}, payload, {
            deleted_at: null,
            seq: 7,
        }));

        expect(restored.id).toBe(workout.id);
        expect(restored.intervals).toEqual(workout.intervals);
        expect(restored.meta).toEqual(workout.meta);
        expect(restored.zwo).toBe(workout.zwo);
        expect(restored.dirty).toBe(false);
        expect(restored.seq).toBe(7);
    });

    test('a workout with no ZWO source survives the trip', () => {
        const fromFitCourse = {id: 'w2', name: 'Course', updated_at: 1, intervals: []};
        const payload = workoutToPayload(fromFitCourse);

        expect(payload.zwo).toBe(null);
        expect(workoutFromPayload(payload).zwo).toBe(undefined);
    });

    test('a deleted workout serialises as a tombstone', () => {
        const payload = workoutToPayload(markDeleted(workout, Date.UTC(2026, 0, 2)));
        expect(payload.deleted).toBe(true);
    });

    test('the name falls back to the workout meta', () => {
        const payload = workoutToPayload({id: 'w3', meta: {name: 'From meta'}, updated_at: 1});
        expect(payload.name).toBe('From meta');
    });
});

describe('activity serialisation', () => {
    const record = {
        id: 'a1',
        blob: {size: 4096},
        updated_at: '2026-01-01T00:00:00.000Z',
        summary: {
            id: 'a1',
            name: 'Tuesday ride',
            timestamp: Date.UTC(2026, 0, 1),
            duration: 3600,
            avgPower: 210,
            np: 225,
            tss: 78,
            trace: {p: [1, 2, 3], h: [], c: []},
        },
    };

    test('the summary crosses the wire and the blob size comes from the blob', () => {
        const payload = activityToPayload(record);

        expect(payload.id).toBe('a1');
        expect(payload.duration_sec).toBe(3600);
        expect(payload.started_at).toBe('2026-01-01T00:00:00.000Z');
        expect(payload.fit_size_bytes).toBe(4096);
        expect(payload.summary.trace.p).toEqual([1, 2, 3]);
    });

    test('an activity older than the sync layer falls back to its own timestamp', () => {
        const legacy = {id: 'a2', summary: {timestamp: Date.UTC(2025, 0, 1), duration: 60}};
        expect(activityToPayload(legacy).client_updated_at).toBe('2025-01-01T00:00:00.000Z');
    });

    test('a pulled activity has no blob until its FIT file is fetched', () => {
        const restored = activityFromPayload({
            id: 'a1',
            name: 'Tuesday ride',
            started_at: '2026-01-01T00:00:00.000Z',
            duration_sec: 3600,
            summary: {avgPower: 210},
            fit_key: 'fit/u/a1.fit',
            fit_uploaded_at: '2026-01-01T00:10:00.000Z',
            fit_size_bytes: 4096,
            client_updated_at: '2026-01-01T00:00:00.000Z',
            deleted_at: null,
            seq: 3,
        });

        expect(restored.blob).toBe(undefined);
        expect(restored.summary.timestamp).toBe(Date.UTC(2026, 0, 1));
        expect(restored.summary.duration).toBe(3600);
        expect(restored.fit_key).toBe('fit/u/a1.fit');
        expect(restored.dirty).toBe(false);
    });
});

describe('rider profile', () => {
    const DEFAULTS = {ftp: 200, weight: 75};

    test('only the fields that sync cross the wire', () => {
        const picked = pickSettings({ftp: 283, weight: 71, theme: 'dark', volume: 50});
        expect(picked).toEqual({ftp: 283, weight: 71});
    });

    test('a missing field is left out rather than sent as null', () => {
        expect(pickSettings({ftp: 283, weight: undefined})).toEqual({ftp: 283});
        expect(pickSettings(undefined)).toEqual({});
    });

    test('the envelope round trips', () => {
        const record = stampLocal({settings: {ftp: 283, weight: 71}}, Date.UTC(2026, 0, 1));
        const payload = settingsToPayload(record);

        expect(payload.settings).toEqual({ftp: 283, weight: 71});
        expect(payload.client_updated_at).toBe('2026-01-01T00:00:00.000Z');

        const restored = settingsFromPayload(Object.assign({}, payload, {seq: 9}));
        expect(restored.settings).toEqual({ftp: 283, weight: 71});
        expect(restored.seq).toBe(9);
        expect(restored.dirty).toBe(false);
    });

    test('an account with no profile yet pulls nothing to merge', () => {
        expect(settingsFromPayload(undefined)).toBe(undefined);
        expect(settingsFromPayload(null)).toBe(undefined);
        expect(mergeSettings({settings: {ftp: 283}}, undefined).action).toBe('noop');
    });

    test('a profile from another device is adopted when there is none locally', () => {
        const remote = settingsFromPayload({settings: {ftp: 283}, client_updated_at: 1, seq: 1});
        const result = mergeSettings(undefined, remote);

        expect(result.action).toBe('update');
        expect(result.record).toBe(remote);
    });

    test('a newer unpushed local edit is kept', () => {
        const local = stampLocal({settings: {ftp: 300}}, Date.UTC(2026, 0, 3));
        const remote = settingsFromPayload({
            settings: {ftp: 283},
            client_updated_at: toIso(Date.UTC(2026, 0, 2)),
        });

        expect(mergeSettings(local, remote).action).toBe('keep');
    });

    test('an already pushed local profile loses even when its timestamp is newer', () => {
        // Not dirty means the server acknowledged it, so the server's copy is by
        // definition the later one.
        const local = {settings: {ftp: 300}, updated_at: toIso(Date.UTC(2026, 0, 5)), dirty: false};
        const remote = settingsFromPayload({
            settings: {ftp: 283},
            client_updated_at: toIso(Date.UTC(2026, 0, 2)),
        });

        expect(mergeSettings(local, remote).action).toBe('update');
    });

    test('a profile is only queued once something has actually changed it', () => {
        expect(isSettingsDirty(undefined)).toBe(false);
        expect(isSettingsDirty({settings: {ftp: 283}, dirty: false})).toBe(false);
        expect(isSettingsDirty(stampLocal({settings: {ftp: 283}}))).toBe(true);
    });

    test('untouched factory values are not seeded', () => {
        expect(seedSettings({ftp: 200, weight: 75}, DEFAULTS)).toBe(undefined);
    });

    test('a rider who set an FTP before profile sync existed gets seeded', () => {
        const seeded = seedSettings({ftp: 283, weight: 75}, DEFAULTS);

        // The whole profile goes, not just the field that differs: it is one record.
        expect(seeded.settings).toEqual({ftp: 283, weight: 75});
        expect(seeded.dirty).toBe(true);
        // The epoch, so any profile the account already carries wins.
        expect(seeded.updated_at).toBe('1970-01-01T00:00:00.000Z');
    });

    test('a seeded profile loses to anything the account already holds', () => {
        const seeded = seedSettings({ftp: 283, weight: 75}, DEFAULTS);
        const remote = settingsFromPayload({
            settings: {ftp: 300},
            client_updated_at: toIso(Date.UTC(2026, 0, 1)),
        });

        expect(mergeSettings(seeded, remote).action).toBe('update');
    });
});

describe('merge', () => {
    const remote = (id, at, extra = {}) =>
        Object.assign({id, updated_at: toIso(at), dirty: false}, extra);

    test('an unseen remote record is inserted', () => {
        expect(mergeRecord(undefined, remote('w1', 1)).action).toBe('insert');
    });

    test('a newer remote record overwrites a clean local one', () => {
        const local = remote('w1', Date.UTC(2026, 0, 1));
        const incoming = remote('w1', Date.UTC(2026, 0, 2));

        expect(mergeRecord(local, incoming).action).toBe('update');
    });

    test('a newer unpushed local edit is kept', () => {
        const local = stampLocal({id: 'w1'}, Date.UTC(2026, 0, 3));
        const incoming = remote('w1', Date.UTC(2026, 0, 2));

        const result = mergeRecord(local, incoming);
        expect(result.action).toBe('keep');
        expect(result.record).toBe(local);
    });

    test('a clean local record loses even when its timestamp is newer', () => {
        // Not dirty means it was already acknowledged by the server, so the
        // server's version is by definition the later one.
        const local = remote('w1', Date.UTC(2026, 0, 5));
        const incoming = remote('w1', Date.UTC(2026, 0, 2));

        expect(mergeRecord(local, incoming).action).toBe('update');
    });

    test('a tombstone removes the local record', () => {
        const local = stampLocal({id: 'w1'}, Date.UTC(2026, 0, 1));
        const incoming = remote('w1', Date.UTC(2026, 0, 2), {deleted_at: toIso(Date.UTC(2026, 0, 2))});

        expect(mergeRecord(local, incoming).action).toBe('remove');
    });

    test('a tombstone beats a newer local edit', () => {
        const local = stampLocal({id: 'w1'}, Date.UTC(2026, 1, 1));
        const incoming = remote('w1', Date.UTC(2026, 0, 1), {deleted_at: toIso(Date.UTC(2026, 0, 1))});

        expect(mergeRecord(local, incoming).action).toBe('remove');
    });

    test('a tombstone for something never seen locally is a no-op', () => {
        const incoming = remote('w1', 1, {deleted_at: toIso(1)});
        expect(mergeRecord(undefined, incoming).action).toBe('noop');
    });

    test('mergeCollection applies a whole page and returns the resulting list', () => {
        const locals = [
            remote('keep-me', Date.UTC(2026, 0, 1)),
            stampLocal({id: 'mine', name: 'local edit'}, Date.UTC(2026, 0, 9)),
            remote('doomed', Date.UTC(2026, 0, 1)),
        ];
        const remotes = [
            remote('doomed', Date.UTC(2026, 0, 2), {deleted_at: toIso(Date.UTC(2026, 0, 2))}),
            remote('mine', Date.UTC(2026, 0, 2), {name: 'server edit'}),
            remote('brand-new', Date.UTC(2026, 0, 3)),
        ];

        const {instructions, records} = mergeCollection(locals, remotes);

        expect(instructions.map((i) => i.action)).toEqual(['remove', 'keep', 'insert']);
        const ids = records.map((r) => r.id).sort();
        expect(ids).toEqual(['brand-new', 'keep-me', 'mine']);
        expect(records.find((r) => r.id === 'mine').name).toBe('local edit');
    });

    test('mergeCollection does not mutate the local list', () => {
        const locals = [remote('a', 1)];
        mergeCollection(locals, [remote('a', 2, {deleted_at: toIso(2)})]);
        expect(locals).toHaveLength(1);
    });

    test('an empty page leaves everything alone', () => {
        const locals = [remote('a', 1)];
        expect(mergeCollection(locals, []).records).toEqual(locals);
    });
});

describe('queue', () => {
    test('collectDirty picks up dirty records and anything never stamped', () => {
        const records = [
            {id: 'clean', dirty: false, updated_at: '2026-01-01T00:00:00.000Z'},
            {id: 'dirty', dirty: true, updated_at: '2026-01-01T00:00:00.000Z'},
            {id: 'legacy'},
        ];

        expect(collectDirty(records).map((r) => r.id)).toEqual(['dirty', 'legacy']);
    });

    test('collectDirty honours a syncable predicate, so built-ins are skipped', () => {
        const records = [{id: 'a', isDefault: true}, {id: 'b'}];
        expect(collectDirty(records, {syncable: isSyncable}).map((r) => r.id)).toEqual(['b']);
    });

    test('first login stamps every unstamped record so the whole library goes up', () => {
        const records = [{id: 'a'}, {id: 'b', updated_at: '2026-01-01T00:00:00.000Z', dirty: false}];
        const prepared = prepareForFirstSync(records, Date.UTC(2026, 2, 1));

        expect(prepared[0].updated_at).toBe('2026-03-01T00:00:00.000Z');
        expect(prepared[0].dirty).toBe(true);
        // An already stamped record is left exactly as it was.
        expect(prepared[1]).toBe(records[1]);
    });

    test('batch splits a large first sync into pages', () => {
        const records = Array.from({length: 250}, (_, i) => ({id: `w${i}`}));
        const pages = batch(records, 100);

        expect(pages.map((p) => p.length)).toEqual([100, 100, 50]);
        expect(pages.flat()).toHaveLength(250);
    });

    test('batch of an empty list is no pages at all', () => {
        expect(batch([])).toEqual([]);
        expect(batch(undefined)).toEqual([]);
    });
});

describe('backoff and retry', () => {
    test('backoff grows exponentially and then stops', () => {
        expect(nextBackoffMs(0)).toBe(2000);
        expect(nextBackoffMs(1)).toBe(4000);
        expect(nextBackoffMs(2)).toBe(8000);
        expect(nextBackoffMs(50)).toBe(BACKOFF_MAX_MS);
    });

    test('a network failure and a server error are worth retrying', () => {
        expect(shouldRetry(undefined)).toBe(true);
        expect(shouldRetry(500)).toBe(true);
        expect(shouldRetry(502)).toBe(true);
        expect(shouldRetry(429)).toBe(true);
    });

    test('a bad request is not retried, because it will fail identically', () => {
        expect(shouldRetry(400)).toBe(false);
        expect(shouldRetry(401)).toBe(false);
        expect(shouldRetry(409)).toBe(false);
    });

    test('401 is reported as an auth failure rather than a transient one', () => {
        expect(isAuthFailure(401)).toBe(true);
        expect(isAuthFailure(500)).toBe(false);
    });
});

describe('cursor', () => {
    test('advances forwards only', () => {
        expect(advanceCursor(5, 9)).toBe(9);
        expect(advanceCursor(9, 5)).toBe(9);
        expect(advanceCursor(undefined, 3)).toBe(3);
        expect(advanceCursor(7, undefined)).toBe(7);
    });
});
