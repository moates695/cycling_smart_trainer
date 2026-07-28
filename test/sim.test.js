/**
 * @jest-environment jsdom
 */

//
// Covers the pure maths behind the local device simulator (src/sim.js). The
// simulator only matters as a dev tool, but these guard the properties that
// make it useful: values ramp instead of snapping, ERG follows the target,
// slope/resistance modes respond, and heart rate tracks intensity.
//

import {
    Sim,
    approach,
    jitter,
    hrForPower,
    riderPower,
    speedForPower,
} from '../src/sim.js';

import { xf } from '../src/functions.js';
import { ControlMode } from '../src/ble/enums.js';

describe('approach', () => {
    test('moves toward the target without overshooting', () => {
        const next = approach(100, 200, 0.25, 2);

        expect(next).toBeGreaterThan(100);
        expect(next).toBeLessThan(200);
    });

    test('covers about 63% of the gap in one time constant', () => {
        const next = approach(0, 100, 2, 2);

        expect(next).toBeCloseTo(63.2, 0);
    });

    test('converges on the target over many steps', () => {
        let value = 0;
        for(let i = 0; i < 200; i++) {
            value = approach(value, 250, 0.25, 2);
        }

        expect(Math.round(value)).toBe(250);
    });

    test('falls back to the target when tau is zero or missing', () => {
        expect(approach(100, 200, 0.25, 0)).toBe(200);
        expect(approach(100, 200, 0.25, undefined)).toBe(200);
    });

    test('decays toward a lower target', () => {
        expect(approach(200, 0, 0.25, 2)).toBeLessThan(200);
        expect(approach(200, 0, 0.25, 2)).toBeGreaterThan(0);
    });
});

describe('jitter', () => {
    test('stays inside the given fraction', () => {
        expect(jitter(200, 0.025, () => 0)).toBeCloseTo(195);
        expect(jitter(200, 0.025, () => 1)).toBeCloseTo(205);
        expect(jitter(200, 0.025, () => 0.5)).toBeCloseTo(200);
    });

    test('random values never leave the band', () => {
        for(let i = 0; i < 100; i++) {
            const value = jitter(200, 0.025);
            expect(value).toBeGreaterThanOrEqual(195);
            expect(value).toBeLessThanOrEqual(205);
        }
    });
});

describe('riderPower', () => {
    test('erg follows the power target', () => {
        expect(riderPower({
            mode: ControlMode.erg, powerTarget: 240, freeRide: 160,
        })).toBe(240);
    });

    test('erg falls back to free ride with no target set', () => {
        expect(riderPower({
            mode: ControlMode.erg, powerTarget: 0, freeRide: 160,
        })).toBe(160);
    });

    test('sim mode rises with slope and falls on descents', () => {
        const flat = riderPower({mode: ControlMode.sim, slopeTarget: 0, freeRide: 160});
        const up   = riderPower({mode: ControlMode.sim, slopeTarget: 6, freeRide: 160});
        const down = riderPower({mode: ControlMode.sim, slopeTarget: -4, freeRide: 160});

        expect(flat).toBe(160);
        expect(up).toBeGreaterThan(flat);
        expect(down).toBeLessThan(flat);
        expect(down).toBeGreaterThanOrEqual(0);
    });

    test('resistance mode scales with the resistance target', () => {
        expect(riderPower({
            mode: ControlMode.resistance, resistanceTarget: 50, freeRide: 160,
        })).toBe(160);

        expect(riderPower({
            mode: ControlMode.resistance, resistanceTarget: 100, freeRide: 160,
        })).toBe(320);
    });

    test('never goes negative', () => {
        expect(riderPower({
            mode: ControlMode.sim, slopeTarget: -100, freeRide: 160,
        })).toBe(0);
    });
});

describe('hrForPower', () => {
    test('rises with power', () => {
        const easy = hrForPower(120, 250);
        const hard = hrForPower(300, 250);

        expect(hard).toBeGreaterThan(easy);
    });

    test('stays within rest and max', () => {
        for(const power of [0, 50, 150, 250, 400, 900]) {
            const hr = hrForPower(power, 250);
            expect(hr).toBeGreaterThanOrEqual(58);
            expect(hr).toBeLessThanOrEqual(185);
        }
    });

    test('drops close to resting when not pedalling', () => {
        expect(hrForPower(0, 250)).toBeLessThan(hrForPower(100, 250));
    });

    test('the same power is easier at a higher ftp', () => {
        expect(hrForPower(250, 400)).toBeLessThan(hrForPower(250, 200));
    });

    test('tolerates an unset ftp', () => {
        expect(Number.isFinite(hrForPower(200, 0))).toBe(true);
    });
});

describe('speedForPower', () => {
    test('is zero when not pedalling', () => {
        expect(speedForPower(0)).toBe(0);
    });

    test('rises with power but with diminishing returns', () => {
        const low  = speedForPower(100);
        const mid  = speedForPower(200);
        const high = speedForPower(400);

        expect(mid).toBeGreaterThan(low);
        expect(high).toBeGreaterThan(mid);
        expect(high - mid).toBeLessThan((mid - low) * 2);
    });

    test('gives a plausible speed at endurance power', () => {
        const kmh = speedForPower(200);

        expect(kmh).toBeGreaterThan(15);
        expect(kmh).toBeLessThan(35);
    });
});

//
// Wiring, over the real xf bus. These are what actually break if an event name
// drifts, so they matter more than the maths above: the sim has to speak the
// same events ble/reactive-connectable.js does or the app sees nothing.
//
describe('Sim device', () => {
    let sim;
    const seen = {power: [], cadence: [], speed: [], heartRate: []};
    const connections = [];
    const names = [];

    function tick(ms) {
        jest.advanceTimersByTime(ms);
    }

    function last(xs) {
        return xs[xs.length - 1];
    }

    beforeAll(() => {
        jest.useFakeTimers();

        xf.sub('power',     (x) => seen.power.push(x));
        xf.sub('cadence',   (x) => seen.cadence.push(x));
        xf.sub('speed',     (x) => seen.speed.push(x));
        xf.sub('heartRate', (x) => seen.heartRate.push(x));

        ['controllable', 'heartRateMonitor'].forEach((deviceType) => {
            xf.sub(`ble:${deviceType}:connected`,
                   () => connections.push(`${deviceType}:connected`));
            xf.sub(`ble:${deviceType}:disconnected`,
                   () => connections.push(`${deviceType}:disconnected`));
            xf.sub(`ble:${deviceType}:name`, (x) => names.push(x));
        });

        sim = Sim({devices: ['controllable', 'heartRateMonitor']});
        sim.init();
        tick(1000);
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    test('announces both devices as connected, with names', () => {
        expect(connections).toContain('controllable:connected');
        expect(connections).toContain('heartRateMonitor:connected');
        expect(names).toContain('Sim Trainer 0001');
        expect(names).toContain('Sim HRM 0002');
    });

    test('coasts on connect, so the watch does not auto start', () => {
        tick(2000);

        expect(sim.state().riding).toBe(false);
        expect(last(seen.power)).toBe(0);
        expect(last(seen.cadence)).toBe(0);
    });

    test('streams power, cadence and speed once riding', () => {
        sim.ride();
        tick(10000);

        expect(seen.power.length).toBeGreaterThan(30);
        expect(last(seen.power)).toBeGreaterThan(0);
        expect(last(seen.cadence)).toBeGreaterThan(60);
        expect(last(seen.speed)).toBeGreaterThan(0);
    });

    test('speed is dispatched in m/s, as the ble layer does', () => {
        // ~160W free ride is roughly 23km/h, so well under 20 m/s
        expect(last(seen.speed)).toBeLessThan(20);
    });

    test('erg ramps to a new power target instead of snapping', () => {
        xf.dispatch('db:powerTarget', {powerTarget: 300});
        tick(250);

        const first = last(seen.power);
        expect(first).toBeLessThan(300);

        tick(15000);
        expect(last(seen.power)).toBeGreaterThan(280);
        expect(last(seen.power)).toBeLessThan(320);
    });

    test('heart rate lags power rather than tracking it instantly', () => {
        // settle at the 300W target set above
        tick(300000);
        const hot = last(seen.heartRate);
        expect(hot).toBeGreaterThan(160);

        xf.dispatch('db:powerTarget', {powerTarget: 120});
        tick(2000);

        // 2s after easing off, heart rate has barely moved
        expect(Math.abs(last(seen.heartRate) - hot)).toBeLessThan(12);

        // given long enough it comes down to the easier intensity
        tick(300000);
        expect(last(seen.heartRate)).toBeLessThan(hot - 20);
    });

    test('coasting drops power and cadence to zero', () => {
        sim.coast();
        tick(20000);

        expect(last(seen.power)).toBe(0);
        expect(last(seen.cadence)).toBe(0);
    });

    test('the connection switch toggles a single device', () => {
        xf.dispatch('ui:ble:heartRateMonitor:switch');
        tick(1000);

        expect(sim.state().connected.heartRateMonitor).toBe(false);
        expect(sim.state().connected.controllable).toBe(true);
        expect(last(seen.heartRate)).toBe(0);
        expect(names).toContain('--');
    });

    test('a disconnected device stops streaming', () => {
        const count = seen.heartRate.length;
        sim.ride();
        tick(10000);

        expect(seen.heartRate.length).toBe(count);
        expect(last(seen.power)).toBeGreaterThan(0);
    });

    test('reconnects after a dropout', () => {
        sim.dropout(5000, 'controllable');
        tick(100);
        expect(sim.state().connected.controllable).toBe(false);
        expect(last(seen.power)).toBe(0);

        tick(6000);
        expect(sim.state().connected.controllable).toBe(true);

        tick(5000);
        expect(last(seen.power)).toBeGreaterThan(0);
    });
});

describe('fast forward', () => {
    let sim;
    const rates = [];

    beforeAll(() => {
        jest.useFakeTimers();
        xf.sub('sim:speed', (x) => rates.push(x));

        sim = Sim({devices: ['controllable'], speed: 5, ride: true});
        sim.init();
        jest.advanceTimersByTime(1000);
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    test('applies the speed it was started with', () => {
        expect(sim.state().speed).toBe(5);
        expect(rates).toContain(5);
    });

    test('changing speed asks the watch for a new tick rate', () => {
        sim.speed(2);

        expect(sim.state().speed).toBe(2);
        expect(rates[rates.length - 1]).toBe(2);
    });

    test('stays within a sane range', () => {
        expect(sim.speed(0)).toBe(1);
        expect(sim.speed(-4)).toBe(1);
        expect(sim.speed(1000)).toBe(20);
    });

    test('the devices keep streaming at their own rate', () => {
        // Fast forward is the workout clock only — a trainer notifies just as
        // often at 10x as at 1x, which is why the data coarsens.
        const seen = [];
        xf.sub('power', (x) => seen.push(x));

        sim.speed(1);
        jest.advanceTimersByTime(4000);
        const atNormal = seen.length;

        seen.length = 0;
        sim.speed(10);
        jest.advanceTimersByTime(4000);

        expect(seen.length).toBe(atNormal);
    });
});
