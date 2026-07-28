/**
 * @jest-environment jsdom
 */

//
// The power hero has to hold still while the reading changes: a wide value used
// to push "0.00 W/kg" past its column and wrap it onto a second line, growing
// the whole data panel. The layout side of that lives in flux.css (fixed-width,
// right-aligned, nowrap boxes); what this covers is the markup those rules need
// — the W/kg number must be its own element so it can be right-aligned
// independently of its unit.
//

import { xf } from '../../src/functions.js';
import '../../src/views/watts.js';
import '../../src/views/data-views.js';

// `db:*` subscribers read their own key off the store the proxy hands them,
// so a hand-rolled dispatch has to carry that shape.
function set(key, value) {
    xf.dispatch(`db:${key}`, {[key]: value});
}

afterEach(() => { document.body.innerHTML = ''; });

describe('<w-per-kg>', () => {
    test('renders the number and the unit as separate elements', () => {
        const el = document.createElement('w-per-kg');
        document.body.appendChild(el);

        expect(el.querySelector('.watts-hero--wkg-num').textContent).toBe('0.00');
        expect(el.querySelector('.watts-hero--wkg-unit').textContent).toBe('W/kg');
    });

    test('only the number changes as power moves', () => {
        const el = document.createElement('w-per-kg');
        document.body.appendChild(el);
        const num = el.querySelector('.watts-hero--wkg-num');

        set('weight', 75);
        set('power1s', 250);
        expect(num.textContent).toBe('3.33');

        // Double figures drop a decimal so the text stays 4 characters wide and
        // still fits the box the unit sits beside.
        set('power1s', 1000);
        expect(num.textContent).toBe('13.3');
        expect(num.textContent.length).toBe(4);
        // The unit element is untouched, so nothing after the number can shift.
        expect(el.querySelector('.watts-hero--wkg-unit').textContent).toBe('W/kg');
    });

    test('a missing weight falls back rather than rendering NaN', () => {
        const el = document.createElement('w-per-kg');
        document.body.appendChild(el);

        set('weight', 0);
        set('power1s', 150);
        expect(el.querySelector('.watts-hero--wkg-num').textContent).toBe('2.00');
    });
});

describe('<power-value>', () => {
    // The hero reserves room for a 3-digit reading; CSS shrinks the type for a
    // wider one, keyed off this attribute, so "W" and "W/kg" stay put instead of
    // being pushed into the target column.
    test('publishes the digit count of the reading', () => {
        const el = document.createElement('power-value');
        el.setAttribute('prop', 'db:power1s');
        document.body.appendChild(el);

        set('power1s', 250);
        expect(el.textContent).toBe('250');
        expect(el.dataset.digits).toBe('3');

        set('power1s', 1250);
        expect(el.dataset.digits).toBe('4');

        set('power1s', 42);
        expect(el.dataset.digits).toBe('2');
    });
});
