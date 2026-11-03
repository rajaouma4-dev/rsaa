import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';
import {PermissionsAndroid, Platform} from 'react-native';
import {APP_CONFIG} from '../config';

export type CallOutcome = 'completed' | 'missed' | 'declined' | 'cancelled' | 'busy' | 'offline' | 'failed';

export type CallType = 'audio' | 'video';
export type CallQuality = 'hd' | 'sd' | 'low';
export type CallStatus =
  | 'idle'
  | 'outgoing_calling'
  | 'outgoing_ringing'
  | 'incoming_ringing'
  | 'connecting'
  | 'connected'
  | 'ended';

export interface CallState {
  callId: string | null;
  callType: CallType;
  remoteUser: {uid: string; name: string} | null;
  isCaller: boolean;
  status: CallStatus;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMicMuted: boolean;
  isCameraOff: boolean;
  isFrontCamera: boolean;
  isScreenSharing: boolean;
  isPeerScreenSharing: boolean;
  quality: CallQuality;
  durationSec: number;
  endReason?: string;
}

export interface CallEndEvent {
  callId: string;
  callType: CallType;
  remoteUser: {uid: string; name: string};
  isCaller: boolean;
  durationSec: number;
  durationFormatted: string;
  status: CallOutcome;
  timestamp: number;
}

export function formatCallDuration(sec: number): string {
  if (sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

export type CallSignalSender = (toUid: string, payload: any) => boolean | void;

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  highpassFilter: true,
};

function optimizeSdp(sdp: string): string {
  // Merge Opus preferences once; preserve video and transport negotiation.
  return sdp.split(/(?=^m=)/m).map(section => {
    if (!section.startsWith('m=audio')) return section;
    const opus = section.match(/^a=rtpmap:(\d+)\s+opus\/48000/mi);
    if (!opus) return section;
    const prefix = `a=fmtp:${opus[1]} `;
    const lines = section.split(/\r?\n/);
    const params = new Map<string, string>();
    for (const line of lines.filter(value => value.startsWith(prefix))) {
      for (const part of line.slice(prefix.length).split(';')) {
        const split = part.indexOf('=');
        if (split > 0) params.set(part.slice(0, split).trim().toLowerCase(), part.slice(split + 1).trim());
      }
    }
    params.delete('ptime'); params.delete('maxptime');
    for (const [key, value] of Object.entries({minptime: '10', useinbandfec: '1', usedtx: '1', stereo: '0', 'sprop-stereo': '0', cbr: '0', maxaveragebitrate: '32000'})) params.set(key, value);
    const kept = lines.filter(line => line && !line.startsWith(prefix) && !/^a=(ptime|maxptime):/.test(line));
    kept.push(prefix + [...params].map(([key, value]) => `${key}=${value}`).join(';'));
    kept.push('a=ptime:10', 'a=maxptime:20', '');
    return kept.join('\r\n');
  }).join('');
}

class CallService {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private recentCalls = new Map<string, number>();
  private endReason?: string;
  private currentCallId: string | null = null;
  private remoteUser: {uid: string; name: string} | null = null;
  private callType: CallType = 'audio';
  private isCaller = false;
  private status: CallStatus = 'idle';
  private isMicMuted = false;
  private isCameraOff = false;
  private isFrontCamera = true;
  private isScreenSharing = false;
  private isPeerScreenSharing = false;
  private screenStream: MediaStream | null = null;
  private originalCameraTrack: any = null;
  private quality: CallQuality = 'sd';
  private durationSec = 0;
  private durationTimer: any = null;
  private ringingTimeoutTimer: any = null;
  private connectionGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCandidates: any[] = [];
  private remoteOfferSdp: string | null = null;

  private signalSender: CallSignalSender | null = null;
  private listeners = new Set<(state: CallState) => void>();
  private callEndListeners = new Set<(event: CallEndEvent) => void>();

  setSignalSender(sender: CallSignalSender) {
    this.signalSender = sender;
  }

  subscribe(listener: (state: CallState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  onCallEnd(listener: (event: CallEndEvent) => void): () => void {
    this.callEndListeners.add(listener);
    return () => {
      this.callEndListeners.delete(listener);
    };
  }

  private notify() {
    const s = this.getState();
    this.listeners.forEach(fn => {
      try {
        fn(s);
      } catch (err) {
        console.warn('Call listener error:', err);
      }
    });
  }

  getState(): CallState {
    return {
      callId: this.currentCallId,
      callType: this.callType,
      remoteUser: this.remoteUser,
      isCaller: this.isCaller,
      status: this.status,
      localStream: this.localStream,
      remoteStream: this.remoteStream,
      isMicMuted: this.isMicMuted,
      isCameraOff: this.isCameraOff,
      isFrontCamera: this.isFrontCamera,
      isScreenSharing: this.isScreenSharing,
      isPeerScreenSharing: this.isPeerScreenSharing,
      quality: this.quality,
      durationSec: this.durationSec,
      endReason: this.endReason,
    };
  }

  private async requestPermissions(callType: CallType): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    try {
      if (callType === 'video') {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          PermissionsAndroid.PERMISSIONS.CAMERA,
        ]);
        const audioOk =
          granted[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const cameraOk =
          granted[PermissionsAndroid.PERMISSIONS.CAMERA] ===
          PermissionsAndroid.RESULTS.GRANTED;
        return audioOk && cameraOk;
      } else {
        // Audio call: ONLY request Microphone permission with user-friendly dialog!
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message: 'Microphone access is required to make secure audio calls.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
    } catch {
      return false;
    }
  }

  /**
   * Start an outgoing call to remote user
   */
  async startCall(
    remoteUser: {uid: string; name: string},
    callType: CallType,
    myDisplayName: string
  ): Promise<void> {
    if (this.status !== 'idle') {
      return;
    }

    const callId = 'call_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    this.currentCallId = callId;
    this.remoteUser = remoteUser;
    this.callType = callType;
    this.isCaller = true;
    this.status = 'outgoing_calling';
    this.isMicMuted = false;
    this.isCameraOff = callType === 'audio'; // Camera starts completely OFF for audio calls
    this.isFrontCamera = true;
    this.quality = 'sd';
    this.durationSec = 0;
    this.pendingCandidates = [];
    this.notify();

    const permOk = await this.requestPermissions(callType);
    if (this.currentCallId !== callId) return;
    if (!permOk) { this.resetCall('Permission denied'); return; }

    try {
      // 1. Get local user media - audio call only acquires audio (NO camera opened automatically!)
      let stream: MediaStream;
      if (callType === 'video') {
        stream = (await mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS as any,
          video: {
            facingMode: 'user',
            width: {ideal: 640, max: 1280},
            height: {ideal: 480, max: 720},
            frameRate: {ideal: 24, max: 30},
          },
        })) as MediaStream;
        this.isCameraOff = false;
      } else {
        // Pure audio call: Camera hardware is NOT activated
        stream = (await mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS as any,
          video: false,
        })) as MediaStream;
        this.isCameraOff = true;
      }
      if (this.currentCallId !== callId || ['idle', 'ended'].includes(this.status)) {
        stream.getTracks().forEach(track => track.stop());
        stream.release(true);
        return;
      }
      this.localStream = stream;

      // 2. Create PeerConnection with instant candidate pooling & max-bundle
      const pc = new RTCPeerConnection({
        iceServers: APP_CONFIG.ICE_SERVERS as any,
        iceCandidatePoolSize: 2,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      this.pc = pc;

      // 3. Attach local tracks
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      // 4. Handle ICE candidates
      pc.addEventListener('icecandidate', (event: any) => {
        if (event.candidate && this.currentCallId === callId && this.remoteUser) {
          this.signalSender?.(this.remoteUser.uid, {
            type: 'call_candidate',
            callId,
            candidate: event.candidate.toJSON(),
          });
        }
      });

      // 5. Handle remote stream tracks
      pc.addEventListener('track', (event: any) => {
        if (this.pc !== pc || this.currentCallId !== callId) return;
        const track = event.track;
        if (event.streams && event.streams[0]) {
          this.remoteStream = event.streams[0];
        } else if (track) {
          if (!this.remoteStream) {
            this.remoteStream = new MediaStream([track]);
          } else {
            if (!this.remoteStream.getTracks().some((t: any) => t.id === track.id)) {
              this.remoteStream.addTrack(track);
            }
          }
        }

        if (track && track.kind === 'video') {
          track.enabled = true;
          track.addEventListener('unmute', () => {
            this.notify();
          });
        }

        if (this.pc !== pc || this.currentCallId !== callId) return;
        this.notify();
      });

      // 6. Handle connection state changes
      this.attachConnectionLifecycle(pc, callId);

      // 7. Create Offer & setLocalDescription with Opus low-latency optimization
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: callType === 'video',
      });
      const optimizedOfferSdp = optimizeSdp(offer.sdp || '');
      await pc.setLocalDescription(new RTCSessionDescription({type: 'offer', sdp: optimizedOfferSdp}));
      if (this.currentCallId !== callId) return;
      if (callType === 'video') await this.setQuality(this.quality);
      if (this.currentCallId !== callId) return;

      // 8. Send call_invite with offer SDP to peer
      const inviteSent = this.signalSender?.(remoteUser.uid, {
        type: 'call_invite',
        callId,
        callType,
        callerName: myDisplayName,
        sdp: optimizedOfferSdp,
      });
      if (!this.signalSender || inviteSent === false) {
        throw new Error('No authenticated call signaling connection');
      }

      // 9. 35s Ringing timeout
      this.ringingTimeoutTimer = setTimeout(() => {
        if (this.status === 'outgoing_calling' || this.status === 'outgoing_ringing') {
          this.endCall('No answer');
        }
      }, 35000);

      this.notify();
    } catch (err) {
      console.warn('startCall failed:', err);
      if (this.currentCallId === callId) this.resetCall('Failed to start call');
    }
  }

  /**
   * Callee accepts the incoming call
   */
  async acceptCall(myDisplayName: string): Promise<void> {
    if (this.status !== 'incoming_ringing' || !this.remoteUser || !this.remoteOfferSdp) {
      return;
    }

    if (this.ringingTimeoutTimer) {
      clearTimeout(this.ringingTimeoutTimer);
      this.ringingTimeoutTimer = null;
    }

    const acceptedCallId = this.currentCallId;
    this.status = 'connecting';
    this.notify();
    const permOk = await this.requestPermissions(this.callType);
    if (this.currentCallId !== acceptedCallId) return;
    if (!permOk) {
      this.rejectCall('Permission denied');
      return;
    }

    const callId = this.currentCallId!;
    this.status = 'connecting';
    this.notify();

    try {
      // 1. Get local media - pure audio for audio calls, dual audio/video for video calls
      let stream: MediaStream;
      if (this.callType === 'video') {
        stream = (await mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS as any,
          video: {
            facingMode: 'user',
            width: {ideal: 640, max: 1280},
            height: {ideal: 480, max: 720},
            frameRate: {ideal: 24, max: 30},
          },
        })) as MediaStream;
        this.isCameraOff = false;
      } else {
        // Pure audio call: Camera is NOT activated
        stream = (await mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS as any,
          video: false,
        })) as MediaStream;
        this.isCameraOff = true;
      }
      if (this.currentCallId !== callId || ['idle', 'ended'].includes(this.status)) {
        stream.getTracks().forEach(track => track.stop());
        stream.release(true);
        return;
      }
      this.localStream = stream;

      // 2. Create PeerConnection with instant candidate pooling & max-bundle
      const pc = new RTCPeerConnection({
        iceServers: APP_CONFIG.ICE_SERVERS as any,
        iceCandidatePoolSize: 2,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      this.pc = pc;

      // 3. Attach local tracks
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      // 4. Handle ICE candidates
      pc.addEventListener('icecandidate', (event: any) => {
        if (event.candidate && this.currentCallId === callId && this.remoteUser) {
          this.signalSender?.(this.remoteUser.uid, {
            type: 'call_candidate',
            callId,
            candidate: event.candidate.toJSON(),
          });
        }
      });

      // 5. Handle remote stream tracks
      pc.addEventListener('track', (event: any) => {
        if (this.pc !== pc || this.currentCallId !== callId) return;
        const track = event.track;
        if (event.streams && event.streams[0]) {
          this.remoteStream = event.streams[0];
        } else if (track) {
          if (!this.remoteStream) {
            this.remoteStream = new MediaStream([track]);
          } else {
            if (!this.remoteStream.getTracks().some((t: any) => t.id === track.id)) {
              this.remoteStream.addTrack(track);
            }
          }
        }

        if (track && track.kind === 'video') {
          track.enabled = true;
          track.addEventListener('unmute', () => {
            this.notify();
          });
        }

        if (this.pc !== pc || this.currentCallId !== callId) return;
        this.notify();
      });

      this.attachConnectionLifecycle(pc, callId);

      // 6. Set Remote Description from caller's offer
      await pc.setRemoteDescription(
        new RTCSessionDescription({
          type: 'offer',
          sdp: this.remoteOfferSdp,
        })
      );

      // 7. Flush any queued ICE candidates
      for (const cand of this.pendingCandidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch {}
      }
      this.pendingCandidates = [];

      // 8. Create Answer & setLocalDescription with Opus low-latency optimization
      const answer = await pc.createAnswer();
      const optimizedAnswerSdp = optimizeSdp(answer.sdp || '');
      await pc.setLocalDescription(new RTCSessionDescription({type: 'answer', sdp: optimizedAnswerSdp}));
      if (this.currentCallId !== callId) return;
      if (this.callType === 'video') await this.setQuality(this.quality);
      if (this.currentCallId !== callId) return;

      // 9. Send call_answer back to caller
      this.signalSender?.(this.remoteUser.uid, {
        type: 'call_answer',
        callId,
        sdp: optimizedAnswerSdp,
      });

      if (pc.connectionState !== 'connected') this.status = 'connecting';
      this.notify();
    } catch (err) {
      console.warn('acceptCall failed:', err);
      if (this.currentCallId === callId) this.rejectCall('Connection failed');
    }
  }

  /**
   * Callee rejects incoming call
   */
  rejectCall(reason = 'Call declined'): void {
    if (this.currentCallId && this.remoteUser) {
      this.signalSender?.(this.remoteUser.uid, {
        type: 'call_reject',
        callId: this.currentCallId,
        reason,
      });
    }
    this.resetCall(reason);
  }

  /**
   * End ongoing call
   */
  endCall(reason = 'Call ended'): void {
    if (this.currentCallId && this.remoteUser) {
      this.signalSender?.(this.remoteUser.uid, {
        type: 'call_end',
        callId: this.currentCallId,
        reason,
      });
    }
    this.resetCall(reason);
  }

  /**
   * In-call toggle Microphone (Mute / Unmute)
   */
  toggleMic(): boolean {
    if (!this.localStream) return false;
    const audioTracks = this.localStream.getAudioTracks();
    this.isMicMuted = !this.isMicMuted;
    audioTracks.forEach(track => {
      track.enabled = !this.isMicMuted;
    });
    this.notify();
    return this.isMicMuted;
  }

  /**
   * In-call toggle Camera (On / Off) - works in BOTH audio and video calls!
   */
  async toggleCamera(): Promise<boolean> {
    if (!this.localStream) return false;
    let videoTracks = this.localStream.getVideoTracks();

    // If local stream does not have a video track yet, dynamically request permission and add one
    if (videoTracks.length === 0) {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
          {
            title: 'Camera Permission',
            message: 'Camera permission is required to turn on video during the call.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          return false;
        }
      }
      try {
        const vidStream = (await mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: this.isFrontCamera ? 'user' : 'environment',
            width: {ideal: 1280},
            height: {ideal: 720},
            frameRate: {ideal: 30},
          },
        })) as MediaStream;
        const newTrack = vidStream.getVideoTracks()[0];
        if (newTrack) {
          this.localStream.addTrack(newTrack);
          if (this.pc) {
            const senders = await (this.pc as any).getSenders?.();
            const transceivers = await (this.pc as any).getTransceivers?.();
            const vidSender =
              (Array.isArray(senders) &&
                senders.find((s: any) => s.track && s.track.kind === 'video')) ||
              (Array.isArray(transceivers) &&
                transceivers.find(
                  (t: any) =>
                    t.receiver?.track?.kind === 'video' ||
                    (t.mid && t.mid.toLowerCase().includes('video')),
                )?.sender);
            if (vidSender && typeof vidSender.replaceTrack === 'function') {
              await vidSender.replaceTrack(newTrack);
            } else {
              this.pc.addTrack(newTrack, this.localStream);
            }
          }
          videoTracks = [newTrack];
        }
      } catch (err) {
        console.warn('Failed to dynamically acquire camera:', err);
        return false;
      }
    }

    this.isCameraOff = !this.isCameraOff;
    videoTracks.forEach(track => {
      track.enabled = !this.isCameraOff;
    });
    this.notify();
    return this.isCameraOff;
  }

  /**
   * In-call Switch Camera (Front <-> Back)
   */
  switchCamera(): void {
    if (!this.localStream) return;
    const videoTracks = this.localStream.getVideoTracks();
    if (videoTracks.length > 0 && typeof (videoTracks[0] as any)._switchCamera === 'function') {
      try {
        (videoTracks[0] as any)._switchCamera();
        this.isFrontCamera = !this.isFrontCamera;
        this.notify();
      } catch (err) {
        console.warn('switchCamera failed:', err);
      }
    }
  }

  /**
   * Realtime Screen Sharing (start, stop, toggle)
   */
  async startScreenShare(): Promise<boolean> {
    if (!this.pc) {
      console.warn('startScreenShare: PeerConnection is not active');
      return false;
    }
    try {
      const constraints: any = {};
      if (Platform.OS === 'android') {
        const apiLevel =
          typeof Platform.Version === 'number'
            ? Platform.Version
            : parseInt(String(Platform.Version), 10);
        if (apiLevel >= 33) {
          try {
            await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any);
          } catch {}
        }
        if (apiLevel >= 34) {
          constraints.android = {
            createConfigForDefaultDisplay: true,
          };
        }
      }

      const stream = (await mediaDevices.getDisplayMedia(constraints)) as MediaStream;

      const screenTrack = stream.getVideoTracks()[0];
      if (!screenTrack) return false;

      this.screenStream = stream;
      this.isScreenSharing = true;

      // Handle user stopping screen share from Android notification drawer
      screenTrack.addEventListener('ended', () => {
        void this.stopScreenShare();
      });

      // Find video sender or transceiver on the PeerConnection
      const senders = await (this.pc as any).getSenders?.();
      let videoSender = Array.isArray(senders)
        ? senders.find((s: any) => s.track && s.track.kind === 'video')
        : null;

      const transceivers = await (this.pc as any).getTransceivers?.();
      let vidTransceiver: any = null;
      if (Array.isArray(transceivers)) {
        vidTransceiver = transceivers.find(
          (t: any) =>
            (t.receiver?.track && t.receiver.track.kind === 'video') ||
            (t.sender?.track && t.sender.track.kind === 'video') ||
            t.mid === '1' ||
            (t.mid && String(t.mid).toLowerCase().includes('video')),
        );
        if (!videoSender && vidTransceiver?.sender) {
          videoSender = vidTransceiver.sender;
        }
      }

      if (vidTransceiver) {
        try {
          vidTransceiver.direction = 'sendrecv';
        } catch {}
      }

      let renegotiated = false;
      if (videoSender && typeof videoSender.replaceTrack === 'function') {
        this.originalCameraTrack = videoSender.track;
        await videoSender.replaceTrack(screenTrack);
      } else {
        if (!this.localStream) {
          this.localStream = new MediaStream([]);
        }
        this.localStream.addTrack(screenTrack);
        this.pc.addTrack(screenTrack, this.localStream);
        renegotiated = true;
      }

      // Notify peer that screen share started and negotiate SDP if needed
      if (this.remoteUser && this.currentCallId) {
        this.signalSender?.(this.remoteUser.uid, {
          type: 'call_screen_share',
          callId: this.currentCallId,
          isSharing: true,
        });

        try {
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this.signalSender?.(this.remoteUser.uid, {
            type: 'call_renegotiate',
            callId: this.currentCallId,
            sdp: offer.sdp,
          });
        } catch (e) {
          console.warn('Renegotiation offer error:', e);
        }
      }

      this.notify();
      return true;
    } catch (err) {
      console.warn('startScreenShare failed:', err);
      return false;
    }
  }

  async stopScreenShare(): Promise<void> {
    if (!this.isScreenSharing) return;
    this.isScreenSharing = false;

    if (this.remoteUser && this.currentCallId) {
      this.signalSender?.(this.remoteUser.uid, {
        type: 'call_screen_share',
        callId: this.currentCallId,
        isSharing: false,
      });
    }

    const scr = this.screenStream;
    this.screenStream = null;
    if (scr) {
      try {
        scr.getTracks().forEach(t => {
          try { t.stop(); } catch {}
        });
      } catch {}
    }

    if (this.pc) {
      try {
        const senders = await (this.pc as any).getSenders?.();
        let videoSender = Array.isArray(senders)
          ? senders.find((s: any) => s.track && s.track.kind === 'video')
          : null;

        if (!videoSender) {
          const transceivers = await (this.pc as any).getTransceivers?.();
          if (Array.isArray(transceivers)) {
            const vidTransceiver = transceivers.find(
              (t: any) =>
                (t.receiver?.track && t.receiver.track.kind === 'video') ||
                (t.sender?.track && t.sender.track.kind === 'video') ||
                t.mid === '1' ||
                (t.mid && String(t.mid).toLowerCase().includes('video')),
            );
            if (vidTransceiver?.sender) {
              videoSender = vidTransceiver.sender;
            }
          }
        }

        if (videoSender && typeof videoSender.replaceTrack === 'function') {
          if (this.originalCameraTrack && !this.isCameraOff) {
            await videoSender.replaceTrack(this.originalCameraTrack);
          } else {
            const camTrack = this.localStream?.getVideoTracks()[0] || null;
            await videoSender.replaceTrack(camTrack);
          }
        }
      } catch (err) {
        console.warn('stopScreenShare restore error:', err);
      }
    }

    this.originalCameraTrack = null;
    this.notify();
  }

  async toggleScreenShare(): Promise<boolean> {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
      return false;
    } else {
      return await this.startScreenShare();
    }
  }

  /**
   * In-call Quality adjustments (HD, SD, Low)
   */
  async setQuality(mode: CallQuality): Promise<void> {
    this.quality = mode;
    this.notify();
    if (!this.pc) return;
    try {
      const senders = await (this.pc as any).getSenders?.();
      if (Array.isArray(senders)) {
        const videoSender = senders.find((s: any) => s.track && s.track.kind === 'video');
        if (videoSender && typeof videoSender.getParameters === 'function') {
          const params = videoSender.getParameters();
          if (params && params.encodings && params.encodings[0]) {
            if (mode === 'hd') {
              params.encodings[0].maxBitrate = 1500000;
              params.encodings[0].maxFramerate = 30;
              params.encodings[0].scaleResolutionDownBy = 1.0;
            } else if (mode === 'sd') {
              params.encodings[0].maxBitrate = 500000;
              params.encodings[0].maxFramerate = 24;
              params.encodings[0].scaleResolutionDownBy = 1.5;
            } else {
              params.encodings[0].maxBitrate = 150000;
              params.encodings[0].maxFramerate = 15;
              params.encodings[0].scaleResolutionDownBy = 2.0;
            }
            await videoSender.setParameters(params);
          }
        }
      }
    } catch (err) {
      console.warn('setQuality failed:', err);
    }
  }

  private startDurationTimer(): void {
    if (this.durationTimer) clearInterval(this.durationTimer);
    this.durationSec = 0;
    this.durationTimer = setInterval(() => {
      this.durationSec += 1;
      this.notify();
    }, 1000);
  }

  private attachConnectionLifecycle(pc: RTCPeerConnection, callId: string): void {
    pc.addEventListener('connectionstatechange', () => {
      if (this.pc !== pc || this.currentCallId !== callId) return;
      if (pc.connectionState === 'connected') {
        if (this.connectionGraceTimer) clearTimeout(this.connectionGraceTimer);
        this.connectionGraceTimer = null;
        this.status = 'connected';
        if (!this.durationTimer) this.startDurationTimer();
        this.notify();
      } else if (pc.connectionState === 'failed') {
        this.endCall('Connection lost');
      } else if (pc.connectionState === 'disconnected' && !this.connectionGraceTimer) {
        this.connectionGraceTimer = setTimeout(() => {
          this.connectionGraceTimer = null;
          if (this.pc === pc && this.currentCallId === callId && pc.connectionState === 'disconnected') {
            this.endCall('Connection lost');
          }
        }, 15000);
      }
    });
  }

  private resetCall(reason?: string, previousStatus?: CallStatus): void {
    if (this.connectionGraceTimer) clearTimeout(this.connectionGraceTimer);
    this.connectionGraceTimer = null;
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.ringingTimeoutTimer) {
      clearTimeout(this.ringingTimeoutTimer);
      this.ringingTimeoutTimer = null;
    }

    // Capture and emit call record before resetting fields
    if (this.currentCallId && this.remoteUser) {
      const durationSec = this.durationSec;
      const isCaller = this.isCaller;
      const callType = this.callType;
      const remoteUser = this.remoteUser;
      const callId = this.currentCallId;
      const prevStatus = previousStatus || this.status;
      this.recentCalls.set(callId, Date.now() + 120000);

      let callEndStatus: CallOutcome;
      if (reason === 'rate_limited') callEndStatus = 'failed';
      else if (reason === 'in_call' || reason === 'User busy') callEndStatus = 'busy';
      else if (reason === 'offline') callEndStatus = 'offline';
      else if (reason === 'Call declined') callEndStatus = 'declined';
      else if (reason === 'Missed call' || reason === 'No answer') callEndStatus = 'missed';
      else if (reason && /failed|lost|denied/i.test(reason)) callEndStatus = 'failed';
      else if (durationSec > 0 || prevStatus === 'connected') callEndStatus = 'completed';
      else if (!isCaller && prevStatus === 'incoming_ringing') callEndStatus = 'missed';
      else callEndStatus = 'cancelled';

      const durationFormatted = formatCallDuration(durationSec);
      const event: CallEndEvent = {
        callId,
        callType,
        remoteUser,
        isCaller,
        durationSec,
        durationFormatted,
        status: callEndStatus,
        timestamp: Date.now(),
      };

      this.callEndListeners.forEach(fn => {
        try {
          fn(event);
        } catch (err) {
          console.warn('CallEndListener error:', err);
        }
      });
    }

    // Retain references for graceful deferred cleanup
    const scrStream = this.screenStream;
    const locStream = this.localStream;
    const pcInstance = this.pc;

    // Phase 1: Reset all state and notify UI immediately so CallModal and RTCView unmount first
    this.screenStream = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pc = null;
    this.isScreenSharing = false;
    this.isPeerScreenSharing = false;
    this.originalCameraTrack = null;
    this.currentCallId = null;
    this.remoteUser = null;
    this.status = 'idle';
    this.endReason = undefined;
    this.isMicMuted = false;
    this.isCameraOff = false;
    this.isFrontCamera = true;
    this.durationSec = 0;
    this.pendingCandidates = [];
    this.remoteOfferSdp = null;
    this.notify();

    // Phase 2: Deferred native teardown allows SurfaceViewRenderer to detach cleanly without SIGSEGV
    setTimeout(() => {
      if (scrStream) {
        try {
          scrStream.getTracks().forEach(t => {
            try { t.stop(); } catch {}
          });
        } catch {}
      }
      if (locStream) {
        try {
          locStream.getTracks().forEach(t => {
            try { t.stop(); } catch {}
          });
          locStream.release(true);
        } catch {}
      }
      if (pcInstance) {
        try {
          pcInstance.close();
        } catch {}
      }
    }, 150);
  }

  private finishRemote(reason: string): void {
    const callId = this.currentCallId;
    const previous = this.status;
    this.endReason = ({rate_limited: 'Too many call attempts. Try again shortly.', in_call: 'User is on another call', offline: 'User is offline', 'Missed call': 'No answer'} as Record<string, string>)[reason] || reason;
    this.status = 'ended';
    this.notify();
    setTimeout(() => {
      if (this.currentCallId === callId && this.status === 'ended') this.resetCall(reason, previous);
    }, 800);
  }

  /**
   * Dispatch incoming call signaling frames received from peer
   */
  private signalQueue: Promise<void> = Promise.resolve();
  private earlyCandidates = new Map<string, {at: number; candidates: any[]}>();
  handleSignal(fromUid: string, payload: any): Promise<void> {
    const next = this.signalQueue.then(() => this.processSignal(fromUid, payload));
    this.signalQueue = next.catch(() => {});
    return next;
  }
  private async processSignal(fromUid: string, payload: any): Promise<void> {
    if (!payload || typeof payload !== 'object') return;

    while (this.recentCalls.size > 256) this.recentCalls.delete(this.recentCalls.keys().next().value!);
    for (const [id, until] of this.recentCalls) if (until <= Date.now()) this.recentCalls.delete(id);
    if (this.recentCalls.has(payload.callId)) return;
    if (this.currentCallId === payload.callId && this.remoteUser?.uid !== fromUid) return;
    if (this.status === 'ended' && this.currentCallId === payload.callId) return;
    const candidateKey = `${fromUid}:${payload.callId}`;
    for (const [key, entry] of this.earlyCandidates) {
      if (Date.now() - entry.at > 30000) this.earlyCandidates.delete(key);
    }
    if (payload.type === 'call_candidate' && this.currentCallId !== payload.callId && payload.candidate) {
      if (this.earlyCandidates.size >= 32) return;
      const entry = this.earlyCandidates.get(candidateKey) || {at: Date.now(), candidates: []};
      if (entry.candidates.length < 64) entry.candidates.push(payload.candidate);
      this.earlyCandidates.set(candidateKey, entry);
      return;
    }
    switch (payload.type) {
      case 'call_invite': {
        // If this is a retransmitted invite for the current call, reaffirm ringing!
        if (this.currentCallId === payload.callId) {
          this.signalSender?.(fromUid, {
            type: 'call_ringing',
            callId: payload.callId,
          });
          return;
        }

        // If already in an active or ringing call with someone else, reply busy
        if (this.status !== 'idle') {
          this.recentCalls.set(payload.callId, Date.now() + 120000);
          const event: CallEndEvent = {callId: payload.callId, callType: payload.callType === 'video' ? 'video' : 'audio', remoteUser: {uid: fromUid, name: payload.callerName || 'Caller'}, isCaller: false, durationSec: 0, durationFormatted: '0s', status: 'busy', timestamp: Date.now()};
          this.callEndListeners.forEach(fn => { try { fn(event); } catch {} });
          this.signalSender?.(fromUid, {
            type: 'call_busy',
            callId: payload.callId,
            reason: 'in_call',
          });
          return;
        }

        this.currentCallId = payload.callId;
        this.callType = payload.callType || 'audio';
        this.remoteUser = {
          uid: fromUid,
          name: payload.callerName || 'Caller',
        };
        this.isCaller = false;
        this.remoteOfferSdp = payload.sdp;
        this.status = 'incoming_ringing';
        this.durationSec = 0;
        this.pendingCandidates = this.earlyCandidates.get(candidateKey)?.candidates || [];
        this.earlyCandidates.delete(candidateKey);

        // Notify caller that we are ringing
        this.signalSender?.(fromUid, {
          type: 'call_ringing',
          callId: payload.callId,
        });

        // Auto timeout incoming call after 35s if not answered
        this.ringingTimeoutTimer = setTimeout(() => {
          if (this.status === 'incoming_ringing') {
            this.rejectCall('Missed call');
          }
        }, 35000);

        this.notify();
        break;
      }

      case 'call_ringing': {
        if (this.currentCallId === payload.callId && this.status === 'outgoing_calling') {
          this.status = 'outgoing_ringing';
          this.notify();
        }
        break;
      }

      case 'call_answer': {
        // Signaling is delivered on WSS and DataChannel; an answer may arrive
        // twice. Applying it again after reaching stable tears down a valid call.
        if (this.pc?.signalingState !== 'have-local-offer' || !this.isCaller ||
            this.remoteUser?.uid !== fromUid || typeof payload.sdp !== 'string') return;
        if (
          this.currentCallId === payload.callId &&
          this.pc &&
          this.status !== 'idle' &&
          this.status !== 'ended'
        ) {
          if (this.ringingTimeoutTimer) {
            clearTimeout(this.ringingTimeoutTimer);
            this.ringingTimeoutTimer = null;
          }
          try {
            await this.pc.setRemoteDescription(
              new RTCSessionDescription({
                type: 'answer',
                sdp: payload.sdp,
              })
            );
            // Flush any buffered candidates
            for (const cand of this.pendingCandidates) {
              try {
                await this.pc.addIceCandidate(new RTCIceCandidate(cand));
              } catch {}
            }
            this.pendingCandidates = [];
            if (this.pc.connectionState !== 'connected') this.status = 'connecting';
            this.notify();
          } catch (err) {
            console.warn('Failed to set remote answer description:', err);
            this.endCall('Handshake failed');
          }
        }
        break;
      }

      case 'call_candidate': {
        if (this.currentCallId === payload.callId && payload.candidate) {
          if (this.pc && this.pc.remoteDescription) {
            try {
              await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
            } catch (err) {
              console.warn('addIceCandidate error:', err);
            }
          } else {
            this.pendingCandidates.push(payload.candidate);
          }
        }
        break;
      }

      case 'call_screen_share': {
        if (this.currentCallId === payload.callId) {
          this.isPeerScreenSharing = !!payload.isSharing;
          if (this.pc && this.remoteStream) {
            try {
              const receivers = (this.pc as any).getReceivers?.();
              if (Array.isArray(receivers)) {
                for (const r of receivers) {
                  if (r.track && r.track.kind === 'video') {
                    r.track.enabled = true;
                    if (!this.remoteStream.getVideoTracks().some(t => t.id === r.track.id)) {
                      this.remoteStream.addTrack(r.track);
                    }
                  }
                }
              }
            } catch {}
          }
          if (this.remoteStream) {
            this.remoteStream.getVideoTracks().forEach(t => {
              t.enabled = true;
            });
          }
          this.notify();
        }
        break;
      }

      case 'call_renegotiate': {
        if (this.currentCallId === payload.callId && this.pc && payload.sdp) {
          try {
            await this.pc.setRemoteDescription(
              new RTCSessionDescription({
                type: 'offer',
                sdp: payload.sdp,
              })
            );
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this.signalSender?.(fromUid, {
              type: 'call_renegotiate_answer',
              callId: payload.callId,
              sdp: answer.sdp,
            });
            if (this.remoteStream) {
              try {
                const receivers = (this.pc as any).getReceivers?.();
                if (Array.isArray(receivers)) {
                  for (const r of receivers) {
                    if (r.track && r.track.kind === 'video') {
                      r.track.enabled = true;
                      if (!this.remoteStream.getVideoTracks().some(t => t.id === r.track.id)) {
                        this.remoteStream.addTrack(r.track);
                      }
                    }
                  }
                }
              } catch {}
              this.remoteStream.getVideoTracks().forEach(t => {
                t.enabled = true;
              });
            }
            this.notify();
          } catch (err) {
            console.warn('call_renegotiate error:', err);
          }
        }
        break;
      }

      case 'call_renegotiate_answer': {
        if (this.currentCallId === payload.callId && this.pc && payload.sdp) {
          try {
            await this.pc.setRemoteDescription(
              new RTCSessionDescription({
                type: 'answer',
                sdp: payload.sdp,
              })
            );
            if (this.remoteStream) {
              try {
                const receivers = (this.pc as any).getReceivers?.();
                if (Array.isArray(receivers)) {
                  for (const r of receivers) {
                    if (r.track && r.track.kind === 'video') {
                      r.track.enabled = true;
                      if (!this.remoteStream.getVideoTracks().some(t => t.id === r.track.id)) {
                        this.remoteStream.addTrack(r.track);
                      }
                    }
                  }
                }
              } catch {}
              this.remoteStream.getVideoTracks().forEach(t => {
                t.enabled = true;
              });
            }
            this.notify();
          } catch (err) {
            console.warn('call_renegotiate_answer error:', err);
          }
        }
        break;
      }

      case 'call_busy': {
        if (
          payload.callId &&
          this.currentCallId === payload.callId &&
          (this.status === 'outgoing_calling' || this.status === 'outgoing_ringing')
        ) {
          this.finishRemote(payload.reason || 'User busy');
        }
        break;
      }

      case 'call_reject': {
        if (
          payload.callId &&
          this.currentCallId === payload.callId &&
          (this.status === 'outgoing_calling' || this.status === 'outgoing_ringing')
        ) {
          this.finishRemote(payload.reason || 'Call declined');
        }
        break;
      }

      case 'call_end': {
        if (payload.callId && this.currentCallId === payload.callId) {
          this.finishRemote(payload.reason || 'Call ended');
        }
        break;
      }
    }
  }
}

export const callService = new CallService();
