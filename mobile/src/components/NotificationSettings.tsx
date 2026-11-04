import React, {useEffect, useState} from 'react';
import {AppState, Pressable, Text, View} from 'react-native';
import {notificationSettings, notificationStatus} from '../services/notifications';
import {C, S} from '../theme';

export function NotificationSettings() {
  const [status, setStatus] = useState('Checking message alerts…');
  useEffect(() => {
    let active = true;
    const refresh = () => { void notificationStatus().then(info => {
      if (!active) return;
      setStatus(!info ? 'Not supported on this platform' : !info.enabled ? 'Off — allow notifications in Settings'
        : !info.configured ? 'Background alerts are not set up yet'
        : !info.googleServices ? 'Push unavailable on this device' : !info.token ? 'Setting up message alerts…'
        : 'On — alerts when the app is in the background');
    }).catch(() => { if (active) setStatus('Could not check alerts'); }); };
    refresh();
    const sub = AppState.addEventListener('change', next => { if (next === 'active') refresh(); });
    return () => { active = false; sub.remove(); };
  }, []);
  return <View style={{alignSelf:'stretch', gap:10, marginVertical:10}}>
    <Text style={{color:C.text,fontSize:14,fontWeight:'700'}}>Message notifications</Text>
    <Text style={{color:C.muted,fontSize:12,lineHeight:18}}>{status}</Text>
    <Pressable accessibilityRole="button" onPress={notificationSettings} style={S.secondaryButton}>
      <Text style={S.secondaryText}>Notification settings</Text>
    </Pressable>
  </View>;
}
