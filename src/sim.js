//
// Device simulator for local development — a fake smart trainer + heart rate
// strap, so a workout can be ridden end to end without hardware.
//
// It plugs in at the same seam the BLE layer uses: the `xf.dispatch('power', n)`
// calls in ble/reactive-connectable.js. Nothing below that seam (Web Bluetooth,
// GATT, characteristic parsing) is involved, but everything above it runs exactly
// as it does with real hardware — db reducers, models, watch, workout stepping,
// graphs, FIT recording, activity upload.
//
// Enable:
//     npm start  ->  http://localhost:1234/?sim=1
//     &ride=1        start pedalling immediately instead of coasting
//     &speed=5       run the workout clock at 5x real time
//     &devices=controllable,heartRateMonitor,smo2,coreTemp
//
// or persist it across reloads with:
//     localStorage.setItem('sim', 'true');
//
// Console API (window.sim):
//     sim.ride()            start pedalling
//     sim.coast()           stop pedalling (power/cadence -> 0, tests auto-pause)
//                           Coasting/riding is only ever switched by you — the SIM
//                           badge, ?ride=1, or these calls. Starting, pausing or
//                           stopping the workout leaves the rider as they were.
//     sim.power(240)        set free-ride power; ignored while ERG holds a target
//     sim.hr(175)           jump heart rate, then it drifts back toward the
//                           value implied by current power
//     sim.cadence(95)       set target cadence
//     sim.speed(5)          fast forward: workout clock at 5x real time (1..20).
//                           Devices keep streaming at their real rate, so the
//                           faster it runs the coarser the recorded data is
//     sim.dropout(5000)     disconnect for 5s, then reconnect
//     sim.disconnect()      / sim.connect()
//     sim.state()           current sim state
//
// The pure maths at the top is DOM- and store-free so it can be unit tested
// (test/sim.test.js), following the designer-model.js pattern.
//

import { xf, exists, equals, clamp } from './functions.js';
import { ControlMode } from './ble/enums.js';

const defaults = {
    // notify rate, matches a real FTMS indoor bike data stream
    hz:             4,
    // heart rate straps notify around 1Hz
    hrHz:           1,
    freeRidePower:  160,
    cadence:        85,
    hrRest:         58,
    hrMax:          185,
    ftp:            250,
    // ms of fake pairing, so the switches show their loading state
    connectDelay:   400,
    // seconds for a first order lag to cover ~63% of the gap
    tauPower:       2,
    tauCadence:     3,
    tauHrUp:        22,
    tauHrDown:      35,
    noisePower:     0.025,
    noiseCadence:   0.02,
    noiseHr:        0.01,
    // fast forward multiplier, and the values the badge cycles through
    speed:          1,
};

const SPEEDS = [1, 2, 5, 10];
const SPEED_MAX = 20;

// -------------------------------------------------------------------------
// pure
// -------------------------------------------------------------------------

// First order lag. Moves prev toward target over dt seconds, tau being the
// time constant. Keeps the sim from snapping to a new value the instant a
// workout step changes, the way a real trainer and body do not.
function approach(prev, target, dt, tau) {
    if(!(tau > 0)) return target;
    const alpha = 1 - Math.exp(-dt / tau);
    return prev + ((target - prev) * alpha);
}

// Symmetric multiplicative noise, fraction 0.02 -> +/-2%.
function jitter(value, fraction, random = Math.random) {
    return value * (1 + ((random() - 0.5) * 2 * fraction));
}

// Steady state heart rate the rider would settle at for a given power.
// Linear in intensity, which is wrong physiologically but close enough to
// exercise the UI, zones and averages.
function hrForPower(power, ftp, args = {}) {
    const rest = args.rest ?? defaults.hrRest;
    const max  = args.max  ?? defaults.hrMax;
    const useFtp = ftp > 0 ? ftp : defaults.ftp;

    if(power <= 0) return rest + 12;

    const intensity = clamp(0, 1.5, power / useFtp);
    return clamp(rest, max, rest + ((max - rest) * (0.42 + (0.46 * intensity))));
}

// What the rider/trainer pair is asked to produce, per control mode.
function riderPower(args = {}) {
    const mode      = args.mode ?? ControlMode.erg;
    const freeRide  = args.freeRide ?? defaults.freeRidePower;

    if(equals(mode, ControlMode.erg)) {
        // In ERG the trainer holds the target. No target set yet -> free ride.
        return (args.powerTarget > 0) ? args.powerTarget : freeRide;
    }
    if(equals(mode, ControlMode.sim)) {
        // Rider pushes harder uphill, eases off downhill.
        return clamp(0, 2000, freeRide * (1 + ((args.slopeTarget ?? 0) / 20)));
    }
    if(equals(mode, ControlMode.resistance)) {
        // resistanceTarget is a percentage, 50% reads as "about free ride".
        return clamp(0, 2000, freeRide * ((args.resistanceTarget ?? 50) / 50));
    }
    return freeRide;
}

// Rough power -> road speed, km/h. Only used for the raw trainer speed field;
// db.speedVirtual is derived properly by models.js from physics.js.
function speedForPower(power) {
    if(power <= 0) return 0;
    return clamp(0, 120, 4.2 * Math.cbrt(power));
}

function kmhToMps(kmh) {
    return kmh / 3.6;
}

// -------------------------------------------------------------------------
// enablement
// -------------------------------------------------------------------------

function readFlags() {
    if(typeof window === 'undefined') return {};

    let params = {};
    try {
        params = Object.fromEntries(new URLSearchParams(window.location.search));
    } catch(e) {
        params = {};
    }

    let stored = false;
    try {
        stored = equals(window.localStorage.getItem('sim'), 'true');
    } catch(e) {
        stored = false;
    }

    const on = stored || equals(params.sim, '1') || equals(params.sim, 'true');

    return {
        on,
        ride: equals(params.ride, '1') || equals(params.ride, 'true'),
        speed: parseFloat(params.speed) > 0 ? parseFloat(params.speed) : 1,
        devices: exists(params.devices) ?
            params.devices.split(',').map((x) => x.trim()) :
            ['controllable', 'heartRateMonitor'],
    };
}

function simEnabled() {
    return readFlags().on ?? false;
}

// -------------------------------------------------------------------------
// the sim device
// -------------------------------------------------------------------------

function Sim(args = {}) {
    const config = Object.assign({}, defaults, args);
    const deviceTypes = args.devices ?? ['controllable', 'heartRateMonitor'];

    // inputs, mirrored from the store
    let mode             = ControlMode.erg;
    let powerTarget      = 0;
    let slopeTarget      = 0;
    let resistanceTarget = 0;
    let cadenceTarget    = 0;
    let ftp              = config.ftp;

    // sim state — connection is per device, so the switches behave like the
    // real ones (dropping the HRM must not take the trainer with it)
    const connected   = {};
    // which of the two simulated units of each device type is in use
    const units       = {};
    let riding        = false;
    let power         = 0;
    let cadence       = 0;
    let heartRate     = config.hrRest;
    let freeRide      = config.freeRidePower;
    let timer         = undefined;
    let tick          = 0;
    let dropoutTimer  = undefined;
    let speed         = config.speed;

    const dt      = 1 / config.hz;
    const hrEvery = Math.max(1, Math.round(config.hz / config.hrHz));

    // a device is a data source only while it is simulated and connected
    function has(deviceType) {
        return deviceTypes.includes(deviceType) && (connected[deviceType] ?? false);
    }

    function anyConnected() {
        return deviceTypes.some((deviceType) => connected[deviceType]);
    }

    function id(deviceType) {
        return `ble:${deviceType}`;
    }

    function subs() {
        xf.sub('db:mode',             (x) => mode             = x);
        xf.sub('db:powerTarget',      (x) => powerTarget      = x);
        xf.sub('db:slopeTarget',      (x) => slopeTarget      = x);
        xf.sub('db:resistanceTarget', (x) => resistanceTarget = x);
        xf.sub('db:cadenceTarget',    (x) => cadenceTarget    = x);
        xf.sub('db:ftp',              (x) => ftp              = x);

        // the connection switches in index.html toggle the sim devices
        deviceTypes.forEach((deviceType) => {
            xf.sub(`ui:${id(deviceType)}:switch`, () => {
                connected[deviceType] ? disconnect(deviceType) : connect(deviceType);
            });

            // the topbar chips search for another device rather than toggling:
            // connect when off, and when already on swap in the other simulated
            // unit, which is what picking a different device in the browser's
            // chooser does
            xf.sub(`ui:${id(deviceType)}:replace`, () => {
                if(connected[deviceType]) {
                    units[deviceType] = ((units[deviceType] ?? 0) + 1) % 2;
                    disconnect(deviceType);
                }
                connect(deviceType);
            });
        });

        // pedalling is ours alone: only the badge, ?ride=1 and window.sim switch
        // between coasting and riding. Starting or pausing the workout doesn't.
    }

    // deviceType omitted -> every simulated device
    function connect(deviceType) {
        const targets = exists(deviceType) ? [deviceType] : deviceTypes;

        targets.forEach((target) => {
            if(connected[target]) return;
            xf.dispatch(`${id(target)}:connecting`);
        });

        setTimeout(function() {
            targets.forEach((target) => {
                if(connected[target]) return;
                connected[target] = true;

                xf.dispatch(`${id(target)}:connected`);
                xf.dispatch(`${id(target)}:name`, nameFor(target));
                xf.dispatch(`${id(target)}:batteryLevel`, 88);
            });

            start();
            renderBadge();
        }, config.connectDelay);
    }

    function disconnect(deviceType) {
        const targets = exists(deviceType) ? [deviceType] : deviceTypes;

        targets.forEach((target) => {
            connected[target] = false;
            xf.dispatch(`${id(target)}:disconnected`);
            xf.dispatch(`${id(target)}:name`, '--');
        });

        // mirror the zeroing reactive-connectable.js does on disconnect
        if(targets.includes('controllable') || targets.includes('powerMeter')) {
            xf.dispatch('power', 0);
            xf.dispatch('cadence', 0);
            xf.dispatch('speed', 0);
        }
        if(targets.includes('heartRateMonitor')) xf.dispatch('heartRate', 0);
        if(targets.includes('smo2')) {
            xf.dispatch('smo2', 0);
            xf.dispatch('thb', 0);
        }
        if(targets.includes('coreTemp')) {
            xf.dispatch('coreBodyTemperature', 0);
            xf.dispatch('skinTemperature', 0);
        }

        if(!anyConnected()) stop();
        renderBadge();
    }

    function dropout(ms = 5000, deviceType) {
        clearTimeout(dropoutTimer);
        disconnect(deviceType);
        dropoutTimer = setTimeout(() => connect(deviceType), ms);
    }

    // Each device type has two units, so a chip set to replace has something
    // other than the current device to land on.
    function nameFor(deviceType) {
        const names = {
            controllable:     ['Sim Trainer 0001', 'Sim Trainer 0011'],
            heartRateMonitor: ['Sim HRM 0002',     'Sim HRM 0022'],
            powerMeter:       ['Sim Power 0003',   'Sim Power 0033'],
            smo2:             ['Sim Moxy 0004',    'Sim Moxy 0044'],
            coreTemp:         ['Sim Core 0005',    'Sim Core 0055'],
        };
        const unit = units[deviceType] ?? 0;
        return names[deviceType]?.[unit] ?? `Sim ${deviceType} ${unit + 1}`;
    }

    function start() {
        if(exists(timer)) return;
        timer = setInterval(onTick, 1000 / config.hz);
    }

    function stop() {
        clearInterval(timer);
        timer = undefined;
    }

    // Fast forward. The watch owns the workout clock, so this only asks it to
    // tick faster (watch.js -> timer.js); the sim itself keeps producing power,
    // cadence and heart rate at its real notify rate, exactly as a trainer
    // would. Above ~5x a workout second gets fewer than one fresh sample, so
    // the graph traces and the recorded activity coarsen accordingly.
    function setSpeed(value) {
        speed = clamp(1, SPEED_MAX, value ?? 1);
        xf.dispatch('sim:speed', speed);
        updateBadge();
        return speed;
    }

    function nextSpeed() {
        const i = SPEEDS.indexOf(speed);
        return setSpeed(SPEEDS[(i + 1) % SPEEDS.length] ?? 1);
    }

    function ride() {
        riding = true;
        renderBadge();
    }

    function coast() {
        riding = false;
        renderBadge();
    }

    function onTick() {
        tick += 1;

        const targetPower   = riding ? riderPower({
            mode, powerTarget, slopeTarget, resistanceTarget, freeRide,
        }) : 0;
        const targetCadence = riding ?
              ((cadenceTarget > 0) ? cadenceTarget : config.cadence) : 0;

        power = approach(power, targetPower, dt, config.tauPower);
        cadence = approach(cadence, targetCadence, dt, config.tauCadence);

        const powerOut   = Math.round(clamp(0, 2500,
            (power < 1) ? 0 : jitter(power, config.noisePower)));
        const cadenceOut = Math.round(clamp(0, 200,
            (cadence < 1) ? 0 : jitter(cadence, config.noiseCadence)));

        if(has('controllable') || has('powerMeter')) {
            xf.dispatch('power', powerOut);
            xf.dispatch('cadence', cadenceOut);
            xf.dispatch('speed', kmhToMps(speedForPower(powerOut)));
        }

        // heart rate lags a long way behind power, and falls slower than it rises
        const hrTarget = hrForPower(powerOut, ftp,
            {rest: config.hrRest, max: config.hrMax});
        const tauHr = (hrTarget > heartRate) ? config.tauHrUp : config.tauHrDown;
        heartRate = approach(heartRate, hrTarget, dt, tauHr);

        if(equals(tick % hrEvery, 0)) {
            if(has('heartRateMonitor')) {
                xf.dispatch('heartRate', Math.round(
                    jitter(heartRate, config.noiseHr)));
            }
            if(has('smo2')) {
                // saturation drops as intensity rises
                const intensity = clamp(0, 1.5, powerOut / (ftp > 0 ? ftp : config.ftp));
                xf.dispatch('smo2', Math.round((72 - (18 * intensity)) * 100) / 100);
                xf.dispatch('thb', Math.round(jitter(11.1, 0.01) * 100) / 100);
            }
            if(has('coreTemp')) {
                xf.dispatch('coreBodyTemperature', Math.round((37 + (heartRate / 200)) * 100) / 100);
                xf.dispatch('skinTemperature', Math.round((33 + (heartRate / 150)) * 100) / 100);
            }
        }

        updateBadge();
    }

    // -------------------------------------------------------------------
    // on screen badge, so sim mode is never mistaken for real data
    // -------------------------------------------------------------------

    let $badge  = undefined;
    let $status = undefined;
    let $speed  = undefined;

    function renderBadge() {
        if(typeof document === 'undefined') return;

        if(!exists($badge)) {
            $badge = document.createElement('div');
            $badge.id = 'sim-badge';
            $badge.setAttribute('style', [
                'position:fixed', 'right:12px', 'bottom:12px', 'z-index:9999',
                'display:flex', 'align-items:center', 'gap:8px',
                'padding:6px 10px', 'border-radius:6px',
                'font:600 11px/1.2 monospace', 'letter-spacing:0.08em',
                'color:#fff', 'background:rgba(200,60,60,0.92)',
                'user-select:none',
            ].join(';'));

            $status = document.createElement('span');
            $status.title = 'Simulated devices. Click to toggle pedalling.';
            $status.setAttribute('style', 'cursor:pointer');
            $status.addEventListener('pointerup', () => riding ? coast() : ride());

            $speed = document.createElement('span');
            $speed.title = `Workout clock speed. Click to cycle ${SPEEDS.join('x, ')}x.`;
            $speed.setAttribute('style', [
                'cursor:pointer', 'padding:2px 5px', 'border-radius:4px',
                'background:rgba(0,0,0,0.28)',
            ].join(';'));
            $speed.addEventListener('pointerup', () => nextSpeed());

            $badge.appendChild($status);
            $badge.appendChild($speed);
            document.body.appendChild($badge);
        }

        updateBadge();
    }

    function updateBadge() {
        if(!exists($status)) return;
        const status = !anyConnected() ? 'OFFLINE' : (riding ? 'RIDING' : 'COASTING');
        $status.textContent = `SIM ${status} ${Math.round(power)}W ${Math.round(heartRate)}bpm`;
        $speed.textContent = `▶ ${speed}x`;
    }

    function init() {
        subs();
        connect();
        if(args.ride) ride();
        // sync the workout clock with ?speed=
        setSpeed(speed);
        return api;
    }

    const api = {
        init,
        connect,
        disconnect,
        dropout,
        ride,
        coast,
        speed: setSpeed,
        power: (value) => { freeRide = value; power = value; },
        hr:    (value) => { heartRate = value; },
        cadence: (value) => { cadence = value; },
        state: () => ({
            connected: Object.assign({}, connected),
            riding, speed, mode, powerTarget, slopeTarget, resistanceTarget,
            ftp, freeRide,
            power: Math.round(power),
            cadence: Math.round(cadence),
            heartRate: Math.round(heartRate),
        }),
    };

    return api;
}

// -------------------------------------------------------------------------
// boot
// -------------------------------------------------------------------------

const flags = readFlags();

if(flags.on) {
    console.warn('|--------------------------|');
    console.warn('| Device SIM mode is ON!   |');
    console.warn('| window.sim for controls  |');
    console.warn('|--------------------------|');

    const sim = Sim({devices: flags.devices, ride: flags.ride, speed: flags.speed});
    window.sim = sim;

    xf.sub('app:start', () => sim.init());
}

export {
    Sim,
    simEnabled,
    // pure, for tests
    approach,
    jitter,
    hrForPower,
    riderPower,
    speedForPower,
};
