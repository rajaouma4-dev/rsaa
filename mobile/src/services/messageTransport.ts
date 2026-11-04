import {Buffer} from 'buffer';
import {APP_CONFIG} from '../config';
import type {OutgoingEnvelope} from './outbox';

type Signal = {authenticated: boolean; send(frame: any): void};
type Realtime = {isOpen: boolean; sendEncryptedEnvelope(body: string): Promise<void>};
type ReceiptRealtime = {isOpen: boolean; sendControlFrame(frame: {type:'delivered_ack'|'seen_ack'; message_id:string}): void};

export function sendMessageReceipt(type:'delivered_ack'|'seen_ack', id:string, signal:Signal|null, rtc:ReceiptRealtime|null): boolean {
  const payload={type,message_id:id};
  try { if(signal?.authenticated) {signal.send({type:'data_frame',payload});return true;} } catch {}
  try { if(rtc?.isOpen) {rtc.sendControlFrame(payload);return true;} } catch {}
  return false;
}

/** Select a ready transport AFTER encryption and durable enqueue. Never wait for ICE for text. */
export function sendQueuedEnvelope(item: OutgoingEnvelope, signal: Signal | null, rtc: Realtime | null): Promise<void> | null {
  const payload = {type:'send_message', message_id:item.messageId, conversation_id:item.conversationId,
    recipient_uid:item.recipientUid, ciphertext_b64:item.ciphertextB64, msg_type:item.msgType};
  const frame = {type:'data_frame', payload};
  // Leave room for the server's recipient envelope and its 60 KiB relay cap.
  const tlsLimit=Math.min(APP_CONFIG.MAX_SIGNAL_FRAME_BYTES,60*1024-1024);
  if (signal?.authenticated && Buffer.byteLength(JSON.stringify(frame) + '\n', 'utf8') <= tlsLimit) {
    signal.send(frame);
    return Promise.resolve();
  }
  return rtc?.isOpen ? rtc.sendEncryptedEnvelope(JSON.stringify(payload)) : null;
}
