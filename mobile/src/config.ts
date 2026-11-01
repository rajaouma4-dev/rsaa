export const APP_CONFIG = {
  // Live mode is strictly enforced and fail-closed. Unauthenticated demo bypass is disabled.
  DEMO_MODE: false,
  // Production signaling host: public domain only, no hardcoded localhost or private LAN IP.
  SIGNALING_HOST: 'rsaa.onrender.com',
  // Candidate hosts for fallback during local development/testing
  CANDIDATE_HOSTS: ['rsaa.onrender.com', '10.0.2.2', '10.109.201.13'],
  SIGNALING_PORT: 443,
  // Pin the SHA-256 fingerprint of the leaf TLS certificate. Add backup pins before rotation.
  TLS_CERT_SHA256_PINS: [
    '044db75f48cf4514638bdf7da3cc1162fbed36017b99c7a848f69de479000cc5',
    '8d7a0a5b4822cbcf6784cc0e153122a8df86d0a2',
    '5cb40b8a7ce95411ba3700c900abb8fe95cfa1bce124230c45371110f6605eb7',
  ],
  MAX_SIGNAL_FRAME_BYTES: 65_536,
  // Google Global STUN pool + OpenRelay TURN for full NAT & firewall penetration
  ICE_SERVERS: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun.l.google.com:19305',
        'stun:stun1.l.google.com:19302',
        'stun:stun1.l.google.com:19305',
        'stun:stun2.l.google.com:19302',
        'stun:stun2.l.google.com:19305',
        'stun:stun3.l.google.com:19302',
        'stun:stun3.l.google.com:19305',
        'stun:stun4.l.google.com:19302',
        'stun:stun4.l.google.com:19305',
      ],
    },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  ICE_TRANSPORT_POLICY: 'all' as const,
  APP_NAME: 'Nexa Chat',
  // WebSocket signaling URL for Render / Cloud (e.g. wss://your-service.onrender.com)
  SIGNALING_URL: 'wss://rsaa.onrender.com',
};

export function updateSignalingHost(host: string) {
  const trimmed = host.trim();
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://') || trimmed.includes('onrender.com')) {
    const url = trimmed.startsWith('ws')
      ? trimmed
      : `wss://${trimmed.replace(/^https?:\/\//i, '').replace(/\/$/, '')}`;
    APP_CONFIG.SIGNALING_URL = url;
    APP_CONFIG.SIGNALING_HOST = url.replace(/^wss?:\/\//i, '').replace(/:\d+$/, '').replace(/\/.*$/, '');
    return;
  }
  const cleaned = trimmed.replace(/^https?:\/\//i, '').replace(/:\d+$/, '');
  if (cleaned) {
    APP_CONFIG.SIGNALING_HOST = cleaned;
    if (!APP_CONFIG.CANDIDATE_HOSTS.includes(cleaned)) {
      APP_CONFIG.CANDIDATE_HOSTS = [cleaned, ...APP_CONFIG.CANDIDATE_HOSTS];
    }
  }
}

export function isLiveConfigReady(): boolean {
  return !APP_CONFIG.DEMO_MODE &&
    (Boolean(APP_CONFIG.SIGNALING_URL) || (Boolean(APP_CONFIG.SIGNALING_HOST) && APP_CONFIG.SIGNALING_PORT > 0)) &&
    APP_CONFIG.ICE_SERVERS.length > 0;
}
