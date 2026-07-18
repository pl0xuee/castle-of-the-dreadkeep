'use strict';

// The game needs no Node APIs in the renderer; contextIsolation + sandbox stay
// on and nothing is exposed. Kept as an explicit file so the preload path in
// main.js always resolves. A `contextBridge` bridge (e.g. a Quit button) can be
// added here later if desired.
