import { xf, exists, existance, equals, first, last, clamp, debounce, toFixed  } from '../functions.js';
import { formatTime, translate } from '../utils.js';
import { models } from '../models/models.js';
import { zoneClassByPct, rampGradient, zoneGradientStops } from './watts.js';
import { g } from './graph.js';
import {
    flattenSteps, shapeSteps, isSloped, rampPolygon,
} from '../workouts/profile-shape.js';


// Zoom bounds for the workout profile.
//  - zoom 1 = "fit": the whole workout fills the viewport (most zoomed out).
//  - Max zoom-in is a *constant on the x-axis*: at full zoom the viewport shows
//    exactly MAX_ZOOM_VISIBLE_SECONDS of the workout, regardless of its total
//    length. So zoomMax = totalDuration / MAX_ZOOM_VISIBLE_SECONDS (never < 1).
const MAX_ZOOM_VISIBLE_SECONDS = 120; // seconds visible in the viewport at full zoom-in
// Each +/- click multiplies/divides zoom by this factor. A geometric step keeps
// every click the same *perceived* size (constant ratio) — the first press from
// 1× is a gentle +50%, while a long workout's large zoomMax is still reachable
// in ~log₁.₅(zoomMax) clicks (a linear split of fit→max made the first click
// jump several ×).
const ZOOM_FACTOR = 1.5;

// Ceilings of the profile's two right-hand reference axes. These are the values
// printed on .watts-profile--axis-hr / --axis-cad in index.html, so a trace
// drawn against them lines up with the labels the rider reads.
const HR_AXIS_MAX      = 200; // bpm
const CADENCE_AXIS_MAX = 120; // rpm

// Per-element suffix for the power trace's gradient id (SVG ids are global).
let graphPowGradSeq = 0;


function powerToHeight(power, powerMax, viewPort) {
    const height = translate(power, 0, powerMax, 0, viewPort.height * 0.90);
    // console.log(`${viewPort.height} -> ${height}`);
    if(height < (viewPort.height * 0.10)) {
        return viewPort.height * 0.14;
    }
    return height;
}

function intervalToWidth(intervalDuration, totalDuration, totalWidth) {
    // Cap at the total plot width (in px) — a single interval can be at most the
    // whole plot. (The cap used to be totalDuration, a seconds value; harmless at
    // 1× where widths stay well under it, but when zoomed the plot grows past
    // that value and long intervals stopped widening even as zoom kept rising.)
    return clamp(1,
                 totalWidth,
                 translate(intervalDuration, 0, totalDuration, 0, totalWidth)
                );
}

// The workout intensity % (the -/+ stepper on the control bar) scales every
// planned target before it is sent to the trainer (see watch.js), so the
// profile draws the scaled watts too — otherwise the blocks, their labels and
// the axis would keep describing a workout the rider is no longer riding.
function scalePower(power, intensity) {
    if(!exists(power)) return power;
    return models.workoutIntensity.apply(intensity ?? 100, power);
}

function intervalsToMaxPower(intervals, ftp, intensity = 100) {
    // Scale the plot to the workout's own peak power (not a fixed 160%-FTP
    // ceiling). powerToHeight fills to 90% of the plot, so the tallest block
    // sits slightly below the top — "slightly higher than the loaded workout".
    const peak = intervals.reduce((highest, interval) => {
        interval.steps.forEach((step) => {
            const power = scalePower(models.ftp.toAbsolute(step.power, ftp), intensity);
            if(power > highest) highest = power;
        });
        return highest;
    }, 0);
    return peak > 0 ? peak : (ftp * 1.5);
}

function Interval(acc, interval, width, pct, ftp, powerMax, viewPort, intervalIndex = 0,
                  shaped = [], rampSpans = {}) {
    const stepsLength = interval.steps.length;
    const stepPowers  = shaped.map((step) => step.power);

    // A ramp reaches us as a run of short steps of monotonically changing power
    // — either inside one interval (a zwo Warmup/Cooldown expands that way) or
    // spread across several consecutive single-step intervals (how ramp tests
    // and most exported workouts write the same shape). profile-shape.js finds
    // those runs and hands back the top-edge height at each step's left and
    // right boundary; anything it left flat draws as an ordinary rectangle.
    const isRamp = shaped.some(isSloped);
    // The run may continue into the neighbouring intervals. When it does, each
    // interval still draws its own slice — the slices meet at identical heights,
    // so the run reads as one unbroken line across all of them.
    const rampId       = shaped.find(isSloped)?.rampId ?? null;
    const spansManyIvs = exists(rampId) && (rampSpans[rampId] ?? 1) > 1;

    const heightOf = (power) => powerToHeight(power, powerMax, viewPort);
    const hStart = isRamp ? heightOf(first(shaped).powerStart) : 0;
    const hEnd   = isRamp ? heightOf(last(shaped).powerEnd) : 0;

    // A ramping interval draws as ONE shape so its edge has no per-step seams;
    // the per-step bars stay in the DOM as invisible hit targets clipped to
    // their own slice of that edge, so hover and scrub keep step granularity.
    let rampShape = '';
    let hMax      = 0;
    if(isRamp) {
        hMax = shaped.reduce((acc, step) =>
            Math.max(acc, heightOf(step.powerStart), heightOf(step.powerEnd)), 0);
        const polygon = hMax > 0
            ? rampPolygon(shaped, (power) => heightOf(power) / hMax) : '';
        rampShape = `<div class="graph--ramp" style="height: ${hMax}px; ` +
            `clip-path: ${polygon}; ` +
            `background: linear-gradient(90deg, ${rampGradient(stepPowers, ftp)});"></div>`;
    }

    // Persistent per-interval labels: peak watts above the block, total time at
    // its base. Shown on every interval wide enough to read without clutter
    // (was previously limited to work blocks, which hid the labels on recovery
    // and on workouts with narrower intervals).
    const peakPower  = stepPowers.reduce((m, p) => Math.max(m, p), 0);
    const wideEnough = width >= 12;  // anything wider than a sliver gets labels
    const narrow     = width < 40;   // too tight for horizontal text → go vertical
    // Drop the leading zero from the minutes/hours (e.g. "02:00" → "2:00",
    // "00:30" → "0:30") — local to the profile label, formatTime is untouched.
    const durationLabel = exists(interval.duration)
        ? formatTime({value: interval.duration, format: 'mm:ss'}).replace(/^0/, '') : '';
    let wattLabel = `<div class="graph--bar-watt">${Math.round(peakPower)}</div>`;
    // A run spread over many intervals would repeat the "start→end" label on
    // every one of them (26 of them on a ramp test), so those intervals keep the
    // plain watt label and the slope itself carries the shape.
    if(isRamp && !spansManyIvs) {
        const rampText = `${Math.round(first(stepPowers))}→${Math.round(last(stepPowers))}`;
        if(narrow) {
            wattLabel = `<div class="graph--bar-watt">${rampText}</div>`;
        } else {
            // Lay the label along the sloped edge: centred over its midpoint,
            // rotated to the edge's on-screen angle. viewPort.width includes
            // the current zoom, so the angle flattens as the plot stretches
            // (render() re-runs on every zoom change).
            const groupPx = (pct / 100) * viewPort.width;
            const angle   = toFixed(-Math.atan2(hEnd - hStart, groupPx) * (180 / Math.PI), 1);
            const mid     = Math.round((hStart + hEnd) / 2);
            wattLabel = `<div class="graph--bar-watt graph--bar-watt--ramp" ` +
                `style="bottom: ${mid + 6}px; transform: translateX(-50%) rotate(${angle}deg);">` +
                `${rampText}</div>`;
        }
    }
    const labels = wideEnough
        ? wattLabel + `<div class="graph--bar-dur">${durationLabel}</div>`
        : '';
    const groupClass = `graph--bar-group${narrow ? ' is-narrow' : ''}`;

    // Step widths follow their share of the interval's time, so a hit bar sits
    // exactly under the slice of the slope it belongs to (and scrubbing, which
    // reads these rects, lands on the right step). Steps without a duration fall
    // back to an equal share.
    const stepsDuration = interval.steps.reduce((acc, step) => acc + (step.duration ?? 0), 0);

    return acc + interval.steps.reduce((a, step, stepIndex) => {
        const power    = stepPowers[stepIndex];
        const cadence  = step.cadence;
        const slope    = step.slope;
        const duration = step.duration;
        const barWidth = stepsDuration > 0
            ? ((step.duration ?? 0) / stepsDuration) * 100
            : 100 / stepsLength;
        // Colour by the WATTS Coggan boundaries (wattsZones), shared with the
        // FTP gauge / zone chip / power-history gradient, so a bar's colour
        // matches the rest of the home screen (top/purple zone starts at
        // >150% FTP, not 120% as in the legacy models.ftp zone model).
        const zone     = zoneClassByPct((power / (ftp || 200)) * 100);
        const infoTime = formatTime({value: duration, format: 'mm:ss'});

        const powerAttr    = exists(power)    ? `power="${power}"` : '';
        const cadenceAttr  = exists(cadence)  ? `cadence="${cadence}"` : '';
        const slopeAttr    = exists(slope)    ? `slope="${slope}"` : '';
        const durationAttr = exists(duration) ? `duration="${infoTime}"` : '';

        let barClass = `graph--bar zone-${zone}`;
        let sizing   = `height: ${heightOf(power)}px; width: ${barWidth}%`;
        if(isRamp) {
            // Invisible hit target: no zone class (the ramp shape behind it
            // carries the colour), clipped to its own slice of the slope so
            // hover only triggers inside the drawn shape.
            const hL      = heightOf(shaped[stepIndex].powerStart);
            const hR      = heightOf(shaped[stepIndex].powerEnd);
            const barPeak = Math.max(hL, hR);
            const topL = barPeak > 0 ? toFixed(100 * (1 - (hL / barPeak)), 2) : 0;
            const topR = barPeak > 0 ? toFixed(100 * (1 - (hR / barPeak)), 2) : 0;
            barClass = 'graph--bar is-ramp';
            sizing = `height: ${barPeak}px; width: ${barWidth}%; ` +
                `clip-path: polygon(0% ${topL}%, 100% ${topR}%, 100% 100%, 0% 100%)`;
        }

        return a +
            `<div class="${barClass}" style="${sizing}" data-step="${stepIndex}" ${powerAttr} ${cadenceAttr} ${slopeAttr} ${durationAttr}></div>`;
    }, `<div class="${groupClass}" data-interval="${intervalIndex}" style="flex: 0 0 ${pct}%; width: ${pct}%;">${labels}${rampShape}`) + `</div>`;
}

function intervalsToGraph(workout, ftp, viewPort, intensity = 100) {
    // Bars are sized as a *percentage* of the plot so they scale with zoom via
    // CSS (the plot's own width is zoom×100% — see render()). The px `labelWidth`
    // is only used to decide which bars are wide enough to carry labels, and is
    // computed from the 1× (fit) width so labels stay stable across zoom levels.
    const totalWidth    = viewPort.baseWidth ?? viewPort.width;
    const intervals     = workout.intervals;
    const totalDuration = workout.meta.duration;
    const maxPower      = intervalsToMaxPower(intervals, ftp, intensity);

    // Ramp runs are found over the whole workout at once, since one run can span
    // several consecutive intervals; each interval then draws its own slice.
    // The ramp thresholds are expressed in %FTP, so the reference FTP is scaled
    // alongside the powers — a workout must not change shape just because the
    // rider nudged the intensity.
    const shaped = shapeSteps(
        flattenSteps(intervals, (step) =>
            scalePower(models.ftp.toAbsolute(step.power, ftp) ?? 0, intensity)),
        {ftp: scalePower(ftp, intensity)});
    const byInterval = shaped.reduce((acc, step) => {
        (acc[step.intervalIndex] ??= []).push(step);
        return acc;
    }, {});
    // How many intervals each run covers — drives whether an interval labels its
    // own slope or leaves the run to speak for itself.
    const rampSpans = shaped.reduce((acc, step) => {
        if(!exists(step.rampId)) return acc;
        (acc.seen[step.rampId] ??= new Set()).add(step.intervalIndex);
        acc.counts[step.rampId] = acc.seen[step.rampId].size;
        return acc;
    }, {seen: {}, counts: {}}).counts;

    return intervals.reduce((acc, interval, intervalIndex) => {
        if(exists(interval.duration) && totalDuration > 0) {
            const labelWidth = intervalToWidth(interval.duration, totalDuration, totalWidth);
            const pct        = (interval.duration / totalDuration) * 100;
            return Interval(acc, interval, labelWidth, pct, ftp, maxPower, viewPort,
                            intervalIndex, byInterval[intervalIndex] ?? [], rampSpans);
        }

        return acc;
    }, '<div class="graph--info--cont"></div>');
}

function renderInfo(args = {}) {
    const power    = exists(args.power)    ? `${args.power}W `: '';
    const cadence  = exists(args.cadence)  ? `${args.cadence}rpm `: '';
    const slope    = exists(args.slope)    ? `${toFixed(args.slope, 2)}%` : '';
    const duration = exists(args.duration) ? `${args.duration}min `: '';
    const distance = exists(args.distance) ? `${args.distance}m `: '';
    const dom      = args.dom;

    const contLeft   = args.contRect.left;
    const contTop    = args.contRect.top;
    const contWidth  = args.contRect.width;
    const contHeight = args.contRect.height;

    // Cursor position relative to the graph container.
    const cursorX = exists(args.mouseX) ? args.mouseX - contLeft : 0;
    const cursorY = exists(args.mouseY) ? args.mouseY - contTop  : 0;

    dom.info.style.display = 'block';
    dom.info.style.bottom  = 'auto';
    dom.info.innerHTML = `<div>${power}</div><div>${cadence}</div><div>${slope}</div><div class="graph--info--time">${duration}</div>`;

    const width  = dom.info.getBoundingClientRect().width;
    const height = dom.info.getBoundingClientRect().height;

    // Offset the popup from the cursor, then clamp it inside the container.
    const offset = 14;
    let left = cursorX + offset;
    let top  = cursorY + offset;

    if(left + width > contWidth)  left = cursorX - offset - width;  // flip to left of cursor
    if(top + height > contHeight) top  = cursorY - offset - height; // flip above cursor

    left = clamp(0, Math.max(0, contWidth - width), left);
    top  = clamp(0, Math.max(0, contHeight - height), top);

    dom.info.style.left = `${left}px`;
    dom.info.style.top  = `${top}px`;
}

class WorkoutGraph extends HTMLElement {
    constructor() {
        super();
        this.workout = {};
        this.workoutStatus = "stopped";
        this.metricValue = 0;
        this.index = 0;
        this.minHeight = 30;
        this.type = 'workout';
        this.zoom = 1;
        this.intensity = models.workoutIntensity.default;
        this.zoomMin = 1;
        this.zoomMax = 6;
        this.tracking = false; // follow-current mode; only meaningful when zoomed
        // Actual rider output, sampled while the workout runs and drawn as lines
        // over the planned profile (the rider may deviate from it, e.g. via the
        // intensity +/- % control). One list per trace, each [{t, v}] where t is
        // seconds into the workout — power against the left axis, heart rate and
        // cadence against their own right-hand axes.
        this.powerTrace = [];
        this.hrTrace = [];
        this.cadenceTrace = [];
        this.intervalStarts = []; // cumulative start time of each interval
        this.powerMax = 0;
        // Gradient ids are global in SVG, so each graph element gets its own.
        this.gradId = `graphPowGrad${graphPowGradSeq++}`;
    }
    // Top of the power trace's scale in %FTP. setTrace fills powerMax to 90% of
    // the plot height, so the value at y=0 is powerMax / 0.90 (the same figure
    // updateAxis prints at the top of the left axis).
    tracePowerMaxPct() {
        const ftp      = this.ftp || 200;
        const powerMax = this.powerMax || (ftp * 1.5);
        return (powerMax / 0.90) / ftp * 100;
    }
    connectedCallback() {
        const self = this;
        this.dom = {};
        this.$graphCont = document.querySelector('#graph-workout') ?? this;
        this.viewPort = this.getViewPort();
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        this.debounced = {
            onWindowResize: debounce(
                self.onWindowResize.bind(this), 300, {trailing: true, leading: false},
            ),
        };


        xf.sub(`db:workout`, this.onWorkout.bind(this), this.signal);
        xf.sub(`db:ftp`, this.onFTP.bind(this), this.signal);
        xf.sub('db:workoutIntensity', this.onIntensity.bind(this), this.signal);

        xf.sub('db:intervalIndex', this.onIntervalIndex.bind(this), this.signal);
        xf.sub('db:distance', this.onDistance.bind(this), this.signal);
        xf.sub('db:page', this.onPage.bind(this), this.signal);
        xf.sub('db:lapTime', this.onLapTime.bind(this), this.signal);
        xf.sub('db:workoutStatus', this.onWorkoutStatus.bind(this), this.signal);
        xf.sub('db:lock', this.onLock.bind(this), this.signal);
        xf.sub('db:power1s', this.onPower1s.bind(this), this.signal);
        xf.sub('db:heartRate', this.onHeartRate.bind(this), this.signal);
        xf.sub('db:cadence', this.onCadence.bind(this), this.signal);

        this.addEventListener('mousemove', this.onHover.bind(this), this.signal);
        this.addEventListener('mouseout', this.onMouseOut.bind(this), this.signal);

        // Scrub: drag the progress handle to seek (only when unlocked).
        this.lock = false;
        this.dragging = false;
        this.onScrubMove = this.onScrubMove.bind(this);
        this.onScrubEnd  = this.onScrubEnd.bind(this);
        this.addEventListener('pointerdown', this.onScrubStart.bind(this), this.signal);
        // window.addEventListener('resize', this.debounced.onWindowResize.bind(this), this.signal);
        window.addEventListener('resize', this.onWindowResize.bind(this), this.signal);

        this.bindZoomControls();
    }
    // The zoom / navigation buttons live in the profile head (outside this
    // element), so wire them up by id here and tear down via the same signal.
    bindZoomControls() {
        const on = (id, handler) => {
            const el = document.querySelector(id);
            if(exists(el)) el.addEventListener('click', handler, this.signal);
        };
        on('#profile-zoom-in',  () => this.setZoom(this.zoom * ZOOM_FACTOR));
        on('#profile-zoom-out', () => this.setZoom(this.zoom / ZOOM_FACTOR));
        on('#profile-zoom-fit', () => this.zoomFit());
        on('#profile-zoom-now', () => this.trackCurrent());
        // A manual scroll drops out of follow-current mode.
        this.$graphCont.addEventListener('scroll', this.onPlotScroll.bind(this), this.signal);
        this.updateNowButton();
        this.updateZoomControls();
    }
    // Reflect the current zoom on the readout and dim whichever of -/+ has
    // nowhere left to go. Also runs when the *range* changes (a new workout
    // moves zoomMax), which can disable + even though zoom has not moved.
    updateZoomControls() {
        const value = document.querySelector('#profile-zoom-value');
        // Native toFixed, not the helper: the readout wants a fixed "1.0×"
        // width, and the helper rounds to a number ("1×").
        if(exists(value)) value.textContent = `${this.zoom.toFixed(1)}×`;

        const dim = (id, disabled) => {
            const el = document.querySelector(id);
            if(exists(el)) el.classList.toggle('is-disabled', disabled);
        };
        dim('#profile-zoom-in',  !(this.zoom < this.zoomMax));
        dim('#profile-zoom-out', !(this.zoom > this.zoomMin));
    }
    // Derive zoomMax from the loaded workout so full zoom-in always shows the
    // same amount of time (MAX_ZOOM_VISIBLE_SECONDS) across the viewport.
    computeZoomMax() {
        const totalDuration = this.workout?.meta?.duration;
        this.zoomMax = exists(totalDuration) && totalDuration > 0
            ? Math.max(this.zoomMin, toFixed(totalDuration / MAX_ZOOM_VISIBLE_SECONDS, 2))
            : this.zoomMin;
        // A shorter workout may have lowered zoomMax below the current zoom.
        if(this.zoom > this.zoomMax) this.setZoom(this.zoomMax);
        this.updateZoomControls();
    }
    setZoom(zoom) {
        const clamped = clamp(this.zoomMin, this.zoomMax, toFixed(zoom, 2));
        if(equals(clamped, this.zoom)) return;
        const wasTracking = this.tracking;
        // Where the middle of the viewport sits in the workout right now. Held
        // across the zoom so the plot expands around what is on screen —
        // without it, scrollLeft stays put in pixels while the plot grows
        // underneath it and repeated + presses drift off towards the start.
        const anchor = this.viewportCentre();
        this.zoom = clamped;
        if(this.zoom <= 1) this.tracking = false; // nothing to follow when it all fits
        this.applyZoom();
        if(this.zoom > 1 && wasTracking) this.scrollToCurrent();
        else if(this.zoom <= 1) this.$graphCont.scrollLeft = 0;
        else this.scrollToFraction(anchor);
        this.updateNowButton();
        this.updateZoomControls();
    }
    // Re-render at the new zoom. render() writes the plot's zoom×100% width and
    // toggles the scroll class, so it must always run — refresh the measured
    // viewport too when it's measurable (used for bar heights / labels).
    applyZoom() {
        const viewPort = this.getViewPort();
        if(!equals(viewPort.width, 0)) this.viewPort = viewPort;
        this.render();
    }
    zoomFit() {
        this.tracking = false;
        this.setZoom(this.zoomMin);
        this.$graphCont.scrollLeft = 0;
        this.updateNowButton();
    }
    // Enter follow-current mode (only allowed when zoomed in) and centre on now.
    trackCurrent() {
        if(this.zoom <= 1) return;
        this.tracking = true;
        this.scrollToCurrent();
        this.updateNowButton();
    }
    onPlotScroll() {
        // Ignore the scroll we triggered ourselves; a user scroll ends tracking.
        if(this._programmaticScroll) { this._programmaticScroll = false; return; }
        this.stopTracking();
    }
    // Leave follow-current mode, if it was on, and dim the NOW pill.
    stopTracking() {
        if(!this.tracking) return;
        this.tracking = false;
        this.updateNowButton();
    }
    // Scroll the plot so the current-position line sits in the middle of the
    // viewport (no-op when not zoomed in — the whole workout is already shown).
    scrollToCurrent() {
        const cont = this.$graphCont;
        if(!exists(cont) || this.zoom <= 1) return;
        const current = parseFloat(this.dom?.progress?.style.width) || 0;
        const target  = clamp(0, cont.scrollWidth, current - (cont.clientWidth / 2));
        if(!equals(Math.round(target), Math.round(cont.scrollLeft))) {
            this._programmaticScroll = true;
            cont.scrollLeft = target;
        }
    }
    // How far through the workout the middle of the viewport is, 0..1.
    viewportCentre() {
        const cont = this.$graphCont;
        if(!exists(cont) || !(cont.scrollWidth > 0)) return 0.5;
        return clamp(0, 1, (cont.scrollLeft + (cont.clientWidth / 2)) / cont.scrollWidth);
    }
    // Put `fraction` of the way through the workout back under the middle of
    // the viewport. Counts as a programmatic scroll, so it does not cancel
    // follow-current the way a hand scroll does.
    scrollToFraction(fraction) {
        const cont = this.$graphCont;
        if(!exists(cont)) return;
        const max    = Math.max(0, cont.scrollWidth - cont.clientWidth);
        const target = clamp(0, max, (fraction * cont.scrollWidth) - (cont.clientWidth / 2));
        if(!equals(Math.round(target), Math.round(cont.scrollLeft))) {
            this._programmaticScroll = true;
            cont.scrollLeft = target;
        }
    }
    // NOW is highlighted only while actively following, and dimmed when zoomed
    // all the way out (where following is not available).
    updateNowButton() {
        const btn = document.querySelector('#profile-zoom-now');
        if(!exists(btn)) return;
        btn.classList.toggle('is-active', this.tracking && this.zoom > 1);
        btn.classList.toggle('is-disabled', this.zoom <= 1);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    getViewPort() {
        // const rect = this.getBoundingClientRect();
        const rect = this.$graphCont.getBoundingClientRect();
        // The plot renders `zoom`× the visible container width; the surplus
        // scrolls horizontally inside #graph-workout (see is-zoomed).
        const width = rect.width * this.zoom;

        return {
            width,
            baseWidth: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top,
            aspectRatio: width / rect.height,
        };
    }
    onFTP(value) {
        this.ftp = value;
        if(exists(this.workout.intervals)) this.render();
    }
    // The intensity stepper rescales every planned target, so the whole profile
    // is redrawn: block heights, watt labels, zone colours and the power axis.
    onIntensity(value) {
        if(equals(value, this.intensity)) return;
        this.intensity = value;
        if(exists(this.workout.intervals)) this.render();
    }
    onPage(page) {
        if(equals(page, 'home')) {
            const viewPort = this.getViewPort();
            this.viewPort = viewPort;
            this.render();
        }
    }
    onWindowResize(e) {
        const viewPort = this.getViewPort();
        if(equals(viewPort.width, 0)) return;
        this.viewPort = viewPort;
        this.render();
    }
    onHover(e) {
        const self = this;
        const target = this.querySelector('.graph--bar:hover');
        if(exists(target)) {
            const power        = target.getAttribute('power');
            const cadence      = target.getAttribute('cadence');
            const slope        = target.getAttribute('slope');
            const duration     = target.getAttribute('duration');
            const distance     = target.getAttribute('distance');
            const intervalRect = target.getBoundingClientRect();

            this.renderInfo({
                power,
                cadence,
                slope,
                duration,
                distance,
                intervalRect,
                contRect: self.getBoundingClientRect(),
                mouseX: e.clientX,
                mouseY: e.clientY,
                dom: self.dom,
            });
        }
    }
    onMouseOut(e) {
        this.dom.info.style.display = 'none';
    }
    onWorkout(value) {
        this.workout = value; // this.workout = Object.assign({}, value);

        if(exists(value.intervals)) {
            this.type = 'workout';
            this.computeZoomMax();
            this.intervalStarts = value.intervals.reduce((acc, interval) => {
                acc.list.push(acc.sum);
                acc.sum += interval.duration ?? 0;
                return acc;
            }, {list: [], sum: 0}).list;
            // Loading a different workout outside a session invalidates the
            // recorded traces (a running session keeps them: same workout object
            // is re-dispatched on restore).
            if(!equals(this.workoutStatus, 'started')) this.resetTraces();
        }
        if(exists(value.points)) {
            this.type = 'course';
        }

        if(!equals(this.viewPort.width, 0)) {
            this.render();
        }
    }
    onWorkoutStatus(value) {
        // A fresh start begins fresh traces (pause/resume does not touch
        // workoutStatus, so they survive it).
        if(equals(value, 'started') && !equals(this.workoutStatus, 'started')) {
            this.resetTraces();
            this.updateTrace();
        }
        this.workoutStatus = value;
    }
    // Seconds into the workout of the current position, derived from interval
    // index + countdown lap time — the same clock the progress line uses, so
    // the trace stays aligned after seeks/skips.
    workoutTimeAt() {
        const i        = this.index ?? 0;
        const start    = this.intervalStarts[i] ?? 0;
        const duration = this.workout?.intervals?.[i]?.duration ?? 0;
        const lapTime  = this.lapTime ?? duration;
        return start + clamp(0, duration, duration - lapTime);
    }
    // Append a sample to one of the recorded traces at the current workout time.
    // Returns whether it was recorded, so a caller only redraws when it was.
    sample(trace, value) {
        if(!equals(this.type, 'workout')) return false;
        if(!equals(this.workoutStatus, 'started')) return false;
        if(!exists(value)) return false;
        const t = this.workoutTimeAt();
        // After a backwards seek, re-riding a section overwrites its samples
        // so x stays monotonic and the line never doubles back.
        while(trace.length > 0 && last(trace).t >= t) trace.pop();
        trace.push({t, v: value});
        return true;
    }
    resetTraces() {
        this.powerTrace = [];
        this.hrTrace = [];
        this.cadenceTrace = [];
    }
    onPower1s(power) {
        if(this.sample(this.powerTrace, power)) this.updateTrace();
    }
    onHeartRate(heartRate) {
        if(this.sample(this.hrTrace, heartRate)) this.updateTrace();
    }
    onCadence(cadence) {
        if(this.sample(this.cadenceTrace, cadence)) this.updateTrace();
    }
    updateTrace() {
        const total = this.workout?.meta?.duration ?? 0;
        // Power shares the bars' vertical scale: powerToHeight fills powerMax to
        // 90% of the plot height, i.e. y = 100 - 90 * p / powerMax in the
        // viewBox. Heart rate and cadence have no relation to that scale, so
        // each uses the full plot height against its own right-hand axis.
        const powerMax = this.powerMax || ((this.ftp || 200) * 1.5);
        this.setTrace(this.dom?.tracePower,   this.powerTrace,   total, powerMax, 90);
        // The outline sits directly under the power line, so it takes the same
        // geometry — only its stroke (wider, dark) differs, and that is CSS.
        this.setTrace(this.dom?.tracePowerHalo, this.powerTrace, total, powerMax, 90);
        this.setTrace(this.dom?.traceHr,      this.hrTrace,      total, HR_AXIS_MAX, 100);
        this.setTrace(this.dom?.traceCadence, this.cadenceTrace, total, CADENCE_AXIS_MAX, 100);
    }
    // Write one trace's polyline. `fill` is how much of the plot height the
    // axis ceiling occupies, matching however that trace's scale is drawn.
    setTrace(line, trace, total, vmax, fill) {
        if(!exists(line)) return;
        if(total <= 0 || vmax <= 0 || trace.length < 2) {
            line.setAttribute('points', '');
            return;
        }
        const points = trace.map((s) => {
            const x = clamp(0, 100, (s.t / total) * 100);
            const y = 100 - clamp(0, 98, (s.v / vmax) * fill);
            return `${x.toFixed(3)},${y.toFixed(2)}`;
        }).join(' ');
        line.setAttribute('points', points);
    }
    onIntervalIndex(index) {
        const self = this;
        this.index = index;
        this.progress({index: self.index, dom: self.dom, parent: self, lapTime: self.lapTime});
    }
    onDistance(distance) {
        const self = this;
        if(exists(this.workout?.points)) {
            const totalDistance = this.workout.meta.distance;
            const $dom = self.dom;
            const $parent = self;
            const height = $parent.getBoundingClientRect().height;
            const width = $parent.getBoundingClientRect().width;
            const left = translate(distance, 0, totalDistance, 0, width);
            $dom.active.style.left   = `${left % width}px`;
            $dom.active.style.width  = `2px`;
            $dom.active.style.height = `${height}px`;

            if(equals(this.type, 'course')) {
                $dom.progress.style.left   = `${left % width}px`;
            }
        }
        return;
    }
    onLapTime(lapTime) {
        const self = this;
        this.lapTime = lapTime;
        if(equals(this.type, 'workout')) {
            this.progress({index: self.index, dom: self.dom, parent: self, lapTime: self.lapTime});
        }
    }
    progress(args = {}) {
        if(this.workoutStatus === "done") {
            return;
        }

        const index                 = args.index ?? 0;
        const lapTime               = args.lapTime ?? this.workout.intervals[index].duration;
        const $dom                  = args.dom;
        const $parent               = args.parent;
        const rect                  = $dom.intervals[index].getBoundingClientRect();
        const left                  = rect.left - $parent.getBoundingClientRect().left;
        const lapPercentageComplete = 1 - (lapTime / this.workout.intervals[index].duration);

        $dom.active.style.left   = `${left}px`;
        $dom.active.style.width  = `${rect.width}px`;
        $dom.active.style.height = `${$parent.getBoundingClientRect().height}px`;

        $dom.progress.style.width = `${left + (rect.width * lapPercentageComplete)}px`;

        // Follow the current position while tracking is on.
        if(this.tracking) this.scrollToCurrent();
    }
    onLock(lock) {
        this.lock = lock;
        this.updateLockState();
    }
    updateLockState() {
        // Handle is only grabbable when the controls are unlocked.
        if(exists(this.dom?.handle)) {
            this.dom.handle.classList.toggle('is-locked', !!this.lock);
        }
    }
    // Rewrite the fixed % axis to reflect the workout's own power range, showing
    // both the %-of-FTP tick and the absolute watts it corresponds to.
    updateAxis(powerMax, ftp) {
        const axis = document.querySelector('.watts-profile--axis-pow');
        if(!exists(axis) || !ftp || !powerMax) return;
        // powerToHeight fills to 90% of the plot, so the value at the very top
        // of the plot is powerMax / 0.90.
        const topWatts = (powerMax / 0.90);
        const topPct   = Math.round(topWatts / ftp * 100);
        const spans    = axis.querySelectorAll('span');
        if(spans.length < 4) return;
        const fractions = [1, 2 / 3, 1 / 3, 0];
        fractions.forEach((frac, i) => {
            const pct   = Math.round(topPct * frac);
            const watts = Math.round(topWatts * frac);
            const b = spans[i].querySelector('b');
            const w = spans[i].querySelector('i');
            if(b) b.textContent = `${pct}%`;
            if(w) w.textContent = `${watts}`;
        });
    }
    onScrubStart(e) {
        if(this.lock) return;
        if(!exists(e.target?.closest?.('#progress-handle'))) return;
        e.preventDefault();
        this.dragging = true;
        this.classList.add('is-scrubbing');
        window.addEventListener('pointermove', this.onScrubMove, this.signal);
        window.addEventListener('pointerup',   this.onScrubEnd,  this.signal);
    }
    onScrubMove(e) {
        if(!this.dragging) return;
        const rect = this.getBoundingClientRect();
        const x    = clamp(0, rect.width, e.clientX - rect.left);
        // Preview: move the progress line (and its handle) to the cursor.
        this.dom.progress.style.width = `${x}px`;
    }
    onScrubEnd(e) {
        if(!this.dragging) return;
        this.dragging = false;
        this.classList.remove('is-scrubbing');
        window.removeEventListener('pointermove', this.onScrubMove);
        window.removeEventListener('pointerup',   this.onScrubEnd);

        const target = this.stepAtX(e.clientX);
        if(exists(target) && this.workoutStatus === 'started') {
            xf.dispatch('ui:watchGoto', target);
        } else {
            // Not running (or no target) — snap the line back to the real position.
            this.progress({index: this.index, dom: this.dom, parent: this, lapTime: this.lapTime});
        }
    }
    // Map an x coordinate to the interval/step under it, plus how far (in
    // seconds) into that step the cursor sits — so a drop can land anywhere in a
    // block, not just snap to its edge.
    stepAtX(clientX) {
        const rect   = this.getBoundingClientRect();
        const x      = clamp(0, rect.width, clientX - rect.left);
        const groups = this.querySelectorAll('.graph--bar-group');
        for(const group of groups) {
            const gRect = group.getBoundingClientRect();
            const left  = gRect.left - rect.left;
            if(x >= left && x <= left + gRect.width) {
                const intervalIndex = parseInt(group.dataset.interval ?? '0', 10);
                let stepIndex   = 0;
                let stepElapsed = 0;
                for(const bar of group.querySelectorAll('.graph--bar')) {
                    const bRect = bar.getBoundingClientRect();
                    const bLeft = bRect.left - rect.left;
                    if(x >= bLeft && x <= bLeft + bRect.width) {
                        stepIndex = parseInt(bar.dataset.step ?? '0', 10);
                        const frac = bRect.width > 0
                            ? clamp(0, 1, (x - bLeft) / bRect.width) : 0;
                        const step = this.workout?.intervals?.[intervalIndex]
                            ?.steps?.[stepIndex];
                        stepElapsed = frac * (step?.duration ?? 0);
                        break;
                    }
                }
                return { intervalIndex, stepIndex, stepElapsed };
            }
        }
        return null;
    }
    render() {
        const self = this;
        const progress = `<div id="progress" class="progress"><div id="progress-handle" class="scrub-handle"></div></div><div id="progress-active"></div>`;

        // Widen the plot to zoom×100% of the scroll viewport and let #graph-workout
        // scroll the overflow. Each interval bar keeps a % share of the plot (see
        // intervalsToGraph), so the bars scale purely via CSS as this width grows —
        // no pixel measurement, which is why the old measured-px approach silently
        // did nothing. min-width:100% (CSS) keeps it filling the viewport at 1×.
        const zoomed = this.zoom > 1;
        this.$graphCont.classList.toggle('is-zoomed', zoomed);
        this.style.width = zoomed ? `${this.zoom * 100}%` : '';
        this.style.right = zoomed ? 'auto' : '';

        if(equals(this.type, 'workout')) {
            // Drawn back-to-front: cadence, then heart rate, then power on top —
            // power is the line the rider is steering by, so it never gets
            // hidden underneath the other two where they cross.
            const polyline = (name) =>
                `<polyline class="graph--trace-${name}" fill="none" ` +
                `vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
            // The recorded-power line is stroked with the same vertical zone
            // gradient as the home screen's power history, so its colour reads
            // as the zone the rider was in. userSpaceOnUse pins the bands to the
            // plot's own scale (y 0..100 of the viewBox) — the default
            // objectBoundingBox would stretch them over the stroke's bounding
            // box, painting a flat trace with the whole ramp.
            this.powerMax = intervalsToMaxPower(
                this.workout.intervals, this.ftp, this.intensity);
            const traces =
                `<svg class="graph--traces" viewBox="0 0 100 100" preserveAspectRatio="none">` +
                `<defs><linearGradient id="${this.gradId}" gradientUnits="userSpaceOnUse" ` +
                `x1="0" y1="0" x2="0" y2="100">${zoneGradientStops(this.tracePowerMaxPct())}` +
                `</linearGradient></defs>` +
                polyline('cad') + polyline('hr') +
                // The power line is drawn twice: a wider dark copy underneath
                // gives it an outline, so a zone colour never disappears into a
                // bar of the same colour (e.g. a red trace over a Z6 block).
                // Same points, written by updateTrace along with the line itself.
                polyline('halo') +
                `<polyline class="graph--trace-pow" fill="none" stroke="url(#${this.gradId})" ` +
                `vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
                `</svg>`;
            this.innerHTML = progress +
                intervalsToGraph(this.workout, this.ftp, this.viewPort, this.intensity) +
                traces;

            this.dom.info      = this.querySelector('.graph--info--cont');
            this.dom.progress  = this.querySelector('#progress');
            this.dom.handle    = this.querySelector('#progress-handle');
            this.dom.active    = this.querySelector('#progress-active');
            this.dom.intervals = this.querySelectorAll('.graph--bar-group');
            this.dom.steps     = this.querySelectorAll('.graph--bar');
            this.dom.tracePower   = this.querySelector('.graph--trace-pow');
            this.dom.tracePowerHalo = this.querySelector('.graph--trace-halo');
            this.dom.traceHr      = this.querySelector('.graph--trace-hr');
            this.dom.traceCadence = this.querySelector('.graph--trace-cad');

            this.updateAxis(this.powerMax, this.ftp);
            this.updateTrace();
            this.updateLockState();
            this.progress({index: self.index, dom: self.dom, parent: self, lapTime: self.lapTime});
        }

        if(equals(this.type, 'course')) {
            this.innerHTML = progress +
                courseToGraph(this.workout, this.viewPort);

            this.dom.info     = this.querySelector('.graph--info--cont');
            this.dom.progress = this.querySelector('#progress');
            this.dom.active   = this.querySelector('#progress-active');
        }
    }
    renderInfo(args = {}) {
        renderInfo(args);
    }
}

customElements.define('workout-graph', WorkoutGraph);



function Segment(points, prop) {
    return points.reduce((acc, point, i) => {
        const value = point[prop];
        if(value > acc.max) acc.max = value;
        if(value < acc.min) acc.min = value;
        if(equals(i, 0)) { acc.min = value; acc.start = value; };
        if(equals(i, points.length-1)) acc.end = value;
        return acc;
    }, {min: 0, max: 0, start: 0, end: 0,});
}

function scale(value, max = 100) {
    return 100 * (value/max);
}

function courseToGraph(course, viewPort) {
    const altitudeSpec  = Segment(course.points, 'y');

    const distanceTotal = course.meta.distance;
    const aspectRatio   = viewPort.aspectRatio;
    const yOffset       = Math.min(altitudeSpec.min, altitudeSpec.start, altitudeSpec.end);
    const yMax          = (altitudeSpec.max - altitudeSpec.min);
    const yScale        = (1 / ((aspectRatio * yMax) / distanceTotal));
    const flatness      = ((altitudeSpec.max - altitudeSpec.min));
    const altitudeScale = yScale * ((flatness < 100) ? 0.2 : 0.7);

    const viewBox = { width: distanceTotal, height: yMax, };

    // console.table({distanceTotal, yMax, aspectRatio, yScale, flatness, altitudeScale, altitudeSpec});

    const track = course.pointsSimplified.reduce((acc, p, i, xs) => {
        const color = g.slopeToColor(p.slope);

        const px1 = p.x;
        const px2 = xs[i+1]?.x ?? px1;
        const py1 = p.y;
        const py2 = xs[i+1]?.y ?? py1;

        const x1 = px1;
        const y1 = yMax;
        const x2 = px1;
        const y2 = yMax - ((py1-yOffset) * altitudeScale);
        const x3 = px2;
        const y3 = yMax - ((py2-yOffset) * altitudeScale);
        const x4 = px2;
        const y4 = yMax;

        return acc + `<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3} ${x4},${y4}" stroke="none" fill="${color}" class="graph--bar" index="${i}" slope="${p.slope}" />`;

    }, ``);

    const display =
          `<altitude-value class="elevation--value altitude--value">${altitudeSpec.start ?? '--'}</altitude-value>
        <ascent-value class="elevation--value ascent--value">0.0</ascent-value>`;

    return `${display}<div class="graph--info--cont"></div><svg class="graph--bar-group" width="100%" height="100%" viewBox="0 0 ${viewBox.width} ${viewBox.height}" preserveAspectRatio="xMinYMax meet">${track}</svg>`;
}

export {
    WorkoutGraph,
    intervalsToGraph,
    courseToGraph,
    renderInfo,
};

