import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StatusBar, View, Alert, Text, ActivityIndicator, AppState, AppStateStatus} from 'react-native';
import {AuthScreen} from './src/screens/AuthScreen';
import {HomeScreen, formatSnippet} from './src/screens/HomeScreen';
import {ChatScreen} from './src/screens/ChatScreen';
import {Chat, User, ChatMessage, MediaImageItem, VoiceNoteItem} from './src/types';
import {demoChats, demoUsers} from './src/state/demoData';
import {clearDemoSession, clearLiveSession, readDemoSession, readLiveSession, saveDemoSession, saveLiveSession} from './src/services/session';
import {APP_CONFIG, isLiveConfigReady} from './src/config';
import {TlsSignalingClient} from './src/services/signaling';
import {ServerDataChannel, RtcStatus} from './src/services/rtc';
import {e2eeService, RemotePreKeyBundle} from './src/services/e2ee';
import {
  getLocalMessages,
  saveLocalMessages,
  appendLocalMessage,
  updateLocalMessageStatus,
  saveSentMessageText,
  getSentMessageText,
  migrateLocalMessages,
} from './src/services/messageStore';
import {C, S} from './src/theme';
import {getMessageTimestamp} from './src/utils/time';
import {CallModal} from './src/components/CallModal';
import {callService, CallState} from './src/services/callService';

async function publishPrekeys(signal: TlsSignalingClient) {
  try {
    const bundle = await e2eeService.exportPreKeyBundle();
    await signal.request({type: 'publish_prekeys', bundle}, 'prekeys_published');
  } catch (err) {
    console.warn('Could not publish prekeys:', err);
  }
}

type Session = {uid?: string; username: string; displayName: string; about?: string; token?: string; live: boolean};
type InboxUser = {uid: string; username: string; display_name: string; about: string; online: boolean};
type InboxConversation = {conversation_id: string; user: InboxUser; unread_count: number; has_messages: boolean; updated_at: string};
type AuthResponse = {uid: string; username: string; display_name: string; about: string; token: string};

async function mapInbox(conversations: InboxConversation[]): Promise<Chat[]> {
  return Promise.all(conversations.map(async item => {
    const localMsgs = await getLocalMessages(item.conversation_id);
    const lastMsg = localMsgs.length > 0 ? localMsgs[localMsgs.length - 1] : null;
    const itemTimestamp = lastMsg?.timestamp || (Number(item.updated_at) ? Number(item.updated_at) * 1000 : Date.now());
    return {
      id: item.conversation_id,
      user: {id: item.user.uid, username: item.user.username, name: item.user.display_name, about: item.user.about, online: item.user.online},
      preview: lastMsg ? formatSnippet(lastMsg.text) : item.has_messages ? 'Encrypted message' : 'Start a conversation',
      time: lastMsg ? lastMsg.time : 'Recent',
      timestamp: itemTimestamp,
      unread: item.unread_count,
      messages: localMsgs,
    };
  }));
}

export default function App() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [session, setSession] = useState<Session | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selected, setSelected] = useState<Chat | null>(null);
  const selectedRef = useRef<Chat | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [rtcStatus, setRtcStatus] = useState<RtcStatus>('disconnected');
  const [callState, setCallState] = useState<CallState>(callService.getState());
  const signalRef = useRef<TlsSignalingClient | null>(null);
  const rtcRef = useRef<ServerDataChannel | null>(null);

  const attachSignalHandlers = useCallback((client: TlsSignalingClient) => {
    client.onFrame(frame => {
      if (frame.type === 'call_signal' && frame.from_uid && frame.payload) {
        void callService.handleSignal(String(frame.from_uid), frame.payload);
      } else if (frame.type === 'data_frame' && (frame as any).payload) {
        void processDataEnvelopeRef.current((frame as any).payload);
      }
    });
  }, []);

  const chatsRef = useRef<Chat[]>([]);
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  useEffect(() => {
    callService.setSignalSender((toUid, payload) => {
      const sig = signalRef.current;
      if (sig && sig.connected) {
        try {
          sig.send({type: 'call_signal', to_uid: toUid, payload});
          return;
        } catch {}
      }
      const rtc = rtcRef.current;
      if (rtc && rtc.isOpen) {
        try {
          rtc.sendControlFrame({type: 'call_signal', to_uid: toUid, payload});
          return;
        } catch {}
      }
    });

    const unsubscribe = callService.subscribe(state => {
      setCallState(state);
    });

    const unsubCallEnd = callService.onCallEnd(async event => {
      const now = event.timestamp;
      const isMe = event.isCaller;
      const isVideo = event.callType === 'video';
      const callIcon = isVideo ? '📹' : '📞';

      let title = '';
      if (event.status === 'completed') {
        title = `${callIcon} ${isVideo ? 'Video call' : 'Audio call'} · ${event.durationFormatted}`;
      } else if (event.status === 'missed') {
        if (!isMe) {
          title = `${callIcon} Missed ${isVideo ? 'video' : 'audio'} call`;
        } else {
          title = `${callIcon} ${isVideo ? 'Video call' : 'Audio call'} · No answer`;
        }
      } else if (event.status === 'declined') {
        title = `${callIcon} ${isVideo ? 'Video call' : 'Audio call'} · Declined`;
      } else {
        title = `${callIcon} ${isVideo ? 'Video call' : 'Audio call'} · Cancelled`;
      }

      const msgId = `call_${event.callId}_${now}`;
      const callMsg: ChatMessage = {
        id: msgId,
        from: isMe ? 'me' : 'them',
        text: title,
        time: new Date(now).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
        timestamp: now,
        status: 'seen',
        mediaType: 'call',
        callDetails: {
          callId: event.callId,
          callType: event.callType,
          durationSec: event.durationSec,
          durationFormatted: event.durationFormatted,
          status: event.status,
          isCaller: event.isCaller,
        },
      };

      const remoteUid = event.remoteUser.uid;
      const currentChats = chatsRef.current;
      const existingChat = currentChats.find(c => c.user.id === remoteUid);
      const conversationId = existingChat?.id || `cv_${remoteUid}`;

      // Persist to local database (AsyncStorage via messageStore)
      void appendLocalMessage(conversationId, callMsg);
      void saveSentMessageText(msgId, title);

      // Update in-memory state
      setChats(prev => {
        const found = prev.find(c => c.user.id === remoteUid);
        if (found) {
          const updatedChat = {
            ...found,
            preview: title,
            time: 'Now',
            timestamp: now,
            messages: [...found.messages, callMsg],
          };
          return [updatedChat, ...prev.filter(c => c.id !== found.id)];
        } else {
          const newChat: Chat = {
            id: conversationId,
            user: {
              id: remoteUid,
              username: event.remoteUser.name.toLowerCase().replace(/\s+/g, '_'),
              name: event.remoteUser.name,
              online: true,
            },
            preview: title,
            time: 'Now',
            timestamp: now,
            unread: 0,
            messages: [callMsg],
          };
          return [newChat, ...prev];
        }
      });

      setSelected(current => {
        if (current && current.user.id === remoteUid) {
          const updatedChat = {
            ...current,
            preview: title,
            time: 'Now',
            timestamp: now,
            messages: [...current.messages, callMsg],
          };
          selectedRef.current = updatedChat;
          return updatedChat;
        }
        return current;
      });
    });

    return () => {
      unsubscribe();
      unsubCallEnd();
    };
  }, []);

  const outboxRef = useRef<{
    messageId: string;
    conversationId: string;
    recipientUid: string;
    ciphertextB64: string;
  }[]>([]);

  const flushOutbox = useCallback(async () => {
    if (outboxRef.current.length === 0) return;
    const rtc = rtcRef.current;
    const sig = signalRef.current;
    if ((!rtc || !rtc.isOpen) && (!sig || !sig.connected)) return;

    const queue = [...outboxRef.current];
    outboxRef.current = [];
    for (const item of queue) {
      try {
        const payloadObj = {
          type: 'send_message',
          message_id: item.messageId,
          conversation_id: item.conversationId,
          ciphertext_b64: item.ciphertextB64,
        };
        if (rtc && rtc.isOpen) {
          await rtc.sendEncryptedEnvelope(JSON.stringify(payloadObj));
        } else if (sig && sig.connected) {
          sig.send({ type: 'data_frame', payload: payloadObj });
        }
      } catch {
        outboxRef.current.push(item);
      }
    }
  }, []);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const processDataEnvelope = useCallback(async (envelope: any) => {
    try {
      if (!envelope || typeof envelope !== 'object') return;
      if (envelope.type === 'error') {
        console.warn('Transport notification:', envelope);
      } else if (envelope.type === 'call_signal' && envelope.from_uid && envelope.payload) {
        void callService.handleSignal(String(envelope.from_uid), envelope.payload);
      } else if (['saved_ack', 'delivered_ack', 'seen_ack'].includes(envelope.type || '') && envelope.message_id) {
        const nextStatus = envelope.type === 'saved_ack' ? 'saved' : envelope.type === 'delivered_ack' ? 'delivered' : 'seen';
        const msgId = envelope.message_id;
        const convId = envelope.conversation_id || selectedRef.current?.id;
        if (convId) {
          void updateLocalMessageStatus(convId, msgId, nextStatus as any);
        }
        setChats(current => current.map(item => ({
          ...item,
          messages: item.messages.map(message => message.id === msgId ? {...message, status: nextStatus as 'saved' | 'delivered' | 'seen'} : message),
        })));
        setSelected(current => current ? ({
          ...current,
          messages: current.messages.map(message => message.id === msgId ? {...message, status: nextStatus as 'saved' | 'delivered' | 'seen'} : message),
        }) : current);
      } else if (envelope.type === 'presence_update' && envelope.uid && typeof envelope.online === 'boolean') {
        const targetUid = envelope.uid;
        const isOnline = envelope.online!;
        const now = Date.now();
        setChats(current => current.map(item => item.user.id === targetUid ? {
          ...item,
          user: {
            ...item.user,
            online: isOnline,
            lastActive: isOnline ? undefined : (item.user.lastActive || now),
          },
        } : item));
        setSelected(current => {
          if (!current || current.user.id !== targetUid) return current;
          const updated = {
            ...current,
            user: {
              ...current.user,
              online: isOnline,
              lastActive: isOnline ? undefined : (current.user.lastActive || now),
            },
          };
          selectedRef.current = updated;
          return updated;
        });
      } else if (envelope.type === 'new_conversation' && envelope.conversation_id && envelope.user) {
        const newChat: Chat = {
          id: envelope.conversation_id,
          user: {id: envelope.user.uid, username: envelope.user.username, name: envelope.user.display_name, about: envelope.user.about, online: envelope.user.online},
          preview: 'Start a conversation', time: 'Now', timestamp: Date.now(), unread: 0, messages: [],
        };
        setChats(current => current.some(item => item.id === newChat.id) ? current : [newChat, ...current]);
      } else if (envelope.type === 'new_message' && envelope.message) {
        const incoming = envelope.message;
        const handleIncoming = async () => {
          // Acknowledge delivered receipt immediately
          try {
            if (rtcRef.current?.isOpen) {
              rtcRef.current.sendControlFrame({type: 'delivered_ack', message_id: incoming.message_id});
            } else if (signalRef.current?.connected) {
              signalRef.current.send({type: 'data_frame', payload: {type: 'delivered_ack', message_id: incoming.message_id}});
            }
          } catch {}

          const isCurrentChat = selectedRef.current?.id === incoming.conversation_id;
          if (isCurrentChat) {
            try {
              if (rtcRef.current?.isOpen) {
                rtcRef.current.sendControlFrame({type: 'seen_ack', message_id: incoming.message_id});
              } else if (signalRef.current?.connected) {
                signalRef.current.send({type: 'data_frame', payload: {type: 'seen_ack', message_id: incoming.message_id}});
              }
            } catch {}
          }

          // Check in-memory first to avoid slow disk read on duplicates
          const currentSelected = selectedRef.current;
          if (currentSelected && currentSelected.id === incoming.conversation_id) {
            const alreadyInMemory = currentSelected.messages.find(m => m.id === incoming.message_id);
            if (alreadyInMemory && !alreadyInMemory.text.startsWith('Encrypted message') && !alreadyInMemory.text.startsWith('Decryption failed')) {
              return;
            }
          }

          let decryptedText = 'Encrypted message';
          try {
            decryptedText = await e2eeService.decrypt(incoming.sender_uid, 0, incoming.ciphertext_b64);
          } catch (err) {
            console.warn('Decryption failed:', err);
            decryptedText = 'Decryption failed · Bad MAC or missing session';
          }

          let msgMediaType: 'text' | 'image' | 'voice' = 'text';
          let msgImages: MediaImageItem[] | undefined = undefined;
          let msgIsHd: boolean | undefined = undefined;
          let msgVoice: VoiceNoteItem | undefined = undefined;
          let displayText = decryptedText;

          try {
            if (decryptedText.startsWith('{') && decryptedText.endsWith('}')) {
              const parsed = JSON.parse(decryptedText);
              if (parsed.type === 'image_batch' && Array.isArray(parsed.images)) {
                msgMediaType = 'image';
                msgImages = parsed.images;
                msgIsHd = !!parsed.isHd;
                displayText = parsed.caption || (parsed.images.length > 1 ? `📷 ${parsed.images.length} Photos` : '📷 Photo');
              } else if (parsed.type === 'voice_note' && parsed.audioBase64) {
                msgMediaType = 'voice';
                msgVoice = {
                  audioBase64: parsed.audioBase64,
                  durationSec: parsed.durationSec || 1,
                };
                displayText = `🎤 Voice message (${parsed.durationSec || 1}s)`;
              } else if (parsed.type === 'text' && typeof parsed.text === 'string') {
                displayText = parsed.text;
              }
            }
          } catch {}

          const incomingEpoch = Number(incoming.created_at) * 1000 || Date.now();
          const incomingMsg: ChatMessage = {
            id: incoming.message_id,
            from: 'them',
            text: displayText,
            time: new Date(incomingEpoch).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
            timestamp: incomingEpoch,
            status: isCurrentChat ? ('seen' as const) : ('delivered' as const),
            mediaType: msgMediaType,
            images: msgImages,
            isHd: msgIsHd,
            voice: msgVoice,
          };

          // 1. Instantly update UI (0ms delay) so incoming message appears in real time
          setChats(current => current.map(item => {
            if (item.id !== incoming.conversation_id) return item;
            const exists = item.messages.some(m => m.id === incoming.message_id);
            const msgs = exists ? item.messages.map(m => m.id === incoming.message_id ? incomingMsg : m) : [...item.messages, incomingMsg];
            return {
              ...item,
              preview: displayText,
              time: 'Now',
              timestamp: incomingEpoch,
              unread: isCurrentChat ? 0 : item.unread + 1,
              messages: msgs,
            };
          }));

          setSelected(current => {
            if (!current || current.id !== incoming.conversation_id) return current;
            const exists = current.messages.some(m => m.id === incoming.message_id);
            const msgs = exists ? current.messages.map(m => m.id === incoming.message_id ? incomingMsg : m) : [...current.messages, incomingMsg];
            const updatedChat = {
              ...current,
              preview: displayText,
              time: 'Now',
              timestamp: incomingEpoch,
              unread: 0,
              messages: msgs,
            };
            selectedRef.current = updatedChat;
            return updatedChat;
          });

          // 2. Persist to storage in background without blocking realtime flow
          void appendLocalMessage(incoming.conversation_id, incomingMsg);
        };
        void handleIncoming();
      }
    } catch (err) {
      console.warn('Error processing data envelope:', err);
    }
  }, []);

  const processDataEnvelopeRef = useRef(processDataEnvelope);
  useEffect(() => {
    processDataEnvelopeRef.current = processDataEnvelope;
  }, [processDataEnvelope]);

  const createRealtime = useCallback((signal: TlsSignalingClient) => {
    const rtc = new ServerDataChannel(signal);
    rtc.onConnectionStatus(status => {
      setRtcStatus(status);
      if (status === 'connected') {
        void flushOutbox();
      }
    });
    rtc.onMessage(packet => {
      try {
        const envelope = JSON.parse(packet);
        void processDataEnvelope(envelope);
      } catch (e) {
        console.warn('Malformed DataChannel packet:', e);
      }
    });
    return rtc;
  }, [flushOutbox, processDataEnvelope]);

  useEffect(() => {
    let cancelled = false;
    let bootSignal: TlsSignalingClient | null = null;
    let bootRtc: ServerDataChannel | null = null;

    const boot = async () => {
      try {
        const saved = await readLiveSession();
        if (!saved || cancelled) {
          setIsInitializing(false);
          return;
        }
        if (!isLiveConfigReady()) {
          setIsInitializing(false);
          return;
        }

        bootSignal = new TlsSignalingClient();
        attachSignalHandlers(bootSignal);
        await bootSignal.connect();
        const result = await bootSignal.request<AuthResponse>({type: 'resume', token: saved.token}, 'auth_ok');
        const inbox = await bootSignal.request<{conversations?: InboxConversation[]}>(
          {type: 'list_conversations'}, 'conversations');
        if (cancelled) { bootSignal.close(); return; }

        await saveLiveSession({uid: result.uid, username: result.username, displayName: result.display_name, about: result.about, token: result.token});
        if (cancelled) { bootSignal.close(); return; }
        signalRef.current = bootSignal;
        await publishPrekeys(bootSignal);
        bootRtc = createRealtime(bootSignal);
        rtcRef.current = bootRtc;
        setSession({uid: result.uid, username: result.username, displayName: result.display_name, about: result.about, token: result.token, live: true});
        setChats(await mapInbox(inbox.conversations || []));
        try {
          await bootRtc.connectAuthenticated();
        } catch {
          setRtcStatus('failed');
        }
      } catch (error) {
        bootRtc?.close();
        bootSignal?.close();
        await clearLiveSession();
        setSession(null);
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    };

    void boot().catch(() => {
      if (!cancelled) setIsInitializing(false);
    });

    return () => {
      cancelled = true;
      bootRtc?.close();
      bootSignal?.close();
    };
  }, [createRealtime]);

  useEffect(() => () => {
    rtcRef.current?.close();
    signalRef.current?.close();
  }, []);

  const reconnectingRef = useRef(false);

  const ensureConnected = useCallback(async (): Promise<boolean> => {
    if (!session?.live) return false;
    if (rtcRef.current?.isOpen) {
      setRtcStatus('connected');
      return true;
    }
    if (reconnectingRef.current) {
      for (let i = 0; i < 25; i++) {
        if (rtcRef.current?.isOpen) {
          setRtcStatus('connected');
          return true;
        }
        await new Promise<void>(r => setTimeout(r, 100));
      }
      return rtcRef.current?.isOpen || false;
    }

    reconnectingRef.current = true;
    try {
      setRtcStatus('connecting');

      // 1. Ensure TLS signaling connection is alive
      let signal = signalRef.current;
      let signalRecreated = false;
      if (!signal || !signal.connected) {
        try { signal?.close(); } catch {}
        signal = new TlsSignalingClient();
        attachSignalHandlers(signal);
        await signal.connect();
        signalRef.current = signal;
        signalRecreated = true;

        const token = session.token || (await readLiveSession())?.token;
        if (token) {
          await signal.request({type: 'resume', token}, 'auth_ok', 6000);
          await publishPrekeys(signal);
        }
      }

      // 2. Freshly connect WebRTC DataChannel (rebuild if signal was recreated or rtc is null)
      let rtc = rtcRef.current;
      if (!rtc || signalRecreated) {
        try { rtc?.close(); } catch {}
        rtc = createRealtime(signal);
        rtcRef.current = rtc;
      }
      try {
        await rtc.connectAuthenticated();
      } catch (rtcErr) {
        console.warn('WebRTC DataChannel setup error:', rtcErr);
      }

      // Check if either WebRTC DataChannel is open or TLS signaling is active
      for (let i = 0; i < 15; i++) {
        if (rtc.isOpen || signalRef.current?.connected) {
          setRtcStatus('connected');
          void flushOutbox();
          return true;
        }
        await new Promise<void>(r => setTimeout(r, 200));
      }

      if (rtc.isOpen || signalRef.current?.connected) {
        setRtcStatus('connected');
        void flushOutbox();
        return true;
      } else {
        setRtcStatus('disconnected');
        return false;
      }
    } catch (err) {
      console.warn('Auto-reconnect error:', err);
      if (signalRef.current?.connected) {
        setRtcStatus('connected');
        void flushOutbox();
        return true;
      } else {
        setRtcStatus('failed');
        return false;
      }
    } finally {
      reconnectingRef.current = false;
    }
  }, [session, createRealtime, flushOutbox]);

  // Auto-recovery watchdog: retries when disconnected or failed with 5s backoff
  useEffect(() => {
    if (!session?.live || rtcStatus === 'connected' || rtcStatus === 'connecting') return;
    const timer = setTimeout(() => {
      if (AppState.currentState === 'active') {
        void ensureConnected();
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [rtcStatus, session, ensureConnected]);

  // AppState listener for instant foreground reconnect and presence reporting
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'background') {
        // Proactively report offline to contacts when going to background, keep channel alive
        try {
          rtcRef.current?.sendControlFrame({type: 'presence_offline'});
        } catch {}
      } else if (nextState === 'active') {
        if (session?.live) {
          void ensureConnected();
        }
      }
    });
    return () => {
      sub.remove();
    };
  }, [session, ensureConnected]);

  const searchPeople = useCallback(async (query: string): Promise<User[]> => {
    if (APP_CONFIG.DEMO_MODE) {
      return demoUsers.filter(user => `${user.name} ${user.username}`.toLowerCase().includes(query.toLowerCase()));
    }
    const signal = signalRef.current;
    if (!signal?.connected) throw new Error('Server signaling connection is not available');
    const response = await signal.request<{users?: Array<{uid: string; username: string; display_name: string; about: string; online: boolean}>}>(
      {type: 'search_users', query}, 'users');
    return (response.users || []).map(user => ({
      id: user.uid, username: user.username, name: user.display_name, about: user.about, online: user.online,
    }));
  }, []);

  const openChat = async (chat: Chat) => {
    // 1. Immediately display locally persisted decrypted messages
    let localMsgs = await getLocalMessages(chat.id);
    if (localMsgs.length === 0 && chat.user?.id) {
      const legacyMsgs = await getLocalMessages(`c_${chat.user.id}`);
      if (legacyMsgs.length > 0) {
        await migrateLocalMessages(`c_${chat.user.id}`, chat.id);
        localMsgs = legacyMsgs;
      }
    }

    const initialMsgs = [...(localMsgs.length > 0 ? localMsgs : chat.messages)].sort(
      (a, b) => getMessageTimestamp(a) - getMessageTimestamp(b)
    );
    const lastM = initialMsgs.length > 0 ? initialMsgs[initialMsgs.length - 1] : null;
    const initialChat = {
      ...chat,
      unread: 0,
      preview: lastM ? formatSnippet(lastM.text) : chat.preview,
      timestamp: lastM?.timestamp || chat.timestamp || Date.now(),
      messages: initialMsgs,
    };
    setSelected(initialChat);
    selectedRef.current = initialChat;
    setChats(prev => prev.map(item => item.id === chat.id ? {...item, unread: 0} : item));

    // Send seen_ack for unread messages from peer
    for (const m of initialMsgs) {
      if (m.from === 'them' && m.status !== 'seen') {
        try {
          if (rtcRef.current?.isOpen) {
            rtcRef.current.sendControlFrame({type: 'seen_ack', message_id: m.id});
          } else if (signalRef.current?.connected) {
            signalRef.current.send({type: 'data_frame', payload: {type: 'seen_ack', message_id: m.id}});
          }
        } catch {}
      }
    }

    if (APP_CONFIG.DEMO_MODE) return;
    const signal = signalRef.current;
    if (!signal?.connected) return;

    try {
      const response = await signal.request<{
        messages?: Array<{message_id: string; sender_uid: string; ciphertext_b64: string; created_at: string; status: string}>;
      }>({
        type: 'conversation_history', conversation_id: chat.id,
      }, 'history');

      const serverMessages = response.messages || [];
      const localMap = new Map<string, any>();
      for (const m of initialMsgs) {
        localMap.set(m.id, m);
      }

      const merged: any[] = [];

      for (const sm of serverMessages) {
        const existing = localMap.get(sm.message_id);
        const serverStatus = (['SAVED', 'DELIVERED', 'SEEN'].includes(sm.status)
          ? sm.status.toLowerCase()
          : 'saved') as 'saved' | 'delivered' | 'seen';

        const smTimestamp = Number(sm.created_at) * 1000 || Date.now();

        if (existing && existing.text && existing.text !== 'Sent message' && !existing.text.startsWith('Encrypted message') && !existing.text.startsWith('Decryption failed')) {
          // Already decrypted and stored locally! Keep the plaintext!
          merged.push({
            ...existing,
            timestamp: existing.timestamp || smTimestamp,
            status: serverStatus,
          });
        } else {
          // New message or message with placeholder text needing restoration
          let text = existing?.text && existing.text !== 'Sent message' ? existing.text : 'Encrypted message';
          if (sm.sender_uid === session?.uid) {
            // Check persistent sent text cache first
            const cachedSent = await getSentMessageText(sm.message_id);
            if (cachedSent) {
              text = cachedSent;
            } else if (existing?.text && existing.text !== 'Sent message' && !existing.text.startsWith('Encrypted message')) {
              text = existing.text;
            } else {
              // Match against optimistic local sent message by timestamp
              const opt = initialMsgs.find(m =>
                m.from === 'me' &&
                m.text &&
                m.text !== 'Sent message' &&
                !m.text.startsWith('Encrypted message') &&
                Math.abs(getMessageTimestamp(m) - smTimestamp) < 30000
              );
              if (opt) {
                text = opt.text;
                await saveSentMessageText(sm.message_id, text);
              } else {
                text = existing?.text && existing.text !== 'Sent message' ? existing.text : 'Encrypted message';
              }
            }
          } else {
            try {
              text = await e2eeService.decrypt(sm.sender_uid, 0, sm.ciphertext_b64);
            } catch {
              text = existing?.text || 'Encrypted message';
            }
          }
          let msgMediaType: 'text' | 'image' | 'voice' = 'text';
          let msgImages: MediaImageItem[] | undefined = undefined;
          let msgIsHd: boolean | undefined = undefined;
          let msgVoice: VoiceNoteItem | undefined = undefined;
          let displayText = text;

          try {
            if (text.startsWith('{') && text.endsWith('}')) {
              const parsed = JSON.parse(text);
              if (parsed.type === 'image_batch' && Array.isArray(parsed.images)) {
                msgMediaType = 'image';
                msgImages = parsed.images;
                msgIsHd = !!parsed.isHd;
                displayText = parsed.caption || (parsed.images.length > 1 ? `📷 ${parsed.images.length} Photos` : '📷 Photo');
              } else if (parsed.type === 'voice_note' && parsed.audioBase64) {
                msgMediaType = 'voice';
                msgVoice = {
                  audioBase64: parsed.audioBase64,
                  durationSec: parsed.durationSec || 1,
                };
                displayText = `🎤 Voice message (${parsed.durationSec || 1}s)`;
              } else if (parsed.type === 'text' && typeof parsed.text === 'string') {
                displayText = parsed.text;
              }
            }
          } catch {}

          merged.push({
            id: sm.message_id,
            from: sm.sender_uid === session?.uid ? 'me' as const : 'them' as const,
            text: displayText,
            time: new Date(smTimestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
            timestamp: smTimestamp,
            status: serverStatus,
            mediaType: msgMediaType,
            images: msgImages,
            isHd: msgIsHd,
            voice: msgVoice,
          });
        }
      }

      // Preserve any optimistic messages not yet returned by server history
      for (const m of initialMsgs) {
        if (!merged.some(item => item.id === m.id)) {
          merged.push(m);
        }
      }

      // Ensure chronological ordering across all messages
      merged.sort((a, b) => {
        const timeA = getMessageTimestamp(a);
        const timeB = getMessageTimestamp(b);
        if (timeA !== timeB) return timeA - timeB;
        return a.id.localeCompare(b.id);
      });

      await saveLocalMessages(chat.id, merged);
      const lastMerged = merged.length > 0 ? merged[merged.length - 1] : null;
      const updated = {
        ...chat,
        unread: 0,
        preview: lastMerged ? formatSnippet(lastMerged.text) : chat.preview,
        timestamp: lastMerged?.timestamp || chat.timestamp,
        messages: merged,
      };
      setSelected(current => current?.id === chat.id ? updated : current);
      selectedRef.current = updated;
      setChats(prev => prev.map(item => item.id === chat.id ? updated : item));

      // Acknowledge seen for any incoming messages in the merged history
      for (const m of merged) {
        if (m.from === 'them' && m.status !== 'seen') {
          try {
            rtcRef.current?.sendControlFrame({type: 'seen_ack', message_id: m.id});
          } catch {}
        }
      }
    } catch (error) {
      console.warn('Could not load history:', error);
    }
  };

  const addChat = async (user: User) => {
    try {
      let conversationId = `c_${user.id}`;
      if (!APP_CONFIG.DEMO_MODE) {
        const signal = signalRef.current;
        if (!signal?.connected) throw new Error('Server signaling is disconnected');
        const response = await signal.request<{conversation_id: string}>(
          {type: 'create_conversation', other_uid: user.id}, 'conversation');
        conversationId = response.conversation_id;
      }
      const existing = chats.find(chat => chat.id === conversationId || chat.user.id === user.id);
      if (existing) {
        const canonical = {...existing, id: conversationId};
        if (existing.id !== conversationId) {
          await migrateLocalMessages(existing.id, conversationId);
        }
        setChats(prev => prev.map(c => (c.id === existing.id || c.user.id === user.id) ? canonical : c));
        await openChat(canonical);
        return;
      }
      const newChat: Chat = {id: conversationId, user, preview: 'Start a conversation', time: 'Now', timestamp: Date.now(), unread: 0, messages: []};
      setChats(prev => [newChat, ...prev]);
      await openChat(newChat);
    } catch (error) {
      Alert.alert('Could not open conversation', error instanceof Error ? error.message : 'Please try again.');
    }
  };

  const sendMessage = async (
    content:
      | string
      | {
          text?: string;
          mediaType?: 'text' | 'image' | 'voice';
          images?: MediaImageItem[];
          isHd?: boolean;
          voice?: VoiceNoteItem;
        },
  ) => {
    if (!selected) return;
    const recipientUid = selected.user.id;
    let conversationId = selected.id;
    const signal = signalRef.current;
    let rtc = rtcRef.current;

    // Normalize content
    let text = typeof content === 'string' ? content : content.text || '';
    const mediaType = typeof content === 'object' ? content.mediaType || 'text' : 'text';
    const images = typeof content === 'object' ? content.images : undefined;
    const isHd = typeof content === 'object' ? content.isHd : undefined;
    const voice = typeof content === 'object' ? content.voice : undefined;

    let plaintextPayload = text;
    if (mediaType === 'image' && images) {
      plaintextPayload = JSON.stringify({
        type: 'image_batch',
        images,
        isHd: !!isHd,
        caption: text,
      });
      if (!text) {
        text = images.length > 1 ? `📷 ${images.length} Photos` : '📷 Photo';
      }
    } else if (mediaType === 'voice' && voice) {
      plaintextPayload = JSON.stringify({
        type: 'voice_note',
        audioBase64: voice.audioBase64,
        durationSec: voice.durationSec,
      });
      text = `🎤 Voice message (${voice.durationSec}s)`;
    } else {
      plaintextPayload = JSON.stringify({
        type: 'text',
        text,
      });
    }

    // Ensure conversation exists on server and has canonical 'cv_' id
    if (!APP_CONFIG.DEMO_MODE && (!conversationId || conversationId.startsWith('c_'))) {
      if (signal?.connected) {
        try {
          const res = await signal.request<{conversation_id: string}>(
            {type: 'create_conversation', other_uid: recipientUid}, 'conversation'
          );
          if (res.conversation_id) {
            const oldId = conversationId;
            conversationId = res.conversation_id;
            if (oldId !== conversationId) {
              await migrateLocalMessages(oldId, conversationId);
            }
            const updatedChat = {...selected, id: conversationId};
            setSelected(updatedChat);
            selectedRef.current = updatedChat;
            setChats(prev => prev.map(c => c.user.id === recipientUid ? {...c, id: conversationId} : c));
          }
        } catch (e) {
          console.warn('Could not ensure canonical conversation:', e);
        }
      }
    }

    const now = Date.now();
    const tempMsgId = `m_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const tempMsg: ChatMessage = {
      id: tempMsgId,
      from: 'me',
      text,
      time: new Date(now).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
      timestamp: now,
      status: 'saved',
      mediaType,
      images,
      isHd,
      voice,
    };

    // 1. Instantly update in-memory UI (0ms delay) so sent bubble appears immediately
    const optimisticMessages = [...selected.messages, tempMsg];
    const updated = {...selected, id: conversationId, preview: text, time: 'Now', timestamp: now, unread: 0, messages: optimisticMessages};
    setSelected(updated);
    selectedRef.current = updated;
    setChats(prev => [updated, ...prev.filter(chat => chat.id !== conversationId && chat.user.id !== recipientUid)]);

    // 2. Persist to storage in background without blocking realtime network send
    void saveSentMessageText(tempMsgId, text);
    void appendLocalMessage(conversationId, tempMsg);

    try {
      const hasSession = await e2eeService.hasSession(recipientUid);
      if (!hasSession) {
        if (!signal?.connected) throw new Error('Signaling server is not connected');
        const res = await signal.request<{uid: string; bundle: RemotePreKeyBundle}>(
          {type: 'get_prekey_bundle', uid: recipientUid},
          'prekey_bundle'
        );
        if (!res.bundle) throw new Error('Recipient has not published encryption prekeys');
        await e2eeService.establishSessionWithPeer(recipientUid, res.bundle);
      }

      const {body_b64} = await e2eeService.encrypt(recipientUid, plaintextPayload);

      const queueItem = {
        messageId: tempMsgId,
        conversationId,
        recipientUid,
        ciphertextB64: body_b64,
      };

      const payloadObj = {
        type: 'send_message',
        message_id: tempMsgId,
        conversation_id: conversationId,
        ciphertext_b64: body_b64,
      };

      if (rtc && rtc.isOpen) {
        try {
          await rtc.sendEncryptedEnvelope(JSON.stringify(payloadObj));
        } catch (sendErr) {
          outboxRef.current.push(queueItem);
          throw sendErr;
        }
      } else if (signal && signal.connected) {
        try {
          signal.send({ type: 'data_frame', payload: payloadObj });
        } catch (sendErr) {
          outboxRef.current.push(queueItem);
          throw sendErr;
        }
      } else {
        outboxRef.current.push(queueItem);
        void ensureConnected().then(connected => {
          if (connected) void flushOutbox();
        });
      }
    } catch (err) {
      console.warn('Send issue:', err);
    }
  };

  const submitAuth = async (name: string, username: string, password: string) => {
    if (authBusy) return;
    setAuthBusy(true);
    let pendingSignal: TlsSignalingClient | null = null;
    try {
      if (!username.trim() || !password) {
        throw new Error('Invalid username or password.');
      }
      if (!isLiveConfigReady()) {
        throw new Error('Set the real Rust signaling hostname and ICE server in mobile/src/config.ts first.');
      }

      // Proactively clear any stale/residual session credentials before authenticating fresh
      await clearLiveSession();
      await clearDemoSession();

      pendingSignal = new TlsSignalingClient();
      attachSignalHandlers(pendingSignal);
      await pendingSignal.connect();
      const authFrame = mode === 'register'
        ? {type: 'register', username: username.trim().toLowerCase(), display_name: name.trim() || username.trim(), password}
        : {type: 'login', username: username.trim().toLowerCase(), password};

      const result = await pendingSignal.request<AuthResponse>(authFrame, 'auth_ok');
      if (!result?.token || !result?.uid) {
        throw new Error('Invalid username or password.');
      }

      const inbox = await pendingSignal.request<{conversations?: Array<{conversation_id: string; user: {uid: string; username: string; display_name: string; about: string; online: boolean}; unread_count: number; has_messages: boolean; updated_at: string}>}>(
        {type: 'list_conversations'}, 'conversations');

      await saveLiveSession({
        uid: result.uid,
        username: result.username,
        displayName: result.display_name,
        about: result.about,
        token: result.token,
      });

      signalRef.current = pendingSignal;
      await publishPrekeys(pendingSignal);
      const rtc = createRealtime(pendingSignal);
      rtcRef.current = rtc;
      setSession({
        uid: result.uid,
        username: result.username,
        displayName: result.display_name,
        about: result.about,
        token: result.token,
        live: true,
      });
      setChats(await mapInbox(inbox.conversations || []));

      try {
        await rtc.connectAuthenticated();
      } catch {
        setRtcStatus('failed');
      }
      pendingSignal = null;
    } catch (error) {
      pendingSignal?.close();
      if (signalRef.current === pendingSignal) signalRef.current = null;
      await clearLiveSession();
      setSession(null);
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.toLowerCase().includes('password') ||
        msg.toLowerCase().includes('username') ||
        msg.toLowerCase().includes('login_failed') ||
        msg.toLowerCase().includes('invalid') ||
        msg.toLowerCase().includes('credentials')
      ) {
        throw new Error('Invalid username or password.');
      }
      throw error;
    } finally {
      setAuthBusy(false);
    }
  };

  const updateProfile = async (displayName: string, about: string) => {
    if (!session?.live) throw new Error('Profile editing requires a live server account.');
    const signal = signalRef.current;
    if (!signal?.connected) throw new Error('Server connection is unavailable.');
    const response = await signal.request<{user: {display_name: string; about: string}}>({
      type: 'update_profile', display_name: displayName, about,
    }, 'profile_updated');
    setSession(current => current ? {...current, displayName: response.user.display_name, about: response.user.about} : current);
    if (session.token && session.uid) {
      await saveLiveSession({uid: session.uid, username: session.username, displayName: response.user.display_name, about: response.user.about, token: session.token});
    }
  };

  const logout = async () => {
    const activeSignal = signalRef.current;
    if (session?.live && activeSignal?.connected) {
      try { await activeSignal.request({type: 'logout'}, 'logged_out', 5000); } catch {}
    }
    rtcRef.current?.close();
    rtcRef.current = null;
    signalRef.current?.close();
    signalRef.current = null;
    setRtcStatus('disconnected');
    await clearLiveSession();
    await clearDemoSession();
    setSession(null);
    setSelected(null);
    setChats([]);
    setMode('login');
  };

  return <View style={{flex: 1, backgroundColor: C.bg}}>
    <StatusBar barStyle="light-content"/>
    {isInitializing ? (
      <View style={[S.screen, {justifyContent: 'center', alignItems: 'center'}]}>
        <ActivityIndicator size="large" color={C.green}/>
        <Text style={{color: C.muted, marginTop: 14, fontSize: 13}}>Restoring secure session...</Text>
      </View>
    ) : selected && session ? (
      <ChatScreen
        chat={selected}
        liveMode={session.live}
        rtcStatus={rtcStatus}
        onBack={() => { setSelected(null); selectedRef.current = null; }}
        onSend={sendMessage}
        onStartCall={(user, callType) => {
          void callService.startCall(
            {uid: user.id, name: user.name},
            callType,
            session.displayName || session.username || 'Me'
          );
        }}
      />
    ) : session ? (
      <HomeScreen
        username={session.username}
        uid={session.uid}
        displayName={session.displayName}
        about={session.about}
        liveMode={session.live}
        rtcStatus={rtcStatus}
        chats={chats}
        people={[]}
        onSearchPeople={searchPeople}
        onOpenChat={openChat}
        onLogout={logout}
        onAddChat={user => { void addChat(user); }}
        onUpdateProfile={updateProfile}
      />
    ) : (
      <AuthScreen mode={mode} onMode={setMode} onSubmit={submitAuth} busy={authBusy} demoMode={APP_CONFIG.DEMO_MODE}/>
    )}
    <CallModal
      callState={callState}
      myDisplayName={session?.displayName || session?.username || 'Me'}
    />
  </View>;
}
