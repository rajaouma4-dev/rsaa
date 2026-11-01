import React, {useEffect, useMemo, useState} from 'react';
import {View, Text, TextInput, Pressable, FlatList, StyleSheet, ScrollView, Alert} from 'react-native';
import {Avatar} from '../components/Avatar';
import {Brand} from '../components/Brand';
import {C, S} from '../theme';
import {Chat, User} from '../types';

import {formatPresence, formatRelativeTime} from '../utils/time';

export function formatSnippet(text?: string): string {
  if (!text) return '';
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.type === 'image_batch') {
        const count = parsed.images?.length || 1;
        return parsed.caption || (count > 1 ? `📷 ${count} Photos` : '📷 Photo');
      }
      if (parsed.type === 'voice_note') {
        return `🎤 Voice message (${parsed.durationSec || 1}s)`;
      }
      if (parsed.type === 'text' && typeof parsed.text === 'string') {
        return parsed.text;
      }
    } catch {}
  }
  return text;
}

type Tab = 'chats' | 'people' | 'profile';
export function HomeScreen({username, uid, displayName, about = '', liveMode, rtcStatus, chats, people, onSearchPeople, onOpenChat, onLogout, onAddChat, onUpdateProfile}: {username: string; uid?: string; displayName: string; about?: string; liveMode: boolean; rtcStatus: string; chats: Chat[]; people: User[]; onSearchPeople: (query: string) => Promise<User[]>; onOpenChat: (c: Chat) => void; onLogout: () => void; onAddChat: (u: User) => void; onUpdateProfile: (displayName: string, about: string) => Promise<void>}) {
  const [tab, setTab] = useState<Tab>('chats');
  const [query, setQuery] = useState('');
  const [remotePeople, setRemotePeople] = useState<User[]>([]);
  const [searchError, setSearchError] = useState('');
  const [profileName, setProfileName] = useState(displayName);
  const [profileAbout, setProfileAbout] = useState(about);
  const [profileBusy, setProfileBusy] = useState(false);
  const filtered = useMemo(() => people.filter(p => `${p.name} ${p.username}`.toLowerCase().includes(query.toLowerCase())), [people, query]);
  useEffect(() => {
    if (!liveMode || tab !== 'people') { setRemotePeople([]); setSearchError(''); return; }
    const value = query.trim();
    if (value.length < 2) { setRemotePeople([]); setSearchError(''); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      onSearchPeople(value).then(results => {
        if (!cancelled) { setRemotePeople(results); setSearchError(''); }
      }).catch(error => {
        if (!cancelled) { setRemotePeople([]); setSearchError(error instanceof Error ? error.message : 'Search failed'); }
      });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [liveMode, tab, query, onSearchPeople]);
  const peopleToShow = useMemo(() => {
    const list = liveMode ? remotePeople : filtered;
    return list.map(p => {
      const chatMatch = chats.find(c => c.user.id === p.id);
      if (chatMatch) {
        return {...p, online: chatMatch.user.online, lastActive: chatMatch.user.lastActive};
      }
      return p;
    });
  }, [liveMode, remotePeople, filtered, chats]);
  return <View style={S.screen}>
    <View style={styles.header}><Brand small/><View style={styles.headerRight}><View style={styles.live}><View style={styles.dot}/><Text style={styles.liveText}>{liveMode ? (rtcStatus === 'connected' ? 'ONLINE' : (rtcStatus === 'connecting' || rtcStatus === 'signaling') ? 'CONNECTING' : 'OFFLINE') : 'DEMO'}</Text></View><Avatar name={displayName || username} size={36}/></View></View>
    {tab === 'chats' ? <>
      <View style={styles.heading}><View><Text style={styles.kicker}>YOUR INBOX</Text><Text style={styles.title}>Messages</Text></View><Text style={styles.count}>{chats.length.toString().padStart(2, '0')}</Text></View>
      <View style={styles.search}><Text style={styles.searchIcon}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Search conversations" placeholderTextColor={C.muted} style={styles.searchInput}/></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stories}>{people.slice(0, 4).map(p => <Pressable key={p.id} onPress={() => onAddChat(p)} style={styles.story}><Avatar name={p.name} online={p.online} size={50}/><Text style={styles.storyName} numberOfLines={1}>{p.name.split(' ')[0]}</Text></Pressable>)}</ScrollView>
      <FlatList data={chats.filter(c => `${c.user.name} ${c.user.username} ${formatSnippet(c.preview)}`.toLowerCase().includes(query.toLowerCase()))} keyExtractor={x => x.id} contentContainerStyle={styles.list} renderItem={({item}) => <Pressable onPress={() => onOpenChat(item)} style={styles.chatRow}><Avatar name={item.user.name} online={item.user.online}/><View style={styles.chatBody}><View style={styles.chatTop}><Text style={styles.name}>{item.user.name}</Text><Text style={styles.time}>{item.timestamp ? formatRelativeTime(item.timestamp) : item.time}</Text></View><View style={styles.chatBottom}><Text numberOfLines={1} style={styles.preview}>{formatSnippet(item.preview)}</Text>{item.unread > 0 ? <View style={styles.unread}><Text style={styles.unreadText}>{item.unread}</Text></View> : null}</View></View></Pressable>} ListEmptyComponent={<Text style={styles.empty}>No conversations yet. Open People to start one.</Text>}/>
    </> : null}
    {tab === 'people' ? <>
      <View style={styles.heading}><View><Text style={styles.kicker}>FIND YOUR PEOPLE</Text><Text style={styles.title}>Discover</Text></View></View>
      <View style={styles.search}><Text style={styles.searchIcon}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Search name or @username" placeholderTextColor={C.muted} style={styles.searchInput}/></View>
      {liveMode && query.trim().length < 2 ? <Text style={styles.empty}>Type at least 2 characters to search server users.</Text> : null}
      {searchError ? <Text style={styles.searchError}>{searchError}</Text> : null}
      <FlatList data={peopleToShow} keyExtractor={x => x.id} contentContainerStyle={styles.list} renderItem={({item}) => <View style={styles.personRow}><Avatar name={item.name} online={item.online}/><View style={styles.personBody}><Text style={styles.name}>{item.name}</Text><Text style={styles.preview}>@{item.username} · {formatPresence(item.online, item.lastActive)}</Text></View><Pressable onPress={() => onAddChat(item)} style={styles.messageBtn}><Text style={styles.messageBtnText}>Message</Text></Pressable></View>}/>
    </> : null}
    {tab === 'profile' ? <ScrollView contentContainerStyle={styles.profile}><Avatar name={displayName || username} size={82}/><Text style={styles.profileName}>{displayName || username}</Text><Text style={styles.profileUser}>@{username}</Text><View style={styles.profileCard}><Text style={styles.kicker}>ACCOUNT</Text><View style={styles.setting}><Text style={styles.settingLabel}>User ID</Text><Text style={styles.settingValue}>{uid || `DEMO-${username.toUpperCase()}`}</Text></View><View style={styles.setting}><Text style={styles.settingLabel}>Connection</Text><Text style={styles.settingValue}>{liveMode ? `WebRTC: ${rtcStatus}` : 'Local demo only'}</Text></View><Text style={styles.settingLabel}>Display name</Text><TextInput value={profileName} onChangeText={setProfileName} maxLength={60} placeholder="Your display name" placeholderTextColor={C.muted} style={styles.profileInput}/><Text style={styles.settingLabel}>About</Text><TextInput value={profileAbout} onChangeText={setProfileAbout} maxLength={160} placeholder="A little about you" placeholderTextColor={C.muted} style={[styles.profileInput, {minHeight: 72, textAlignVertical: 'top'}]} multiline/></View><Pressable disabled={!liveMode || profileBusy} style={[S.primaryButton, (!liveMode || profileBusy) && {opacity: 0.45}]} onPress={async () => {setProfileBusy(true); try {await onUpdateProfile(profileName, profileAbout); Alert.alert('Profile updated', 'Your profile has been saved.');} catch (e) {Alert.alert('Profile update failed', e instanceof Error ? e.message : 'Please try again.');} finally {setProfileBusy(false);}}}><Text style={S.primaryText}>{profileBusy ? 'Saving…' : 'Save profile'}</Text></Pressable><Pressable style={S.secondaryButton} onPress={onLogout}><Text style={[S.secondaryText, {color: C.red}]}>Sign out</Text></Pressable><Text style={styles.profileNote}>{liveMode ? 'Signal Protocol E2EE · All messages are end-to-end encrypted.' : 'Local preview only. No real account or server messages are created.'}</Text></ScrollView> : null}
    <View style={styles.tabbar}>{(['chats', 'people', 'profile'] as Tab[]).map(t => <Pressable onPress={() => {setTab(t); setQuery('');}} key={t} style={styles.tab}><Text style={[styles.tabIcon, tab === t && styles.tabActive]}>{t === 'chats' ? '▣' : t === 'people' ? '◎' : '◉'}</Text><Text style={[styles.tabText, tab === t && styles.tabActive]}>{t === 'chats' ? 'Chats' : t === 'people' ? 'People' : 'You'}</Text></Pressable>)}</View>
  </View>;
}
const styles = StyleSheet.create({header: {height: 62, paddingHorizontal: 21, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: C.line}, headerRight: {flexDirection: 'row', alignItems: 'center', gap: 13}, live: {flexDirection: 'row', alignItems: 'center', gap: 6}, dot: {width: 6, height: 6, backgroundColor: C.green, borderRadius: 8}, liveText: {color: C.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1}, heading: {paddingHorizontal: 22, paddingTop: 25, paddingBottom: 17, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between'}, kicker: {color: C.green, letterSpacing: 1.8, fontSize: 9, fontWeight: '900', marginBottom: 7}, title: {color: C.text, fontSize: 30, fontWeight: '900', letterSpacing: -0.8}, count: {color: C.muted, fontSize: 13, fontWeight: '800', paddingBottom: 5}, search: {marginHorizontal: 21, backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, height: 48, borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13}, searchIcon: {fontSize: 24, color: C.muted, marginRight: 9}, searchInput: {flex: 1, color: C.text, fontSize: 13, padding: 0}, stories: {paddingHorizontal: 21, paddingVertical: 17, gap: 18}, story: {alignItems: 'center', width: 58, gap: 6}, storyName: {color: C.muted, fontSize: 10, maxWidth: 58}, list: {paddingHorizontal: 21, paddingBottom: 110}, chatRow: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1B2938'}, chatBody: {flex: 1}, chatTop: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}, name: {color: C.text, fontSize: 14, fontWeight: '800'}, time: {color: C.muted, fontSize: 10}, chatBottom: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6}, preview: {color: C.muted, fontSize: 12, flex: 1}, unread: {width: 20, height: 20, borderRadius: 10, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center'}, unreadText: {fontSize: 10, color: '#06251C', fontWeight: '900'}, empty: {color: C.muted, textAlign: 'center', padding: 28, fontSize: 13}, tabbar: {position: 'absolute', bottom: 0, left: 0, right: 0, height: 76, backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.line, flexDirection: 'row', justifyContent: 'space-around', paddingTop: 12}, tab: {alignItems: 'center', width: '33%'}, tabIcon: {fontSize: 20, color: C.muted}, tabText: {fontSize: 10, color: C.muted, marginTop: 4, fontWeight: '700'}, tabActive: {color: C.green}, personRow: {flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1B2938', gap: 13}, personBody: {flex: 1}, messageBtn: {paddingHorizontal: 13, paddingVertical: 8, borderRadius: 11, backgroundColor: C.greenDark}, messageBtnText: {color: C.green, fontSize: 11, fontWeight: '800'}, profile: {alignItems: 'center', padding: 24, paddingTop: 36, paddingBottom: 110, gap: 8}, profileName: {color: C.text, fontSize: 23, fontWeight: '900', marginTop: 8}, profileUser: {color: C.muted, fontSize: 13}, profileCard: {alignSelf: 'stretch', backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 18, padding: 17, marginTop: 25, marginBottom: 14, gap: 9}, profileInput: {color: C.text, backgroundColor: C.bg, borderColor: C.line, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13}, setting: {flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line}, settingLabel: {color: C.muted, fontSize: 12}, settingValue: {color: C.text, fontSize: 12, fontWeight: '700'}, profileNote: {color: C.muted, fontSize: 10, textAlign: 'center', marginTop: 14}, searchError: {color: C.red, fontSize: 11, paddingHorizontal: 22, paddingTop: 10}});
