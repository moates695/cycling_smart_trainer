//
// Sync model
//
// Pure conversion and merge logic between the local IndexedDB records and the
// WATTS API. Deliberately DOM free and free of heavy app imports, so it can be
// unit tested in isolation — same convention as workouts/designer-model.js.
//
// The governing rule lives here rather than in the network glue:
//
//   IndexedDB is the source of truth for the running app. The server is a
//   replica that converges in the background, and no UI path ever blocks on it.
//   A trainer app that stops working when the wifi drops mid-interval is broken.
//
// Two clocks, matching the server:
//
//   updated_at        the device's own modification time. Only ever used for the
//                     last-write-wins comparison between two versions of a record.
//   cursor            an opaque integer handed out by the server. The client
//                     stores the server's number, never its own, so clock skew
//                     between devices cannot make a record skip past the cursor.
//

const SyncState = {
    signedOut: 'signed-out',
    idle: 'idle',
    syncing: 'syncing',
    offline: 'offline',
    error: 'error',
};

// Retry schedule for a failed drain. Jitter is applied by the caller so this
// stays pure and testable.
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

// Largest number of records pushed in one request. Matches the server's cap.
const PUSH_BATCH_SIZE = 200;

function exists(x) {
    return x !== undefined && x !== null;
}

function empty(xs) {
    return !exists(xs) || xs.length === 0;
}

// -- time ----------------------------------------------------------------

// Accepts a millisecond epoch, a Date or an ISO string, and always returns an
// ISO string. Local records predate the sync layer and carry timestamps in
// whichever of those forms the model that wrote them happened to use.
function toIso(value) {
    if(!exists(value)) return undefined;
    if(typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
    }
    if(value instanceof Date) return value.toISOString();
    if(typeof value === 'number') return new Date(value).toISOString();
    return undefined;
}

function toMillis(value) {
    const iso = toIso(value);
    return exists(iso) ? Date.parse(iso) : 0;
}

// True when `a` is strictly later than `b`. A tie keeps what is already stored,
// which makes repeated pushes of an unchanged record a no-op.
function isNewer(a, b) {
    if(!exists(b)) return true;
    if(!exists(a)) return false;
    return toMillis(a) > toMillis(b);
}

// -- local record envelopes ----------------------------------------------

// Mark a record as locally modified and due for push.
function stampLocal(record, at = Date.now()) {
    return Object.assign({}, record, {
        updated_at: toIso(at),
        dirty: true,
    });
}

// The push succeeded. Keep the server's cursor so a later pull does not hand
// this record straight back.
function markSynced(record, serverRecord = {}) {
    return Object.assign({}, record, {
        dirty: false,
        updated_at: toIso(serverRecord.client_updated_at) ?? record.updated_at,
        seq: serverRecord.seq ?? record.seq,
    });
}

// Deletes are tombstones, not removals. Without that, a workout deleted on the
// laptop is resurrected by the phone on its next push.
function markDeleted(record, at = Date.now()) {
    return Object.assign({}, record, {
        updated_at: toIso(at),
        deleted_at: toIso(at),
        dirty: true,
    });
}

function isDeleted(record) {
    return exists(record) && exists(record.deleted_at);
}

// The built-in library ships with the app and is identical on every device, so
// it is never pushed and never counted as a conflict.
function isSyncable(workout) {
    return exists(workout) && !workout.isDefault;
}

// -- serialisation -------------------------------------------------------

// A workout record is the parsed form exactly as held in idb. Workout.parse()
// accepts both ZWO and FIT courses, so ZWO is not a universal source form and
// cannot be the only thing stored.
function workoutToPayload(workout) {
    const { id, name, zwo, updated_at, deleted_at, dirty, seq, isDefault, ...rest } = workout;
    return {
        id,
        name: name ?? workout?.meta?.name ?? '',
        workout: rest,
        zwo: zwo ?? null,
        client_updated_at: toIso(updated_at) ?? new Date(0).toISOString(),
        deleted: exists(deleted_at),
    };
}

function workoutFromPayload(payload) {
    return Object.assign({}, payload.workout, {
        id: payload.id,
        name: payload.name,
        zwo: payload.zwo ?? undefined,
        updated_at: toIso(payload.client_updated_at),
        deleted_at: toIso(payload.deleted_at),
        seq: payload.seq,
        dirty: false,
    });
}

// An activity record in idb is {id, blob, summary}. Only the summary crosses the
// wire here; the FIT blob goes to Spaces through a presigned URL.
function activityToPayload(record) {
    const summary = record.summary ?? {};
    return {
        id: record.id,
        name: summary.name ?? '',
        started_at: toIso(summary.timestamp) ?? new Date(0).toISOString(),
        duration_sec: Math.round(summary.duration ?? 0),
        summary,
        fit_size_bytes: record.blob?.size ?? record.fit_size_bytes ?? null,
        client_updated_at: toIso(record.updated_at ?? summary.timestamp) ?? new Date(0).toISOString(),
        deleted: exists(record.deleted_at),
    };
}

// A record pulled from the server has no blob until its FIT file is fetched.
function activityFromPayload(payload) {
    const summary = Object.assign({}, payload.summary, {
        id: payload.id,
        name: payload.name,
        timestamp: toMillis(payload.started_at),
        duration: payload.duration_sec,
    });
    return {
        id: payload.id,
        summary,
        updated_at: toIso(payload.client_updated_at),
        deleted_at: toIso(payload.deleted_at),
        seq: payload.seq,
        dirty: false,
        fit_key: payload.fit_key ?? undefined,
        fit_uploaded_at: toIso(payload.fit_uploaded_at),
        fit_size_bytes: payload.fit_size_bytes ?? undefined,
    };
}

// -- rider profile -------------------------------------------------------
//
// FTP and weight are one record, not one per field: they are written from a
// single settings screen, so a per-field merge would buy nothing and would cost
// a cursor entry per field. Unlike workouts and activities the profile lives in
// local storage rather than idb, because that is where the models that own it
// already keep it and reading it at startup has to be synchronous.

const SETTINGS_KEYS = ['ftp', 'weight'];

// Narrow whatever the caller hands over to the fields that actually sync, so
// adding a local-only setting later does not silently start crossing the wire.
function pickSettings(values, keys = SETTINGS_KEYS) {
    const out = {};
    for(const key of keys) {
        if(exists(values?.[key])) out[key] = values[key];
    }
    return out;
}

function settingsToPayload(record) {
    return {
        settings: pickSettings(record?.settings),
        client_updated_at: toIso(record?.updated_at) ?? new Date(0).toISOString(),
    };
}

function settingsFromPayload(payload) {
    if(!exists(payload)) return undefined;
    return {
        settings: pickSettings(payload.settings),
        updated_at: toIso(payload.client_updated_at),
        seq: payload.seq,
        dirty: false,
    };
}

// The same last-write-wins decision as mergeRecord, minus the tombstone arm: a
// profile is replaced, never deleted.
function mergeSettings(local, remote) {
    if(!exists(remote)) return {action: 'noop'};
    if(!exists(local)) return {action: 'update', record: remote};
    if(local.dirty === true && isNewer(local.updated_at, remote.updated_at)) {
        return {action: 'keep', record: local};
    }
    return {action: 'update', record: remote};
}

// A browser that has been in use for months holds an FTP but has no envelope,
// because nothing has touched the setting since this feature shipped. Without a
// seed those values are stranded on that one device.
//
// The seed is stamped at the epoch on purpose: any profile the account already
// carries wins the comparison, so only an empty account is seeded. Values still
// at the factory default are not seeded at all — uploading 200 W overwrites
// nothing on an empty account, but it would beat a real value seeded later by
// another device at the same epoch timestamp.
function seedSettings(values, defaults = {}) {
    const settings = pickSettings(values);
    const changed = Object.keys(settings).some((key) => settings[key] !== defaults[key]);
    if(!changed) return undefined;
    return {settings, updated_at: toIso(0), dirty: true};
}

function isSettingsDirty(record) {
    return exists(record) && record.dirty === true;
}

// -- merge ---------------------------------------------------------------

// What to do with one incoming record. Returned as an instruction rather than
// performed, so the decision is testable without a database.
//
//   'insert'  no local copy — write it
//   'update'  the remote copy is authoritative — overwrite
//   'remove'  the remote copy is a tombstone — delete locally
//   'keep'    the local copy is a newer unpushed edit — leave it to be pushed
function mergeRecord(local, remote) {
    if(isDeleted(remote)) {
        // A tombstone always wins, even over a newer local edit. Losing an edit
        // to a delete is a far less surprising outcome than a deleted workout
        // reappearing on every device.
        return exists(local) ? {action: 'remove', id: remote.id} : {action: 'noop', id: remote.id};
    }
    if(!exists(local)) {
        return {action: 'insert', id: remote.id, record: remote};
    }
    if(local.dirty && isNewer(local.updated_at, remote.updated_at)) {
        return {action: 'keep', id: remote.id, record: local};
    }
    return {action: 'update', id: remote.id, record: remote};
}

// Apply a pulled page against the local collection. Returns instructions plus
// the resulting list, so a caller can both write idb and re-render from one pass.
function mergeCollection(locals, remotes) {
    const byId = new Map((locals ?? []).map((record) => [record.id, record]));
    const instructions = [];

    for(const remote of remotes ?? []) {
        const instruction = mergeRecord(byId.get(remote.id), remote);
        instructions.push(instruction);

        if(instruction.action === 'insert' || instruction.action === 'update') {
            byId.set(instruction.id, instruction.record);
        }
        if(instruction.action === 'remove') {
            byId.delete(instruction.id);
        }
    }

    return {instructions, records: Array.from(byId.values())};
}

// -- queue ---------------------------------------------------------------

// Everything waiting to go up. Built-ins are excluded; a record with no
// updated_at predates the sync layer and is treated as dirty so the first sync
// after signing in pushes the existing library and ride history wholesale.
function collectDirty(records, {syncable = () => true} = {}) {
    return (records ?? []).filter((record) => {
        if(!syncable(record)) return false;
        return record.dirty === true || !exists(record.updated_at);
    });
}

// Records with no updated_at have never been stamped. Give them one so the
// first push carries a usable client clock rather than the epoch.
function prepareForFirstSync(records, at = Date.now()) {
    return (records ?? []).map((record) => (exists(record.updated_at) ? record : stampLocal(record, at)));
}

function batch(records, size = PUSH_BATCH_SIZE) {
    const out = [];
    for(let i = 0; i < (records ?? []).length; i += size) {
        out.push(records.slice(i, i + size));
    }
    return out;
}

// Exponential, capped. The caller adds jitter so a fleet of tabs coming back
// online together does not stampede.
function nextBackoffMs(attempt, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS) {
    if(attempt <= 0) return base;
    return Math.min(max, base * Math.pow(2, attempt));
}

// 401 means sign in again; 4xx means the payload is wrong and retrying will not
// help. Anything else is worth another go.
function shouldRetry(status) {
    if(!exists(status)) return true;          // network failure
    if(status === 408 || status === 429) return true;
    if(status >= 500) return true;
    return false;
}

function isAuthFailure(status) {
    return status === 401;
}

// A pull page is complete when the server says there is no more and the cursor
// has not moved backwards.
function advanceCursor(current, next) {
    if(!exists(next)) return current;
    return Math.max(current ?? 0, next);
}

export {
    SyncState,
    PUSH_BATCH_SIZE,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,

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

    SETTINGS_KEYS,
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
};
