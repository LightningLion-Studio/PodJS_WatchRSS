#!/usr/bin/env bash
set -euo pipefail
# Caller wraps this build with flock/capmem. Output stays outside the source tree.
source_dir=$(cd "$(dirname "$0")/denied-app" && pwd)
output=$(realpath -m "$1")
mkdir -p "$output/classes" "$output/dex"
sdk=${ANDROID_SDK_ROOT:?}
build_tools="$sdk/build-tools/36.0.0"
javac --release 8 -cp "$sdk/platforms/android-36/android.jar" -d "$output/classes" "$source_dir/MainActivity.java"
jar cf "$output/classes.jar" -C "$output/classes" .
"$build_tools/d8" --lib "$sdk/platforms/android-36/android.jar" --output "$output/dex" "$output/classes.jar"
"$build_tools/aapt2" link -I "$sdk/platforms/android-36/android.jar" --manifest "$source_dir/AndroidManifest.xml" -o "$output/unsigned.apk"
(cd "$output/dex" && zip -q "$output/unsigned.apk" classes.dex)
"$build_tools/zipalign" -f 4 "$output/unsigned.apk" "$output/aligned.apk"
"$build_tools/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --out "$output/denied.apk" "$output/aligned.apk"
