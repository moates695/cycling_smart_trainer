/**
 * @jest-environment jsdom
 */

//
// The library row's load-selector: the control that decides which workout is
// loaded on the ride screen. Only one can be selected at a time (db.workout is
// a single value), and taking the selection away from a workout that is being
// ridden has to be confirmed first.
//

import { xf } from '../../src/functions.js';
import { workouts } from '../../src/workouts/workouts.js';
import { zwo } from '../../src/workouts/zwo.js';
import { workoutTemplate } from '../../src/views/workout-list.js';

const FTP = 200;

function mount(id = 'w-1', isDefault = false) {
    const parsed = zwo.readToInterval(workouts[0]);
    const workout = {...parsed, id, isDefault};
    document.body.innerHTML = workoutTemplate(workout, FTP);
    return document.querySelector('workout-item');
}

function click(el) {
    el.dispatchEvent(new Event('pointerup', {bubbles: true}));
}

// db:* events carry the whole store, and xf hands the subscriber the field
// named in the event (see XF.sub).
function setStore(field, value) {
    xf.dispatch(`db:${field}`, {[field]: value});
}

// Record every dispatch of the given event types.
function spyOn(types) {
    const seen = [];
    types.forEach((type) => xf.sub(type, (data) => seen.push({type, data})));
    return seen;
}

afterEach(() => {
    document.body.innerHTML = '';
    document.querySelectorAll('.wl-modal-backdrop').forEach((el) => el.remove());
});

describe('load-selector', () => {
    test('sits at the far left of the row, ahead of the thumbnail', () => {
        const item = mount();
        const head = item.querySelector('.watts-wrow--head');
        expect(head.firstElementChild.className).toBe('watts-wsel');
        expect(head.firstElementChild.nextElementSibling.className)
            .toMatch(/watts-wmini/);
    });

    test('selecting loads the workout without leaving the page', () => {
        const item = mount('w-42');
        const seen = spyOn(['ui:workout:select', 'ui:page-set']);

        click(item.querySelector('.watts-wsel'));

        expect(seen).toEqual([{type: 'ui:workout:select', data: 'w-42'}]);
    });

    test('selecting does not expand the row', () => {
        const item = mount();
        click(item.querySelector('.watts-wsel'));
        expect(item.classList.contains('is-expanded')).toBe(false);
    });

    test('follows db.workout, so only the loaded workout reads as selected', () => {
        const item = mount('w-1');
        const button = item.querySelector('.watts-wsel');

        setStore('workout', {id: 'w-1'});
        expect(item.classList.contains('is-selected')).toBe(true);
        expect(button.getAttribute('aria-checked')).toBe('true');

        // something else was loaded — from the other library tab, say
        setStore('workout', {id: 'w-2'});
        expect(item.classList.contains('is-selected')).toBe(false);
        expect(button.getAttribute('aria-checked')).toBe('false');
    });
});

describe('loading over a workout in progress', () => {
    function mountRunning() {
        const item = mount('w-new');
        setStore('workout', {id: 'w-old'});
        setStore('workoutStatus', 'started');
        return item;
    }

    test('asks before taking over, and loads nothing until confirmed', () => {
        const item = mountRunning();
        const seen = spyOn(['ui:workout:select', 'ui:watchStop']);

        click(item.querySelector('.watts-wsel'));

        expect(document.querySelector('.wl-modal-backdrop')).not.toBeNull();
        expect(seen).toEqual([]);
    });

    test('confirming stops the ride — without a second prompt — then loads', () => {
        const item = mountRunning();
        const seen = spyOn(['ui:workout:select', 'ui:watchStop']);

        click(item.querySelector('.watts-wsel'));
        click(document.querySelector('.wl-modal-backdrop .wl-confirm'));

        expect(seen).toEqual([
            {type: 'ui:watchStop', data: {confirmed: true}},
            {type: 'ui:workout:select', data: 'w-new'},
        ]);
        expect(document.querySelector('.wl-modal-backdrop')).toBeNull();
    });

    test('cancelling leaves the ride alone', () => {
        const item = mountRunning();
        const seen = spyOn(['ui:workout:select', 'ui:watchStop']);

        click(item.querySelector('.watts-wsel'));
        click(document.querySelector('.wl-modal-backdrop .wl-cancel'));

        expect(seen).toEqual([]);
        expect(document.querySelector('.wl-modal-backdrop')).toBeNull();
    });

    test('START goes through the same guard', () => {
        const item = mountRunning();
        const seen = spyOn(['ui:workout:select', 'ui:page-set']);

        click(item.querySelector('.watts-start-pill'));
        expect(seen).toEqual([]);

        click(document.querySelector('.wl-modal-backdrop .wl-confirm'));
        expect(seen).toEqual([
            {type: 'ui:workout:select', data: 'w-new'},
            {type: 'ui:page-set', data: 'home'},
        ]);
    });

    test('re-starting the workout already loaded needs no confirmation', () => {
        const item = mount('w-1');
        setStore('workout', {id: 'w-1'});
        setStore('workoutStatus', 'started');
        const seen = spyOn(['ui:page-set']);

        click(item.querySelector('.watts-start-pill'));

        expect(document.querySelector('.wl-modal-backdrop')).toBeNull();
        expect(seen).toEqual([{type: 'ui:page-set', data: 'home'}]);
    });

    test('no ride under way means no confirmation', () => {
        const item = mount('w-new');
        setStore('workout', {id: 'w-old'});
        setStore('workoutStatus', 'stopped');
        const seen = spyOn(['ui:workout:select']);

        click(item.querySelector('.watts-wsel'));

        expect(document.querySelector('.wl-modal-backdrop')).toBeNull();
        expect(seen).toEqual([{type: 'ui:workout:select', data: 'w-new'}]);
    });
});

describe('expand chevron', () => {
    test('is a drawn icon, and the row marks its own expanded state', () => {
        const item = mount();
        const chev = item.querySelector('.watts-chev');
        // rotation is CSS off .is-expanded, so there is no glyph to swap
        expect(chev.querySelector('svg.watts-chev--icon')).not.toBeNull();
        expect(chev.textContent.trim()).toBe('');

        click(item.querySelector('.watts-wrow--name'));
        expect(item.classList.contains('is-expanded')).toBe(true);
        expect(item.querySelector('svg.watts-chev--icon')).not.toBeNull();

        click(item.querySelector('.watts-wrow--name'));
        expect(item.classList.contains('is-expanded')).toBe(false);
    });
});
