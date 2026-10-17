const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const { autoUpdater } = require('electron-updater');

const USER_DATA = () => app.getPath('userData');
const SNIPPETS_FILE = () => path.join(USER_DATA(), 'snippets.json');
const HISTORY_FILE = () => path.join(USER_DATA(), 'history.json');
const SETTINGS_FILE = () => path.join(USER_DATA(), 'settings.json');
const CREDENTIALS_FILE = () => path.join(USER_DATA(), 'credentials.json');
const HISTORY_LIMIT = 5000;

let mainWindow = null;
const ptyProcesses = new Map(); // tabId -> pty process

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  // Every file this app writes here can hold something worth keeping
  // private on a shared machine — not just credentials.json (PIN hash +
  // encrypted passwords), but also history.json (full shell command
  // history) and snippets.json (can include SSH hosts/usernames) — so
  // restrict all of them to the owning user, not just the one that
  // obviously needed it.
  try { fs.chmodSync(file, 0o600); } catch (err) { /* best-effort */ }
}

// Only http(s) URLs ever get handed to the OS's "open externally" handler.
// A terminal's link detection can surface a URI printed by an untrusted
// remote host (SSH output, curl'd text, etc.), and shell.openExternal on an
// arbitrary scheme (file:, custom app-registered protocols, ...) has a real
// history as an OS-level code-execution vector on top of just opening a
// browser — restricting the scheme closes that off entirely.
function openExternalIfHttp(url) {
  try {
    const scheme = new URL(url).protocol;
    if (scheme === 'http:' || scheme === 'https:') shell.openExternal(url);
  } catch (err) {
    /* not a parseable URL — ignore */
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 560,
    minHeight: 360,
    // Not every Linux window manager's taskbar/panel/alt-tab switcher reads
    // the icon out of an AppImage's desktop file — several fall back to
    // asking the window itself, and without this it's Electron's own
    // default logo.
    icon: resolveAppIcon(),
    // A real per-pixel transparent window (for rounded corners) only
    // renders correctly on Linux if a compositing window manager is
    // actually running, which isn't reliable across the range of desktops
    // this app targets (tried and reverted — see CHANGELOG). A plain,
    // solid backgroundColor here just avoids a white flash before the
    // page's own CSS paints on first load.
    backgroundColor: '#0b0b10',
    frame: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Never navigate away from the app shell; open external links in the
  // user's default browser instead of inside the terminal window. Only
  // http(s) links are ever handed to the OS this way — the terminal's own
  // link detection (WebLinksAddon, in the renderer) can surface a URI from
  // an untrusted remote host's output (SSH session, curl'd text, etc.), and
  // shell.openExternal on an arbitrary scheme has a real history of being
  // an OS-level code-execution vector, not just "opens a browser".
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalIfHttp(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttp(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function bundledIconPath() {
  return path.join(__dirname, 'build', 'icons', '512x512.png');
}

// Where the desktop expects user-installed icons and launchers to live.
// resolveAppIcon and ensureDesktopIntegration have to agree on the icon's
// exact path — one writes it, the other reads it back — so they derive it
// from here rather than each spelling it out.
function xdgDataHome() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function managedIconDir() {
  return path.join(xdgDataHome(), 'icons', 'hicolor', '512x512', 'apps');
}

function managedIconPath() {
  return path.join(managedIconDir(), 'fetch-terminal.png');
}

// Prefers the copy this app manages under ~/.local/share (written by
// ensureDesktopIntegration below, and confirmed world-readable there) over
// the one bundled inside the packaged app's own asar archive — asar path
// resolution for this exact icon has already bitten this feature once, so
// this sidesteps trusting it a second time for the window's own icon.
// Falls back to the bundled copy in dev mode, on other platforms, or
// before desktop integration has had a chance to run.
function resolveAppIcon() {
  if (process.env.APPIMAGE) {
    const managed = managedIconPath();
    if (fs.existsSync(managed)) return managed;
  }
  return bundledIconPath();
}

// A plain, un-integrated AppImage has no application launcher the desktop
// knows about, so there's nothing for a taskbar/panel to actually "pin" —
// pinning always works by remembering a .desktop file, not a running
// process. `AppImage` env var is set by the AppImage runtime itself to the
// image's own absolute path, so this only runs when actually launched that
// way (never in dev, never on other platforms), and that path stays valid
// across auto-updates since electron-updater replaces the file in place
// rather than renaming it. Re-registering on every launch is intentional
// and safe: it doesn't touch the pin itself (that's the desktop
// environment's own state, keyed off the .desktop file's name, which never
// changes), it just keeps the file's contents in sync.
function ensureDesktopIntegration() {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return;
  try {
    const desktopDir = path.join(xdgDataHome(), 'applications');
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.mkdirSync(managedIconDir(), { recursive: true });

    const iconTarget = managedIconPath();
    fs.copyFileSync(bundledIconPath(), iconTarget);
    // copyFileSync's resulting mode isn't guaranteed to match the source
    // file's — it's subject to this process's own umask, which can leave
    // it owner-only (0600) and unreadable to the desktop environment's own
    // process. Icons and desktop entries are meant to be world-readable,
    // there's nothing sensitive in either.
    fs.chmodSync(iconTarget, 0o644);

    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Fetch Terminal',
      `Exec="${process.env.APPIMAGE}" %U`,
      'Icon=fetch-terminal',
      'Terminal=false',
      'Categories=System;TerminalEmulator;',
      // Must match the running window's WM_CLASS for the desktop
      // environment to treat this launcher and the running window as the
      // same app — Electron derives that from executableName below.
      'StartupWMClass=fetch-terminal',
      '',
    ].join('\n');
    const desktopTarget = path.join(desktopDir, 'fetch-terminal.desktop');
    fs.writeFileSync(desktopTarget, entry, 'utf8');
    fs.chmodSync(desktopTarget, 0o644);

    // Best-effort: nudges the desktop environment into picking this up
    // immediately rather than waiting for its own periodic rescan. Neither
    // tool is guaranteed to exist, and nothing here depends on it working.
    for (const [cmd, args] of [
      ['update-desktop-database', [desktopDir]],
      ['gtk-update-icon-cache', ['-f', '-t', path.join(xdgDataHome(), 'icons', 'hicolor')]],
    ]) {
      try { require('child_process').execFileSync(cmd, args, { stdio: 'ignore' }); } catch (err) { /* not installed, or not needed on this desktop */ }
    }
  } catch (err) {
    /* best-effort — never block startup over desktop integration */
  }
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function sendUpdateState(state, extra) {
  if (mainWindow) mainWindow.webContents.send('update:state', { state, ...extra });
}

autoUpdater.on('update-available', (info) => sendUpdateState('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateState('not-available'));
autoUpdater.on('error', (err) => sendUpdateState('error', { message: err == null ? 'Unknown error' : err.message }));
autoUpdater.on('download-progress', (progress) => sendUpdateState('downloading', { percent: progress.percent }));
autoUpdater.on('update-downloaded', (info) => sendUpdateState('downloaded', { version: info.version }));

function runUpdateCheck() {
  sendUpdateState('checking');
  if (!app.isPackaged) {
    sendUpdateState('not-available');
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => sendUpdateState('error', { message: err.message }));
}

ipcMain.handle('update:check', () => runUpdateCheck());

ipcMain.handle('update:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    sendUpdateState('error', { message: err.message });
  }
});

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall();
});

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

app.whenReady().then(() => {
  // The app is dark only. Pinning this keeps Chromium's own widgets
  // (scrollbars, form controls) dark too, whatever the desktop is set to.
  nativeTheme.themeSource = 'dark';
  ensureDesktopIntegration();
  createWindow();
  mainWindow.once('ready-to-show', runUpdateCheck);
  setInterval(runUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
});

ipcMain.handle('terminal:context-menu', (event, { hasSelection }) => {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (action) => {
      if (resolved) return;
      resolved = true;
      resolve(action);
    };
    const menu = Menu.buildFromTemplate([
      { label: 'Copy', enabled: !!hasSelection, click: () => finish('copy') },
      { label: 'Paste', click: () => finish('paste') },
    ]);
    menu.popup({ window: mainWindow, callback: () => finish(null) });
  });
});

ipcMain.handle('accent:get', () => readJson(SETTINGS_FILE(), {}).accentHue);

ipcMain.handle('accent:set', (event, hue) => {
  if (typeof hue !== 'number' || Number.isNaN(hue)) return;
  writeJson(SETTINGS_FILE(), { ...readJson(SETTINGS_FILE(), {}), accentHue: hue });
});

// Passwords are encrypted at rest via the OS keyring (safeStorage) and are
// never sent back to the renderer once saved — only a name, never the
// plaintext or ciphertext. "Typing" one decrypts it in this process only
// and writes it straight to the pty; the decrypted value never crosses
// back over IPC.
//
// Encryption at rest alone doesn't stop someone else who's simply sitting
// at this already-unlocked computer from using a saved password, so every
// credentials:* call below is also gated behind a separate vault PIN that
// auto-locks after a few minutes idle.
const VAULT_IDLE_MS = 5 * 60 * 1000;
let vaultUnlockedUntil = 0;

function readCredentialsFile() {
  return readJson(CREDENTIALS_FILE(), { pin: null, entries: [] });
}
function writeCredentialsFile(data) {
  writeJson(CREDENTIALS_FILE(), data);
}
function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 64);
}
function pinMatches(pin, salt, expectedHash) {
  const actual = hashPin(pin, salt);
  const expected = Buffer.from(expectedHash, 'hex');
  // Lengths always match here (scrypt output is fixed-size), but
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, so guard it explicitly.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function isVaultUnlocked() {
  return Date.now() < vaultUnlockedUntil;
}
function touchVaultActivity() {
  vaultUnlockedUntil = Date.now() + VAULT_IDLE_MS;
}
function sendVaultState() {
  if (mainWindow) mainWindow.webContents.send('vault:state', { unlocked: isVaultUnlocked() });
}

setInterval(() => {
  if (vaultUnlockedUntil !== 0 && !isVaultUnlocked()) {
    vaultUnlockedUntil = 0;
    sendVaultState();
  }
}, 15000);

ipcMain.handle('vault:status', () => {
  return { hasPin: !!readCredentialsFile().pin, unlocked: isVaultUnlocked() };
});

ipcMain.handle('vault:setPin', (event, pin) => {
  if (typeof pin !== 'string' || pin.length < 4) return { error: 'invalid' };
  const data = readCredentialsFile();
  if (data.pin) return { error: 'exists' };
  const salt = crypto.randomBytes(16).toString('hex');
  data.pin = { salt, hash: hashPin(pin, salt).toString('hex') };
  writeCredentialsFile(data);
  touchVaultActivity();
  sendVaultState();
  return { ok: true };
});

// Five wrong PINs lock the vault for an hour. The failure count and the
// lockout deadline are persisted in credentials.json (not just process
// memory), so quitting and relaunching the app doesn't reset the clock.
const PIN_LOCKOUT_THRESHOLD = 5;
const PIN_LOCKOUT_MS = 60 * 60 * 1000;

ipcMain.handle('vault:unlock', (event, pin) => {
  const data = readCredentialsFile();
  if (!data.pin) return { error: 'no-pin' };
  const lockout = data.lockout || { failures: 0, until: 0 };
  if (Date.now() < lockout.until) return { error: 'locked-out' };
  const ok = typeof pin === 'string' && pinMatches(pin, data.pin.salt, data.pin.hash);
  if (ok) {
    if (data.lockout) {
      delete data.lockout;
      writeCredentialsFile(data);
    }
    touchVaultActivity();
    sendVaultState();
    return { ok };
  }
  lockout.failures += 1;
  lockout.until = 0;
  if (lockout.failures >= PIN_LOCKOUT_THRESHOLD) {
    lockout.until = Date.now() + PIN_LOCKOUT_MS;
    lockout.failures = 0;
  }
  data.lockout = lockout;
  writeCredentialsFile(data);
  return lockout.until ? { ok: false, error: 'locked-out' } : { ok: false };
});

ipcMain.handle('vault:lock', () => {
  vaultUnlockedUntil = 0;
  sendVaultState();
  return { ok: true };
});

ipcMain.handle('credentials:list', () => {
  if (!isVaultUnlocked()) return { locked: true };
  touchVaultActivity();
  return { entries: readCredentialsFile().entries.map(({ id, name }) => ({ id, name })) };
});

ipcMain.handle('credentials:add', (event, { name, password }) => {
  if (!isVaultUnlocked()) return { error: 'locked' };
  if (!name || !password) return { error: 'invalid' };
  if (!safeStorage.isEncryptionAvailable()) return { error: 'unavailable' };
  const encrypted = safeStorage.encryptString(password).toString('base64');
  const data = readCredentialsFile();
  const entry = { id: crypto.randomUUID(), name, encrypted };
  data.entries.push(entry);
  writeCredentialsFile(data);
  touchVaultActivity();
  return { id: entry.id, name: entry.name };
});

ipcMain.handle('credentials:update', (event, { id, name, password }) => {
  if (!isVaultUnlocked()) return { error: 'locked' };
  if (!name) return { error: 'invalid' };
  const data = readCredentialsFile();
  const entry = data.entries.find((c) => c.id === id);
  if (!entry) return { error: 'not-found' };
  entry.name = name;
  if (password) {
    if (!safeStorage.isEncryptionAvailable()) return { error: 'unavailable' };
    entry.encrypted = safeStorage.encryptString(password).toString('base64');
  }
  writeCredentialsFile(data);
  touchVaultActivity();
  return { id: entry.id, name: entry.name };
});

ipcMain.handle('credentials:delete', (event, id) => {
  if (!isVaultUnlocked()) return { error: 'locked' };
  const data = readCredentialsFile();
  data.entries = data.entries.filter((c) => c.id !== id);
  writeCredentialsFile(data);
  touchVaultActivity();
});

ipcMain.handle('credentials:type', (event, { id, tabId }) => {
  if (!isVaultUnlocked()) return { ok: false, error: 'locked' };
  const entry = readCredentialsFile().entries.find((c) => c.id === id);
  const proc = ptyProcesses.get(tabId);
  if (!entry || !proc) return { ok: false };
  let password = safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'));
  proc.write(password + '\r');
  password = null;
  touchVaultActivity();
  return { ok: true };
});

// Confirmation happens in the renderer's own two-click "Reset" / "Confirm?"
// button, so this just does the deed once asked.
ipcMain.handle('app:reset', () => {
  for (const file of [SNIPPETS_FILE(), HISTORY_FILE(), SETTINGS_FILE(), CREDENTIALS_FILE()]) {
    try { fs.unlinkSync(file); } catch (err) { /* already gone */ }
  }
  app.relaunch();
  app.exit(0);
});

app.on('window-all-closed', () => {
  for (const proc of ptyProcesses.values()) {
    try { proc.kill(); } catch (err) { /* already gone */ }
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------- Window controls ----------

ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.close());

// ---------- PTY management ----------

function shellCommand() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

ipcMain.on('pty:spawn', (event, { tabId, cols, rows, cwd }) => {
  if (ptyProcesses.has(tabId)) return;
  const proc = pty.spawn(shellCommand(), [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: process.env,
  });

  ptyProcesses.set(tabId, proc);

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { tabId, data });
    }
  });

  proc.onExit(({ exitCode }) => {
    ptyProcesses.delete(tabId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { tabId, exitCode });
    }
  });
});

ipcMain.on('pty:write', (event, { tabId, data }) => {
  const proc = ptyProcesses.get(tabId);
  if (proc) proc.write(data);
});

ipcMain.on('pty:resize', (event, { tabId, cols, rows }) => {
  const proc = ptyProcesses.get(tabId);
  if (proc && cols > 0 && rows > 0) {
    try { proc.resize(cols, rows); } catch (err) { /* ignore transient resize errors */ }
  }
});

ipcMain.on('pty:kill', (event, { tabId }) => {
  const proc = ptyProcesses.get(tabId);
  if (proc) {
    try { proc.kill(); } catch (err) { /* already gone */ }
    ptyProcesses.delete(tabId);
  }
});

// ---------- Snippets ----------

// A blank sidebar with a "+ New snippet" button and nothing else doesn't
// show what a snippet actually is — one small, obviously-safe example
// (that also happens to be genuinely useful) makes the feature self
// explanatory. Seeded once, only if snippets.json has never existed yet
// (a fresh install, or right after "Reset all data"), and written to disk
// immediately so it's a completely normal snippet from then on — editing
// or deleting it behaves exactly like any snippet the user created
// themselves, and it won't come back on its own once it's gone.
const DEFAULT_SNIPPETS = [{ id: 'default-clear', name: 'Clear', command: 'clear' }];

ipcMain.handle('snippets:load', () => {
  const file = SNIPPETS_FILE();
  if (!fs.existsSync(file)) {
    writeJson(file, DEFAULT_SNIPPETS);
    return DEFAULT_SNIPPETS;
  }
  return readJson(file, []);
});

ipcMain.handle('snippets:save', (event, snippets) => {
  writeJson(SNIPPETS_FILE(), snippets);
  return true;
});

function snippetsToMarkdown(snippets) {
  const lines = ['# Fetch Terminal Snippets', ''];
  for (const snippet of snippets) {
    if (snippet.name && snippet.name.trim()) {
      lines.push(`## ${snippet.name.trim()}`);
    }
    lines.push('```sh');
    lines.push(snippet.command);
    lines.push('```', '');
  }
  return lines.join('\n');
}

function markdownToSnippets(markdown) {
  const lines = markdown.split(/\r?\n/);
  const snippets = [];
  let pendingName = null;
  let inFence = false;
  let fenceLines = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{2,6}\s+(.*\S)\s*$/);
    const fenceMatch = line.match(/^```(\w*)\s*$/);

    if (!inFence && fenceMatch) {
      inFence = true;
      fenceLines = [];
      continue;
    }
    if (inFence && fenceMatch) {
      inFence = false;
      const command = fenceLines.join('\n').trim();
      if (command) {
        snippets.push({
          id: `${Date.now()}-${snippets.length}-${Math.floor(Math.random() * 1e6)}`,
          name: pendingName,
          command,
        });
      }
      pendingName = null;
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    if (headingMatch) {
      pendingName = headingMatch[1];
      continue;
    }
    if (line.trim() === '') continue;
    // A bare line outside of a fence and not a heading: ignore (e.g. the title).
  }

  return snippets;
}

ipcMain.handle('snippets:export', async (event, snippets) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Snippets',
    defaultPath: 'fetch-terminal-snippets.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  fs.writeFileSync(result.filePath, snippetsToMarkdown(snippets), 'utf8');
  return { ok: true, path: result.filePath };
});

ipcMain.handle('snippets:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Snippets',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const markdown = fs.readFileSync(result.filePaths[0], 'utf8');
  return { ok: true, snippets: markdownToSnippets(markdown) };
});

// ---------- Command history ----------

ipcMain.handle('history:load', () => readJson(HISTORY_FILE(), []));

ipcMain.handle('history:add', (event, command) => {
  if (!command || !command.trim()) return readJson(HISTORY_FILE(), []);
  const history = readJson(HISTORY_FILE(), []);
  const trimmed = command.trim();
  // Skip consecutive duplicates so the list doesn't fill up with repeats.
  if (history.length && history[history.length - 1].command === trimmed) {
    return history;
  }
  history.push({ command: trimmed, timestamp: Date.now() });
  while (history.length > HISTORY_LIMIT) history.shift();
  writeJson(HISTORY_FILE(), history);
  return history;
});
