import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ToastAndroid,
  ActivityIndicator,
} from 'react-native';
import {Avatar} from '../components/Avatar';
import {Chat, User, ChatMessage, MediaImageItem, VoiceNoteItem} from '../types';
import {formatPresence, getMessageTimestamp} from '../utils/time';
import {MediaGridBubble} from '../components/MediaGridBubble';
import {VoiceBubble} from '../components/VoiceBubble';
import {VoiceReviewBar} from '../components/VoiceReviewBar';
import {FullScreenViewer} from '../components/FullScreenViewer';
import {PhotoSelectTray} from '../components/PhotoSelectTray';
import {CallHistoryBubble} from '../components/CallHistoryBubble';
import {
  pickPhotosFromGallery,
  processImageAttachment,
  startRecordingVoice,
  stopRecordingVoice,
  cancelRecordingVoice,
  saveBatchToPhoneGallery,
} from '../services/mediaBridge';

function formatHeaderTime(timestamp?: number, fallbackTime?: string): string {
  if (!timestamp) return fallbackTime || '';
  const d = new Date(timestamp);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  const timeStr = d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  if (isToday) return timeStr;

  const dateStr = d.toLocaleDateString([], {month: 'short', day: 'numeric'});
  return `${dateStr}, ${timeStr}`;
}

export function ChatScreen({
  chat,
  liveMode,
  rtcStatus,
  onBack,
  onSend,
  onStartCall,
}: {
  chat: Chat;
  liveMode: boolean;
  rtcStatus: string;
  onBack: () => void;
  onSend: (content: any) => void;
  onStartCall?: (user: User, callType: 'audio' | 'video') => void;
}) {
  const [text, setText] = useState('');
  const [, setTick] = useState(0);
  const list = useRef<FlatList<ChatMessage>>(null);

  // Media & Voice States
  const [selectedPhotoUris, setSelectedPhotoUris] = useState<string[]>([]);
  const [isHd, setIsHd] = useState(true);
  const [isProcessingPhotos, setIsProcessingPhotos] = useState(false);

  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedVoice, setRecordedVoice] = useState<VoiceNoteItem | null>(null);
  const [activePlayingId, setActivePlayingId] = useState<string | null>(null);

  const [downloadingAlbumId, setDownloadingAlbumId] = useState<string | null>(null);

  // Full Screen Photo Viewer States
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerImages, setViewerImages] = useState<MediaImageItem[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerIsHd, setViewerIsHd] = useState(false);

  // Live ticker to update relative presence time (e.g. Active 10s ago -> Active 1m ago)
  useEffect(() => {
    const timer = setInterval(() => {
      setTick(t => t + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // Voice recording live timer
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isRecordingAudio) {
      interval = setInterval(() => {
        setRecordingSeconds(s => s + 1);
      }, 1000);
    } else {
      setRecordingSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecordingAudio]);

  // Facebook Messenger standard: newest message is index 0 for native bottom-anchored rendering
  const invertedMessages = useMemo(() => {
    return [...chat.messages].sort((a, b) => {
      const timeA = getMessageTimestamp(a);
      const timeB = getMessageTimestamp(b);
      if (timeA !== timeB) return timeB - timeA; // Newest first
      return b.id.localeCompare(a.id);
    });
  }, [chat.messages]);

  const isNearBottomRef = useRef(true);

  const handleScroll = (event: any) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    // In inverted FlatList, offset 0 is physically the bottom (newest messages)
    isNearBottomRef.current = offsetY < 60;
  };

  const prevMessagesLen = useRef(invertedMessages.length);
  useEffect(() => {
    if (invertedMessages.length > prevMessagesLen.current) {
      const newestMsg = invertedMessages[0];
      if (newestMsg?.from === 'me' || isNearBottomRef.current) {
        requestAnimationFrame(() => {
          list.current?.scrollToOffset({offset: 0, animated: true});
        });
      }
    }
    prevMessagesLen.current = invertedMessages.length;
  }, [invertedMessages]);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      list.current?.scrollToOffset({offset: 0, animated: true});
    });
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    onSend(value);
    scrollToBottom();
  };

  // --- Image Pick & Send Handlers ---
  const handlePickPhotos = async () => {
    const uris = await pickPhotosFromGallery();
    if (uris && uris.length > 0) {
      setSelectedPhotoUris(uris);
    }
  };

  const handleSendSelectedPhotos = async () => {
    if (selectedPhotoUris.length === 0 || isProcessingPhotos) return;
    setIsProcessingPhotos(true);
    try {
      const processedList: MediaImageItem[] = [];
      for (const uri of selectedPhotoUris) {
        const item = await processImageAttachment(uri, isHd);
        if (item) processedList.push(item);
      }

      if (processedList.length > 0) {
        const caption = text.trim();
        if (caption) setText('');
        onSend({
          mediaType: 'image',
          images: processedList,
          isHd,
          text: caption,
        });
        setSelectedPhotoUris([]);
        scrollToBottom();
      }
    } finally {
      setIsProcessingPhotos(false);
    }
  };

  // --- Voice Record & Review Handlers ---
  const handleStartVoiceRecord = async () => {
    const started = await startRecordingVoice();
    if (started) {
      setIsRecordingAudio(true);
      setRecordingSeconds(0);
    }
  };

  const handleStopVoiceRecord = async () => {
    const voiceItem = await stopRecordingVoice();
    setIsRecordingAudio(false);
    if (voiceItem) {
      setRecordedVoice(voiceItem);
    }
  };

  const handleCancelVoiceReview = async () => {
    await cancelRecordingVoice();
    setRecordedVoice(null);
  };

  const handleSendVoice = () => {
    if (!recordedVoice) return;
    onSend({
      mediaType: 'voice',
      voice: recordedVoice,
    });
    setRecordedVoice(null);
    scrollToBottom();
  };

  // --- Package Download All Handler ---
  const handleDownloadAlbum = async (msgId: string, images: MediaImageItem[]) => {
    setDownloadingAlbumId(msgId);
    try {
      const payloads = images.map(img => img.fullBase64 || img.thumb);
      const count = await saveBatchToPhoneGallery(payloads);
      if (Platform.OS === 'android') {
        ToastAndroid.show(`Saved ${count} photos to Gallery`, ToastAndroid.SHORT);
      }
    } catch {
      if (Platform.OS === 'android') {
        ToastAndroid.show('Failed to save photos', ToastAndroid.SHORT);
      }
    } finally {
      setDownloadingAlbumId(null);
    }
  };

  const formatSec = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const renderMessage = ({item, index}: {item: ChatMessage; index: number}) => {
    const isMe = item.from === 'me';
    // In inverted list, index+1 is chronologically older, index-1 is chronologically newer
    const olderMsg = invertedMessages[index + 1];
    const newerMsg = invertedMessages[index - 1];

    const isFirstInGroup = !olderMsg || olderMsg.from !== item.from;
    const isLastInGroup = !newerMsg || newerMsg.from !== item.from;

    // Show date/time separator if this message is first in thread or > 15 mins after previous older message
    const olderTime = olderMsg?.timestamp || 0;
    const currTime = item.timestamp || 0;
    const showTimeDivider =
      !olderMsg || (currTime > 0 && olderTime > 0 && currTime - olderTime > 15 * 60 * 1000);

    const messageTime = item.time || formatHeaderTime(item.timestamp);

    const hasImages = item.mediaType === 'image' && item.images && item.images.length > 0;
    const hasVoice = item.mediaType === 'voice' && item.voice;
    const hasCall = item.mediaType === 'call' || !!item.callDetails;

    return (
      <View key={item.id} style={styles.messageWrapper}>
        {showTimeDivider ? (
          <View style={styles.timeDividerContainer}>
            <Text style={styles.timeDividerText}>
              {formatHeaderTime(item.timestamp, item.time)}
            </Text>
          </View>
        ) : null}

        {/* Facebook Messenger Style User Name above first message of cluster */}
        {!isMe && isFirstInGroup ? (
          <View style={styles.senderNameRow}>
            <Text style={styles.senderNameText}>{chat.user.name}</Text>
          </View>
        ) : null}

        <View
          style={[
            styles.messageRow,
            isMe ? styles.messageRowMe : styles.messageRowThem,
            {marginTop: isFirstInGroup ? 4 : 2},
          ]}>
          {/* Recipient avatar beside bottom message of group */}
          {!isMe ? (
            <View style={styles.themAvatarContainer}>
              {isLastInGroup ? (
                <Avatar name={chat.user.name} online={chat.user.online} size={28} />
              ) : (
                <View style={styles.themAvatarSpacer} />
              )}
            </View>
          ) : null}

          <View style={styles.bubbleContainer}>
            {hasCall ? (
              <CallHistoryBubble
                callDetails={item.callDetails}
                fallbackText={item.text}
                time={messageTime}
                isMe={isMe}
                onCallBack={type => onStartCall?.(chat.user, type)}
              />
            ) : hasImages ? (
              // Media Grid Bubble (1, 2, 3, or 4+ photos with +N overlay & Download All)
              <View>
                <MediaGridBubble
                  images={item.images!}
                  isHd={item.isHd}
                  isMe={isMe}
                  onOpenImage={idx => {
                    setViewerImages(item.images!);
                    setViewerIndex(idx);
                    setViewerIsHd(!!item.isHd);
                    setViewerVisible(true);
                  }}
                  onDownloadAll={() => handleDownloadAlbum(item.id, item.images!)}
                  isDownloading={downloadingAlbumId === item.id}
                />
                {item.text && !item.text.startsWith('📷') ? (
                  <View style={[styles.captionBubble, isMe ? styles.bubbleMe : styles.bubbleThem]}>
                    <Text style={styles.messageText}>{item.text}</Text>
                  </View>
                ) : null}
              </View>
            ) : hasVoice ? (
              // Voice Note Bubble with waveform & playback
              <VoiceBubble
                voice={item.voice!}
                isMe={isMe}
                messageId={item.id}
                activePlayingId={activePlayingId}
                setActivePlayingId={setActivePlayingId}
              />
            ) : (
              // Standard Text Bubble
              <View
                style={[
                  styles.bubble,
                  isMe ? styles.bubbleMe : styles.bubbleThem,
                  isMe
                    ? {
                        borderTopRightRadius: isFirstInGroup ? 18 : 6,
                        borderBottomRightRadius: isLastInGroup ? 4 : 6,
                      }
                    : {
                        borderTopLeftRadius: isFirstInGroup ? 18 : 6,
                        borderBottomLeftRadius: isLastInGroup ? 4 : 6,
                      },
                ]}>
                <Text style={styles.messageText}>{item.text}</Text>
              </View>
            )}

            {/* Always visible timestamp & receipt directly underneath every bubble */}
            {!hasCall && (
              <View style={[styles.metaRow, isMe ? styles.metaRowMe : styles.metaRowThem]}>
                <Text style={styles.metaTime}>{messageTime}</Text>
                {isMe ? (
                  <Text
                    style={[
                      styles.receiptText,
                      item.status === 'seen' && styles.receiptSeen,
                    ]}>
                    {item.status === 'seen'
                      ? ' · Seen'
                      : item.status === 'delivered'
                      ? ' · Delivered'
                      : ' · Sent'}
                  </Text>
                ) : null}
              </View>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={4}>
      {/* Facebook Messenger Style Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn}>
          <Text style={styles.backArrow}>‹</Text>
        </Pressable>
        <Avatar name={chat.user.name} online={chat.user.online} size={42} />
        <View style={styles.headerInfo}>
          <Text numberOfLines={1} style={styles.headerName}>
            {chat.user.name}
          </Text>
          <Text
            style={[
              styles.headerPresence,
              chat.user.online ? styles.presenceOnline : styles.presenceOffline,
            ]}>
            {formatPresence(chat.user.online, chat.user.lastActive)}
          </Text>
        </View>
        <View style={styles.headerBadge}>
          <Text style={styles.badgeText}>
            {liveMode ? `E2EE · ${rtcStatus.toUpperCase()}` : 'DEMO'}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => onStartCall?.(chat.user, 'audio')}
            hitSlop={8}
            style={styles.headerCallBtn}>
            <Text style={styles.headerCallIcon}>📞</Text>
          </Pressable>
          <Pressable
            onPress={() => onStartCall?.(chat.user, 'video')}
            hitSlop={8}
            style={styles.headerCallBtn}>
            <Text style={styles.headerCallIcon}>📹</Text>
          </Pressable>
        </View>
      </View>

      {/* Facebook Messenger Style Inverted Message List - naturally anchored to bottom at 0ms */}
      <FlatList
        ref={list}
        data={invertedMessages}
        inverted={true}
        keyExtractor={m => m.id}
        style={{flex: 1}}
        contentContainerStyle={[styles.messagesContainer, {paddingTop: 16, paddingBottom: 10}]}
        ListHeaderComponent={<View style={{height: 10}} />}
        ListFooterComponent={<View style={{height: 14}} />}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        renderItem={renderMessage}
        showsVerticalScrollIndicator={false}
        initialNumToRender={14}
        maxToRenderPerBatch={10}
        windowSize={7}
        updateCellsBatchingPeriod={40}
        removeClippedSubviews={Platform.OS === 'android'}
        ListEmptyComponent={
          <View style={[styles.emptyContainer, {transform: [{scaleY: -1}]}]}>
            <Avatar name={chat.user.name} online={chat.user.online} size={70} />
            <Text style={styles.emptyTitle}>{chat.user.name}</Text>
            <Text style={styles.emptySubtitle}>
              {liveMode
                ? 'Signal Protocol Double Ratchet E2EE · Messages & Media are end-to-end encrypted.'
                : 'Send your first message to start conversation.'}
            </Text>
          </View>
        }
      />

      {/* Photo Picker Tray when photos are selected (compact strip attached directly above composer) */}
      {selectedPhotoUris.length > 0 ? (
        <PhotoSelectTray
          selectedUris={selectedPhotoUris}
          isHd={isHd}
          onToggleHd={() => setIsHd(v => !v)}
          onCancel={() => setSelectedPhotoUris([])}
        />
      ) : null}

      {/* When voice note has been recorded, show review bar INSTEAD of composer */}
      {recordedVoice ? (
        <VoiceReviewBar
          voice={recordedVoice}
          onSend={handleSendVoice}
          onCancel={handleCancelVoiceReview}
        />
      ) : isRecordingAudio ? (
        /* When actively recording audio, show recording bar INSTEAD of composer */
        <View style={styles.recordingBar}>
          <View style={styles.recordingPulse}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingTimer}>{formatSec(recordingSeconds)}</Text>
          </View>
          <Text style={styles.recordingTip}>Recording voice note...</Text>
          <Pressable onPress={handleStopVoiceRecord} style={styles.stopRecordBtn}>
            <Text style={styles.stopRecordIcon}>⏹</Text>
            <Text style={styles.stopRecordText}>Done</Text>
          </Pressable>
        </View>
      ) : (
        /* Facebook Messenger Style Composer with Gallery & Voice icons */
        <View style={styles.composerContainer}>
          {/* Gallery Pick Button */}
          <Pressable
            onPress={handlePickPhotos}
            hitSlop={8}
            style={styles.composerActionBtn}>
            <Text style={styles.actionIcon}>🖼️</Text>
          </Pressable>

          {/* Microphone Record Button */}
          <Pressable
            onPress={handleStartVoiceRecord}
            hitSlop={8}
            style={styles.composerActionBtn}>
            <Text style={styles.actionIcon}>🎙️</Text>
          </Pressable>

          {/* Text Input Pill */}
          <View style={styles.inputPill}>
            <TextInput
              editable={!isProcessingPhotos}
              value={text}
              onChangeText={setText}
              placeholder={selectedPhotoUris.length > 0 ? 'Add a caption...' : 'Aa'}
              placeholderTextColor="#8A8D91"
              style={styles.input}
              multiline
            />
          </View>

          {/* Send / Action Button */}
          <Pressable
            onPress={selectedPhotoUris.length > 0 ? handleSendSelectedPhotos : send}
            disabled={isProcessingPhotos || (selectedPhotoUris.length === 0 && !text.trim())}
            style={[
              styles.sendBtn,
              (isProcessingPhotos || (selectedPhotoUris.length === 0 && !text.trim())) && styles.sendBtnDisabled,
            ]}>
            {isProcessingPhotos ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.sendIcon}>➤</Text>
            )}
          </Pressable>
        </View>
      )}

      {/* Fullscreen HD Image Viewer */}
      <FullScreenViewer
        visible={viewerVisible}
        images={viewerImages}
        initialIndex={viewerIndex}
        isHd={viewerIsHd}
        onClose={() => setViewerVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#18191A',
  },
  header: {
    height: 64,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#242526',
    borderBottomWidth: 1,
    borderBottomColor: '#393A3B',
    gap: 10,
  },
  backBtn: {
    paddingRight: 6,
    paddingVertical: 8,
  },
  backArrow: {
    color: '#0084FF',
    fontSize: 34,
    lineHeight: 34,
    fontWeight: '300',
  },
  headerInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  headerName: {
    color: '#E4E6EB',
    fontSize: 16,
    fontWeight: '700',
  },
  headerPresence: {
    fontSize: 11,
    marginTop: 2,
    fontWeight: '500',
  },
  presenceOnline: {
    color: '#31A24C',
  },
  presenceOffline: {
    color: '#B0B3B8',
  },
  headerBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#3A3B3C',
    borderRadius: 12,
  },
  badgeText: {
    color: '#E4E6EB',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 4,
  },
  headerCallBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#3A3B3C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCallIcon: {
    fontSize: 17,
  },
  messagesContainer: {
    paddingHorizontal: 12,
    paddingTop: 16,
  },
  messageWrapper: {
    marginVertical: 1,
  },
  timeDividerContainer: {
    alignItems: 'center',
    marginVertical: 14,
  },
  timeDividerText: {
    color: '#8A8D91',
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: '#242526',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  senderNameRow: {
    marginLeft: 38,
    marginBottom: 3,
    marginTop: 6,
  },
  senderNameText: {
    color: '#B0B3B8',
    fontSize: 11,
    fontWeight: '600',
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  messageRowMe: {
    justifyContent: 'flex-end',
  },
  messageRowThem: {
    justifyContent: 'flex-start',
  },
  themAvatarContainer: {
    width: 28,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginBottom: 16,
  },
  themAvatarSpacer: {
    width: 28,
    height: 28,
  },
  bubbleContainer: {
    maxWidth: '75%',
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  captionBubble: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    marginTop: 2,
  },
  bubbleMe: {
    backgroundColor: '#0084FF',
  },
  bubbleThem: {
    backgroundColor: '#303030',
  },
  messageText: {
    color: '#FFFFFF',
    fontSize: 15,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
    paddingHorizontal: 4,
  },
  metaRowMe: {
    justifyContent: 'flex-end',
  },
  metaRowThem: {
    justifyContent: 'flex-start',
  },
  metaTime: {
    color: '#8A8D91',
    fontSize: 10,
    fontWeight: '500',
  },
  receiptText: {
    color: '#8A8D91',
    fontSize: 10,
    fontWeight: '500',
  },
  receiptSeen: {
    color: '#53BDEB',
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 36,
    paddingVertical: 60,
    gap: 12,
  },
  emptyTitle: {
    color: '#E4E6EB',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 8,
  },
  emptySubtitle: {
    color: '#B0B3B8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#242526',
    borderTopWidth: 1,
    borderTopColor: '#333333',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  recordingPulse: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FF3B30',
  },
  recordingTimer: {
    color: '#FF3B30',
    fontSize: 14,
    fontWeight: '800',
  },
  recordingTip: {
    color: '#8A8D91',
    fontSize: 12,
  },
  stopRecordBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0084FF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    gap: 4,
  },
  stopRecordIcon: {
    color: '#FFFFFF',
    fontSize: 12,
  },
  stopRecordText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  composerContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: '#242526',
    borderTopWidth: 1,
    borderTopColor: '#393A3B',
    gap: 6,
  },
  composerActionBtn: {
    width: 36,
    height: 38,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionBtnActive: {
    backgroundColor: 'rgba(255, 59, 48, 0.2)',
    borderRadius: 18,
  },
  actionIcon: {
    fontSize: 20,
  },
  inputPill: {
    flex: 1,
    backgroundColor: '#3A3B3C',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
    minHeight: 40,
    maxHeight: 110,
    justifyContent: 'center',
  },
  input: {
    color: '#E4E6EB',
    fontSize: 15,
    padding: 0,
    maxHeight: 90,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#0084FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 1,
  },
  sendBtnDisabled: {
    opacity: 0.35,
  },
  sendIcon: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
    marginLeft: 2,
  },
});
