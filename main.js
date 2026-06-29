const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const DEFAULT_SETTINGS = {
  spotifyClientId: "",
  spotifyRedirectUri: "http://127.0.0.1:17321/callback",
  targetDisplayId: "",
  alwaysOnTop: false,
  startMinimizedToTray: false,
  lcdFps: 10,
  tokens: {
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
  },
};

const APP_NAME = "Spotify Lyrics LCD";
const POLL_INTERVAL_MS = 15_000;
const lyricsCache = new Map();
let mainWindow = null;
let tray = null;
let isQuitting = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

let settings = structuredClone(DEFAULT_SETTINGS);
let pollingTimer = null;
let pollInFlight = false;
let authServer = null;
let lcdBridge = null;
let lcdBridgeReady = false;
let signalRgbMonitorTimer = null;
let signalRgbOccupied = false;
let lcdStatus = {
  connected: false,
  message: "LCD bridge not started.",
};

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      tokens: {
        ...DEFAULT_SETTINGS.tokens,
        ...(parsed.tokens || {}),
      },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

function clampLcdFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps)) {
    return DEFAULT_SETTINGS.lcdFps;
  }
  return Math.min(60, Math.max(10, Math.round(fps)));
}

function startupFolderPath() {
  return path.join(
    process.env.APPDATA || app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
}

function startupLauncherPath() {
  return path.join(startupFolderPath(), `${APP_NAME}.lnk`);
}

function legacyStartupLauncherPath() {
  return path.join(startupFolderPath(), `${APP_NAME}.vbs`);
}

function startupTargetPath() {
  return app.isPackaged ? process.execPath : path.join(__dirname, "start-lyric-screen-debug.bat");
}

function createStartupShortcut(targetPath) {
  const { execFileSync } = require("child_process");
  const escapedTarget = String(targetPath).replace(/'/g, "''");
  const escapedWorkingDir = String(path.dirname(targetPath)).replace(/'/g, "''");
  const script = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$shortcut = $ws.CreateShortcut('${startupLauncherPath().replace(/'/g, "''")}')`,
    `$shortcut.TargetPath = '${escapedTarget}'`,
    `$shortcut.WorkingDirectory = '${escapedWorkingDir}'`,
    `$shortcut.WindowStyle = 1`,
    `$shortcut.Description = '${APP_NAME.replace(/'/g, "''")}'`,
    "$shortcut.Save()",
  ].join("; ");

  execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
}

function bridgeBasePath() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function trayIconPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "icon.ico") : path.join(__dirname, "build", "icon.ico");
}

function lcdBridgeExecutablePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "lcd_bridge.exe")
    : path.join(__dirname, "lcd_bridge.py");
}

function isLaunchAtStartupEnabled() {
  return fs.existsSync(startupLauncherPath()) || fs.existsSync(legacyStartupLauncherPath());
}

function setLaunchAtStartup(openAtLogin) {
  if (openAtLogin) {
    fs.mkdirSync(startupFolderPath(), { recursive: true });
    createStartupShortcut(startupTargetPath());
    if (fs.existsSync(legacyStartupLauncherPath())) {
      fs.unlinkSync(legacyStartupLauncherPath());
    }
  } else {
    if (fs.existsSync(startupLauncherPath())) {
      fs.unlinkSync(startupLauncherPath());
    }
    if (fs.existsSync(legacyStartupLauncherPath())) {
      fs.unlinkSync(legacyStartupLauncherPath());
    }
  }
  return isLaunchAtStartupEnabled();
}

function migrateStartupShortcut() {
  const legacyPath = legacyStartupLauncherPath();
  const shortcutPath = startupLauncherPath();

  if (!fs.existsSync(legacyPath) || fs.existsSync(shortcutPath)) {
    return;
  }

  try {
    fs.mkdirSync(startupFolderPath(), { recursive: true });
    createStartupShortcut(startupTargetPath());
    fs.unlinkSync(legacyPath);
  } catch (error) {
    console.warn(`Failed to migrate startup shortcut: ${error.message}`);
  }
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createCodeVerifier() {
  return base64Url(crypto.randomBytes(32));
}

function createCodeChallenge(verifier) {
  return base64Url(crypto.createHash("sha256").update(verifier).digest());
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function parseSyncedLyrics(text) {
  if (!text) {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\[(\d+):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);

      if (!match) {
        return null;
      }

      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = Number(String(match[3] || "0").padEnd(3, "0").slice(0, 3));
      const textValue = match[4].trim();

      return {
        startMs: minutes * 60_000 + seconds * 1_000 + fraction,
        text: textValue,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs);
}

function currentSettingsSnapshot() {
  return {
    spotifyClientId: settings.spotifyClientId,
    spotifyRedirectUri: settings.spotifyRedirectUri,
    targetDisplayId: settings.targetDisplayId || "",
    alwaysOnTop: settings.alwaysOnTop,
    startMinimizedToTray: Boolean(settings.startMinimizedToTray),
    lcdFps: clampLcdFps(settings.lcdFps),
    hasRefreshToken: Boolean(settings.tokens.refreshToken),
    launchAtStartup: isLaunchAtStartupEnabled(),
  };
}

function emitState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("player-state", {
    ...state,
    settings: currentSettingsSnapshot(),
    lcd: {
      ...lcdStatus,
    },
    updatedAt: Date.now(),
  });

  pushBridgeState(state);
}

function setWindowAlwaysOnTop(value) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(Boolean(value));
  }
  settings.alwaysOnTop = Boolean(value);
  saveSettings();
  emitState(lastKnownState);
}

function setWindowSkipTaskbar(value) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSkipTaskbar(Boolean(value));
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  setWindowSkipTaskbar(false);
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.hide();
  setWindowSkipTaskbar(true);
}

function sendBridgeCommand(command) {
  if (!lcdBridge || !lcdBridge.stdin.writable || !lcdBridgeReady) {
    return false;
  }

  try {
    lcdBridge.stdin.write(`${JSON.stringify({ type: "command", command })}\n`);
    return true;
  } catch (error) {
    console.warn(`Failed to send bridge command: ${error.message}`);
    return false;
  }
}

function stopLcdBridge(clearScreen = false) {
  if (!lcdBridge) {
    lcdBridgeReady = false;
    return;
  }

  if (clearScreen) {
    sendBridgeCommand("clear");
  }

  try {
    if (lcdBridge.stdin && !lcdBridge.stdin.destroyed) {
      lcdBridge.stdin.end();
    }
  } catch (error) {
    console.warn(`Failed to close LCD bridge stdin: ${error.message}`);
  }

  const bridge = lcdBridge;
  const bridgePid = bridge.pid;
  lcdBridge = null;
  lcdBridgeReady = false;

  const forceKillBridge = () => {
    if (bridge.exitCode !== null || bridge.killed) {
      return;
    }

    try {
      if (process.platform === "win32" && bridgePid) {
        require("child_process").spawnSync(
          "taskkill",
          ["/PID", String(bridgePid), "/T", "/F"],
          { stdio: "ignore" }
        );
      } else {
        bridge.kill();
      }
    } catch (error) {
      console.warn(`Failed to stop LCD bridge: ${error.message}`);
    }
  };

  if (clearScreen) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    } catch {
      // Ignore if Atomics.wait is unavailable.
    }
  }

  forceKillBridge();
}

function shutdownApp() {
  stopPolling();
  stopSignalRgbMonitor();
  cleanupAuthListener();
  stopLcdBridge(true);
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const { Menu } = require("electron");
  const template = [
    {
      label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? "隱藏視窗" : "顯示視窗",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          hideMainWindowToTray();
        } else {
          showMainWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: "重新整理",
      click: () => {
        loadPlaybackState(true);
      },
    },
    {
      label: "離開",
      click: () => {
        isQuitting = true;
        shutdownApp();
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  if (tray) {
    return;
  }

  const { Menu, Tray, nativeImage } = require("electron");
  const iconPath = trayIconPath();
  if (!fs.existsSync(iconPath)) {
    console.warn("Tray icon not found, skipping tray creation.");
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      hideMainWindowToTray();
    } else {
      showMainWindow();
    }
  });

  tray.on("right-click", () => {
    updateTrayMenu();
    tray.popUpContextMenu();
  });

  tray.setContextMenu(Menu.buildFromTemplate([]));
  updateTrayMenu();
}

function moveWindowToDisplay(displayId, fullscreen = false) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const display =
    screen.getAllDisplays().find((item) => String(item.id) === String(displayId)) ||
    screen.getPrimaryDisplay();

  if (!display) {
    return;
  }

  const { x, y, width, height } = display.bounds;

  mainWindow.setFullScreen(false);
  mainWindow.setBounds({ x, y, width, height }, false);
  mainWindow.setAlwaysOnTop(Boolean(settings.alwaysOnTop));
  mainWindow.show();
  mainWindow.focus();

  if (fullscreen) {
    mainWindow.setFullScreen(true);
  }
}

let lastKnownState = {
  connected: false,
  status: "idle",
  message: "先輸入 Spotify Client ID 再按連接。",
  track: null,
};

function updateState(partial) {
  lastKnownState = {
    ...lastKnownState,
    ...partial,
  };
  emitState(lastKnownState);
}

function setLcdStatus(partial) {
  lcdStatus = {
    ...lcdStatus,
    ...partial,
  };

  emitState(lastKnownState);
}

function detectSignalRgbService() {
  try {
    const service = require("child_process").execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Service -Filter \"Name='SignalRgb.Service'\" | Select-Object -ExpandProperty State",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();

    return service === "Running";
  } catch {
    return false;
  }
}

function signalRgbStatusMessage(occupied) {
  return occupied
    ? "SignalRGB 服務正在占用 LCD，請先停止 SignalRgb.Service。"
    : "SignalRGB 未占用 LCD。";
}

function refreshSignalRgbMonitor(initial = false) {
  const occupied = detectSignalRgbService();

  if (occupied === signalRgbOccupied && !initial) {
    return;
  }

  signalRgbOccupied = occupied;

  if (occupied) {
    setLcdStatus({
      connected: false,
      message: signalRgbStatusMessage(true),
    });
    if (lcdBridge && !lcdBridge.killed) {
      lcdBridge.kill();
    }
    return;
  }

  if (!lcdBridgeReady || !lcdBridge) {
    startLcdBridge();
    return;
  }

  if (lcdBridgeReady && lcdBridge) {
    setLcdStatus({
      connected: true,
      message: "LCD 已連線，正在送歌詞畫面。",
    });
  } else {
    setLcdStatus({
      connected: false,
      message: signalRgbStatusMessage(false),
    });
  }
}

function startSignalRgbMonitor() {
  refreshSignalRgbMonitor(true);

  if (signalRgbMonitorTimer) {
    clearInterval(signalRgbMonitorTimer);
  }

  signalRgbMonitorTimer = setInterval(() => {
    refreshSignalRgbMonitor(false);
  }, 10_000);
}

function stopSignalRgbMonitor() {
  if (signalRgbMonitorTimer) {
    clearInterval(signalRgbMonitorTimer);
    signalRgbMonitorTimer = null;
  }
}

function startLcdBridge() {
  const bridgeCwd = bridgeBasePath();
  const bridgePath = lcdBridgeExecutablePath();

  if (!fs.existsSync(bridgePath)) {
    console.warn("LCD bridge not found, skipping direct LCD output.");
    return;
  }

  if (lcdBridge || lcdBridgeReady) {
    stopLcdBridge(false);
  }

  if (detectSignalRgbService()) {
    signalRgbOccupied = true;
    setLcdStatus({
      connected: false,
      message: signalRgbStatusMessage(true),
    });
    return;
  }

  setLcdStatus({ connected: false, message: "正在啟動 LCD bridge..." });
  const launchCommand = app.isPackaged ? bridgePath : (process.env.PYTHON || "python");
  const launchArgs = app.isPackaged ? [] : ["-u", bridgePath];
  lcdBridge = spawn(launchCommand, launchArgs, {
    cwd: bridgeCwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  lcdBridgeReady = true;

  lcdBridge.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);

    if (text.includes("Connected to")) {
      signalRgbOccupied = false;
      setLcdStatus({ connected: true, message: "LCD 已連線，正在送歌詞畫面。" });
    } else if (text.includes("access denied")) {
      signalRgbOccupied = true;
      setLcdStatus({
        connected: false,
        message: "LCD 被占用或權限不足，請先停止 SignalRgb.Service 或其他控制軟體。",
      });
    } else if (text.includes("not found")) {
      setLcdStatus({ connected: false, message: "找不到 LCD，請確認裝置已接上。" });
    }
  });

  lcdBridge.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  lcdBridge.on("exit", (code, signal) => {
    lcdBridgeReady = false;
    lcdBridge = null;
    console.warn(`LCD bridge exited (${code ?? "null"}, ${signal ?? "null"}).`);
    setLcdStatus({ connected: false, message: "LCD bridge 已停止。" });
  });
}

function pushBridgeState(state) {
  if (!lcdBridge || !lcdBridge.stdin.writable || !lcdBridgeReady) {
    return;
  }

  const payload = {
    type: "state",
    state: {
      ...state,
      settings: currentSettingsSnapshot(),
      updatedAt: Date.now(),
    },
  };

  try {
    lcdBridge.stdin.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    console.warn(`Failed to send state to LCD bridge: ${error.message}`);
  }
}

function mapTrack(playback) {
  const item = playback.item;
  const artist = item.artists?.[0]?.name || "";

  return {
    id: item.id || `${item.name}-${artist}`,
    title: item.name || "",
    artist,
    album: item.album?.name || "",
    durationMs: item.duration_ms || 0,
    progressMs: playback.progress_ms || 0,
    isPlaying: Boolean(playback.is_playing),
    albumArtUrl: item.album?.images?.[0]?.url || "",
    externalUrl: item.external_urls?.spotify || "",
  };
}

function scoreCandidate(candidate, track) {
  const candidateTrack = normalizeText(candidate.trackName || candidate.name);
  const candidateArtist = normalizeText(candidate.artistName);
  const candidateAlbum = normalizeText(candidate.albumName);
  const targetTrack = normalizeText(track.title);
  const targetArtist = normalizeText(track.artist);
  const targetAlbum = normalizeText(track.album);
  const candidateDuration = Number(candidate.duration || 0);
  const targetDuration = Math.round(track.durationMs / 1000);

  let score = 0;

  if (candidateTrack === targetTrack) score += 50;
  if (candidateArtist === targetArtist) score += 40;
  if (candidateAlbum && candidateAlbum === targetAlbum) score += 10;
  if (Math.abs(candidateDuration - targetDuration) <= 2) score += 15;
  if (candidate.syncedLyrics) score += 5;

  return score;
}

function normalizeLyricsPayload(payload) {
  const syncedLyrics = parseSyncedLyrics(payload.syncedLyrics || "");

  return {
    source: "LRCLIB",
    mode: syncedLyrics.length > 0 ? "synced" : payload.plainLyrics ? "plain" : "empty",
    syncedLyrics,
    plainLyrics: payload.plainLyrics || "",
    trackName: payload.trackName || payload.name || "",
    artistName: payload.artistName || "",
    albumName: payload.albumName || "",
  };
}

async function fetchLyrics(track) {
  const cacheKey = `${normalizeText(track.title)}|${normalizeText(track.artist)}|${normalizeText(track.album)}|${Math.round(
    track.durationMs / 1000
  )}`;

  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey);
  }

  const baseParams = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist,
    duration: String(Math.max(1, Math.round(track.durationMs / 1000))),
  });

  if (track.album) {
    baseParams.set("album_name", track.album);
  }

  const getResponse = await fetch(`https://lrclib.net/api/get?${baseParams.toString()}`, {
    headers: {
      "User-Agent": "SpotifyLyricsLCD/0.2.0",
    },
  });

  if (getResponse.ok) {
    const payload = await getResponse.json();
    const lyrics = normalizeLyricsPayload(payload);
    lyricsCache.set(cacheKey, lyrics);
    return lyrics;
  }

  const searchParams = new URLSearchParams({
    q: `${track.artist} ${track.title}`.trim(),
  });

  const searchResponse = await fetch(`https://lrclib.net/api/search?${searchParams.toString()}`, {
    headers: {
      "User-Agent": "SpotifyLyricsLCD/0.2.0",
    },
  });

  if (!searchResponse.ok) {
    lyricsCache.set(cacheKey, null);
    return null;
  }

  const results = await searchResponse.json();
  if (!Array.isArray(results) || results.length === 0) {
    lyricsCache.set(cacheKey, null);
    return null;
  }

  const bestMatch = results
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, track) }))
    .sort((a, b) => b.score - a.score)[0]?.candidate;

  if (!bestMatch) {
    lyricsCache.set(cacheKey, null);
    return null;
  }

  const lyrics = normalizeLyricsPayload(bestMatch);
  lyricsCache.set(cacheKey, lyrics);
  return lyrics;
}

async function fetchSpotifyCurrentPlayback(accessToken) {
  const response = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 204 || response.status === 304) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify 讀取失敗: ${response.status} ${text}`.trim());
  }

  return response.json();
}

async function exchangeAuthorizationCode(code, verifier) {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: settings.spotifyClientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: settings.spotifyRedirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify 授權失敗: ${response.status} ${text}`.trim());
  }

  return response.json();
}

async function refreshAccessToken() {
  if (!settings.tokens.refreshToken) {
    throw new Error("沒有 refresh token，請重新連接 Spotify。");
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: settings.spotifyClientId,
      grant_type: "refresh_token",
      refresh_token: settings.tokens.refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify token 刷新失敗: ${response.status} ${text}`.trim());
  }

  const payload = await response.json();
  settings.tokens.accessToken = payload.access_token;
  settings.tokens.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
  if (payload.refresh_token) {
    settings.tokens.refreshToken = payload.refresh_token;
  }
  saveSettings();
  return settings.tokens.accessToken;
}

async function ensureAccessToken() {
  if (!settings.tokens.accessToken) {
    throw new Error("尚未連接 Spotify。");
  }

  if (Date.now() > settings.tokens.expiresAt - 60_000) {
    return refreshAccessToken();
  }

  return settings.tokens.accessToken;
}

async function loadPlaybackState(forceLyricsRefresh = false) {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;

  try {
    if (!settings.tokens.refreshToken || !settings.spotifyClientId) {
      updateState({
        connected: false,
        status: "setup",
        message: "先填 Spotify Client ID，然後按連接。",
        track: null,
      });
      return;
    }

    const accessToken = await ensureAccessToken();
    const playback = await fetchSpotifyCurrentPlayback(accessToken);

    if (!playback || !playback.item) {
      updateState({
        connected: true,
        status: "idle",
        message: "Spotify 目前沒有正在播放的歌曲。",
        track: null,
      });
      return;
    }

    const track = mapTrack(playback);
    const trackKey = `${track.id}|${track.title}|${track.artist}`;
    const cacheKey = `${normalizeText(track.title)}|${normalizeText(track.artist)}|${normalizeText(track.album)}|${Math.round(
      track.durationMs / 1000
    )}`;
    let lyrics = lyricsCache.get(cacheKey);

    if (forceLyricsRefresh || !lyrics || lastKnownState.track?.id !== track.id || !lastKnownState.track?.lyrics) {
      lyrics = await fetchLyrics(track);
    }

    updateState({
      connected: true,
      status: "playing",
      message: lyrics ? "同步歌詞已載入。" : "找不到同步歌詞，正在顯示歌曲資訊。",
      track: {
        ...track,
        lyrics,
        trackKey,
      },
    });
  } catch (error) {
    updateState({
      connected: false,
      status: "error",
      message: error.message,
      track: null,
    });
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  loadPlaybackState(true);
  restartPollingTimer();
}

function restartPollingTimer() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
  }

  pollingTimer = setInterval(() => {
    loadPlaybackState(false);
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 680,
    height: 620,
    minWidth: 560,
    minHeight: 520,
    backgroundColor: "#101114",
    show: !settings.startMinimizedToTray,
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(Boolean(settings.alwaysOnTop));
  mainWindow.setSkipTaskbar(Boolean(settings.startMinimizedToTray));

  mainWindow.on("minimize", (event) => {
    event.preventDefault();
    hideMainWindowToTray();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    hideMainWindowToTray();
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.once("did-finish-load", () => {
    emitState(lastKnownState);
    emitState({
      ...lastKnownState,
      settings: currentSettingsSnapshot(),
    });
    if (settings.tokens.refreshToken && settings.spotifyClientId) {
      startPolling();
    } else {
      updateState({
        connected: false,
        status: "setup",
        message: "先填 Spotify Client ID，然後按連接。",
        track: null,
      });
    }

    if (settings.targetDisplayId) {
      moveWindowToDisplay(settings.targetDisplayId, false);
    }

    if (settings.startMinimizedToTray) {
      hideMainWindowToTray();
    }
  });
}

function startAuthListener() {
  const redirect = new URL(settings.spotifyRedirectUri);
  const host = redirect.hostname;
  const port = Number(redirect.port || "17321");
  const callbackPath = redirect.pathname || "/";
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = new URL("https://accounts.spotify.com/authorize");

  authUrl.searchParams.set("client_id", settings.spotifyClientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", settings.spotifyRedirectUri);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "user-read-currently-playing user-read-playback-state");

  if (authServer) {
    authServer.close();
    authServer = null;
  }

  return new Promise((resolve, reject) => {
    authServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, settings.spotifyRedirectUri);

      if (requestUrl.pathname !== callbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const returnedState = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Spotify 授權失敗，請回到 app 重試。");
        cleanupAuthListener();
        reject(new Error(error));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Spotify 回傳內容不正確，請重試。");
        cleanupAuthListener();
        reject(new Error("Spotify callback 驗證失敗。"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html>
          <body style="font-family:Segoe UI, sans-serif; background:#0b1022; color:#fff; display:grid; place-items:center; min-height:100vh; margin:0;">
            <div style="text-align:center; max-width:520px; padding:32px;">
              <h1 style="margin:0 0 12px;">Spotify 已連接</h1>
              <p style="margin:0; opacity:.8;">你可以關閉這個頁面，回到 app 繼續看歌詞。</p>
            </div>
          </body>
        </html>
      `);

      exchangeAuthorizationCode(code, verifier)
        .then((tokenPayload) => {
          settings.tokens.accessToken = tokenPayload.access_token;
          settings.tokens.refreshToken = tokenPayload.refresh_token;
          settings.tokens.expiresAt = Date.now() + Number(tokenPayload.expires_in || 3600) * 1000;
          saveSettings();
          cleanupAuthListener();
          resolve(tokenPayload);
        })
        .catch((err) => {
          cleanupAuthListener();
          reject(err);
        });
    });

    authServer.on("error", (error) => {
      cleanupAuthListener();
      reject(error);
    });

    authServer.listen(port, host, () => {
      shell.openExternal(authUrl.toString());
    });
  });
}

function cleanupAuthListener() {
  if (authServer) {
    authServer.close();
    authServer = null;
  }
}

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    updateTrayMenu();
  }
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  app.setName(APP_NAME);
  settings = loadSettings();
  settings.lcdFps = clampLcdFps(settings.lcdFps);
  if (settings.alwaysOnTop) {
    settings.alwaysOnTop = false;
    saveSettings();
  }
  migrateStartupShortcut();
  createTray();
  startLcdBridge();
  startSignalRgbMonitor();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  shutdownApp();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    return;
  }
});

ipcMain.handle("settings:get", async () => currentSettingsSnapshot());

ipcMain.handle("settings:save", async (_, partial) => {
  settings = {
    ...settings,
    ...partial,
    lcdFps: partial.lcdFps === undefined ? settings.lcdFps : clampLcdFps(partial.lcdFps),
    tokens: {
      ...settings.tokens,
      ...(partial.tokens || {}),
    },
  };

  saveSettings();
  emitState(lastKnownState);
  return currentSettingsSnapshot();
});

ipcMain.handle("spotify:connect", async () => {
  if (!settings.spotifyClientId) {
    throw new Error("請先輸入 Spotify Client ID。");
  }

  const tokenPayload = await startAuthListener();
  startPolling();
  return {
    connected: true,
    expiresAt: settings.tokens.expiresAt,
    accessToken: tokenPayload.access_token,
  };
});

ipcMain.handle("window:set-always-on-top", async (_, value) => {
  setWindowAlwaysOnTop(value);
  return currentSettingsSnapshot();
});

ipcMain.handle("window:set-fullscreen", async (_, value) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(Boolean(value));
  }
  return { fullscreen: Boolean(value) };
});

ipcMain.handle("window:set-display", async (_, displayId, fullscreen = false) => {
  settings.targetDisplayId = String(displayId || "");
  saveSettings();
  moveWindowToDisplay(settings.targetDisplayId, fullscreen);
  emitState(lastKnownState);
  return currentSettingsSnapshot();
});

ipcMain.handle("display:list", async () => {
  return screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    label: `${display.label || `Display ${display.id}`}${display.primary ? " (Primary)" : ""}`,
    primary: Boolean(display.primary),
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
  }));
});

ipcMain.handle("window:sync-display", async (_, fullscreen = false) => {
  moveWindowToDisplay(settings.targetDisplayId, fullscreen);
  return currentSettingsSnapshot();
});

ipcMain.handle("app:refresh", async () => {
  await loadPlaybackState(true);
  restartPollingTimer();
  return lastKnownState;
});

ipcMain.handle("startup:set", async (_, value) => {
  const launchAtStartup = setLaunchAtStartup(Boolean(value));
  emitState(lastKnownState);
  return { launchAtStartup };
});

ipcMain.handle("tray:set-start-minimized", async (_, value) => {
  settings.startMinimizedToTray = Boolean(value);
  saveSettings();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSkipTaskbar(Boolean(settings.startMinimizedToTray));
    if (settings.startMinimizedToTray && mainWindow.isVisible()) {
      hideMainWindowToTray();
    }
    updateTrayMenu();
  }

  emitState(lastKnownState);
  return currentSettingsSnapshot();
});
