#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="$ROOT/mobile"
TMP="$(mktemp -d)"
cleanup(){ rm -rf "$TMP"; }
trap cleanup EXIT

if [ -d "$MOBILE/android" ]; then
  echo "mobile/android already exists; leaving native shell unchanged."
  exit 0
fi

npx --yes @react-native-community/cli@20.2.0 init SecureMessenger --directory "$TMP/SecureMessenger" --version 0.88.1 --skip-install
cp -a "$TMP/SecureMessenger/android" "$MOBILE/android"
if [ -d "$TMP/SecureMessenger/ios" ]; then cp -a "$TMP/SecureMessenger/ios" "$MOBILE/ios"; fi
cp "$TMP/SecureMessenger/gradle.properties" "$MOBILE/gradle.properties"
cp "$TMP/SecureMessenger/.watchmanconfig" "$MOBILE/.watchmanconfig" 2>/dev/null || true
# Use the package entry point from this starter, not the temporary template.
echo "Native shell generated. Next: cd mobile && npm install && cd android && ./gradlew assembleRelease"
