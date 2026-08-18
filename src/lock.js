import { xf } from './functions.js';

class WakeLock {
    constructor(args) {
        this.lock = undefined;
        this.isLocked = false;
        this.isLocable = false;
        this.isVisible = false;
        this.init();
    }
    init() {
        let self = this;
        self.isLocable = ('wakeLock' in navigator);
        self.isVisible = self.checkVisibility();

        self.lockScreen();

        document.addEventListener('visibilitychange', self.onVisibilityChange.bind(self));

        window.addEventListener('beforeunload', e => {
            xf.dispatch('lock:beforeunload');
        });

        // beforeunload never fires on iOS and an idb write started in it is not
        // guaranteed to finish anywhere, so the ride is also saved from pagehide
        // and from the page going hidden — the last points a backgrounded PWA is
        // reliably still alive. All three write the same record to the same key,
        // so firing more than once on a reload costs nothing.
        window.addEventListener('pagehide', e => {
            xf.dispatch('session:backup');
        });
    }
    checkVisibility() {
        let isVisible = false;
        let visibilityState = document.visibilityState;

        if(visibilityState === 'visible') {
            isVisible = true;
        } else {
            isVisible = false;
        }
        return isVisible;
    }
    onVisibilityChange () {
        let self = this;

        if(self.checkVisibility()) {
            self.lockScreen();
        } else {
            xf.dispatch('session:backup');
        }
    }
    async lockScreen() {
        let self = this;
        if(self.isLocable && self.isVisible) {
            try {
                let lock = await navigator.wakeLock.request('screen');
                self.isLocked = true;

                lock.addEventListener('release', e => {
                    self.isLocked = false;
                    xf.dispatch('lock:release');
                    console.log(`Wake lock released.`);
                });
            } catch(e) {
                console.warn(`wake-lock: not-supported:`, e);
            }
        }
    }
}

const lock = new WakeLock();

export { lock };
