# EZ Sign Studio

Make images for a **Santek EZ Sign** 4.2" 4-color NFC e-paper display, on your phone.
Type a sign or pick a photo, save a `.ezs` file, and write it to the display with the
EZ Sign Writer app on a Flipper Zero.

**Open it:** https://shesk.github.io/ez-sign-studio/ — in Chrome on Android, use ⋮ → Install app.

Everything happens on your device. Images are never uploaded.

## Using it

1. Make a text sign or choose a photo, then tap **Save payload**. The `.ezs` file goes to Downloads.
2. In the Flipper mobile app: **Options → File Manager → ext → apps_data → ez_sign**, upload the file.
3. On the Flipper: **Apps → NFC → EZ Sign Writer**, press OK, pick the file, hold the Flipper on the sign
   until it vibrates (~30 s).

## Development

```
node tests/run.js           # encoder tests, no dependencies
python -m http.server 8000  # local preview at http://localhost:8000
```

See `CLAUDE.md` for the file format and the rules the encoder must follow.

## Credits

Protocol research by [niw](https://gist.github.com/niw/3885b22d502bb1e145984d41568f202d).
Reference encoder: [alt-core/nfc-eink](https://github.com/alt-core/nfc-eink) (MIT).
