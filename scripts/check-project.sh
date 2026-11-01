#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 - <<'PY'
import json
from pathlib import Path
root = Path('.')
files = list(root.rglob('*.json'))
for file in files:
    if any(part in {'node_modules', 'android', 'ios', 'target'} for part in file.parts):
        continue
    json.loads(file.read_text(encoding='utf-8'))
print(f'PASS: {len(files)} JSON files parsed')
PY

node scripts/validate-typescript.cjs
node scripts/test-mobile-framing.cjs
python3 scripts/test-db-schema.py
python3 scripts/test-source-invariants.py
bash -n scripts/bootstrap-native.sh scripts/build-android.sh scripts/check-project.sh
python3 - <<'PY'
from pathlib import Path
try:
    import yaml
except ImportError:
    print('SKIP: PyYAML unavailable; GitHub workflow syntax not parsed locally')
else:
    path = Path('.github/workflows/android.yml')
    yaml.safe_load(path.read_text(encoding='utf-8'))
    print('PASS: GitHub Actions YAML parsed')
PY

if command -v cargo >/dev/null 2>&1; then
  (cd backend && cargo test)
else
  echo 'SKIP: Rust compile/tests — cargo is not installed in this environment.'
fi

if [ -x mobile/android/gradlew ]; then
  echo 'Native Android Gradle shell exists. APK compilation is a separate build step.'
else
  echo 'SKIP: Android build — native shell/Gradle wrapper is not present.'
fi
