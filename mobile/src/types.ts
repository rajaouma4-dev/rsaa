export type User = {
  id: string;
  username: string;
  name: string;
  online: boolean;
  about?: string;
  lastActive?: number;
};

export interface MediaImageItem {
  id: string;
  thumb: string; // Compact data:image/jpeg;base64,... (~2-4KB) for ultra-fast rendering & small DB
  fullBase64?: string; // High quality base64 image data for fullscreen & download
  width: number;
  height: number;
}

export interface VoiceNoteItem {
  audioBase64: string;
  durationSec: number;
}

export type CallDetails = {
  callId: string;
  callType: 'audio' | 'video';
  durationSec: number;
  durationFormatted: string; // e.g. "2m 14s", "1h 5m 20s"
  status: 'completed' | 'missed' | 'declined' | 'cancelled';
  isCaller: boolean;
};

export type ChatMessage = {
  id: string;
  from: 'me' | 'them';
  text: string;
  time: string;
  timestamp?: number;
  status: 'sent' | 'saved' | 'delivered' | 'seen';
  mediaType?: 'text' | 'image' | 'voice' | 'call';
  images?: MediaImageItem[];
  isHd?: boolean;
  voice?: VoiceNoteItem;
  callDetails?: CallDetails;
};

export type Chat = {
  id: string;
  user: User;
  preview: string;
  time: string;
  timestamp?: number;
  unread: number;
  messages: ChatMessage[];
};
