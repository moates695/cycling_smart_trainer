//
// When the watch starts, pauses, and picks itself up again — as pure functions.
//
// Pressing play no longer starts the clock. The watch is *armed* and the ride
// begins on the rider's first turn of the pedals, so a workout doesn't burn its
// opening interval while they are still clipping in. If they don't get going
// within ARM_WINDOW_S the watch quietly drops back to where it was.
//
// Two independent rider settings, either of which can be on without the other:
//   auto start — the pedals begin the ride, with no play press: from a
//                standstill they start it, and after a pause they pick it back
//                up. All the same gesture, so they are one switch. Ending a ride
//                asks a little more than a pause the app made: after a stop, or
//                a pause the rider pressed, they have to have actually stopped
//                and then pedal for AUTO_START_S before it counts. Otherwise the
//                watts still spinning down off the button press would answer for
//                them and start a fresh ride seconds after they ended one.
//   auto pause — the clock stops when the pedals do
//
// watch.js owns the timer worker and the event bus; this module owns the rules,
// so they can be covered without either. (watch.js constructs a Worker at
// import time, which is why it cannot be unit-tested directly.)
//
import { equals } from './functions.js';

// A trainer reports a trickle of watts from freewheeling and drivetrain noise,
// so "pedalling" needs a floor rather than > 0.
const PEDALLING_WATTS = 40;
// How long the rider has to get going after pressing play.
const ARM_WINDOW_S = 15;
// How long the pedals have to be still before auto pause steps in.
const AUTO_PAUSE_S = 4;
// How long the rider has to be pedalling before auto start begins the ride on
// its own. Long enough that nudging the cranks while setting up doesn't start
// recording; this is what the old 3, 2, 1 countdown was counting.
const AUTO_START_S = 3;

// The one thing the watch should do in response to a sample.
const TimingAction = {
    none:       'none',
    launch:     'launch',       // start, or resume, the ride for real
    armExpired: 'arm-expired',  // the rider never got going
    autoPause:  'auto-pause',
    autoResume: 'auto-resume',
};

function timingDefaults() {
    return {
        armed:  false,
        // Seconds waited since play was pressed.
        armCounter: 0,
        // Consecutive seconds of pedalling while stopped.
        startCounter: 0,
        // Consecutive seconds at zero watts while running.
        idleCounter: 0,
        // Whether the pause the watch is sitting in is one the app made. Those
        // pick themselves up on the first stroke; a pause the rider pressed
        // waits for them to stop and then get going again.
        pausedAutomatically: false,
        // Whether the rider has been seen at rest since the clock last ran.
        // Pausing and stopping are both mid-stroke gestures — the trainer keeps
        // reporting the watts they pressed the button on — so neither becomes
        // something the pedals can undo until the rider has come to a halt. A
        // watch that has never run starts out at rest, so a standing start is
        // not asked to coast first.
        coastedSinceRunning: true,
    };
}

function isPedalling(power) {
    return (power ?? 0) > PEDALLING_WATTS;
}

// One 1 s power sample in; the next timing state plus the single action the
// watch should take, out. `status` is the watch's own 'started' / 'paused' /
// 'stopped'.
function onPowerSample(args = {}) {
    const state     = args.state ?? timingDefaults();
    const power     = args.power ?? 0;
    const status    = args.status ?? 'stopped';
    const settings  = args.settings ?? {};
    const pedalling = isPedalling(power);

    // Waiting for the rider. Nothing else applies until they turn up or the
    // window closes — the clock is not running either way.
    if(state.armed) {
        if(pedalling) {
            return {
                state:  {...state, armed: false, armCounter: 0, startCounter: 0},
                action: TimingAction.launch,
            };
        }
        const armCounter = state.armCounter + 1;
        if(armCounter < ARM_WINDOW_S) {
            return {state: {...state, armCounter, startCounter: 0}, action: TimingAction.none};
        }
        return {
            state: {
                ...state,
                armed: false,
                armCounter: 0,
                startCounter: 0,
                // Giving up mid-ride leaves a pause the app made, so auto
                // resume may still pick it up. Before the ride has begun there
                // is nothing to resume and the watch just stays stopped.
                pausedAutomatically:
                    equals(status, 'paused') || state.pausedAutomatically,
            },
            action: TimingAction.armExpired,
        };
    }

    if(equals(status, 'started')) {
        // Not pedalling, rather than exactly zero: a trainer freewheels a
        // trickle of watts for a long time after the rider stops, and waiting
        // for a clean 0 delays the pause well past AUTO_PAUSE_S. Same floor
        // auto resume uses, so there is no dead band between them.
        const idleCounter = pedalling ? 0 : state.idleCounter + 1;
        if(settings.autoPause && idleCounter >= AUTO_PAUSE_S) {
            return {
                state:  {
                    ...state,
                    idleCounter: 0,
                    startCounter: 0,
                    pausedAutomatically: true,
                    coastedSinceRunning: false,
                },
                action: TimingAction.autoPause,
            };
        }
        return {
            state:  {...state, idleCounter, startCounter: 0, coastedSinceRunning: false},
            action: TimingAction.none,
        };
    }

    // Nothing running. Auto start means the ride begins when the rider does,
    // without play being pressed at all — the setting the 3, 2, 1 countdown
    // used to belong to.
    if(equals(status, 'stopped')) {
        // Rest first, the same rule and for the same reason as a rider pause:
        // stop ends the ride mid-stroke and the trainer freewheels the watts it
        // was turning for a good few seconds afterwards, which would otherwise
        // start a brand new ride three seconds after the rider ended one. A
        // standing start has already been at rest, so it costs nothing there.
        const coasted      = state.coastedSinceRunning || !pedalling;
        // Counting only while the setting is on means switching it on mid-ride
        // starts a fresh confirmation rather than firing straight away.
        const eligible     = settings.autoStart && coasted;
        const startCounter = (eligible && pedalling) ? state.startCounter + 1 : 0;

        if(eligible && startCounter >= AUTO_START_S) {
            return {
                state:  {...state, startCounter: 0, idleCounter: 0, coastedSinceRunning: false},
                action: TimingAction.launch,
            };
        }
        return {
            state:  {...state, startCounter, idleCounter: 0, coastedSinceRunning: coasted},
            action: TimingAction.none,
        };
    }

    if(equals(status, 'paused')) {
        // A pause the app made picks itself up on the first stroke. No
        // AUTO_START_S confirmation there: the ride is already under way, and
        // the rider stopping for a moment mid-interval shouldn't cost them 3s.
        if(settings.autoStart && state.pausedAutomatically && pedalling) {
            return {
                state:  {...state, idleCounter: 0, startCounter: 0, coastedSinceRunning: false},
                action: TimingAction.autoResume,
            };
        }

        // A pause the rider pressed is theirs until they have both stopped and
        // got going again — the rider's own gesture for carrying on, asked for
        // deliberately enough that the watts still spinning down off the press
        // can't answer for them. Same AUTO_START_S confirmation as a standing
        // start, for the same reason.
        const coasted      = state.coastedSinceRunning || !pedalling;
        const eligible     = settings.autoStart && coasted;
        const startCounter = (eligible && pedalling) ? state.startCounter + 1 : 0;

        if(eligible && startCounter >= AUTO_START_S) {
            return {
                state:  {...state, startCounter: 0, idleCounter: 0, coastedSinceRunning: false},
                action: TimingAction.autoResume,
            };
        }
        return {
            state:  {...state, idleCounter: 0, startCounter, coastedSinceRunning: coasted},
            action: TimingAction.none,
        };
    }

    // Some status the watch does not otherwise know about. Leave the rest flag
    // alone rather than answering for a transition we have not seen.
    return {
        state:  {...state, idleCounter: 0, startCounter: 0},
        action: TimingAction.none,
    };
}

export {
    PEDALLING_WATTS,
    ARM_WINDOW_S,
    AUTO_PAUSE_S,
    AUTO_START_S,
    TimingAction,
    timingDefaults,
    isPedalling,
    onPowerSample,
};
