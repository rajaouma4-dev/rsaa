import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  SafeAreaView,
  StatusBar,
  Dimensions,
} from 'react-native';
import {RTCView} from 'react-native-webrtc';
import {CallState, callService, CallQuality} from '../services/callService';

const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get('window');

interface CallModalProps {
  callState: CallState;
  myDisplayName: string;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function CallModal({callState, myDisplayName}: CallModalProps) {
  if (callState.status === 'idle') {
    return null;
  }

  const isConnected = callState.status === 'connected';
  const isIncoming = callState.status === 'incoming_ringing';
  const isOutgoing =
    callState.status === 'outgoing_calling' ||
    callState.status === 'outgoing_ringing';

  const isCameraActive =
    !callState.isCameraOff &&
    (callState.localStream?.getVideoTracks().some(t => t.enabled) ?? false);
  const remoteStreamUrl = callState.remoteStream ? callState.remoteStream.toURL() : null;
  const localStreamUrl = callState.localStream ? callState.localStream.toURL() : null;
  const remoteVideoTracks = callState.remoteStream?.getVideoTracks() || [];
  const hasRemoteVideo =
    isConnected &&
    !!remoteStreamUrl &&
    (callState.isPeerScreenSharing || (remoteVideoTracks.length > 0 && remoteVideoTracks.some(t => t.enabled)));

  const handleToggleMic = () => {
    callService.toggleMic();
  };

  const handleToggleCamera = () => {
    void callService.toggleCamera();
  };

  const handleSwitchCamera = () => {
    callService.switchCamera();
  };

  const handleToggleScreenShare = () => {
    void callService.toggleScreenShare();
  };

  const handleCycleQuality = () => {
    const nextQuality: Record<CallQuality, CallQuality> = {
      hd: 'sd',
      sd: 'low',
      low: 'hd',
    };
    void callService.setQuality(nextQuality[callState.quality]);
  };

  const handleAccept = () => {
    void callService.acceptCall(myDisplayName);
  };

  const handleDecline = () => {
    callService.rejectCall();
  };

  const handleEnd = () => {
    callService.endCall();
  };

  const rtcKey = `remote_${remoteStreamUrl}_${callState.isPeerScreenSharing ? 'screen' : 'cam'}_${remoteVideoTracks.length}_${remoteVideoTracks[0]?.id || 'novid'}`;

  return (
    <Modal
      visible={true}
      animationType="slide"
      transparent={true}
      statusBarTranslucent={true}
      onRequestClose={handleEnd}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.modalRoot, hasRemoteVideo && styles.modalRootVideoActive]}>
        {/* Remote Fullscreen Video / Screen Surface when connected and remote stream available */}
        {hasRemoteVideo && remoteStreamUrl ? (
          <View style={StyleSheet.absoluteFill}>
            <RTCView
              key={rtcKey}
              streamURL={remoteStreamUrl}
              style={styles.fullscreenVideo}
              objectFit="contain"
              zOrder={1}
            />
          </View>
        ) : null}

        <SafeAreaView style={styles.container} pointerEvents="box-none">

        {/* Top Header Information Overlay */}
        <View style={styles.topOverlay}>
          <View style={styles.securityBadge}>
            <Text style={styles.securityIcon}>🔒</Text>
            <Text style={styles.securityText}>DTLS-SRTP E2EE</Text>
          </View>
          <Text numberOfLines={1} style={styles.remoteName}>
            {callState.remoteUser?.name || 'Contact'}
          </Text>
          <Text style={styles.callStatusText}>
            {isIncoming
              ? callState.callType === 'video'
                ? 'Incoming Video Call...'
                : 'Incoming Audio Call...'
              : isOutgoing
              ? callState.status === 'outgoing_calling'
                ? 'Calling...'
                : 'Ringing...'
              : formatDuration(callState.durationSec)}
          </Text>

          {/* Realtime Video Quality Toggle Pill */}
          {isConnected ? (
            <Pressable
              onPress={handleCycleQuality}
              hitSlop={8}
              style={[
                styles.qualityPill,
                callState.quality === 'hd' && styles.qualityHd,
                callState.quality === 'sd' && styles.qualitySd,
                callState.quality === 'low' && styles.qualityLow,
              ]}>
              <Text style={styles.qualityPillText}>
                {callState.quality.toUpperCase()} QUALITY
              </Text>
            </Pressable>
          ) : null}

          {/* Real-time Screen Sharing Active Banner */}
          {callState.isScreenSharing ? (
            <View style={styles.screenShareBanner}>
              <Text style={styles.screenShareBannerText}>
                📱 Sharing Screen in Real-time
              </Text>
            </View>
          ) : callState.isPeerScreenSharing ? (
            <View style={styles.peerScreenShareBanner}>
              <Text style={styles.peerScreenShareBannerText}>
                📱 {callState.remoteUser?.name || 'Contact'} is sharing screen
              </Text>
            </View>
          ) : null}
        </View>

        {/* Audio Avatar / Placeholder Screen when not displaying full remote video */}
        {!hasRemoteVideo && (
          <View style={styles.avatarCenterContainer}>
            <View
              style={[
                styles.avatarCircle,
                isIncoming && styles.avatarPulseIncoming,
                isOutgoing && styles.avatarPulseOutgoing,
              ]}>
              <Text style={styles.avatarInitial}>
                {callState.remoteUser?.name?.charAt(0).toUpperCase() || '?'}
              </Text>
            </View>
            <Text style={styles.callTypeLabel}>
              {callState.isScreenSharing
                ? '📱 Real-time Screen Sharing Active'
                : callState.isPeerScreenSharing
                ? '📱 Receiving Real-time Screen...'
                : isCameraActive
                ? '📷 Live Video Active'
                : '📞 Encrypted Audio Call'}
            </Text>
          </View>
        )}

        {/* Local Camera Floating Picture-in-Picture when camera is enabled & not sharing screen */}
        {isConnected && localStreamUrl && isCameraActive && !callState.isScreenSharing ? (
          <View style={styles.pipContainer}>
            <RTCView
              streamURL={localStreamUrl}
              style={styles.pipVideo}
              objectFit="cover"
              mirror={callState.isFrontCamera}
              zOrder={2}
            />
          </View>
        ) : null}

        {/* Bottom Controls Bar */}
        <View style={styles.bottomControls}>
          {isIncoming ? (
            /* Incoming Call Controls: Accept (Green) & Decline (Red) */
            <View style={styles.incomingBtnRow}>
              <Pressable
                onPress={handleDecline}
                style={[styles.actionBtn, styles.declineBtn]}>
                <Text style={styles.actionBtnIcon}>✕</Text>
                <Text style={styles.btnLabel}>Decline</Text>
              </Pressable>
              <Pressable
                onPress={handleAccept}
                style={[styles.actionBtn, styles.acceptBtn]}>
                <Text style={styles.actionBtnIcon}>
                  {callState.callType === 'video' ? '📹' : '📞'}
                </Text>
                <Text style={styles.btnLabel}>Accept</Text>
              </Pressable>
            </View>
          ) : (
            /* Active / Outgoing In-Call Controls */
            <View style={styles.inCallControlsRow}>
              {/* Mic Mute / Unmute */}
              <Pressable
                onPress={handleToggleMic}
                style={[
                  styles.controlIconBtn,
                  callState.isMicMuted && styles.controlIconBtnMuted,
                ]}>
                <Text style={styles.controlIconText}>
                  {callState.isMicMuted ? '🔇' : '🎙️'}
                </Text>
                <Text style={styles.controlSubLabel}>
                  {callState.isMicMuted ? 'Unmute' : 'Mute'}
                </Text>
              </Pressable>

              {/* Camera On / Off (Available in BOTH Audio and Video calls) */}
              <Pressable
                onPress={handleToggleCamera}
                disabled={callState.isScreenSharing}
                style={[
                  styles.controlIconBtn,
                  isCameraActive && styles.controlIconBtnCameraActive,
                  callState.isScreenSharing && {opacity: 0.4},
                ]}>
                <Text style={styles.controlIconText}>
                  {isCameraActive ? '📷' : '🚫'}
                </Text>
                <Text style={styles.controlSubLabel}>
                  {isCameraActive ? 'Cam Off' : 'Cam On'}
                </Text>
              </Pressable>

              {/* Real-time Screen Sharing Toggle (Always visible in-call) */}
              <Pressable
                onPress={handleToggleScreenShare}
                style={[
                  styles.controlIconBtn,
                  callState.isScreenSharing && styles.controlIconBtnScreenActive,
                ]}>
                <Text style={styles.controlIconText}>
                  {callState.isScreenSharing ? '🛑' : '📱'}
                </Text>
                <Text style={styles.controlSubLabel}>
                  {callState.isScreenSharing ? 'Stop' : 'Share'}
                </Text>
              </Pressable>

              {/* Switch Camera (Flip Front <-> Back) when Camera is Active & not screen sharing */}
              {isCameraActive && !callState.isScreenSharing ? (
                <Pressable
                  onPress={handleSwitchCamera}
                  style={styles.controlIconBtn}>
                  <Text style={styles.controlIconText}>🔄</Text>
                  <Text style={styles.controlSubLabel}>Flip</Text>
                </Pressable>
              ) : null}

              {/* End Call / Hang Up Button */}
              <Pressable
                onPress={handleEnd}
                style={[styles.actionBtn, styles.declineBtn]}>
                <Text style={styles.actionBtnIcon}>📞</Text>
                <Text style={styles.btnLabel}>End</Text>
              </Pressable>
            </View>
          )}
        </View>
      </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    backgroundColor: '#0a0d14',
  },
  modalRootVideoActive: {
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
    backgroundColor: 'transparent',
    justifyContent: 'space-between',
  },
  fullscreenVideo: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000000',
  },
  topOverlay: {
    paddingTop: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    zIndex: 10,
  },
  securityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
    marginBottom: 10,
  },
  securityIcon: {
    fontSize: 12,
    marginRight: 5,
  },
  securityText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  remoteName: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 6,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 3,
  },
  callStatusText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 15,
    fontWeight: '500',
  },
  qualityPill: {
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  qualityHd: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
    borderColor: '#3b82f6',
  },
  qualitySd: {
    backgroundColor: 'rgba(234, 179, 8, 0.2)',
    borderColor: '#eab308',
  },
  qualityLow: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: '#ef4444',
  },
  qualityPillText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  avatarCenterContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 40,
  },
  avatarCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#1f2937',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#374151',
    marginBottom: 18,
  },
  avatarPulseIncoming: {
    borderColor: '#10b981',
    shadowColor: '#10b981',
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 10,
  },
  avatarPulseOutgoing: {
    borderColor: '#3b82f6',
    shadowColor: '#3b82f6',
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 10,
  },
  avatarInitial: {
    color: '#ffffff',
    fontSize: 54,
    fontWeight: '700',
  },
  callTypeLabel: {
    color: '#9ca3af',
    fontSize: 14,
    fontWeight: '600',
  },
  pipContainer: {
    position: 'absolute',
    top: 50,
    right: 16,
    width: 100,
    height: 150,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    backgroundColor: '#000000',
    zIndex: 20,
    elevation: 10,
  },
  pipVideo: {
    width: '100%',
    height: '100%',
  },
  bottomControls: {
    paddingBottom: 36,
    paddingHorizontal: 24,
    zIndex: 10,
  },
  incomingBtnRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  inCallControlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderRadius: 24,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  actionBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  acceptBtn: {
    backgroundColor: '#10b981',
  },
  declineBtn: {
    backgroundColor: '#ef4444',
  },
  actionBtnIcon: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '700',
  },
  btnLabel: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  controlIconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    minWidth: 48,
  },
  controlIconBtnMuted: {
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    borderRadius: 16,
  },
  controlIconBtnCameraActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.25)',
    borderRadius: 16,
  },
  controlIconBtnScreenActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.35)',
    borderRadius: 16,
  },
  screenShareBanner: {
    marginTop: 10,
    backgroundColor: 'rgba(59, 130, 246, 0.25)',
    borderWidth: 1,
    borderColor: '#3b82f6',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
  },
  screenShareBannerText: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '700',
  },
  peerScreenShareBanner: {
    marginTop: 10,
    backgroundColor: 'rgba(16, 185, 129, 0.25)',
    borderWidth: 1,
    borderColor: '#10b981',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
  },
  peerScreenShareBannerText: {
    color: '#34d399',
    fontSize: 12,
    fontWeight: '700',
  },
  controlIconText: {
    fontSize: 24,
    marginBottom: 4,
  },
  controlSubLabel: {
    color: '#e5e7eb',
    fontSize: 11,
    fontWeight: '600',
  },
});
