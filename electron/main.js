'use strict';

const { app, BrowserWindow, protocol, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

// ---------------------------------------------------------------------------
// Custom `app://` standard scheme.
//
// The game loads Three.js as an ES module and (from the graphics upgrade) uses
// an import map. Both are blocked under `file://` (opaque origin). A registered
// *standard* scheme gives a real, stable origin (`app://bundle/`) so ES modules,
// import maps, fetch and localStorage all work — with no TCP port and no server
// lifecycle to manage. localStorage is per-origin, and `app://bundle` is stable
// across launches, so the game's saved settings + leaderboard persist.
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true
    }
  }
]);

// Root that contains index.html + assets/. When packaged, files live inside the
// asar archive under the app path; fs.promises (main process) reads asar
// transparently, which is why we read+return an explicit-MIME Response instead
// of net.fetch(file://) (the latter cannot read inside an asar archive).
const ROOT = app.getAppPath();

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json'
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL('app://bundle/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url); // app://bundle/<path>
    let rel = decodeURIComponent(url.pathname); // "/index.html"
    if (rel === '/' || rel === '') rel = '/index.html';

    // Resolve within ROOT and guard against path traversal.
    const filePath = path.join(ROOT, path.normalize(rel));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fs.readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: { 'content-type': mimeFor(filePath) }
      });
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 500;
      return new Response(status === 404 ? 'Not Found' : 'Internal Error', { status });
    }
  });

  Menu.setApplicationMenu(null);
  createWindow();
  setupAutoUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ---------------------------------------------------------------------------
// Auto-update via electron-updater against the GitHub Releases feed configured
// in package.json ("build".publish). On launch (and periodically) the app checks
// the latest release; a newer build downloads in the background and, once ready,
// the player is offered a restart to install. Failures are logged and swallowed —
// a missed update check must never block or crash the game.
// ---------------------------------------------------------------------------
function setupAutoUpdates() {
  // electron-updater is a no-op unless the app is packaged (there is no installed
  // app to replace in dev), so skip it entirely when running from source.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    return; // module missing (e.g. running unpacked) — nothing to do
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => { /* swallow: never interrupt play on a failed check */ });

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Castle of the Dreadkeep ${info.version} is ready to install.`,
      detail: 'Restart the game to apply the update. It will otherwise install automatically next time you quit.'
    }).then((res) => {
      if (res.response === 0) autoUpdater.quitAndInstall();
    }).catch(() => {});
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  // Re-check every 6 hours for long-running sessions.
  setInterval(check, 6 * 60 * 60 * 1000);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
