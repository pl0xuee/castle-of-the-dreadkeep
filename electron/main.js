'use strict';

const { app, BrowserWindow, protocol, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

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
// in package.json ("build".publish).
//
// Downloads are user-initiated: the background poll only asks GitHub for a
// version number and lights up the Settings button, so the game never spends a
// player's bandwidth on a ~100MB build unprompted, and never stalls mid-run.
// autoInstallOnAppQuit stays on, so an update the player downloads but declines
// to restart into still applies the next time they quit.
//
// Ported from the StreamHub updater, which is the same stack shipping the same
// AppImage-on-Linux shape; the AppImage handling below is its hard-won part.
// ---------------------------------------------------------------------------
const REPO = 'pl0xuee/castle-of-the-dreadkeep';
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;
let pendingUpdate = null;   // version string of a known-newer release, or null
let updateBusy = false;     // guards against a second click mid-download

function sendToUi(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function isNewerVersion(latest, current) {
  const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Whether electron-updater can install a new build in place, as opposed to only
// pointing the player at the download page.
//   * Windows: the packaged NSIS installer does the swap and relaunch itself.
//   * Linux: only the AppImage build can replace itself — it overwrites the file
//     at $APPIMAGE, which the AppImage runtime sets. Started any other way
//     (`npm start`, an unpacked tree), there is nothing to swap.
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  return Boolean(process.env.APPIMAGE);
}

// electron-updater keeps the AppImage's path — so desktop entries, docks and
// pinned icons keep working — only when the current filename carries no version
// number; otherwise it names the new file after the new version and every
// launcher the player set up points at a file that no longer exists. The build
// config now ships an unversioned name to take the in-place branch, but a build
// still running under the old versioned name has to be renamed once. Detect it
// so we can say so up front rather than silently breaking their launcher.
function appImageWillBeRenamed() {
  const current = process.env.APPIMAGE;
  return Boolean(current) && /\d+\.\d+\.\d+/.test(path.basename(current));
}

async function fetchLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CastleOfTheDreadkeep' }
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const data = await res.json();
  return { version: String(data.tag_name || '').replace(/^v/, ''), url: data.html_url };
}

// Start the new AppImage once this process is gone.
//
// The obvious ways to do this — electron-updater's own run-after-install, or
// app.relaunch() — both launch the successor from inside a process that is about
// to disappear, and everything this process runs from lives in the AppImage's
// mount under /tmp/.mount_*, which the runtime tears down the moment we exit.
// That race can leave the player with no game running at all.
//
// So the job goes to /bin/sh, a real file on the host that outlives us: it waits
// for our pid to disappear, then execs the new build. Its environment is
// stripped of the old mount's variables — they point into a directory that is
// about to stop existing — and the new AppImage's runtime sets its own.
function relaunchAfterExit(appImagePath) {
  const env = { ...process.env };
  for (const key of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) {
    delete env[key];
  }
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"',
      'dreadkeep-relaunch', // $0
      String(process.pid),  // $1: wait for us to exit…
      appImagePath          // $2: …then become the new build
    ],
    { detached: true, stdio: 'ignore', env, cwd: os.homedir() }
  );
  child.unref();
}

function loadUpdater() {
  try {
    return require('electron-updater').autoUpdater;
  } catch (err) {
    return null; // module missing (e.g. running unpacked) — nothing to do
  }
}

function setupAutoUpdates() {
  const autoUpdater = loadUpdater();
  if (!autoUpdater) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => { /* swallow: never interrupt play on a failed check */ });
  autoUpdater.on('download-progress', (p) => sendToUi('update:progress', Math.round(p.percent)));

  if (!app.isPackaged) return; // nothing to poll for when running from source

  // Quiet background poll: no dialogs, no download, and failures (offline,
  // GitHub rate-limited) resolve to null rather than throwing. Its only job is
  // to light up the Settings button.
  const pollForUpdate = async () => {
    let latest = null;
    try {
      if (canSelfUpdate()) {
        const result = await autoUpdater.checkForUpdates();
        const v = result && result.updateInfo && result.updateInfo.version;
        latest = v && isNewerVersion(v, app.getVersion()) ? v : null;
      } else {
        const rel = await fetchLatestRelease();
        latest = isNewerVersion(rel.version, app.getVersion()) ? rel.version : null;
      }
    } catch {
      return; // a background check that cannot reach the network is not an error
    }
    if (latest === pendingUpdate) return; // nothing changed; don't churn the UI
    pendingUpdate = latest;
    sendToUi('update:available', pendingUpdate);
  };

  pollForUpdate();
  setInterval(pollForUpdate, UPDATE_POLL_MS);
}

// Renderer asks for the button's initial label without triggering a network hit.
ipcMain.handle('update:state', () => ({
  version: app.getVersion(),
  supported: canSelfUpdate(),
  pending: pendingUpdate
}));

// The Settings "Check for updates" button. Checks, and when something is there,
// downloads it and restarts into it. Everything it learns settles the button's
// state: finding nothing must clear a stale "update available", or the button
// would keep offering an update the player has just been told they don't have.
ipcMain.handle('update:check', async () => {
  if (updateBusy) return { state: 'busy' };
  const current = app.getVersion();

  // Unpacked or a non-AppImage Linux build: we can still tell them a new version
  // exists and hand them the releases page, which beats a dead end.
  if (!canSelfUpdate()) {
    try {
      const latest = await fetchLatestRelease();
      const newer = Boolean(latest.version) && isNewerVersion(latest.version, current);
      pendingUpdate = newer ? latest.version : null;
      if (!newer) return { state: 'up-to-date', version: current };
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Open releases page', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Castle of the Dreadkeep ${latest.version} is available.`,
        detail: app.isPackaged
          ? 'This build cannot replace itself, so the new version has to be downloaded manually.'
          : 'The game is running from source, so there is no installed build to replace.'
      });
      if (r.response === 0) shell.openExternal(latest.url || `https://github.com/${REPO}/releases/latest`);
      return { state: 'manual', version: latest.version };
    } catch (err) {
      return { state: 'error', message: String((err && err.message) || err) };
    }
  }

  const autoUpdater = loadUpdater();
  if (!autoUpdater) return { state: 'error', message: 'Updater unavailable' };

  updateBusy = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result && result.updateInfo;
    if (!info || !info.version || !isNewerVersion(info.version, current)) {
      pendingUpdate = null;
      sendToUi('update:available', null);
      return { state: 'up-to-date', version: current };
    }

    pendingUpdate = info.version;
    sendToUi('update:available', info.version);
    await autoUpdater.downloadUpdate();
    sendToUi('update:progress', null);

    // Windows: hand off to the NSIS installer, which swaps the files and
    // relaunches by itself, so none of the AppImage handling below applies.
    if (process.platform === 'win32') {
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `Castle of the Dreadkeep ${info.version} is ready.`,
        detail: 'Restart now to finish updating? It will otherwise install the next time you quit.'
      });
      if (r.response !== 0) return { state: 'ready', version: info.version };
      autoUpdater.quitAndInstall(true, true);
      return { state: 'installing', version: info.version };
    }

    const renamed = appImageWillBeRenamed();
    const r = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Castle of the Dreadkeep ${info.version} is ready.`,
      detail: renamed
        ? 'Restart now to finish updating?\n\nThis update also drops the version number from ' +
          'the AppImage\'s filename, so shortcuts and pinned icons will need pointing at it ' +
          'one last time. From then on the file keeps its name and path, and updates will no ' +
          'longer break them.'
        : 'Restart now to finish updating? It will otherwise install the next time you quit.'
    });
    if (r.response !== 0) return { state: 'ready', version: info.version };

    // isSilent: true — there is no installer UI on Linux; this just swaps the
    // AppImage. isForceRunAfter: false — we relaunch ourselves, below, rather
    // than letting electron-updater spawn the new build from this dying process.
    // The swap is synchronous (the quit it triggers is not), so once this
    // returns the new file is on disk.
    let installError = null;
    const onError = (err) => { installError = err; };
    autoUpdater.once('error', onError);
    autoUpdater.quitAndInstall(true, false);
    autoUpdater.off('error', onError);
    if (installError) throw installError;

    relaunchAfterExit(process.env.APPIMAGE);
    return { state: 'installing', version: info.version };
  } catch (err) {
    sendToUi('update:progress', null);
    return { state: 'error', message: String((err && err.message) || err) };
  } finally {
    updateBusy = false;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
