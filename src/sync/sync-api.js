//
// Sync API client
//
// Thin transport over the WATTS backend. No merge logic lives here — that is
// sync-model.js. Every call is same origin, so the session cookie rides along
// with credentials: 'same-origin' and there is no token for JavaScript to hold.
//

import config from '../models/config.js';

const base = () => config.get().WATTS_API_URI;

// A failed call carries the status so the caller can tell a transient failure
// (retry) from an auth failure (sign in again) from a bad payload (give up).
class ApiError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

async function request(path, {method = 'GET', body, signal} = {}) {
    let response;
    try {
        response = await fetch(`${base()}${path}`, {
            method,
            headers: body === undefined ? {} : {'Content-Type': 'application/json'},
            credentials: 'same-origin',
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
    } catch(error) {
        // No status at all: offline, DNS failure, connection reset.
        throw new ApiError(error?.message ?? 'network error', undefined);
    }

    if(response.status === 204) return undefined;

    let parsed;
    try {
        parsed = await response.json();
    } catch(error) {
        parsed = undefined;
    }

    if(!response.ok) {
        throw new ApiError(parsed?.detail ?? response.statusText, response.status, parsed);
    }
    return parsed;
}

// -- auth ----------------------------------------------------------------

const auth = {
    register(email, password) {
        return request('/auth/register', {method: 'POST', body: {email, password}});
    },
    login(email, password) {
        return request('/auth/login', {method: 'POST', body: {email, password}});
    },
    logout() {
        return request('/auth/logout', {method: 'POST'});
    },
    me() {
        return request('/auth/me');
    },
    // Always resolves, account or no account: the server will not say which
    // addresses are registered, and neither does this.
    requestPasswordReset(email) {
        return request('/auth/password/reset', {method: 'POST', body: {email}});
    },
    // Resolves to the user, like login: a correct code signs this device in.
    confirmPasswordReset(email, code, newPassword) {
        return request('/auth/password/reset/confirm', {
            method: 'POST',
            body: {email, code, new_password: newPassword},
        });
    },
    changePassword(currentPassword, newPassword) {
        return request('/auth/password', {
            method: 'POST',
            body: {current_password: currentPassword, new_password: newPassword},
        });
    },
    deleteAccount() {
        return request('/auth/account', {method: 'DELETE'});
    },
};

// -- sync ----------------------------------------------------------------

const sync = {
    pull(since = 0, signal) {
        return request(`/sync?since=${encodeURIComponent(since)}`, {signal});
    },
    // `settings` is one record rather than a list, so on a paged push it rides
    // along with the first page only.
    push(workouts = [], activities = [], settings = undefined, signal) {
        return request('/sync', {method: 'POST', body: {workouts, activities, settings}, signal});
    },
};

// -- FIT files -----------------------------------------------------------

const fit = {
    presign(activityId, sizeBytes) {
        return request(`/activities/${activityId}/fit/presign`, {
            method: 'POST',
            body: {size_bytes: sizeBytes},
        });
    },
    complete(activityId) {
        return request(`/activities/${activityId}/fit/complete`, {method: 'POST'});
    },
    pending() {
        return request('/activities/pending-uploads');
    },
    // Phase 2 of the upload: browser straight to Spaces, so the bytes never pass
    // through the API and a slow connection cannot time out a worker.
    async put(url, blob) {
        let response;
        try {
            response = await fetch(url, {
                method: 'PUT',
                body: blob,
                headers: {'Content-Type': 'application/octet-stream'},
            });
        } catch(error) {
            throw new ApiError(error?.message ?? 'network error', undefined);
        }
        if(!response.ok) {
            throw new ApiError('upload failed', response.status);
        }
    },
    downloadUrl(activityId) {
        return `${base()}/activities/${activityId}/fit`;
    },
};

const api = Object.freeze({auth, sync, fit, request});

export { api, ApiError };
export default api;
