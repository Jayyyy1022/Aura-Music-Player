const { app, BrowserWindow, ipcMain, shell, desktopCapturer, screen, Tray, Menu, globalShortcut, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
let DiscordRPC; try { DiscordRPC = require('discord-rpc'); } catch {}
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { exec, spawn } = require('child_process');

process.on('unhandledRejection', () => {});

// ── Discord Application ID ─────────────────────────────────────
// Create a Discord app at discord.com/developers/applications, then paste the Application ID here:
const DISCORD_CLIENT_ID = '';

let mainWindow;
let miniPlayerWindow;
let immersiveWindow;
let tray = null;
let isQuitting = false;
let closeToTray = true;
let rpc = null;
let authServer;
let codeVerifier;
let tokens = {};

const CONFIG_PATH = path.join(__dirname, 'config.json');
const BUNDLED_CLIENT_ID = '8eaca3ad76a24719ba4a86a5cb6a77d2';
let config = { CLIENT_ID: BUNDLED_CLIENT_ID };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { CLIENT_ID: saved.CLIENT_ID || BUNDLED_CLIENT_ID };
      if (saved.closeToTray === false) closeToTray = false;
    }
  } catch (e) {}
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...config, closeToTray }, null, 2)); } catch (e) {}
}

function saveTokens(data) {
  try {
    const p = path.join(app.getPath('userData'), 'tokens.json');
    fs.writeFileSync(p, JSON.stringify(data));
  } catch (e) {}
}

function loadTokens() {
  try {
    const p = path.join(app.getPath('userData'), 'tokens.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {}
  return null;
}

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-top-read',
  'user-read-recently-played',
].join(' ');

// ── Tray ──────────────────────────────────────────────────────
function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'icon.ico'));
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('Aura');
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else { mainWindow?.show(); mainWindow?.focus(); }
  });
  updateTrayMenu({ isPlaying: false, title: '', artist: '' });
}

function updateTrayMenu({ isPlaying, title, artist }) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: title || 'Aura', enabled: false },
    ...(artist ? [{ label: artist, enabled: false }] : []),
    { type: 'separator' },
    { label: isPlaying ? '⏸  Pause' : '▶  Play', click: () => mainWindow?.webContents.send('tray:action', 'play-pause') },
    { label: '⏮  Previous',                        click: () => mainWindow?.webContents.send('tray:action', 'prev') },
    { label: '⏭  Next',                             click: () => mainWindow?.webContents.send('tray:action', 'next') },
    { type: 'separator' },
    { label: 'Show / Hide', click: () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show() },
    { label: 'Quit Aura',   click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ── Discord RPC ───────────────────────────────────────────────
function initDiscord() {
  if (!DISCORD_CLIENT_ID || !DiscordRPC) return;
  DiscordRPC.register(DISCORD_CLIENT_ID);
  rpc = new DiscordRPC.Client({ transport: 'ipc' });
  rpc.on('ready', () => console.log('[Discord] RPC ready'));
  rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(() => {});
}

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    frame: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Allow system audio loopback capture for visualizer
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  });

  // F12 打开 DevTools 调试
  const { globalShortcut } = require('electron');
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.openDevTools();
  });
}

function createMiniPlayerWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  miniPlayerWindow = new BrowserWindow({
    width: 340,
    height: 62,
    x: Math.floor(bounds.width / 2 - 170),
    y: 6,
    minWidth: 200,
    maxWidth: 640,
    minHeight: 48,
    maxHeight: 96,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'mini-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  miniPlayerWindow.loadFile(path.join(__dirname, 'renderer', 'mini-player.html'));
  miniPlayerWindow.setAlwaysOnTop(true, 'screen-saver');
  miniPlayerWindow.on('closed', () => { miniPlayerWindow = null; });
}

app.whenReady().then(() => {
  loadConfig();
  tokens = loadTokens() || {};
  createWindow();
  createMiniPlayerWindow();
  createTray();
  initDiscord();

  app.on('before-quit', () => { isQuitting = true; });
  mainWindow.on('close', (e) => {
    if (!isQuitting && closeToTray) { e.preventDefault(); mainWindow.hide(); }
    else { isQuitting = true; miniPlayerWindow?.destroy(); immersiveWindow?.destroy(); }
  });
  mainWindow.on('focus', () => {
    if (immersiveWindow?.isVisible()) immersiveWindow.hide();
  });
  // Global hotkeys (Ctrl+Alt+←/Space/→)
  globalShortcut.register('CmdOrCtrl+Alt+Space', () => mainWindow?.webContents.send('hotkey', 'play-pause'));
  globalShortcut.register('CmdOrCtrl+Alt+Right', () => mainWindow?.webContents.send('hotkey', 'next'));
  globalShortcut.register('CmdOrCtrl+Alt+Left',  () => mainWindow?.webContents.send('hotkey', 'prev'));

  // Auto-updater
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  autoUpdater.on('update-available',  () => mainWindow?.webContents.send('update:available'));
  autoUpdater.on('update-downloaded', () => mainWindow?.webContents.send('update:downloaded'));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  rpc?.destroy().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---
ipcMain.on('set-app-icon', (_, dataUrl) => {
  try {
    const { nativeImage } = require('electron');
    mainWindow?.setIcon(nativeImage.createFromDataURL(dataUrl));
  } catch {}
});

ipcMain.handle('get-client-id', () => config.CLIENT_ID || '');

ipcMain.handle('save-client-id', (_, clientId) => {
  config.CLIENT_ID = clientId.trim();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return true;
});

ipcMain.handle('get-saved-token', () => tokens.access_token || null);

ipcMain.handle('spotify-login', async () => {
  if (!config.CLIENT_ID) throw new Error('No Client ID configured');

  codeVerifier = crypto.randomBytes(96).toString('base64url');
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  const params = new URLSearchParams({
    client_id: config.CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
  });

  return new Promise((resolve, reject) => {
    if (authServer) { try { authServer.close(); } catch (e) {} }

    authServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://localhost:8888');
      if (reqUrl.pathname !== '/callback') return;

      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#121212;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><h2 style="color:#1DB954">✓ 授权成功！</h2><p style="color:#b3b3b3">请返回 Spotify Player 应用</p></body></html>');

      authServer.close();
      authServer = null;

      if (error) { reject(new Error(error)); return; }

      try {
        const data = await exchangeCode(code);
        tokens = data;
        saveTokens(data);
        resolve(data.access_token);
      } catch (e) {
        reject(e);
      }
    });

    authServer.on('error', reject);
    authServer.listen(8888, () => {
      shell.openExternal(`https://accounts.spotify.com/authorize?${params}`);
    });
  });
});

async function exchangeCode(code) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: config.CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

ipcMain.handle('refresh-token', async () => {
  if (!tokens.refresh_token || !config.CLIENT_ID) return null;
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: config.CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    tokens.access_token = data.access_token;
    if (data.refresh_token) tokens.refresh_token = data.refresh_token;
    saveTokens(tokens);
    return tokens.access_token;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('logout', () => {
  tokens = {};
  try {
    const p = path.join(app.getPath('userData'), 'tokens.json');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
  return true;
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('set-close-to-tray', (_, val) => { closeToTray = val; saveConfig(); });
ipcMain.handle('get-close-to-tray', () => closeToTray);
ipcMain.on('window-fullscreen', () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ── Tray / Hotkey / Updater / Discord IPC ────────────────
ipcMain.on('tray:update',    (_, data) => updateTrayMenu(data));
ipcMain.on('update:install', ()        => autoUpdater.quitAndInstall());
ipcMain.on('discord:update', (_, d)    => {
  if (!rpc?.user) return;
  try {
    const now = Date.now();
    rpc.setActivity({
      details:        d.title  || 'Aura',
      state:          d.artist ? `by ${d.artist}` : undefined,
      startTimestamp: d.isPlaying ? now - (d.positionMs || 0) : undefined,
      endTimestamp:   d.isPlaying && d.durationMs ? now - (d.positionMs || 0) + d.durationMs : undefined,
      largeImageKey:  d.artUrl || 'aura',
      largeImageText: 'Aura Music Player',
      smallImageKey:  d.isPlaying ? 'play' : 'pause',
      smallImageText: d.isPlaying ? 'Playing' : 'Paused',
      instance: false,
    });
  } catch {}
});

// ── Immersive Window ──────────────────────────────────────
function createImmersiveWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  immersiveWindow = new BrowserWindow({
    width: bounds.width, height: bounds.height,
    x: bounds.x, y: bounds.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-immersive.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  immersiveWindow.loadFile(path.join(__dirname, 'renderer', 'immersive.html'));
  immersiveWindow.on('closed', () => { immersiveWindow = null; });
}

ipcMain.on('immersive:show', (_, data) => {
  if (!immersiveWindow) createImmersiveWindow();
  if (data) immersiveWindow.webContents.send('immersive:update', data);
  if (immersiveWindow.isVisible()) return;
  const doShow = () => {
    immersiveWindow.showInactive();
    immersiveWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow?.minimize();
  };
  if (immersiveWindow.webContents.isLoading()) immersiveWindow.once('ready-to-show', doShow);
  else doShow();
});
ipcMain.on('immersive:hide', () => immersiveWindow?.hide());
ipcMain.on('immersive:update', (_, d) => {
  if (immersiveWindow?.isVisible()) immersiveWindow.webContents.send('immersive:update', d);
});
ipcMain.on('immersive:lyrics', (_, d) => {
  if (immersiveWindow?.isVisible()) immersiveWindow.webContents.send('immersive:lyrics', d);
});
ipcMain.on('immersive:progress', (_, d) => {
  if (immersiveWindow?.isVisible()) immersiveWindow.webContents.send('immersive:progress', d);
});
ipcMain.on('immersive:queue', (_, d) => {
  if (immersiveWindow?.isVisible()) immersiveWindow.webContents.send('immersive:queue', d);
});
ipcMain.on('immersive:mouse-ignore', (_, v) => {
  if (!immersiveWindow) return;
  if (v) immersiveWindow.setIgnoreMouseEvents(true, { forward: true });
  else   immersiveWindow.setIgnoreMouseEvents(false);
});
ipcMain.on('immersive:glass-mode', (_, m) => {
  immersiveWindow?.webContents.send('immersive:glass-mode', m);
});
ipcMain.on('immersive:action', (_, type) => {
  if (type === 'focus-main') { mainWindow?.show(); mainWindow?.focus(); return; }
  if (type === 'close-immersive') {
    immersiveWindow?.hide();
    mainWindow?.show();
    mainWindow?.focus();
    return;
  }
  mainWindow?.webContents.send('immersive:action', type);
});
ipcMain.on('immersive:close', () => {
  immersiveWindow?.hide();
  mainWindow?.show();
  mainWindow?.focus();
});

// ── Mini Player IPC ───────────────────────────────────────
ipcMain.on('mini:show', (_, data) => {
  if (!miniPlayerWindow) return;
  if (data) miniPlayerWindow.webContents.send('mini:update', data);
  miniPlayerWindow.showInactive();
});
ipcMain.on('mini:hide', () => miniPlayerWindow?.hide());
ipcMain.on('mini:update', (_, data) => {
  if (miniPlayerWindow?.isVisible()) miniPlayerWindow.webContents.send('mini:update', data);
});
ipcMain.on('mini:lyric', (_, text) => {
  if (miniPlayerWindow?.isVisible()) miniPlayerWindow.webContents.send('mini:lyric', text);
});
ipcMain.on('mini:action', (_, type) => {
  if (type === 'dismiss') { miniPlayerWindow?.hide(); return; }
  if (type === 'open-npo') { mainWindow?.show(); mainWindow?.focus(); }
  mainWindow?.webContents.send('mini:action', type);
});

// ── Spotify Auto-Launch ────────────────────────────────────
function findSpotifyExe() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Spotify', 'Spotify.exe'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function isSpotifyRunning() {
  return new Promise(resolve => {
    exec('tasklist /FI "IMAGENAME eq Spotify.exe" /NH', { windowsHide: true }, (err, stdout) => {
      resolve(!!(stdout && stdout.toLowerCase().includes('spotify.exe')));
    });
  });
}

ipcMain.handle('fetch-lyrics', async (_, trackId, token) => {
  try {
    const res = await fetch(
      `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`,
      { headers: { 'Authorization': `Bearer ${token}`, 'App-Platform': 'WebPlayer' } }
    );
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
});

ipcMain.handle('launch-spotify', async () => {
  console.log('[Spotify] launch-spotify called');
  const alreadyRunning = await isSpotifyRunning();
  console.log('[Spotify] alreadyRunning:', alreadyRunning);
  let status = 'already_running';

  if (!alreadyRunning) {
    const spotifyPath = findSpotifyExe();
    if (!spotifyPath) return { status: 'not_found' };
    const proc = spawn(spotifyPath, [], { detached: true, stdio: 'ignore' });
    proc.unref();
    status = 'launched';
  }

  // Always hide Spotify window — whether just launched or already open
  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern int SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
for ($i = 0; $i -lt 100; $i++) {
    Start-Sleep -Milliseconds 50
    $procs = Get-Process -Name "Spotify" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle.ToInt64() -ne 0 }
    if ($procs) {
        foreach ($p in $procs) {
            [WinApi]::ShowWindow($p.MainWindowHandle, 0) | Out-Null
        }
        break
    }
}
`;
  const scriptPath = path.join(app.getPath('temp'), 'hide-spotify.ps1');
  fs.writeFileSync(scriptPath, psScript, 'utf8');
  console.log('[Spotify] script written to:', scriptPath);

  exec(`powershell -ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File "${scriptPath}"`, { windowsHide: true }, () => {});

  return { status };
});
