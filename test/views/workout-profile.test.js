/**
 * @jest-environment jsdom
 */

//
// Guards the wiring between profile-shape.js and the two views that draw a
// workout's power profile: the live profile on Home (workout-graph.js) and the
// library rows on the Workouts page (workout-list.js).
//
// The shapes themselves are covered in test/workouts/profile-shape.test.js;
// what matters here is that a ramp reaches the DOM as ONE sloped shape per
// interval/segment rather than a staircase of rectangles, and that workouts
// built from real blocks are left alone.
//

import { first, last } from '../../src/functions.js';
import { workouts } from '../../src/workouts/workouts.js';
import { zwo } from '../../src/workouts/zwo.js';
import { intervalsToGraph } from '../../src/views/workout-graph.js';
import {
    workoutToSteps, miniProfileHtml, fullProfileHtml,
} from '../../src/views/workout-list.js';

const FTP = 200;
const viewPort = {
    width: 900, baseWidth: 900, height: 200, left: 0, top: 0, aspectRatio: 4.5,
};

// Built-in workouts, by the shape they exercise.
const RAMP_TEST   = 17; // a ramp written as 26 consecutive 1 min intervals
const DIJON       = 0;  // a <Warmup>/<Cooldown> ramp plus over/unders
const BLOCKS_ONLY = 8;  // "Potato Chips" — flat blocks, no ramp anywhere

function load(index) {
    const parsed = zwo.readToInterval(workouts[index]);
    return {intervals: parsed.intervals, meta: parsed.meta};
}

function render(html) {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
}

// Read a ramp overlay's left/right edge heights (px above the block's base)
// back out of the inline height + clip-path the view wrote.
function edgesOf(rampEl) {
    const style  = rampEl.getAttribute('style');
    const height = parseFloat(style.match(/height: ([\d.]+)px/)[1]);
    const points = style.match(/polygon\(([^)]*)\)/)[1].split(', ');
    // the polygon closes with "100% 100%, 0% 100%" along the base
    const tops   = points.slice(0, -2);
    const toPx   = (point) => height * (1 - (parseFloat(point.split(' ')[1]) / 100));
    return {left: toPx(tops[0]), right: toPx(tops[tops.length - 1])};
}

describe('live workout profile (workout-graph)', () => {
    test('a ramp spread over many intervals draws as one unbroken line', () => {
        const el    = render(intervalsToGraph(load(RAMP_TEST), FTP, viewPort));
        const ramps = [...el.querySelectorAll('.graph--ramp')];

        // one sloped shape per interval of the run (the 5 min lead-in stays flat)
        expect(ramps).toHaveLength(26);

        const edges = ramps.map(edgesOf);
        // consecutive slices meet at the same height, so there is no visible
        // step where one interval hands over to the next (tolerance is the
        // rounding in the clip-path percentages, well under a pixel)
        edges.slice(0, -1).forEach((edge, i) => {
            expect(Math.abs(edge.right - edges[i + 1].left)).toBeLessThan(0.05);
        });
        // and it climbs the whole way
        expect(last(edges).right).toBeGreaterThan(first(edges).left);
    });

    test('ramp overlays carry a clip-path and a zone gradient', () => {
        const el = render(intervalsToGraph(load(DIJON), FTP, viewPort));
        const ramps = [...el.querySelectorAll('.graph--ramp')];
        expect(ramps.length).toBeGreaterThan(0);
        ramps.forEach((ramp) => {
            const style = ramp.getAttribute('style');
            expect(style).toMatch(/clip-path: polygon\(/);
            expect(style).toMatch(/linear-gradient\(90deg, #/);
        });
    });

    test('per-step hit targets survive so hover and scrub stay per step', () => {
        const workout = load(DIJON);
        const el = render(intervalsToGraph(workout, FTP, viewPort));
        const steps = workout.intervals.reduce((acc, i) => acc + i.steps.length, 0);
        expect(el.querySelectorAll('.graph--bar')).toHaveLength(steps);
        // the bars inside a ramp are invisible targets — no zone colour on them
        el.querySelectorAll('.graph--bar.is-ramp').forEach((bar) => {
            expect(bar.className).not.toMatch(/zone-/);
        });
    });

    test('one group per interval, so the active-interval highlight still lines up', () => {
        const workout = load(RAMP_TEST);
        const el = render(intervalsToGraph(workout, FTP, viewPort));
        expect(el.querySelectorAll('.graph--bar-group'))
            .toHaveLength(workout.intervals.length);
    });

    test('a workout of flat blocks draws no sloped shapes', () => {
        const el = render(intervalsToGraph(load(BLOCKS_ONLY), FTP, viewPort));
        expect(el.querySelectorAll('.graph--ramp')).toHaveLength(0);
        expect(el.querySelectorAll('.graph--bar.is-ramp')).toHaveLength(0);
    });

    test('renders without leaking undefined/NaN into the markup', () => {
        [RAMP_TEST, DIJON, BLOCKS_ONLY].forEach((i) => {
            const html = intervalsToGraph(load(i), FTP, viewPort);
            expect(html).not.toContain('undefined');
            expect(html).not.toContain('NaN');
        });
    });

    // The intensity stepper scales the targets actually sent to the trainer, so
    // the drawn profile has to describe those scaled targets too.
    describe('workout intensity %', () => {
        const wattsOf = (html) => [...render(html).querySelectorAll('.graph--bar')]
              .map((bar) => Number(bar.getAttribute('power')));

        test('block powers scale with the intensity', () => {
            const workout = load(BLOCKS_ONLY);
            const base    = wattsOf(intervalsToGraph(workout, FTP, viewPort));
            const up      = wattsOf(intervalsToGraph(workout, FTP, viewPort, 110));
            const down    = wattsOf(intervalsToGraph(workout, FTP, viewPort, 90));

            expect(base.length).toBeGreaterThan(0);
            up.forEach((w, i) => expect(w).toBe(Math.round(base[i] * 1.10)));
            down.forEach((w, i) => expect(w).toBe(Math.round(base[i] * 0.90)));
        });

        test('omitting the intensity leaves the profile at 100%', () => {
            const workout = load(DIJON);
            expect(intervalsToGraph(workout, FTP, viewPort))
                .toEqual(intervalsToGraph(workout, FTP, viewPort, 100));
        });

        test('the watt labels follow the scaled powers', () => {
            const workout = load(BLOCKS_ONLY);
            const labelsAt = (intensity) =>
                  [...render(intervalsToGraph(workout, FTP, viewPort, intensity))
                   .querySelectorAll('.graph--bar-watt')]
                  .map((label) => label.textContent.trim());

            const base = labelsAt(100);
            expect(base.length).toBeGreaterThan(0);
            expect(labelsAt(150)).not.toEqual(base);
            expect(labelsAt(150).map(Number))
                .toEqual(base.map((w) => Math.round(Number(w) * 1.5)));
        });

        test('a ramp keeps its shape — only its values move', () => {
            const workout = load(RAMP_TEST);
            const rampsAt = (intensity) =>
                  [...render(intervalsToGraph(workout, FTP, viewPort, intensity))
                   .querySelectorAll('.graph--ramp')];

            // same number of sloped shapes: intensity must not re-trigger ramp
            // detection (its thresholds are %FTP, and FTP scales with it)
            expect(rampsAt(120)).toHaveLength(rampsAt(100).length);
            // the plot rescales with the workout's own peak, so the drawn
            // heights are unchanged — the slope reads the same at any intensity
            rampsAt(120).map(edgesOf).forEach((edge, i) => {
                const at100 = rampsAt(100).map(edgesOf)[i];
                expect(Math.abs(edge.left  - at100.left)).toBeLessThan(0.5);
                expect(Math.abs(edge.right - at100.right)).toBeLessThan(0.5);
            });
        });
    });
});

describe('workouts page profile (workout-list)', () => {
    test('a ramp collapses into a single shape in both the thumbnail and the profile', () => {
        const workout = load(RAMP_TEST);
        const steps   = workoutToSteps(workout, FTP);
        const el = render(miniProfileHtml(steps) +
                          fullProfileHtml(steps, FTP, workout.meta.duration));

        // 27 steps in, but the 26 ramp steps become one shape either side
        expect(el.querySelectorAll('.watts-wmini--ramp')).toHaveLength(1);
        expect(el.querySelectorAll('.watts-wprof--ramp')).toHaveLength(1);
        // leaving just the flat lead-in as a bar
        expect(el.querySelectorAll('.watts-wprof--bar')).toHaveLength(1);
    });

    test('ramp shapes carry a clip-path and a zone gradient', () => {
        const workout = load(DIJON);
        const steps   = workoutToSteps(workout, FTP);
        const el = render(miniProfileHtml(steps) +
                          fullProfileHtml(steps, FTP, workout.meta.duration));
        const ramps = [...el.querySelectorAll('.watts-wmini--ramp, .watts-wprof--ramp')];
        expect(ramps.length).toBeGreaterThan(0);
        ramps.forEach((ramp) => {
            const style = ramp.getAttribute('style');
            expect(style).toMatch(/clip-path: polygon\(/);
            expect(style).toMatch(/linear-gradient\(90deg, #/);
        });
    });

    test('watt labels are bare numbers — no W suffix', () => {
        [RAMP_TEST, DIJON, BLOCKS_ONLY].forEach((i) => {
            const workout = load(i);
            const steps   = workoutToSteps(workout, FTP);
            const el = render(fullProfileHtml(steps, FTP, workout.meta.duration));
            const labels = [...el.querySelectorAll('.watts-wprof--watt')];
            expect(labels.length).toBeGreaterThan(0);
            labels.forEach((label) => {
                // a block reads "240", a ramp run "104→404"
                expect(label.textContent.trim()).toMatch(/^\d+(→\d+)?$/);
            });
        });
    });

    test('blocks carry their duration at the base, mm:ss without a leading zero', () => {
        const workout = load(DIJON);
        const steps   = workoutToSteps(workout, FTP);
        const el = render(fullProfileHtml(steps, FTP, workout.meta.duration));
        const durations = [...el.querySelectorAll('.watts-wprof--dur')];
        expect(durations.length).toBeGreaterThan(0);
        durations.forEach((dur) => {
            expect(dur.textContent.trim()).toMatch(/^[1-9]?\d:[0-5]\d$/);
        });
    });

    test('slivers too narrow to read stay unlabelled', () => {
        const workout = load(DIJON);
        const steps   = workoutToSteps(workout, FTP);
        const total   = workout.meta.duration;
        const el = render(fullProfileHtml(steps, FTP, total));
        // fewer duration labels than segments — the short over/under blocks are
        // below the width threshold and would otherwise overlap each other
        const segments = el.querySelectorAll('.watts-wprof--seg').length;
        expect(el.querySelectorAll('.watts-wprof--dur').length).toBeLessThan(segments);
    });

    test('a workout of flat blocks keeps one bar per step', () => {
        const workout = load(BLOCKS_ONLY);
        const steps   = workoutToSteps(workout, FTP);
        const el = render(fullProfileHtml(steps, FTP, workout.meta.duration));
        expect(el.querySelectorAll('.watts-wprof--ramp')).toHaveLength(0);
        expect(el.querySelectorAll('.watts-wprof--bar')).toHaveLength(steps.length);
    });

    test('renders without leaking undefined/NaN into the markup', () => {
        [RAMP_TEST, DIJON, BLOCKS_ONLY].forEach((i) => {
            const workout = load(i);
            const steps   = workoutToSteps(workout, FTP);
            [miniProfileHtml(steps),
             fullProfileHtml(steps, FTP, workout.meta.duration)].forEach((html) => {
                expect(html).not.toContain('undefined');
                expect(html).not.toContain('NaN');
            });
        });
    });
});
