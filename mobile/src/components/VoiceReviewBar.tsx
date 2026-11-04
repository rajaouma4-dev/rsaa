import React, {useState, useEffect} from 'react';
import {View, Text, Pressable, StyleSheet} from 'react-native';
import {VoiceNoteItem} from '../types';
import {playVoiceNote, stopVoiceNote} from '../services/mediaBridge';

interface VoiceReviewBarProps {
  voice: VoiceNoteItem;
  onSend: () => void;
  onCancel: () => void;
}

export function VoiceReviewBar({voice, onSend, onCancel}: VoiceReviewBarProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (isPlaying) {
      timer = setInterval(() => {
        setElapsed(e => {
          if (e >= (voice.durationSec || 1)) {
            return 0;
          }
          return e + 1;
        });
      }, 1000);
    } else {
      setElapsed(0);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isPlaying, voice.durationSec]);

  const togglePlay = async () => {
    if (isPlaying) {
      await stopVoiceNote();
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      setElapsed(0);
      await playVoiceNote(voice.audioBase64, () => {
        setIsPlaying(false);
        setElapsed(0);
      });
    }
  };

  const handleCancel = async () => {
    await stopVoiceNote();
    onCancel();
  };

  const handleSend = async () => {
    await stopVoiceNote();
    onSend();
  };

  const formatSec = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <View style={styles.container}>
      {/* Delete / Cancel Button */}
      <Pressable onPress={handleCancel} style={styles.cancelBtn} hitSlop={10}>
        <Text style={styles.cancelIcon}>🗑</Text>
      </Pressable>

      {/* Play / Preview Voice */}
      <Pressable onPress={togglePlay} style={styles.playBtn} hitSlop={10}>
        <Text style={styles.playIcon}>{isPlaying ? '❚❚' : '▶'}</Text>
      </Pressable>

      {/* Timer & Status */}
      <View style={styles.infoContainer}>
        <Text style={styles.previewLabel}>Voice Note Preview</Text>
        <Text style={styles.timerText}>
          {isPlaying ? formatSec(elapsed) : formatSec(voice.durationSec || 0)}
        </Text>
      </View>

      {/* Send Button */}
      <Pressable onPress={handleSend} style={styles.sendBtn} hitSlop={10}>
        <Text style={styles.sendIcon}>➤</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E1E1E',
    borderTopWidth: 1,
    borderTopColor: '#333333',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  cancelBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 75, 75, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  cancelIcon: {
    fontSize: 16,
  },
  playBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#7957E8',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  playIcon: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
    marginLeft: 2,
  },
  infoContainer: {
    flex: 1,
    minWidth:0,
  },
  previewLabel: {
    color: '#A4B1C7',
    fontSize: 11,
    fontWeight: '600',
  },
  timerText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#00BFA5',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendIcon: {
    color: '#000000',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
