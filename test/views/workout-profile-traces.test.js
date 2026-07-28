/**
 * @jest-environment jsdom
 */

//
// The profile's legend and right-hand axes advertise HR (bpm) and cadence (rpm)
// alongside power, but only power was ever drawn. These cover the recording and
// the mapping onto those axes: power keeps the bars' scale (powerMax at 90% of
// the plot), HR and cadence use the full height against their own ceilings.
//

import { WorkoutGraph } from '../../src/views/workout-graph.js';
import { wattsZones, colorByPct } from '../../src/views/watts.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Build a graph without mounting it — connectedCallback needs the page's
// #graph-workout container and a laid-out viewport, neither of which matter
// to the trace maths.
function graph() {
    const el = document.createElement('workout-graph');
    el.type = 'workout';
    el.workoutStatus = 'started';
    el.workout = {meta: {duration: 600}, intervals: [{duration: 600, steps: []}]};
    el.intervalStarts = [0];
    el.index = 0;
    el.lapTime = 600; // t = 0
    el.ftp = 200;
    el.powerMax = 300;
    el.dom = {
        tracePower:   document.createElementNS(SVG_NS, 'polyline'),
        traceHr:      document.createElementNS(SVG_NS, 'polyline'),
        traceCadence: document.createElementNS(SVG_NS, 'polyline'),
    };
    return el;
}

// A graph that has actually drawn itself — render() is where the trace markup
// (and the power line's gradient) is written. It needs the page container and a
// viewport; neither is laid out in jsdom, which the drawing doesn't depend on.
function rendered() {
    const el = graph();
    el.workout = {
        meta: {duration: 600},
        // 1.5 × 200 W FTP = 300 W peak, so powerMax lands on the 300 the
        // trace-scale tests use.
        intervals: [{duration: 600, steps: [{duration: 600, power: 1.5}]}],
    };
    el.$graphCont = document.createElement('div');
    el.viewPort = {width: 900, baseWidth: 900, height: 200, left: 0, top: 0, aspectRatio: 4.5};
    el.zoom = 1;
    el.render();
    return el;
}

// Advance the graph's clock by counting the lap down, then feed one sample of
// each metric — the same order db.js dispatches them in.
function ride(el, seconds, {power, heartRate, cadence}) {
    el.lapTime = 600 - seconds;
    if(power !== undefined)     el.onPower1s(power);
    if(heartRate !== undefined) el.onHeartRate(heartRate);
    if(cadence !== undefined)   el.onCadence(cadence);
}

function pointsOf(line) {
    return (line.getAttribute('points') ?? '')
        .split(' ').filter((p) => p.length > 0)
        .map((p) => p.split(',').map(parseFloat));
}

describe('profile traces', () => {
    test('heart rate is drawn against its own 200 bpm axis', () => {
        const el = graph();
        ride(el, 0,   {heartRate: 100});
        ride(el, 300, {heartRate: 200});

        expect(pointsOf(el.dom.traceHr)).toEqual([
            [0,  50],  // 100 bpm = half the axis
            [50, 2],   // 200 bpm = the top (clamped just inside the edge)
        ]);
    });

    test('cadence is drawn against its own 120 rpm axis', () => {
        const el = graph();
        ride(el, 0,   {cadence: 60});
        ride(el, 600, {cadence: 90});

        expect(pointsOf(el.dom.traceCadence)).toEqual([
            [0,   50],
            [100, 25],
        ]);
    });

    test('power still follows the bars, filling powerMax to 90% of the plot', () => {
        const el = graph();
        ride(el, 0,   {power: 150}); // half of powerMax
        ride(el, 300, {power: 300});

        expect(pointsOf(el.dom.tracePower)).toEqual([
            [0,  55],
            [50, 10],
        ]);
    });

    test('each metric records on its own event, so a dropout only gaps that trace', () => {
        const el = graph();
        ride(el, 0,   {power: 200, heartRate: 140, cadence: 90});
        ride(el, 60,  {power: 210});               // HR strap drops out
        ride(el, 120, {power: 205, heartRate: 145, cadence: 88});

        expect(pointsOf(el.dom.tracePower)).toHaveLength(3);
        expect(pointsOf(el.dom.traceHr)).toHaveLength(2);
        expect(pointsOf(el.dom.traceCadence)).toHaveLength(2);
    });

    test('nothing is recorded before the workout starts', () => {
        const el = graph();
        el.workoutStatus = 'stopped';
        ride(el, 0,  {power: 200, heartRate: 140, cadence: 90});
        ride(el, 60, {power: 200, heartRate: 140, cadence: 90});

        expect(el.powerTrace).toEqual([]);
        expect(el.hrTrace).toEqual([]);
        expect(el.cadenceTrace).toEqual([]);
    });

    test('a fresh start clears all three traces', () => {
        const el = graph();
        ride(el, 0,  {power: 200, heartRate: 140, cadence: 90});
        ride(el, 60, {power: 200, heartRate: 140, cadence: 90});

        el.workoutStatus = 'stopped';
        el.onWorkoutStatus('started');

        expect(el.powerTrace).toEqual([]);
        expect(el.hrTrace).toEqual([]);
        expect(el.cadenceTrace).toEqual([]);
        expect(el.dom.traceHr.getAttribute('points')).toBe('');
    });

    test('power is stroked with the zone gradient, pinned to the plot', () => {
        const el = rendered();
        const line = el.querySelector('.graph--trace-pow');
        const grad = el.querySelector('linearGradient');

        expect(line.getAttribute('stroke')).toBe(`url(#${grad.getAttribute('id')})`);
        // Pinned to the plot's own scale — objectBoundingBox would stretch the
        // whole ramp over the trace's bounding box (see power-history graph).
        expect(grad.getAttribute('gradientUnits')).toBe('userSpaceOnUse');
        expect(grad.getAttribute('y1')).toBe('0');
        expect(grad.getAttribute('y2')).toBe('100');
        // Cadence and HR keep their flat colours from CSS.
        expect(el.querySelector('.graph--trace-hr').getAttribute('stroke')).toBe(null);
    });

    test('the power line has an outline drawn under it, on the same points', () => {
        const el = rendered();
        const halo = el.querySelector('.graph--trace-halo');
        const line = el.querySelector('.graph--trace-pow');

        // Under, not over: the outline must be painted first.
        const order = [...el.querySelectorAll('polyline')];
        expect(order.indexOf(halo)).toBeLessThan(order.indexOf(line));
        // Its colour is CSS's business; the zone gradient stays on the line.
        expect(halo.getAttribute('stroke')).toBe(null);

        el.dom.tracePower     = line;
        el.dom.tracePowerHalo = halo;
        ride(el, 0,   {power: 150});
        ride(el, 300, {power: 300});

        expect(pointsOf(halo)).toEqual(pointsOf(line));
        expect(pointsOf(halo)).toEqual([[0, 55], [50, 10]]);
    });

    test('the gradient covers the profile\'s own ceiling, not a fixed one', () => {
        // powerMax fills to 90% of the plot, so the top of the plot is
        // 300 / 0.9 = 333 W = 167% of a 200 W FTP — inside Z7.
        const stops = [...rendered().querySelectorAll('linearGradient stop')].map((s) => ({
            offset: parseFloat(s.getAttribute('offset')),
            color:  s.getAttribute('stop-color'),
        }));

        expect(stops[0].offset).toBe(0);
        expect(stops[0].color).toBe(colorByPct(300 / 0.9 / 200 * 100));
        expect(stops[stops.length - 1].offset).toBe(1);
        expect(stops[stops.length - 1].color).toBe(wattsZones[0].color);
        // 100% FTP sits on the Z3/Z4 edge, at its own height on this scale.
        const threshold = stops.find((stop) => stop.color === '#eab308');
        expect(threshold.offset).toBeCloseTo((166.67 - 105) / 166.67, 2);
    });

    test('re-riding a section after a backwards seek overwrites its samples', () => {
        const el = graph();
        ride(el, 0,   {heartRate: 140});
        ride(el, 300, {heartRate: 150});
        ride(el, 600, {heartRate: 160});
        // Seek back to 5 min and ride it again.
        ride(el, 300, {heartRate: 120});

        const points = pointsOf(el.dom.traceHr);
        expect(points).toEqual([[0, 30], [50, 40]]);
    });
});
