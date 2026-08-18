//
// The app's confirm dialog: a small centred card in the WATTS style, used
// anywhere a native `confirm()` would otherwise interrupt the ride with an
// unstyled browser sheet. Styling lives with the rest of the WATTS surfaces
// (`.wl-modal*` in css/watts-workouts.css).
//
// Every caller-supplied string is written with textContent, so a workout name
// or any other user text can never inject markup into it.
//

// `confirmClass` picks the accent on the confirm button:
//   'btn--danger'     destructive (delete)
//   'wl-confirm--go'  non-destructive but consequential (load over a ride)
// Returns the backdrop element so a caller can dismiss it itself if needed.
function confirmModal({head, body, confirmLabel, confirmClass, onConfirm, onCancel}) {
    const backdrop = document.createElement('div');
    backdrop.className = 'wl-modal-backdrop';
    backdrop.innerHTML = `
        <div class="wl-modal" role="dialog" aria-modal="true">
            <div class="wl-modal-head"></div>
            <div class="wl-modal-body"></div>
            <div class="wl-modal-foot">
                <button class="wl-cancel btn">Cancel</button>
                <button class="wl-confirm btn ${confirmClass ?? ''}"></button>
            </div>
        </div>`;
    backdrop.querySelector('.wl-modal-head').textContent = head;
    backdrop.querySelector('.wl-modal-body').textContent = body;
    backdrop.querySelector('.wl-confirm').textContent = confirmLabel;

    // Escape cancels, the same as tapping the backdrop. The listener is on the
    // document because focus may still be on whatever opened the dialog.
    const onKey = (e) => {
        if(e.key === 'Escape') { e.stopPropagation(); cancel(); }
    };
    const close = () => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
    };
    const cancel = () => { close(); onCancel?.(); };

    backdrop.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        if(e.target === backdrop || e.target.closest('.wl-cancel')) { cancel(); return; }
        if(e.target.closest('.wl-confirm')) { close(); onConfirm?.(); }
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    // Focus the confirm button so Enter takes the action the dialog is asking
    // about, and so a keyboard rider isn't left tabbing from the page behind.
    backdrop.querySelector('.wl-confirm').focus?.();
    return backdrop;
}

export { confirmModal };
