//
// Shared geometry for drawing a workout's power profile.
//
// A ramp in a workout file is never a single sloped block: `.zwo` expands
// <Warmup>/<Cooldown>/<Ramp> into a run of short steps, and many exported
// workouts (Intervals.icu, ramp tests) write the same shape as a run of short
// <SteadyState> intervals instead. Drawn literally, both read as a staircase of
// rectangles rather than the slope the author meant.
//
// This module finds those runs and gives every step the height of its top edge
// at its LEFT and RIGHT boundary, so a view can draw the run as one continuous
// sloped shape. Steps outside a run keep a flat top (left === right), i.e. they
// stay ordinary rectangles.
//
// It is deliberately DOM-free and free of app imports so it can be unit tested
// in isolation (see test/workouts/profile-shape.test.js), the same way
// designer-model.js is.
//

// A run is only smoothed when it really looks like a discretised slope rather
// than a series of distinct efforts the rider holds one at a time:
//
//  - steps longer than this are substantial blocks in their own right (a 2 min
//    block at 65% then one at 81% is a ladder, not a ramp), so they never merge;
//  - a big power jump between neighbours is a change of effort, not the next
//    tick of a slope — this is what stops a warmup ramp from swallowing the
//    hard block that follows it;
//  - a couple of rising blocks is not a ramp; a run needs some length before
//    the staircase reads as a line.
const RAMP_MAX_STEP_DURATION = 60;  // seconds, per step
const RAMP_MAX_JUMP_PCT      = 15;  // % FTP between neighbouring steps
const RAMP_MIN_STEPS         = 4;   // steps in a run

function sign(value) {
    if(value > 0) return 1;
    if(value < 0) return -1;
    return 0;
}

// Maximal runs of consecutive steps that form one monotonic slope.
// Returns [{start, end}] as inclusive indices into `steps`.
function findRampRuns(steps, args = {}) {
    const maxDuration = args.maxStepDuration ?? RAMP_MAX_STEP_DURATION;
    const maxJump     = args.maxJump ?? Infinity;
    const minSteps    = args.minSteps ?? RAMP_MIN_STEPS;

    const runs = [];
    const n    = steps.length;
    let   i    = 0;

    while(i < n) {
        let direction = 0; // set by the first step that actually changes power
        let end       = i;

        while(end + 1 < n) {
            const from = steps[end];
            const to   = steps[end + 1];
            if((from.duration ?? 0) > maxDuration) break;
            if((to.duration ?? 0) > maxDuration) break;

            const delta = (to.power ?? 0) - (from.power ?? 0);
            if(Math.abs(delta) > maxJump) break;

            const d = sign(delta);
            if(!(d === 0 || direction === 0 || d === direction)) break;
            if(d !== 0 && direction === 0) direction = d;

            end += 1;
        }

        const length  = (end - i) + 1;
        const changes = (steps[i]?.power ?? 0) !== (steps[end]?.power ?? 0);

        if(length >= minSteps && direction !== 0 && changes) {
            runs.push({start: i, end});
            i = end + 1;
        } else {
            i += 1;
        }
    }

    return runs;
}

// The top edge of one ramp run, as a function of seconds from the run's start.
//
// The edge is the straight-line interpolation of the run's control points, and
// a control point sits at the centre of each PLATEAU — each maximal group of
// consecutive steps at the same power — rather than at the centre of every
// step.
//
// That distinction is what keeps a quantised ramp straight. A .zwo <Cooldown>
// is expanded into fixed-length samples whose powers are rounded to whole
// watts, so a shallow one comes out as runs of repeats (39, 39, 39, 38, 38, 38,
// 38, 37, ...). Interpolating step by step holds each repeat flat and then
// drops between them, redrawing the staircase at half amplitude; interpolating
// between plateau centres recovers the line the author wrote.
//
// Past the outermost control points the line continues at the slope of the
// adjacent span, so the run stays straight right to its tips — a staircase
// samples the line at each step's start, so without that the ends would be
// drawn at half slope and a straight ramp would bend at both tips.
//
// Returns {at, bounds}: `bounds[k]` is the offset of the k-th step's left edge.
function runEdge(steps, run) {
    const bounds = [0];
    for(let i = run.start; i <= run.end; i += 1) {
        bounds.push(bounds[bounds.length - 1] + (steps[i].duration ?? 0));
    }

    const points = [];
    let i = run.start;
    while(i <= run.end) {
        const power = steps[i].power ?? 0;
        let end = i;
        while(end + 1 <= run.end && (steps[end + 1].power ?? 0) === power) end += 1;
        points.push({
            x: (bounds[i - run.start] + bounds[(end - run.start) + 1]) / 2,
            power,
        });
        i = end + 1;
    }

    function at(x) {
        if(points.length < 2) return points[0].power;
        // the span x falls in, clamped to the outer spans so both tails
        // extrapolate rather than flatten off
        let a = 0;
        while(a < (points.length - 2) && x > points[a + 1].x) a += 1;
        const from = points[a];
        const to   = points[a + 1];
        const span = to.x - from.x;
        if(!(span > 0)) return from.power;
        return from.power + ((to.power - from.power) * ((x - from.x) / span));
    }

    return {at, bounds};
}

// Annotate each step with the power at its left and right top-edge boundary.
//
// Inside a run the edges are read off the run's interpolated top edge (see
// runEdge), so consecutive steps meet at the same height and the run's tops
// join into one unbroken polyline. Outside a run, both edges are the step's own
// power (a flat top).
//
// `steps` is [{duration, power, ...}]; extra fields are preserved. `power` may
// be in any linear unit (watts or %FTP) as long as `ftp` is in the same unit —
// it is only used to size the neighbour-jump limit.
function shapeSteps(steps, args = {}) {
    const ftp     = args.ftp > 0 ? args.ftp : 0;
    const maxJump = ftp > 0
        ? (ftp * ((args.maxJumpPct ?? RAMP_MAX_JUMP_PCT) / 100))
        : Infinity;

    const runs   = findRampRuns(steps, Object.assign({}, args, {maxJump}));
    const shaped = steps.map((step) => Object.assign({}, step, {
        rampId:     null,
        powerStart: step.power ?? 0,
        powerEnd:   step.power ?? 0,
    }));

    runs.forEach((run, rampId) => {
        const edge = runEdge(steps, run);
        for(let i = run.start; i <= run.end; i += 1) {
            const k = i - run.start;
            shaped[i].rampId     = rampId;
            shaped[i].powerStart = edge.at(edge.bounds[k]);
            shaped[i].powerEnd   = edge.at(edge.bounds[k + 1]);
        }
    });

    return shaped;
}

// True when a step's top is not flat, i.e. it must be drawn as a slope.
function isSloped(step) {
    return step.powerStart !== step.powerEnd;
}

// Flatten a workout's intervals into one list of steps, keeping where each came
// from so a view can still group by interval.
// `toPower` converts a step's stored power into the unit the caller draws in.
function flattenSteps(intervals, toPower) {
    const out = [];
    (intervals ?? []).forEach((interval, intervalIndex) => {
        (interval.steps ?? []).forEach((step, stepIndex) => {
            out.push(Object.assign({}, step, {
                intervalIndex,
                stepIndex,
                duration: step.duration ?? 0,
                power: toPower(step),
            }));
        });
    });
    return out;
}

// Split a shaped step list into drawable segments: each run of ramp steps
// becomes ONE segment (so a view can draw it as a single shape with no seams
// between its steps), and every other step becomes a segment of its own.
function toSegments(shaped) {
    return shaped.reduce((acc, step) => {
        const previous = acc[acc.length - 1];
        if(step.rampId !== null && previous?.rampId === step.rampId) {
            previous.steps.push(step);
            previous.duration += step.duration;
            return acc;
        }
        acc.push({
            rampId:   step.rampId,
            isRamp:   step.rampId !== null,
            duration: step.duration,
            steps:    [step],
        });
        return acc;
    }, []);
}

// A CSS clip-path polygon tracing the tops of `steps` across the element's box.
//
// `heightOf(power)` maps a power to a fraction (0–1) of the box height measured
// from its base; the polygon is emitted in the top-down percentages clip-path
// wants. Widths follow each step's share of the run's duration, so runs whose
// steps differ in length still land on the right x positions.
function rampPolygon(steps, heightOf) {
    const total = steps.reduce((acc, step) => acc + (step.duration ?? 0), 0);
    if(!(total > 0)) return '';

    const toY = (power) => {
        const fraction = Math.min(1, Math.max(0, heightOf(power)));
        return ((1 - fraction) * 100).toFixed(2);
    };

    const points = [];
    // Steps that join at the same height share a vertex; only emit it once so
    // the polygon stays as small as the shape it draws.
    const push = (point) => {
        if(point !== points[points.length - 1]) points.push(point);
    };

    let x = 0;
    steps.forEach((step) => {
        const xStart = (x / total) * 100;
        x += (step.duration ?? 0);
        const xEnd = (x / total) * 100;
        push(`${xStart.toFixed(3)}% ${toY(step.powerStart)}%`);
        push(`${xEnd.toFixed(3)}% ${toY(step.powerEnd)}%`);
    });

    return `polygon(${points.join(', ')}, 100% 100%, 0% 100%)`;
}

export {
    RAMP_MAX_STEP_DURATION,
    RAMP_MAX_JUMP_PCT,
    RAMP_MIN_STEPS,
    findRampRuns,
    shapeSteps,
    isSloped,
    flattenSteps,
    toSegments,
    rampPolygon,
};
