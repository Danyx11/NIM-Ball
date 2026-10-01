// iOS Safari's own "scroll the focused input above the keyboard" behavior is
// deliberately killed app-wide (see main.js's pinVisualViewport comment — it
// was panning the whole board, "l'arène remonte", not just the focused
// field), so every text field that can end up covered by the on-screen
// keyboard needs this by hand instead. visualViewport is the only signal for
// how much of the bottom the keyboard actually covers.
//
// `apply(overlapPx)` is called with however many px of `input` currently sit
// below the real visible viewport (0 once it's clear, including on blur).
// Re-fires on every visualViewport resize while focused, since the keyboard
// finishes animating in asynchronously after focus — a single computation
// right on focus would usually run before the keyboard has actually opened.
export function attachKeyboardAvoidance(input, mobile, apply) {
  if (!mobile || !window.visualViewport) return;
  const recompute = () => {
    const rect = input.getBoundingClientRect();
    const visibleBottom = window.visualViewport.height + window.visualViewport.offsetTop;
    apply(Math.max(0, rect.bottom - visibleBottom));
  };
  const onFocus = () => {
    window.visualViewport.addEventListener('resize', recompute);
    setTimeout(recompute, 350);
  };
  input.addEventListener('focus', onFocus);
  input.addEventListener('blur', () => {
    window.visualViewport.removeEventListener('resize', recompute);
    apply(0);
  });
  // Several call sites (the alias claim dialog, WEEK match rename) call
  // input.focus() themselves right after building the dialog, to open the
  // keyboard immediately with no extra tap — that focus() fires the 'focus'
  // event synchronously, so if this function runs after it (the natural
  // reading order: build dialog, focus it, then wire up its behavior) the
  // listener above is attached too late to ever see that first focus and
  // never schedules a single recompute. Catch that case here too, not just
  // by reordering every call site (confirmed on a real iPhone — the alias
  // field stayed hidden behind the keyboard because of exactly this).
  if (document.activeElement === input) onFocus();
}

// Strategy for an ancestor that's already a real overflow:auto scroll
// container (the .config-panel dialogs, the WEEK board panel, …): nudge its
// scrollTop by the overlap instead of moving the panel itself. A plain
// scrollIntoView() doesn't know about the keyboard at all — it scrolls based
// on the panel's own (un-shrunk) layout bounds, which already consider the
// input "in view" even when the keyboard visually covers it.
export function keyboardAvoidScroll(input, mobile, scrollContainer) {
  attachKeyboardAvoidance(input, mobile, (overlap) => {
    scrollContainer.scrollTop = overlap > 0
      ? Math.min(scrollContainer.scrollTop + overlap + 16, scrollContainer.scrollHeight - scrollContainer.clientHeight)
      : 0;
  });
}

// Strategy for an element with nothing to scroll inside it — content that
// already fits, or a fixed bottom bar like the in-match chat compose row —
// where a scrollTop nudge would be a no-op. Translating the whole panel
// (rather than scrolling it) was tried first for the scrollable dialogs
// above and rejected: it moved the whole panel including the part that was
// already fine. That tradeoff doesn't apply here since there's only ever
// one thing in `el` that needs to move.
export function keyboardAvoidTranslate(input, mobile, el) {
  attachKeyboardAvoidance(input, mobile, (overlap) => {
    el.style.transform = overlap > 0 ? `translateY(-${overlap + 16}px)` : '';
  });
}
