# Assets

Place the following icon files here before building:

- `icon.icns` — macOS app icon (1024×1024 base, all sizes packed). Generate from TARX logo via iconutil.
- `tray-icon.png` — 22×22 (or @2x: 44×44) PNG for system tray. Use template image (black + alpha) if possible, or the programmatic dot fallback will be used.

## Generate icon.icns from a PNG

```bash
# Start with a 1024×1024 TARX logo PNG at /tmp/tarx-1024.png
mkdir /tmp/tarx.iconset
for size in 16 32 64 128 256 512; do
  sips -z $size $size /tmp/tarx-1024.png --out /tmp/tarx.iconset/icon_${size}x${size}.png
  sips -z $((size*2)) $((size*2)) /tmp/tarx-1024.png --out /tmp/tarx.iconset/icon_${size}x${size}@2x.png
done
iconutil -c icns /tmp/tarx.iconset -o assets/icon.icns
```
