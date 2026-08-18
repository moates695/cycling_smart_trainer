/**
 * @jest-environment jsdom
 */

//
// The top-bar chips carry effect="replace" so a tap searches for another
// device instead of dropping the one that is connected. Every other switch
// keeps the default toggle.
//

import { xf } from '../../src/functions.js';
import '../../src/views/connection-switch.js';

function mount(html) {
    document.body.innerHTML = html;
    return document.body.firstElementChild;
}

function click(el) {
    el.dispatchEvent(new window.Event('pointerup'));
}

function record(eventType) {
    const seen = [];
    xf.sub(eventType, () => seen.push(eventType));
    return seen;
}

describe('connection-switch', () => {
    test('defaults to the toggle effect', () => {
        const seen = record('ui:ble:powerMeter:switch');
        const el = mount(`<connection-switch for="ble:powerMeter"></connection-switch>`);

        click(el);
        expect(seen.length).toBe(1);
    });

    test('effect="replace" asks for a device swap, not a toggle', () => {
        const toggles  = record('ui:ble:controllable:switch');
        const replaces = record('ui:ble:controllable:replace');
        const el = mount(
            `<connection-switch for="ble:controllable" effect="replace"></connection-switch>`
        );

        click(el);
        expect(replaces.length).toBe(1);
        expect(toggles.length).toBe(0);
    });
});
