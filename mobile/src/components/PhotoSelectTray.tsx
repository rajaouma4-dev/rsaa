import React from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  Pressable,
  StyleSheet,
} from 'react-native';

interface PhotoSelectTrayProps {
  selectedUris: string[];
  isHd: boolean;
  onToggleHd: () => void;
  onCancel: () => void;
}

export function PhotoSelectTray({
  selectedUris,
  isHd,
  onToggleHd,
  onCancel,
}: PhotoSelectTrayProps) {
  if (!selectedUris || selectedUris.length === 0) return null;

  return (
    <View style={styles.container}>
      {/* Top Controls: Photo Count + HD Toggle + Cancel */}
      <View style={styles.headerRow}>
        <View style={styles.counterBox}>
          <Text style={styles.counterText}>
            📷 {selectedUris.length} {selectedUris.length === 1 ? 'photo' : 'photos'} attached
          </Text>
        </View>

        <View style={styles.actionsBox}>
          {/* HD Mode Toggle Badge */}
          <Pressable
            onPress={onToggleHd}
            hitSlop={8}
            style={[styles.hdToggleBtn, isHd && styles.hdToggleActive]}>
            <Text style={[styles.hdToggleText, isHd && styles.hdToggleTextActive]}>
              HD
            </Text>
          </Pressable>

          <Pressable onPress={onCancel} hitSlop={10} style={styles.cancelBtn}>
            <Text style={styles.cancelText}>✕</Text>
          </Pressable>
        </View>
      </View>

      {/* Horizontal thumbnail scrollview */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}>
        {selectedUris.map((uri, idx) => (
          <View key={uri + idx} style={styles.thumbWrapper}>
            <Image source={{uri}} style={styles.thumbImage} resizeMode="cover" />
            <View style={styles.indexBadge}>
              <Text style={styles.indexText}>{idx + 1}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1E1E1E',
    borderTopWidth: 1,
    borderTopColor: '#333333',
    paddingTop: 8,
    paddingBottom: 6,
    paddingHorizontal: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  counterBox: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  counterText: {
    color: '#E4E6EB',
    fontSize: 12,
    fontWeight: '600',
  },
  actionsBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  hdToggleBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: '#65676B',
    backgroundColor: 'transparent',
  },
  hdToggleActive: {
    borderColor: '#00BFA5',
    backgroundColor: '#00BFA5',
  },
  hdToggleText: {
    color: '#B0B3B8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  hdToggleTextActive: {
    color: '#000000',
  },
  cancelBtn: {
    padding: 2,
  },
  cancelText: {
    color: '#B0B3B8',
    fontSize: 16,
    fontWeight: 'bold',
  },
  scrollContent: {
    paddingVertical: 2,
    gap: 8,
  },
  thumbWrapper: {
    width: 52,
    height: 52,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  indexBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 132, 255, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  indexText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: 'bold',
  },
});
