"""Opt-in real FCM transport checks on one existing signed-in Android test emulator.

Build/install :app:assembleRelease and :app:assembleReleaseAndroidTest first.
Build Rust tests with cargo test --no-run. No chat messages are created.
Example: python scripts/test-fcm-device.py SERIAL SERVICE_ACCOUNT_FILE
Temporarily changes only the emulator's network state and restores it afterward.
"""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SERIAL, CREDENTIAL = sys.argv[1:3]
ADB = Path(os.environ.get('NEXA_QA_ADB', r'D:/Program Files/Netease/MuMuPlayer/nx_main/adb.exe'))
OUT = ROOT / 'backend/target/fcm-device'
OUT.mkdir(parents=True, exist_ok=True)
FIXTURE = OUT / 'registration-private.json'
RUST_TEST = max((ROOT / 'backend/target/debug/deps').glob('nexa_messenger_server-*.exe'), key=lambda p: p.stat().st_mtime)
RUN = str(int(time.time()))
results = json.loads((OUT / 'results.json').read_text()) if (OUT / 'results.json').exists() else {}
manager = ADB.parent / 'MuMuManager.exe'
mumu_index = None
if manager.exists() and ':' in SERIAL:
    records = json.loads(subprocess.check_output([str(manager),'info','-v','all'], timeout=20))
    mumu_index = next((str(v['index']) for v in records.values() if str(v.get('adb_port')) == SERIAL.rsplit(':',1)[1]), None)


def host_command(command):
    subprocess.run([str(manager),'sh','-v',mumu_index,'-c',command], check=True, capture_output=True, timeout=20)


def network_command(*args):
    # MuMu's network toggle can also disconnect its ADB transport. Its documented
    # host shell remains available, including for cleanup after exceptions.
    if mumu_index is not None:
        host_command(shlex.join(args))
    else:
        shell(*args)


def adb(*args, check=True):
    return subprocess.run([str(ADB), '-s', SERIAL, *args], capture_output=True, timeout=40, check=check).stdout


def shell(*args, check=True):
    return adb('shell', *args, check=check).decode(errors='replace').strip()


def registration():
    raw = shell('am', 'instrument', '-w', 'com.securemessenger.test/com.securemessenger.NotificationTestRunner')
    match = re.search(r'INSTRUMENTATION_RESULT: registration=(\{.*\})', raw)
    if not match:
        raise RuntimeError('Test registration export failed; no private output was printed')
    info = json.loads(match[1])
    if not info.get('token') or not info.get('uid'):
        raise RuntimeError('Open the configured app and sign in first; FCM registration is not ready')
    FIXTURE.write_text(json.dumps(info))
    return info


def send(message, conversation):
    env = os.environ.copy()
    env.update(FIREBASE_SERVICE_ACCOUNT_FILE=str(Path(CREDENTIAL).resolve()),
               NEXA_FCM_SMOKE_FIXTURE=str(FIXTURE), NEXA_FCM_SMOKE_ID=message,
               NEXA_FCM_SMOKE_CONVERSATION=conversation)
    result = subprocess.run([str(RUST_TEST), '--exact', 'push::tests::firebase_real_device_transport', '--ignored'],
                            env=env, capture_output=True, timeout=40)
    if result.returncode:
        raise RuntimeError('Real FCM provider test failed; inspect credentials, API enablement and connectivity')
    print('FCM accepted', message, flush=True)


def notifications():
    text = shell('dumpsys', 'notification')
    return [line.strip() for line in text.splitlines() if 'NotificationRecord' in line and 'pkg=com.securemessenger ' in line]


def wait_alert(conversation):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if any(f'tag=nexa:{conversation} ' in line for line in notifications()):
            return
        time.sleep(2)
    raise RuntimeError('FCM was accepted but Android notification was not observed within 60 seconds')


def foreground():
    shell('cmd', 'statusbar', 'collapse')
    shell('am', 'start', '-n', 'com.securemessenger/.MainActivity')
    time.sleep(2)
    assert not notifications(), 'Returning to the app did not clear message notifications'


def evidence(name):
    shell('cmd', 'statusbar', 'expand-notifications')
    time.sleep(1)
    (OUT / f'{name}.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    shell('cmd', 'statusbar', 'collapse')


def network_none():
    text = shell('dumpsys', 'connectivity')
    match = re.search(r'Active default network:\s*(\S+)', text)
    return bool(match and match[1].lower() in ('none', 'null', '-1'))


wifi = shell('settings', 'get', 'global', 'wifi_on')
airplane = shell('settings', 'get', 'global', 'airplane_mode_on')
network_changed = False

try:
    registration()
    if '--offline-only' not in sys.argv[3:]:
        foreground()
        foreground_id = f'push_foreground_{RUN}'
        send(foreground_id, 'push-test-foreground')
        time.sleep(18)
        assert not notifications(), 'A visible app posted a message notification'
        info = registration()
        assert foreground_id in info.get('recent', []), 'No proof the foreground push reached native code'
        results['foreground_received_without_notification'] = True
        print('PASS foreground received with no notification', flush=True)

        foreground()
        shell('input', 'keyevent', '3')
        time.sleep(2)
        shell('am', 'kill', 'com.securemessenger')
        time.sleep(2)
        assert not shell('pidof', 'com.securemessenger', check=False), 'App process was not killed; cannot claim a cold-process pass'
        killed_id = f'push_killed_{RUN}'
        send(killed_id, 'push-test-killed')
        wait_alert('push-test-killed')
        evidence('process-killed')
        results['notification_after_process_kill'] = True
        print('PASS notification after app process kill', flush=True)
        before = notifications()
        send(killed_id, 'push-test-killed')
        time.sleep(15)
        assert notifications() == before, 'Duplicate push replaced or added a notification'
        results['duplicate_kept_existing_notification'] = True
        print('PASS duplicate kept the existing notification record', flush=True)

    foreground()
    shell('input', 'keyevent', '3')
    network_changed = True
    network_command('cmd', 'connectivity', 'airplane-mode', 'enable')
    network_command('svc', 'wifi', 'disable')
    time.sleep(4)
    if mumu_index is not None:
        host_command('dumpsys connectivity > /data/local/tmp/nexa-offline-connectivity.txt')
    elif not network_none():
        raise RuntimeError('Device still has a default network; refusing to claim an offline pass')
    send(f'push_offline_{RUN}', 'push-test-offline')
    time.sleep(10)
    if mumu_index is None:
        assert not notifications(), 'Offline test did not isolate device delivery'
    network_command('cmd', 'connectivity', 'airplane-mode', 'disable')
    network_command('svc', 'wifi', 'enable')
    time.sleep(4)
    if mumu_index is not None:
        snapshot = shell('cat','/data/local/tmp/nexa-offline-connectivity.txt')
        match = re.search(r'Active default network:\s*(\S+)', snapshot)
        assert match and match[1].lower() in ('none','null','-1'), 'No proof that the emulator had no default network'
    print('Verified no default network during the queued push', flush=True)
    wait_alert('push-test-offline')
    evidence('offline-reconnect')
    results['offline_notification_after_reconnect'] = True
    print('PASS offline notification delivered after reconnect', flush=True)
finally:
    errors = []
    if network_changed:
        for command in [('cmd','connectivity','airplane-mode','enable' if airplane == '1' else 'disable'),
                        ('svc','wifi','enable' if wifi == '1' else 'disable')]:
            try:
                network_command(*command)
            except Exception:
                errors.append(' '.join(command))
    FIXTURE.unlink(missing_ok=True)
    results['network_restore_errors'] = errors
    (OUT / 'results.json').write_text(json.dumps(results, indent=2))
    try:
        foreground()
    except Exception:
        pass
    if errors:
        print('Network restoration needs attention:', errors, flush=True)
