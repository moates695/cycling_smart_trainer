//
// Sync orchestrator
//
// Wires sync-model.js (pure merge logic) and sync-api.js (transport) to the idb
// stores and the xf event bus.
//
// IndexedDB stays the source of truth for the running app. Every local mutation
// is written to idb first and only then queued; nothing in the UI awaits a
// network call. If the backend is unreachable, or the user has no account at
// all, the app behaves exactly as it did before this module existed.
//

import { xf, exists, empty } from '../functions.js';
import { idb } from '../storage/idb.js';
import { api, ApiError } from './sync-api.js';
import {
    SyncState,
    stampLocal,
    markSynced,
    markDeleted,
    isSyncable,
    workoutToPayload,
    workoutFromPayload,
    activityToPayload,
    activityFromPayload,
    mergeCollection,
    mergeSettings,
    pickSettings,
    seedSettings,
    isSettingsDirty,
    settingsToPayload,
    settingsFromPayload,
    collectDirty,
    prepareForFirstSync,
    batch,
    nextBackoffMs,
    shouldRetry,
    isAuthFailure,
    advanceCursor,
    PUSH_BATCH_SIZE,
} from './sync-model.js';

const WORKOUTS_STORE = 'workouts';
const ACTIVITY_STORE = 'activity';

// The rider profile lives in local storage rather than idb: the models that own
// FTP and weight already keep it there, and restoring it at startup has to be
// synchronous. This key holds the sync envelope around those values — the
// individual `ftp` / `weight` keys stay exactly as they were, so the app reads
// its settings the same way whether or not there is an account.
const SETTINGS_KEY = 'sync:settings';

// The account this device last signed in as. The session itself is an httpOnly
// cookie the browser keeps and JavaScript cannot read, so this is only the
// identity that goes with it — enough to stay signed in through a launch with
// no network rather than dropping the rider back to the sign-in card.
const IDENTITY_KEY = 'sync:identity';

// A quiet period between drains. Short enough that a ride saved on the turbo is
// on the other device by the time you have showered; long enough not to matter.
const DRAIN_INTERVAL_MS = 60 * 1000;

function cursorKey(userId) {
    return `sync:cursor:${userId}`;
}

function readCursor(userId) {
    const raw = window.localStorage.getItem(cursorKey(userId));
    const parsed = Number.parseInt(raw ?? '0', 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function writeCursor(userId, cursor) {
    window.localStorage.setItem(cursorKey(userId), String(cursor ?? 0));
}

function readIdentity() {
    try {
        const raw = window.localStorage.getItem(IDENTITY_KEY);
        const parsed = exists(raw) ? JSON.parse(raw) : undefined;
        return exists(parsed?.id) ? parsed : undefined;
    } catch(error) {
        return undefined;
    }
}

function writeIdentity(user) {
    if(!exists(user?.id)) return;
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({id: user.id, email: user.email ?? ''}));
}

function clearIdentity() {
    window.localStorage.removeItem(IDENTITY_KEY);
}

function readSettings() {
    try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        return exists(raw) ? JSON.parse(raw) : undefined;
    } catch(error) {
        // Corrupt envelope. The values themselves are still in their own keys,
        // so the worst case is that the profile syncs again from scratch.
        return undefined;
    }
}

function writeSettings(record) {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(record));
}

// Compared before and after a drain to decide whether the app needs telling.
function settingsFingerprint(record) {
    const settings = pickSettings(record?.settings);
    return Object.keys(settings).sort().map((key) => `${key}=${settings[key]}`).join(',');
}

function Sync() {
    let user = undefined;
    let state = SyncState.signedOut;
    let cursor = 0;
    let attempt = 0;
    let timer = undefined;
    let draining = false;
    // Set while a drain is in flight; a mutation arriving mid-drain schedules
    // another one rather than being silently folded into the current pass.
    let dirtyDuringDrain = false;

    function setState(next) {
        if(state === next) return;
        state = next;
        xf.dispatch('sync:state', state);
    }

    function signedIn() {
        return exists(user);
    }

    // -- session ---------------------------------------------------------

    // Sessions are meant to survive: the cookie is long lived and slides forward
    // on every call, so the only thing that signs a device out is the rider
    // asking for it or the server saying the session is gone.
    async function restore() {
        try {
            const me = await api.auth.me();
            adopt(me);
            schedule(0);
            return me;
        } catch(error) {
            const status = error instanceof ApiError ? error.status : undefined;

            // 401 is the server's answer that this cookie is no longer a
            // session — the ordinary "not signed in" case, and not worth a
            // console error.
            if(isAuthFailure(status)) {
                forget();
                return undefined;
            }

            // Anything else means the backend could not be reached: offline,
            // flaky wifi at the track, a deploy in progress. That says nothing
            // about the session, so the last known account is adopted and the
            // drain retries in the background. Signing the rider out here would
            // be the app inventing a logout the server never asked for.
            const known = readIdentity();
            if(!exists(known)) {
                forget();
                return undefined;
            }
            adopt(known);
            schedule(0);
            return known;
        }
    }

    function adopt(me) {
        user = me;
        cursor = readCursor(me.id);
        attempt = 0;
        writeIdentity(me);
        setState(SyncState.idle);
        xf.dispatch('sync:user', me);
    }

    function forget() {
        user = undefined;
        cursor = 0;
        stop();
        clearIdentity();
        setState(SyncState.signedOut);
        xf.dispatch('sync:user', undefined);
    }

    async function register(email, password) {
        const me = await api.auth.register(email, password);
        adopt(me);
        // A brand new account starts empty, so the whole local library and ride
        // history goes up. Existing users keep their data and gain an account
        // rather than starting from nothing.
        await firstSync();
        return me;
    }

    async function login(email, password) {
        const me = await api.auth.login(email, password);
        adopt(me);
        await firstSync();
        return me;
    }

    // -- forgotten password ----------------------------------------------
    //
    // A code rather than a link, so the session the reset produces lands in the
    // browser that asked for it — the one the rider is about to ride with —
    // rather than in whichever browser opened their mail.

    async function requestPasswordReset(email) {
        await api.auth.requestPasswordReset(email);
    }

    async function resetPassword(email, code, password) {
        const me = await api.auth.confirmPasswordReset(email, code, password);
        // Same path as login from here: the account already exists, so its
        // server side records merge with whatever is on this device.
        adopt(me);
        await firstSync();
        return me;
    }

    async function logout() {
        try {
            await api.auth.logout();
        } finally {
            forget();
        }
    }

    // -- local mutations -------------------------------------------------
    //
    // These are called from db.js reducers after the model has already written
    // to idb. They stamp the record and nudge the queue; they never block.

    async function workoutChanged(workout) {
        if(!isSyncable(workout)) return;
        const stamped = stampLocal(workout);
        await idb.put(WORKOUTS_STORE, stamped);
        schedule(0);
    }

    // Called after the model has removed the row. Writes a tombstone back in its
    // place rather than leaving the store empty, so the delete propagates instead
    // of the workout reappearing from another device on the next pull. The
    // tombstone is swept once the server has acknowledged it.
    async function workoutRemoved(workout) {
        if(!isSyncable(workout)) return;
        await idb.put(WORKOUTS_STORE, markDeleted(workout));
        schedule(0);
    }

    // The record was already stamped by whoever wrote it (Activity.createFromCurrent
    // does this at creation). Nothing to rewrite — just drain soon.
    function nudge() {
        schedule(0);
    }

    async function activityChanged(record) {
        const existing = await idb.get(ACTIVITY_STORE, record.id);
        const stamped = stampLocal(Object.assign({}, existing, record));
        await idb.put(ACTIVITY_STORE, stamped);
        schedule(0);
    }

    // FTP or weight was edited. Synchronous on purpose: the reducer that calls
    // this has already written the value to its own local storage key, and the
    // envelope must not be able to land after it.
    function settingsChanged(values) {
        const current = readSettings();
        const settings = Object.assign({}, current?.settings, pickSettings(values));
        writeSettings(stampLocal({settings, seq: current?.seq}));
        schedule(0);
    }

    // Called once at startup with the values the models restored. Only writes an
    // envelope when there is none, so it never re-dirties a profile that is
    // already in step with the account.
    function seedFromLocal(values, defaults) {
        if(exists(readSettings())) return;
        const seeded = seedSettings(values, defaults);
        if(exists(seeded)) writeSettings(seeded);
    }

    // -- scheduling ------------------------------------------------------

    function schedule(delay = DRAIN_INTERVAL_MS) {
        if(!signedIn()) return;
        if(draining) {
            dirtyDuringDrain = true;
            return;
        }
        if(exists(timer)) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = undefined;
            drain();
        }, delay);
    }

    function stop() {
        if(exists(timer)) window.clearTimeout(timer);
        timer = undefined;
    }

    function backoff() {
        attempt += 1;
        // Jitter, so a fleet of tabs coming back online together does not
        // stampede the API in lockstep.
        const wait = nextBackoffMs(attempt) * (0.75 + Math.random() * 0.5);
        schedule(wait);
    }

    // -- the drain -------------------------------------------------------

    async function drain() {
        if(!signedIn() || draining) return;
        if(!window.navigator.onLine) {
            setState(SyncState.offline);
            return;
        }

        draining = true;
        dirtyDuringDrain = false;
        setState(SyncState.syncing);

        // Both a push (this device lost the last-write-wins) and a pull (another
        // device changed it) can land a new profile, so the app is told once here
        // rather than from each of them.
        const profileBefore = settingsFingerprint(readSettings());

        try {
            await push();
            await pull();
            await uploadPendingFit();

            const after = readSettings();
            if(settingsFingerprint(after) !== profileBefore) {
                xf.dispatch('sync:settings', pickSettings(after?.settings));
            }

            attempt = 0;
            setState(SyncState.idle);
            draining = false;
            schedule(dirtyDuringDrain ? 0 : DRAIN_INTERVAL_MS);
        } catch(error) {
            draining = false;
            handleFailure(error);
        }
    }

    function handleFailure(error) {
        const status = error instanceof ApiError ? error.status : undefined;

        if(isAuthFailure(status)) {
            // The session went away underneath us. Local data is untouched and
            // stays dirty, so signing back in resumes exactly where this left off.
            forget();
            return;
        }
        if(!shouldRetry(status)) {
            console.error(':sync :give-up', error);
            setState(SyncState.error);
            return;
        }
        setState(exists(status) ? SyncState.error : SyncState.offline);
        backoff();
    }

    // -- push ------------------------------------------------------------

    async function push() {
        const workouts = collectDirty(await idb.getAll(WORKOUTS_STORE), {syncable: isSyncable});
        const activities = collectDirty(await idb.getAll(ACTIVITY_STORE));
        const stored = readSettings();
        const settings = isSettingsDirty(stored) ? stored : undefined;

        if(empty(workouts) && empty(activities) && !exists(settings)) return;

        const workoutPages = batch(prepareForFirstSync(workouts), PUSH_BATCH_SIZE);
        const activityPages = batch(prepareForFirstSync(activities), PUSH_BATCH_SIZE);
        // At least one request: a profile edit on its own has no page to ride on.
        const pages = Math.max(workoutPages.length, activityPages.length, 1);

        for(let i = 0; i < pages; i++) {
            const workoutPage = workoutPages[i] ?? [];
            const activityPage = activityPages[i] ?? [];
            // One record, so it goes with the first page and no other.
            const settingsPage = i === 0 ? settings : undefined;

            const result = await api.sync.push(
                workoutPage.map(workoutToPayload),
                activityPage.map(activityToPayload),
                exists(settingsPage) ? settingsToPayload(settingsPage) : undefined,
            );

            await acknowledge(WORKOUTS_STORE, workoutPage, result.workouts);
            await acknowledge(ACTIVITY_STORE, activityPage, result.activities);
            if(exists(settingsPage)) acknowledgeSettings(result.settings);

            // The cursor is deliberately NOT advanced here. A push response's
            // cursor is the high-water mark of the rows just sent, which can sit
            // above rows another device uploaded earlier: a fresh device signing
            // in at cursor 0 and pushing its own library would jump straight past
            // everything already on the account. Only pull() moves the cursor,
            // and it only ever moves it to something it has actually seen.
        }
    }

    // The push response carries the authoritative row, so a record whose edit
    // lost the last-write-wins comparison learns that here rather than on some
    // later pull.
    async function acknowledge(store, sent, returned = []) {
        const byId = new Map(returned.map((row) => [row.id, row]));
        for(const record of sent) {
            const row = byId.get(record.id);
            if(!exists(row)) continue;
            if(exists(row.deleted_at)) {
                await idb.remove(store, record.id);
                continue;
            }
            await idb.put(store, markSynced(record, row));
        }
    }

    // The response is the authoritative profile, so a push that lost the
    // last-write-wins comparison learns the winning values here rather than
    // waiting for a pull that may never return the row (its seq did not move).
    function acknowledgeSettings(returned) {
        const record = settingsFromPayload(returned);
        if(!exists(record)) return;
        writeSettings(record);
    }

    // -- pull ------------------------------------------------------------

    async function pull() {
        let more = true;
        let touchedWorkouts = false;
        let touchedActivities = false;

        while(more) {
            const page = await api.sync.pull(cursor);

            if(!empty(page.workouts)) {
                await applyWorkouts(page.workouts.map(workoutFromPayload));
                touchedWorkouts = true;
            }
            if(!empty(page.activities)) {
                await applyActivities(page.activities.map(activityFromPayload));
                touchedActivities = true;
            }
            if(exists(page.settings)) {
                applySettings(settingsFromPayload(page.settings));
            }

            const next = advanceCursor(cursor, page.cursor);
            more = page.has_more === true && next > cursor;
            cursor = next;
            writeCursor(user.id, cursor);
        }

        if(touchedWorkouts) xf.dispatch('sync:workouts', await idb.getAll(WORKOUTS_STORE));
        if(touchedActivities) xf.dispatch('sync:activities', await summaries());
    }

    function applySettings(remote) {
        const instruction = mergeSettings(readSettings(), remote);
        if(instruction.action !== 'update') return;
        writeSettings(instruction.record);
    }

    async function applyWorkouts(remotes) {
        const locals = (await idb.getAll(WORKOUTS_STORE)) ?? [];
        const { instructions } = mergeCollection(locals, remotes);

        for(const instruction of instructions) {
            if(instruction.action === 'insert' || instruction.action === 'update') {
                await idb.put(WORKOUTS_STORE, instruction.record);
            }
            if(instruction.action === 'remove') {
                await idb.remove(WORKOUTS_STORE, instruction.id);
            }
        }
    }

    async function applyActivities(remotes) {
        const locals = (await idb.getAll(ACTIVITY_STORE)) ?? [];
        const byId = new Map(locals.map((record) => [record.id, record]));
        const { instructions } = mergeCollection(locals, remotes);

        for(const instruction of instructions) {
            if(instruction.action === 'insert' || instruction.action === 'update') {
                // Never drop a FIT blob this device already holds just because
                // the server's copy of the summary is newer.
                const blob = byId.get(instruction.id)?.blob;
                const record = exists(blob) ?
                      Object.assign({}, instruction.record, {blob}) :
                      instruction.record;
                await idb.put(ACTIVITY_STORE, record);
            }
            if(instruction.action === 'remove') {
                await idb.remove(ACTIVITY_STORE, instruction.id);
            }
        }
    }

    async function summaries() {
        const records = (await idb.getAll(ACTIVITY_STORE)) ?? [];
        return records
            .filter((record) => exists(record.summary) && !exists(record.deleted_at))
            .map((record) => record.summary)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    // -- FIT files -------------------------------------------------------

    // Phase 1 and 3 of the three phase upload; phase 2 is a direct PUT to
    // Spaces. A row left between them is self describing (fit_key set,
    // fit_uploaded_at null) and simply gets retried, so a dropped connection is
    // never a correctness problem.
    async function uploadPendingFit() {
        let pending;
        try {
            pending = await api.fit.pending();
        } catch(error) {
            // Storage may not be configured yet. Summaries still sync; only the
            // blobs wait.
            if(error instanceof ApiError && error.status === 503) return;
            throw error;
        }
        if(empty(pending)) return;

        for(const row of pending) {
            const record = await idb.get(ACTIVITY_STORE, row.id);
            const blob = record?.blob;
            if(!exists(blob)) continue;   // this device never held the file

            try {
                const presigned = await api.fit.presign(row.id, blob.size);
                await api.fit.put(presigned.url, blob);
                await api.fit.complete(row.id);
            } catch(error) {
                if(error instanceof ApiError && error.status === 503) return;
                console.warn(`:sync :fit :retry-later ${row.id}`, error?.message);
            }
        }
    }

    // Fetch a FIT file this device does not hold, for a ride recorded elsewhere.
    async function downloadFit(activityId) {
        const response = await fetch(api.fit.downloadUrl(activityId), {credentials: 'same-origin'});
        if(!response.ok) throw new ApiError('download failed', response.status);
        const blob = await response.blob();

        const record = (await idb.get(ACTIVITY_STORE, activityId)) ?? {id: activityId};
        await idb.put(ACTIVITY_STORE, Object.assign({}, record, {blob}));
        return blob;
    }

    // -- first sync ------------------------------------------------------

    // Everything already in idb has a UUID and no server counterpart, so signing
    // in for the first time pushes the local library and ride history wholesale.
    async function firstSync() {
        await drain();
    }

    // -- lifecycle -------------------------------------------------------

    function start() {
        window.addEventListener('online', () => {
            if(signedIn()) schedule(0);
        });
        window.addEventListener('offline', () => {
            if(signedIn()) setState(SyncState.offline);
        });
        // A ride is the one thing worth pushing straight away rather than at the
        // next tick of the interval.
        xf.sub('activity:save:success', () => schedule(0));
        return restore();
    }

    return Object.freeze({
        start,
        restore,
        register,
        login,
        logout,
        requestPasswordReset,
        resetPassword,
        drain,
        downloadFit,
        nudge,
        workoutChanged,
        workoutRemoved,
        activityChanged,
        settingsChanged,
        seedFromLocal,
        get state() { return state; },
        get user() { return user; },
    });
}

const sync = Sync();

export { sync, Sync };
export default sync;
