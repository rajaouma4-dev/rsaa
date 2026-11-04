import React from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import {mediaWidth} from '../utils/layout';
import {MediaImageItem} from '../types';

interface MediaGridBubbleProps {
  images: MediaImageItem[];
  isHd?: boolean;
  isMe: boolean;
  onOpenImage: (index: number) => void;
  onDownloadAll: () => void;
  isDownloading?: boolean;
}

function MediaGridBubbleComponent({
  images,
  isHd,
  isMe,
  onOpenImage,
  onDownloadAll,
  isDownloading,
}: MediaGridBubbleProps) {
  const {width}=useWindowDimensions();
  const gridWidth=mediaWidth(width);
  if (!images || images.length === 0) return null;

  const total = images.length;

  const getImgUri = (img?: MediaImageItem): string => {
    if (!img) return '';
    // Crisp 480px thumbnail for instant, stutter-free 60fps in-bubble rendering
    if (img.thumb) {
      return img.thumb.startsWith('data:') ? img.thumb : `data:image/jpeg;base64,${img.thumb}`;
    }
    if (img.fullBase64) {
      return img.fullBase64.startsWith('data:') ? img.fullBase64 : `data:image/jpeg;base64,${img.fullBase64}`;
    }
    return '';
  };

  // Dynamic aspect ratio calculation for single photo
  let singleWidth = 250;
  let singleHeight = 250;
  if (images[0]?.width && images[0]?.height) {
    const ar = images[0].width / images[0].height;
    if (ar >= 1) {
      singleWidth = 260;
      singleHeight = Math.max(160, Math.min(260, Math.round(260 / ar)));
    } else {
      singleHeight = Math.min(340, Math.max(220, Math.round(240 / ar)));
      singleWidth = Math.min(260, Math.max(180, Math.round(singleHeight * ar)));
    }
  }

  const scale=Math.min(1,gridWidth/singleWidth);singleWidth*=scale;singleHeight*=scale;
  return (
    <View style={[styles.container, isMe ? styles.containerMe : styles.containerThem]}>
      {total === 1 ? (
        // 1 Single Photo: Edge-to-edge dynamic preview with floating Save & HD pills
        <Pressable
          onPress={() => onOpenImage(0)}
          style={[styles.singleImageContainer, {width: singleWidth, height: singleHeight}]}>
          <Image
            source={{uri: getImgUri(images[0])}}
            style={styles.singleImage}
            resizeMode="cover"
          />
          {/* Floating Controls Overlay */}
          <View style={styles.floatingControls}>
            {isHd ? (
              <View style={styles.hdBadge}>
                <Text style={styles.hdText}>HD</Text>
              </View>
            ) : (
              <View />
            )}
            <Pressable
              onPress={onDownloadAll}
              hitSlop={8}
              disabled={isDownloading}
              style={({pressed}) => [
                styles.floatingDownloadBtn,
                pressed && {opacity: 0.7},
              ]}>
              {isDownloading ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  <Text style={styles.downloadIcon}>⬇</Text>
                  <Text style={styles.downloadText}>Save</Text>
                </>
              )}
            </Pressable>
          </View>
        </Pressable>
      ) : (
        // 2+ Photos: Album with header and multi-grid layout
        <>
          <View style={styles.albumHeader}>
            {isHd ? (
              <View style={styles.hdBadge}>
                <Text style={styles.hdText}>HD</Text>
              </View>
            ) : (
              <View />
            )}
            <Pressable
              onPress={onDownloadAll}
              hitSlop={8}
              disabled={isDownloading}
              style={({pressed}) => [
                styles.downloadAllBtn,
                pressed && {opacity: 0.7},
              ]}>
              {isDownloading ? (
                <ActivityIndicator size="small" color="#0084FF" />
              ) : (
                <>
                  <Text style={styles.downloadIcon}>⬇</Text>
                  <Text style={styles.downloadText}>
                    {`Save All (${total})`}
                  </Text>
                </>
              )}
            </Pressable>
          </View>

          {total === 2 ? (
            // 2 Photos: Side-by-side
            <View style={[styles.twoGridRow,{width:gridWidth,height:gridWidth*.56}]}>
              {images.slice(0, 2).map((img, idx) => (
                <Pressable
                  key={img.id || idx}
                  onPress={() => onOpenImage(idx)}
                  style={styles.halfImageWrapper}>
                  <Image
                    source={{uri: getImgUri(img)}}
                    style={styles.gridImage}
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
            </View>
          ) : total === 3 ? (
            // 3 Photos: 1 on left, 2 stacked on right
            <View style={[styles.threeGridRow,{width:gridWidth,height:gridWidth*.72}]}>
              <Pressable
                onPress={() => onOpenImage(0)}
                style={styles.threeLargeWrapper}>
                <Image
                  source={{uri: getImgUri(images[0])}}
                  style={styles.gridImage}
                  resizeMode="cover"
                />
              </Pressable>
              <View style={styles.threeStackedColumn}>
                {images.slice(1, 3).map((img, idx) => (
                  <Pressable
                    key={img.id || idx}
                    onPress={() => onOpenImage(idx + 1)}
                    style={styles.threeSmallWrapper}>
                    <Image
                      source={{uri: getImgUri(img)}}
                      style={styles.gridImage}
                      resizeMode="cover"
                    />
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            // 4 or 4+ Photos: 2x2 Matrix with +N overlay on 4th photo
            <View style={[styles.fourGridContainer,{width:gridWidth,height:gridWidth}]}>
              <View style={styles.fourGridRow}>
                <Pressable onPress={() => onOpenImage(0)} style={styles.quarterWrapper}>
                  <Image
                    source={{uri: getImgUri(images[0])}}
                    style={styles.gridImage}
                    resizeMode="cover"
                  />
                </Pressable>
                <Pressable onPress={() => onOpenImage(1)} style={styles.quarterWrapper}>
                  <Image
                    source={{uri: getImgUri(images[1])}}
                    style={styles.gridImage}
                    resizeMode="cover"
                  />
                </Pressable>
              </View>
              <View style={styles.fourGridRow}>
                <Pressable onPress={() => onOpenImage(2)} style={styles.quarterWrapper}>
                  <Image
                    source={{uri: getImgUri(images[2])}}
                    style={styles.gridImage}
                    resizeMode="cover"
                  />
                </Pressable>
                <Pressable onPress={() => onOpenImage(3)} style={styles.quarterWrapper}>
                  <Image
                    source={{uri: getImgUri(images[3])}}
                    style={styles.gridImage}
                    resizeMode="cover"
                  />
                  {total > 4 ? (
                    <View style={styles.moreOverlay}>
                      <Text style={styles.moreText}>+{total - 3}</Text>
                    </View>
                  ) : null}
                </Pressable>
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 16,
    overflow: 'hidden',
    maxWidth: 270,
    backgroundColor: 'transparent',
  },
  containerMe: {
    backgroundColor: 'transparent',
  },
  containerThem: {
    backgroundColor: 'transparent',
  },
  floatingControls: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  floatingDownloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  albumHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  hdBadge: {
    backgroundColor: '#00BFA5',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  hdText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  downloadAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  downloadIcon: {
    color: '#FFFFFF',
    fontSize: 12,
    marginRight: 4,
  },
  downloadText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
  singleImageContainer: {
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
  },
  singleImage: {
    width: '100%',
    height: '100%',
    borderRadius: 16,
  },
  twoGridRow: {
    flexDirection: 'row',
    width: 250,
    height: 140,
    gap: 3,
  },
  halfImageWrapper: {
    flex: 1,
    height: '100%',
  },
  threeGridRow: {
    flexDirection: 'row',
    width: 250,
    height: 180,
    gap: 3,
  },
  threeLargeWrapper: {
    flex: 1.2,
    height: '100%',
  },
  threeStackedColumn: {
    flex: 1,
    height: '100%',
    gap: 3,
  },
  threeSmallWrapper: {
    flex: 1,
    width: '100%',
  },
  fourGridContainer: {
    width: 250,
    height: 250,
    gap: 3,
  },
  fourGridRow: {
    flex: 1,
    flexDirection: 'row',
    gap: 3,
  },
  quarterWrapper: {
    flex: 1,
    height: '100%',
    position: 'relative',
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  moreOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
  },
});

export const MediaGridBubble = React.memo(MediaGridBubbleComponent);
