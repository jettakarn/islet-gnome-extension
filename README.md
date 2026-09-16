# Islet

A native Dynamic Island–style peninsula for GNOME Shell on Wayland. Built as a GJS/Clutter extension (not Electron), so it stays interactive on top of the shell with a small footprint.

## Features

- **Peninsula island** — flush to the top bezel, expands on hover/click
- **Overview** — clock, date, weather, battery
- **Media card** — album art, title/artist, progress, prev / play-pause / next, and an output button that opens GNOME Sound settings
- **Now playing peek** — while music plays, the compact island shows album art on the left and an animated spectrum on the right (colors sampled from the cover)
- **Battery banners** — peninsula expands left/right (same style as hover) for ~3 seconds, then shrinks back:
  - **Charging** (green) when power is connected
  - **Low battery** (red) when level drops to **20%** or below while discharging (once per drop; resets after charging above 20%)
- **Experimental: fingerprint auth island** — when fprintd starts verification (lock unlock / Settings test), the island morphs into a rounded square with a mint scan frame, breathing green rim/edge, and fingerprint; success spins to a check, failure shakes; falls back to the default island on password / session end
- **Shortcuts** — Term, Files, Calc, Browser
- **In-island settings** — temperature unit, 12/24h clock
- **Auto-collapse** when the pointer leaves the island, you click/tap outside it, or another window takes focus (optional)
- **Circular tab swipe** — scroll/swipe wraps Overview → Media → Shortcuts → Settings → Overview

## Requirements

- GNOME Shell **45+**
- [`playerctl`](https://github.com/altdesktop/playerctl) for media metadata and controls
- Network access for weather (IP geo + [Open-Meteo](https://open-meteo.com/))
- Optional: `fprintd` (or compatible `open-fprintd`) + enrolled fingers for the experimental fingerprint island

## Experimental: fingerprint island

On devices with a fingerprint reader (e.g. ThinkPad T480), Islet listens **passively** to `net.reactivated.Fprint` `VerifyFingerSelected` / `VerifyStatus` (no Claim). When unlock or another app starts verification:

1. Island shrinks horizontally and grows into a square
2. Fingerprint + mint focus frame + green island edge breathe; thin green scan ring
3. **Match** → rim spin → green check → brief hold → default island
4. **No match** → fingerprint shakes, then returns to default (or when the lock UI switches to password)

GDM greeter login fingerprint is out of scope (runs outside the user session).

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
| Hover | Peek clock/battery, or album art + spectrum while playing |
| Click | Expand / collapse the island (playing → opens **Media** tab first) |
| Scroll / swipe while expanded | Cycle tabs (wraps around) |
| Plug in power | **Charging** banner (~3s), then default island |
| Battery ≤ 20% (on battery) | **Low Battery** banner (~3s), then default island |
| Fingerprint verify (lock / Settings) | Experimental square scan → check or shake |
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
    media.js            # playerctl, art, media card UI + spectrum + progress
    batteryBannerUi.js  # Charging / low-battery peninsula banners
    fingerprintAuth.js  # Passive fprintd Verify* monitor (experimental)
    fingerprintUi.js    # Auth square overlay + animations
    settingsUi.js       # In-island settings rows
```

## License

See [LICENSE](LICENSE).
