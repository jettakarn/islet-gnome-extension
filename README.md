# Islet

A native Dynamic Island clone for GNOME Shell (Wayland), inspired by the Ripple by TopMyster.

## Why Islet?
Unlike the original Electron-based implementation, **Islet** is built as a native GNOME Shell Extension using GJS and Clutter. This ensures:
- **Wayland Compatibility:** Stays permanently on top and interactive without focus issues.
- **High Performance:** Extremely low CPU and memory footprint compared to Chromium-based apps.
- **Deep Integration:** Native battery, clock, and media monitoring via D-Bus and UPower.

## Requirements
- GNOME Shell 45+
- `playerctl` (for media metadata and controls)

## Installation
1. Move the project folder to `~/.local/share/gnome-shell/extensions/islet@your_username`.
2. Restart GNOME (Log out and Log in).
3. Enable via the **Extensions** app.
