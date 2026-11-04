type Incoming = {id: string; from: string; status?: string};

/** Reconcile a chat that stayed selected while the app was on Home.
 * Keep local delivery status intact so an interrupted transport can retry.
 */
export async function acknowledgeVisibleMessages(options: {
  conversation(): string | null;
  visible(): boolean;
  load(id: string): Promise<Incoming[]>;
  sendSeen(id: string): boolean;
  acknowledged: Set<string>;
  markRead(id: string): void;
}): Promise<boolean> {
  const id = options.conversation();
  if (!id || !options.visible()) return false;
  const messages = await options.load(id);
  if (options.conversation() !== id || !options.visible()) return false;
  for (const message of messages) {
    if (message.from !== 'them' || message.status === 'seen' || options.acknowledged.has(message.id)) continue;
    try { if (!options.sendSeen(message.id)) return false; } catch { return false; }
    options.acknowledged.add(message.id);
  }
  if (options.conversation() !== id || !options.visible()) return false;
  options.markRead(id);
  return true;
}
