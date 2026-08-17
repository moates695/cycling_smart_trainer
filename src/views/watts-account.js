import { xf, exists, } from '../functions.js';
import { SyncState } from '../sync/sync-model.js';
import { sync } from '../sync/sync.js';

// The server rejects anything shorter, so check here too rather than making the
// rider wait for a round trip to find out.
const MIN_PASSWORD_LENGTH = 10;
const CODE_LENGTH = 6;

// Settings -> Account: the WATTS account.
//
// Signing in is what makes custom workouts, ride history and the rider profile
// durable and available on more than one browser profile. (The profile matters
// more than it sounds: without it a second device rides every %FTP target
// against a default 200 W.) It is optional: everything below
// this component keeps writing to IndexedDB either way, so the app works signed
// out, offline, and mid-interval on bad wifi.
//
// Five states share the one card, and exactly one is ever visible: sign in,
// create account, forgot password, enter the emailed code, and signed in.
//
// The reset is a code typed in here rather than a link followed from the inbox,
// because a link opens whatever browser handles mail — on iOS always Safari,
// never the installed home screen app — and the session it produces would land
// there instead of in the app the rider is about to ride with.
class WattsAccount extends HTMLElement {
    constructor() {
        super();
        this.mode = 'sign-in';
        // The address a reset code was sent to, carried between the two reset
        // panels so the rider does not type it twice.
        this.resetEmail = '';
    }
    connectedCallback() {
        const self = this;
        this.abortController = new AbortController();
        this.signal = { signal: self.abortController.signal };

        this.$signedOut = self.querySelector('#account--signed-out');
        this.$signedIn = self.querySelector('#account--signed-in');
        this.$panelSignIn = self.querySelector('#account--panel-sign-in');
        this.$panelSignUp = self.querySelector('#account--panel-sign-up');
        this.$panelResetRequest = self.querySelector('#account--panel-reset-request');
        this.$panelResetConfirm = self.querySelector('#account--panel-reset-confirm');

        this.$signInForm = self.querySelector('#signin--form');
        this.$signInEmail = self.querySelector('#signin--email');
        this.$signInPassword = self.querySelector('#signin--password');
        this.$signInSubmit = self.querySelector('#signin--submit');

        this.$signUpForm = self.querySelector('#signup--form');
        this.$signUpEmail = self.querySelector('#signup--email');
        this.$signUpPassword = self.querySelector('#signup--password');
        this.$signUpConfirm = self.querySelector('#signup--confirm');
        this.$signUpSubmit = self.querySelector('#signup--submit');

        this.$resetForm = self.querySelector('#reset--form');
        this.$resetEmail = self.querySelector('#reset--email');
        this.$resetSubmit = self.querySelector('#reset--submit');

        this.$codeForm = self.querySelector('#reset-code--form');
        this.$codeSentTo = self.querySelector('#reset-code--sent-to');
        this.$codeEmail = self.querySelector('#reset-code--email');
        this.$code = self.querySelector('#reset-code--code');
        this.$codePassword = self.querySelector('#reset-code--password');
        this.$codeConfirm = self.querySelector('#reset-code--confirm');
        this.$codeSubmit = self.querySelector('#reset-code--submit');

        this.$seg = self.querySelector('#account--seg');
        this.$toSignUp = self.querySelector('#account--to-sign-up');
        this.$toSignIn = self.querySelector('#account--to-sign-in');
        this.$toReset = self.querySelector('#account--to-reset');
        this.$resetToSignIn = self.querySelector('#reset--to-sign-in');
        this.$codeResend = self.querySelector('#reset-code--resend');

        this.$pwToggles = [...self.querySelectorAll('.watts-pw--toggle')];

        this.$msg = self.querySelector('#account--msg');
        this.$identity = self.querySelector('#account--identity');
        this.$status = self.querySelector('#account--status');
        this.$signOut = self.querySelector('#account--sign-out');
        this.$syncNow = self.querySelector('#account--sync-now');

        this.$signInForm.addEventListener('submit', self.onSignIn.bind(self), this.signal);
        this.$signUpForm.addEventListener('submit', self.onSignUp.bind(self), this.signal);
        this.$resetForm.addEventListener('submit', self.onResetRequest.bind(self), this.signal);
        this.$codeForm.addEventListener('submit', self.onResetConfirm.bind(self), this.signal);
        this.$toSignUp.addEventListener('pointerup', self.onSwitch.bind(self, 'sign-up'), this.signal);
        this.$toSignIn.addEventListener('pointerup', self.onSwitch.bind(self, 'sign-in'), this.signal);
        this.$toReset.addEventListener('pointerup', self.onSwitch.bind(self, 'reset-request'), this.signal);
        this.$resetToSignIn.addEventListener('pointerup', self.onSwitch.bind(self, 'sign-in'), this.signal);
        this.$codeResend.addEventListener('pointerup', self.onSwitch.bind(self, 'reset-request'), this.signal);
        // click rather than the pointerup used elsewhere in this card: a reveal
        // button is reached by tab from the field it belongs to, and pointerup
        // never fires for Enter or Space.
        this.$pwToggles.forEach((button) => {
            button.addEventListener('click', self.onPasswordToggle.bind(self, button), this.signal);
        });
        this.$signOut.addEventListener('pointerup', self.onSignOut.bind(self), this.signal);
        this.$syncNow.addEventListener('pointerup', self.onSyncNow.bind(self), this.signal);

        xf.sub('db:user', self.onUser.bind(self), this.signal);
        xf.sub('db:syncState', self.onSyncState.bind(self), this.signal);
        xf.sub('db:syncError', self.onError.bind(self), this.signal);
        xf.sub('account:reset-code-sent', self.onCodeSent.bind(self), this.signal);

        this.renderMode();
        // Read the current session rather than waiting for the next event: this
        // tab may be reconnected (Account is a sub-tab) long after the
        // session was restored, and subscriptions only see what happens next.
        this.onUser(sync.user);
        this.onSyncState(sync.state);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onSwitch(mode) {
        // Carry the address across rather than making the rider retype it: they
        // have usually just typed it into the sign in form and failed.
        if(mode === 'reset-request') {
            const typed = (this.$signInEmail.value ?? '').trim();
            if(typed !== '') this.$resetEmail.value = typed;
            else if(this.resetEmail !== '') this.$resetEmail.value = this.resetEmail;
        }
        this.mode = mode;
        this.message('');
        this.renderMode();
    }
    onSignIn(e) {
        e.preventDefault();
        const email = (this.$signInEmail.value ?? '').trim();
        const password = this.$signInPassword.value ?? '';

        if(email === '' || password === '') {
            this.message('Enter an email and a password.', 'error');
            return;
        }

        this.message('Signing in ...', 'loading');
        this.$signInSubmit.disabled = true;
        xf.dispatch('ui:account:login', {email, password});
    }
    onSignUp(e) {
        e.preventDefault();
        const email = (this.$signUpEmail.value ?? '').trim();
        const password = this.$signUpPassword.value ?? '';
        const confirm = this.$signUpConfirm.value ?? '';

        if(email === '' || password === '') {
            this.message('Enter an email and a password.', 'error');
            return;
        }
        if(password.length < MIN_PASSWORD_LENGTH) {
            this.message(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, 'error');
            return;
        }
        // Checked before the request, so a typo costs nothing and never creates
        // an account whose password the rider cannot reproduce.
        if(password !== confirm) {
            this.message('Those passwords do not match.', 'error');
            this.$signUpConfirm.value = '';
            this.$signUpConfirm.focus();
            return;
        }

        this.message('Creating account ...', 'loading');
        this.$signUpSubmit.disabled = true;
        xf.dispatch('ui:account:register', {email, password});
    }
    onResetRequest(e) {
        e.preventDefault();
        const email = (this.$resetEmail.value ?? '').trim();

        if(email === '') {
            this.message('Enter the email on your account.', 'error');
            return;
        }

        this.message('Sending a code ...', 'loading');
        this.$resetSubmit.disabled = true;
        xf.dispatch('ui:account:reset-request', {email});
    }
    // The request went through. It says nothing about whether that address has
    // an account — the server deliberately answers the same either way — so the
    // wording here promises an email only "if" one exists.
    onCodeSent(email) {
        this.resetEmail = email ?? '';
        this.$resetSubmit.disabled = false;
        this.$codeEmail.value = this.resetEmail;
        this.$codeSentTo.textContent = this.resetEmail;
        this.mode = 'reset-confirm';
        this.renderMode();
        this.message(`If ${this.resetEmail} has an account, a code is on its way.`, 'success');
        this.$code.focus();
    }
    onResetConfirm(e) {
        e.preventDefault();
        // Codes get pasted with a stray space more often than you would think.
        const code = (this.$code.value ?? '').replace(/\s/g, '');
        const password = this.$codePassword.value ?? '';
        const confirm = this.$codeConfirm.value ?? '';

        if(code.length !== CODE_LENGTH) {
            this.message(`Enter the ${CODE_LENGTH} digit code from the email.`, 'error');
            return;
        }
        if(password.length < MIN_PASSWORD_LENGTH) {
            this.message(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, 'error');
            return;
        }
        if(password !== confirm) {
            this.message('Those passwords do not match.', 'error');
            this.$codeConfirm.value = '';
            this.$codeConfirm.focus();
            return;
        }

        this.message('Setting your new password ...', 'loading');
        this.$codeSubmit.disabled = true;
        xf.dispatch('ui:account:reset-confirm', {email: this.resetEmail, code, password});
    }
    onSignOut() {
        xf.dispatch('ui:account:logout');
    }
    onSyncNow() {
        xf.dispatch('ui:account:sync-now');
    }
    onUser(user) {
        const signedIn = exists(user);

        this.enableSubmits();
        this.$signedIn.hidden = !signedIn;
        this.$signedOut.hidden = signedIn;

        if(signedIn) {
            this.$identity.textContent = user.email;
            this.clearPasswords();
            this.message('');
            // So signing out does not drop the rider on the registration form,
            // or worse, back in the middle of a reset they have finished.
            this.mode = 'sign-in';
            this.resetEmail = '';
            this.renderMode();
        }
    }
    onSyncState(state) {
        const text = {
            [SyncState.idle]: 'Up to date.',
            [SyncState.syncing]: 'Syncing ...',
            [SyncState.offline]: 'Offline. Your rides are saved here and will sync when you reconnect.',
            [SyncState.error]: 'Sync is having trouble. Nothing is lost; it will keep trying.',
            [SyncState.signedOut]: '',
        }[state] ?? '';

        this.$status.textContent = text;
        this.$status.classList.toggle('error', state === SyncState.error);
    }
    onError(error) {
        if(!exists(error) || error === '') return;
        this.enableSubmits();
        this.message(error, 'error');
    }
    enableSubmits() {
        this.$signInSubmit.disabled = false;
        this.$signUpSubmit.disabled = false;
        this.$resetSubmit.disabled = false;
        this.$codeSubmit.disabled = false;
    }
    // Show / hide, one handler for all five password fields rather than five
    // ids: the button always acts on the input beside it.
    onPasswordToggle(button) {
        const input = button.parentElement.querySelector('input');
        this.reveal(button, input.type === 'password');
    }
    reveal(button, on) {
        const input = button.parentElement.querySelector('input');
        input.type = on ? 'text' : 'password';
        button.textContent = on ? 'Hide' : 'Show';
        button.setAttribute('aria-pressed', String(on));
        button.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
    }
    clearPasswords() {
        this.$signInPassword.value = '';
        this.$signUpPassword.value = '';
        this.$signUpConfirm.value = '';
        this.$code.value = '';
        this.$codePassword.value = '';
        this.$codeConfirm.value = '';
        // Clearing the values and leaving a field revealed would show the next
        // password typed into it, so a panel switch or a sign in resets the
        // reveal too. Read on screen, deliberately, once.
        this.$pwToggles.forEach((button) => this.reveal(button, false));
    }
    message(text, kind) {
        this.$msg.classList.remove('loading', 'success', 'error');
        this.$msg.textContent = text ?? '';
        if(exists(kind)) this.$msg.classList.add(kind);
    }
    renderMode() {
        const signIn = this.mode === 'sign-in';
        const signUp = this.mode === 'sign-up';

        this.$panelSignIn.hidden = !signIn;
        this.$panelSignUp.hidden = !signUp;
        this.$panelResetRequest.hidden = this.mode !== 'reset-request';
        this.$panelResetConfirm.hidden = this.mode !== 'reset-confirm';

        // The two segments describe a choice between the panels below them, so
        // they only make sense while one of those two is showing. During a reset
        // neither is true, and a control with nothing selected reads as broken.
        this.$seg.hidden = !(signIn || signUp);
        this.$toSignIn.classList.toggle('active', signIn);
        this.$toSignUp.classList.toggle('active', signUp);
        this.$toSignIn.setAttribute('aria-pressed', String(signIn));
        this.$toSignUp.setAttribute('aria-pressed', String(signUp));

        // Never carry a typed password across the switch.
        this.clearPasswords();
    }
}

customElements.define('watts-account', WattsAccount);

export { WattsAccount };
