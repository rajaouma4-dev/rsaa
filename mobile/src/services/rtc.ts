import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'react-native-webrtc';
import {APP_CONFIG} from '../config';
import {TlsSignalingClient} from './signaling';

type RTCDataChannel = ReturnType<RTCPeerConnection['createDataChannel']>;

export type RtcStatus = 'connecting' | 'signaling' | 'connected' | 'disconnected' | 'failed';

export type CandidateType = 'host' | 'srflx' | 'relay' | 'unknown';

export interface CandidateInfo {
  type: CandidateType;
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface SelectedPairInfo {
  localType: CandidateType;
  remoteType: CandidateType;
  state: string;
}

function parseCandidateType(candStr: string): CandidateType {
  const match = candStr.match(/typ\s+(\w+)/i);
  if (match) {
    const raw = match[1].toLowerCase();
    if (raw === 'host' || raw === 'srflx' || raw === 'relay') return raw;
  }
  return 'unknown';
}

/**
 * Connects one Android client to its Rust server peer using WebRTC DataChannel.
 * Users never P2P-connect directly to each other; all messages are end-to-end
 * encrypted via Signal Protocol and routed: Client A -> Rust Server -> Client B.
 *
 * Configured strictly with Google's public STUN server (stun:stun.l.google.com:19302)
 * for ICE NAT discovery without any TURN relay.
 */
export class ServerDataChannel {
  private pc: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private onPacket?: (packet: string) => void;
  private onStatus?: (status: RtcStatus) => void;
  private pendingRemoteCandidates: any[] = [];
  private pendingLocalCandidates: any[] = [];
  private removeSignalListener?: () => void;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private connectTimeoutTimer?: ReturnType<typeof setTimeout>;
  private gatheredLocalCandidates: CandidateInfo[] = [];
  private receivedRemoteCandidates: CandidateInfo[] = [];
  private selectedPair: SelectedPairInfo | null = null;
  private offerSent = false;
  private isDestroyed = false;
  private incomingChunks = new Map<string, {total: number; chunks: Map<number, string>; timer: any}>();

  constructor(private readonly signal: TlsSignalingClient) {
    this.pc = this.createPeerConnection();
  }

  private createPeerConnection(): RTCPeerConnection {
    return new RTCPeerConnection({
      iceServers: APP_CONFIG.ICE_SERVERS as any,
      iceTransportPolicy: APP_CONFIG.ICE_TRANSPORT_POLICY,
    });
  }

  onMessage(callback: (packet: string) => void): void { this.onPacket = callback; }
  onConnectionStatus(callback: (status: RtcStatus) => void): void { this.onStatus = callback; }

  get isOpen(): boolean {
    return this.channel?.readyState === 'open';
  }

  getGatheredLocalCandidates(): CandidateInfo[] {
    return [...this.gatheredLocalCandidates];
  }

  getReceivedRemoteCandidates(): CandidateInfo[] {
    return [...this.receivedRemoteCandidates];
  }

  async getSelectedCandidatePair(): Promise<SelectedPairInfo | null> {
    if (this.selectedPair) return this.selectedPair;
    try {
      const stats = await this.pc.getStats();
      if (!stats) return null;
      let activePair: any = null;
      const candidates = new Map<string, any>();

      stats.forEach((report: any) => {
        if (report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded')) {
          activePair = report;
        } else if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates.set(report.id, report);
        }
      });

      if (activePair) {
        const local = candidates.get(activePair.localCandidateId);
        const remote = candidates.get(activePair.remoteCandidateId);
        const localType: CandidateType = local?.candidateType || 'unknown';
        const remoteType: CandidateType = remote?.candidateType || 'unknown';
        this.selectedPair = {localType, remoteType, state: activePair.state || 'succeeded'};
        return this.selectedPair;
      }
    } catch {
      // getStats error or unsupported on platform
    }
    return null;
  }

  /** Call after this TLS signaling connection has completed login/register/resume. */
  async connectAuthenticated(): Promise<void> {
    if (!this.signal.connected) throw new Error('Signaling must be authenticated before WebRTC setup');
    this.isDestroyed = false;
    this.cleanupPeer();
    this.removeSignalListener?.();
    this.removeSignalListener = undefined;
    this.pc = this.createPeerConnection();

    this.onStatus?.('connecting');

    // 15-second connection watchdog: if ICE cannot complete via Google STUN, fallback seamlessly to TLS signaling
    if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
    this.connectTimeoutTimer = setTimeout(() => {
      if (this.pc.connectionState !== 'connected' && this.channel?.readyState !== 'open') {
        if (this.signal.connected) {
          this.onStatus?.('connected');
        } else {
          this.onStatus?.('failed');
        }
      }
    }, 15000);

    this.channel = this.pc.createDataChannel('nexa-control', {ordered: true});
    this.channel.onopen = () => {
      if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
      this.onStatus?.('connected');
      void this.getSelectedCandidatePair();

      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = setInterval(() => {
        if (this.channel?.readyState === 'open') {
          try { this.channel.send(JSON.stringify({type: 'ping'})); } catch { /* connection state handles failure */ }
        }
      }, 12_000);
    };

    this.channel.onclose = () => {
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
      if (this.signal.connected) {
        this.onStatus?.('connected');
      } else {
        this.onStatus?.('disconnected');
      }
    };

    this.channel.onerror = (e: any) => {
      console.warn('WebRTC DataChannel error event:', e);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') {
        if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
        this.onStatus?.('connected');
        void this.getSelectedCandidatePair();
      } else if (state === 'failed') {
        if (this.signal.connected) {
          this.onStatus?.('connected');
        } else {
          this.onStatus?.('failed');
        }
      } else if (state === 'closed' || state === 'disconnected') {
        if (this.signal.connected) {
          this.onStatus?.('connected');
        } else {
          this.onStatus?.('disconnected');
        }
      } else if (state === 'connecting') {
        if (this.signal.connected) {
          this.onStatus?.('connected');
        } else {
          this.onStatus?.('connecting');
        }
      }
    };

    // Network switching support: when ICE connection transitions to disconnected (e.g. Wi-Fi -> 4G),
    // wait briefly for ICE to heal or re-gather
    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc.iceConnectionState;
      if (iceState === 'disconnected') {
        if (this.signal.connected) {
          this.onStatus?.('connected');
        } else {
          this.onStatus?.('disconnected');
        }
      } else if (iceState === 'failed') {
        // Safe ICE restart attempt before declaring final failure
        void this.restartIce();
      }
    };

    this.channel.onmessage = (event: any) => {
      const raw = String(event.data || '');
      if (raw.startsWith('{"type":"chunk"') || raw.includes('"type":"chunk"')) {
        try {
          const parsed = JSON.parse(raw);
          if (
            parsed.type === 'chunk' &&
            typeof parsed.transfer_id === 'string' &&
            typeof parsed.index === 'number' &&
            typeof parsed.total === 'number' &&
            typeof parsed.data === 'string'
          ) {
            const transferId = parsed.transfer_id;
            let entry = this.incomingChunks.get(transferId);
            if (!entry) {
              if (this.incomingChunks.size > 100) {
                this.incomingChunks.forEach(item => clearTimeout(item.timer));
                this.incomingChunks.clear();
              }
              const timer = setTimeout(() => {
                this.incomingChunks.delete(transferId);
              }, 45000);
              entry = {total: parsed.total, chunks: new Map<number, string>(), timer};
              this.incomingChunks.set(transferId, entry);
            }
            entry.chunks.set(parsed.index, parsed.data);
            if (entry.chunks.size === entry.total) {
              clearTimeout(entry.timer);
              let full = '';
              for (let i = 0; i < entry.total; i++) {
                full += entry.chunks.get(i) || '';
              }
              this.incomingChunks.delete(transferId);
              this.onPacket?.(full);
            }
            return;
          }
        } catch {}
      }
      this.onPacket?.(raw);
    };

    this.offerSent = false;
    this.pc.onicecandidate = (event: any) => {
      if (!event.candidate) return;
      const candidateObj = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
      const rawCand = String(candidateObj.candidate || '');
      const type = parseCandidateType(rawCand);

      this.gatheredLocalCandidates.push({
        type,
        candidate: rawCand,
        sdpMid: candidateObj.sdpMid,
        sdpMLineIndex: candidateObj.sdpMLineIndex,
      });

      if (this.offerSent) {
        this.signal.send({type: 'ice_candidate', candidate: candidateObj});
      } else {
        this.pendingLocalCandidates.push(candidateObj);
      }
    };

    this.removeSignalListener = this.signal.onFrame(frame => {
      if (frame.type === 'answer' && typeof frame.sdp === 'string') {
        void this.applyAnswer(String(frame.sdp));
      } else if (frame.type === 'ice_candidate' && frame.candidate) {
        const rawCand = String((frame.candidate as any).candidate || '');
        this.receivedRemoteCandidates.push({
          type: parseCandidateType(rawCand),
          candidate: rawCand,
        });

        if (this.pc.remoteDescription) {
          void this.pc.addIceCandidate(new RTCIceCandidate(frame.candidate as any)).catch(() => {});
        } else {
          this.pendingRemoteCandidates.push(frame.candidate);
        }
      } else if (frame.type === 'error' && (frame as any).code === 'WEBRTC_NEGOTIATION_FAILED') {
        if (this.signal.connected) {
          this.onStatus?.('connected');
        } else {
          this.onStatus?.('failed');
        }
      }
    });

    this.onStatus?.(this.signal.connected ? 'connected' : 'signaling');
    const offer = await this.pc.createOffer({offerToReceiveAudio: false, offerToReceiveVideo: false});
    await this.pc.setLocalDescription(offer);
    this.signal.send({type: 'offer', sdp: offer.sdp || ''});
    this.offerSent = true;

    for (const candidate of this.pendingLocalCandidates) {
      this.signal.send({type: 'ice_candidate', candidate});
    }
    this.pendingLocalCandidates = [];
  }

  private async applyAnswer(sdp: string): Promise<void> {
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp}));
      for (const candidate of this.pendingRemoteCandidates) {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      this.pendingRemoteCandidates = [];
    } catch {
      if (this.signal.connected) {
        this.onStatus?.('connected');
      } else {
        this.onStatus?.('failed');
      }
    }
  }

  /** Safe ICE restart when network switching occurs (e.g. Wi-Fi to cellular handover). */
  async restartIce(): Promise<void> {
    if (!this.signal.connected || this.isDestroyed) return;
    try {
      this.onStatus?.('connecting');
      this.pc.restartIce();
      const offer = await this.pc.createOffer({offerToReceiveAudio: false, offerToReceiveVideo: false});
      await this.pc.setLocalDescription(offer);
      this.signal.send({type: 'offer', sdp: offer.sdp || ''});
    } catch {
      this.onStatus?.('failed');
    }
  }

  /** Safely closes the peer connection and performs full re-establishment over signaling. */
  async reconnect(): Promise<void> {
    if (this.isDestroyed) return;
    this.cleanupPeer();
    this.pc = this.createPeerConnection();
    await this.connectAuthenticated();
  }

  /** Only send an E2EE ciphertext envelope or control frame here. */
  sendControlFrame(frame: {type: 'delivered_ack' | 'seen_ack' | 'ping' | 'presence_offline' | 'call_signal'; message_id?: string; to_uid?: string; payload?: any}): void {
    if (!this.channel || this.channel.readyState !== 'open') throw new Error('WebRTC DataChannel is not connected');
    if ((frame.type === 'delivered_ack' || frame.type === 'seen_ack') && !frame.message_id) {
      throw new Error('A message ID is required for a receipt');
    }
    this.channel.send(JSON.stringify(frame));
  }

  /**
   * Sends an encrypted envelope over the WebRTC DataChannel.
   * If the DataChannel is not open, the message is NEVER sent as plaintext and
   * E2EE is NEVER bypassed.
   *
   * Payloads exceeding 12 KB (images, voice notes) are automatically sliced into
   * 12 KB Chunk frames to avoid SCTP buffer limits (64 KiB) and prevent socket resets.
   */
  async sendEncryptedEnvelope(envelope: string): Promise<void> {
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('WebRTC DataChannel is not connected. Message cannot be delivered without secure E2EE channel.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(envelope); } catch { throw new Error('Message envelope must be valid JSON'); }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as any).type !== 'send_message' ||
      typeof (parsed as any).message_id !== 'string' ||
      typeof (parsed as any).conversation_id !== 'string' ||
      typeof (parsed as any).ciphertext_b64 !== 'string' ||
      !(parsed as any).ciphertext_b64.length
    ) {
      throw new Error('Only an E2EE ciphertext envelope can be sent');
    }

    const CHUNK_SIZE = 12 * 1024;
    if (envelope.length <= CHUNK_SIZE) {
      this.channel.send(envelope);
    } else {
      const transferId = 'cli_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
      const total = Math.ceil(envelope.length / CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        const chunkData = envelope.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const chunkFrame = JSON.stringify({
          type: 'chunk',
          transfer_id: transferId,
          index: i,
          total,
          data: chunkData,
        });
        this.channel.send(chunkFrame);
        if (total > 4 && i % 3 === 0) {
          await new Promise<void>(resolve => setTimeout(() => resolve(), 2));
        }
      }
    }
  }

  private cleanupPeer(): void {
    if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.incomingChunks.forEach(item => clearTimeout(item.timer));
    this.incomingChunks.clear();
    this.channel?.close();
    this.pc.close();
    this.pendingLocalCandidates = [];
    this.pendingRemoteCandidates = [];
    this.selectedPair = null;
  }

  close(): void {
    this.isDestroyed = true;
    this.removeSignalListener?.();
    this.removeSignalListener = undefined;
    this.cleanupPeer();
  }
}
