#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then echo "Node.js 22.13+ is required" >&2; exit 1; fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
NODE_MINOR="$(node -p 'Number(process.versions.node.split(".")[1])')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 13) )); then
  echo "Node.js 22.13+ is required; found $(node --version)" >&2; exit 1
fi
if ! command -v java >/dev/null 2>&1; then echo "JDK 17 is required" >&2; exit 1; fi
JAVA_VERSION="$(java -version 2>&1 | awk -F '"' '/version/ {print $2; exit}')"
JAVA_MAJOR="${JAVA_VERSION%%.*}"
if [ "$JAVA_MAJOR" != "17" ]; then
  echo "JDK 17 is required for this template; found Java ${JAVA_VERSION:-unknown}" >&2; exit 1
fi
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK_ROOT" ] || [ ! -d "$SDK_ROOT" ]; then
  echo "Set ANDROID_HOME or ANDROID_SDK_ROOT to an installed Android SDK" >&2; exit 1
fi
if [ ! -d "$SDK_ROOT/platforms/android-37" ]; then
  echo "Android SDK Platform 37 is missing. Install it with sdkmanager 'platforms;android-37'." >&2; exit 1
fi

if [ ! -d mobile/android ]; then bash scripts/bootstrap-native.sh; fi
if [ ! -x mobile/android/gradlew ]; then chmod +x mobile/android/gradlew; fi
cd mobile
npm install --no-audit --no-fund
npm run validate:syntax
npm run typecheck
cd android
./gradlew --no-daemon clean assembleRelease
APK="$ROOT/mobile/android/app/build/outputs/apk/release/app-release.apk"
if [ ! -s "$APK" ]; then echo "Gradle finished but APK was not found at $APK" >&2; exit 1; fi
printf '\nAPK created: %s\n' "$APK"
sha256sum "$APK"
printf 'APK size: '
du -h "$APK" | awk '{print $1}'
echo 'NOTE: verify signingConfig and use your own production keystore before distribution.'
