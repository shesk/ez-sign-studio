# EZ Sign Studio

Static PWA (GitHub Pages, `https://shesk.github.io/ez-sign-studio/`) that turns text or photos into
`.ezs` payload files for a Santek EZ Sign 4.2" 4-color NFC e-paper display. The files are written to
the display by a separate Flipper Zero app ("EZ Sign Writer", Momentum firmware) that replays them
over NFC. Everything runs client-side on the phone: no backend, no uploads, no analytics.

## Files

| File | Role |
|---|---|
| `index.html` | UI, inline CSS and app script. Loads `ezs-core.js`. |
| `ezs-core.js` | Encoder: dithering, pixel packing, LZO1X compression, `.ezs` container. Pure functions, no DOM; also loads in Node. |
| `sw.js` | Service worker. App files network-first, fonts cache-first. |
| `manifest.webmanifest`, `icon-*.png` | Install-to-home-screen metadata. |
| `tests/run.js` | Test suite: `node tests/run.js` (no dependencies). |
| `tests/lzo1x-decompress.js` | Test-only LZO1X decompressor, validated against the real `lzo1x_1_compress`. |
| `tests/fixtures/ref_*.ezs/.idx` | Payloads + expected pixels from the reference Python library (nfc-eink), known to work on hardware. |

## Rules — do not break these

The display and the Flipper app reject anything that deviates. Run `node tests/run.js` after any
change to `ezs-core.js`; it must report 0 failures before committing.

- **Panel:** 400×300, 2 bits per pixel. Color indices: 0 black, 1 white, 2 yellow, 3 red.
- **Packing:** each row is 100 bytes, packed **right to left**: byte `k` holds pixels starting at
  x = `(99 - k) * 4`; pixel `i` of that group sits in bits `2i..2i+1`. No rotation or flip for this panel.
- **Blocks:** packed data split into 2000-byte blocks (15 blocks), each compressed independently
  with **LZO1X** (any valid LZO1X stream; must end with `11 00 00`).
- **Fragments:** each compressed block split into ≤250-byte fragments, each sent as APDU
  `F0 D3 00 P2 Lc blockNo fragNo data…` where P2 = `01` on the block's last fragment, else `00`,
  and Lc = fragment length + 2.
- **`.ezs` container** (little-endian): `"EZS1"`, u16 width, u16 height, u8 bpp, u8 0, u16 apdu_count,
  then per APDU: u16 length + raw APDU bytes. Only F0 D3 APDUs go in the file; the Flipper sends
  auth, device-info and refresh itself.
- **Flipper limits** (enforced in its loader): file ≤ 48 KB, each APDU 5..261 bytes, file must end
  exactly after the last record. Heavy dithering of noisy photos is the main risk to the 48 KB cap.
- **Saved filename** ends in `.ezs` and goes to the phone's Downloads; the user uploads it to
  `/ext/apps_data/ez_sign/` with the Flipper mobile app (Options → File Manager).

## Working on it

- Preview locally: `python -m http.server 8000`, then open `http://localhost:8000`
  (or `http://<PC LAN IP>:8000` on the phone; the service worker only registers on localhost/HTTPS).
- Keep it dependency-free and offline-capable: no build step, no CDN scripts. Google Fonts is the
  only external request and has system-font fallbacks.
- Deploy = push to `main`; GitHub Pages republishes in about a minute. Installed phones pick up
  changes on next launch while online (network-first). Bump `VERSION` in `sw.js` only to force-clear
  old caches, e.g. after renaming or removing a cached file — and update `APP_FILES` if you add one.
- Phone-first UI: test at ~390 px wide. Every control needs to work by touch.

## Protocol background (for features that touch the device)

ISO 14443-4A tag, ISO 7816 APDUs. Auth is a fixed constant (`00 20 00 01 04 20 09 12 10`), so the
display has no real access control. Refresh takes ~30 s and the reader must keep the RF field up the
whole time. References: https://gist.github.com/niw/3885b22d502bb1e145984d41568f202d and
https://github.com/alt-core/nfc-eink (MIT; reference encoder used for the fixtures).
Browsers can't drive this directly: Web NFC only supports NDEF, not raw ISO-DEP APDUs.
