/**
 * @jest-environment jsdom
 */

//
// Guards the two things that made <power-history-graph> paint the wrong colours
// or the wrong shape:
//
//  - the zone gradient must be pinned to the plot's own 0..170% FTP scale
//    (gradientUnits="userSpaceOnUse"), not to the stroke's bounding box, which
//    is what smeared the full purple→grey ramp over any flat trace; and
//  - x must be scaled by the selected window, so a partly-filled buffer draws
//    across its share of the width instead of being re-stretched every tick.
//

import { xf } from '../../src/functions.js';
import { toPoints, wattsZones } from '../../src/views/watts.js';

const HIST_MAX_PCT = 170;

function mount() {
    const el = document.createElement('power-history-graph');
    document.body.appendChild(el);
    return el;
}

// `db:*` subscribers read their own key off the store the proxy hands them,
// so a hand-rolled dispatch has to carry that shape.
function set(key, value) {
    xf.dispatch(`db:${key}`, {[key]: value});
}

function stopsOf(el) {
    return [...el.querySelectorAll('linearGradient stop')].map((stop) => ({
        offset: parseFloat(stop.getAttribute('offset')),
        color:  stop.getAttribute('stop-color'),
    }));
}

function pointsOf(el) {
    return (el.querySelector('polyline').getAttribute('points') ?? '')
        .split(' ').filter((p) => p.length > 0)
        .map((p) => p.split(',').map(parseFloat));
}

afterEach(() => { document.body.innerHTML = ''; });

describe('<power-history-graph> zone gradient', () => {
    test('is pinned to the plot, not to the trace bounding box', () => {
        const grad = mount().querySelector('linearGradient');
        expect(grad.getAttribute('gradientUnits')).toBe('userSpaceOnUse');
        // Top to bottom of the 0 0 100 100 viewBox.
        expect(grad.getAttribute('y1')).toBe('0');
        expect(grad.getAttribute('y2')).toBe('100');
    });

    test('bands the zones at their own boundaries, top-down', () => {
        const stops = stopsOf(mount());
        // Every zone below the 170% ceiling gets a hard-edged band: a pair of
        // stops sharing one colour.
        const visible = wattsZones.filter((zone, i) =>
            (i === 0 ? 0 : wattsZones[i - 1].max) < HIST_MAX_PCT);
        expect(stops).toHaveLength(visible.length * 2);

        // Top of the plot is the highest zone, bottom is the lowest.
        expect(stops[0].offset).toBe(0);
        expect(stops[0].color).toBe(wattsZones[wattsZones.length - 1].color);
        expect(stops[stops.length - 1].offset).toBe(1);
        expect(stops[stops.length - 1].color).toBe(wattsZones[0].color);

        // Bands run in order and tile the plot without gaps or overlap.
        stops.forEach((stop, i) => {
            if(i === 0) return;
            expect(stop.offset).toBeGreaterThanOrEqual(stops[i - 1].offset);
        });
        for(let i = 0; i < stops.length; i += 2) {
            expect(stops[i].color).toBe(stops[i + 1].color);
            if(i > 0) expect(stops[i].offset).toBe(stops[i - 1].offset);
        }

        // 100% FTP sits on the Z3/Z4 edge, at the same height as the mid gridline.
        const threshold = stops.find((stop) => stop.color === '#eab308');
        expect(threshold.offset).toBeCloseTo((HIST_MAX_PCT - 105) / HIST_MAX_PCT, 3);
    });
});

describe('<power-history-graph> trace', () => {
    test('a partly-filled buffer covers its share of the window, not the plot', () => {
        const el = mount();
        set('ftp', 200);
        // 5m window is the default; 30 samples is a tenth of it.
        for(let i = 0; i < 31; i += 1) set('power1s', 200);

        const points = pointsOf(el);
        expect(points).toHaveLength(31);
        expect(points[0][0]).toBe(0);
        expect(points[points.length - 1][0]).toBeCloseTo((30 / 299) * 100, 2);
    });

    test('a full buffer spans the plot, scaled 0..170% FTP', () => {
        const el = mount();
        set('ftp', 200);
        for(let i = 0; i < 300; i += 1) set('power1s', 340); // 170% FTP

        const points = pointsOf(el);
        expect(points[points.length - 1][0]).toBeCloseTo(100, 2);
        // 170% FTP is the top of the plot (y is clamped just inside the edge).
        points.forEach(([, y]) => expect(y).toBeCloseTo(2, 2));
    });
});

describe('toPoints', () => {
    test('spans the values by default', () => {
        const points = toPoints([0, 50, 100], 0, 100);
        expect(points).toBe('0.00,98.00 50.00,50.00 100.00,2.00');
    });

    test('an explicit span leaves room for the samples still to come', () => {
        const points = toPoints([0, 50, 100], 0, 100, 0, 100, 5);
        expect(points).toBe('0.00,98.00 25.00,50.00 50.00,2.00');
    });
});
