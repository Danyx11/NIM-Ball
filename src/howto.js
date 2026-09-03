// "How To" tutorial: step copy only (see game.js's howTo mode for the actual
// orchestration — phase gating, spotlight targeting, DOM sync). Kept as its
// own tiny data module so the copy can be edited/proofread without touching
// game.js's closure. Two lists, not one: mobile selects a stone with a tap
// then aims a separate on-screen joystick (2 gestures), while desktop clicks
// and drags the stone itself directly (1 gesture) — see game.js's
// startGame() picking whichever list matches its own `mobile` flag, and its
// howToTargetId() for how each step's DOM/canvas target also differs.
export const HOWTO_STEPS_MOBILE = [
  // Special step — no game action gates it (see game.js's howToGotItBtn
  // handling); dismissed by tapping "Got it?" instead, appended to `text`
  // as its own pill rather than baked into this copy.
  { id: 'meetStone', title: 'Your stone', text: 'Your stone’s 4 LEDs show how many hits it can take before it’s knocked out.' },
  { id: 'select', title: 'Select', text: 'Tap your stone' },
  { id: 'aim', title: 'Aim', text: 'Drag the stick — hold 2s to lock' },
  { id: 'play', title: 'Play', text: 'Tap Play to launch your stone' },
  { id: 'ice', title: 'Ice boost', text: 'Tap the ice button to speed up your stone' },
  { id: 'positionIce', title: 'Position the ice', text: 'Drag the ice zone to place it' },
  { id: 'slide', title: 'Slide on the ice', text: 'Launch your stone through the ice' },
  // Merged with what used to be a separate "bounce off a wall" step, whose
  // own aim (found by the player, then frozen) is now a preset demo shot
  // instead (see game.js's howToStartLaserDemo) — no game action gates this
  // one either, just the power button toggle already being watched for.
  // Requires four clicks (see game.js's howToLaserToggleCount), not one, so
  // the player actually sees both styles alternate back and forth rather
  // than whichever one they land on first — the copy spells that out
  // rather than just saying "switch", per explicit request.
  { id: 'laser', title: 'Basic laser', text: 'Click several times on the button to alternate between predictive and basic laser.' },
  { id: 'quit', title: 'Done !', text: 'Tap exit to leave the tutorial' },
];

// One fewer step than mobile: "select" + "aim" merge into a single click-
// and-drag-the-stone gesture (see game.js's startGame() — mousedown on a
// stone begins a real drag immediately, no separate tap-to-select step the
// way mobile's joystick needs).
export const HOWTO_STEPS_DESKTOP = [
  { id: 'meetStone', title: 'Your stone', text: 'Your stone’s 4 LEDs show how many hits it can take before it’s knocked out.' },
  { id: 'aim', title: 'Aim', text: 'Click and drag your stone to aim' },
  { id: 'play', title: 'Play', text: 'Click Play to launch your stone' },
  { id: 'ice', title: 'Ice boost', text: 'Click the ice button to speed up your stone' },
  { id: 'positionIce', title: 'Position the ice', text: 'Drag the ice zone to place it' },
  { id: 'slide', title: 'Slide on the ice', text: 'Launch your stone through the ice' },
  { id: 'laser', title: 'Basic laser', text: 'Click several times on the button to alternate between predictive and basic laser.' },
  { id: 'quit', title: 'Done !', text: 'Click exit to leave the tutorial' },
];
