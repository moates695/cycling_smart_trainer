/**
 * @jest-environment jsdom
 */

//
// Deleting is the one action in the library that can't be undone, and both
// delete buttons sit a tap away from things a rider does mid-session (Download
// .fit, Duplicate). Neither may reach the store until the dialog is confirmed.
//

import { xf } from '../../src/functions.js';
import { workouts } from '../../src/workouts/workouts.js';
import { zwo } from '../../src/workouts/zwo.js';
import { workoutTemplate } from '../../src/views/workout-list.js';
import '../../src/views/activity-list.js';
// defines <view-action>, the chip the expanded row's Delete button is made of
import '../../src/views/data-views.js';

const FTP = 200;

function click(el) {
    el.dispatchEvent(new Event('pointerup', {bubbles: true}));
}

// Record every dispatch of the given event types.
function spyOn(types) {
    const seen = [];
    types.forEach((type) => xf.sub(type, (data) => seen.push({type, data})));
    return seen;
}

function backdrop() {
    return document.querySelector('.wl-modal-backdrop');
}

afterEach(() => {
    document.body.innerHTML = '';
    document.querySelectorAll('.wl-modal-backdrop').forEach((el) => el.remove());
});

// jsdom 16 ignores addEventListener's `signal` option, so a row that has been
// torn down here still hears `action:activity:<id>`. Give every test its own
// activity id rather than letting a previous row answer for this one.
describe('deleting a completed ride', () => {
    function mount(id, name = 'Morning Ride') {
        document.body.innerHTML = `<activity-list></activity-list>`;
        xf.dispatch('db:activity', {activity: [{id, name, timestamp: Date.now()}]});
        const item = document.querySelector('activity-item');
        // the Delete chip lives in the expanded half of the row
        click(item.querySelector('.watts-arow--head'));
        return item;
    }

    function pressDelete(item) {
        click(item.querySelector('view-action[action=":remove"]'));
    }

    test('asks first, and removes nothing until confirmed', () => {
        const item = mount('a-1');
        const seen = spyOn(['ui:activity:remove']);

        pressDelete(item);

        expect(backdrop()).not.toBeNull();
        expect(seen).toEqual([]);
        expect(document.querySelector('activity-item')).not.toBeNull();
    });

    test('names the ride it is about to delete', () => {
        pressDelete(mount('a-2', 'Threshold 4x8'));

        expect(backdrop().querySelector('.wl-modal-body').textContent)
            .toContain('Threshold 4x8');
    });

    test('confirming removes it from the store and the list', () => {
        const item = mount('a-3');
        const seen = spyOn(['ui:activity:remove']);

        pressDelete(item);
        click(backdrop().querySelector('.wl-confirm'));

        expect(seen).toEqual([{type: 'ui:activity:remove', data: 'a-3'}]);
        expect(document.querySelector('activity-item')).toBeNull();
        expect(backdrop()).toBeNull();
    });

    test('cancelling leaves the ride where it is', () => {
        const item = mount('a-4');
        const seen = spyOn(['ui:activity:remove']);

        pressDelete(item);
        click(backdrop().querySelector('.wl-cancel'));

        expect(seen).toEqual([]);
        expect(document.querySelector('activity-item')).not.toBeNull();
        expect(backdrop()).toBeNull();
    });
});

describe('deleting a custom workout', () => {
    function mount(id = 'w-1') {
        const parsed = zwo.readToInterval(workouts[0]);
        document.body.innerHTML = workoutTemplate({...parsed, id, isDefault: false}, FTP);
        return document.querySelector('workout-item');
    }

    function pressDelete(item) {
        click(item.querySelector('.watts-wrow--options'));
        click(item.querySelector('.watts-wmenu--item[data-action="delete"]'));
    }

    test('asks first, and removes nothing until confirmed', () => {
        const item = mount('w-3');
        const seen = spyOn(['ui:workout:remove']);

        pressDelete(item);

        expect(backdrop()).not.toBeNull();
        expect(seen).toEqual([]);
    });

    test('confirming removes it', () => {
        const item = mount('w-3');
        const seen = spyOn(['ui:workout:remove']);

        pressDelete(item);
        click(backdrop().querySelector('.wl-confirm'));

        expect(seen).toEqual([{type: 'ui:workout:remove', data: 'w-3'}]);
        expect(backdrop()).toBeNull();
    });

    test('cancelling keeps it', () => {
        const item = mount('w-3');
        const seen = spyOn(['ui:workout:remove']);

        pressDelete(item);
        click(backdrop().querySelector('.wl-cancel'));

        expect(seen).toEqual([]);
        expect(backdrop()).toBeNull();
    });
});
