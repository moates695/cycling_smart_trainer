import { xf, exists, equals } from './functions.js';
import { models } from './models/models.js';
import { Sound } from './sound.js';
import { idb } from './storage/idb.js';
import { ControlMode, } from './ble/enums.js';
import { TimerStatus, } from './activity/enums.js';

// import { trainerMock } from './simulation-scripts.js';

let db = {
    // Data Screen
    power: models.power.default,
    heartRate: models.heartRate.default,
    rrInterval: [],
    cadence: models.cadence.default,
    speed: models.speed.default,
    sources: models.sources.default,
    smo2: models.smo2.default,
    thb: models.thb.default,
    coreBodyTemperature: 0,
    skinTemperature: 0,
    position_lat: 0,
    position_long: 0,

    speedVirtual: models.virtualState.speed,
    altitude: models.virtualState.altitude,
    distance: models.virtualState.distance,
    ascent: models.virtualState.ascent,

    power1s: models.power1s.default,
    power3s: models.power3s.default,
    powerInZone: models.powerInZone.default,

    powerLap: models.powerLap.default,
    heartRateLap: models.heartRateLap.default,
    cadenceLap: models.cadenceLap.default,
    kcal: models.kcal.default,
    powerAvg: models.powerAvg.default,
    cadenceAvg: models.cadenceAvg.default,
    heartRateAvg: models.heartRateAvg.default,

    powerLapCount: models.powerLap.count,
    heartRateLapCount: models.heartRateLap.count,
    cadenceLapCount: models.cadenceLap.count,
    powerAvgCount: models.powerAvg.count,
    cadenceAvgCount: models.cadenceAvg.count,
    heartRateAvgCount: models.heartRateAvg.count,

    heartRateMax: 0,

    // Targets
    powerTarget: models.powerTarget.default,
    workoutIntensity: models.workoutIntensity.default,
    resistanceTarget: models.resistanceTarget.default,
    slopeTarget: models.slopeTarget.default,
    cadenceTarget: models.cadenceTarget.default,

    mode: models.mode.default,
    page: models.page.default,
    lock: false,
    lockDefault: models.lockDefault.default,

    // Profile
    ftp: models.ftp.default,
    weight: models.weight.default,
    theme: models.theme.default,
    dockMode: models.dockMode.default,
    measurement: models.measurement.default,
    volume: models.volume.default,

    // UI options
    powerSmoothing: 0,
    dataTileSwitch: models.dataTileSwitch.default,
    auth: ':login',

    // Workouts
    workouts: [],
    workout: models.workout.default,

    // Activities
    activity: models.activity.default,

    // Recording
    records: [],
    lap: [],
    laps: [],
    events: [],
    lapStartTime: false,

    // Watch
    elapsed: 0,
    lapTime: 0,
    stepTime: 0,
    intervalIndex: 0,
    stepIndex: 0,
    intervalDuration: 0,
    stepDuration: 0,
    watchStatus: TimerStatus.stopped,
    workoutStatus: TimerStatus.stopped,
    // Play pressed, waiting for the rider to start pedalling (see watch-timing.js).
    watchArmed: false,

    // Course
    courseIndex: 0,

    // Request ANT+ Device
    antSearchList: [],
    antDeviceId: {},

    // Services
    services: {strava: false, intervals: false, trainingPeaks: false},

    // Account
    authState: '',
    accountEmail: '',
};



xf.create(db);

// Data Screen
xf.reg(models.heartRate.prop, (heartRate, db) => {
    db.heartRate = heartRate;
    db.heartRateLap = models.heartRateLap.setState(heartRate);
    db.heartRateAvg = models.heartRateAvg.setState(heartRate);
    db.heartRateLapCount = models.heartRateLap.count;
    db.heartRateAvgCount = models.heartRateAvg.count;

    if(heartRate > db.heartRateMax) {
        db.heartRateMax = heartRate;
    }
});

xf.reg('rrInterval', (rrInterval, db) => {
    db.rrInterval = rrInterval;
});

xf.reg(models.power.prop, (power, db) => {
    db.power = power;
});

xf.reg(models.cadence.prop, (cadence, db) => {
    db.cadence = cadence;
    db.cadenceLap = models.cadenceLap.setState(cadence);
    db.cadenceAvg = models.cadenceAvg.setState(cadence);
    db.cadenceLapCount = models.cadenceLap.count;
    db.cadenceAvgCount = models.cadenceAvg.count;
});

xf.reg(models.speed.prop, (speed, db) => {
    db.speed = speed;
});

xf.reg(models.smo2.prop, (smo2, db) => {
    db.smo2 = smo2;
});

xf.reg(models.thb.prop, (thb, db) => {
    db.thb = thb;
});

xf.reg(`coreBodyTemperature`, (coreBodyTemperature, db) => {
    db.coreBodyTemperature = coreBodyTemperature;
});

xf.reg(`skinTemperature`, (skinTemperature, db) => {
    db.skinTemperature = skinTemperature;
});

xf.reg(models.sources.prop, (sources, db) => {
    db.sources = models.sources.set(db.sources, sources);
    models.sources.backup(db.sources);
    console.log(db.sources);
});

xf.reg(models.dockMode.prop, (value, db) => {
    db.dockMode = models.dockMode.set(value);
    models.dockMode.backup(db.dockMode);
});

xf.reg('power1s', (power, db) => {
    db.power1s = power;

    db.powerLap = models.powerLap.setState(power);
    db.powerAvg = models.powerAvg.setState(power);
    db.kcal = models.kcal.setState(power);

    db.powerLapCount = models.powerLap.count;
    db.powerAvgCount = models.powerAvg.count;
});

xf.reg('power3s', (power, db) => {
    db.power3s = power;
});

xf.reg('powerInZone', (powerInZone, db) => {
    db.powerInZone = powerInZone;
});

xf.reg('speedVirtual', (speedVirtual, db) => {
    db.speedVirtual = speedVirtual;
});

xf.reg('altitude', (altitude, db) => {
    db.altitude = altitude;
});

xf.reg('ascent', (ascent, db) => {
    db.ascent = ascent;
});

xf.reg('distance', (distance, db) => {
    if(equals(db.watchStatus, 'started')) {
        db.distance = distance;
    };
});

// Pages
xf.reg('ui:page-set', (page, db) => {
    db.page = models.page.set(page);
});

// Modes
xf.reg('ui:mode-set', (mode, db) => {
    if(db.lock) return;

    db.mode = models.mode.set(mode);

    if(equals(mode, ControlMode.erg)) {
        xf.dispatch(`ui:power-target-set`, db.powerTarget);
    }
    if(equals(mode, ControlMode.resistance)) {
        xf.dispatch(`ui:resistance-target-set`, db.resistanceTarget);
    }
    if(equals(mode, ControlMode.sim)) {
        xf.dispatch(`ui:slope-target-set`, db.slopeTarget);
    }
});

xf.reg('ui:lock-set', (_, db) => {
    db.lock = !db.lock;
});

xf.reg('ui:lock-toggle', (_, db) => {
    db.lock = !db.lock;
});

// WATTS Settings: persisted "Lock controls by default" option. Seeds db.lock
// on startup (see app:start) and is toggled from the Settings page.
xf.reg('ui:lock-default-switch', (_, db) => {
    db.lockDefault = !db.lockDefault;
    models.lockDefault.backup(db.lockDefault);
});


// UI options
xf.reg('ui:data-tile-switch-set', (index, db) => {
    db.dataTileSwitch = index;
    models.dataTileSwitch.backup(db.dataTileSwitch);
});

// Targets
xf.reg('ui:power-target-set', (powerTarget, db) => {
    db.powerTarget = models.powerTarget.set(powerTarget);
});
xf.reg('ui:power-target-inc', (_, db) => {
    db.powerTarget = models.powerTarget.inc(db.powerTarget);
});
xf.reg(`ui:power-target-dec`, (_, db) => {
    db.powerTarget = models.powerTarget.dec(db.powerTarget);
});
// Workout intensity (%): scales the workout's power targets. On change,
// re-derive the current step's target so the trainer reacts immediately
// rather than waiting for the next step.
function reapplyPowerTarget(db) {
    const step  = db.workout?.intervals?.[db.intervalIndex]?.steps?.[db.stepIndex];
    const power = step?.power;
    if(exists(power) && equals(db.workoutStatus, 'started')) {
        const absolute = models.ftp.toAbsolute(power, db.ftp);
        xf.dispatch('ui:power-target-set',
                    models.workoutIntensity.apply(db.workoutIntensity, absolute));
    }
}
xf.reg('ui:workout-intensity-set', (intensity, db) => {
    db.workoutIntensity = models.workoutIntensity.set(intensity);
    reapplyPowerTarget(db);
});
xf.reg('ui:workout-intensity-inc', (_, db) => {
    db.workoutIntensity = models.workoutIntensity.inc(db.workoutIntensity);
    reapplyPowerTarget(db);
});
xf.reg('ui:workout-intensity-dec', (_, db) => {
    db.workoutIntensity = models.workoutIntensity.dec(db.workoutIntensity);
    reapplyPowerTarget(db);
});
xf.reg('ui:cadence-target-set', (cadenceTarget, db) => {
    db.cadenceTarget = models.cadenceTarget.set(cadenceTarget);
});

xf.reg('ui:resistance-target-set', (resistanceTarget, db) => {
    db.resistanceTarget = models.resistanceTarget.set(resistanceTarget);
});
xf.reg('ui:resistance-target-inc', (_, db) => {
    db.resistanceTarget = models.resistanceTarget.inc(db.resistanceTarget);
});
xf.reg(`ui:resistance-target-dec`, (_, db) => {
    db.resistanceTarget = models.resistanceTarget.dec(db.resistanceTarget);
});

xf.reg('ui:slope-target-set', (slopeTarget, db) => {
    db.slopeTarget = models.slopeTarget.set(slopeTarget);
});
xf.reg('ui:slope-target-inc', (_, db) => {
    db.slopeTarget = models.slopeTarget.inc(db.slopeTarget);
});
xf.reg(`ui:slope-target-dec`, (_, db) => {
    db.slopeTarget = models.slopeTarget.dec(db.slopeTarget);
});

// Profile
xf.reg('ui:ftp-set', (ftp, db) => {
    db.ftp = models.ftp.set(ftp);
    models.ftp.backup(db.ftp);
});
xf.reg('ui:weight-set', (weight, db) => {
    db.weight = models.weight.set(weight);
    models.weight.backup(db.weight);
});
xf.reg('ui:theme-switch', (_, db) => {
    db.theme = models.theme.switch(db.theme);
    models.theme.backup(db.theme);
});

xf.reg('ui:dock-mode-switch', (_, db) => {
    db.theme = models.dockMode.switch(db.dockMode);
    models.dockMode.backup(db.dockMode);
});
xf.reg('ui:measurement-switch', (_, db) => {
    db.measurement = models.measurement.switch(db.measurement);
    models.measurement.backup(db.measurement);
});

xf.reg('ui:volume-mute', (_, db) => {
    db.volume = models.volume.mute();
    models.volume.backup(db.volume);
});
xf.reg('ui:volume-down', (_, db) => {
    db.volume = models.volume.dec(db.volume);
    models.volume.backup(db.volume);
});
xf.reg(`ui:volume-up`, (_, db) => {
    db.volume = models.volume.inc(db.volume);
    models.volume.backup(db.volume);
});
// WATTS Settings: the sound slider sets an exact volume rather than stepping.
xf.reg('ui:volume-set', (volume, db) => {
    db.volume = models.volume.set(volume);
    models.volume.backup(db.volume);
});

// Workouts
xf.reg('workout', (workout, db) => {
    db.workout = models.workout.set(workout);
});
xf.reg('ui:workout:select', (id, db) => {
    db.workout = models.workouts.get(db.workouts, id);
});
xf.reg('ui:planned:select', (id, db) => {
    db.workout = models.planned.get(id);
});
xf.reg('ui:workout:remove', (id, db) => {
    db.workouts = models.workouts.remove(db.workouts, id);
});
xf.reg('ui:workout:upload', async function(files, db) {
    for(let file of Object.values(files)) {
        const { result, name } = await models.workout.readFromFile(file);
        const workout = models.workout.parse(result, name);
        models.workouts.add(db.workouts, workout);
        xf.dispatch('db:workouts', db);
    }

});
xf.reg('ui:workout:create', (zwo, db) => {
    const workout = models.workout.parse(zwo);
    models.workouts.add(db.workouts, workout);
    xf.dispatch('db:workouts', db);
});
// Save from the designer. Carries an explicit id so the first save creates a
// library entry and later saves of the same editing session update it in place
// (rather than piling up duplicates).
xf.reg('ui:workout:save', (data, db) => {
    const { zwo, id } = data ?? {};
    const workout = models.workout.parse(zwo);
    workout.id = id;
    const i = db.workouts.findIndex((w) => equals(w.id, id));
    if(i >= 0) {
        db.workouts[i] = workout;
        models.workouts.save(workout);
    } else {
        models.workouts.add(db.workouts, workout);
    }
    xf.dispatch('db:workouts', db);
});
xf.reg('watch:stopped', (_, db) => {
    try {
        models.activity.createFromCurrent(db);
        xf.dispatch('activity:save:success');
    } catch (err) {
        console.error(`Error on activity save: `, err);
        xf.dispatch('activity:save:fail');
    }

});
xf.reg('activity:save:success', (e, db) => {
    models.session.reset(db);
});
xf.sub('ui:activity:upload:by:id', (id) => {
    models.activity.upload(id);
});
// download the current activity as a .fit file
xf.reg('ui:activity:save', (_, db) => {
    xf.dispatch(`ui:page-set`, 'workouts');
});

xf.reg('course:index', (index, db) => {
    db.courseIndex = index;
});

xf.reg('course:position', (position, db) => {
    db.position_lat = position.position_lat;
    db.position_long = position.position_long;
});

// Wake Lock
xf.reg('lock:beforeunload', (e, db) => {
    // backup session
    models.session.backup(db);
});
xf.reg('lock:release', (e, db) => {
    // backup session
    models.session.backup(db);
});

// Request ANT+ Device
xf.reg('ui:ant:request:selected', (x, db) => {
    db.antDeviceId = db.antSearchList.filter(d => {
        return d.deviceNumber === parseInt(x);
    })[0];
});
function includesDevice(devices, id) {
    return devices.filter(d => d.deviceNumber === id.deviceNumber).length > 0;
}
xf.reg(`ant:search:device-found`, (x, db) => {
    if(includesDevice(db.antSearchList, x)) return;
    db.antSearchList.push(x);
    db.antSearchList = db.antSearchList;
});
xf.reg(`ant:search:stopped`, (x, db) => {
    db.antSearchList = [];
});

xf.reg('auth', (x, db) => {
    // TODO: remove?
});

xf.reg('services', (x, db) => {
    db.services = Object.assign(db.services, x);
});

// Mirror the auth flow state into the store so views can react to sign-in
// (':password:profile' is the signed-in state, see models/auth.js).
xf.reg('action:auth', (state, db) => {
    db.authState = state;
});

// The API doesn't return the account identity on session restore, so the
// email is captured at login and persisted locally.
xf.reg('account:email', (email, db) => {
    db.accountEmail = email ?? '';
    window.localStorage.setItem('accountEmail', db.accountEmail);
});


//
xf.reg('app:start', async function(_, db) {

    db.ftp = models.ftp.set(models.ftp.restore());
    db.weight = models.weight.set(models.weight.restore());
    db.theme = models.theme.set(models.theme.restore());
    db.measurement = models.measurement.set(models.measurement.restore());
    db.volume = models.volume.set(models.volume.restore());
    // seed the ride-controls lock from the persisted "lock by default" option
    db.lockDefault = models.lockDefault.set(models.lockDefault.restore());
    db.lock = db.lockDefault;
    db.dataTileSwitch = models.dataTileSwitch.set(models.dataTileSwitch.restore()),

    db.sources = models.sources.set(models.sources.restore());
    db.accountEmail = window.localStorage.getItem('accountEmail') ?? '';

    // IndexedDB Schema Version 3
    await idb.start('store', 3, ['session', 'workouts', 'activity']);
    db.workouts = await models.workouts.restore();
    db.activity = await models.activity.restore();
    db.workout = models.workout.restore(db);
    models.planned.restore();

    await models.session.restore(db);
    xf.dispatch('workout:restore');
    xf.dispatch('activity:restore');

    models.kcal.restore(db);
    models.powerLap.restore(db);
    models.powerAvg.restore(db);
    models.cadenceLap.restore(db);
    models.cadenceAvg.restore(db);
    models.heartRateLap.restore(db);
    models.heartRateAvg.restore(db);

    const sound = Sound({volume: db.volume});
    sound.start();

    models.api.start();
    // TODO: remove
    // xf.dispatch(`ui:page-set`, 'workouts');

    // TRAINER MOCK
    // trainerMock.init();
});

function start () {
    console.log('start db');
    xf.dispatch('db:start');

    // UI test
    // setInterval(function() {
    //     xf.dispatch('watch:elapsed', 1);
    //     xf.dispatch('power', 180);
    //     xf.dispatch('cadence', 80);
    //     xf.dispatch('heartRate', 140 + (Math.random() * 10));
    //     xf.dispatch('smo2', 71.17); // + (Math.random() * 10));
    //     xf.dispatch('thb', 11.14); // + (Math.random() / 2));
    //     xf.dispatch('coreBodyTemperature', 38.12);
    //     xf.dispatch('skinTemperature', 38.47);
    // }, 1000);
    // end UI test
}

start();

export { db };

