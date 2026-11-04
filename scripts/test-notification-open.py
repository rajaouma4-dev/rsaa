"""Opt-in warm notification-intent routing check on an existing signed-in emulator.

Install the normal release APK and its separate NotificationTestRunner APK first.
Reads only this test device's registration and one existing conversation ID.
Does not send chat messages, alter accounts, or print identifiers/tokens.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ADB = os.environ.get('NEXA_QA_ADB', r'D:/Program Files/Netease/MuMuPlayer/nx_main/adb.exe')
SERIAL = sys.argv[1]


def shell(*args):
    return subprocess.check_output([ADB, '-s', SERIAL, 'shell', *args], timeout=20)


def ui():
    path = '/data/local/tmp/nexa-notification-open.xml'
    shell('rm', '-f', path)
    result = subprocess.run([ADB, '-s', SERIAL, 'shell', 'uiautomator', 'dump', path],
                            capture_output=True, timeout=20)
    # This MuMu Android 15 build can exit 139 during VM shutdown after writing
    # a valid hierarchy. Require its success marker and a freshly created file.
    if result.returncode and b'dumped to:' not in result.stdout:
        result.check_returncode()
    return ET.fromstring(shell('cat', path))


raw = shell('am', 'instrument', '-w', 'com.securemessenger.test/com.securemessenger.NotificationTestRunner').decode()
match = re.search(r'INSTRUMENTATION_RESULT: registration=(\{.*\})', raw)
if not match:
    raise RuntimeError('Test registration export failed')
uid = json.loads(match[1]).get('uid')
if not uid:
    raise RuntimeError('Test device must already be signed in')
values = {}
for line in (ROOT / 'backend/.env').read_text(encoding='utf-8').splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        values[key] = value.strip().strip('"')
url = values['TURSO_DATABASE_URL'].replace('libsql://', 'https://').rstrip('/') + '/v2/pipeline'
sql = "SELECT m.conversation_id FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE cm.uid=?1 ORDER BY CAST(m.created_at AS INTEGER) DESC LIMIT 1"
request = urllib.request.Request(url, data=json.dumps({'requests':[
    {'type':'execute','stmt':{'sql':sql,'args':[{'type':'text','value':uid}]}}, {'type':'close'}]}).encode(),
    headers={'Authorization':'Bearer '+values['TURSO_AUTH_TOKEN'],'Content-Type':'application/json'})
with urllib.request.urlopen(request, timeout=20) as response:
    result = json.load(response)
rows = result['results'][0]['response']['result']['rows']
if not rows:
    raise RuntimeError('Test account needs an existing conversation')
conversation = rows[0][0]['value']
shell('am', 'start', '-n', 'com.securemessenger/.MainActivity')
time.sleep(2)
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    try:
        if any(n.get('text') == 'Messages' for n in ui().iter('node')):
            break
    except subprocess.CalledProcessError:
        # MuMu's UIAutomator occasionally exits during activity startup.
        pass
    time.sleep(1)
else:
    raise RuntimeError('Inbox was not ready within 120 seconds')
time.sleep(1)
started = time.monotonic()
shell('am', 'start', '-n', 'com.securemessenger/.MainActivity',
      '--es', 'notification_uid', uid, '--es', 'notification_conversation', conversation)
root = ui()
elapsed = time.monotonic() - started
assert any(n.get('content-desc') == 'Back to messages' for n in root.iter('node')), 'Warm notification intent did not open its conversation'
assert elapsed < 6, 'Opening the warm intent waited too long'
print(f'PASS: existing conversation opened from a warm native intent in {elapsed:.2f}s including UI automation overhead; no message sent.')
shell('input', 'keyevent', '4')
