import React, {useState} from 'react';
import {View, Text, TextInput, Pressable, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, ActivityIndicator, StatusBar} from 'react-native';
import {Brand} from '../components/Brand';
import {C, S} from '../theme';
import {APP_CONFIG, updateSignalingHost} from '../config';

const TOP_INSET = Platform.OS === 'android' ? Math.max(StatusBar.currentHeight || 0, 36) + 16 : 52;
const BOTTOM_INSET = Platform.OS === 'android' ? 20 : 12;

export function AuthScreen({
  mode,
  onMode,
  onSubmit,
  busy = false,
  demoMode = false,
}: {
  mode: 'login' | 'register';
  onMode: (m: 'login' | 'register') => void;
  onSubmit: (name: string, username: string, password: string) => Promise<void> | void;
  busy?: boolean;
  demoMode?: boolean;
}) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [serverHost, setServerHost] = useState(
    APP_CONFIG.SIGNALING_URL || 'wss://rsaa.onrender.com'
  );
  const [showServerInput, setShowServerInput] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState('');
  const isRegister = mode === 'register';
  const ready = username.trim().length >= 3 && password.length >= 6 && (!isRegister || name.trim().length >= 2);
  const submitting = busy || localBusy;

  const submit = async () => {
    if (!ready || submitting) return;
    setError('');
    setLocalBusy(true);
    try {
      updateSignalingHost(serverHost);
      await onSubmit(name.trim(), username.trim().replace(/^@/, ''), password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.toLowerCase().includes('password') ||
        msg.toLowerCase().includes('login_failed') ||
        msg.toLowerCase().includes('credentials') ||
        msg.toLowerCase().includes('user not found') ||
        msg.toLowerCase().includes('invalid username')
      ) {
        setError(isRegister ? 'Username may already be taken or invalid.' : 'Invalid username or password. If new, tap "Create account" below.');
      } else if (
        msg.toLowerCase().includes('connect') ||
        msg.toLowerCase().includes('econnrefused') ||
        msg.toLowerCase().includes('timed out')
      ) {
        setError(`Could not connect to ${serverHost}. Please wait 5s and try again.`);
      } else {
        setError(msg || (isRegister ? 'Registration failed.' : 'Invalid username or password.'));
      }
    } finally {
      setLocalBusy(false);
    }
  };

  const switchMode = (targetMode: 'login' | 'register') => {
    if (submitting) return;
    setError('');
    setPassword('');
    onMode(targetMode);
  };

  return <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <View style={styles.top}>
        <Brand />
        <Pressable onPress={() => setShowServerInput(prev => !prev)} style={styles.pill}>
          <View style={styles.pulse}/>
          <Text style={styles.pillText}>SERVER: {serverHost}</Text>
        </Pressable>
      </View>

      {showServerInput ? (
        <View style={styles.serverBox}>
          <Text style={styles.serverLabel}>Backend Host / IP (default: {APP_CONFIG.SIGNALING_HOST}):</Text>
          <TextInput
            value={serverHost}
            onChangeText={val => {
              setServerHost(val);
              updateSignalingHost(val);
            }}
            placeholder="e.g. 10.109.201.244 or 10.0.2.2"
            placeholderTextColor={C.muted}
            style={[S.input, styles.serverInput]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ) : null}

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>YOUR SPACE. YOUR PEOPLE.</Text>
        <Text style={styles.title}>{isRegister ? 'Create your\nquiet corner.' : 'Good to see\nyou again.'}</Text>
        <Text style={styles.sub}>A simple place for conversations that matter.</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{isRegister ? 'Create account' : 'Welcome back'}</Text>
        {isRegister ? <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={C.muted} style={S.input} autoCapitalize="words" maxLength={60} editable={!submitting}/> : null}
        <TextInput value={username} onChangeText={value => {setUsername(value); setError('');}} placeholder="Username" placeholderTextColor={C.muted} style={S.input} autoCapitalize="none" autoCorrect={false} maxLength={24} editable={!submitting}/>
        
        <View style={styles.passwordContainer}>
          <TextInput
            value={password}
            onChangeText={value => {setPassword(value); setError('');}}
            placeholder="Password (min 6 characters)"
            placeholderTextColor={C.muted}
            style={[S.input, styles.passwordInput]}
            secureTextEntry={!showPassword}
            maxLength={128}
            editable={!submitting}
          />
          <Pressable onPress={() => setShowPassword(p => !p)} style={styles.eyeBtn}>
            <Text style={styles.eyeIcon}>{showPassword ? '🙈' : '👁️'}</Text>
          </Pressable>
        </View>

        {password.length > 0 && password.length < 6 ? (
          <Text style={styles.hint}>Password must be at least 6 characters ({password.length}/6)</Text>
        ) : null}

        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Pressable disabled={!ready || submitting} onPress={() => { void submit(); }} style={[S.primaryButton, (!ready || submitting) && {opacity: 0.45}]}>
          {submitting ? <ActivityIndicator color="#06251C"/> : <Text style={S.primaryText}>{isRegister ? 'Create account' : 'Sign in'}  →</Text>}
        </Pressable>
        <View style={styles.switchRow}>
          <Text style={styles.switchText}>{isRegister ? 'Already have an account?' : 'New to Nexa?'}</Text>
          <Text onPress={() => switchMode(isRegister ? 'login' : 'register')} style={styles.switchLink}>{isRegister ? ' Sign in' : ' Create account'}</Text>
        </View>
      </View>
      <View style={styles.footer}><Text style={styles.lock}>▣</Text><Text style={styles.footerText}>{demoMode ? 'Demo preview · No real account is created' : 'Account credentials are sent only over the configured TLS connection'}</Text></View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  wrap: {flexGrow: 1, padding: 24, paddingTop: TOP_INSET, paddingBottom: BOTTOM_INSET, justifyContent: 'space-between'},
  top: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  pill: {flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: C.line, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20},
  pulse: {width: 6, height: 6, borderRadius: 6, backgroundColor: C.green},
  pillText: {fontSize: 9, color: C.muted, letterSpacing: 1.1, fontWeight: '800'},
  serverBox: {marginTop: 14, padding: 12, backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 14, gap: 6},
  serverLabel: {color: C.muted, fontSize: 11, fontWeight: '600'},
  serverInput: {height: 42, fontSize: 13},
  hero: {marginTop: 28, marginBottom: 20},
  eyebrow: {color: C.green, letterSpacing: 2, fontSize: 10, fontWeight: '800', marginBottom: 11},
  title: {color: C.text, fontSize: 36, lineHeight: 40, fontWeight: '900', letterSpacing: -1.2},
  sub: {color: C.muted, fontSize: 13, marginTop: 12, lineHeight: 19, maxWidth: 270},
  card: {backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 24, padding: 20, gap: 13},
  cardTitle: {color: C.text, fontSize: 19, fontWeight: '800', marginBottom: 4},
  passwordContainer: {position: 'relative', justifyContent: 'center'},
  passwordInput: {paddingRight: 48},
  eyeBtn: {position: 'absolute', right: 12, height: 40, width: 40, alignItems: 'center', justifyContent: 'center'},
  eyeIcon: {fontSize: 18},
  hint: {color: C.muted, fontSize: 11, marginTop: -6, marginLeft: 4},
  switchRow: {flexDirection: 'row', justifyContent: 'center', marginTop: 2},
  switchText: {color: C.muted, fontSize: 12},
  switchLink: {color: C.green, fontWeight: '800', fontSize: 12},
  footer: {flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 20},
  lock: {color: C.green},
  footerText: {color: C.muted, fontSize: 10},
  error: {color: C.red, fontSize: 12, lineHeight: 18},
});
