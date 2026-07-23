import { xf, exists, existance, equals, clamp, debounce, toFixed  } from '../functions.js';
import { formatTime, translate } from '../utils.js';
import { models } from '../models/models.js';
import { zoneClassByPct } from './watts.js';
import { g } from './graph.js';



function powerToHeight(power, powerMax, viewPort) {
    const height = translate(power, 0, powerMax, 0, viewPort.height * 0.90);
    // console.log(`${viewPort.height} -> ${height}`);
    if(height < (viewPort.height * 0.10)) {
        return viewPort.height * 0.14;
    }
    return height;
}

function intervalToWidth(intervalDuration, totalDuration, totalWidth) {
    return clamp(1,
                 totalDuration,
                 translate(intervalDuration, 0, totalDuration, 0, totalWidth)
                );
}

function intervalsToMaxPower(intervals, ftp) {
    // Scale the plot to the workout's own peak power (not a fixed 160%-FTP
    // ceiling). powerToHeight fills to 90% of the plot, so the tallest block
    // sits slightly below the top — "slightly higher than the loaded workout".
    const peak = intervals.reduce((highest, interval) => {
        interval.steps.forEach((step) => {
            const power = models.ftp.toAbsolute(step.power, ftp);
            if(power > highest) highest = power;
        });
        return highest;
    }, 0);
    return peak > 0 ? peak : (ftp * 1.5);
}

function Interval(acc, interval, width, ftp, powerMax, viewPort, intervalIndex = 0) {
    const stepsLength = interval.steps.length;

    // Persistent per-interval labels: peak watts above the block, total time at
    // its base. Shown on every interval wide enough to read without clutter
    // (was previously limited to work blocks, which hid the labels on recovery
    // and on workouts with narrower intervals).
    const peakPower = interval.steps.reduce(
        (m, step) => Math.max(m, models.ftp.toAbsolute(step.power, ftp) ?? 0), 0);
    const wideEnough = width >= 12;  // anything wider than a sliver gets labels
    const narrow     = width < 40;   // too tight for horizontal text → go vertical
    // Drop the leading zero from the minutes/hours (e.g. "02:00" → "2:00",
    // "00:30" → "0:30") — local to the profile label, formatTime is untouched.
    const durationLabel = exists(interval.duration)
        ? formatTime({value: interval.duration, format: 'mm:ss'}).replace(/^0/, '') : '';
    const labels = wideEnough
        ? `<div class="graph--bar-watt">${Math.round(peakPower)}</div>` +
          `<div class="graph--bar-dur">${durationLabel}</div>`
        : '';
    const groupClass = `graph--bar-group${narrow ? ' is-narrow' : ''}`;

    return acc + interval.steps.reduce((a, step, stepIndex) => {
        const power    = models.ftp.toAbsolute(step.power, ftp) ?? 0;
        const cadence  = step.cadence;
        const slope    = step.slope;
        const duration = step.duration;
        const width    = 100 / stepsLength;
        const height   = powerToHeight(power, powerMax, viewPort);
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

        return a +
            `<div class="graph--bar zone-${zone}" style="height: ${height}px; width: ${width}%" data-step="${stepIndex}" ${powerAttr} ${cadenceAttr} ${slopeAttr} ${durationAttr}></div>`;
    }, `<div class="${groupClass}" data-interval="${intervalIndex}" style="width: ${width}px;">${labels}`) + `</div>`;
}

function intervalsToGraph(workout, ftp, viewPort) {
    const totalWidth    = viewPort.width;
    const intervals     = workout.intervals;
    const totalDuration = workout.meta.duration;
    const maxPower      = intervalsToMaxPower(intervals, ftp);

    return intervals.reduce((acc, interval, intervalIndex) => {
        let width = 1;

        if(exists(interval.duration)) {
            width = intervalToWidth(interval.duration, totalDuration, totalWidth);
            return Interval(acc, interval, width, ftp, maxPower, viewPort, intervalIndex);
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

    const intervalLeft = args.intervalRect.left;
    const contLeft     = args.contRect.left;
    const contWidth    = args.contRect.width;
    const left         = intervalLeft - contLeft;
    const bottom       = args.intervalRect.height;

    dom.info.style.display = 'block';
    dom.info.innerHTML = `<div>${power}</div><div>${cadence}</div><div>${slope}</div><div class="graph--info--time">${duration}</div>`;

    const width  = dom.info.getBoundingClientRect().width;
    const height = dom.info.getBoundingClientRect().height;
    const minHeight = (bottom + height + (40)); // fix 40
    dom.info.style.left = `min(${contWidth}px - ${width}px, ${left}px)`;

    if(window.innerHeight > minHeight) {
        dom.info.style.bottom = bottom;
    } else {
        dom.info.style.bottom = bottom - (minHeight - window.innerHeight);
    }
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

        xf.sub('db:intervalIndex', this.onIntervalIndex.bind(this), this.signal);
        xf.sub('db:distance', this.onDistance.bind(this), this.signal);
        xf.sub('db:page', this.onPage.bind(this), this.signal);
        xf.sub('db:lapTime', this.onLapTime.bind(this), this.signal);
        xf.sub('db:workoutStatus', this.onWorkoutStatus.bind(this), this.signal);
        xf.sub('db:lock', this.onLock.bind(this), this.signal);

        this.addEventListener('mouseover', this.onHover.bind(this), this.signal);
        this.addEventListener('mouseout', this.onMouseOut.bind(this), this.signal);

        // Scrub: drag the progress handle to seek (only when unlocked).
        this.lock = false;
        this.dragging = false;
        this.onScrubMove = this.onScrubMove.bind(this);
        this.onScrubEnd  = this.onScrubEnd.bind(this);
        this.addEventListener('pointerdown', this.onScrubStart.bind(this), this.signal);
        // window.addEventListener('resize', this.debounced.onWindowResize.bind(this), this.signal);
        window.addEventListener('resize', this.onWindowResize.bind(this), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    getViewPort() {
        // const rect = this.getBoundingClientRect();
        const rect = this.$graphCont.getBoundingClientRect();

        return {
            width: rect.width,
            height: rect.height,
            left: rect.left,
            aspectRatio: rect.width / rect.height,
        };
    }
    onFTP(value) {
        this.ftp = value;
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
                contRect: self.viewPort,
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
        }
        if(exists(value.points)) {
            this.type = 'course';
        }

        if(!equals(this.viewPort.width, 0)) {
            this.render();
        }
    }
    onWorkoutStatus(value) {
        this.workoutStatus = value;
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

        if(equals(this.type, 'workout')) {
            this.innerHTML = progress +
                intervalsToGraph(this.workout, this.ftp, this.viewPort);

            this.dom.info      = this.querySelector('.graph--info--cont');
            this.dom.progress  = this.querySelector('#progress');
            this.dom.handle    = this.querySelector('#progress-handle');
            this.dom.active    = this.querySelector('#progress-active');
            this.dom.intervals = this.querySelectorAll('.graph--bar-group');
            this.dom.steps     = this.querySelectorAll('.graph--bar');

            this.updateAxis(intervalsToMaxPower(this.workout.intervals, this.ftp), this.ftp);
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

