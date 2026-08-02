import { xf, exists, } from '../functions.js';
import { models } from '../models/models.js';

// Settings -> Connections: enter a personal intervals.icu API key.
//
// This replaces the OAuth-over-api.auuki.com connect button. The key is held in
// localStorage (see the IntervalsApiKey model) and sent as HTTP Basic auth
// straight to intervals.icu, which reflects arbitrary origins in its CORS
// headers — so no backend of our own is involved.
class IntervalsKey extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        this.$input = self.querySelector('#intervals--key--input');
        this.$save = self.querySelector('#intervals--key--save');
        this.$clear = self.querySelector('#intervals--key--clear');
        this.$msg = self.querySelector('#intervals--key--msg');

        this.$save.addEventListener('pointerup', self.onSave.bind(self), this.signal);
        this.$clear.addEventListener('pointerup', self.onClear.bind(self), this.signal);

        // Enter in the field is the same as pressing Connect.
        this.$input.addEventListener('keydown', (e) => {
            if(e.key === 'Enter') {
                e.preventDefault();
                self.onSave();
            }
        }, this.signal);

        xf.sub('db:intervalsApiKey', self.onKey.bind(self), this.signal);
        xf.sub('action:intervals', self.onAction.bind(self), this.signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onSave() {
        const value = (this.$input.value ?? '').trim();
        if(value === '') {
            this.render(':empty');
            return;
        }
        this.render(':checking');
        xf.dispatch('ui:intervals-api-key-set', value);
    }
    onClear() {
        this.$input.value = '';
        xf.dispatch('ui:intervals-api-key-set', '');
    }
    onKey(key) {
        // Never put the key back in the field; show a masked placeholder instead.
        if(exists(key) && key !== '') {
            this.$input.value = '';
            this.$input.placeholder = models.intervalsApiKey.mask(key);
        } else {
            this.$input.placeholder = 'Paste key from intervals.icu';
        }
    }
    onAction(action) {
        if(action === ':key:valid') { this.render(':connected'); return; }
        if(action === ':key:invalid') { this.render(':invalid'); return; }
    }
    render(state) {
        const $msg = this.$msg;
        $msg.classList.remove('loading', 'success', 'error');

        if(state === ':checking') {
            $msg.textContent = 'Checking key with intervals.icu ...';
            $msg.classList.add('loading');
            return;
        }
        if(state === ':connected') {
            $msg.textContent = 'Connected. Planned workouts and rider profile will sync.';
            $msg.classList.add('success');
            return;
        }
        if(state === ':invalid') {
            $msg.textContent = 'That key was rejected by intervals.icu. Check Settings → Developer for the current one.';
            $msg.classList.add('error');
            return;
        }
        if(state === ':empty') {
            $msg.textContent = 'Enter a key first.';
            $msg.classList.add('error');
            return;
        }
        $msg.textContent = '';
    }
}

customElements.define('intervals-key', IntervalsKey);

export { IntervalsKey };
