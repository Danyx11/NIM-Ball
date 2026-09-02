// Mobile "How To" tutorial: step copy only (see game.js's howTo mode for the
// actual orchestration — phase gating, spotlight targeting, DOM sync). Kept
// as its own tiny data module so the copy can be edited/proofread without
// touching game.js's closure.
export const HOWTO_STEPS = [
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
  { id: 'quit', title: 'Quit', text: 'Tap exit to leave the tutorial' },
];
