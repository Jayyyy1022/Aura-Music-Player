# Aura — Music Player

A desktop music player powered by Spotify Connect. Premium UI with floating mini player, lyrics sync, visualizer, and album color theming.

> Powered by Spotify

## Download

**[→ Download latest release](https://github.com/Jayyyy1022/Aura-Music-Player/releases/latest)**

1. Download `Aura-Setup.exe`
2. Run the installer
3. Launch Aura and log in with your Spotify account

That's it. No setup required.

## Requirements

- Windows 10 / 11 (64-bit)
- [Spotify](https://www.spotify.com/download/) installed and running
- Spotify Premium account

## Features

- Full playback control — play, pause, skip, shuffle, repeat
- Now Playing Overlay with album art, visualizer, and synced lyrics
- Vinyl turntable mode
- Floating mini player that stays above all windows
- Dynamic color theming from album art
- Language support: 中文 / English

## Notes

- Spotify must be open for playback to work (it launches automatically in the background)
- Lyrics depend on track availability via lrclib
- The visualizer uses screen audio capture — grant permission when prompted

---

## For developers

```bash
git clone https://github.com/Jayyyy1022/Aura-Music-Player.git
cd Aura-Music-Player
npm install
npm start
```

To build the installer:
```bash
npm run build
# Output: dist/Aura-Setup.exe
```
