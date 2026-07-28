// Pure conversion logic for the graphical workout designer.
//
// Kept free of DOM and heavy app imports so it can be unit tested in isolation.
// A "segment" is one draggable bar in the designer:
//   { id, duration(sec), powerStart(frac), powerEnd(frac), cadence?, slope? }
// It is a ramp when powerStart !== powerEnd, otherwise a steady block.

import { exists, first, last } from '../functions.js';

const MIN_DURATION = 5;      // seconds
const DURATION_SNAP = 5;     // seconds
const POWER_SNAP = 0.01;     // fraction of FTP
const MIN_POWER = 0;

let _seq = 0;
function nextId() { return `seg-${_seq++}`; }

function clamp(min, max, v) { return Math.max(min, Math.min(max, v)); }
function round2(v) { return Math.round(v * 100) / 100; }

function snapDuration(sec) {
    return Math.max(MIN_DURATION, Math.round(sec / DURATION_SNAP) * DURATION_SNAP);
}
function snapPower(frac) {
    return Math.max(MIN_POWER, Math.round(frac / POWER_SNAP) * POWER_SNAP);
}

// Coggan 7-zone boundaries as fractions of FTP (upper edge of each zone,
// z7 is open-ended). Matches the WATTS design spec's colorByPct mapping.
const ZONE_BOUNDS = [0.55, 0.75, 0.90, 1.05, 1.20, 1.50];

// Map a power fraction of FTP to a Coggan zone index 1..7, used by the
// designer to pick the bar colour (via the --watts-z1..z7 CSS tokens).
function powerToZoneIndex(frac) {
    for(let i = 0; i < ZONE_BOUNDS.length; i++) {
        if(frac <= ZONE_BOUNDS[i]) return i + 1;
    }
    return 7;
}

function Segment(args = {}) {
    return {
        id: args.id ?? nextId(),
        duration: args.duration ?? 300,
        powerStart: args.powerStart ?? 0.5,
        powerEnd: args.powerEnd ?? (args.powerStart ?? 0.5),
        cadence: args.cadence,
        slope: args.slope,
    };
}

function segmentsFromIntervals(intervals = []) {
    return intervals.map((interval) => {
        const steps = interval.steps ?? [];
        const start = first(steps) ?? {};
        const end = last(steps) ?? start;
        return Segment({
            duration: interval.duration ?? 300,
            powerStart: start.power ?? 0.5,
            powerEnd: end.power ?? start.power ?? 0.5,
            cadence: start.cadence,
            slope: start.slope,
        });
    });
}

function segmentToZwoStep(seg) {
    const duration = Math.round(seg.duration);
    const cadence = exists(seg.cadence) ? ` Cadence="${Math.round(seg.cadence)}"` : '';
    const slope = exists(seg.slope) ? ` Slope="${seg.slope}"` : '';

    if(Math.abs(seg.powerStart - seg.powerEnd) < 0.001) {
        return `<SteadyState Duration="${duration}" Power="${round2(seg.powerStart)}"${cadence}${slope}/>`;
    }
    const low = round2(seg.powerStart);
    const high = round2(seg.powerEnd);
    // Auuki's parser reads a rising ramp from Warmup and a falling one from
    // Cooldown, in both cases starting at PowerLow and ending at PowerHigh.
    const tag = seg.powerEnd > seg.powerStart ? 'Warmup' : 'Cooldown';
    return `<${tag} Duration="${duration}" PowerLow="${low}" PowerHigh="${high}"${cadence}${slope}/>`;
}

function escapeXml(s) {
    return `${s ?? ''}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Produce a library-unique name for a workout. If `base` does not collide with
// any existing name it is returned unchanged; otherwise a numbered suffix is
// appended, reusing the root when `base` already ends in " (n)".
//   copyName('Threshold', ['Threshold'])        -> 'Threshold (2)'
//   copyName('Threshold (2)', ['Threshold (2)']) -> 'Threshold (3)'
function copyName(base, existingNames = []) {
    const names = new Set((existingNames ?? []).map((n) => `${n ?? ''}`));
    const raw = `${base ?? ''}`.trim() || 'Workout';
    if(!names.has(raw)) return raw;
    const root = raw.replace(/\s*\(\d+\)$/, '').trim() || 'Workout';
    let n = 2;
    while(names.has(`${root} (${n})`)) n++;
    return `${root} (${n})`;
}

function segmentsToZwo(meta = {}, segments = []) {
    const steps = segments.map(segmentToZwoStep).join('\n        ');
    return `<workout_file>
    <author>${escapeXml(meta.author)}</author>
    <name>${escapeXml(meta.name)}</name>
    <category>${escapeXml(meta.category)}</category>
    <description>${escapeXml(meta.description)}</description>
    <sportType>bike</sportType>
    <tags></tags>
    <workout>
        ${steps}
    </workout>
</workout_file>`;
}

export {
    MIN_DURATION,
    DURATION_SNAP,
    POWER_SNAP,
    nextId,
    clamp,
    round2,
    snapDuration,
    snapPower,
    powerToZoneIndex,
    Segment,
    segmentsFromIntervals,
    segmentToZwoStep,
    segmentsToZwo,
    copyName,
};
