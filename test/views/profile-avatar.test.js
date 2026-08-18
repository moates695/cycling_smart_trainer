/**
 * @jest-environment jsdom
 */

//
// The top-bar avatar has only an email to work with, so its initials come from
// the local part: one word gives one letter, several give first + last.
//

import { xf } from '../../src/functions.js';
import { accountInitials } from '../../src/views/watts.js';
import '../../src/views/watts.js';

// `db:*` subscribers read their own key off the store the proxy hands them,
// so a hand-rolled dispatch has to carry that shape.
function set(key, value) {
    xf.dispatch(`db:${key}`, { [key]: value });
}

describe('accountInitials', () => {
    test('one word gives one letter', () => {
        expect(accountInitials('marcus@moates.com.au')).toBe('M');
    });

    test('two words give first and last', () => {
        expect(accountInitials('marcus.oates@moates.com.au')).toBe('MO');
    });

    test('more than two words skip the middle', () => {
        expect(accountInitials('marcus_john-oates@moates.com.au')).toBe('MO');
    });

    test('separators around the words are ignored', () => {
        expect(accountInitials('.marcus..oates.@moates.com.au')).toBe('MO');
    });

    test('nothing usable gives nothing', () => {
        expect(accountInitials('')).toBe('');
        expect(accountInitials(undefined)).toBe('');
        expect(accountInitials('...@moates.com.au')).toBe('');
    });
});

describe('<profile-avatar>', () => {
    let $avatar;

    beforeEach(() => {
        document.body.innerHTML = `<profile-avatar>?</profile-avatar>`;
        $avatar = document.querySelector('profile-avatar');
    });

    test('shows a question mark signed out', () => {
        expect($avatar.textContent).toBe('?');
        expect($avatar.classList.contains('is-signed-in')).toBe(false);
    });

    test('shows the initials once signed in', () => {
        set('user', {id: 'u1', email: 'marcus.oates@moates.com.au'});

        expect($avatar.textContent).toBe('MO');
        expect($avatar.classList.contains('is-signed-in')).toBe(true);
    });

    test('goes back to the question mark on sign out', () => {
        set('user', {id: 'u1', email: 'marcus@moates.com.au'});
        expect($avatar.textContent).toBe('M');

        set('user', undefined);
        expect($avatar.textContent).toBe('?');
        expect($avatar.classList.contains('is-signed-in')).toBe(false);
    });
});
