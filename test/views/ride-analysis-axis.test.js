/**
 * @jest-environment jsdom
 */

//
// The Ride Analysis graph draws only what was recorded, on the clock it was
// recorded against: the traces are resampled onto an even grid of riding
// seconds (pauses and dropped ticks excluded) and the time axis is labelled
// off that same span.
//

import { models } from '../../src/models/models.js';
import { timeTicksHtml, timeLabel } from '../../src/views/watts.js';

// records at 1 Hz from t0, with an optional pause gap inserted at `pauseAt`.
function makeRecords({ n, t0 = 1_700_000_000_000, pauseAt, pauseMs = 300_000, power = (i) => i }) {
    const out = [];
    let t = t0;
    for(let i = 0; i < n; i++) {
        if(i === pauseAt) t += pauseMs;
        out.push({ timestamp: t, power: power(i), cadence: 90, heart_rate: 140 });
        t += 1000;
    }
    return out;
}

describe('activity trace time axis', () => {
    test('a clean 1 Hz ride spans its own seconds', () => {
        const s = models.activity.summarize({ records: makeRecords({ n: 600 }), ftp: 200 });
        expect(s.trace.dur).toBe(600);
        expect(s.trace.p.length).toBe(180);
    });

    test('a five minute pause does not stretch the axis', () => {
        const s = models.activity.summarize({
            records: makeRecords({ n: 600, pauseAt: 300 }), ftp: 200,
        });
        expect(s.trace.dur).toBe(600);
    });

    test('the second half of a ride is drawn in the second half of the trace', () => {
        // 0 W for the first 300 s, 300 W for the last 300 s, with a pause in between.
        const s = models.activity.summarize({
            records: makeRecords({ n: 600, pauseAt: 300, power: (i) => (i < 300 ? 0 : 300) }),
            ftp: 200,
        });
        const half = s.trace.p.length / 2;
        expect(Math.max(...s.trace.p.slice(0, half - 1))).toBe(0);
        expect(Math.min(...s.trace.p.slice(half + 1))).toBe(300);
    });

    test('dropped ticks leave a hold, not a squeeze', () => {
        // 120 samples, but 60 s of them never arrived (backgrounded tab):
        // samples 0..59 at 1 Hz, then a 60 s hole, then 60..119.
        const records = makeRecords({ n: 120, pauseAt: 60, pauseMs: 60_000, power: () => 200 });
        const s = models.activity.summarize({ records, ftp: 200 });
        expect(s.trace.dur).toBe(120);
    });

    test('a short ride keeps one point per second', () => {
        const s = models.activity.summarize({ records: makeRecords({ n: 10 }), ftp: 200 });
        expect(s.trace.p.length).toBe(10);
        expect(s.trace.dur).toBe(10);
    });

    test('no planned profile is stored', () => {
        const s = models.activity.summarize({
            records: makeRecords({ n: 60 }), ftp: 200,
            workout: { intervals: [{ steps: [{ duration: 60, power: 0.8 }] }] },
        });
        expect(s.plan).toBeUndefined();
    });
});

describe('time ticks', () => {
    test('round steps, exact ends', () => {
        const html = timeTicksHtml(3432); // 57:12
        expect(html).toContain('>0:00<');
        expect(html).toContain('>57:12<');
        expect(html).not.toContain('>14:00<');
    });
    test('hours read h:mm:ss', () => {
        expect(timeLabel(3725)).toBe('1:02:05');
        expect(timeLabel(72)).toBe('1:12');
    });
    test('nothing to label when there is no time', () => {
        expect(timeTicksHtml(0)).toBe('');
    });
});
