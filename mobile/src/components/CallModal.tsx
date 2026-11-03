import React, {useEffect, useRef, useState} from 'react';
import {
  Animated, Modal, View, Text, StyleSheet, Pressable, SafeAreaView,
  StatusBar, Platform, PanResponder, useWindowDimensions,
} from 'react-native';
import {Avatar} from './Avatar';
import {RTCView} from 'react-native-webrtc';
import {CallState, callService, CallQuality} from '../services/callService';
import {clampPreview, previewBounds, PreviewPoint} from './callPreviewLayout';

interface CallModalProps { callState: CallState; myDisplayName: string }

type IconName = 'mic' | 'camera' | 'share' | 'flip' | 'end' | 'accept';

// Small native line icons keep call controls crisp without loading an icon font.
function CallIcon({name, off = false}: {name: IconName; off?: boolean}) {
  return <View style={styles.icon} accessible={false}>
    {name === 'mic' ? <>
      <View style={styles.micCapsule}/><View style={styles.micBowl}/><View style={styles.micStem}/>
    </> : name === 'camera' ? <>
      <View style={styles.cameraBody}/><View style={styles.cameraLens}/>
    </> : name === 'share' ? <>
      <View style={styles.shareScreen}/><Text style={styles.shareArrow}>↑</Text>
    </> : name === 'flip' ? <Text style={styles.symbol}>↻</Text> :
      <View style={[styles.handset, name === 'accept' && styles.handsetAccept]}>
        <View style={styles.handsetArch}/><View style={styles.handsetLeft}/><View style={styles.handsetRight}/>
      </View>}
    {off ? <View style={styles.iconSlash}/> : null}
  </View>;
}

function Control({label, icon, onPress, selected, danger, disabled, off}: {
  label: string; icon: IconName; onPress: () => void; selected?: boolean;
  danger?: boolean; disabled?: boolean; off?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{selected: !!selected, disabled: !!disabled}}
    disabled={disabled} onPress={onPress} hitSlop={4}
    style={({pressed}) => [styles.control, disabled && styles.disabled, pressed && styles.pressed]}>
    <View style={[styles.controlCircle, selected && styles.controlSelected, danger && styles.endCircle]}>
      <CallIcon name={icon} off={off}/>
    </View>
    <Text style={styles.controlLabel} numberOfLines={1}>{label}</Text>
  </Pressable>;
}

function formatDuration(sec: number) {
  return `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;
}

export function CallModal({callState, myDisplayName}: CallModalProps) {
  const window = useWindowDimensions();
  const [viewport, setViewport] = useState({width: window.width, height: window.height});
  const [controlsHeight, setControlsHeight] = useState(120);
  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 20;
  const pipHeight = Math.min(158, Math.max(64, viewport.height - topInset - controlsHeight - 130));
  const pipWidth = Math.min(112, Math.round(pipHeight * 0.72));
  const bounds = previewBounds(viewport.width, viewport.height, pipWidth, pipHeight, topInset, controlsHeight);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const position = useRef(new Animated.ValueXY()).current;
  const point = useRef<PreviewPoint>({x: 0, y: 0});
  const dragStart = useRef<PreviewPoint>({x: 0, y: 0});
  const previousCall = useRef<string | null>(null);
  const movePreview = (next: PreviewPoint) => {
    point.current = clampPreview(next, boundsRef.current);
    position.setValue(point.current);
  };
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 3,
    onPanResponderGrant: () => { dragStart.current = {...point.current}; },
    onPanResponderMove: (_, gesture) => movePreview({
      x: dragStart.current.x + gesture.dx, y: dragStart.current.y + gesture.dy,
    }),
    onPanResponderRelease: () => movePreview(point.current),
    onPanResponderTerminate: () => movePreview(point.current),
    onPanResponderTerminationRequest: () => false,
  })).current;

  useEffect(() => {
    const fresh = previousCall.current !== callState.callId;
    previousCall.current = callState.callId;
    movePreview(fresh ? {x: bounds.maxX, y: bounds.maxY} : point.current);
  }, [callState.callId, bounds.minX, bounds.maxX, bounds.minY, bounds.maxY]);

  if (callState.status === 'idle') return null;
  const isConnected = callState.status === 'connected';
  const isIncoming = callState.status === 'incoming_ringing';
  const ended = callState.status === 'ended';
  const cameraActive = !callState.isCameraOff &&
    (callState.localStream?.getVideoTracks().some(track => track.enabled) ?? false);
  const remoteUrl = callState.remoteStream?.toURL();
  const localUrl = callState.localStream?.toURL();
  const tracks = callState.remoteStream?.getVideoTracks() || [];
  const remoteVideo = isConnected && !!remoteUrl &&
    (callState.isPeerScreenSharing || tracks.some(track => track.enabled));
  const status = ended ? (callState.endReason || 'Call ended') : isIncoming
    ? `Incoming ${callState.callType === 'video' ? 'video' : 'audio'} call`
    : callState.status === 'outgoing_calling' ? 'Calling…'
    : callState.status === 'outgoing_ringing' ? 'Ringing…'
    : callState.status === 'connecting' ? 'Connecting…' : formatDuration(callState.durationSec);
  const cycleQuality = () => {
    const next: Record<CallQuality, CallQuality> = {hd: 'sd', sd: 'low', low: 'hd'};
    void callService.setQuality(next[callState.quality]);
  };

  return <Modal visible animationType="slide" transparent statusBarTranslucent
    onRequestClose={() => { if (!ended) callService.endCall(); }}>
    <StatusBar barStyle="light-content"/>
    <View style={styles.root} onLayout={event => setViewport(event.nativeEvent.layout)}>
      <View pointerEvents="none" style={styles.audioBackdrop}/>
      {remoteVideo && remoteUrl ? <RTCView
        key={`remote-${remoteUrl}-${callState.isPeerScreenSharing}-${tracks[0]?.id || ''}`}
        streamURL={remoteUrl} style={StyleSheet.absoluteFill}
        objectFit={callState.isPeerScreenSharing ? 'contain' : 'cover'} zOrder={0}/> : null}
      {remoteVideo ? <View pointerEvents="none" style={styles.videoShade}/> : null}

      <SafeAreaView style={[styles.content, {paddingTop: topInset + 12}]} pointerEvents="box-none">
        <View style={styles.header}>
          <View style={styles.brandMark}><Text style={styles.brandLetter}>N</Text></View>
          <View style={styles.headerText}>
            <Text numberOfLines={1} style={styles.name}>{callState.remoteUser?.name || 'Contact'}</Text>
            <Text style={styles.status} numberOfLines={2} accessibilityLiveRegion="polite">{status}</Text>
          </View>
          {isConnected ? <Pressable accessibilityRole="button"
            accessibilityLabel={`Call quality ${callState.quality.toUpperCase()}. Change quality`}
            onPress={cycleQuality} hitSlop={8} style={styles.quality}>
            <Text style={styles.qualityText}>{callState.quality.toUpperCase()}</Text>
          </Pressable> : <View style={styles.headerSpacer}/>}
        </View>
        {callState.isScreenSharing || callState.isPeerScreenSharing ? <View style={styles.sharingBanner}>
          <Text style={styles.sharingText}>{callState.isScreenSharing ? 'You are sharing your screen' : 'Viewing shared screen'}</Text>
        </View> : null}

        <View pointerEvents="none" style={styles.center}>
          {!remoteVideo ? <>
            <View style={[styles.avatar, isIncoming && styles.ringingAvatar]}>
              <Avatar uid={callState.remoteUser?.uid} name={callState.remoteUser?.name||'Contact'} size={140}/>
            </View>
            <Text style={styles.callType}>{callState.callType === 'video' ? 'Video call' : 'Audio call'}</Text>
          </> : null}
        </View>

        <View style={styles.bottom} onLayout={event => setControlsHeight(event.nativeEvent.layout.height)}>
          {isIncoming ? <View style={styles.incoming}>
            <Control icon="end" label="Decline" danger onPress={() => callService.rejectCall()}/>
            <Pressable accessibilityRole="button" accessibilityLabel="Accept call"
              onPress={() => { void callService.acceptCall(myDisplayName); }} style={styles.control}>
              <View style={[styles.controlCircle, styles.acceptCircle]}><CallIcon name="accept"/></View>
              <Text style={styles.controlLabel}>Accept</Text>
            </Pressable>
          </View> : <View style={styles.dock}>
            <Control icon="mic" label={callState.isMicMuted ? 'Unmute' : 'Mute'} off={callState.isMicMuted}
              selected={callState.isMicMuted} disabled={ended} onPress={() => callService.toggleMic()}/>
            <Control icon="camera" label={cameraActive ? 'Cam Off' : 'Cam On'} off={!cameraActive}
              selected={cameraActive} disabled={ended || callState.isScreenSharing}
              onPress={() => { void callService.toggleCamera(); }}/>
            <Control icon="share" label={callState.isScreenSharing ? 'Stop Share' : 'Share'}
              selected={callState.isScreenSharing} disabled={ended}
              onPress={() => { void callService.toggleScreenShare(); }}/>
            {cameraActive && !callState.isScreenSharing ? <Control icon="flip" label="Flip"
              disabled={ended} onPress={() => callService.switchCamera()}/> : null}
            <Control icon="end" label="End" danger disabled={ended} onPress={() => callService.endCall()}/>
          </View>}
        </View>
      </SafeAreaView>

      {isConnected && localUrl && cameraActive && !callState.isScreenSharing ? <Animated.View
        testID="call-self-preview" accessibilityLabel="Your camera preview. Drag to move"
        accessibilityHint="Move with one finger. Preview stays above call controls."
        accessibilityActions={[{name: 'increment', label: 'Move right'}, {name: 'decrement', label: 'Move left'}]}
        onAccessibilityAction={event => movePreview({x: event.nativeEvent.actionName === 'increment' ? bounds.maxX : bounds.minX, y: point.current.y})}
        accessible style={[styles.preview, {width: pipWidth, height: pipHeight, transform: position.getTranslateTransform()}]}
        {...responder.panHandlers}>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <RTCView streamURL={localUrl} style={styles.previewVideo} objectFit="cover"
            mirror={callState.isFrontCamera} zOrder={1}/>
        </View>
        <View pointerEvents="none" style={styles.previewHandle}><View style={styles.handleLine}/></View>
        <Text pointerEvents="none" style={styles.youLabel}>You</Text>
      </Animated.View> : null}
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#160f23'},
  audioBackdrop: {position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundImage: 'linear-gradient(155deg, #553184 0%, #241531 26%, #160f23 52%, #1d112e 100%)'},
  videoShade: {position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundImage: 'linear-gradient(180deg, rgba(20,10,34,0.48) 0%, rgba(20,10,34,0) 30%, rgba(20,10,34,0) 65%, rgba(20,10,34,0.64) 100%)'},
  content: {flex: 1, justifyContent: 'space-between'},
  header: {flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 20, minHeight: 70, zIndex: 10},
  brandMark: {width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(222,203,255,0.15)', alignItems: 'center', justifyContent: 'center'},
  brandLetter: {fontSize: 16, fontWeight: '700', color: '#eadcff'},
  headerText: {flex: 1, alignItems: 'center', paddingHorizontal: 10},
  name: {fontSize: 19, fontWeight: '600', color: '#fff', textShadowColor: '#1c0e2a', textShadowRadius: 5, textShadowOffset: {width: 0, height: 1}},
  status: {fontSize: 13, color: '#eee3fb', marginTop: 5, textAlign: 'center'},
  quality: {minWidth: 44, height: 34, borderRadius: 18, backgroundColor: 'rgba(207,185,244,0.22)', alignItems: 'center', justifyContent: 'center'},
  qualityText: {fontSize: 12, fontWeight: '600', color: '#fff'},
  headerSpacer: {width: 36},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 35},
  avatar: {width: 146, height: 146, borderRadius: 73, backgroundColor: '#493456', borderWidth: 1, borderColor: '#806696', alignItems: 'center', justifyContent: 'center'},
  ringingAvatar: {borderWidth: 3, borderColor: '#bc93f4'},
  initials: {fontSize: 46, fontWeight: '500', color: '#f1e7ff'},
  callType: {color: '#c3aed7', fontSize: 12, marginTop: 18, letterSpacing: 0.5},
  bottom: {paddingHorizontal: 12, paddingBottom: Platform.OS === 'ios' ? 12 : 28, paddingTop: 12},
  dock: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', backgroundColor: 'rgba(38,24,54,0.64)', borderRadius: 30, paddingHorizontal: 6, paddingVertical: 16, borderWidth: 1, borderColor: 'rgba(232,211,255,0.07)'},
  incoming: {flexDirection: 'row', justifyContent: 'space-evenly', paddingVertical: 16},
  control: {alignItems: 'center', flexShrink: 1, minWidth: 52},
  controlCircle: {width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(212,191,239,0.18)', alignItems: 'center', justifyContent: 'center'},
  controlSelected: {backgroundColor: '#8055ae', borderWidth: 1, borderColor: '#c8a2f0'},
  endCircle: {backgroundColor: '#ff263b'},
  acceptCircle: {backgroundColor: '#23aa78'},
  controlLabel: {color: '#f6efff', fontSize: 10, marginTop: 8, textAlign: 'center'},
  disabled: {opacity: 0.4}, pressed: {opacity: 0.65},
  icon: {width: 26, height: 26, alignItems: 'center', justifyContent: 'center'},
  micCapsule: {position: 'absolute', top: 2, width: 8, height: 14, borderWidth: 1.6, borderColor: '#fff', borderRadius: 5},
  micBowl: {position: 'absolute', top: 9, width: 16, height: 12, borderBottomWidth: 1.6, borderLeftWidth: 1.6, borderRightWidth: 1.6, borderColor: '#fff', borderBottomLeftRadius: 10, borderBottomRightRadius: 10},
  micStem: {position: 'absolute', bottom: 1, height: 5, width: 1.6, backgroundColor: '#fff'},
  cameraBody: {position: 'absolute', left: 1, top: 6, width: 17, height: 14, borderWidth: 1.6, borderColor: '#fff', borderRadius: 3},
  cameraLens: {position: 'absolute', right: 1, top: 8, width: 7, height: 10, borderWidth: 1.6, borderColor: '#fff', borderRadius: 2, transform: [{skewY: '-15deg'}]},
  shareScreen: {position: 'absolute', bottom: 2, width: 22, height: 15, borderWidth: 1.6, borderColor: '#fff', borderRadius: 3},
  shareArrow: {position: 'absolute', top: -6, fontSize: 25, color: '#fff', backgroundColor: '#473054', lineHeight: 27},
  symbol: {fontSize: 29, color: '#fff', lineHeight: 30},
  handset: {width: 26, height: 20},
  handsetAccept: {transform: [{rotate: '-135deg'}]},
  handsetArch: {position: 'absolute', top: 5, left: 2, width: 22, height: 14, borderTopWidth: 4, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderColor: '#fff'},
  handsetLeft: {position: 'absolute', top: 8, left: 1, width: 7, height: 9, borderRadius: 2, backgroundColor: '#fff', transform: [{rotate: '20deg'}]},
  handsetRight: {position: 'absolute', top: 8, right: 1, width: 7, height: 9, borderRadius: 2, backgroundColor: '#fff', transform: [{rotate: '-20deg'}]},
  iconSlash: {position: 'absolute', width: 28, height: 1.7, backgroundColor: '#fff', transform: [{rotate: '45deg'}]},
  sharingBanner: {alignSelf: 'center', borderRadius: 20, backgroundColor: 'rgba(73,48,97,0.85)', paddingHorizontal: 14, paddingVertical: 7, marginTop: 8},
  sharingText: {fontSize: 12, color: '#f2e5ff'},
  preview: {position: 'absolute', left: 0, top: 0, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(245,231,255,0.5)', backgroundColor: '#2c203b', zIndex: 20, elevation: 8},
  previewVideo: {width: '100%', height: '100%'},
  previewHandle: {position: 'absolute', top: 6, alignSelf: 'center', padding: 4, borderRadius: 5, backgroundColor: 'rgba(15,8,24,0.3)'},
  handleLine: {width: 22, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.85)'},
  youLabel: {position: 'absolute', bottom: 6, left: 8, color: '#fff', fontSize: 10, textShadowColor: '#000', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 3},
});
