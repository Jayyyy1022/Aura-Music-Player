# Aura — Music Player

A desktop music player powered by Spotify Connect. Lets you control Spotify playback with a premium UI, floating mini player, lyrics sync, and visualizer.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Spotify Premium](https://www.spotify.com/premium/) account
- Spotify app installed and running on the same machine

## Setup

### 1. Get a Spotify Client ID

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Create a new app (any name)
3. In **Edit settings → Redirect URIs**, add: `http://127.0.0.1:8888/callback`
4. Copy the **Client ID**

### 2. Install and run

```bash
npm install
npm start
```

On first launch, paste your Client ID into the setup screen and connect your Spotify account.

## Features

- Full playback control (play, pause, skip, shuffle, repeat)
- Now Playing Overlay (NPO) with album art, visualizer, and lyrics
- Vinyl turntable mode
- Floating mini player — stays on top of all windows
- Lyrics sync via lrclib
- Album color extraction for dynamic theming
- Language support: 中文 / English

## Notes

- Spotify must be open and playing for Connect API to work
- Lyrics availability depends on the track
- Powered by Spotify
