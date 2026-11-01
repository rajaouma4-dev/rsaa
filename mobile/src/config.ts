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
  // Google Global STUN pool (Primary - zero bandwidth cost & ultra-low latency)
  // + Metered Dedicated Authenticated TURN pool (Secondary fallback for strict symmetric CGNAT)
  ICE_SERVERS: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
      ],
    },
    {
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ],
      username: '6b4f1ed4dfec6aa058c544b1',
      credential: '02Mhum2YDd/IcEhx',
    },
  ],
  ICE_TRANSPORT_POLICY: 'all' as const,
  APP_NAME: 'Nexa Chat',
  // WebSocket signaling URL for Render / Cloud (e.g. wss://your-service.onrender.com)
  SIGNALING_URL: 'wss://rsaa.onrender.com',
};

export async function refreshTurnCredentials(): Promise<void> {
  try {
    const res = await fetch('https://rsaa.metered.live/api/v1/turn/credentials?apiKey=3db65ca898a902693c4bacecd8dc40041fc1', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        // ALWAYS keep Google STUN at top priority for 0-cost direct connectivity
        APP_CONFIG.ICE_SERVERS = [
          {
            urls: [
              'stun:stun.l.google.com:19302',
              'stun:stun1.l.google.com:19302',
              'stun:stun2.l.google.com:19302',
              'stun:stun3.l.google.com:19302',
            ],
          },
          ...data,
        ];
      }
    }
  } catch {
    // Keep solid default static Metered credentials
  }
}

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
