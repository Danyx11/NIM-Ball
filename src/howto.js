// Mobile "How To" tutorial: step copy only (see game.js's howTo mode for the
// actual orchestration — phase gating, spotlight targeting, DOM sync). Kept
// as its own tiny data module so the copy can be edited/proofread without
// touching game.js's closure.
export const HOWTO_STEPS = [
  // Special step — no game action gates it (see game.js's howToGotItBtn
  // handling); dismissed by tapping "Got it?" instead, appended to `text`
  // as its own pill rather than baked into this copy.
  { id: 'meetStone', title: 'Your stone', text: 'Its 4 LEDs show how many hits it can take before it’s knocked out.' },
  { id: 'select', title: 'Select', text: 'Tap a stone' },
  { id: 'aim', title: 'Aim', text: 'Drag the stick — hold 2s to lock' },
  { id: 'play', title: 'Play', text: 'Tap Play to launch' },
  { id: 'ice', title: 'Ice boost', text: 'Tap the ice button' },
  { id: 'positionIce', title: 'Position the ice', text: 'Drag the ice zone to place it' },
  { id: 'slide', title: 'Slide on the ice', text: 'Launch your stone through the ice' },
  { id: 'wall', title: 'Bounce off a wall', text: 'Aim at a wall' },
  { id: 'laser', title: 'Basic laser', text: 'Switch between predictive and basic laser' },
  { id: 'quit', title: 'Quit', text: 'Tap exit to leave the tutorial' },
];
