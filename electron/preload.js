'use strict';

// The game needs no Node APIs in the renderer; contextIsolation + sandbox stay
// on. The only thing bridged is the updater, so the Settings panel can drive a
// "Check for updates" button — everything it exposes is a narrow, fixed-shape
// call into the main process, never a general IPC handle.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameUpdater', {
  // Current version + whether this build can replace itself, for the button's
  // resting label. No network hit.
  state: () => ipcRenderer.invoke('update:state'),
  // Check, and if there is something newer, download it and offer the restart.
  check: () => ipcRenderer.invoke('update:check'),
  // Download percentage while fetching; null when it finishes or fails.
  onProgress: (cb) => ipcRenderer.on('update:progress', (_e, percent) => cb(percent)),
  // Fires when the background poll notices a release the player doesn't have.
  onAvailable: (cb) => ipcRenderer.on('update:available', (_e, version) => cb(version))
});
