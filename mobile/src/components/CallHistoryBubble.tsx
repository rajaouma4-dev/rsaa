import React from 'react';
import {View, Text, StyleSheet, Pressable} from 'react-native';
import {CallDetails} from '../types';

interface CallHistoryBubbleProps {
  callDetails?: CallDetails;
  fallbackText?: string;
  time: string;
  isMe: boolean;
  onCallBack?: (callType: 'audio' | 'video') => void;
}

export function CallHistoryBubble({
  callDetails,
  fallbackText,
  time,
  isMe,
  onCallBack,
}: CallHistoryBubbleProps) {
  const isVideo = callDetails?.callType === 'video';
  const isMissed =
    callDetails?.status === 'missed' && !callDetails.isCaller;
  const isNoAnswer =
    callDetails?.status === 'missed' && callDetails.isCaller;
  const isDeclined = callDetails?.status === 'declined';
  const isCompleted =
    callDetails?.status === 'completed' || (!isMissed && !isNoAnswer && !isDeclined);

  const durationText = callDetails?.durationFormatted || '0s';
  const callType = callDetails?.callType || 'audio';

  // Title formatting
  let title = '';
  let subtitle = '';

  if (isMissed) {
    title = isVideo ? 'Missed video call' : 'Missed audio call';
    subtitle = 'You missed a call';
  } else if (isNoAnswer) {
    title = isVideo ? 'Video call' : 'Audio call';
    subtitle = 'No answer';
  } else if (isDeclined) {
    title = isVideo ? 'Video call' : 'Audio call';
    subtitle = 'Call declined';
  } else {
    title = isVideo ? 'Video call' : 'Audio call';
    subtitle = durationText !== '0s' ? `${durationText}` : 'Call ended';
  }

  const handlePressCallBack = () => {
    onCallBack?.(callType);
  };

  return (
    <View
      style={[
        styles.cardContainer,
        isMissed && styles.cardMissed,
        isCompleted && styles.cardCompleted,
      ]}>
      <View style={styles.contentRow}>
        {/* Icon Circle */}
        <View
          style={[
            styles.iconCircle,
            isMissed && styles.iconCircleMissed,
            isCompleted && styles.iconCircleCompleted,
          ]}>
          <Text style={styles.callIcon}>
            {isVideo ? (isMissed ? '📹' : '📹') : (isMissed ? '📞' : '📞')}
          </Text>
          {isMissed ? (
            <View style={styles.missedArrowBadge}>
              <Text style={styles.missedArrowText}>↙</Text>
            </View>
          ) : null}
        </View>

        {/* Text Details */}
        <View style={styles.infoCol}>
          <Text
            style={[
              styles.callTitle,
              isMissed && styles.callTitleMissed,
            ]}
            numberOfLines={1}>
            {title}
          </Text>

          <View style={styles.subRow}>
            {isCompleted && callDetails?.durationSec && callDetails.durationSec > 0 ? (
              <View style={styles.durationPill}>
                <Text style={styles.durationIcon}>⏱️</Text>
                <Text style={styles.durationPillText}>{durationText}</Text>
              </View>
            ) : (
              <Text style={[styles.subText, isMissed && styles.subTextMissed]}>
                {subtitle}
              </Text>
            )}
            <Text style={styles.bulletDot}>·</Text>
            <Text style={styles.timeText}>{time}</Text>
          </View>
        </View>
      </View>

      {/* Call Back / Call Again Button */}
      <Pressable
        onPress={handlePressCallBack}
        hitSlop={6}
        style={({pressed}) => [
          styles.callBackBtn,
          isMissed ? styles.callBackBtnMissed : styles.callBackBtnStandard,
          pressed && styles.callBackBtnPressed,
        ]}>
        <Text
          style={[
            styles.callBackBtnText,
            isMissed ? styles.callBackBtnTextMissed : styles.callBackBtnTextStandard,
          ]}>
          {isVideo ? '📹 Call Back' : '📞 Call Back'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  cardContainer: {
    minWidth: 230,
    maxWidth: 290,
    backgroundColor: '#18191a',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#3a3b3c',
    padding: 12,
    marginVertical: 4,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  cardMissed: {
    borderColor: 'rgba(239, 68, 68, 0.45)',
    backgroundColor: '#1f1315',
  },
  cardCompleted: {
    borderColor: 'rgba(59, 130, 246, 0.35)',
    backgroundColor: '#131b26',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    position: 'relative',
  },
  iconCircleMissed: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
  },
  iconCircleCompleted: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
  },
  callIcon: {
    fontSize: 20,
  },
  missedArrowBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    backgroundColor: '#ef4444',
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  missedArrowText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '900',
    lineHeight: 12,
  },
  infoCol: {
    flex: 1,
    justifyContent: 'center',
  },
  callTitle: {
    color: '#e4e6eb',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 3,
  },
  callTitleMissed: {
    color: '#f87171',
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  subText: {
    color: '#b0b3b8',
    fontSize: 12,
    fontWeight: '500',
  },
  subTextMissed: {
    color: '#fca5a5',
  },
  durationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  durationIcon: {
    fontSize: 10,
    marginRight: 3,
  },
  durationPillText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  bulletDot: {
    color: '#65676b',
    marginHorizontal: 5,
    fontSize: 12,
  },
  timeText: {
    color: '#8a8d91',
    fontSize: 11,
    fontWeight: '500',
  },
  callBackBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBackBtnStandard: {
    backgroundColor: 'rgba(59, 130, 246, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.35)',
  },
  callBackBtnMissed: {
    backgroundColor: 'rgba(239, 68, 68, 0.22)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.45)',
  },
  callBackBtnPressed: {
    opacity: 0.75,
  },
  callBackBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  callBackBtnTextStandard: {
    color: '#60a5fa',
  },
  callBackBtnTextMissed: {
    color: '#fca5a5',
  },
});
