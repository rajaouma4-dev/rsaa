import React, {useState} from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  Modal,
  StyleSheet,
  ActivityIndicator,
  ToastAndroid,
  Platform,
} from 'react-native';
import {useModalInsets} from '../utils/layout';
import {MediaImageItem} from '../types';
import {saveBatchToPhoneGallery} from '../services/mediaBridge';

interface FullScreenViewerProps {
  visible: boolean;
  images: MediaImageItem[];
  initialIndex: number;
  isHd?: boolean;
  onClose: () => void;
}

export function FullScreenViewer({
  visible,
  images,
  initialIndex,
  isHd,
  onClose,
}: FullScreenViewerProps) {
  const insets=useModalInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex || 0);
  const [isSaving, setIsSaving] = useState(false);

  // Sync index when initialIndex changes
  React.useEffect(() => {
    setCurrentIndex(Math.max(0,Math.min(initialIndex||0,images.length-1)));
  }, [initialIndex,visible,images.length]);

  if (!images || images.length === 0) return null;

  const currentImg = images[currentIndex] || images[0];

  const handleDownload = async () => {
    if (!currentImg) return;
    setIsSaving(true);
    try {
      const targetData = currentImg.fullBase64 || currentImg.thumb;
      await saveBatchToPhoneGallery([targetData]);
      if (Platform.OS === 'android') {
        ToastAndroid.show('Photo saved to Gallery', ToastAndroid.SHORT);
      }
    } catch {
      if (Platform.OS === 'android') {
        ToastAndroid.show('Failed to save photo', ToastAndroid.SHORT);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
  };

  const handleNext = () => {
    if (currentIndex < images.length - 1) setCurrentIndex(currentIndex + 1);
  };

  return (
    <Modal
      statusBarTranslucent
      navigationBarTranslucent
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}>
      <View style={[styles.container,{paddingTop:insets.top,paddingBottom:insets.bottom,paddingLeft:insets.left,paddingRight:insets.right}]}>
        {/* Top Navigation Bar */}
        <View style={styles.topBar}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.actionBtn}>
            <Text style={styles.closeIcon}>✕</Text>
          </Pressable>

          <View style={styles.titleContainer}>
            <Text style={styles.counterText}>
              {currentIndex + 1} of {images.length}
            </Text>
            {isHd ? (
              <View style={styles.hdBadge}>
                <Text style={styles.hdText}>HD</Text>
              </View>
            ) : null}
          </View>

          <Pressable
            accessibilityLabel="Save image to gallery"
            onPress={handleDownload}
            disabled={isSaving}
            hitSlop={12}
            style={styles.actionBtn}>
            {isSaving ? (
              <ActivityIndicator size="small" color="#00BFA5" />
            ) : (
              <Text style={styles.downloadIcon}>⬇</Text>
            )}
          </Pressable>
        </View>

        {/* Main Image Stage */}
        <View style={styles.stage}>
          <Image
            source={{uri: currentImg.fullBase64 ? (currentImg.fullBase64.startsWith('data:')?currentImg.fullBase64:`data:image/jpeg;base64,${currentImg.fullBase64}`) : currentImg.thumb}}
            style={styles.fullImage}
            resizeMode="contain"
          />

          {/* Left Arrow */}
          {currentIndex > 0 ? (
            <Pressable onPress={handlePrev} style={[styles.navArrow, styles.navArrowLeft]}>
              <Text style={styles.arrowText}>‹</Text>
            </Pressable>
          ) : null}

          {/* Right Arrow */}
          {currentIndex < images.length - 1 ? (
            <Pressable onPress={handleNext} style={[styles.navArrow, styles.navArrowRight]}>
              <Text style={styles.arrowText}>›</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    zIndex: 10,
  },
  actionBtn: {
    padding: 8,
    minWidth:44,
    minHeight:44,
    alignItems:'center',
    justifyContent:'center',
  },
  closeIcon: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: 'bold',
  },
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  counterText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  hdBadge: {
    backgroundColor: '#00BFA5',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  hdText: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '800',
  },
  downloadIcon: {
    color: '#00BFA5',
    fontSize: 22,
    fontWeight: 'bold',
  },
  stage: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  fullImage: {
    width: '100%',
    height: '100%',
  },
  navArrow: {
    position: 'absolute',
    top: '46%',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navArrowLeft: {
    left: 12,
  },
  navArrowRight: {
    right: 12,
  },
  arrowText: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '300',
    marginTop: -2,
  },
});
