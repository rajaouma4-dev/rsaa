import AsyncStorage from '@react-native-async-storage/async-storage';
import {ChatMessage} from '../types';
import {advanceMessageStatus} from './messageStatus';
import {getMessageTimestamp} from '../utils/time';

const MSG_PREFIX = 'nexa.chat.messages.v2.';
const SENT_TEXT_PREFIX = 'nexa.sent_text.v1.';

// High-speed in-memory cache to eliminate repetitive AsyncStorage JSON parsing lag
const memoryCache = new Map<string, ChatMessage[]>();
const mutations = new Map<string, Promise<unknown>>();

function serial<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
  const next = (mutations.get(conversationId) || Promise.resolve()).catch(() => {}).then(operation);
  mutations.set(conversationId, next);
  void next.finally(() => {
    if (mutations.get(conversationId) === next) mutations.delete(conversationId);
  }).catch(() => {});
  return next;
}

export async function getLocalMessages(conversationId: string): Promise<ChatMessage[]> {
  const cached = memoryCache.get(conversationId);
  if (cached) return cached;
  const raw = await AsyncStorage.getItem(MSG_PREFIX + conversationId);
  const list: ChatMessage[] = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(list)) throw new Error('Invalid local message history');
  const sorted = list.sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));
  // A read started before a committed write must not replace newer cache state.
  if (!memoryCache.has(conversationId)) memoryCache.set(conversationId, sorted);
  return memoryCache.get(conversationId)!;
}

async function persist(conversationId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
  const sorted = [...messages].sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b)).slice(-500);
  await AsyncStorage.setItem(MSG_PREFIX + conversationId, JSON.stringify(sorted));
  memoryCache.set(conversationId, sorted);
  return sorted;
}

function mergeMessage(previous: ChatMessage | undefined, next: ChatMessage): ChatMessage {
  return previous ? {...previous, ...next, status: advanceMessageStatus(previous.status, next.status)} : next;
}

export async function saveLocalMessages(conversationId: string, messages: ChatMessage[]): Promise<void> {
  await serial(conversationId, async () => {
    const byId = new Map((await getLocalMessages(conversationId)).map(m => [m.id, m]));
    for (const message of messages) byId.set(message.id, mergeMessage(byId.get(message.id), message));
    await persist(conversationId, [...byId.values()]);
  });
}

export function appendLocalMessage(conversationId: string, message: ChatMessage): Promise<ChatMessage[]> {
  return serial(conversationId, async () => {
    const current = await getLocalMessages(conversationId);
    const previous = current.find(m => m.id === message.id);
    const merged = mergeMessage(previous, message);
    return persist(conversationId, previous ? current.map(m => m.id === message.id ? merged : m) : [...current, merged]);
  });
}

export async function updateLocalMessageStatus(
  conversationId: string,
  messageId: string,
  status: 'saved' | 'delivered' | 'seen',
): Promise<void> {
  await serial(conversationId, async () => {
    const current = await getLocalMessages(conversationId);
    const updated = current.map(m => m.id === messageId ? {...m, status: advanceMessageStatus(m.status, status)} : m);
    if (updated.some((m, i) => m.status !== current[i].status)) await persist(conversationId, updated);
  });
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
