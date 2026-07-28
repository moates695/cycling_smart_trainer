import {
    findRampRuns,
    shapeSteps,
    isSloped,
    flattenSteps,
    toSegments,
    rampPolygon,
} from '../../src/workouts/profile-shape.js';

const FTP = 200;

// helper: build a step list from [duration, watts] pairs
function steps(pairs) {
    return pairs.map(([duration, power]) => ({duration, power}));
}

// helper: a ramp of `n` equal steps rising linearly from `from` to `to`
function ramp(n, from, to, duration = 10) {
    return steps(Array.from({length: n}, (_, i) =>
        [duration, from + ((to - from) * (i / (n - 1)))]));
}

describe('findRampRuns', () => {
    test('finds a run of short rising steps', () => {
        const runs = findRampRuns(ramp(12, 64, 78), {maxJump: 30});
        expect(runs).toEqual([{start: 0, end: 11}]);
    });

    test('finds a falling run', () => {
        const runs = findRampRuns(ramp(12, 150, 90), {maxJump: 30});
        expect(runs).toEqual([{start: 0, end: 11}]);
    });

    test('ignores a run shorter than the minimum', () => {
        expect(findRampRuns(ramp(3, 100, 130), {maxJump: 30})).toEqual([]);
    });

    test('ignores flat steps', () => {
        expect(findRampRuns(steps([[10, 100], [10, 100], [10, 100], [10, 100]]),
                            {maxJump: 30})).toEqual([]);
    });

    test('does not merge blocks that are too long to be ramp steps', () => {
        // a ladder of 2 min blocks is a set of efforts, not a slope
        const ladder = steps([[120, 130], [120, 162], [120, 176], [120, 190]]);
        expect(findRampRuns(ladder, {maxJump: 60})).toEqual([]);
    });

    test('a big power jump ends the run instead of joining it', () => {
        // warmup ramp, then a hard effort at nearly double the power
        const list = [...ramp(6, 64, 78), ...steps([[30, 196], [30, 126]])];
        expect(findRampRuns(list, {maxJump: 30})).toEqual([{start: 0, end: 5}]);
    });

    test('a change of direction ends the run', () => {
        const list = [...ramp(5, 60, 100), ...ramp(5, 96, 60)];
        const runs = findRampRuns(list, {maxJump: 30});
        expect(runs).toHaveLength(2);
        expect(runs[0]).toEqual({start: 0, end: 4});
        expect(runs[1]).toEqual({start: 5, end: 9});
    });

    test('over/unders are never a ramp', () => {
        const ou = steps([[60, 210], [60, 170], [60, 210], [60, 170],
                          [60, 210], [60, 170]]);
        expect(findRampRuns(ou, {maxJump: 60})).toEqual([]);
    });

    test('a long lead-in step is excluded but the run after it is found', () => {
        // the shape of a ramp test: 5 min at a steady power, then 1 min stages
        const list = [{duration: 300, power: 92},
                      ...ramp(8, 104, 188, 60)];
        expect(findRampRuns(list, {maxJump: 30})).toEqual([{start: 1, end: 8}]);
    });
});

describe('shapeSteps', () => {
    test('flat steps keep a flat top', () => {
        const shaped = shapeSteps(steps([[60, 100], [60, 200]]), {ftp: FTP});
        shaped.forEach((step) => {
            expect(step.rampId).toBe(null);
            expect(step.powerStart).toBe(step.power);
            expect(step.powerEnd).toBe(step.power);
            expect(isSloped(step)).toBe(false);
        });
    });

    test('an evenly spaced ramp becomes one straight, unbroken line', () => {
        const shaped = shapeSteps(ramp(11, 100, 200), {ftp: FTP});
        // every step belongs to the same run and is sloped
        shaped.forEach((step) => {
            expect(step.rampId).toBe(0);
            expect(isSloped(step)).toBe(true);
        });
        // tops join: each step's right edge is the next step's left edge
        shaped.slice(0, -1).forEach((step, i) => {
            expect(step.powerEnd).toBeCloseTo(shaped[i + 1].powerStart, 10);
        });
        // and the joined line is straight — a constant rise per step
        const rises = shaped.map((s) => s.powerEnd - s.powerStart);
        rises.forEach((rise) => expect(rise).toBeCloseTo(rises[0], 10));
        // the ends are extrapolated half a step out, so the line stays straight
        // right to its tips (steps rise 10 W, so half a step is 5 W)
        expect(shaped[0].powerStart).toBeCloseTo(95, 10);
        expect(shaped[shaped.length - 1].powerEnd).toBeCloseTo(205, 10);
    });

    test('a ramp quantised into plateaus still draws as a straight line', () => {
        // Dijon's <Cooldown Duration="300" PowerLow="0.39" PowerHigh="0.32"/>:
        // 30 samples across a 14 W range, each rounded to whole watts, so the
        // powers arrive as runs of repeats (78,78,78,77,77,77,77,76,...).
        const quantised = steps(Array.from({length: 30}, (_, i) =>
            [10, Math.round(78 - ((78 - 64) * (i / 29)))]));
        const shaped = shapeSteps(quantised, {ftp: FTP});

        expect(shaped.every((step) => step.rampId === 0)).toBe(true);
        // no step holds its height: a flat one is a tread of the staircase
        shaped.forEach((step) => expect(isSloped(step)).toBe(true));
        // tops still join
        shaped.slice(0, -1).forEach((step, i) => {
            expect(step.powerEnd).toBeCloseTo(shaped[i + 1].powerStart, 10);
        });
        // and fall at an even rate — plateaus of unequal length leave a little
        // slack, but nothing like the 4:1 swing of a staircase
        const drops = shaped.map((s) => s.powerStart - s.powerEnd);
        const mean  = drops.reduce((a, b) => a + b, 0) / drops.length;
        drops.forEach((drop) => expect(Math.abs(drop - mean) / mean).toBeLessThan(0.2));
        // spanning the range the author wrote, to within the rounding that
        // put the plateau boundaries slightly off the true line
        expect(Math.abs(shaped[0].powerStart - 78)).toBeLessThanOrEqual(1);
        expect(Math.abs(shaped[shaped.length - 1].powerEnd - 64)).toBeLessThanOrEqual(1);
    });

    test('a ramp followed by a hard block leaves the block flat', () => {
        const shaped = shapeSteps([...ramp(6, 64, 78), ...steps([[30, 196]])],
                                  {ftp: FTP});
        expect(shaped[6].rampId).toBe(null);
        expect(isSloped(shaped[6])).toBe(false);
    });

    test('extra step fields are preserved', () => {
        const shaped = shapeSteps([{duration: 10, power: 100, cadence: 90}],
                                  {ftp: FTP});
        expect(shaped[0].cadence).toBe(90);
    });

    test('an unset ftp disables the jump limit without throwing', () => {
        const shaped = shapeSteps(ramp(6, 100, 150), {});
        expect(shaped[0].rampId).toBe(0);
    });
});

describe('flattenSteps', () => {
    test('keeps interval and step provenance', () => {
        const intervals = [
            {duration: 20, steps: [{duration: 10, power: 0.5}, {duration: 10, power: 0.6}]},
            {duration: 60, steps: [{duration: 60, power: 0.9}]},
        ];
        const flat = flattenSteps(intervals, (step) => step.power * FTP);
        expect(flat).toHaveLength(3);
        expect(flat[0]).toMatchObject({intervalIndex: 0, stepIndex: 0, power: 100});
        expect(flat[1]).toMatchObject({intervalIndex: 0, stepIndex: 1, power: 120});
        expect(flat[2]).toMatchObject({intervalIndex: 1, stepIndex: 0, power: 180});
    });

    test('tolerates a workout with no intervals', () => {
        expect(flattenSteps(undefined, (s) => s.power)).toEqual([]);
    });
});

describe('toSegments', () => {
    test('a ramp run collapses into one segment, flat steps stay separate', () => {
        const shaped = shapeSteps(
            [...ramp(6, 64, 78), ...steps([[30, 196], [30, 126]])], {ftp: FTP});
        const segments = toSegments(shaped);
        expect(segments).toHaveLength(3);
        expect(segments[0].isRamp).toBe(true);
        expect(segments[0].steps).toHaveLength(6);
        expect(segments[0].duration).toBe(60);
        expect(segments[1].isRamp).toBe(false);
        expect(segments[2].isRamp).toBe(false);
    });

    test('two runs in opposite directions stay separate segments', () => {
        const shaped = shapeSteps([...ramp(5, 60, 100), ...ramp(5, 96, 60)],
                                  {ftp: FTP});
        const segments = toSegments(shaped);
        expect(segments).toHaveLength(2);
        expect(segments.every((s) => s.isRamp)).toBe(true);
    });
});

describe('rampPolygon', () => {
    const heightOf = (power) => power / 200;

    test('traces the tops and closes along the base', () => {
        const shaped = shapeSteps(ramp(4, 100, 160, 10), {ftp: FTP});
        const polygon = rampPolygon(shaped, heightOf);
        expect(polygon.startsWith('polygon(')).toBe(true);
        expect(polygon.endsWith('100% 100%, 0% 100%)')).toBe(true);
        // 4 steps rising 20 W each, so the left edge extrapolates to 90 W
        // (45% of the 200 W box -> 55% down from the top)
        expect(polygon).toContain('0.000% 55.00%');
    });

    test('emits no duplicate vertices where steps join', () => {
        const shaped = shapeSteps(ramp(4, 100, 160, 10), {ftp: FTP});
        const points = rampPolygon(shaped, heightOf)
            .replace(/^polygon\(|\)$/g, '').split(', ');
        points.slice(0, -1).forEach((point, i) => {
            expect(point).not.toBe(points[i + 1]);
        });
    });

    test('x positions follow duration, not step count', () => {
        // one 90 s step then three 10 s steps: the first vertex pair must span
        // 75% of the width
        const shaped = shapeSteps(
            steps([[90, 100], [10, 110], [10, 120], [10, 130]]), {ftp: FTP});
        const polygon = rampPolygon(shaped, heightOf);
        expect(polygon).toContain('75.000%');
    });

    test('is empty for a zero-duration run rather than dividing by zero', () => {
        expect(rampPolygon([{duration: 0, powerStart: 1, powerEnd: 1}], heightOf))
            .toBe('');
    });

    test('clamps heights that fall outside the box', () => {
        const polygon = rampPolygon(
            [{duration: 10, powerStart: -50, powerEnd: 500}], heightOf);
        expect(polygon).toContain('100.00%'); // clamped to the base
        expect(polygon).toContain('0.00%');   // clamped to the top
    });
});
