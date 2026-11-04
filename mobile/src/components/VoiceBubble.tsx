import React, {useState, useEffect} from 'react';
import {View, Text, Pressable, StyleSheet} from 'react-native';
import {bubbleTextColor} from '../services/chatAppearance';
import {VoiceNoteItem} from '../types';
import {playVoiceNote, stopVoiceNote} from '../services/mediaBridge';

interface VoiceBubbleProps {
  bubbleColor?: string;
  voice: VoiceNoteItem;
  isMe: boolean;
  messageId: string;
  activePlayingId: string | null;
  setActivePlayingId: (id: string | null) => void;
}

function VoiceBubbleComponent({
  voice,
  bubbleColor,
  isMe,
  messageId,
  activePlayingId,
  setActivePlayingId,
}: VoiceBubbleProps) {
  const isPlaying = activePlayingId === messageId;
  const [playbackSeconds, setPlaybackSeconds] = useState(0);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isPlaying) {
      interval = setInterval(() => {
        setPlaybackSeconds(s => {
          if (s >= (voice.durationSec || 1)) {
            return 0;
          }
          return s + 1;
        });
      }, 1000);
    } else {
      setPlaybackSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isPlaying, voice.durationSec]);

  const togglePlay = async () => {
    if (isPlaying) {
      await stopVoiceNote();
      setActivePlayingId(null);
    } else {
      setActivePlayingId(messageId);
      setPlaybackSeconds(0);
      await playVoiceNote(voice.audioBase64, () => {
        setActivePlayingId(null);
        setPlaybackSeconds(0);
      });
    }
  };

  const formatSec = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Mock waveform bars with aesthetic heights
  const bars = [12, 18, 26, 14, 20, 28, 16, 22, 12, 18, 24, 15, 20, 10];

  return (
    <View style={[styles.container, isMe ? [styles.containerMe,{backgroundColor:bubbleColor || '#7957E8'}] : styles.containerThem]}>
      {/* Play/Pause Button */}
      <Pressable onPress={togglePlay} style={styles.playBtn} hitSlop={10}>
        <Text style={[styles.playIcon,isMe&&bubbleColor?{color:bubbleTextColor(bubbleColor)}:null]}>{isPlaying ? '❚❚' : '▶'}</Text>
      </Pressable>

      {/* Waveform graphic */}
      <View style={styles.waveformContainer}>
        {bars.map((height, i) => {
          const isPassed = isPlaying && i / bars.length <= playbackSeconds / (voice.durationSec || 1);
          return (
            <View
              key={i}
              style={[
                styles.waveBar,
                {height},
                isPassed ? styles.waveBarActive : styles.waveBarInactive,
              ]}
            />
          );
        })}
      </View>

      {/* Duration / Timer */}
      <View style={styles.infoCol}>
        <Text style={[styles.timerText,isMe&&bubbleColor?{color:bubbleTextColor(bubbleColor)}:null]}>
          {isPlaying ? formatSec(playbackSeconds) : formatSec(voice.durationSec || 0)}
        </Text>
        <Text style={styles.micBadge}>🎙</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    width: 230,
    maxWidth: '100%',

  },
  containerMe: {
    backgroundColor: '#0084FF',
  },
  containerThem: {
    backgroundColor: '#242526',
  },
  playBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  playIcon: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
    marginLeft: 2,
  },
  waveformContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 30,
    minWidth:0,
    overflow: 'hidden',
    marginRight: 10,
  },
  waveBar: {
    width: 3,
    flexShrink:1,
    borderRadius: 2,
  },
  waveBarActive: {
    backgroundColor: '#00FFB2',
  },
  waveBarInactive: {
    backgroundColor: 'rgba(255, 255, 255, 0.45)',
  },
  infoCol: {
    alignItems: 'center',
  },
  timerText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  micBadge: {
    fontSize: 10,
    marginTop: 2,
  },
});

export const VoiceBubble = React.memo(VoiceBubbleComponent);
