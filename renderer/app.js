// ── Splash Animation ─────────────────────────────────────────
(function() {
  const splash = document.getElementById('splash-screen');
  const barsEl = document.getElementById('splash-bars');
  if (!splash || !barsEl) return;
  const heights = [25,62,88,45,72,33,95,58,42,78,52,84,28,68,82,48,65,76,30,92,50,70,38,87,60,40,73,55,90,35,64,80];
  const durs    = [.52,.58,.50,.62,.55,.60,.48,.56,.53,.61,.57,.50,.64,.54,.59,.51,.60,.55,.63,.50,.58,.52,.61,.56,.54,.62,.50,.59,.53,.60,.57,.51];
  heights.forEach((h, i) => {
    const b = document.createElement('div');
    b.className = 'splash-bar';
    b.style.cssText = `height:${h}%;--delay:${i * 28}ms;--dur:${durs[i] || 0.55}s`;
    barsEl.appendChild(b);
  });
  setTimeout(() => {
    splash.classList.add('splash-out');
    setTimeout(() => splash.remove(), 800);
  }, 2500);
})();

// ── State ──────────────────────────────────────────────────
let accessToken = null;
let currentDuration = 0;
let pollInterval = null;
let progressInterval = null;
let shuffleActive = false;
let repeatMode = 0; // 0=off 1=context 2=track
let volumeLevel = 70;
let currentTrackUri = null;
let likedTrackIds = new Set();
let activeDeviceId = null;
let isPlaying = false;
let lastPollPos = 0;
let lastPollTime = 0;
let currentArtUrl = null;
let npoOpen = false;
let bgBlurTimer = null;
let playlistViewMode = 'list';
let shelfResizeObserver = null;
let lastShelfBooksPerRow = 0;
let cachedPlaylistTracks = [];
let cachedPlaylistUri = '';
let cachedMyPlaylists = null;
let currentContextUri = null; // tracks the active Spotify context URI
let immersivePlayHistory = []; // played tracks (newest first), max 5
let lastTrackInfo = null;      // snapshot of current track before it changes

function buildImmersiveQueue(qData) {
  const queueItems = [qData.currently_playing, ...(qData.queue || [])]
    .filter(t => t?.type === 'track')
    .map(t => ({
      uri: t.uri, name: t.name,
      artist: t.artists?.[0]?.name || '',
      artUrl: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
      isCurrent: t.uri === currentTrackUri,
    }));
  const historyItems = immersivePlayHistory.map(t => ({ ...t, isCurrent: false }));
  return [...historyItems, ...queueItems];
}
let cachedMyPlaylistsAt = 0;
let lyricsLines = [];       // [{time, text}]
let currentLyricIdx = -1;
let lyricsTrackId = '';
let lyricsVisible = false;
let vinylLyricsVisible = false;
let addPlaylistPendingUri = null;
let sleepTimerId = null;
let sleepTimerEnd = 0;
let sleepNoteInterval = null;
let statsRange = 'short_term';
let vinylPrevArt = '';
let vinylNextArt = '';

// ── Visualizer State ─────────────────────────────────────────
const viz = { analyser: null, data: null, canvas: null, ctx: null, frame: null, ready: false, stream: null, audioCtx: null };
let vizMode = 1;
let vizTime = 0;
const particles = [];
let prevBass = 0;
const rings = [];
let skipDir = 0;
let cachedAccentRgb = [168, 85, 247];
let lastVizFrameTime = 0;

// ── Performance Mode ─────────────────────────────────────────
let perfMode   = localStorage.getItem('perfMode')   || 'high'; // 'high' | 'low'
let currentLang = localStorage.getItem('lang')      || 'zh';  // 'zh' | 'en'
let vizEnabled  = localStorage.getItem('vizEnabled') !== 'false'; // default true
let closeToTray  = true; // synced from main process on init


// ── Spotify API ────────────────────────────────────────────
let rateLimitedUntil = 0;
let tokenRefreshPromise = null;

async function refreshAccessToken() {
  if (tokenRefreshPromise) return tokenRefreshPromise;
  tokenRefreshPromise = window.electronAPI.refreshToken().finally(() => { tokenRefreshPromise = null; });
  return tokenRefreshPromise;
}

async function api(endpoint, options = {}) {
  // Global rate-limit guard: if we're still in cooldown, skip immediately
  if (Date.now() < rateLimitedUntil) return null;

  const doFetch = (token) =>
    fetch(`https://api.spotify.com/v1${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

  let res = await doFetch(accessToken);

  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (!newToken) { showScreen('login'); return null; }
    accessToken = newToken;
    res = await doFetch(newToken);
  }

  if (res.status === 429) {
    const raw = parseInt(res.headers.get('Retry-After') || '30');
    const wait = Math.min(raw, 90); // cap at 90s regardless of what Spotify says
    rateLimitedUntil = Date.now() + wait * 1000;
    console.warn(`Rate limited. Pausing for ${wait}s (server said ${raw}s)`);
    return null;
  }

  if (res.status === 204 || res.status === 202) return null;
  if (res.status === 403) return { __forbidden: true };
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn('API error', res.status, endpoint, errText);
    return null;
  }
  try { return await res.json(); } catch { return null; }
}

// ── Screens ────────────────────────────────────────────────
function showScreen(name) {
  ['login-screen', 'loading-screen', 'app'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  document.getElementById('player-bar')?.classList.add('hidden');

  if (name === 'app') {
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('player-bar').classList.remove('hidden');
  } else {
    document.getElementById(`${name}-screen`).classList.remove('hidden');
  }
}

// ── Init ────────────────────────────────────────────────────
async function init() {
  showScreen('loading');

  let token = await window.electronAPI.getSavedToken();
  if (!token) token = await window.electronAPI.refreshToken();
  if (!token) { showScreen('login'); return; }

  accessToken = token;
  await launchApp();
}

let likedCollectionUri = null;

async function launchApp() {
  showScreen('app');
  setGreeting();
  // Fetch user ID for liked songs collection URI
  api('/me').then(me => {
    if (me?.id) likedCollectionUri = `spotify:user:${me.id}:collection`;
  }).catch(() => {});
  loadSidebar();
  loadHome();
  loadLikedIds();
  startPolling();
  generateAppIcon();

  window.electronAPI.launchSpotify().then(result => {
    if (result?.status === 'launched') showToast(i18n[currentLang].spotify_launched);
  }).catch(() => {});
}

function setGreeting() {
  const h = new Date().getHours();
  const t = i18n[currentLang] || i18n.zh;
  const g = h < 5 ? t.greeting_night : h < 12 ? t.greeting_morning : h < 18 ? t.greeting_afternoon : t.greeting_evening;
  document.getElementById('greeting').textContent = g + (currentLang === 'zh' ? '！' : '!');
}

// ── Device Management ───────────────────────────────────────
async function ensureDevice() {
  if (activeDeviceId) return activeDeviceId;

  const data = await api('/me/player/devices');
  if (data?.devices?.length) {
    const device = data.devices.find(d => d.is_active) || data.devices[0];
    activeDeviceId = device.id;
    return device.id;
  }

  return await waitForSpotifyDevice();
}

async function waitForSpotifyDevice() {
  const result = await window.electronAPI.launchSpotify();
  if (result?.status === 'not_found') {
    showToast(i18n[currentLang].spotify_not_found);
    return null;
  }

  showToast(i18n[currentLang].spotify_starting);
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const data = await api('/me/player/devices');
    if (data?.devices?.length) {
      const device = data.devices.find(d => d.is_active) || data.devices[0];
      activeDeviceId = device.id;
      showToast(i18n[currentLang].spotify_ready);
      return device.id;
    }
  }

  showToast(i18n[currentLang].spotify_timeout);
  return null;
}

// ── Playback Controls ───────────────────────────────────────
async function playTrack(uri, contextUri = null) {
  const deviceId = await ensureDevice();
  if (!deviceId) return;
  const body = contextUri
    ? { context_uri: contextUri, offset: { uri } }
    : { uris: [uri] };
  await api(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  setTimeout(pollPlayback, 600);
}

async function playContext(contextUri) {
  const deviceId = await ensureDevice();
  if (!deviceId) return;
  await api(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ context_uri: contextUri }),
  });
  setTimeout(pollPlayback, 600);
}

async function togglePlayPause() {
  if (isPlaying) {
    await api('/me/player/pause', { method: 'PUT' });
  } else {
    const deviceId = await ensureDevice();
    if (!deviceId) return;
    await api(`/me/player/play?device_id=${deviceId}`, { method: 'PUT' });
  }
  setTimeout(pollPlayback, 400);
}

function exitTrackAnim(dir) {
  const dx = dir > 0 ? '-24px' : '24px';
  const tr = 'opacity 0.17s ease, transform 0.18s ease';
  ['now-track-name', 'now-artist-name'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('track-in-r', 'track-in-l');
    el.style.transition = tr;
    el.style.opacity = '0';
    el.style.transform = `translateX(${dx})`;
  });
  const nowArt = document.getElementById('now-album-art');
  if (nowArt) {
    nowArt.classList.remove('art-in');
    nowArt.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    nowArt.style.opacity = '0';
    nowArt.style.transform = 'scale(0.86)';
  }
  if (npoOpen) {
    ['npo-track-name', 'npo-artist-name'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('track-in-r', 'track-in-l');
      el.style.transition = tr;
      el.style.opacity = '0';
      el.style.transform = `translateX(${dx})`;
    });
    const npoArt = document.getElementById('npo-art');
    if (npoArt) {
      npoArt.classList.remove('art-in');
      npoArt.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
      npoArt.style.opacity = '0';
      npoArt.style.transform = 'scale(0.88)';
    }
  }
}

function enterTrackAnim(dir) {
  const cls = dir >= 0 ? 'track-in-r' : 'track-in-l';
  const textIds = ['now-track-name', 'now-artist-name', 'npo-track-name', 'npo-artist-name'];
  const artIds  = ['now-album-art', 'npo-art'];
  textIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = ''; el.style.opacity = ''; el.style.transform = '';
    el.classList.remove('track-in-r', 'track-in-l');
    void el.offsetWidth;
    el.classList.add(cls);
  });
  artIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = ''; el.style.opacity = ''; el.style.transform = '';
    el.classList.remove('art-in');
    void el.offsetWidth;
    el.classList.add('art-in');
  });
}

async function skipNext() {
  skipDir = 1;
  exitTrackAnim(1);
  await api('/me/player/next', { method: 'POST' });
  setTimeout(pollPlayback, 400);
}

async function skipPrev() {
  skipDir = -1;
  exitTrackAnim(-1);
  await api('/me/player/previous', { method: 'POST' });
  setTimeout(pollPlayback, 400);
}

// ── Polling ─────────────────────────────────────────────────
function startPolling() {
  clearInterval(pollInterval);
  pollPlayback();
  pollInterval = setInterval(pollPlayback, 3000);
}

async function pollPlayback() {
  const dir = skipDir;
  const state = await api('/me/player');
  if (!state || !state.item) return;

  const track = state.item;
  const prevUri = currentTrackUri;
  if (prevUri && prevUri !== track.uri && lastTrackInfo) {
    immersivePlayHistory.unshift({ ...lastTrackInfo });
    if (immersivePlayHistory.length > 5) immersivePlayHistory.pop();
  }
  currentTrackUri = track.uri;
  currentDuration = track.duration_ms;
  isPlaying = state.is_playing;
  if (state.device?.id) activeDeviceId = state.device.id;
  if (state.context?.uri) currentContextUri = state.context.uri;
  shuffleActive = state.shuffle_state;
  repeatMode = state.repeat_state === 'off' ? 0 : state.repeat_state === 'context' ? 1 : 2;

  document.body.classList.toggle('is-playing', isPlaying);
  const vinylOverlayOpen = document.getElementById('vinyl-overlay')?.classList.contains('open');
  if (npoOpen || vinylOverlayOpen) { isPlaying ? startViz() : stopViz(); }

  // Album art + color + bg
  const img = track.album?.images?.[0]?.url;
  if (img && currentArtUrl !== img) {
    currentArtUrl = img;

    const artEl = document.getElementById('now-album-art');
    artEl.src = img;
    artEl.onload = () => {
      try {
        const [r, g, b] = extractColor(artEl);
        applyDynamicColor(r, g, b);
      } catch (e) {}
    };

    updateBgBlur(img);

    document.getElementById('npo-art').src = img;
    document.getElementById('npo-bg-img').src = img;

    const heroBg = document.getElementById('hero-bg');
    const heroArt = document.getElementById('hero-art');
    if (heroBg) heroBg.style.backgroundImage = `url('${img}')`;
    if (heroArt) heroArt.src = img;
  }

  const heroTitle = document.getElementById('hero-title');
  const heroArtist = document.getElementById('hero-artist');
  if (heroTitle) heroTitle.textContent = track.name || '—';
  if (heroArtist) heroArtist.textContent = track.artists?.map(a => a.name).join(', ') || '—';

  document.getElementById('now-track-name').textContent = track.name;
  document.getElementById('now-artist-name').textContent =
    track.artists?.map(a => a.name).join(', ') || '';

  document.getElementById('npo-track-name').textContent = track.name;
  document.getElementById('npo-artist-name').textContent =
    track.artists?.map(a => a.name).join(', ') || '';

  const trackArtist = track.artists?.map(a => a.name).join(', ') || '';
  const trackArtUrl = track.album?.images?.[0]?.url || '';
  lastTrackInfo = {
    uri: track.uri, name: track.name,
    artist: track.artists?.[0]?.name || '',
    artUrl: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || '',
  };
  window.electronAPI.updateMiniPlayer({ title: track.name, artist: trackArtist, artUrl: trackArtUrl, isPlaying });
  window.electronAPI.updateImmersive({ title: track.name, artist: trackArtist, artUrl: trackArtUrl, isPlaying, duration_ms: currentDuration });
  window.electronAPI.updateTray({ title: track.name, artist: trackArtist, isPlaying });
  window.electronAPI.updateDiscord({ title: track.name, artist: trackArtist, artUrl: trackArtUrl, isPlaying, positionMs: state.progress_ms || 0, durationMs: track.duration_ms || 0 });

  if (dir !== 0 || (prevUri !== null && prevUri !== currentTrackUri)) {
    skipDir = 0;
    enterTrackAnim(dir || 1);
  }

  document.getElementById('play-icon').classList.toggle('hidden', isPlaying);
  document.getElementById('pause-icon').classList.toggle('hidden', !isPlaying);
  document.getElementById('npo-play-icon').classList.toggle('hidden', isPlaying);
  document.getElementById('npo-pause-icon').classList.toggle('hidden', !isPlaying);

  document.getElementById('shuffle-btn').classList.toggle('active', shuffleActive);
  document.getElementById('npo-shuffle-btn').classList.toggle('active', shuffleActive);
  document.getElementById('repeat-btn').classList.toggle('active', repeatMode > 0);
  document.getElementById('npo-repeat-btn').classList.toggle('active', repeatMode > 0);
  document.getElementById('repeat-icon').classList.toggle('hidden', repeatMode === 2);
  document.getElementById('repeat-one-icon').classList.toggle('hidden', repeatMode !== 2);

  const vol = state.device?.volume_percent ?? volumeLevel;
  if (vol !== volumeLevel) {
    volumeLevel = vol;
    document.getElementById('volume-slider').value = vol;
    document.getElementById('volume-fill').style.width = vol + '%';
    document.getElementById('npo-volume-slider').value = vol;
    document.getElementById('vinyl-volume-slider').value = vol;
  }

  lastPollPos = state.progress_ms || 0;
  lastPollTime = Date.now();
  updateProgress(lastPollPos, currentDuration);

  clearInterval(progressInterval);
  if (isPlaying) {
    progressInterval = setInterval(() => {
      const pos = lastPollPos + (Date.now() - lastPollTime);
      updateProgress(pos, currentDuration);
      if (lyricsLines.length) syncLyrics(pos);
      window.electronAPI.updateImmersiveProgress({ ms: pos, idx: currentLyricIdx });
    }, 150);
  }

  const liked = likedTrackIds.has(track.id);
  document.getElementById('like-btn').classList.toggle('liked', liked);
  document.getElementById('npo-like-btn').classList.toggle('liked', liked);

  // Refresh playing state in list rows, bookshelf books, and vinyl items
  document.querySelectorAll('.track-row, .book, .vinyl-item').forEach(el => {
    el.classList.toggle('playing', el.dataset.uri === currentTrackUri);
  });

  // Auto-scroll and per-mode playing state update when track changes
  if (prevUri !== currentTrackUri) {
    const playingEl = document.querySelector('.track-row.playing, .book.playing');
    if (playingEl) playingEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Update vinyl wall cards
    document.querySelectorAll('.vinyl-card').forEach(c => {
      c.classList.toggle('playing', c.dataset.uri === currentTrackUri);
    });
    // Track prev art for vinyl overlay navigation
    if (prevUri) {
      vinylPrevArt = document.getElementById('now-album-art')?.src || '';
      const prevEl = document.getElementById('vinyl-prev-art');
      if (prevEl) prevEl.src = vinylPrevArt;
    }
    fetchLyrics(track);
  }
  // Sync tonearm with play state when vinyl overlay is open
  try {
    const overlay = document.getElementById('vinyl-overlay');
    if (overlay?.classList.contains('open')) {
      document.getElementById('vinyl-tonearm')?.classList.toggle('playing', isPlaying);
      document.getElementById('vinyl-big-disc')?.classList.toggle('spinning', isPlaying);
    }
  } catch {}

  // lyrics sync is handled by progressInterval (every 300ms)

  // Auto-refresh queue panel when track changes
  if (queueOpen && prevUri !== currentTrackUri) refreshQueueContent();

  // Refresh immersive carousel when track changes
  if (prevUri !== currentTrackUri) {
    setTimeout(async () => {
      const qData = await fetchFullQueue();
      if (qData) window.electronAPI.updateImmersiveQueue({ queue: buildImmersiveQueue(qData) });
    }, 800);
  }

  // Update vinyl overlay if open
  // Update vinyl overlay info when track changes while overlay is open
  if (prevUri !== currentTrackUri) {
    try {
      const overlay = document.getElementById('vinyl-overlay');
      if (overlay?.classList.contains('open')) {
        const img = track.album?.images?.[0]?.url || '';
        const labelEl = document.getElementById('vinyl-big-label');
        const bgEl = document.getElementById('vinyl-overlay-bg');
        const titleEl = document.getElementById('vinyl-overlay-title');
        const artistEl = document.getElementById('vinyl-overlay-artist');
        if (labelEl) labelEl.src = img;
        if (bgEl) bgEl.src = img;
        if (titleEl) titleEl.textContent = track.name;
        if (artistEl) artistEl.textContent = track.artists?.map(a => a.name).join(', ') || '';
        const disc = document.getElementById('vinyl-big-disc');
        if (disc) {
          disc.classList.remove('spinning', 'entering');
          requestAnimationFrame(() => {
            disc.classList.add('entering');
            setTimeout(() => { disc.classList.remove('entering'); if (isPlaying) disc.classList.add('spinning'); }, 600);
          });
        }
        // Fetch next art
        const qData = await api('/me/player/queue');
        const nxt = qData?.queue?.[0];
        if (nxt) {
          vinylNextArt = nxt.album?.images?.[0]?.url || '';
          const nextEl = document.getElementById('vinyl-next-art');
          if (nextEl) nextEl.src = vinylNextArt;
        }
      }
    } catch {}
  }
}

function updateProgress(pos, dur) {
  const pct = dur > 0 ? Math.min((pos / dur) * 100, 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-thumb').style.left = pct + '%';
  document.getElementById('current-time').textContent = msToTime(pos);
  document.getElementById('total-time').textContent = msToTime(dur);
  document.getElementById('npo-fill').style.width = pct + '%';
  document.getElementById('npo-cur').textContent = msToTime(pos);
  document.getElementById('npo-tot').textContent = msToTime(dur);
}

function msToTime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Dynamic Color ────────────────────────────────────────────
function extractColor(imgEl) {
  const canvas = document.getElementById('color-canvas');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum < 20 || lum > 230) continue;
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  if (!n) return [120, 60, 200];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function applyDynamicColor(r, g, b) {
  // Boost vibrancy so muted album colors still look vivid
  const max = Math.max(r, g, b);
  if (max > 0 && max < 200) {
    const boost = Math.min(200 / max, 1.5);
    r = Math.min(255, Math.round(r * boost));
    g = Math.min(255, Math.round(g * boost));
    b = Math.min(255, Math.round(b * boost));
  }

  // Lighter variant for hover state
  const rH = Math.round(r + (255 - r) * 0.28);
  const gH = Math.round(g + (255 - g) * 0.28);
  const bH = Math.round(b + (255 - b) * 0.28);

  // Update all accent CSS variables
  cachedAccentRgb = [r, g, b];
  const root = document.documentElement;
  root.style.setProperty('--accent',      `rgb(${r},${g},${b})`);
  root.style.setProperty('--accent-hover',`rgb(${rH},${gH},${bH})`);
  root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.4)`);
  root.style.setProperty('--accent-dim',  `rgba(${r},${g},${b},0.15)`);

  // Update orbs + glow color
  document.querySelectorAll('.npo-orb').forEach(o => { o.style.background = `rgb(${r},${g},${b})`; });
  document.getElementById('npo-art-glow')?.style.setProperty('background', `rgb(${r},${g},${b})`);

  // Player bar tint
  const playerBar = document.querySelector('.player-bar');
  if (playerBar) {
    playerBar.style.background =
      `linear-gradient(to right, rgba(${r},${g},${b},0.25) 0%, rgba(8,8,8,0.92) 55%)`;
    playerBar.style.backdropFilter = 'blur(28px)';
  }

  // Main content gradient
  const mainContent = document.querySelector('.main-content');
  if (mainContent) {
    mainContent.style.background =
      `linear-gradient(180deg, rgba(${r},${g},${b},0.5) 0%, rgba(${Math.round(r*0.35)},${Math.round(g*0.35)},${Math.round(b*0.35)},0.2) 220px, #0a0a0a 480px)`;
  }
}

// ── Background Blur ──────────────────────────────────────────
function updateBgBlur(imgUrl) {
  const layer = document.getElementById('bg-blur-layer');
  const img = document.getElementById('bg-blur-img');
  layer.classList.remove('visible');
  clearTimeout(bgBlurTimer);
  bgBlurTimer = setTimeout(() => {
    img.src = imgUrl;
    img.onload = () => layer.classList.add('visible');
  }, 500);
}

// ── Visualizer ───────────────────────────────────────────────
async function initVisualizer() {
  if (viz.ready) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 1, height: 1, frameRate: 1 }
    });
    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    viz.stream = stream;
    viz.audioCtx = audioCtx;
    viz.analyser = analyser;
    viz.data = new Uint8Array(analyser.frequencyBinCount);
    viz.timeData = new Uint8Array(analyser.fftSize);
    viz.canvas = document.getElementById('npo-visualizer');
    viz.ctx = viz.canvas.getContext('2d');
    viz.ready = true;
  } catch (e) {
    console.warn('Visualizer init failed:', e);
  }
}

function setVizMode(n) {
  vizMode = n;
  particles.length = 0;
  rings.length = 0;
  if (vinylLyricsVisible) {
    vinylLyricsVisible = false;
    document.getElementById('vinyl-lyrics-btn')?.classList.remove('active');
    document.getElementById('vinyl-overlay')?.classList.remove('vinyl-lyrics-open');
  }
  if (n === 2) {
    const maxR = Math.min(viz.canvas?.offsetWidth || 800, viz.canvas?.offsetHeight || 600) * 0.42;
    for (let i = 0; i < 500; i++) {
      const r0 = 18 + Math.random() * maxR;
      particles.push({ angle: Math.random() * Math.PI * 2, radius: r0, baseRadius: r0,
        speed: (0.004 + Math.random() * 0.009) / Math.sqrt(Math.max(r0, 1) / 30),
        alpha: 0.15 + Math.random() * 0.85, size: 0.5 + Math.random() * 2 });
    }
  }

  const glowEl = document.getElementById('npo-art-glow');
  if (glowEl) {
    glowEl.style.background = 'var(--accent)';
    glowEl.style.filter = 'blur(28px)';
    glowEl.style.transition = 'opacity 0.08s linear';
  }
  document.querySelectorAll('.viz-mode-btn[data-mode]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.mode) === n);
  });
}

function startViz() {
  if (!viz.analyser) return;
  const vinylOpen = document.getElementById('vinyl-overlay')?.classList.contains('open');
  const targetId = vinylOpen ? 'vinyl-visualizer' : 'npo-visualizer';
  const targetCanvas = document.getElementById(targetId);
  if (targetCanvas && viz.canvas !== targetCanvas) {
    viz.canvas = targetCanvas;
    viz.ctx = targetCanvas.getContext('2d');
  }
  cancelAnimationFrame(viz.frame);
  drawViz();
}

function stopViz() {
  cancelAnimationFrame(viz.frame);
  viz.frame = null;
  const glowEl = document.getElementById('npo-art-glow');
  if (glowEl) glowEl.style.opacity = '0';
  // Release screen capture so GPU memory is freed
  viz.stream?.getTracks().forEach(t => t.stop());
  viz.audioCtx?.close();
  viz.stream = null;
  viz.audioCtx = null;
  viz.analyser = null;
  viz.ready = false;
}

function getArtBounds() {
  const wrap = document.getElementById('npo-art-wrap');
  if (!wrap) return null;
  const r = wrap.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.width / 2 };
}

function detectBeat(data) {
  const bass = data.slice(0, 10).reduce((s, v) => s + v, 0) / 10 / 255;
  const isBeat = bass > 0.55 && bass > prevBass * 1.35;
  prevBass = bass * 0.7 + prevBass * 0.3;
  return isBeat;
}


function drawViz() {
  viz.frame = requestAnimationFrame(drawViz);
  const now = performance.now();
  const fpsTarget = perfMode === 'low' ? 30 : 60;
  if (now - lastVizFrameTime < 1000 / fpsTarget - 1) return;
  lastVizFrameTime = now;

  const { analyser, data, canvas, ctx } = viz;
  if (!analyser || !canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth;
  const cssH = canvas.offsetHeight;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.resetTransform();
    ctx.scale(dpr, dpr);
  }

  analyser.getByteFrequencyData(data);
  vizTime += 0.016;

  const [r, g, b] = cachedAccentRgb;

  ctx.clearRect(0, 0, cssW, cssH);

  switch (vizMode) {
    case 1: drawModeBar(ctx, cssW, cssH, data, r, g, b); break;
    case 2: drawModeVortex(ctx, cssW, cssH, data, r, g, b); break;
  }

  if (vizMode === 1) {
    const avg = data.reduce((s, v) => s + v, 0) / data.length / 255;
    const glowEl = document.getElementById('npo-art-glow');
    if (glowEl) glowEl.style.opacity = Math.min(avg * 2.2, 0.85).toFixed(3);
  }
}

// ── Mode 1: Bar Visualizer ───────────────────────────────────
function drawModeBar(ctx, W, H, data, r, g, b) {
  const count = 64;
  const bw = W / count;
  const gap = 1.5;
  const maxH = H * 0.32;

  for (let i = 0; i < count; i++) {
    const bin = Math.floor((i / count) * data.length * 0.65);
    const v = data[bin] / 255;
    const bh = Math.max(2, v * maxH * 0.92);
    const x = i * bw + gap / 2;
    const y = H - bh;
    const bW = bw - gap;
    const rx = Math.min(bW / 2, 3);

    const grad = ctx.createLinearGradient(0, y, 0, H);
    grad.addColorStop(0, `rgba(${r},${g},${b},${0.85 + v * 0.15})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0.04)`);
    ctx.fillStyle = grad;
    ctx.shadowColor = perfMode === 'low' ? 'transparent' : `rgba(${r},${g},${b},0.55)`;
    ctx.shadowBlur = perfMode === 'low' ? 0 : v * 14;

    ctx.beginPath();
    ctx.moveTo(x + rx, y);
    ctx.lineTo(x + bW - rx, y);
    ctx.arcTo(x + bW, y, x + bW, y + rx, rx);
    ctx.lineTo(x + bW, H);
    ctx.lineTo(x, H);
    ctx.lineTo(x, y + rx);
    ctx.arcTo(x, y, x + rx, y, rx);
    ctx.closePath();
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

// ── Mode 2: 引力漩涡 ─────────────────────────────────────────
function drawModeVortex(ctx, W, H, data, r, g, b) {
  const bass = data.slice(0, 10).reduce((s, v) => s + v, 0) / 10 / 255;
  const avg = data.reduce((s, v) => s + v, 0) / data.length / 255;
  const isBeat = detectBeat(data);
  const cx = W / 2, cy = H / 2;

  if (particles.length === 0) {
    const maxR = Math.min(W, H) * 0.42;
    for (let i = 0; i < 500; i++) {
      const r0 = 18 + Math.random() * maxR;
      particles.push({ angle: Math.random() * Math.PI * 2, radius: r0, baseRadius: r0,
        speed: (0.004 + Math.random() * 0.009) / Math.sqrt(Math.max(r0, 1) / 30),
        alpha: 0.15 + Math.random() * 0.85, size: 0.5 + Math.random() * 2 });
    }
  }

  if (isBeat) {
    for (const p of particles) {
      if (Math.random() < 0.18) p.radius += 30 + Math.random() * 55;
    }
  }

  for (const p of particles) {
    p.angle += p.speed * (1 + bass * 0.9);
    p.radius += (p.baseRadius - p.radius) * 0.025 + Math.sin(vizTime * 2.2 + p.angle) * bass * 2.5;
    p.radius = Math.max(12, Math.min(W * 0.52, p.radius));

    const depth = (Math.sin(p.angle) + 1) * 0.5;
    const x = cx + Math.cos(p.angle) * p.radius;
    const y = cy + Math.sin(p.angle) * p.radius * 0.6;

    ctx.beginPath();
    ctx.arc(x, y, p.size * (0.5 + depth * 0.55) * (1 + bass * 0.3), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(p.alpha * (0.4 + depth * 0.6) * (1 + avg * 0.5), 0.95)})`;
    ctx.fill();
  }

  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, 45 + avg * 30);
  grd.addColorStop(0, `rgba(${r},${g},${b},${(0.35 + avg * 0.45).toFixed(3)})`);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  const glowEl = document.getElementById('npo-art-glow');
  if (glowEl) glowEl.style.opacity = Math.min(avg * 2.2, 0.82).toFixed(3);
}


// ── Now Playing Overlay ──────────────────────────────────────
async function openNPO() {
  window.electronAPI.hideMiniPlayer();
  window.electronAPI.hideImmersive();
  document.getElementById('npo').classList.add('npo-open');
  npoOpen = true;
  document.getElementById('npo-volume-slider').value = volumeLevel;
  spawnOrbs();
  if (vizEnabled) await initVisualizer();
  if (isPlaying) startViz();
}

function closeNPO() {
  document.getElementById('npo').classList.remove('npo-open', 'controls-idle', 'queue-open');
  npoOpen = false;
  stopViz();
  document.getElementById('npo-orbs')?.classList.remove('ready');
}

function spawnOrbs(containerId = 'npo-orbs') {
  const orbsEl = document.getElementById(containerId);
  if (!orbsEl) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const m = accent.match(/\d+/g) || [168, 85, 247];
  const [r, g, b] = m;
  orbsEl.innerHTML = '';
  const allOrbs = [
    { size: 380, left: '5%',  top: '10%', dx: '70px',  dy: '50px',  dur: '9s'  },
    { size: 300, left: '55%', top: '55%', dx: '-60px', dy: '-40px', dur: '12s' },
    { size: 240, left: '35%', top: '-5%', dx: '40px',  dy: '70px',  dur: '7s'  },
  ];
  const configs = perfMode === 'low' ? allOrbs.slice(0, 1) : allOrbs;
  configs.forEach(c => {
    const orb = document.createElement('div');
    orb.className = 'npo-orb';
    orb.style.cssText = `width:${c.size}px;height:${c.size}px;left:${c.left};top:${c.top};background:rgb(${r},${g},${b});--dx:${c.dx};--dy:${c.dy};--dur:${c.dur}`;
    orbsEl.appendChild(orb);
  });
  requestAnimationFrame(() => requestAnimationFrame(() => orbsEl.classList.add('ready')));
}

// ── Shared playlist fetch (5-min cache, sidebar + library share one call) ──
async function fetchMyPlaylists(forceRefresh = false) {
  const age = Date.now() - cachedMyPlaylistsAt;
  if (!forceRefresh && cachedMyPlaylists && age < 5 * 60 * 1000) return cachedMyPlaylists;
  let items = [];
  let next = '/me/playlists?limit=50';
  while (next) {
    const page = await api(next.replace('https://api.spotify.com/v1', ''));
    if (!page) break;
    items = items.concat(page.items || []);
    next = page.next;
  }
  const result = { items };
  cachedMyPlaylists = result;
  cachedMyPlaylistsAt = Date.now();
  return result;
}

// ── Sidebar ─────────────────────────────────────────────────
async function loadSidebar() {
  const data = await fetchMyPlaylists();
  if (!data) return;
  const list = document.getElementById('playlist-list');
  const likedItem = `<div class="playlist-item playlist-item-liked" id="sidebar-liked-btn">
    <svg viewBox="0 0 24 24" width="13" height="13" style="flex-shrink:0;margin-right:5px"><path fill="currentColor" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3z"/></svg>
    ${i18n[currentLang].home_liked}
  </div>`;
  list.innerHTML = likedItem + data.items
    .map(p => `<div class="playlist-item" data-id="${p.id}" title="${esc(p.name)}">${esc(p.name)}</div>`)
    .join('');
  document.getElementById('sidebar-liked-btn').addEventListener('click', () => {
    document.querySelectorAll('.playlist-item').forEach(x => x.classList.remove('active'));
    document.getElementById('sidebar-liked-btn').classList.add('active');
    openLikedSongs();
  });
  list.querySelectorAll('.playlist-item[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.playlist-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      openPlaylist(el.dataset.id);
    });
  });
}

// ── Home ────────────────────────────────────────────────────
async function loadHome() {
  loadRecent();
  loadLiked();
}

async function loadRecent() {
  const data = await api('/me/player/recently-played?limit=12');
  if (!data) return;
  const seen = new Set();
  const items = data.items.filter(({ track }) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  }).slice(0, 8);
  const container = document.getElementById('recent-content');
  container.innerHTML = items.map(({ track }) => cardHTML(track)).join('');
  bindCardClicks(container);
}

async function loadLiked() {
  const container = document.getElementById('liked-content');
  // Show count from first page
  const data = await api('/me/tracks?limit=1');
  const total = data?.total ?? '—';
  container.innerHTML = `
    <div class="liked-home-card" id="liked-home-card">
      <div class="liked-home-art">
        <svg viewBox="0 0 24 24" width="48" height="48"><path fill="#fff" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3z"/></svg>
      </div>
      <div class="liked-home-info">
        <div class="liked-home-title">${i18n[currentLang].home_liked}</div>
        <div class="liked-home-count">${total} ${i18n[currentLang].playlist_tracks_suffix}</div>
      </div>
      <svg viewBox="0 0 24 24" width="20" height="20" class="liked-home-arrow"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
    </div>`;
  document.getElementById('liked-home-card')?.addEventListener('click', openLikedSongs);
}

async function loadLikedIds() {
  let next = '/me/tracks?limit=50&fields=items(track(id)),next';
  while (next) {
    const page = await api(next.replace('https://api.spotify.com/v1', ''));
    if (!page) break;
    page.items?.forEach(i => { if (i.track?.id) likedTrackIds.add(i.track.id); });
    next = page.next;
  }
}

// ── Search ──────────────────────────────────────────────────
let searchTimer;
function setupSearch() {
  const input = document.getElementById('search-input');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
    searchTimer = setTimeout(() => doSearch(q), 380);
  });
}

async function doSearch(q) {
  const data = await api(`/search?q=${encodeURIComponent(q)}&type=track,artist,album,playlist&limit=10`);
  if (!data) return;
  const container = document.getElementById('search-results');
  let html = '';

  const t = i18n[currentLang];

  if (data.playlists?.items?.length) {
    html += `<h3 class="results-section-title">${t.search_playlists}</h3><div class="card-grid">`;
    html += data.playlists.items.filter(Boolean).slice(0, 6).map(p => `
      <div class="card" data-playlist-id="${p.id}">
        <img src="${p.images?.[0]?.url || ''}" alt="" class="card-img">
        <div class="card-name">${esc(p.name)}</div>
        <div class="card-sub">${esc(p.owner?.display_name || '')}</div>
        <button class="card-play-btn" data-playlist-id="${p.id}">▶</button>
      </div>`).join('');
    html += `</div>`;
  }

  if (data.tracks?.items?.length) {
    html += `<h3 class="results-section-title">${t.search_tracks}</h3>`;
    html += trackListHTML(data.tracks.items);
  }

  if (data.artists?.items?.length) {
    html += `<h3 class="results-section-title">${t.search_artists}</h3><div class="card-grid">`;
    html += data.artists.items.slice(0, 5).map(a => `
      <div class="card" data-artist-id="${a.id}">
        <img src="${a.images?.[0]?.url || ''}" alt="" class="card-img artist-img">
        <div class="card-name">${esc(a.name)}</div>
        <div class="card-sub">${t.search_artist_label}</div>
      </div>`).join('');
    html += `</div>`;
  }

  if (!html) html = `<div class="loading-text" style="color:var(--text-muted);font-size:14px">${t.search_no_results}</div>`;
  container.innerHTML = html;
  bindTrackRows(container);

  // 点歌单卡片打开
  container.querySelectorAll('.card[data-playlist-id]').forEach(card => {
    card.addEventListener('click', () => openPlaylist(card.dataset.playlistId));
  });
  container.querySelectorAll('.card-play-btn[data-playlist-id]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openPlaylist(btn.dataset.playlistId); });
  });
  // 点艺人卡片打开艺人页
  container.querySelectorAll('.card[data-artist-id]').forEach(card => {
    card.addEventListener('click', () => openArtist(card.dataset.artistId));
  });
}

// ── Library ─────────────────────────────────────────────────
async function loadLibrary(forceRefresh = false) {
  const container = document.getElementById('library-content');
  container.innerHTML = `<div class="loading-text">${i18n[currentLang].loading}</div>`;
  const data = await fetchMyPlaylists(forceRefresh);
  if (!data) {
    const btn = document.createElement('button');
    btn.style.cssText = 'padding:7px 20px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;border-radius:20px;cursor:pointer;font-size:12px';
    btn.textContent = i18n[currentLang].btn_retry;
    btn.addEventListener('click', () => loadLibrary(true));
    const msg = document.createElement('div');
    msg.className = 'loading-text';
    msg.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px';
    msg.innerHTML = `<span style="color:var(--text-muted);font-size:13px">${i18n[currentLang].api_quota}</span><span style="color:var(--text-muted);font-size:12px;opacity:0.6">${i18n[currentLang].api_quota_note}</span>`;
    msg.appendChild(btn);
    container.innerHTML = '';
    container.appendChild(msg);
    return;
  }
  const likedCard = `<div class="card card-liked" id="library-liked-card">
    <div class="card-img liked-card-art">
      <svg viewBox="0 0 24 24" width="42" height="42"><path fill="#fff" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3z"/></svg>
    </div>
    <div class="card-name">${i18n[currentLang].home_liked}</div>
    <div class="card-sub">${i18n[currentLang].playlist_type}</div>
  </div>`;
  container.innerHTML = `<div class="card-grid">${likedCard}${data.items.map(p => `
    <div class="card" data-id="${p.id}">
      <img src="${p.images?.[0]?.url || ''}" alt="" class="card-img">
      <div class="card-name">${esc(p.name)}</div>
      <div class="card-sub">播放列表</div>
    </div>`).join('')}</div>`;
  document.getElementById('library-liked-card')?.addEventListener('click', openLikedSongs);
  container.querySelectorAll('.card[data-id]').forEach(card => {
    card.addEventListener('click', () => openPlaylist(card.dataset.id));
  });
}

// ── Playlist ────────────────────────────────────────────────
async function openPlaylist(id) {
  switchView('playlist');
  const container = document.getElementById('playlist-detail');
  container.innerHTML = `<div class="playlist-skeleton">
    <div class="skel-hero">
      <div class="skel skel-img"></div>
      <div class="skel-info">
        <div class="skel skel-title"></div>
        <div class="skel skel-sub"></div>
        <div class="skel skel-sub" style="width:28%"></div>
        <div class="skel skel-btn"></div>
      </div>
    </div>
    ${Array(7).fill(0).map(() => `<div class="skel-track">
      <div class="skel skel-tn"></div><div class="skel skel-ta"></div>
      <div class="skel-ti"><div class="skel skel-tt"></div><div class="skel skel-tar"></div></div>
      <div class="skel skel-td"></div></div>`).join('')}
  </div>`;

  const data = await api(`/playlists/${id}`);
  if (!data) { container.innerHTML = `<div class="loading-text">${i18n[currentLang].error_playlist}</div>`; return; }

  // Spotify API may return tracks as "tracks" or "items" field
  const tracksPage = data.tracks || data.items;
  let allRaw = tracksPage?.items || [];
  let nextUrl = tracksPage?.next;

  // Non-owned playlists often have no embedded tracks — fetch from dedicated endpoint
  if (!allRaw.length) {
    const first = await api(`/playlists/${id}/items?limit=100`);
    if (first?.__forbidden) {
      const pt = i18n[currentLang];
      container.innerHTML = `
        <div class="playlist-hero">
          <img src="${data.images?.[0]?.url || ''}" alt="" class="playlist-hero-img">
          <div class="playlist-hero-info">
            <div class="playlist-type">${pt.playlist_type}</div>
            <h1>${esc(data.name)}</h1>
            ${data.description ? `<p class="playlist-desc">${data.description}</p>` : ''}
          </div>
        </div>
        <div style="padding:40px 32px;color:var(--text-muted);font-size:14px;">${pt.playlist_no_api_tracks}</div>`;
      return;
    }
    if (first?.items) { allRaw = first.items; nextUrl = first.next; }
  }

  while (nextUrl) {
    const p = nextUrl.replace('https://api.spotify.com/v1', '');
    const page = await api(p);
    if (!page) break;
    allRaw = allRaw.concat(page.items || []);
    nextUrl = page.next;
  }

  const tracks = allRaw.map(i => i.item || i.track).filter(t => t && t.type === 'track');
  cachedPlaylistTracks = tracks;
  cachedPlaylistUri = data.uri;

  const img = data.images?.[0]?.url || '';
  const total = tracks.length || tracksPage?.total || 0;
  const listHTML = trackListHTML(tracks, data.uri);

  container.innerHTML = `
    <div class="playlist-hero">
      <img src="${img}" alt="" class="playlist-hero-img">
      <div class="playlist-hero-info">
        <div class="playlist-type">${i18n[currentLang].playlist_type}</div>
        <h1>${esc(data.name)}</h1>
        ${data.description ? `<p class="playlist-desc">${data.description}</p>` : ''}
        <p class="playlist-count">${total} ${i18n[currentLang].playlist_tracks_suffix}</p>
        <div class="hero-actions">
          <button class="primary-btn" id="play-all-btn">${i18n[currentLang].play_all}</button>
          <div class="lib-view-toggle">
            <button id="plist-list-btn" class="lib-view-btn${playlistViewMode === 'list' ? ' active' : ''}" title="列表">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>
            </button>
            <button id="plist-shelf-btn" class="lib-view-btn${playlistViewMode === 'shelf' ? ' active' : ''}" title="书架">
              <svg viewBox="0 0 24 24" width="15" height="15"><rect x="3" y="4" width="4" height="14" rx="1" fill="currentColor"/><rect x="8.5" y="2" width="3" height="16" rx="1" fill="currentColor" opacity="0.75"/><rect x="13" y="5" width="4" height="13" rx="1" fill="currentColor" opacity="0.9"/><rect x="18" y="3" width="3" height="15" rx="1" fill="currentColor" opacity="0.65"/><rect x="2" y="18.5" width="20" height="2.5" rx="1" fill="currentColor"/></svg>
            </button>
            <button id="plist-vinyl-btn" class="lib-view-btn${playlistViewMode === 'vinyl' ? ' active' : ''}" title="黑胶">
              <svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="track-list-wrapper" id="playlist-track-area">${playlistViewMode === 'list' ? listHTML : ''}</div>`;

  const trackArea = container.querySelector('#playlist-track-area');

  if (playlistViewMode === 'shelf') {
    renderTrackShelf(tracks, data.uri, trackArea);
  } else if (playlistViewMode === 'vinyl') {
    renderVinylShelf(tracks, data.uri, trackArea);
  } else {
    bindTrackRows(trackArea, data.uri);
  }

  container.querySelector('#play-all-btn').addEventListener('click', () => playContext(data.uri));

  const setViewMode = (mode) => {
    playlistViewMode = mode;
    ['list','shelf','vinyl'].forEach(m => {
      container.querySelector(`#plist-${m}-btn`)?.classList.toggle('active', m === mode);
    });
  };

  container.querySelector('#plist-list-btn').addEventListener('click', () => {
    if (playlistViewMode === 'list') return;
    setViewMode('list');
    if (shelfResizeObserver) { shelfResizeObserver.disconnect(); shelfResizeObserver = null; }
    trackArea.innerHTML = listHTML;
    bindTrackRows(trackArea, data.uri);
  });

  container.querySelector('#plist-shelf-btn').addEventListener('click', () => {
    if (playlistViewMode === 'shelf') return;
    setViewMode('shelf');
    renderTrackShelf(tracks, data.uri, trackArea);
  });

  container.querySelector('#plist-vinyl-btn').addEventListener('click', () => {
    if (playlistViewMode === 'vinyl') return;
    setViewMode('vinyl');
    if (shelfResizeObserver) { shelfResizeObserver.disconnect(); shelfResizeObserver = null; }
    renderVinylShelf(tracks, data.uri, trackArea);
  });
}

// ── Liked Songs (full paginated view) ────────────────────────
async function openLikedSongs() {
  switchView('playlist');
  const container = document.getElementById('playlist-detail');
  container.innerHTML = `<div class="playlist-skeleton">
    <div class="skel-hero">
      <div class="skel skel-img"></div>
      <div class="skel-info">
        <div class="skel skel-title"></div><div class="skel skel-sub"></div>
        <div class="skel skel-sub" style="width:28%"></div><div class="skel skel-btn"></div>
      </div>
    </div>
    ${Array(7).fill(0).map(() => `<div class="skel-track">
      <div class="skel skel-tn"></div><div class="skel skel-ta"></div>
      <div class="skel-ti"><div class="skel skel-tt"></div><div class="skel skel-tar"></div></div>
      <div class="skel skel-td"></div></div>`).join('')}
  </div>`;

  let allRaw = [];
  let next = '/me/tracks?limit=50';
  while (next) {
    const page = await api(next.replace('https://api.spotify.com/v1', ''));
    if (!page) break;
    allRaw = allRaw.concat(page.items || []);
    next = page.next;
  }

  const contextUri = likedCollectionUri || 'spotify:collection:tracks';
  const tracks = allRaw.map(i => i.track).filter(t => t?.type === 'track');
  cachedPlaylistTracks = tracks;
  cachedPlaylistUri = contextUri;

  const listHTML = trackListHTML(tracks, contextUri);

  container.innerHTML = `
    <div class="playlist-hero">
      <div class="liked-hero-art">
        <svg viewBox="0 0 24 24" width="56" height="56"><path fill="#fff" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3z"/></svg>
      </div>
      <div class="playlist-hero-info">
        <div class="playlist-type">${i18n[currentLang].playlist_type}</div>
        <h1>${i18n[currentLang].home_liked}</h1>
        <p class="playlist-count">${tracks.length} ${i18n[currentLang].playlist_tracks_suffix}</p>
        <div class="hero-actions">
          <button class="primary-btn" id="play-all-btn">${i18n[currentLang].play_all}</button>
          <div class="lib-view-toggle">
            <button id="plist-list-btn" class="lib-view-btn${playlistViewMode === 'list' ? ' active' : ''}" title="列表">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>
            </button>
            <button id="plist-shelf-btn" class="lib-view-btn${playlistViewMode === 'shelf' ? ' active' : ''}" title="书架">
              <svg viewBox="0 0 24 24" width="15" height="15"><rect x="3" y="4" width="4" height="14" rx="1" fill="currentColor"/><rect x="8.5" y="2" width="3" height="16" rx="1" fill="currentColor" opacity="0.75"/><rect x="13" y="5" width="4" height="13" rx="1" fill="currentColor" opacity="0.9"/><rect x="18" y="3" width="3" height="15" rx="1" fill="currentColor" opacity="0.65"/><rect x="2" y="18.5" width="20" height="2.5" rx="1" fill="currentColor"/></svg>
            </button>
            <button id="plist-vinyl-btn" class="lib-view-btn${playlistViewMode === 'vinyl' ? ' active' : ''}" title="黑胶">
              <svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="track-list-wrapper" id="playlist-track-area">${playlistViewMode === 'list' ? listHTML : ''}</div>`;

  const trackArea = container.querySelector('#playlist-track-area');
  if (playlistViewMode === 'shelf') renderTrackShelf(tracks, contextUri, trackArea);
  else if (playlistViewMode === 'vinyl') renderVinylShelf(tracks, contextUri, trackArea);
  else bindTrackRows(trackArea, contextUri);

  container.querySelector('#play-all-btn').addEventListener('click', () => playContext(contextUri));

  const setViewMode = (mode) => {
    playlistViewMode = mode;
    ['list','shelf','vinyl'].forEach(m => {
      container.querySelector(`#plist-${m}-btn`)?.classList.toggle('active', m === mode);
    });
  };
  container.querySelector('#plist-list-btn').addEventListener('click', () => {
    if (playlistViewMode === 'list') return;
    setViewMode('list');
    if (shelfResizeObserver) { shelfResizeObserver.disconnect(); shelfResizeObserver = null; }
    trackArea.innerHTML = listHTML;
    bindTrackRows(trackArea, contextUri);
  });
  container.querySelector('#plist-shelf-btn').addEventListener('click', () => {
    if (playlistViewMode === 'shelf') return;
    setViewMode('shelf');
    renderTrackShelf(tracks, contextUri, trackArea);
  });
  container.querySelector('#plist-vinyl-btn').addEventListener('click', () => {
    if (playlistViewMode === 'vinyl') return;
    setViewMode('vinyl');
    if (shelfResizeObserver) { shelfResizeObserver.disconnect(); shelfResizeObserver = null; }
    renderVinylShelf(tracks, contextUri, trackArea);
  });
}

function renderTrackShelf(tracks, contextUri, container) {
  const booksPerRow = Math.max(5, Math.min(40, Math.floor((container.clientWidth - 80) / 56)));
  const rows = [];
  for (let i = 0; i < tracks.length; i += booksPerRow) rows.push(tracks.slice(i, i + booksPerRow));

  container.innerHTML = `<div class="bookshelf">${rows.map(row => `
    <div class="shelf">
      <div class="shelf-books">${row.map(t => {
        const img = t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || '';
        const artist = t.artists?.[0]?.name || '';
        const isPlaying = t.uri === currentTrackUri;
        return `<div class="book${isPlaying ? ' playing' : ''}" data-uri="${t.uri}" data-ctx="${esc(contextUri || '')}" title="${esc(t.name)} — ${esc(artist)}">
          ${img ? `<img class="book-art" src="${img}" alt="" crossorigin="anonymous">` : ''}
          <div class="book-spine">
            <span class="book-title">${esc(t.name)}</span>
            <span class="book-artist">${esc(artist)}</span>
          </div>
        </div>`;
      }).join('')}</div>
      <div class="shelf-board"></div>
    </div>`).join('')}
  </div>`;

  container.querySelectorAll('.book-art').forEach(img => {
    const tint = () => {
      try {
        const cv = document.getElementById('color-canvas');
        const cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0, 16, 16);
        const d = cx.getImageData(0, 0, 16, 16).data;
        let r=0,g=0,b=0,n=0;
        for (let i=0;i<d.length;i+=4) {
          const l=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
          if(l<20||l>225) continue;
          r+=d[i];g+=d[i+1];b+=d[i+2];n++;
        }
        if(!n) return;
        r=Math.round(r/n);g=Math.round(g/n);b=Math.round(b/n);
        const mx=Math.max(r,g,b);
        if(mx>0&&mx<160){const bst=Math.min(160/mx,1.6);r=Math.min(255,Math.round(r*bst));g=Math.min(255,Math.round(g*bst));b=Math.min(255,Math.round(b*bst));}
        const spine=img.closest('.book')?.querySelector('.book-spine');
        if(spine) spine.style.background=`linear-gradient(175deg,rgb(${r},${g},${b}) 0%,rgb(${Math.round(r*.35)},${Math.round(g*.35)},${Math.round(b*.35)}) 100%)`;
      } catch{}
    };
    if(img.complete&&img.naturalWidth>0) tint();
    else img.addEventListener('load',tint,{once:true});
  });

  const popup = document.getElementById('book-popup');
  container.querySelectorAll('.book').forEach(book => {
    book.addEventListener('click', () => playTrack(book.dataset.uri, book.dataset.ctx || null));
    book.addEventListener('mouseenter', () => {
      const t = tracks.find(tr => tr.uri === book.dataset.uri);
      if (!t || !popup) return;
      const img = t.album?.images?.[0]?.url || '';
      const artist = t.artists?.map(a => a.name).join(', ') || '';
      popup.innerHTML = `${img ? `<img class="book-popup-art" src="${img}">` : ''}
        <div class="book-popup-info">
          <div class="book-popup-title">${esc(t.name)}</div>
          <div class="book-popup-artist">${esc(artist)}</div>
          ${t.album?.name ? `<div class="book-popup-album">${esc(t.album.name)}</div>` : ''}
        </div>`;
      popup.classList.add('visible');
      const rect = book.getBoundingClientRect();
      const pw = 180;
      const left = Math.max(8, Math.min(rect.left + rect.width / 2 - pw / 2, window.innerWidth - pw - 8));
      popup.style.left = `${left}px`;
      popup.style.top = '-9999px';
      requestAnimationFrame(() => {
        popup.style.top = `${rect.top - popup.offsetHeight - 10}px`;
      });
    });
    book.addEventListener('mouseleave', () => popup?.classList.remove('visible'));
  });

  if (shelfResizeObserver) shelfResizeObserver.disconnect();
  lastShelfBooksPerRow = booksPerRow;
  let resizeTimer;
  shelfResizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const newBpr = Math.max(5, Math.min(40, Math.floor((container.clientWidth - 80) / 56)));
      if (newBpr !== lastShelfBooksPerRow) renderTrackShelf(tracks, contextUri, container);
    }, 150);
  });
  shelfResizeObserver.observe(container);
}

// ── Lyrics ───────────────────────────────────────────────────
function parseLRC(lrc) {
  const result = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (m) result.push({ time: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3].trim() });
  }
  return result.sort((a, b) => a.time - b.time);
}

let lyricsGen = 0;

async function fetchLyrics(track) {
  const id = track.id;
  if (id === lyricsTrackId && lyricsLines.length > 0) return;
  const myGen = ++lyricsGen;
  lyricsTrackId = id;
  lyricsLines = [];
  currentLyricIdx = -1;
  window.electronAPI.updateMiniLyric('');
  ['npo-lyrics-lines', 'vinyl-lyrics-lines'].forEach(cid => {
    const el = document.getElementById(cid);
    if (el) el.innerHTML = `<div class="lyric-empty">${i18n[currentLang].lyrics_searching}</div>`;
  });

  const artist = track.artists?.[0]?.name || '';
  const title = (track.name || '').replace(/\s*[-–]\s*(remaster\w*|radio edit|single version|live\b.*)/i, '').trim();
  const album = track.album?.name || '';
  const dur = Math.round((track.duration_ms || 0) / 1000);
  const ea = encodeURIComponent(artist), et = encodeURIComponent(title), eal = encodeURIComponent(album);

  const stale = () => myGen !== lyricsGen;

  // 1. Spotify private lyrics API via IPC (no CORS in main process)
  try {
    const data = await window.electronAPI.fetchLyrics(id, accessToken);
    if (stale()) return;
    if (data?.lyrics?.lines?.length) {
      const synced = data.lyrics.syncType === 'LINE_SYNCED';
      const lines = data.lyrics.lines
        .map(l => ({ time: synced ? parseInt(l.startTimeMs) / 1000 : -1, text: l.words }))
        .filter(l => l.text && l.text !== '♪');
      if (lines.length) { lyricsLines = lines; renderLyricsPanel(); return; }
    }
  } catch {}
  if (stale()) return;

  // 2. lrclib — 3 strategies in parallel (whichever returns synced wins)
  const fetchWithTimeout = async (url, ms = 6000) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) return null;
      const d = await r.json();
      if (Array.isArray(d)) return d.find(x => x.syncedLyrics) || d[0] || null;
      return (d?.syncedLyrics || d?.plainLyrics) ? d : null;
    } catch { return null; }
  };
  const [lrcExact, lrcShort, lrcSearch] = await Promise.all([
    fetchWithTimeout(`https://lrclib.net/api/get?artist_name=${ea}&track_name=${et}&album_name=${eal}&duration=${dur}`),
    fetchWithTimeout(`https://lrclib.net/api/get?artist_name=${ea}&track_name=${et}`),
    fetchWithTimeout(`https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + title)}`),
  ]);
  if (stale()) return;
  // Prefer synced over plain, exact match over looser
  const lrc = [lrcExact, lrcShort, lrcSearch].find(l => l?.syncedLyrics)
           || [lrcExact, lrcShort, lrcSearch].find(l => l?.plainLyrics)
           || null;
  if (lrc?.syncedLyrics) lyricsLines = parseLRC(lrc.syncedLyrics);
  else if (lrc?.plainLyrics) lyricsLines = lrc.plainLyrics.split('\n').filter(Boolean).map(text => ({ time: -1, text }));
  if (stale()) return;

  renderLyricsPanel();
}

function renderLyricsPanel() {
  window.electronAPI.updateImmersiveLyrics({ lines: lyricsLines, idx: currentLyricIdx });
  const panels = [
    { id: 'npo-lyrics-lines', visible: lyricsVisible },
    { id: 'vinyl-lyrics-lines', visible: vinylLyricsVisible },
  ];
  panels.forEach(({ id, visible }) => {
    const container = document.getElementById(id);
    if (!container) return;
    if (!lyricsLines.length) {
      container.innerHTML = `<div class="lyric-empty">${i18n[currentLang].lyrics_empty}</div>`;
      return;
    }
    container.innerHTML = lyricsLines.map((line, i) => {
      const active = i === currentLyricIdx;
      return `<div class="lyric-line${active ? ' lyric-active' : ''}" data-idx="${i}">${esc(line.text || '♪')}</div>`;
    }).join('');
    if (currentLyricIdx >= 0 && visible) {
      const activeEl = container.querySelector('.lyric-active');
      if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

function syncLyrics(posMs) {
  if (!lyricsLines.length || lyricsLines[0].time < 0) return;
  const posSec = posMs / 1000 + 0.35; // 350ms lookahead so lyrics feel on-time
  let idx = 0;
  for (let i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].time <= posSec) idx = i; else break;
  }
  if (idx !== currentLyricIdx) {
    currentLyricIdx = idx;
    window.electronAPI.updateMiniLyric(lyricsLines[idx]?.text || '');
    [
      { id: 'npo-lyrics-lines', visible: lyricsVisible },
      { id: 'vinyl-lyrics-lines', visible: vinylLyricsVisible },
    ].forEach(({ id, visible }) => {
      if (!visible) return;
      const container = document.getElementById(id);
      if (!container) return;
      const prev = container.querySelector('.lyric-active');
      if (prev) prev.classList.remove('lyric-active');
      const next = container.querySelector(`[data-idx="${idx}"]`);
      if (next) { next.classList.add('lyric-active'); next.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
  }
}

// ── Add to Playlist ──────────────────────────────────────────
async function openAddToPlaylistModal(trackUri) {
  addPlaylistPendingUri = trackUri;
  const modal = document.getElementById('add-playlist-modal');
  const listEl = document.getElementById('add-playlist-list');
  modal.classList.remove('hidden');
  listEl.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px">${i18n[currentLang].loading}</div>`;

  const data = await fetchMyPlaylists();
  if (!data?.items?.length) {
    listEl.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px">${i18n[currentLang].no_playlists}</div>`;
    return;
  }
  listEl.innerHTML = data.items.map(p => `
    <div class="atp-item" data-id="${p.id}">
      <img class="atp-art" src="${p.images?.[0]?.url || ''}" alt="">
      <span class="atp-name">${esc(p.name)}</span>
    </div>`).join('');
  listEl.querySelectorAll('.atp-item').forEach(item => {
    item.addEventListener('click', async () => {
      const pid = item.dataset.id;
      closeAddToPlaylistModal();
      const res = await api(`/playlists/${pid}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ uris: [addPlaylistPendingUri] }),
      });
      showToast(res !== null ? i18n[currentLang].toast_added : i18n[currentLang].toast_add_failed);
    });
  });
}

function closeAddToPlaylistModal() {
  document.getElementById('add-playlist-modal').classList.add('hidden');
}

function renderVinylShelf(tracks, contextUri, container) {
  container.innerHTML = `<div class="vinyl-wall">${tracks.map(t => {
    const img = t.album?.images?.[0]?.url || t.album?.images?.[1]?.url || '';
    const isPlaying = t.uri === currentTrackUri;
    return `<div class="vinyl-card${isPlaying ? ' playing' : ''}" data-uri="${t.uri}" data-ctx="${esc(contextUri || '')}">
      <div class="vinyl-sleeve">
        ${img ? `<img src="${img}" alt="" draggable="false">` : '<div class="vinyl-sleeve-empty"></div>'}
      </div>
      <div class="vinyl-record-wrap">
        <div class="vinyl-record">
          ${img ? `<img class="vinyl-record-label" src="${img}" alt="">` : ''}
          <div class="vinyl-record-hole"></div>
        </div>
      </div>
      <div class="vinyl-card-info">
        <div class="vinyl-card-name">${esc(t.name)}</div>
        <div class="vinyl-card-artist">${esc(t.artists?.[0]?.name || '')}</div>
      </div>
    </div>`;
  }).join('')}</div>`;

  container.querySelectorAll('.vinyl-card').forEach(card => {
    card.addEventListener('click', () => {
      const t = tracks.find(tr => tr.uri === card.dataset.uri);
      if (t) openVinylOverlay(t, card.dataset.ctx, tracks);
    });
  });
}

function openVinylOverlay(track, contextUri, tracks = [], noPlay = false) {
  if (!noPlay) playTrack(track.uri, contextUri || null);
  const img = track.album?.images?.[0]?.url || '';
  document.getElementById('vinyl-big-label').src = img;
  document.getElementById('vinyl-overlay-bg').src = img;
  document.getElementById('vinyl-overlay-title').textContent = track.name;
  document.getElementById('vinyl-overlay-artist').textContent = track.artists?.map(a => a.name).join(', ') || '';
  // Prev art: what was playing before
  const prevEl = document.getElementById('vinyl-prev-art');
  if (prevEl) prevEl.src = vinylPrevArt;
  // Next art: next track in the list if we have it
  const nextEl = document.getElementById('vinyl-next-art');
  if (nextEl) {
    const idx = tracks.findIndex(t => t.uri === track.uri);
    const nextTrack = idx >= 0 && idx + 1 < tracks.length ? tracks[idx + 1] : null;
    vinylNextArt = nextTrack?.album?.images?.[0]?.url || '';
    nextEl.src = vinylNextArt;
  }
  // Disc entry animation then spinning
  const disc = document.getElementById('vinyl-big-disc');
  disc.classList.remove('spinning', 'entering');
  requestAnimationFrame(() => {
    disc.classList.add('entering');
    setTimeout(() => { disc.classList.remove('entering'); disc.classList.add('spinning'); }, 600);
  });
  // Background & ambient
  spawnOrbs('vinyl-overlay-orbs');
  // Tonearm: park → play
  const arm = document.getElementById('vinyl-tonearm');
  arm.classList.remove('playing');
  setTimeout(() => arm.classList.add('playing'), 80);
  document.getElementById('vinyl-overlay').classList.add('open');
  document.getElementById('vinyl-volume-slider').value = volumeLevel;
  // Start visualizer on vinyl canvas
  if (viz.ready && isPlaying) {
    viz.canvas = document.getElementById('vinyl-visualizer');
    viz.ctx = viz.canvas?.getContext('2d');
    startViz();
  }
}

function switchToVinyl() {
  if (!currentTrackUri) return;
  const fakeTrack = {
    uri: currentTrackUri,
    name: document.getElementById('now-track-name')?.textContent || '—',
    artists: [{ name: document.getElementById('now-artist-name')?.textContent || '' }],
    album: { images: [{ url: currentArtUrl || '' }] },
  };
  closeNPO();
  openVinylOverlay(fakeTrack, currentContextUri, [], true);
}

function switchToNPO() {
  closeVinylOverlay();
  openNPO();
}

function closeVinylOverlay() {
  const overlay = document.getElementById('vinyl-overlay');
  overlay.classList.remove('open', 'vinyl-lyrics-open', 'controls-idle', 'vinyl-queue-open');
  const arm = document.getElementById('vinyl-tonearm');
  arm?.classList.remove('playing');
  document.getElementById('vinyl-overlay-orbs')?.classList.remove('ready');
  vinylLyricsVisible = false;
  document.getElementById('vinyl-lyrics-btn')?.classList.remove('active');
  // Restore viz to NPO canvas
  viz.canvas = document.getElementById('npo-visualizer');
  viz.ctx = viz.canvas?.getContext('2d');
  if (!npoOpen) stopViz();
}

// ── Renderers ────────────────────────────────────────────────
function cardHTML(track) {
  const img = track.album?.images?.[0]?.url || '';
  return `
    <div class="card" data-uri="${track.uri}">
      <img src="${img}" alt="" class="card-img">
      <div class="card-name">${esc(track.name)}</div>
      <div class="card-sub">${esc(track.artists?.[0]?.name || '')}</div>
      <button class="card-play-btn" data-uri="${track.uri}">▶</button>
    </div>`;
}

function trackListHTML(tracks, contextUri = null) {
  const tl = i18n[currentLang];
  return `<div class="track-list">
    <div class="track-list-header">
      <span>#</span><span></span><span>${tl.track_col_title}</span><span>${tl.track_col_album}</span><span>${tl.track_col_duration}</span><span></span>
    </div>
    ${tracks.filter(Boolean).map((t, i) => `
      <div class="track-row${t.uri === currentTrackUri ? ' playing' : ''}"
           data-uri="${t.uri}" data-context="${contextUri || ''}">
        <span class="track-num">
          <span class="track-num-text">${i + 1}</span>
          <span class="eq-bars">
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
          </span>
        </span>
        <img src="${t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || ''}" alt="" class="track-thumb">
        <div class="track-info">
          <div class="track-title">${esc(t.name)}</div>
          <div class="track-artist">${esc(t.artists?.map(a => a.name).join(', ') || '')}</div>
        </div>
        <div class="track-album">${esc(t.album?.name || '')}</div>
        <div class="track-duration">${msToTime(t.duration_ms)}</div>
        <button class="track-add-btn" data-uri="${t.uri}" title="${tl.track_add_title}">
          <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>
        </button>
      </div>`).join('')}
  </div>`;
}

function bindCardClicks(container) {
  container.querySelectorAll('.card-play-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); playTrack(btn.dataset.uri); });
  });
}

function bindTrackRows(container, contextUri = null) {
  container.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.track-add-btn')) return;
      const ctx = contextUri || row.dataset.context || null;
      playTrack(row.dataset.uri, ctx);
    });
  });
  container.querySelectorAll('.track-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddToPlaylistModal(btn.dataset.uri);
    });
  });
}

// ── Artist Page ─────────────────────────────────────────────
async function openArtist(id) {
  switchView('artist');
  const container = document.getElementById('artist-detail');
  container.innerHTML = `<div class="loading-text">${i18n[currentLang].loading}</div>`;

  const [artist, topData, albumData] = await Promise.all([
    api(`/artists/${id}`),
    api(`/artists/${id}/top-tracks?market=from_token`),
    api(`/artists/${id}/albums?limit=12&include_groups=album,single`),
  ]);
  const tr = i18n[currentLang];
  if (!artist) { container.innerHTML = `<div class="loading-text">${tr.artist_load_fail}</div>`; return; }

  const img = artist.images?.[0]?.url || '';
  const followers = (artist.followers?.total || 0).toLocaleString();
  const topTracks = topData?.tracks?.slice(0, 10) || [];
  const albums = albumData?.items || [];
  const albumLabel = currentLang === 'zh' ? '专辑' : 'Album';
  const singleLabel = currentLang === 'zh' ? '单曲' : 'Single';

  container.innerHTML = `
    <div class="artist-hero">
      <div class="artist-hero-bg" style="background-image:url('${img}')"></div>
      <div class="artist-hero-gradient"></div>
      <div class="artist-hero-content">
        <img class="artist-avatar" src="${img}" alt="">
        <div class="artist-hero-info">
          <div class="artist-type">${tr.artist_type}</div>
          <div class="artist-name">${esc(artist.name)}</div>
          <div class="artist-followers">${followers} ${tr.artist_followers}</div>
        </div>
      </div>
    </div>
    <div class="artist-body">
      ${topTracks.length ? `<section class="content-section"><h2>${tr.artist_top_tracks}</h2>${trackListHTML(topTracks)}</section>` : ''}
      ${albums.length ? `
        <section class="content-section">
          <h2>${tr.artist_albums}</h2>
          <div class="card-grid">
            ${albums.map(a => `
              <div class="card" data-album-id="${a.id}" data-ctx="${a.uri}">
                <img src="${a.images?.[0]?.url || ''}" alt="" class="card-img">
                <div class="card-name">${esc(a.name)}</div>
                <div class="card-sub">${(a.release_date || '').slice(0, 4)} · ${a.album_type === 'single' ? singleLabel : albumLabel}</div>
                <button class="card-play-btn" data-uri="${a.uri}">▶</button>
              </div>`).join('')}
          </div>
        </section>` : ''}
    </div>`;

  bindTrackRows(container);
  container.querySelectorAll('.card[data-album-id]').forEach(card => {
    card.addEventListener('click', () => openPlaylist(card.dataset.albumId));
  });
  container.querySelectorAll('.card-play-btn[data-uri]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); playTrack(btn.dataset.uri); });
  });
}

// ── Navigation ───────────────────────────────────────────────
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`${name}-view`).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`[data-view="${name}"]`)?.classList.add('active');
  document.getElementById('main-content').scrollTop = 0;
}

// ── Like ─────────────────────────────────────────────────────
async function toggleLike() {
  if (!currentTrackUri) return;
  const id = currentTrackUri.split(':').pop();
  const liked = likedTrackIds.has(id);
  if (liked) {
    await api(`/me/tracks?ids=${id}`, { method: 'DELETE' });
    likedTrackIds.delete(id);
  } else {
    await api(`/me/tracks?ids=${id}`, { method: 'PUT' });
    likedTrackIds.add(id);
  }
  const nowLiked = !liked;
  document.getElementById('like-btn').classList.toggle('liked', nowLiked);
  document.getElementById('npo-like-btn').classList.toggle('liked', nowLiked);
}

// ── Toast ────────────────────────────────────────────────────
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Utility ──────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Queue Panel ───────────────────────────────────────────────
let queueOpen = false;

function renderQueueItems(items, listEl) {
  const list = listEl || document.getElementById('queue-list');
  if (!list) return;
  list.innerHTML = items.map((t, i) => `
    <div class="queue-item${i === 0 ? ' queue-now' : ''}" data-uri="${t.uri}">
      <img class="queue-art" src="${t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || ''}" alt="">
      <div class="queue-info">
        <div class="queue-title">${esc(t.name)}</div>
        <div class="queue-artist">${esc(t.artists?.[0]?.name || '')}</div>
      </div>
      ${i === 0 ? `<div class="queue-now-tag">${i18n[currentLang].queue_now_playing}</div>` : ''}
    </div>`).join('');
  list.querySelectorAll('.queue-item:not(.queue-now)').forEach(el => {
    el.addEventListener('click', () => playTrack(el.dataset.uri, currentContextUri));
  });
}

// Returns full queue by extending the API's ~20 limit with the current context tracks
async function fetchFullQueue() {
  const data = await api('/me/player/queue');
  if (!data) return null;
  const current = data.currently_playing;
  const apiNext = (data.queue || []).filter(t => t?.type === 'track');

  if (currentContextUri && current) {
    let contextTracks = null;

    if (cachedPlaylistUri === currentContextUri && cachedPlaylistTracks.length) {
      contextTracks = cachedPlaylistTracks;
    } else if (currentContextUri.startsWith('spotify:playlist:')) {
      const id = currentContextUri.split(':').pop();
      let all = [], next = `/playlists/${id}/items?limit=100`;
      while (next) {
        const page = await api(next.replace('https://api.spotify.com/v1', ''));
        if (!page) break;
        all = all.concat(page.items || []);
        next = page.next;
      }
      contextTracks = all.map(i => i.track || i.item).filter(t => t?.type === 'track');
      cachedPlaylistTracks = contextTracks;
      cachedPlaylistUri = currentContextUri;
    } else if (currentContextUri.startsWith('spotify:album:')) {
      const id = currentContextUri.split(':').pop();
      let all = [], next = `/albums/${id}/tracks?limit=50`;
      while (next) {
        const page = await api(next.replace('https://api.spotify.com/v1', ''));
        if (!page) break;
        all = all.concat(page.items || []);
        next = page.next;
      }
      contextTracks = all.filter(t => t?.type === 'track');
    } else if (likedCollectionUri && currentContextUri === likedCollectionUri
               && cachedPlaylistUri === likedCollectionUri && cachedPlaylistTracks.length) {
      contextTracks = cachedPlaylistTracks;
    }

    if (contextTracks?.length) {
      if (shuffleActive) {
        // API's 20 are the real shuffled order; append remaining context tracks not yet seen
        const seen = new Set([current.uri, ...apiNext.map(t => t.uri)]);
        const rest = contextTracks.filter(t => !seen.has(t.uri));
        return { currently_playing: current, queue: [...apiNext, ...rest] };
      } else {
        const idx = contextTracks.findIndex(t => t.uri === current.uri);
        if (idx >= 0) {
          return { currently_playing: current, queue: contextTracks.slice(idx + 1) };
        }
      }
    }
  }

  return { currently_playing: current, queue: apiNext };
}

async function loadQueueInto(listEl, padStyle = 'padding:20px 14px;') {
  listEl.innerHTML = `<div style="${padStyle}color:var(--text-muted);font-size:13px">${i18n[currentLang].loading}</div>`;
  const data = await fetchFullQueue();
  if (!data) { listEl.innerHTML = `<div style="${padStyle}color:var(--text-muted);font-size:13px">${i18n[currentLang].error_queue}</div>`; return null; }
  const items = [data.currently_playing, ...(data.queue || [])].filter(t => t?.type === 'track');
  if (!items.length) { listEl.innerHTML = `<div style="${padStyle}color:var(--text-muted);font-size:13px">${i18n[currentLang].queue_empty}</div>`; return null; }
  renderQueueItems(items, listEl);
  return items;
}

async function refreshQueueContent() {
  if (!queueOpen) return;
  const items = await loadQueueInto(document.getElementById('queue-list'));
  if (items) {
    const nextTrack = items[1];
    if (nextTrack) {
      vinylNextArt = nextTrack.album?.images?.[0]?.url || '';
      const nextEl = document.getElementById('vinyl-next-art');
      if (nextEl) nextEl.src = vinylNextArt;
    }
  }
}

async function toggleQueue() {
  const panel = document.getElementById('queue-panel');
  queueOpen = !queueOpen;
  panel.classList.toggle('open', queueOpen);
  if (!queueOpen) return;
  await loadQueueInto(document.getElementById('queue-list'));
}

// ── App Icon ──────────────────────────────────────────────────
function generateAppIcon() {
  try {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#181818';
    ctx.beginPath(); ctx.arc(32, 32, 32, 0, Math.PI * 2); ctx.fill();
    // Headphones shape
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(32, 28, 14, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(14, 27, 7, 12); ctx.beginPath(); ctx.arc(17.5, 27, 3.5, Math.PI, 0); ctx.fill();
    ctx.fillRect(43, 27, 7, 12); ctx.beginPath(); ctx.arc(46.5, 27, 3.5, Math.PI, 0); ctx.fill();
    window.electronAPI.setAppIcon(cv.toDataURL('image/png'));
  } catch {}
}


// ── Sleep Timer ───────────────────────────────────────────────
function setSleepTimer(minutes) {
  clearTimeout(sleepTimerId);
  clearInterval(sleepNoteInterval);
  sleepTimerId = null;
  sleepTimerEnd = 0;
  ['sleep-off-btn','sleep-15-btn','sleep-30-btn','sleep-60-btn'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  const noteEl = document.getElementById('sleep-note');

  if (minutes === 0) {
    document.getElementById('sleep-off-btn')?.classList.add('active');
    if (noteEl) noteEl.textContent = '';
    return;
  }

  const btnId = `sleep-${minutes}-btn`;
  document.getElementById(btnId)?.classList.add('active');
  sleepTimerEnd = Date.now() + minutes * 60 * 1000;

  const updateNote = () => {
    const left = Math.max(0, sleepTimerEnd - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    const timeStr = `${m}:${String(s).padStart(2,'0')}`;
    if (noteEl) noteEl.textContent = i18n[currentLang].sleep_countdown(timeStr);
  };
  updateNote();
  sleepNoteInterval = setInterval(updateNote, 1000);

  sleepTimerId = setTimeout(async () => {
    clearInterval(sleepNoteInterval);
    await api('/me/player/pause', { method: 'PUT' });
    setTimeout(pollPlayback, 400);
    setSleepTimer(0);
    showToast(i18n[currentLang].sleep_stopped);
  }, minutes * 60 * 1000);
}

// ── Device Switcher ───────────────────────────────────────────
async function loadDevices() {
  const listEl = document.getElementById('devices-list');
  if (!listEl) return;
  const tr = i18n[currentLang];
  listEl.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:4px 0">${tr.loading}</div>`;
  const data = await api('/me/player/devices');
  if (!data?.devices?.length) {
    listEl.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:4px 0">${tr.device_none}</div>`;
    return;
  }
  listEl.innerHTML = data.devices.map(d => `
    <div class="device-item${d.is_active ? ' device-active' : ''}" data-id="${d.id}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="flex-shrink:0;opacity:0.7">
        ${d.type === 'Smartphone'
          ? '<path d="M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H7V4h10v12z"/>'
          : d.type === 'Speaker'
          ? '<path d="M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5 14c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm0-4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zM7 8h10V6H7v2z"/>'
          : '<path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>'}
      </svg>
      <div class="device-info">
        <div class="device-name">${esc(d.name)}</div>
        <div class="device-type">${d.type}${d.is_active ? ` · ${tr.device_current}` : ''}${d.volume_percent != null ? ` · ${d.volume_percent}%` : ''}</div>
      </div>
      ${d.is_active ? '<span class="device-active-dot"></span>' : ''}
    </div>`).join('');

  listEl.querySelectorAll('.device-item:not(.device-active)').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      await api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [id], play: isPlaying }) });
      activeDeviceId = id;
      showToast(i18n[currentLang].device_switched);
      setTimeout(loadDevices, 800);
    });
  });
}


// ── Stats Page ────────────────────────────────────────────────
async function loadStats() {
  const container = document.getElementById('stats-content');
  if (!container) return;
  container.innerHTML = `<div class="loading-text">${i18n[currentLang].loading}</div>`;

  const [tracksData, artistsData] = await Promise.all([
    api(`/me/top/tracks?limit=10&time_range=${statsRange}`),
    api(`/me/top/artists?limit=8&time_range=${statsRange}`),
  ]);

  let html = '';

  const tr = i18n[currentLang];
  if (artistsData?.items?.length) {
    html += `<section class="content-section"><h2>${tr.stats_artists}</h2><div class="stats-artists">`;
    html += artistsData.items.map((a, i) => `
      <div class="stats-artist-item" data-artist-id="${a.id}">
        <span class="stats-rank">${i + 1}</span>
        <img class="stats-artist-img" src="${a.images?.[2]?.url || a.images?.[0]?.url || ''}" alt="">
        <div class="stats-artist-info">
          <div class="stats-artist-name">${esc(a.name)}</div>
          <div class="stats-artist-genres">${(a.genres || []).slice(0,2).join(' · ') || tr.stats_artist_fallback}</div>
        </div>
        <div class="stats-popularity">
          <div class="stats-pop-bar" style="width:${a.popularity || 0}%"></div>
        </div>
      </div>`).join('');
    html += `</div></section>`;
  }

  if (tracksData?.items?.length) {
    html += `<section class="content-section"><h2>${tr.stats_tracks}</h2>`;
    html += trackListHTML(tracksData.items);
    html += `</section>`;
  }

  if (!html) html = `<div class="loading-text" style="color:var(--text-muted)">${tr.stats_empty}</div>`;
  container.innerHTML = html;

  bindTrackRows(container);
  container.querySelectorAll('.stats-artist-item').forEach(el => {
    el.addEventListener('click', () => openArtist(el.dataset.artistId));
  });

  // Sync tab active state
  document.querySelectorAll('.stats-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.range === statsRange));
}

// ── i18n ─────────────────────────────────────────────────────
const i18n = {
  zh: {
    nav_home: '主页', nav_search: '搜索', nav_library: '音乐库',
    sidebar_toggle: '收起侧边栏', playlist_section: '播放列表', logout: '退出登录',
    home_recent: '最近播放', home_liked: '喜欢的歌曲',
    search_placeholder: '搜索歌曲、艺术家、专辑...',
    btn_like: '喜欢', btn_shuffle: '随机播放', btn_prev: '上一首',
    btn_play: '播放/暂停', btn_next: '下一首', btn_repeat: '循环',
    btn_queue: '播放队列', btn_expand: '全屏', btn_settings: '设置',
    settings_title: '设置', settings_perf: '性能模式', settings_lang: '语言 / Language',
    perf_high: '高性能', perf_high_sub: '60fps · 完整光效 · 适合独立显卡',
    perf_low: '低性能', perf_low_sub: '30fps · 减少光效 · 节省 CPU',
    perf_note_low: '下次打开 NPO / 黑胶时生效',
    greeting_night: '深夜好', greeting_morning: '早上好',
    greeting_afternoon: '下午好', greeting_evening: '晚上好',
    settings_viz: '可视化 / Visualizer',
    viz_on: '开启', viz_off: '关闭',
    viz_note: '关闭后停止屏幕捕捉（解决 GPU 兼容问题）',
    // Spotify launch
    spotify_launched: 'Spotify 已在后台启动',
    spotify_not_found: '未找到 Spotify，请手动安装或打开 Spotify 客户端',
    spotify_starting: 'Spotify 启动中，请稍候...',
    spotify_ready: 'Spotify 已就绪 ✓',
    spotify_timeout: '连接超时，请手动打开 Spotify 后重试',
    // Search
    search_playlists: '歌单', search_tracks: '歌曲', search_artists: '艺术家',
    search_artist_label: '艺术家', search_no_results: '无搜索结果',
    // Loading / errors
    loading: '加载中...', error_playlist: '无法加载歌单', error_queue: '无法加载队列',
    btn_retry: '手动重试', api_quota: 'Spotify 每日 API 配额已耗尽',
    api_quota_note: '等配额重置后再试（约 12:50 AM）', no_playlists: '无歌单',
    // Playlist view
    playlist_type: '播放列表', playlist_tracks_suffix: '首歌曲', play_all: '▶ 播放全部',
    playlist_no_api_tracks: '此歌单的歌曲无法通过 Spotify API 获取（仅支持自建歌单）。',
    // Track list
    track_col_title: '标题', track_col_album: '专辑', track_col_duration: '时长',
    track_add_title: '添加到歌单',
    // Queue
    queue_now_playing: '播放中', queue_empty: '队列为空',
    // Lyrics
    lyrics_searching: '搜索歌词...', lyrics_empty: '暂无歌词',
    // Toasts
    toast_added: '已添加到歌单', toast_add_failed: '添加失败', toast_reshuffled: '已重新随机',
    // Close behavior
    settings_close: '关闭行为',
    close_tray: '最小化到托盘', close_quit: '直接退出',
    close_note_tray: '按 × 隐藏窗口，从托盘图标可重新打开',
    close_note_quit: '按 × 直接退出 Aura',
    // Glass
    settings_glass: '沉浸式 · 玻璃颜色',
    glass_black: '黑色', glass_color: '跟随歌曲', glass_clear: '透明',
    // Sleep
    settings_sleep: '睡眠定时器',
    sleep_off: '关闭', sleep_15: '15 分', sleep_30: '30 分', sleep_60: '60 分',
    sleep_countdown: (t) => `将在 ${t} 后暂停`, sleep_stopped: '睡眠定时器：已暂停播放',
    // Devices
    settings_devices: '播放设备',
    device_current: '当前设备', device_none: '未找到设备', device_switched: '已切换播放设备',
    // Queue panel
    queue_header: '播放队列',
    // Stats
    stats_title: '你的音乐统计',
    stats_short: '近 4 周', stats_medium: '近 6 个月', stats_long: '全时段',
    stats_artists: '常听艺术家', stats_tracks: '常听歌曲', stats_empty: '暂无统计数据',
    stats_artist_fallback: '艺术家',
    // Nav
    nav_stats: '统计',
    // Artist page
    artist_type: '艺术家', artist_followers: '粉丝',
    artist_top_tracks: '热门歌曲', artist_albums: '专辑 & 单曲',
    artist_load_fail: '加载失败',
  },
  en: {
    nav_home: 'Home', nav_search: 'Search', nav_library: 'Library',
    sidebar_toggle: 'Collapse sidebar', playlist_section: 'Playlists', logout: 'Log out',
    home_recent: 'Recently Played', home_liked: 'Liked Songs',
    search_placeholder: 'Search songs, artists, albums...',
    btn_like: 'Like', btn_shuffle: 'Shuffle', btn_prev: 'Previous',
    btn_play: 'Play/Pause', btn_next: 'Next', btn_repeat: 'Repeat',
    btn_queue: 'Queue', btn_expand: 'Full screen', btn_settings: 'Settings',
    settings_title: 'Settings', settings_perf: 'Performance', settings_lang: 'Language',
    perf_high: 'High Performance', perf_high_sub: '60fps · Full effects · Best with GPU',
    perf_low: 'Low Performance', perf_low_sub: '30fps · Reduced effects · Saves CPU',
    perf_note_low: 'Takes effect on next NPO / vinyl open',
    greeting_night: 'Good night', greeting_morning: 'Good morning',
    greeting_afternoon: 'Good afternoon', greeting_evening: 'Good evening',
    settings_viz: 'Visualizer',
    viz_on: 'On', viz_off: 'Off',
    viz_note: 'Disable to stop screen capture (fixes GPU glitches)',
    // Spotify launch
    spotify_launched: 'Spotify launched in background',
    spotify_not_found: 'Spotify not found. Please install or open it manually.',
    spotify_starting: 'Starting Spotify, please wait...',
    spotify_ready: 'Spotify ready ✓',
    spotify_timeout: 'Connection timed out. Open Spotify manually and retry.',
    // Search
    search_playlists: 'Playlists', search_tracks: 'Tracks', search_artists: 'Artists',
    search_artist_label: 'Artist', search_no_results: 'No results found',
    // Loading / errors
    loading: 'Loading...', error_playlist: 'Could not load playlist', error_queue: 'Could not load queue',
    btn_retry: 'Retry', api_quota: 'Spotify daily API quota exhausted',
    api_quota_note: 'Try again after quota resets (~12:50 AM)', no_playlists: 'No playlists',
    // Playlist view
    playlist_type: 'Playlist', playlist_tracks_suffix: 'tracks', play_all: '▶ Play All',
    playlist_no_api_tracks: 'Tracks in this playlist cannot be loaded via the Spotify API (only supported for playlists you own).',
    // Track list
    track_col_title: 'Title', track_col_album: 'Album', track_col_duration: 'Duration',
    track_add_title: 'Add to playlist',
    // Queue
    queue_now_playing: 'Now playing', queue_empty: 'Queue is empty',
    // Lyrics
    lyrics_searching: 'Searching lyrics...', lyrics_empty: 'No lyrics available',
    // Toasts
    toast_added: 'Added to playlist', toast_add_failed: 'Failed to add', toast_reshuffled: 'Reshuffled',
    // Close behavior
    settings_close: 'Close Behavior',
    close_tray: 'Minimize to tray', close_quit: 'Quit on close',
    close_note_tray: '× hides the window — reopen from the tray icon',
    close_note_quit: '× fully quits Aura',
    // Glass
    settings_glass: 'Immersive · Glass Color',
    glass_black: 'Dark', glass_color: 'Dynamic', glass_clear: 'Clear',
    // Sleep
    settings_sleep: 'Sleep Timer',
    sleep_off: 'Off', sleep_15: '15 min', sleep_30: '30 min', sleep_60: '60 min',
    sleep_countdown: (t) => `Pausing in ${t}`, sleep_stopped: 'Sleep timer: playback paused',
    // Devices
    settings_devices: 'Playback Devices',
    device_current: 'Active', device_none: 'No devices found', device_switched: 'Switched playback device',
    // Queue panel
    queue_header: 'Queue',
    // Stats
    stats_title: 'Your Music Stats',
    stats_short: 'Last 4 Weeks', stats_medium: 'Last 6 Months', stats_long: 'All Time',
    stats_artists: 'Top Artists', stats_tracks: 'Top Tracks', stats_empty: 'No stats available',
    stats_artist_fallback: 'Artist',
    // Nav
    nav_stats: 'Stats',
    // Artist page
    artist_type: 'Artist', artist_followers: 'followers',
    artist_top_tracks: 'Popular', artist_albums: 'Albums & Singles',
    artist_load_fail: 'Failed to load',
  }
};

function applyLang(lang) {
  currentLang = lang;
  localStorage.setItem('lang', lang);
  const t = i18n[lang];
  document.getElementById('html-root')?.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
  document.getElementById('lang-zh-btn')?.classList.toggle('active', lang === 'zh');
  document.getElementById('lang-en-btn')?.classList.toggle('active', lang === 'en');
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const title = (id, text) => { const el = document.getElementById(id); if (el) el.title = text; };
  const attr = (id, attr, text) => { const el = document.getElementById(id); if (el) el[attr] = text; };
  set('settings-header-title', t.settings_title);
  set('settings-lang-title', t.settings_lang);
  document.querySelectorAll('.settings-section-title').forEach((el, i) => {
    if (i === 0) el.textContent = t.settings_perf;
  });
  document.querySelector('#perf-high-btn .settings-perf-text > span:first-child').textContent = t.perf_high;
  document.querySelector('#perf-high-btn .settings-perf-sub').textContent = t.perf_high_sub;
  document.querySelector('#perf-low-btn .settings-perf-text > span:first-child').textContent = t.perf_low;
  document.querySelector('#perf-low-btn .settings-perf-sub').textContent = t.perf_low_sub;
  document.querySelector('[data-view="home"] span').textContent = t.nav_home;
  document.querySelector('[data-view="search"] span').textContent = t.nav_search;
  document.querySelector('[data-view="library"] span').textContent = t.nav_library;
  const plHeader = document.querySelector('.playlist-header');
  if (plHeader) plHeader.textContent = t.playlist_section;
  set('logout-btn', t.logout);
  const recentH2 = document.querySelector('#home-view .content-section:first-of-type h2');
  if (recentH2) recentH2.textContent = t.home_recent;
  const likedH2 = document.querySelector('#home-view .content-section:last-of-type h2');
  if (likedH2) likedH2.textContent = t.home_liked;
  const libH1 = document.querySelector('#library-view .view-header h1');
  if (libH1) libH1.textContent = t.nav_library;
  attr('search-input', 'placeholder', t.search_placeholder);
  title('settings-open-btn', t.btn_settings);
  title('like-btn', t.btn_like);
  title('shuffle-btn', t.btn_shuffle);
  title('prev-btn', t.btn_prev);
  title('play-btn', t.btn_play);
  title('next-btn', t.btn_next);
  title('repeat-btn', t.btn_repeat);
  title('queue-btn', t.btn_queue);
  title('expand-btn', t.btn_expand);
  title('sidebar-toggle', t.sidebar_toggle);
  const perfNote = document.getElementById('perf-note');
  if (perfNote?.textContent) perfNote.textContent = t.perf_note_low;
  set('settings-viz-title', t.settings_viz);
  document.getElementById('viz-on-btn')?.classList.toggle('active',  vizEnabled);
  document.getElementById('viz-off-btn')?.classList.toggle('active', !vizEnabled);
  document.getElementById('viz-note').textContent = t.viz_note;
  document.getElementById('viz-on-btn').textContent  = t.viz_on;
  document.getElementById('viz-off-btn').textContent = t.viz_off;
  set('settings-close-title', t.settings_close);
  document.getElementById('close-tray-btn').textContent = t.close_tray;
  document.getElementById('close-quit-btn').textContent = t.close_quit;
  document.getElementById('close-note').textContent = closeToTray ? t.close_note_tray : t.close_note_quit;
  document.getElementById('close-tray-btn').classList.toggle('active',  closeToTray);
  document.getElementById('close-quit-btn').classList.toggle('active', !closeToTray);
  set('settings-glass-title', t.settings_glass);
  set('glass-black-btn', t.glass_black);
  set('glass-color-btn', t.glass_color);
  set('glass-clear-btn', t.glass_clear);
  set('settings-sleep-title', t.settings_sleep);
  set('sleep-off-btn', t.sleep_off);
  set('sleep-15-btn', t.sleep_15);
  set('sleep-30-btn', t.sleep_30);
  set('sleep-60-btn', t.sleep_60);
  set('settings-devices-title', t.settings_devices);
  set('queue-panel-h3', t.queue_header);
  set('npo-queue-header-label', t.queue_header);
  set('vinyl-queue-header-label', t.queue_header);
  set('stats-title-h1', t.stats_title);
  set('stats-tab-short', t.stats_short);
  set('stats-tab-medium', t.stats_medium);
  set('stats-tab-long', t.stats_long);
  set('nav-stats-label', t.nav_stats);
  setGreeting();
}

// ── Event Wiring ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Setup
  // Login
  document.getElementById('login-btn').addEventListener('click', async () => {
    showScreen('loading');
    try {
      accessToken = await window.electronAPI.login();
      await launchApp();
    } catch (e) {
      console.error('Login error:', e);
      showScreen('login');
    }
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', async () => {
    clearInterval(pollInterval);
    clearInterval(progressInterval);
    accessToken = null;
    activeDeviceId = null;
    await window.electronAPI.logout();
    showScreen('login');
  });

  // Nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const view = item.dataset.view;
      switchView(view);
      if (view === 'library') loadLibrary();
      if (view === 'stats') loadStats();
    });
  });

  // Player controls
  document.getElementById('play-btn').addEventListener('click', togglePlayPause);
  document.getElementById('prev-btn').addEventListener('click', skipPrev);
  document.getElementById('next-btn').addEventListener('click', skipNext);
  document.getElementById('like-btn').addEventListener('click', toggleLike);

  const doShuffle = async () => {
    shuffleActive = !shuffleActive;
    await api(`/me/player/shuffle?state=${shuffleActive}`, { method: 'PUT' });
    document.getElementById('shuffle-btn').classList.toggle('active', shuffleActive);
    document.getElementById('npo-shuffle-btn').classList.toggle('active', shuffleActive);
  };
  const reshuffleQueue = async () => {
    if (!shuffleActive) {
      shuffleActive = true;
      document.getElementById('shuffle-btn').classList.add('active');
      document.getElementById('npo-shuffle-btn').classList.add('active');
    }
    await api('/me/player/shuffle?state=false', { method: 'PUT' });
    await api('/me/player/shuffle?state=true', { method: 'PUT' });
    showToast(i18n[currentLang].toast_reshuffled);
    setTimeout(async () => {
      refreshQueueContent();
      const qData = await fetchFullQueue();
      if (qData) window.electronAPI.updateImmersiveQueue({ queue: buildImmersiveQueue(qData) });
    }, 900);
  };
  document.getElementById('shuffle-btn').addEventListener('click', doShuffle);
  document.getElementById('queue-reshuffle-btn').addEventListener('click', reshuffleQueue);

  document.getElementById('repeat-btn').addEventListener('click', async () => {
    repeatMode = (repeatMode + 1) % 3;
    const states = ['off', 'context', 'track'];
    await api(`/me/player/repeat?state=${states[repeatMode]}`, { method: 'PUT' });
    document.getElementById('repeat-btn').classList.toggle('active', repeatMode > 0);
    document.getElementById('repeat-icon').classList.toggle('hidden', repeatMode === 2);
    document.getElementById('repeat-one-icon').classList.toggle('hidden', repeatMode !== 2);
  });

  // Volume
  const volSlider = document.getElementById('volume-slider');
  let volTimer;
  volSlider.addEventListener('input', () => {
    volumeLevel = parseInt(volSlider.value);
    document.getElementById('volume-fill').style.width = volumeLevel + '%';
    document.getElementById('npo-volume-slider').value = volumeLevel;
    document.getElementById('vinyl-volume-slider').value = volumeLevel;
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      api(`/me/player/volume?volume_percent=${volumeLevel}`, { method: 'PUT' });
    }, 300);
  });

  // Mute
  let savedVol = 70;
  document.getElementById('mute-btn').addEventListener('click', () => {
    if (volumeLevel > 0) { savedVol = volumeLevel; volSlider.value = 0; }
    else volSlider.value = savedVol;
    volSlider.dispatchEvent(new Event('input'));
  });

  // Progress seek — shared drag logic for both bars
  function makeSeekable(barEl) {
    let dragging = false;
    const calcPos = (e) => {
      const rect = barEl.getBoundingClientRect();
      return Math.floor(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * currentDuration);
    };
    const applyPos = (pos) => {
      lastPollPos = pos; lastPollTime = Date.now();
      updateProgress(pos, currentDuration);
      if (lyricsLines.length) syncLyrics(pos);
    };
    barEl.addEventListener('mousedown', e => {
      dragging = true;
      clearInterval(progressInterval);
      applyPos(calcPos(e));
    });
    document.addEventListener('mousemove', e => { if (dragging) applyPos(calcPos(e)); });
    document.addEventListener('mouseup', async e => {
      if (!dragging) return;
      dragging = false;
      const pos = calcPos(e);
      applyPos(pos);
      await api(`/me/player/seek?position_ms=${pos}`, { method: 'PUT' });
      if (isPlaying) progressInterval = setInterval(() => {
        const p = lastPollPos + (Date.now() - lastPollTime);
        updateProgress(p, currentDuration);
        if (lyricsLines.length) syncLyrics(p);
      }, 150);
    });
  }

  // Progress seek — both bars support click and drag
  makeSeekable(document.getElementById('progress-bar'));
  makeSeekable(document.getElementById('npo-bar'));

  // NPO 3D tilt
  const npoEl = document.getElementById('npo');
  const artWrap = document.getElementById('npo-art-wrap');
  let npo3dTimeout = null;
  const reset3dTilt = () => {
    artWrap.style.transition = 'transform 0.8s cubic-bezier(0.34, 1.15, 0.64, 1)';
    artWrap.style.transform = '';
  };
  npoEl.addEventListener('mousemove', e => {
    if (!artWrap) return;
    const rect = artWrap.getBoundingClientRect();
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const dx = clamp((e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2), -1, 1);
    const dy = clamp((e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2), -1, 1);
    artWrap.style.transition = 'none';
    artWrap.style.transform = `perspective(700px) rotateY(${dx * 14}deg) rotateX(${-dy * 14}deg) scale(1.04)`;
    clearTimeout(npo3dTimeout);
    npo3dTimeout = setTimeout(reset3dTilt, 3000);
  });
  npoEl.addEventListener('mouseleave', () => {
    if (!artWrap) return;
    clearTimeout(npo3dTimeout);
    reset3dTilt();
  });

  // NPO button ripple
  function addRipple(id) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', e => {
      const r = document.createElement('span');
      r.className = 'npo-ripple';
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      r.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX-rect.left-size/2}px;top:${e.clientY-rect.top-size/2}px`;
      btn.appendChild(r);
      r.addEventListener('animationend', () => r.remove());
    });
  }
  ['npo-play-btn','npo-prev-btn','npo-next-btn','npo-shuffle-btn','npo-repeat-btn','npo-like-btn'].forEach(addRipple);

  // Immersive mode
  document.getElementById('immersive-btn').addEventListener('click', async () => {
    if (npoOpen) closeNPO();
    window.electronAPI.hideMiniPlayer();
    const trackArtUrl2 = document.getElementById('now-album-art').src || '';
    const title2 = document.getElementById('now-track-name').textContent;
    const artist2 = document.getElementById('now-artist-name').textContent;
    window.electronAPI.showImmersive({ title: title2, artist: artist2, artUrl: trackArtUrl2, isPlaying, duration_ms: currentDuration });
    if (lyricsLines.length) window.electronAPI.updateImmersiveLyrics({ lines: lyricsLines, idx: currentLyricIdx });
    const qData = await fetchFullQueue();
    if (qData) window.electronAPI.updateImmersiveQueue({ queue: buildImmersiveQueue(qData) });
  });
  window.electronAPI.onImmersiveAction(async type => {
    if (type === 'play-pause') togglePlayPause();
    else if (type === 'next') skipNext();
    else if (type === 'prev') skipPrev();
    else if (type.startsWith('seek:')) {
      const ms = parseInt(type.slice(5));
      api(`/me/player/seek?position_ms=${ms}`, { method: 'PUT' });
      lastPollPos = ms; lastPollTime = Date.now();
      updateProgress(ms, currentDuration);
    } else if (type.startsWith('volume:')) {
      const vol = parseInt(type.slice(7));
      volumeLevel = vol;
      document.getElementById('volume-fill').style.width = vol + '%';
      document.getElementById('volume-slider').value = vol;
      api(`/me/player/volume?volume_percent=${vol}`, { method: 'PUT' });
    } else if (type === 'shuffle') {
      shuffleActive = !shuffleActive;
      await api(`/me/player/shuffle?state=${shuffleActive}`, { method: 'PUT' });
      document.getElementById('shuffle-btn').classList.toggle('active', shuffleActive);
      document.getElementById('npo-shuffle-btn').classList.toggle('active', shuffleActive);
    } else if (type === 'repeat') {
      repeatMode = (repeatMode + 1) % 3;
      const states = ['off', 'context', 'track'];
      await api(`/me/player/repeat?state=${states[repeatMode]}`, { method: 'PUT' });
      document.getElementById('repeat-btn').classList.toggle('active', repeatMode > 0);
      document.getElementById('repeat-icon').classList.toggle('hidden', repeatMode === 2);
      document.getElementById('repeat-one-icon').classList.toggle('hidden', repeatMode !== 2);
    } else if (type === 'reshuffle') {
      reshuffleQueue();
    } else if (type.startsWith('play-uri:')) {
      playTrack(type.slice(9), currentContextUri || null);
      setTimeout(async () => {
        const qData = await fetchFullQueue();
        if (qData) window.electronAPI.updateImmersiveQueue({ queue: buildImmersiveQueue(qData) });
      }, 1500);
    }
  });

  // NPO open/close
  document.getElementById('now-album-art').addEventListener('click', openNPO);
  document.getElementById('expand-btn').addEventListener('click', () => window.electronAPI.toggleFullscreen());
  document.getElementById('queue-btn').addEventListener('click', toggleQueue);
  document.getElementById('queue-close-btn').addEventListener('click', () => {
    queueOpen = false;
    document.getElementById('queue-panel').classList.remove('open');
  });
  document.getElementById('vinyl-overlay-close').addEventListener('click', closeVinylOverlay);
  document.getElementById('npo-to-vinyl-btn').addEventListener('click', switchToVinyl);
  document.getElementById('vinyl-to-npo-btn').addEventListener('click', switchToNPO);
  // Tonearm click → toggle play/pause (lift off = pause, drop on = play)
  document.getElementById('vinyl-tonearm').addEventListener('click', togglePlayPause);
  // Prev/next navigation in vinyl overlay
  document.getElementById('vinyl-nav-prev').addEventListener('click', skipPrev);
  document.getElementById('vinyl-nav-next').addEventListener('click', skipNext);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeVinylOverlay(); closeAddToPlaylistModal(); }
    if (document.getElementById('vinyl-overlay')?.classList.contains('open')) {
      if (e.code === 'ArrowLeft') { e.preventDefault(); skipPrev(); }
      if (e.code === 'ArrowRight') { e.preventDefault(); skipNext(); }
    }
  });

  // NPO lyrics toggle
  document.getElementById('npo-lyrics-btn').addEventListener('click', async () => {
    lyricsVisible = !lyricsVisible;
    document.getElementById('npo-lyrics-btn').classList.toggle('active', lyricsVisible);
    document.getElementById('npo').classList.toggle('lyrics-open', lyricsVisible);
    if (lyricsVisible && currentTrackUri) {
      const state = await api('/me/player');
      if (state?.item) fetchLyrics(state.item);
    }
  });

  // Vinyl overlay lyrics toggle
  document.getElementById('vinyl-lyrics-btn').addEventListener('click', async () => {
    vinylLyricsVisible = !vinylLyricsVisible;
    document.getElementById('vinyl-lyrics-btn').classList.toggle('active', vinylLyricsVisible);
    document.getElementById('vinyl-overlay').classList.toggle('vinyl-lyrics-open', vinylLyricsVisible);
    if (vinylLyricsVisible && currentTrackUri) {
      const state = await api('/me/player');
      if (state?.item) fetchLyrics(state.item);
    }
  });

  // Add to playlist modal
  document.getElementById('add-playlist-close').addEventListener('click', closeAddToPlaylistModal);
  document.getElementById('add-playlist-backdrop').addEventListener('click', closeAddToPlaylistModal);
  document.getElementById('npo-close').addEventListener('click', closeNPO);
  document.getElementById('npo').addEventListener('click', e => {
    if (e.target === document.getElementById('npo') ||
        e.target === document.querySelector('.npo-scrim')) closeNPO();
  });

  // NPO controls
  document.getElementById('npo-play-btn').addEventListener('click', togglePlayPause);
  document.getElementById('npo-prev-btn').addEventListener('click', skipPrev);
  document.getElementById('npo-next-btn').addEventListener('click', skipNext);
  document.getElementById('npo-like-btn').addEventListener('click', toggleLike);
  document.getElementById('npo-shuffle-btn').addEventListener('click', doShuffle);
  document.getElementById('npo-repeat-btn').addEventListener('click', async () => {
    repeatMode = (repeatMode + 1) % 3;
    const states = ['off', 'context', 'track'];
    await api(`/me/player/repeat?state=${states[repeatMode]}`, { method: 'PUT' });
    document.getElementById('repeat-btn').classList.toggle('active', repeatMode > 0);
    document.getElementById('npo-repeat-btn').classList.toggle('active', repeatMode > 0);
    document.getElementById('repeat-icon').classList.toggle('hidden', repeatMode === 2);
    document.getElementById('repeat-one-icon').classList.toggle('hidden', repeatMode !== 2);
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (document.activeElement.tagName === 'INPUT') return;
    if (e.code === 'Escape' && npoOpen) { closeNPO(); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePlayPause(); }
    if (e.code === 'ArrowRight') { e.preventDefault(); skipNext(); }
    if (e.code === 'ArrowLeft') { e.preventDefault(); skipPrev(); }
  });

  // Viz mode buttons (only buttons with a numeric data-mode)
  document.querySelectorAll('.viz-mode-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const n = parseInt(btn.dataset.mode);
      if (!viz.ready) await initVisualizer();
      setVizMode(n);
      // Ensure viz is running on the correct canvas
      const vinylOpen = document.getElementById('vinyl-overlay')?.classList.contains('open');
      const targetId = vinylOpen ? 'vinyl-visualizer' : 'npo-visualizer';
      const targetCanvas = document.getElementById(targetId);
      if (targetCanvas && viz.canvas !== targetCanvas) {
        viz.canvas = targetCanvas;
        viz.ctx = targetCanvas.getContext('2d');
      }
      if (viz.ready) startViz();
    });
  });

  // Sidebar toggle
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  // ── Settings Panel ───────────────────────────────────────────
  function applyPerfMode(mode) {
    perfMode = mode;
    localStorage.setItem('perfMode', mode);
    document.getElementById('perf-high-btn').classList.toggle('active', mode === 'high');
    document.getElementById('perf-low-btn').classList.toggle('active', mode === 'low');
    document.getElementById('perf-note').textContent =
      mode === 'low' ? (i18n[currentLang]?.perf_note_low || '下次打开 NPO / 黑胶时生效') : '';
  }
  applyPerfMode(perfMode);
  applyLang(currentLang);

  document.getElementById('settings-open-btn').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.remove('hidden');
  });
  const closeSettings = () => document.getElementById('settings-panel').classList.add('hidden');
  document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
  document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
  document.getElementById('perf-high-btn').addEventListener('click', () => applyPerfMode('high'));
  document.getElementById('perf-low-btn').addEventListener('click', () => applyPerfMode('low'));
  document.getElementById('lang-zh-btn').addEventListener('click', () => applyLang('zh'));
  document.getElementById('lang-en-btn').addEventListener('click', () => applyLang('en'));

  function applyViz(enabled) {
    vizEnabled = enabled;
    localStorage.setItem('vizEnabled', enabled);
    document.getElementById('viz-on-btn').classList.toggle('active',  enabled);
    document.getElementById('viz-off-btn').classList.toggle('active', !enabled);
    if (!enabled) stopViz();
  }
  applyViz(vizEnabled);
  document.getElementById('viz-on-btn').addEventListener('click',  () => applyViz(true));
  document.getElementById('viz-off-btn').addEventListener('click', () => applyViz(false));


  function applyCloseBehavior(tray) {
    closeToTray = tray;
    window.electronAPI.setCloseBehavior(tray);
    const t = i18n[currentLang];
    document.getElementById('close-tray-btn').classList.toggle('active',  tray);
    document.getElementById('close-quit-btn').classList.toggle('active', !tray);
    document.getElementById('close-note').textContent = tray ? t.close_note_tray : t.close_note_quit;
  }
  window.electronAPI.getCloseBehavior().then(val => { closeToTray = val; applyLang(currentLang); });
  document.getElementById('close-tray-btn').addEventListener('click', () => applyCloseBehavior(true));
  document.getElementById('close-quit-btn').addEventListener('click', () => applyCloseBehavior(false));

  // Glass mode setting
  const glassModes = { 'glass-black-btn': 'black', 'glass-color-btn': 'color', 'glass-clear-btn': 'clear' };
  function applyGlassModeSetting(mode) {
    localStorage.setItem('glass-mode', mode);
    window.electronAPI.setImmersiveGlassMode(mode);
    Object.entries(glassModes).forEach(([id, m]) =>
      document.getElementById(id)?.classList.toggle('active', m === mode));
  }
  Object.entries(glassModes).forEach(([id, mode]) =>
    document.getElementById(id)?.addEventListener('click', () => applyGlassModeSetting(mode)));
  // init active state
  applyGlassModeSetting(localStorage.getItem('glass-mode') || 'black');

  // Mini player buttons — show mini player overlay window
  function triggerMiniPlayer() {
    if (!currentTrackUri) return;
    if (npoOpen) closeNPO();
    window.electronAPI.hideImmersive();
    window.electronAPI.showMiniPlayer({
      title:    document.getElementById('now-track-name')?.textContent || '—',
      artist:   document.getElementById('now-artist-name')?.textContent || '',
      artUrl:   currentArtUrl || '',
      isPlaying,
    });
  }
  document.getElementById('mini-player-bar-btn').addEventListener('click', triggerMiniPlayer);
  document.getElementById('npo-mini-btn').addEventListener('click', () => {
    closeNPO();
    triggerMiniPlayer();
  });

  // Mini player / tray / global hotkey actions — all share same handlers
  function handlePlayerAction(type) {
    if (type === 'play-pause') togglePlayPause();
    if (type === 'open-npo')   openNPO();
    if (type === 'prev')       skipPrev();
    if (type === 'next')       skipNext();
  }
  window.electronAPI.onMiniAction(handlePlayerAction);
  window.electronAPI.onTrayAction(handlePlayerAction);
  window.electronAPI.onHotkey(handlePlayerAction);

  // Auto-updater notifications
  window.electronAPI.onUpdateAvailable(() => {
    document.getElementById('update-bar').classList.remove('hidden');
    document.getElementById('update-bar-msg').textContent = currentLang === 'zh' ? '🔄 新版本下载中...' : '🔄 Downloading update...';
  });
  window.electronAPI.onUpdateDownloaded(() => {
    const bar = document.getElementById('update-bar');
    bar.classList.remove('hidden');
    document.getElementById('update-bar-msg').textContent = currentLang === 'zh' ? '✅ 新版本已就绪' : '✅ Update ready';
    document.getElementById('update-bar-btn').classList.remove('hidden');
  });
  document.getElementById('update-bar-btn')?.addEventListener('click', () => window.electronAPI.installUpdate());

  // Sleep timer
  document.getElementById('sleep-off-btn')?.addEventListener('click', () => setSleepTimer(0));
  document.getElementById('sleep-15-btn')?.addEventListener('click', () => setSleepTimer(15));
  document.getElementById('sleep-30-btn')?.addEventListener('click', () => setSleepTimer(30));
  document.getElementById('sleep-60-btn')?.addEventListener('click', () => setSleepTimer(60));

  // Device switcher
  document.getElementById('devices-refresh-btn')?.addEventListener('click', loadDevices);
  document.getElementById('settings-open-btn').addEventListener('click', loadDevices, { capture: true });

  // Stats tabs
  document.querySelectorAll('.stats-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      statsRange = tab.dataset.range;
      loadStats();
    });
  });

  // Fullscreen state feedback
  let isFsActive = false;
  function setFullscreenUI(active) {
    isFsActive = active;
    document.querySelector('.titlebar')?.classList.toggle('hidden', active);
    ['npo-fs-expand','vinyl-fs-expand'].forEach(id => document.getElementById(id)?.classList.toggle('hidden', active));
    ['npo-fs-shrink','vinyl-fs-shrink'].forEach(id => document.getElementById(id)?.classList.toggle('hidden', !active));
  }
  window.electronAPI.onFullscreenState(setFullscreenUI);
  document.getElementById('npo-fullscreen-btn')?.addEventListener('click', () => window.electronAPI.toggleFullscreen());
  document.getElementById('vinyl-fullscreen-btn')?.addEventListener('click', () => window.electronAPI.toggleFullscreen());

  // Embedded queue inside NPO
  let npoQueueOpen = false;
  async function toggleNPOQueue() {
    npoQueueOpen = !npoQueueOpen;
    document.getElementById('npo').classList.toggle('queue-open', npoQueueOpen);
    if (!npoQueueOpen) return;
    await loadQueueInto(document.getElementById('npo-queue-inner-list'), 'padding:16px 4px;');
  }
  document.getElementById('npo-queue-overlay-btn')?.addEventListener('click', toggleNPOQueue);
  document.getElementById('npo-queue-inner-close')?.addEventListener('click', () => {
    npoQueueOpen = false;
    document.getElementById('npo').classList.remove('queue-open');
  });

  // Embedded queue inside vinyl overlay
  let vinylQueueOpen = false;
  async function toggleVinylQueue() {
    vinylQueueOpen = !vinylQueueOpen;
    document.getElementById('vinyl-overlay').classList.toggle('vinyl-queue-open', vinylQueueOpen);
    if (!vinylQueueOpen) return;
    await loadQueueInto(document.getElementById('vinyl-queue-inner-list'), 'padding:16px 4px;');
  }
  document.getElementById('vinyl-queue-overlay-btn')?.addEventListener('click', toggleVinylQueue);
  document.getElementById('vinyl-queue-inner-close')?.addEventListener('click', () => {
    vinylQueueOpen = false;
    document.getElementById('vinyl-overlay').classList.remove('vinyl-queue-open');
  });

  // Volume in NPO and vinyl overlays (shared logic)
  let overlayVolTimer;
  function handleOverlayVolume(val) {
    volumeLevel = val;
    document.getElementById('volume-slider').value = val;
    document.getElementById('volume-fill').style.width = val + '%';
    document.getElementById('npo-volume-slider').value = val;
    document.getElementById('vinyl-volume-slider').value = val;
    clearTimeout(overlayVolTimer);
    overlayVolTimer = setTimeout(() => api(`/me/player/volume?volume_percent=${val}`, { method: 'PUT' }), 300);
  }
  let overlaySavedVol = 70;
  function handleOverlayMute() {
    if (volumeLevel > 0) { overlaySavedVol = volumeLevel; handleOverlayVolume(0); }
    else handleOverlayVolume(overlaySavedVol);
    const muted = volumeLevel === 0;
    ['npo','vinyl'].forEach(pfx => {
      document.getElementById(`${pfx}-vol-icon`)?.classList.toggle('hidden', muted);
      document.getElementById(`${pfx}-mute-icon`)?.classList.toggle('hidden', !muted);
    });
  }
  document.getElementById('npo-volume-slider')?.addEventListener('input', e => handleOverlayVolume(parseInt(e.target.value)));
  document.getElementById('vinyl-volume-slider')?.addEventListener('input', e => handleOverlayVolume(parseInt(e.target.value)));
  document.getElementById('npo-mute-btn')?.addEventListener('click', handleOverlayMute);
  document.getElementById('vinyl-mute-btn')?.addEventListener('click', handleOverlayMute);

  // Auto-hide controls + cursor after 3s idle in NPO / vinyl overlay
  (function setupOverlayIdleHide() {
    const IDLE_MS = 3000;
    const overlays = [
      document.getElementById('npo'),
      document.getElementById('vinyl-overlay'),
    ];
    let idleTimer = null;
    function resetIdle(el) {
      el.classList.remove('controls-idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => el.classList.add('controls-idle'), IDLE_MS);
    }
    overlays.forEach(el => {
      el.addEventListener('mousemove', () => {
        if (el.classList.contains('npo-open') || el.classList.contains('open')) resetIdle(el);
      });
      el.addEventListener('mouseleave', () => {
        clearTimeout(idleTimer);
        el.classList.remove('controls-idle');
      });
    });
  })();

  setupSearch();
  init();
});
