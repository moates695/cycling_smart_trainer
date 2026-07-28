/**
 * @jest-environment jsdom
 */

//
// The profile's zoom controls. Zoom is geometric (every -/+ press is the same
// perceived change) and zoomMax is derived from the workout's length, so full
// zoom-in always shows the same span of time. These cover that range, the
// stepping and its limits, and the viewport anchoring that makes a press feel
// like the plot is expanding rather than scrolling away.
//

import { WorkoutGraph } from '../../src/views/workout-graph.js';

const ZOOM_FACTOR = 1.5;

// The zoom controls live in the profile head, outside <workout-graph>, and are
// wired up by id — so the test needs that markup on the page.
function head() {
    document.body.innerHTML = `
        <div id="profile-zoom-out" class="watts-zoom--btn">−</div>
        <div id="profile-zoom-value">1.0×</div>
        <div id="profile-zoom-in" class="watts-zoom--btn">+</div>
        <div id="profile-zoom-fit"></div>
        <div id="profile-zoom-now"></div>
        <div id="graph-workout"></div>`;
}

// A graph wired to the head controls but not mounted: connectedCallback needs a
// laid-out viewport, and render() is irrelevant to the zoom maths.
function graph({duration = 3600} = {}) {
    head();
    const el = document.createElement('workout-graph');
    el.dom = {};
    el.$graphCont = document.querySelector('#graph-workout');
    el.abortController = new AbortController();
    el.signal = {signal: el.abortController.signal};
    el.type = 'workout';
    el.workout = {meta: {duration}, intervals: []};
    el.applyZoom = () => {};                 // no layout to re-render
    el.bindZoomControls();
    el.computeZoomMax();
    return el;
}

function click(id) {
    document.querySelector(id).dispatchEvent(new MouseEvent('click', {bubbles: true}));
}
function disabled(id) {
    return document.querySelector(id).classList.contains('is-disabled');
}
function readout() { return document.querySelector('#profile-zoom-value').textContent; }

afterEach(() => { document.body.innerHTML = ''; });

describe('zoom range', () => {
    test('full zoom-in shows a fixed span of time, whatever the workout length', () => {
        expect(graph({duration: 3600}).zoomMax).toBe(30);  // 3600 / 120
        expect(graph({duration: 7200}).zoomMax).toBe(60);
    });

    test('a workout too short to zoom pins the range at 1×', () => {
        const el = graph({duration: 90}); // under MAX_ZOOM_VISIBLE_SECONDS
        expect(el.zoomMax).toBe(el.zoomMin);
        expect(disabled('#profile-zoom-in')).toBe(true);
        expect(disabled('#profile-zoom-out')).toBe(true);
    });
});

describe('zoom buttons', () => {
    test('+ and - step by one zoom factor', () => {
        const el = graph({duration: 3600});

        click('#profile-zoom-in');
        expect(el.zoom).toBeCloseTo(ZOOM_FACTOR, 2);
        expect(readout()).toBe(`${el.zoom.toFixed(1)}×`);

        click('#profile-zoom-in');
        expect(el.zoom).toBeCloseTo(ZOOM_FACTOR * ZOOM_FACTOR, 1);

        click('#profile-zoom-out');
        expect(el.zoom).toBeCloseTo(ZOOM_FACTOR, 1);
    });

    test('the steps stop at the ends of the range', () => {
        const el = graph({duration: 3600});

        for(let i = 0; i < 20; i++) click('#profile-zoom-in');
        expect(el.zoom).toBe(30);
        expect(disabled('#profile-zoom-in')).toBe(true);
        expect(disabled('#profile-zoom-out')).toBe(false);

        for(let i = 0; i < 20; i++) click('#profile-zoom-out');
        expect(el.zoom).toBe(1);
        expect(disabled('#profile-zoom-out')).toBe(true);
        expect(disabled('#profile-zoom-in')).toBe(false);
    });

    test('FIT returns to 1× and updates the readout', () => {
        const el = graph({duration: 3600});
        el.setZoom(8);
        expect(readout()).toBe('8.0×');

        click('#profile-zoom-fit');
        expect(el.zoom).toBe(1);
        expect(readout()).toBe('1.0×');
    });
});

describe('zoom anchoring', () => {
    // Stand in for the scroll viewport: 400px of window over a plot that is
    // zoom × 400 wide, scrolled to `scrollLeft`.
    function viewport(el, {scrollLeft, zoom}) {
        const cont = el.$graphCont;
        Object.defineProperty(cont, 'clientWidth', {value: 400, configurable: true});
        Object.defineProperty(cont, 'scrollWidth', {value: 400 * zoom, configurable: true});
        cont.scrollLeft = scrollLeft;
    }

    test('zooming keeps what was in the middle of the viewport in the middle', () => {
        const el = graph({duration: 3600});
        el.zoom = 4;
        viewport(el, {scrollLeft: 1000, zoom: 4}); // centre = (1000+200)/1600 = 75%

        // applyZoom would re-render and widen the plot; stand in for that.
        el.applyZoom = () => viewport(el, {scrollLeft: el.$graphCont.scrollLeft, zoom: 8});
        el.setZoom(8);

        // 75% through a 3200px plot, less half a viewport.
        expect(el.$graphCont.scrollLeft).toBe((0.75 * 3200) - 200);
    });

    test('an anchored scroll does not cancel follow-current', () => {
        const el = graph({duration: 3600});
        el.zoom = 4;
        el.tracking = true;
        viewport(el, {scrollLeft: 1000, zoom: 4});
        el.applyZoom = () => viewport(el, {scrollLeft: el.$graphCont.scrollLeft, zoom: 8});

        el.setZoom(8);
        el.onPlotScroll(); // the scroll event the assignment above would fire
        expect(el.tracking).toBe(true);
    });

    test('zooming back out to fit returns to the start', () => {
        const el = graph({duration: 3600});
        el.zoom = 4;
        viewport(el, {scrollLeft: 1000, zoom: 4});
        el.applyZoom = () => viewport(el, {scrollLeft: el.$graphCont.scrollLeft, zoom: 1});

        el.setZoom(1);
        expect(el.$graphCont.scrollLeft).toBe(0);
    });
});
