# Islet

A native Dynamic Island–style peninsula for GNOME Shell on Wayland. Built as a GJS/Clutter extension (not Electron), so it stays interactive on top of the shell with a small footprint.

## Features

- **Peninsula island** — flush to the top bezel, expands on hover/click
- **Overview** — clock, date, weather, battery
- **Media card** — album art, title/artist, progress, prev / play-pause / next, and an output button that opens GNOME Sound settings
- **Shortcuts** — Term, Files, Calc, Browser
- **In-island settings** — temperature unit, 12/24h clock, auto-collapse, top position
- **Auto-collapse** when the pointer leaves the island, you click/tap outside it, or another window takes focus (optional)
- **Circular tab swipe** — scroll/swipe wraps Overview → Media → Shortcuts → Settings → Overview

## Requirements

- GNOME Shell **45+**
- [`playerctl`](https://github.com/altdesktop/playerctl) for media metadata and controls
- Network access for weather (IP geo + [Open-Meteo](https://open-meteo.com/))

## Install

UUID: `islet@jettakarn`

```bash
# From this repo
mkdir -p ~/.local/share/gnome-shell/extensions
rsync -a --delete \
  ./ ~/.local/share/gnome-shell/extensions/islet@jettakarn/ \
  --exclude .git --exclude .cursor

glib-compile-schemas ~/.local/share/gnome-shell/extensions/islet@jettakarn/schemas/
```

Then **log out and log in** (or restart GNOME Shell on Xorg with Alt+F2 → `r`), and enable **Islet** in the Extensions app / Extension Manager.

## Usage

| Action | Effect |
|--------|--------|
| Hover | Peek clock/battery or now-playing strip |
| Click | Expand / collapse the island |
| Scroll / swipe while expanded | Cycle tabs (wraps around) |
| Media → output icon | Opens **Settings → Sound** |
| Media → transport | `playerctl` previous / play-pause / next |

## Project layout

```
islet-gnome-extension/
  extension.js          # Extension class: island shell, hover, gestures, tabs
  stylesheet.css
  metadata.json
  LICENSE
  fonts/
  schemas/
  lib/
    constants.js        # Pads, sizes, tab count, intervals
    weather.js          # Soup + Open-Meteo / IP geo
    media.js            # playerctl, art, media card UI + progress
    settingsUi.js       # In-island settings rows
```

## License

See [LICENSE](LICENSE).
