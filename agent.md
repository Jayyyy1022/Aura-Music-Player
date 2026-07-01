# Aura Music Player — AI Agent Handoff and Project Specification

## 1. Purpose of this document

This file is the technical handoff specification for Aura Music Player. An AI agent taking over this repository should read it before modifying the application.

It describes:

- What the product is and is not.
- The process and file architecture.
- Runtime, authentication, playback, and UI data flows.
- Every major application capability and named function.
- IPC contracts between Electron processes.
- Spotify API usage and state ownership.
- Persistence and configuration behavior.
- Known implementation defects and technical risks.
- Project invariants and safe change guidelines.
- A verification checklist for future work.

This document describes version `0.3.0` as currently represented by the source. When implementation and this document diverge, inspect the source, establish the intended behavior, and update both together.

## 2. Product definition

Aura is a Windows Electron desktop music-player interface powered by Spotify Connect.

Aura is not an independent audio player. It does not download, decode, or output Spotify audio. The installed Spotify desktop application remains the playback device. Aura acts as:

- A Spotify OAuth client.
- A Spotify Web API playback remote.
- A library, playlist, search, artist, and statistics browser.
- A presentation layer for current playback.
- A synchronized lyrics client.
- A desktop integration layer with tray controls, hotkeys, mini player, immersive overlay, updates, and optional Discord Rich Presence.

### Product requirements

- Windows 10 or 11, x64.
- Spotify desktop installed and available as a Connect device.
- Spotify Premium for remote playback control.
- Internet access to Spotify APIs and LRCLIB.
- Screen/audio-loopback capture permission when using the visualizer.

### Major user experiences

1. Main library application.
2. Now Playing Overlay, abbreviated in the source as `NPO`.
3. Vinyl/turntable overlay.
4. Always-on-top mini player.
5. Transparent immersive desktop overlay.

## 3. Technology stack

- Electron `28.x`.
- Plain JavaScript, HTML, and CSS.
- No frontend framework.
- No TypeScript.
- No bundler or transpiler.
- `electron-builder` with an NSIS Windows target.
- `electron-updater` for GitHub release updates.
- `discord-rpc` for optional Discord activity.
- Native browser `fetch`, Web Audio API, Canvas API, and `localStorage`.
- Node.js APIs only in the Electron main process and preload scripts.

The renderer is intentionally isolated:

- `contextIsolation: true`
- `nodeIntegration: false`
- Main-process functionality is exposed only through preload bridges.

## 4. Repository map

```text
Aura-Music-Player/
├── package.json                 Runtime, scripts, installer, publish config
├── package-lock.json            Locked npm dependency graph
├── main.js                      Electron main process and all privileged work
├── preload.js                   Main-window IPC bridge
├── mini-preload.js              Mini-player IPC bridge
├── preload-immersive.js         Immersive-window IPC bridge
├── icon.ico                     Application, installer, and tray icon
├── README.md                    End-user and basic developer documentation
├── agent.md                     This AI-agent handoff specification
└── renderer/
    ├── index.html               Main application DOM and SVG controls
    ├── style.css                Main application, NPO, vinyl, settings styling
    ├── app.js                   Main renderer state and behavior
    ├── mini-player.html         Mini-player markup, CSS, and inline controller
    └── immersive.html           Immersive markup, CSS, and inline controller
```

### File ownership rules

- Put operating-system access, filesystem access, OAuth callback handling, process launching, and Electron window management in `main.js`.
- Put safe renderer-facing IPC methods in the relevant preload.
- Put primary application state and Spotify Web API orchestration in `renderer/app.js`.
- Put mini-player-only behavior in `renderer/mini-player.html`.
- Put immersive-overlay-only behavior in `renderer/immersive.html`.
- Put shared main-window visual styling in `renderer/style.css`.
- Do not enable Node integration in renderer windows to avoid bypassing the preload boundary.

## 5. Process architecture

```text
Spotify Accounts API ─────┐
Spotify Web API ──────────┼── main renderer (app.js)
LRCLIB ───────────────────┘           │
                                     │ window.electronAPI
                                     ▼
Electron preload.js ◄──────────── Electron main process (main.js)
                                     │
                    ┌────────────────┼─────────────────┐
                    ▼                ▼                 ▼
              mini player       immersive window   OS integrations
              miniAPI IPC       immersiveAPI IPC   tray/hotkeys/update/
                                                   Discord/Spotify process
```

The renderer calls the public Spotify Web API directly. The main process owns OAuth token exchange/refresh and proxies Spotify's private lyrics endpoint to avoid renderer CORS restrictions.

Audio always plays in Spotify, never inside an Aura `BrowserWindow`.

## 6. Startup and shutdown lifecycle

### Main-process startup

`app.whenReady()` performs the following work:

1. `loadConfig()` loads the bundled/custom Spotify client ID and close-to-tray preference.
2. `loadTokens()` loads the stored OAuth token set.
3. `createWindow()` creates the main frameless window.
4. `createMiniPlayerWindow()` creates the hidden always-on-top mini player.
5. `createTray()` creates the tray icon and initial menu.
6. `initDiscord()` initializes RPC only when an application ID is configured.
7. Global keyboard and media-key shortcuts are registered.
8. Auto-update checking begins.

The immersive window is lazy-created only when requested.

### Renderer startup

The `DOMContentLoaded` handler wires all UI events and then calls `init()`:

1. Show the loading screen.
2. Ask the main process for the saved access token.
3. Attempt a refresh if no access token is present.
4. Show login if neither succeeds.
5. Otherwise call `launchApp()`.

`launchApp()`:

- Shows the main app and player bar.
- Sets the greeting.
- Retrieves the current Spotify user to build the liked-songs collection URI.
- Loads sidebar playlists, home data, and liked-track IDs.
- Starts playback polling.
- Generates a runtime window icon.
- Launches Spotify in the background if necessary.

### Shutdown behavior

- By default, closing the main window hides it to the tray.
- If close-to-tray is disabled, or the user chooses Quit, the app destroys companion windows and exits.
- `will-quit` unregisters all global shortcuts and destroys Discord RPC.
- The tray Quit command sets `isQuitting` before calling `app.quit()`.

## 7. Main process specification (`main.js`)

### 7.1 Configuration and token functions

- `loadConfig()` reads `config.json`, applies `CLIENT_ID`, and restores `closeToTray`.
- `saveConfig()` writes the current config and close behavior.
- `saveTokens(data)` writes the OAuth token object to `tokens.json` in Electron's user-data directory.
- `loadTokens()` reads and parses the persisted OAuth token object.

The bundled Spotify client ID is used unless a saved client ID exists.

### 7.2 Window creation functions

- `createWindow()` creates the 1200×800 frameless primary window with a 900×600 minimum size.
- `createMiniPlayerWindow()` creates a transparent 340×62 resizable, movable, always-on-top window near the top center of the primary display.
- `createImmersiveWindow()` creates a full-primary-display transparent window that starts hidden, unfocused, and outside the taskbar.

The main window registers a display-media request handler that supplies the first screen source and system audio loopback to the visualizer.

### 7.3 OAuth

Aura uses Authorization Code with PKCE:

- Redirect URI: `http://127.0.0.1:8888/callback`
- A random `codeVerifier` is generated for each login.
- SHA-256 produces the URL-safe code challenge.
- A temporary local HTTP server receives the authorization code.
- `exchangeCode(code)` exchanges the code for tokens.
- The refresh handler obtains a new access token and preserves a replacement refresh token when Spotify returns one.
- Logout deletes `tokens.json`.

Requested scopes:

- `streaming`
- `user-read-email`
- `user-read-private`
- `user-library-read`
- `user-library-modify`
- `playlist-read-private`
- `playlist-read-collaborative`
- `playlist-modify-public`
- `playlist-modify-private`
- `user-read-playback-state`
- `user-modify-playback-state`
- `user-read-currently-playing`
- `user-top-read`
- `user-read-recently-played`

### 7.4 Tray, updater, hotkeys, and Discord

- `createTray()` creates the tray and toggles the main window on left click.
- `updateTrayMenu()` rebuilds the menu from current track state.
- `initDiscord()` registers and logs into Discord RPC when configured.
- Auto-updater events are forwarded to the main renderer.
- Update installation calls `autoUpdater.quitAndInstall()`.

Registered shortcuts:

- `CmdOrCtrl+Alt+Space` → play/pause.
- `CmdOrCtrl+Alt+Right` → next.
- `CmdOrCtrl+Alt+Left` → previous.
- `MediaPlayPause`.
- `MediaNextTrack`.
- `MediaPreviousTrack`.

### 7.5 Spotify process integration

- `findSpotifyExe()` checks `%APPDATA%\Spotify\Spotify.exe` and `%LOCALAPPDATA%\Spotify\Spotify.exe`.
- `isSpotifyRunning()` uses `tasklist` to detect `Spotify.exe`.
- `launch-spotify` starts Spotify when needed.
- A generated PowerShell script polls for Spotify's main window and hides it through `user32.dll` `ShowWindow`.

Possible launch results:

- `already_running`
- `launched`
- `not_found`

### 7.6 Lyrics proxy

`fetch-lyrics` requests:

```text
https://spclient.wg.spotify.com/color-lyrics/v2/track/{trackId}
```

It supplies the access token and `App-Platform: WebPlayer`, uses a five-second timeout, and returns `null` on failure.

## 8. IPC and preload contracts

Do not change a channel on only one side. A bridge method, renderer use, and `ipcMain` handler/listener form one contract.

### 8.1 Main-window `electronAPI`

| Method | Direction | Purpose |
|---|---|---|
| `getClientId()` | renderer → main invoke | Read current Spotify client ID |
| `saveClientId(id)` | renderer → main invoke | Persist a custom client ID |
| `getSavedToken()` | renderer → main invoke | Return saved access token |
| `login()` | renderer → main invoke | Run Spotify OAuth login |
| `refreshToken()` | renderer → main invoke | Refresh access token |
| `logout()` | renderer → main invoke | Delete saved tokens |
| `fetchLyrics(id, token)` | renderer → main invoke | Proxy private Spotify lyrics request |
| `launchSpotify()` | renderer → main invoke | Detect/start/hide Spotify |
| `minimize()` | renderer → main send | Minimize main window |
| `maximize()` | renderer → main send | Toggle maximize |
| `close()` | renderer → main send | Close or hide main window |
| `toggleFullscreen()` | renderer → main send | Toggle main-window fullscreen |
| `setAppIcon(dataUrl)` | renderer → main send | Set runtime-generated icon |
| `showMiniPlayer(data)` | renderer → main send | Update and show mini player |
| `hideMiniPlayer()` | renderer → main send | Hide mini player |
| `updateMiniPlayer(data)` | renderer → main send | Push current track state |
| `updateMiniLyric(text)` | renderer → main send | Push current synchronized lyric |
| `onMiniAction(cb)` | main → renderer listener | Receive mini-player commands |
| `onTrayAction(cb)` | main → renderer listener | Receive tray commands |
| `onHotkey(cb)` | main → renderer listener | Receive global shortcut commands |
| `onUpdateAvailable(cb)` | main → renderer listener | Show update-download status |
| `onUpdateDownloaded(cb)` | main → renderer listener | Show restart/install action |
| `installUpdate()` | renderer → main send | Install downloaded update |
| `updateTray(data)` | renderer → main send | Rebuild tray state |
| `updateDiscord(data)` | renderer → main send | Set Discord activity |
| `setCloseBehavior(value)` | renderer → main send | Persist close-to-tray preference |
| `getCloseBehavior()` | renderer → main invoke | Read close-to-tray preference |
| `showImmersive(data)` | renderer → main send | Create/update/show immersive overlay |
| `hideImmersive()` | renderer → main send | Hide immersive overlay |
| `updateImmersive(data)` | renderer → main send | Push track/play state |
| `updateImmersiveLyrics(data)` | renderer → main send | Push lyric lines and index |
| `updateImmersiveProgress(data)` | renderer → main send | Push progress and lyric index |
| `updateImmersiveQueue(data)` | renderer → main send | Push history and queue items |
| `setImmersiveGlassMode(mode)` | renderer → main send | Push glass mode |
| `onImmersiveAction(cb)` | main → renderer listener | Receive immersive commands |
| `onFullscreenState(cb)` | main → renderer listener | Receive fullscreen state changes |

The titlebar buttons in `index.html` call `electronAPI.minimize`, `maximize`, and `close` directly.

### 8.2 Mini-player `miniAPI`

- `onUpdate(callback)` receives `{ title, artist, artUrl, isPlaying }`.
- `onLyric(callback)` receives the current lyric string.
- `action(type)` emits `prev`, `play-pause`, `next`, `open-npo`, or `dismiss`.

### 8.3 Immersive `immersiveAPI`

- `onUpdate(callback)` receives track metadata and playback state.
- `onLyrics(callback)` receives `{ lines, idx }`.
- `onProgress(callback)` receives `{ ms, idx }`.
- `onQueue(callback)` receives the immersive queue model.
- `action(type)` sends playback/action strings.
- `close()` asks the main process to close immersive mode.
- `setMouseIgnore(value)` toggles click-through behavior.
- `onGlassMode(callback)` receives glass-mode changes.

Immersive action strings include:

- `play-pause`
- `prev`
- `next`
- `shuffle`
- `repeat`
- `reshuffle`
- `seek:{milliseconds}`
- `volume:{0-100}`
- `play-uri:{spotifyUri}`
- `focus-main`
- `close-immersive`

## 9. Main renderer state model (`renderer/app.js`)

The file is intentionally stateful and uses module-level variables rather than a framework store.

### 9.1 Authentication and playback state

- `accessToken`
- `activeDeviceId`
- `currentTrackUri`
- `currentContextUri`
- `currentDuration`
- `isPlaying`
- `shuffleActive`
- `repeatMode`: `0=off`, `1=context`, `2=track`
- `volumeLevel`
- `lastPollPos`
- `lastPollTime`

### 9.2 Polling state

- `pollInterval`: Spotify state refresh every three seconds.
- `progressInterval`: client-side progress interpolation every 150 ms.
- `rateLimitedUntil`: global Spotify API cooldown timestamp.
- `tokenRefreshPromise`: prevents parallel token-refresh requests.

### 9.3 Library and queue state

- `likedTrackIds`
- `likedCollectionUri`
- `cachedMyPlaylists`
- `cachedMyPlaylistsAt`
- `cachedPlaylistTracks`
- `cachedPlaylistUri`
- `playlistViewMode`
- `queueOpen`
- `immersivePlayHistory`
- `lastTrackInfo`

### 9.4 Lyrics state

- `lyricsLines`: `{ time, text }[]`, with time in seconds.
- `currentLyricIdx`
- `lyricsTrackId`
- `lyricsGen`: invalidates stale asynchronous lyric responses.
- `lyricsVisible`
- `vinylLyricsVisible`

### 9.5 Visual state

- `currentArtUrl`
- `npoOpen`
- `viz`: analyser, data buffers, canvases, frame, capture stream, and audio context.
- `vizMode`: `1=bars`, `2=vortex`.
- `cachedAccentRgb`
- `perfMode`: `high` or `low`.
- `vizEnabled`
- `vinylPrevArt`
- `vinylNextArt`

### 9.6 Settings and timers

- `currentLang`: `zh` or `en`.
- `closeToTray`
- `sleepTimerId`
- `sleepTimerEnd`
- `sleepNoteInterval`
- `statsRange`: `short_term`, `medium_term`, or `long_term`.

## 10. Spotify API wrapper behavior

`api(endpoint, options)` prefixes requests with `https://api.spotify.com/v1` and supplies bearer authorization and JSON content type.

Response behavior:

- Before a request, skip immediately during a known rate-limit cooldown.
- On `401`, refresh once and retry with the new token.
- If refresh fails, return to login.
- On `429`, honor `Retry-After`, capped at 90 seconds.
- On `202` or `204`, return `null` because no JSON body exists.
- On `403`, return `{ __forbidden: true }` for callers that need a distinct state.
- On other non-success responses, log a warning and return `null`.
- On success, return parsed JSON or `null` when the response has no valid JSON.

Do not assume `null` always means failure: successful Spotify playback commands commonly return `204` and therefore resolve to `null`.

## 11. Playback synchronization

`startPolling()` calls `pollPlayback()` immediately and every three seconds.

`pollPlayback()` is the central state synchronizer. It:

- Reads `/me/player`.
- Updates track, duration, device, context, play, shuffle, repeat, and volume state.
- Maintains a five-item immersive playback history.
- Updates album art, dynamic theme, hero, player bar, NPO, and vinyl state.
- Pushes metadata to mini player, immersive mode, tray, and Discord.
- Starts or stops progress interpolation.
- Synchronizes lyrics.
- Updates liked-state buttons.
- Marks the active track in lists, shelves, and vinyl walls.
- Refreshes queue displays on track changes.
- Fetches new lyrics on track changes.
- Updates vinyl navigation art.

`updateProgress()` updates both the normal and NPO progress displays. The interpolated timer also sends immersive progress at 150 ms intervals.

## 12. Complete renderer function catalog

### 12.1 Initialization, API, and devices

- `buildImmersiveQueue(qData)`: combine five-track local history, current track, and upcoming queue into immersive cards.
- `refreshAccessToken()`: deduplicated bridge call for token refresh.
- `api(endpoint, options)`: Spotify API wrapper described above.
- `showScreen(name)`: switch login, loading, and app screens.
- `init()`: restore authentication and choose app/login.
- `launchApp()`: start user-data loading, polling, icon generation, and Spotify launch.
- `setGreeting()`: select localized greeting from current hour.
- `ensureDevice()`: return active/first device or wait for Spotify.
- `waitForSpotifyDevice()`: launch Spotify and poll devices for up to 15 seconds.

### 12.2 Playback

- `playTrack(uri, contextUri)`: play a track alone or at an offset within a context.
- `playContext(contextUri)`: start an entire Spotify context.
- `togglePlayPause()`: pause or resume on the active device.
- `exitTrackAnim(dir)`: animate old metadata/art out before skipping.
- `enterTrackAnim(dir)`: animate new metadata/art in.
- `skipNext()` / `skipPrev()`: issue skip commands and schedule a state refresh.
- `startPolling()`: create the three-second player-state loop.
- `pollPlayback()`: central synchronization function.
- `updateProgress(pos, dur)`: update progress bars and timestamps.
- `msToTime(ms)`: format milliseconds as `m:ss`.

### 12.3 Dynamic visuals and visualizer

- `extractColor(imgEl)`: average non-extreme album-art pixels.
- `applyDynamicColor(r, g, b)`: set accent variables and background/player gradients.
- `updateBgBlur(imgUrl)`: debounce blurred background replacement.
- `initVisualizer()`: request system capture and initialize Web Audio analyser state.
- `setVizMode(n)`: select bars or vortex and initialize particles.
- `startViz()`: bind to the correct canvas and begin animation.
- `stopViz()`: cancel animation and release stream/audio resources.
- `getArtBounds()`: calculate NPO artwork center/radius; currently unused.
- `detectBeat(data)`: detect strong bass transients.
- `drawViz()`: FPS-limited animation-frame loop.
- `drawModeBar(...)`: draw the 64-bar frequency visualizer.
- `drawModeVortex(...)`: draw rotating reactive particles and beat rings.
- `spawnOrbs(containerId)`: generate performance-sensitive ambient blobs.

### 12.4 NPO, home, search, and library

- `openNPO()` / `closeNPO()`: show/hide the Now Playing Overlay and manage visualizer resources.
- `fetchMyPlaylists(forceRefresh)`: retrieve all playlist pages with a five-minute cache.
- `loadSidebar()`: render liked songs and playlists.
- `loadHome()`: start recent and liked loading.
- `loadRecent()`: render up to eight unique recently played tracks.
- `loadLiked()`: render the home liked-songs card and count.
- `loadLikedIds()`: paginate liked tracks into an ID set.
- `setupSearch()`: debounce search input by 380 ms.
- `doSearch(q)`: query and render Spotify search results.
- `loadLibrary(forceRefresh)`: render liked songs and playlist cards.
- `openPlaylist(id)`: fetch playlist metadata/tracks, paginate, and render selected layout.
- `openLikedSongs()`: paginate and render the complete liked collection.
- `renderTrackShelf(...)`: render responsive bookshelves, derive spine colors, and show hover popups.

### 12.5 Lyrics

- `parseLRC(lrc)`: parse `[mm:ss.xx]text` lines and sort by time.
- `fetchLyrics(track)`: fetch Spotify lyrics, then parallel LRCLIB fallbacks, while rejecting stale results.
- `renderLyricsPanel()`: render NPO/vinyl lines and send immersive lyrics.
- `syncLyrics(posMs)`: choose and highlight the current synchronized line with 350 ms look-ahead.

### 12.6 Playlists and vinyl

- `openAddToPlaylistModal(trackUri)`: list playlists and add the selected track.
- `closeAddToPlaylistModal()`: hide the add modal.
- `renderVinylShelf(...)`: display tracks as sleeves and records.
- `openVinylOverlay(...)`: optionally play a track and open turntable presentation.
- `switchToVinyl()` / `switchToNPO()`: move between the two presentation modes.
- `closeVinylOverlay()`: close vinyl, reset lyrics/tonearm, and restore visualizer canvas ownership.

### 12.7 Rendering, artists, navigation, and likes

- `cardHTML(track)`: produce a standard track card.
- `trackListHTML(tracks, contextUri)`: produce track-table markup and add buttons.
- `bindCardClicks(container)`: bind card play buttons.
- `bindTrackRows(container, contextUri)`: bind track playback and add-to-playlist actions.
- `openArtist(id)`: retrieve artist profile, top tracks, and releases.
- `switchView(name)`: select a main content view and reset scroll.
- `toggleLike()`: add/remove current track from the user's saved tracks.
- `showToast(msg)`: show one temporary notification.
- `esc(s)`: escape text interpolated into generated HTML.

### 12.8 Queue, sleep, devices, and statistics

- `renderQueueItems(items, listEl)`: render queue rows and bind future-track playback.
- `fetchFullQueue()`: extend Spotify's limited queue with known context tracks.
- `loadQueueInto(listEl, padStyle)`: render loading, error, empty, or queue content.
- `refreshQueueContent()`: refresh open queue and next vinyl art.
- `toggleQueue()`: open/close the main queue panel.
- `generateAppIcon()`: draw a headphone icon and send it to Electron.
- `setSleepTimer(minutes)`: manage countdown and pause playback on expiry.
- `loadDevices()`: list Connect devices and transfer playback.
- `loadStats()`: render top artists and tracks for the selected range.
- `applyLang(lang)`: persist language and update translated static UI.

### 12.9 DOM-local helpers

The `DOMContentLoaded` controller additionally defines:

- `doShuffle()`.
- `reshuffleQueue()`.
- `makeSeekable(barEl)` with `calcPos` and `applyPos` helpers.
- `reset3dTilt()`.
- `addRipple(id)`.
- `applyPerfMode(mode)`.
- `closeSettings()`.
- `applyViz(enabled)`.
- `applyCloseBehavior(tray)`.
- `applyGlassModeSetting(mode)`.
- `triggerMiniPlayer()`.
- `handlePlayerAction(type)`.
- `setFullscreenUI(active)`.
- `toggleNPOQueue()`.
- `toggleVinylQueue()`.
- `handleOverlayVolume(val)`.
- `handleOverlayMute()`.
- `setupOverlayIdleHide()` and `resetIdle(el)`.

These helpers are private to event wiring and should remain there unless behavior is reused elsewhere.

## 13. Main UI specification (`renderer/index.html`)

### Screens

- Splash screen: animated bars, removed after approximately 3.3 seconds.
- Login screen: begins Spotify authorization.
- Loading screen.
- Main application shell.

### Main views

- Home.
- Search.
- Library.
- Playlist/liked-song detail.
- Artist detail.
- Statistics.

### Persistent player bar

- Current artwork, title, and artist.
- Like.
- Shuffle.
- Previous.
- Play/pause.
- Next.
- Repeat.
- Seek bar and timestamps.
- Mute and volume.
- Queue.
- Mini player.
- Immersive overlay.
- Fullscreen.

### Panels and overlays

- NPO.
- Vinyl overlay.
- Add-to-playlist modal.
- Main queue side panel.
- Settings panel.
- Update notification bar.
- Bookshelf hover popup.

## 14. Playlist view modes

`playlistViewMode` is shared between normal playlists and liked songs:

- `list`: conventional rows.
- `shelf`: responsive book spines grouped into shelves.
- `vinyl`: album sleeves and partially exposed records.

Switching modes rerenders the same cached track array. Shelf mode owns a `ResizeObserver`; disconnect it before leaving shelf mode to prevent unnecessary rerenders.

Playlist tracks are paginated until `next` is empty. The implementation accepts Spotify response items using either `item` or `track` to tolerate endpoint shape differences.

## 15. Queue model

Spotify's queue endpoint usually returns a limited number of items. `fetchFullQueue()` extends it using `currentContextUri`:

- Reuse cached tracks when the current playlist/liked collection is already loaded.
- Fetch all pages for a Spotify playlist context.
- Fetch all pages for an album context.
- Reuse cached liked-song tracks for the current user's collection.
- With shuffle enabled, preserve Spotify's real returned shuffle prefix and append unseen context tracks.
- Without shuffle, slice the context after the current URI.

The immersive queue prepends up to five locally observed history items, followed by current and future tracks.

## 16. Lyrics model

`fetchLyrics(track)` uses a generation counter to prevent an old request from overwriting lyrics after the song changes.

Resolution order:

1. Spotify private line-synchronized lyrics through IPC.
2. LRCLIB exact request with artist, title, album, and duration.
3. LRCLIB request with artist and title.
4. LRCLIB free-text search.

All three LRCLIB requests are made concurrently. Synchronized lyrics are preferred over plain lyrics, and exact results are preferred over loose results.

Track titles are normalized by removing common remaster, radio-edit, single-version, and live suffixes.

Synchronized items use seconds. Plain lyrics use `time: -1` and are rendered without time-following behavior.

## 17. Visualizer model

The renderer requests `getDisplayMedia()` with audio and a minimal video stream. The main process supplies screen video plus loopback system audio.

The analyser uses:

- FFT size: 256.
- Smoothing: 0.82.
- Frequency bins stored in a `Uint8Array`.

Modes:

- Bars: 64 frequency bars with album-accent gradient and optional glow.
- Vortex: up to 500 particles, bass-reactive depth, and rings on detected beats.

Performance mode controls frame rate and effect density:

- `high`: 60 FPS and full effects.
- `low`: 30 FPS, fewer ambient orbs, and reduced shadows.

The visualizer must release stream tracks and close the audio context when it is truly no longer needed. If pause/resume behavior is changed, distinguish stopping animation from destroying capture resources.

## 18. Mini-player specification

The mini player is an independent renderer with inline CSS and JavaScript.

Behavior:

- Receives track state only through `miniAPI`.
- Extracts a saturated/average blend from artwork for background colors.
- Shows the artist when no synchronized lyric is available.
- Crossfades the artist/lyric subtitle on lyric changes.
- Clicking artwork or metadata opens NPO in the main window.
- Controls send actions back to the main renderer via the main process.
- Dismiss hides the window without affecting playback.

Named function:

- `applyColor(img)`: calculate accent and dark background RGB values.

## 19. Immersive-overlay specification

The immersive window covers the primary display but is transparent. It contains three movable widgets:

1. Glass playback controls.
2. Frameless single-line lyrics.
3. Frameless vertical queue/history coverflow.

### Named functions

- `el(id)`: DOM lookup helper.
- `esc(s)`: basic HTML escaping helper.
- `fmt(ms)`: format time.
- `applyGlassMode()`: apply black, dynamic-color, or clear glass.
- `setAccent(r, g, b)`: update overlay accent.
- `extractColor(img)`: choose the most saturated usable artwork color.
- `setPlay(value)`: update play/pause icons.
- `updateProg()`: update immersive progress.
- `showLyricLine()`: fade between current lyric strings.
- `getCfT(pos)`: calculate coverflow transform for relative positions -2 through 2.
- `buildCf(items)`: construct coverflow cards and interactions.
- `applyCf()`: apply transforms and metadata for the selected card.
- `resetSnap()`: return carousel selection to playing track after five seconds.
- `makeDrag(handle, widget)`: implement drag and persisted position.
- `initPos()`: restore valid positions or use display-relative defaults.

### Mouse pass-through

The main process initially ignores mouse events and forwards them. Immersive JavaScript checks whether the pointer is over a widget or carousel item and temporarily disables ignore mode. Preserve this behavior when changing widget class names.

### Position persistence

Positions are stored under:

- `wp3-cw`
- `wp3-lw`
- `wp3-qw`

Saved positions outside the current screen bounds are discarded.

## 20. Settings and persistence

### Electron filesystem persistence

- OAuth tokens: `{userData}/tokens.json`.
- Intended configuration: `config.json` containing `CLIENT_ID` and `closeToTray`.

### Main renderer `localStorage`

- `perfMode`: `high` or `low`.
- `lang`: `zh` or `en`.
- `vizEnabled`: boolean-like string.
- `glass-mode`: `black`, `color`, or `clear`.

### Immersive `localStorage`

- `glass-mode`.
- `wp3-{widgetId}` position records.

The main and immersive windows have separate renderer contexts. Glass-mode changes are therefore also propagated through IPC.

## 21. Localization

The primary translation dictionary lives in `renderer/app.js` under `i18n.zh` and `i18n.en`.

When adding visible main-window text:

1. Add keys to both languages.
2. Use `i18n[currentLang]` for dynamically generated content.
3. Update `applyLang()` for persistent static DOM text.
4. Check NPO, vinyl, queue, settings, and statistics.
5. Inspect mini and immersive inline strings, which do not currently share the main dictionary.

Language changes do not automatically rerender every already-generated view. If a feature requires complete live translation, explicitly reload or rerender the current data view.

## 22. External API inventory

### Spotify Accounts

- `POST https://accounts.spotify.com/api/token`
- Authorization URL at `https://accounts.spotify.com/authorize`

### Spotify Web API

Authentication/profile:

- `/me`

Playback:

- `/me/player`
- `/me/player/devices`
- `/me/player/play`
- `/me/player/pause`
- `/me/player/next`
- `/me/player/previous`
- `/me/player/seek`
- `/me/player/volume`
- `/me/player/shuffle`
- `/me/player/repeat`
- `/me/player/queue`

Library/discovery:

- `/me/player/recently-played`
- `/me/tracks`
- `/me/playlists`
- `/search`
- `/playlists/{id}`
- `/playlists/{id}/items`
- `/playlists/{id}/tracks`
- `/albums/{id}/tracks`
- `/artists/{id}`
- `/artists/{id}/top-tracks`
- `/artists/{id}/albums`
- `/me/top/tracks`
- `/me/top/artists`

### Spotify private endpoint

- `spclient.wg.spotify.com/color-lyrics/v2/track/{id}`

### LRCLIB

- `/api/get`
- `/api/search`

## 23. Project invariants

Future agents should preserve these unless the requested change explicitly replaces them:

1. Spotify owns audio playback; Aura remains a Connect controller.
2. Renderer windows do not gain Node integration.
3. Privileged behavior crosses an explicit preload bridge.
4. One main renderer remains the authoritative playback/UI state owner.
5. Companion windows send actions back rather than calling Spotify directly.
6. Successful `204` Spotify commands are not treated as failures.
7. Pagination continues until Spotify returns no `next` URL.
8. Generated user/API text is escaped before insertion into `innerHTML`.
9. Track/context URIs are kept distinct: a track URI is not interchangeable with playlist or album context URI.
10. Queue and lyrics updates tolerate stale or unavailable external data.
11. Visualizer capture must be explicitly released when no longer used.
12. All user-facing text additions account for both Chinese and English.
13. Existing user changes in a dirty worktree must not be overwritten.

## 24. Known defects and technical risks

These are current implementation findings, not desired behavior.

### 24.1 Critical/high-priority defects

#### Immersive preload omitted from installer file list

`main.js` loads `preload-immersive.js`, but `package.json > build.files` does not explicitly include it. Development mode can work while the packaged immersive window fails to obtain `window.immersiveAPI`.

Required correction: include `preload-immersive.js` in the packaged files and verify the installed build.

#### Artist release actions use incorrect API paths

Artist album cards call `openPlaylist(albumId)`, which requests `/playlists/{id}`. Their play buttons pass an album URI into `playTrack()`, which builds a `uris` array intended for track URIs.

Required correction:

- Add an album-detail path using `/albums/{id}` and `/albums/{id}/tracks`, or a generic context-detail function.
- Use `playContext(albumUri)` for album playback.

#### Visualizer resource lifecycle breaks resume paths

`stopViz()` destroys the capture stream and analyser. Pausing playback while an overlay is open calls `stopViz()`, but resuming calls only `startViz()`, which returns when no analyser exists.

Vinyl mode similarly starts only if `viz.ready` already exists; switching from NPO first closes NPO and destroys the capture.

Required correction: separate `pauseVizAnimation()` from `destroyVisualizer()`, or ensure every resume/open path awaits `initVisualizer()`.

#### Configuration path is unsuitable for packaged ASAR writes

`CONFIG_PATH` uses `path.join(__dirname, 'config.json')`. In a packaged Electron application `__dirname` normally points inside `app.asar`, which is read-only.

Effects can include:

- Close behavior not persisting.
- Custom client-ID save failing.

Required correction: store mutable config under `app.getPath('userData')`, with optional migration from a legacy development config.

### 24.2 Functional gaps

- Search requests `album` results but does not render `data.albums.items`.
- Discord Rich Presence is disabled because `DISCORD_CLIENT_ID` is empty.
- `getClientId()` and `saveClientId()` are exposed but no current settings UI uses them.
- `getArtBounds()` is currently dead code.
- Some strings remain hard-coded in Chinese or are not refreshed after a language switch.
- The immersive window is created `focusable: false`; Escape-key closure may not be reachable in normal use.
- Hiding all immersive widgets can leave no obvious in-overlay recovery control.

### 24.3 Reliability and security risks

- Tokens are stored as plaintext JSON rather than OS-protected credentials.
- The Spotify private lyrics endpoint is undocumented and may change without notice.
- `process.on('unhandledRejection', () => {})` suppresses useful diagnostics.
- Playlist descriptions are interpolated into HTML without calling `esc()`.
- Many caught errors are silently ignored, which makes production failures difficult to diagnose.
- `fetchMyPlaylists()` returns an empty result object after certain failures, which can make quota/network errors look like an empty library.
- The code has no automated tests, linting, formatting, or type checking.

## 25. Development workflow

Install and run:

```powershell
npm install
npm start
```

Build the NSIS installer:

```powershell
npm run build
```

Expected output is under `dist/`.

### Current npm scripts

- `npm start` → `electron .`
- `npm run build` → `electron-builder`

There is currently no `test`, `lint`, or `typecheck` script.

### Useful syntax checks

```powershell
node --check main.js
node --check preload.js
node --check mini-preload.js
node --check preload-immersive.js
node --check renderer/app.js
```

Inline scripts in the two HTML files are not covered by those commands and require application smoke testing or extraction into dedicated files.

## 26. Change guidance for future agents

### Adding a new Spotify operation

1. Confirm the correct endpoint, HTTP method, body, scope, and response semantics.
2. Add or reuse a function in `renderer/app.js`.
3. Use `api()` unless CORS, secrets, or privileged behavior require main-process proxying.
4. Account for `null` on successful `204` responses.
5. Update visible state optimistically only when rollback behavior is acceptable.
6. Schedule `pollPlayback()` when authoritative state must be refreshed.

### Adding a new companion-window action

1. Add a UI event in the companion HTML.
2. Send a stable action string through its preload API.
3. Route it through `main.js`.
4. Handle it in the authoritative main renderer.
5. Push resulting state back to all open surfaces.

### Adding a new IPC method

1. Define the `ipcMain.on` or `ipcMain.handle` side.
2. Expose the minimum required method in the correct preload.
3. Use `invoke/handle` only when a return value or awaited result is required.
4. Validate input in the main process for filesystem/process-sensitive operations.
5. Do not expose raw `ipcRenderer` to a renderer.

### Adding a new setting

1. Choose persistence owner: main-process user-data config or renderer `localStorage`.
2. Add controls to `index.html` and styling to `style.css`.
3. Add both language strings.
4. Initialize before normal UI interaction.
5. Apply changes to already-open companion windows through IPC if needed.

### Modifying generated HTML

- Escape user/profile/Spotify text with `esc()`.
- Do not escape trusted markup templates themselves.
- Bind events after assigning `innerHTML`.
- Rebind after every rerender.
- Avoid relying on duplicate IDs across simultaneously visible surfaces.

### Modifying visualizer behavior

- Test play, pause, resume, track changes, NPO close/reopen, vinyl direct open, NPO-to-vinyl, and visualizer disabled/enabled.
- Ensure only one animation frame loop is active.
- Ensure old media tracks are stopped when capture is destroyed.
- Preserve low-performance mode.

## 27. Verification checklist

### Authentication

- Fresh login opens the browser and returns to Aura.
- Restart restores login.
- Expired access token refreshes transparently.
- Logout removes local authentication.

### Spotify/device behavior

- Spotify is detected when already running.
- Spotify launches when stopped.
- Missing Spotify shows a useful notification.
- Aura selects an active or available device.
- Device transfer preserves the intended playback state.

### Playback controls

- Play/pause, previous, next.
- Seek while playing and paused.
- Volume, mute, and volume restore.
- Shuffle and reshuffle.
- Repeat off/context/track.
- Like/unlike.
- Sleep timer expiry.

### Data views

- Home recent and liked data.
- Search tracks, artists, playlists, and expected album behavior.
- Library and sidebar pagination.
- Playlist pagination.
- Liked-song pagination.
- List, shelf, and vinyl modes.
- Add to playlist.
- Artist profile, top tracks, albums, and singles.
- All three statistics ranges.

### Queue and lyrics

- Queue from playlist, album, liked songs, and standalone playback.
- Shuffle queue preserves Spotify prefix.
- Queue updates on track changes.
- Spotify-synced lyrics.
- LRCLIB fallback.
- Plain unsynchronized lyrics.
- Rapid skipping does not show stale lyrics.

### Presentation surfaces

- NPO open/close and controls.
- Visualizer first start, pause/resume, and reopen.
- Vinyl direct open and NPO/vinyl switching.
- Mini player controls and lyric updates.
- Immersive controls, carousel, lyric, click-through, dragging, and position restore.
- Main fullscreen state icons.

### Desktop integration

- Tray state and actions.
- Close-to-tray and quit-on-close.
- Global shortcuts and media keys.
- Update available/downloaded UI in a packaged build.
- Discord activity when a valid application ID is configured.

### Packaging

- Installer contains every preload.
- All renderer files and icon load from the installed app.
- Mutable configuration writes to user data, not ASAR.
- Auto-updater points to the intended GitHub repository.

## 28. Recommended repair order

When no feature request takes priority, address technical debt in this order:

1. Add `preload-immersive.js` to packaged files.
2. Move mutable config to the Electron user-data directory.
3. Correct artist album detail and playback routing.
4. Split visualizer pause from capture destruction.
5. Escape playlist descriptions and improve error reporting.
6. Render album search results.
7. Improve complete live localization.
8. Add tests around pure helpers and mocked Spotify API behavior.
9. Add linting/type checking or migrate incrementally to TypeScript.
10. Consider OS credential storage for refresh tokens.

## 29. Definition of done for future work

A change is complete when:

- The requested behavior works in the relevant UI surfaces.
- Main, preload, and renderer contracts remain synchronized.
- Existing playback behavior is not regressed.
- New visible strings support Chinese and English.
- Mutable state is persisted in the correct location.
- Generated external text is escaped.
- Standalone JavaScript files pass syntax checks.
- Relevant items from the verification checklist have been exercised.
- Packaged-only behavior is verified with `electron-builder` when the change affects files, preload paths, updater, resources, or configuration.
- `README.md` and this file are updated when product behavior or architecture changes.

