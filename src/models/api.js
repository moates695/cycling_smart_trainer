import { exists, xf, print, } from '../functions.js';
import { OAuthService, DialogMsg, stateParam, } from './enums.js';
import { uuid } from '../storage/uuid.js';
import config from './config.js';
import strava from './strava.js';
import trainingPeaks from './training-peaks.js';
import auth from './auth.js';


//

function API() {
    const router = Router();

    async function start() {
        router.start();
    }

    function stop() {
    }

    return Object.freeze({
        auth,
        strava,
        trainingPeaks,
        start,
        stop,
    });
}

// TODO: create a proper minimalist router
function Router(args = {}) {

    async function start() {
        // auth.status() used to run here. It calls api.auuki.com, whose CORS
        // allowlist is exactly one origin (https://auuki.com), so from this fork
        // it always rejected and surfaced a misleading "No internet connection or
        // the API service is currently offline" banner. The WATTS account
        // (src/sync/) restores its own session on start, so there is nothing to
        // check here.
        const params = getParams();
        if(hasParams(params)) {
            console.log(params);
            await onQueryParams(params);
        }
        return;
    }

    function getParams() {
        return (new URL(document.location)).searchParams;
    }

    function hasParams(params) {
        if(params) {
            return params.size > 0;
        } else {
            const params = (new URL(document.location)).searchParams;
            return params.size > 0;
        }
    }

    async function onQueryParams(params) {
        // strava params
        const state  = params.get('state');
        const code   = params.get('code');
        const scope  = params.get('scope');
        const error  = params.get('error');
        const token = params.get('token');

        // switch
        if(error) {
            console.error(`:api :param :error `, error);
            return true;
        }
        if(!error && (code || scope || state)) {
            const { service, id } = stateParam.decode(state);
            console.log(`:api :onQueryParams service: ${service} id: ${id}`);

            if(service === OAuthService.strava) {
                await strava.paramsHandler({state, code, scope});
            }
            if(service === OAuthService.trainingPeaks) {
                await trainingPeaks.paramsHandler({state, code, scope});
            }
            return true;
        }
        if(!error && token) {
            xf.dispatch('ui:page-set', 'settings');
            xf.dispatch('action:nav', 'settings:profile');
            xf.dispatch('action:auth', ':password:reset');
            return true;
        }
        // clearParams();
        return false;
    }

    function clearParams() {
        window.history.pushState({}, document.title, window.location.pathname);
    }

    return Object.freeze({
        onQueryParams,
        clearParams,
        start,
    });
}


export default API;

