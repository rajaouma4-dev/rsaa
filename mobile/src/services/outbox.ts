import AsyncStorage from '@react-native-async-storage/async-storage';

export interface OutgoingEnvelope {
  messageId: string;
  conversationId: string;
  recipientUid: string;
  ciphertextB64: string;
  msgType?: number;
}

// Only ciphertext is persisted here. A new instance is bound to one account.
export class DurableOutbox {
  private items: OutgoingEnvelope[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private attempts = new Map<string, number>();
  private constructor(private key: string) {}

  static async open(uid: string): Promise<DurableOutbox> {
    if (!uid) throw new Error('Account required for outgoing queue');
    const queue = new DurableOutbox('nexa.outbox.v1.' + uid);
    const raw = await AsyncStorage.getItem(queue.key);
    const items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items) || items.some(m => !m.messageId || !m.conversationId || !m.recipientUid || typeof m.ciphertextB64 !== 'string')) {
      throw new Error('Invalid outgoing queue');
    }
    queue.items = items;
    return queue;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(operation);
    this.tail = next;
    return next;
  }

  enqueue(item: OutgoingEnvelope): Promise<void> {
    return this.serial(async () => {
      if (this.items.some(m => m.messageId === item.messageId)) return;
      const next = [...this.items, item];
      if (next.length > 1000 || next.reduce((n, m) => n + m.ciphertextB64.length, 0) > 32 * 1024 * 1024) {
        throw new Error('Outgoing queue full. Reconnect before sending more.');
      }
      await AsyncStorage.setItem(this.key, JSON.stringify(next));
      this.items = next;
    });
  }

  acknowledge(messageId: string): Promise<OutgoingEnvelope | undefined> {
    return this.serial(async () => {
      const item = this.items.find(m => m.messageId === messageId);
      if (!item) return;
      const next = this.items.filter(m => m.messageId !== messageId);
      await AsyncStorage.setItem(this.key, JSON.stringify(next));
      this.items = next;
      this.attempts.delete(messageId);
      return item;
    });
  }

  due(limit = 16): OutgoingEnvelope[] {
    return this.items.filter(m => Date.now() - (this.attempts.get(m.messageId) || 0) >= 2000).sort((a, b) => a.ciphertextB64.length - b.ciphertextB64.length).slice(0, limit);
  }
  attempted(messageId: string): void { this.attempts.set(messageId, Date.now()); }
}
