# EZ Sign Writer for Android

Writes images from [EZ Sign Studio](https://shesk.github.io/ez-sign-studio/) to a Santek EZ Sign
4.2" 4-color display using the phone's own NFC. No Flipper needed.

## Installing

Download on the phone: https://shesk.github.io/ez-sign-studio/android/releases/ez-sign-writer-1.1.apk
(SHA-256 in [`releases/SHA256SUMS`](releases/SHA256SUMS), built from commit edd05fc by `build.sh`).
Android asks once to allow installs from Chrome; switch that back off afterwards.

## Using it

1. In EZ Sign Studio, make your sign and tap **Send to sign**.
2. Pick **EZ Sign Writer** in the share sheet. (Long-press it there and choose **Pin** to keep it at the top.)
3. Check the preview, tap **Write to sign**, and hold the middle of the phone's back flat on the center
   of the sign. Keep still for about 30 seconds until the phone buzzes and says **Done**.

You can also open a saved `.ezs` file with **Open a saved .ezs file…**.

## Security model

- **One permission: NFC.** No internet, storage, location or anything else. Check under
  Settings → Apps → EZ Sign Writer → Permissions, or `aapt2 dump permissions` on the APK.
- **No third-party code.** Plain Java against the Android SDK, under 800 lines in `src/`.
- **NFC is only on while you're writing.** Reader mode starts when you tap **Write to sign** and stops when
  it finishes, you cancel, or the app leaves the screen.
- **Bank cards are safe.** The sign's unlock command (`00 20 …`) is the standard *VERIFY PIN* instruction,
  so before sending it the app requires the tag to (1) accept SELECT of application `D2760000850101` and
  (2) report itself as an EZ Sign panel matching the image. Payment and transit cards fail step 1 and
  never receive anything else. `test/Tests.java` checks this against a simulated bank card.
- **Files are checked before use.** The app validates the whole payload, including decompressing every
  block, and shows a preview of exactly what will be written.
- **Nothing is stored or backed up.** The app keeps no data; Android backup is disabled.
- **The sign itself is not secured.** Its unlock code is the same on every unit, so anyone with an NFC
  phone can rewrite it. This app doesn't change that.

## Building

Uses only the SDK's own tools (aapt2, javac, d8, zipalign, apksigner); no Gradle.

```
sdkmanager "platforms;android-37.0" "build-tools;37.0.0"
ANDROID_HOME=/path/to/sdk ./build.sh                              # tests + unsigned build
KEYSTORE=ezsign-release.jks KS_PASS=... ANDROID_HOME=... ./build.sh   # signed APK
```

`build.sh` runs the JVM tests first (payload parsing against the reference fixtures, and the NFC
conversation against a simulated sign and a simulated bank card) and prints the APK's permissions and
SHA-256 after signing.

Updates must be signed with the same key (`ezsign-release.jks`, kept outside this repo). If it's lost,
uninstall the old app before installing a build signed with a new key; the app has no data to lose.

## Release signing certificate

SHA-256 of the signing certificate for releases from this repo:
`5d5a4428c216bdb763e011ed3291bbe4bae13136dd342cf1c77a0b6967c8adbd`

Check a downloaded APK with `apksigner verify --print-certs ez-sign-writer-1.1.apk`.
