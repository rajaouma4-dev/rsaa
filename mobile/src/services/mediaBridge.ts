import {
  NativeModules,
  NativeEventEmitter,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import {MediaImageItem, VoiceNoteItem} from '../types';

const {NexaMediaModule} = NativeModules;
const mediaEventEmitter = NexaMediaModule ? new NativeEventEmitter(NexaMediaModule) : null;

export async function requestAudioPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: 'Microphone Permission',
        message: 'Nexa needs access to your microphone to record voice messages.',
        buttonPositive: 'OK',
      },
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export async function requestStoragePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    if (Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request(
        (PermissionsAndroid.PERMISSIONS as any).READ_MEDIA_IMAGES,
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } else {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      );
      return (
        granted === PermissionsAndroid.RESULTS.GRANTED ||
        granted === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
      );
    }
  } catch {
    return true;
  }
}

export async function pickPhotosFromGallery(): Promise<string[]> {
  if (!NexaMediaModule?.pickImages) return [];
  try {
    const uris: string[] = await NexaMediaModule.pickImages();
    return uris || [];
  } catch (err) {
    console.warn('Failed to pick photos:', err);
    return [];
  }
}

export async function processImageAttachment(
  uri: string,
  isHd: boolean,
): Promise<MediaImageItem | null> {
  if (!NexaMediaModule?.processImage) return null;
  try {
    const res = await NexaMediaModule.processImage(uri, isHd);
    return {
      id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      thumb: res.thumb,
      fullBase64: res.fullBase64,
      width: res.width,
      height: res.height,
    };
  } catch (err) {
    console.warn('Failed to process image attachment:', err);
    return null;
  }
}

export async function startRecordingVoice(): Promise<string | null> {
  if (!NexaMediaModule?.startRecording) return null;
  const hasPerm = await requestAudioPermission();
  if (!hasPerm) return null;
  try {
    const path: string = await NexaMediaModule.startRecording();
    return path;
  } catch (err) {
    console.warn('Failed to start voice recording:', err);
    return null;
  }
}

export async function stopRecordingVoice(): Promise<VoiceNoteItem | null> {
  if (!NexaMediaModule?.stopRecording) return null;
  try {
    const res = await NexaMediaModule.stopRecording();
    return {
      audioBase64: res.audioBase64,
      durationSec: res.durationSec || 1,
    };
  } catch (err) {
    console.warn('Failed to stop voice recording:', err);
    return null;
  }
}

export async function cancelRecordingVoice(): Promise<void> {
  if (!NexaMediaModule?.cancelRecording) return;
  try {
    await NexaMediaModule.cancelRecording();
  } catch {}
}

export async function playVoiceNote(
  audioSource: string,
  onFinished?: () => void,
): Promise<void> {
  if (!NexaMediaModule?.playVoice) return;
  try {
    let sub: any = null;
    if (mediaEventEmitter && onFinished) {
      sub = mediaEventEmitter.addListener('onVoicePlaybackEnd', () => {
        sub?.remove();
        onFinished();
      });
    }
    await NexaMediaModule.playVoice(audioSource);
  } catch (err) {
    console.warn('Failed to play voice note:', err);
    onFinished?.();
  }
}

export async function stopVoiceNote(): Promise<void> {
  if (!NexaMediaModule?.stopVoice) return;
  try {
    await NexaMediaModule.stopVoice();
  } catch {}
}

export async function saveBatchToPhoneGallery(
  base64Images: string[],
): Promise<number> {
  if (!NexaMediaModule?.saveImagesToGallery) return 0;
  await requestStoragePermission();
  try {
    const count: number = await NexaMediaModule.saveImagesToGallery(base64Images);
    return count;
  } catch (err) {
    console.warn('Failed to save images to gallery:', err);
    return 0;
  }
}
