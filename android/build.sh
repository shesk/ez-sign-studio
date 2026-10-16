#!/usr/bin/env bash
# Builds EZ Sign Writer for Android with only the Android SDK's own tools (aapt2, javac, d8, zipalign,
# apksigner). No Gradle, no third-party libraries.
#
#   ANDROID_HOME=/path/to/sdk ./build.sh            # unsigned check build + tests
#   KEYSTORE=ezsign.jks KS_PASS=... ./build.sh      # signed release APK
#
# Needs: JDK 17+, SDK packages "platforms;android-37.0" and "build-tools;37.0.0".
set -euo pipefail
cd "$(dirname "$0")"

VERSION_CODE=1
VERSION_NAME=1.0
MIN_SDK=33   # keep in sync with <uses-sdk> in AndroidManifest.xml

SDK="${ANDROID_HOME:?set ANDROID_HOME to your Android SDK}"
BT="$SDK/build-tools/37.0.0"
JAR="$SDK/platforms/android-37.0/android.jar"
OUT=build
rm -rf "$OUT"; mkdir -p "$OUT/classes" "$OUT/gen" "$OUT/dex" "$OUT/test"

echo "== tests (JVM)"
javac -Xlint:all -Werror -d "$OUT/test" src/io/github/shesk/ezsign/Ezs.java src/io/github/shesk/ezsign/SignProtocol.java test/Tests.java
java -cp "$OUT/test" Tests ../tests/fixtures

echo "== resources"
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -o "$OUT/unaligned.apk" "$OUT/res.zip" \
  --java "$OUT/gen" --version-code $VERSION_CODE --version-name $VERSION_NAME

echo "== compile"
javac --release 17 -Xlint:all,-options -Werror -cp "$JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --release --min-api $MIN_SDK --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -X ../unaligned.apk classes.dex)
"$BT/zipalign" -p -f 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"

if [[ -n "${KEYSTORE:-}" ]]; then
  echo "== sign"
  "$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass env:KS_PASS --ks-key-alias ezsign \
    --out "$OUT/ez-sign-writer-$VERSION_NAME.apk" "$OUT/aligned.apk"
  "$BT/apksigner" verify --print-certs "$OUT/ez-sign-writer-$VERSION_NAME.apk"
  echo "== permissions requested"
  "$BT/aapt2" dump permissions "$OUT/ez-sign-writer-$VERSION_NAME.apk"
  sha256sum "$OUT/ez-sign-writer-$VERSION_NAME.apk"
else
  echo "Built $OUT/aligned.apk (unsigned). Set KEYSTORE and KS_PASS to sign."
fi
