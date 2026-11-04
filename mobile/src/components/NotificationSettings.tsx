import React, {useEffect, useState} from 'react';
import {AppState, Pressable, Switch, Text, View} from 'react-native';
import {notificationSettings, notificationStatus, requestNotificationPermission, setNotificationSound} from '../services/notifications';
import {C, S} from '../theme';

export function NotificationSettings() {
  const [status, setStatus] = useState('Checking message alerts…');
  const [revision, setRevision] = useState(0);
  const [sound, setSound] = useState(true);
  const [soundBusy, setSoundBusy] = useState(false);
  const [soundError, setSoundError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => { void notificationStatus().then(info => {
      if (!active) return;
      if(info) setSound(info.soundEnabled !== false);
      setStatus(!info ? 'Not supported on this platform' : !info.enabled ? 'Off — allow notifications in Settings'
        : !info.configured ? 'Background alerts are not set up yet'
        : !info.googleServices ? 'Push unavailable on this device' : !info.token ? 'Setting up message alerts…'
        : info.headsUp === false ? 'Alerts on — enable sound and pop on screen in Notification settings'
        : 'On — alerts when the app is in the background');
    }).catch(() => { if (active) setStatus('Could not check alerts'); }); };
    refresh();
    const sub = AppState.addEventListener('change', next => { if (next === 'active') refresh(); });
    return () => { active = false; sub.remove(); };
  }, [revision]);
  return <View style={{alignSelf:'stretch', gap:10, marginVertical:10}}>
    <Text style={{color:C.text,fontSize:14,fontWeight:'700'}}>Message notifications</Text>
    <Text style={{color:C.muted,fontSize:12,lineHeight:18}}>{status}</Text>
    <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}}>
      <View style={{flex:1}}><Text style={{color:C.text,fontSize:14}}>Notification sound</Text>
        <Text style={{color:C.muted,fontSize:12}}>{soundBusy ? 'Saving…' : sound ? 'Moonlit Bubble' : 'Off — alerts still appear'}</Text></View>
      <Switch accessibilityLabel="Notification sound" value={sound} disabled={soundBusy} onValueChange={enabled => {
        setSound(enabled); setSoundBusy(true); setSoundError('');
        void setNotificationSound(enabled).catch(error => setSoundError(error instanceof Error ? error.message : 'Could not save sound setting'))
          .finally(() => {setSoundBusy(false);setRevision(value=>value+1);});
      }}/>
    </View>
    {soundError ? <Text style={{color:C.muted,fontSize:12,lineHeight:18}}>{soundError}</Text> : null}
    <Pressable accessibilityRole="button" onPress={() => {
      void requestNotificationPermission(true).catch(() => setStatus('Could not request permission — use Notification settings'))
        .finally(() => setRevision(value => value + 1));
    }} style={S.secondaryButton}>
      <Text style={S.secondaryText}>Allow message alerts</Text>
    </Pressable>
    <Pressable accessibilityRole="button" onPress={notificationSettings} style={S.secondaryButton}>
      <Text style={S.secondaryText}>Notification settings</Text>
    </Pressable>
  </View>;
}
