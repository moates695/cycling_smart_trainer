//
// WATTS UI overhaul — Settings screen components
//
// Small derived-data / control components used by the Settings page rebuild:
// the FTP-per-kg readout, the Metric/Imperial segmented control, the sound
// volume slider, and the WATTS-style toggle switches (lock-by-default and
// the autoStart/autoPause source flags).
//
// They follow the same conventions as the rest of src/views: a native
// HTMLElement that sets up an AbortController in connectedCallback,
// subscribes to `db:*` events on the xf store, and tears the subscriptions
// down in disconnectedCallback.
//
import { xf, equals } from '../functions.js';
import { models } from '../models/models.js';

//
// <ftp-per-kg> — derived FTP / weight, e.g. "2.67" (unit lives in the markup).
// Reacts to both db:ftp and db:weight so edits update it immediately.
//
class FtpPerKg extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.ftp = models.ftp.default;
        this.weight = models.weight.default;
        xf.sub('db:ftp',    (v) => { this.ftp = v; this.render(); }, this.signal);
        xf.sub('db:weight', (v) => { this.weight = v; this.render(); }, this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    render() {
        const wkg = this.weight > 0 ? this.ftp / this.weight : 0;
        this.textContent = wkg.toFixed(2);
    }
}
customElements.define('ftp-per-kg', FtpPerKg);

//
// <units-switch> — Metric | Imperial segmented control over db.measurement.
// Tapping the inactive segment fires the existing `ui:measurement-switch`
// effect (the model only has two values, so a switch is always correct).
//
class UnitsSwitch extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.state = models.measurement.default;
        this.innerHTML = `
            <span class="watts-set--seg-btn" data-units="metric">Metric</span>
            <span class="watts-set--seg-btn" data-units="imperial">Imperial</span>`;
        this.addEventListener('pointerup', this.onEffect.bind(this), this.signal);
        xf.sub('db:measurement', this.onUpdate.bind(this), this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    onEffect(e) {
        const btn = e.target.closest('[data-units]');
        if(!btn) return;
        if(!equals(btn.dataset.units, this.state)) {
            xf.dispatch('ui:measurement-switch');
        }
    }
    onUpdate(measurement) {
        this.state = measurement;
        this.render();
    }
    render() {
        this.querySelectorAll('[data-units]').forEach(($el) => {
            $el.classList.toggle('active', equals($el.dataset.units, this.state));
        });
    }
}
customElements.define('units-switch', UnitsSwitch);

//
// <volume-slider> — range control over db.volume (0–100) with a % readout.
// Dispatches `ui:volume-set` so dragging lands on an exact value rather than
// stepping through ui:volume-up/down.
//
class VolumeSlider extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.state = models.volume.default;
        this.innerHTML = `
            <input class="watts-set--range" type="range" min="0" max="100" step="5" value="0" />
            <span class="watts-set--range-value">0%</span>`;
        this.$range = this.querySelector('.watts-set--range');
        this.$value = this.querySelector('.watts-set--range-value');
        this.$range.addEventListener('input', this.onInput.bind(this), this.signal);
        xf.sub('db:volume', this.onUpdate.bind(this), this.signal);
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    onInput(e) {
        xf.dispatch('ui:volume-set', parseInt(e.target.value, 10));
    }
    onUpdate(volume) {
        this.state = volume;
        this.render();
    }
    render() {
        this.$range.value = this.state;
        this.$range.style.setProperty('--fill', `${this.state}%`);
        this.$value.textContent = `${this.state}%`;
    }
}
customElements.define('volume-slider', VolumeSlider);

//
// WATTS toggle switch base: a pill track with a sliding knob, `.on` when true.
//
class WattsToggle extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };
        this.state = false;
        this.classList.add('watts-set--toggle');
        this.innerHTML = `<div class="watts-set--toggle-knob"></div>`;
        this.addEventListener('pointerup', this.onEffect.bind(this), this.signal);
        this.subs();
        this.render();
    }
    disconnectedCallback() { this.abortController.abort(); }
    subs() { return; }
    onEffect() { return; }
    render() {
        this.classList.toggle('on', !!this.state);
    }
}

//
// <lock-default-toggle> — "Lock controls by default". Persisted via the
// lockDefault model; db.lock is seeded from it on startup (see db.js).
//
class LockDefaultToggle extends WattsToggle {
    subs() {
        xf.sub('db:lockDefault', (v) => { this.state = v; this.render(); }, this.signal);
        this.state = models.lockDefault.default;
    }
    onEffect() {
        xf.dispatch('ui:lock-default-switch');
    }
}
customElements.define('lock-default-toggle', LockDefaultToggle);

//
// <source-toggle key="autoPause"> — toggle over a boolean flag inside
// db.sources (autoStart / autoPause), mirroring the legacy AutoStart /
// AutoPause views but rendered as a WATTS switch.
//
class SourceToggle extends WattsToggle {
    subs() {
        this.key = this.getAttribute('key');
        this.state = models.sources.state?.[this.key] ?? false;
        xf.sub('db:sources', (sources) => {
            this.state = sources[this.key];
            this.render();
        }, this.signal);
    }
    onEffect() {
        const update = {};
        update[this.key] = !this.state;
        xf.dispatch('sources', update);
    }
}
customElements.define('source-toggle', SourceToggle);

export { FtpPerKg, UnitsSwitch, VolumeSlider, LockDefaultToggle, SourceToggle };
