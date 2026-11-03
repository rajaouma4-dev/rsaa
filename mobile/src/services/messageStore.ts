import AsyncStorage from '@react-native-async-storage/async-storage';
import {ChatMessage} from '../types';
import {advanceMessageStatus} from './messageStatus';
import {getMessageTimestamp} from '../utils/time';

const MSG_PREFIX = 'nexa.chat.messages.v2.';
const SENT_TEXT_PREFIX = 'nexa.sent_text.v1.';

// High-speed in-memory cache to eliminate repetitive AsyncStorage JSON parsing lag
const memoryCache = new Map<string, ChatMessage[]>();
const pendingSaveTimers = new Map<string, any>();

export async function getLocalMessages(conversationId: string): Promise<ChatMessage[]> {
  if (memoryCache.has(conversationId)) {
    return memoryCache.get(conversationId)!;
  }
  try {
    const raw = await AsyncStorage.getItem(MSG_PREFIX + conversationId);
    if (!raw) {
      memoryCache.set(conversationId, []);
      return [];
    }
    const list = JSON.parse(raw) as ChatMessage[];
    const sorted = list.sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));
    memoryCache.set(conversationId, sorted);
    return sorted;
  } catch {
    return [];
  }
}

export async function saveLocalMessages(conversationId: string, messages: ChatMessage[]): Promise<void> {
  const sorted = [...messages].sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));
  const trimmed = sorted.slice(-500);
  memoryCache.set(conversationId, trimmed);

  // Clear any existing debounce timer for this conversation
  if (pendingSaveTimers.has(conversationId)) {
    clearTimeout(pendingSaveTimers.get(conversationId));
  }

  // Debounced write to AsyncStorage so rapid status updates never lock the SQLite thread
  const timer = setTimeout(async () => {
    pendingSaveTimers.delete(conversationId);
    try {
      await AsyncStorage.setItem(MSG_PREFIX + conversationId, JSON.stringify(trimmed));
    } catch (err) {
      console.warn('Failed to persist local messages:', err);
    }
  }, 300);
  pendingSaveTimers.set(conversationId, timer);
}

export async function appendLocalMessage(conversationId: string, message: ChatMessage): Promise<ChatMessage[]> {
  try {
    const current = await getLocalMessages(conversationId);
    let updated: ChatMessage[];
    if (current.some(m => m.id === message.id)) {
      updated = current.map(m => m.id === message.id ? {...m, ...message} : m);
    } else {
      updated = [...current, message];
    }
    updated.sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));
    await saveLocalMessages(conversationId, updated);
    return updated;
  } catch {
    return [message];
  }
}

export async function updateLocalMessageStatus(
  conversationId: string,
  messageId: string,
  status: 'saved' | 'delivered' | 'seen',
): Promise<void> {
  try {
    const current = await getLocalMessages(conversationId);
    let changed = false;
    const updated = current.map(m => {
      if (m.id === messageId && m.status !== status) {
        changed = true;
        return {...m, status: advanceMessageStatus(m.status, status)};
      }
      return m;
    });
    if (changed) {
      await saveLocalMessages(conversationId, updated);
    }
  } catch {}
}

export async function getConversationPreview(conversationId: string): Promise<string | null> {
  try {
    const msgs = await getLocalMessages(conversationId);
    if (msgs.length > 0) {
      return msgs[msgs.length - 1].text;
    }
    return null;
  } catch {
    return null;
  }
}

const sentTextMemory = new Map<string, string>();

export async function saveSentMessageText(messageId: string, text: string): Promise<void> {
  try {
    if (!messageId || !text) return;
    sentTextMemory.set(messageId, text);
    await AsyncStorage.setItem(SENT_TEXT_PREFIX + messageId, text);
  } catch {}
}

export async function getSentMessageText(messageId: string): Promise<string | null> {
  if (sentTextMemory.has(messageId)) {
    return sentTextMemory.get(messageId)!;
  }
  try {
    if (!messageId) return null;
    const text = await AsyncStorage.getItem(SENT_TEXT_PREFIX + messageId);
    if (text) {
      sentTextMemory.set(messageId, text);
    }
    return text;
  } catch {
    return null;
  }
}

export async function migrateLocalMessages(oldConvId: string, newConvId: string): Promise<void> {
  if (!oldConvId || !newConvId || oldConvId === newConvId) return;
  try {
    const oldMsgs = await getLocalMessages(oldConvId);
    if (oldMsgs.length === 0) return;
    const newMsgs = await getLocalMessages(newConvId);
    const idMap = new Map<string, ChatMessage>();
    for (const m of oldMsgs) idMap.set(m.id, m);
    for (const m of newMsgs) idMap.set(m.id, m);
    const combined = Array.from(idMap.values()).sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));
    await saveLocalMessages(newConvId, combined);
  } catch (err) {
    console.warn('Migration failed:', err);
  }
}
