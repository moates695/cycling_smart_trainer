/**
 * @jest-environment jsdom
 */

import { zwo } from '../../src/workouts/zwo.js';
import {
    Segment,
    segmentsFromIntervals,
    segmentToZwoStep,
    segmentsToZwo,
    snapDuration,
    snapPower,
    copyName,
} from '../../src/workouts/designer-model.js';

describe('snapping', () => {
    test('duration snaps to 5s and enforces a 5s minimum', () => {
        expect(snapDuration(302)).toBe(300);
        expect(snapDuration(303)).toBe(305);
        expect(snapDuration(1)).toBe(5);
        expect(snapDuration(0)).toBe(5);
    });

    test('power snaps to 1% increments and never goes negative', () => {
        expect(snapPower(0.884)).toBe(0.88);
        expect(snapPower(0.886)).toBe(0.89);
        expect(snapPower(-0.2)).toBe(0);
    });
});

describe('segmentToZwoStep', () => {
    test('constant power emits SteadyState', () => {
        const step = segmentToZwoStep(Segment({ duration: 300, powerStart: 0.88 }));
        expect(step).toBe('<SteadyState Duration="300" Power="0.88"/>');
    });

    test('rising power emits Warmup with low/high', () => {
        const step = segmentToZwoStep(Segment({ duration: 120, powerStart: 0.4, powerEnd: 0.6 }));
        expect(step).toBe('<Warmup Duration="120" PowerLow="0.4" PowerHigh="0.6"/>');
    });

    test('falling power emits Cooldown with low/high', () => {
        const step = segmentToZwoStep(Segment({ duration: 120, powerStart: 0.6, powerEnd: 0.4 }));
        expect(step).toBe('<Cooldown Duration="120" PowerLow="0.6" PowerHigh="0.4"/>');
    });

    test('cadence and slope are included when present', () => {
        const step = segmentToZwoStep(Segment({ duration: 60, powerStart: 1.0, cadence: 95, slope: 2 }));
        expect(step).toContain('Cadence="95"');
        expect(step).toContain('Slope="2"');
    });
});

describe('round trip through the real Auuki ZWO parser', () => {
    test('generated ZWO parses back to matching intervals', () => {
        const meta = { name: 'Test', author: 'me', category: 'VO2 Max', description: 'x' };
        const segments = [
            Segment({ duration: 300, powerStart: 0.4, powerEnd: 0.6 }), // warmup
            Segment({ duration: 600, powerStart: 0.88 }),               // steady
            Segment({ duration: 300, powerStart: 0.6, powerEnd: 0.3 }), // cooldown
        ];

        const parsed = zwo.readToInterval(segmentsToZwo(meta, segments));

        expect(parsed.meta.name).toBe('Test');
        expect(parsed.intervals).toHaveLength(3);

        const durations = parsed.intervals.map((i) => i.duration);
        expect(durations).toEqual([300, 600, 300]);

        const steady = parsed.intervals[1];
        expect(steady.steps[0].power).toBeCloseTo(0.88, 5);

        // ramp direction preserved: warmup rises, cooldown falls
        const warmup = parsed.intervals[0];
        expect(warmup.steps[0].power).toBeLessThan(warmup.steps[warmup.steps.length - 1].power);
        const cooldown = parsed.intervals[2];
        expect(cooldown.steps[0].power).toBeGreaterThan(cooldown.steps[cooldown.steps.length - 1].power);
    });
});

describe('copyName', () => {
    test('returns the name unchanged when there is no collision', () => {
        expect(copyName('Threshold', ['Sweet Spot', 'VO2 Max'])).toBe('Threshold');
    });

    test('appends (2) on the first collision', () => {
        expect(copyName('Threshold', ['Threshold'])).toBe('Threshold (2)');
    });

    test('skips already-taken numbers', () => {
        expect(copyName('Threshold', ['Threshold', 'Threshold (2)', 'Threshold (3)']))
            .toBe('Threshold (4)');
    });

    test('reuses the root when the base already ends in (n)', () => {
        expect(copyName('Threshold (2)', ['Threshold', 'Threshold (2)']))
            .toBe('Threshold (3)');
    });

    test('falls back to "Workout" for a blank name', () => {
        expect(copyName('', [])).toBe('Workout');
        expect(copyName('   ', ['Workout'])).toBe('Workout (2)');
    });
});

describe('segmentsFromIntervals', () => {
    test('reconstructs segments from an intervals model', () => {
        const intervals = [
            { duration: 300, steps: [{ duration: 300, power: 0.5 }] },
            { duration: 120, steps: [
                { duration: 60, power: 0.4 },
                { duration: 60, power: 0.6 },
            ] },
        ];
        const segments = segmentsFromIntervals(intervals);
        expect(segments).toHaveLength(2);
        expect(segments[0].powerStart).toBe(0.5);
        expect(segments[0].powerEnd).toBe(0.5);
        expect(segments[1].powerStart).toBe(0.4);
        expect(segments[1].powerEnd).toBe(0.6);
    });
});
