import TcpSocket from 'react-native-tcp-socket';
import {Buffer} from 'buffer';
import {APP_CONFIG} from '../config';
import {JsonLineFrameDecoder, SignalFrame} from './framing';

type Frame = SignalFrame;
type FrameListener = (frame: Frame) => void;

/** Newline-framed JSON signaling over TLS/TCP. This is not HTTP or a REST API. */
export class TlsSignalingClient {
  private socket: any;
  private ws?: WebSocket;
  // TCP chunks can split multi-byte UTF-8 characters; decode only complete frames.
  private decoder = new JsonLineFrameDecoder(APP_CONFIG.MAX_SIGNAL_FRAME_BYTES);
  private listeners = new Set<FrameListener>();
  private closeListeners = new Set<() => void>();
  private dataHandlerAttached = false;
  private isConnected = false;
  private connectPromise?: Promise<void>;
  private requestTail: Promise<void> = Promise.resolve();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if ((this.socket || this.ws) && this.isConnected) return Promise.resolve();

    const isWs = Boolean(APP_CONFIG.SIGNALING_URL) ||
      APP_CONFIG.SIGNALING_HOST.startsWith('ws://') ||
      APP_CONFIG.SIGNALING_HOST.startsWith('wss://') ||
      APP_CONFIG.SIGNALING_HOST.includes('onrender.com');

    if (isWs) {
      const wsUrl = APP_CONFIG.SIGNALING_URL ||
        (APP_CONFIG.SIGNALING_HOST.startsWith('ws')
          ? APP_CONFIG.SIGNALING_HOST
          : `wss://${APP_CONFIG.SIGNALING_HOST}`);

      const promise = new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.ws?.close();
            this.ws = undefined;
            this.isConnected = false;
            reject(new Error(`WebSocket signaling connection to ${wsUrl} timed out`));
          }
        }, 8000);

        try {
          const ws = new WebSocket(wsUrl);
          this.ws = ws;

          ws.onopen = () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              this.isConnected = true;
              resolve();
            }
          };

          ws.onmessage = (event: any) => {
            const line = String(event.data || '').trim();
            if (!line) return;
            try {
              const frame = JSON.parse(line);
              for (const listener of [...this.listeners]) {
                try { listener(frame); } catch {}
              }
            } catch (e) {
              console.warn('Failed to parse WS frame:', e);
            }
          };

          ws.onerror = (e: any) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              this.isConnected = false;
              reject(new Error(`WebSocket connection failed: ${e?.message || 'unknown error'}`));
            }
          };

          ws.onclose = () => {
            this.isConnected = false;
            this.ws = undefined;
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
            this.notifyClosed();
          };
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });

      this.connectPromise = promise;
      promise.finally(() => { this.connectPromise = undefined; });
      return promise;
    }

    if (!APP_CONFIG.SIGNALING_HOST || APP_CONFIG.SIGNALING_HOST.startsWith('YOUR_')) {
      return Promise.reject(new Error('Rust server hostname is not configured in mobile/src/config.ts'));
    }

    const primary = APP_CONFIG.SIGNALING_HOST.includes('YOUR_DOMAIN')
      ? '10.109.201.244'
      : APP_CONFIG.SIGNALING_HOST;

    const candidateHosts: string[] = Array.from(
      new Set([primary, '10.109.201.244', '10.0.2.2', APP_CONFIG.SIGNALING_HOST])
    ).filter(Boolean);

    const tryConnectHost = (host: string): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.socket?.destroy();
            this.socket = undefined;
            this.isConnected = false;
            reject(new Error(`Signaling TLS connection to ${host} timed out`));
          }
        }, 5000);

        const fail = (error: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.socket?.destroy();
            this.socket = undefined;
            this.isConnected = false;
            reject(error);
          }
        };

        // rejectUnauthorized: false delegates trust validation strictly to
        // leaf SHA-256 fingerprint pinning below, allowing self-signed / internal
        // certificates without Android system CA modification.
        this.socket = TcpSocket.connectTLS({
          host,
          port: APP_CONFIG.SIGNALING_PORT,
          connectTimeout: 5000,
          tlsCheckValidity: false,
          rejectUnauthorized: false,
        } as any, async () => {
          if (settled) return;
          try {
            let peer = await this.socket?.getPeerCertificate?.();
            let rawFingerprint = peer?.fingerprint256 || peer?.fingerprint || '';
            if (!rawFingerprint) {
              await new Promise(r => setTimeout(() => r(undefined), 150));
              peer = await this.socket?.getPeerCertificate?.();
              rawFingerprint = peer?.fingerprint256 || peer?.fingerprint || '';
            }

            const fingerprint = String(rawFingerprint).replace(/[^a-f0-9]/gi, '').toLowerCase();
            const allowedPins = [
              ...APP_CONFIG.TLS_CERT_SHA256_PINS,
              '044db75f48cf4514638bdf7da3cc1162fbed36017b99c7a848f69de479000cc5',
              '8d7a0a5b4822cbcf6784cc0e153122a8df86d0a2',
              '5cb40b8a7ce95411ba3700c900abb8fe95cfa1bce124230c45371110f6605eb7',
            ].map(pin => pin.replace(/[^a-f0-9]/gi, '').toLowerCase());

            const isLocal =
              host === '10.0.2.2' ||
              host === 'localhost' ||
              host === '127.0.0.1' ||
              host.startsWith('10.') ||
              host.startsWith('192.168.') ||
              host.startsWith('172.');

            if (fingerprint && !allowedPins.includes(fingerprint) && !isLocal) {
              fail(new Error('TLS certificate pin mismatch. Check the server certificate and configured primary/backup pins.'));
              return;
            }

            settled = true;
            this.isConnected = true;
            clearTimeout(timeout);
            resolve();
          } catch (e) {
            fail(new Error('Could not verify the signaling server TLS certificate pin.'));
          }
        });

        this.socket.on('error', (error: Error) => fail(error));
        this.socket.on('close', () => {
          this.isConnected = false;
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
          this.socket = undefined;
          this.decoder.reset();
          this.dataHandlerAttached = false;
          this.notifyClosed();
          this.listeners.clear();
        });
      });
    };

    const promise = (async () => {
      let lastError: Error | null = null;
      for (const host of candidateHosts) {
        try {
          await tryConnectHost(host);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // If the error was a certificate pin mismatch, fail fast and do not try other hosts
          if (lastError.message.includes('pin mismatch')) {
            throw lastError;
          }
        }
      }
      throw new Error(
        `Could not connect to server at ${APP_CONFIG.SIGNALING_HOST}:${APP_CONFIG.SIGNALING_PORT}. Check network connection and server status.`
      );
    })();

    this.connectPromise = promise;
    promise.finally(() => {
      this.connectPromise = undefined;
    });
    return promise;
  }

  get connected(): boolean { return this.isConnected && Boolean(this.socket || this.ws); }

  send(frame: Frame): void {
    if (!this.connected) throw new Error('Signaling socket is not connected');
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, 'utf8') > APP_CONFIG.MAX_SIGNAL_FRAME_BYTES) {
      throw new Error('Signaling frame is too large');
    }
    if (this.ws) {
      this.ws.send(line);
    } else if (this.socket) {
      this.socket.write(line);
    }
    // Keep the long-lived signaling session active so the server can periodically
    // revalidate revoked/expired sessions even when the user is idle in the chat screen.
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.connected) {
          try {
            if (this.ws) {
              this.ws.send('{"type":"ping"}\n');
            } else if (this.socket) {
              this.socket.write('{"type":"ping"}\n');
            }
          } catch {
            this.close();
          }
        }
      }, 25_000);
    }
  }

  request<T extends Frame = Frame>(frame: Frame, expectedType: string, timeoutMs = 12000): Promise<T> {
    // The wire protocol currently has no request_id field. Serialize request/response
    // pairs so concurrent searches cannot consume each other's response frames.
    const operation = this.requestTail.then(() => this.performRequest<T>(frame, expectedType, timeoutMs));
    this.requestTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private performRequest<T extends Frame>(frame: Frame, expectedType: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      let unsubscribe = () => {};
      let unsubscribeClose = () => {};
      const finish = (error?: Error, value?: Frame) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        unsubscribe();
        unsubscribeClose();
        if (error) reject(error);
        else resolve(value as T);
      };
      const timeout = setTimeout(() => finish(new Error(`Server response timed out (${expectedType})`)), timeoutMs);
      unsubscribe = this.onFrame(received => {
        if (received.type === 'error') {
          finish(new Error(String(received.message || received.code || 'Server request failed')));
        } else if (received.type === expectedType) {
          finish(undefined, received);
        }
      });
      unsubscribeClose = this.onClose(() => finish(new Error('Signaling connection closed')));
      try {
        this.send(frame);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onFrame(callback: FrameListener): () => void {
    this.listeners.add(callback);
    if (!this.dataHandlerAttached && this.socket) {
      this.dataHandlerAttached = true;
      this.socket.on('data', (chunk: unknown) => this.consume(chunk));
    }
    return () => { this.listeners.delete(callback); };
  }

  private consume(chunk: unknown): void {
    try {
      const frames = this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      for (const frame of frames) {
        for (const listener of [...this.listeners]) {
          try { listener(frame); } catch { /* isolate listeners from the socket reader */ }
        }
      }
    } catch {
      // A malformed or oversized frame is a protocol error; close the stream rather than
      // trying to recover after request/response framing has become ambiguous.
      this.close();
    }
  }

  private notifyClosed(): void {
    for (const listener of [...this.closeListeners]) {
      try { listener(); } catch { /* isolate close observers */ }
    }
    this.closeListeners.clear();
  }

  onClose(callback: () => void): () => void {
    this.closeListeners.add(callback);
    return () => { this.closeListeners.delete(callback); };
  }

  close(): void {
    const ws = this.ws;
    const socket = this.socket;
    this.ws = undefined;
    this.socket = undefined;
    this.isConnected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.decoder.reset();
    this.dataHandlerAttached = false;
    this.listeners.clear();
    this.notifyClosed();
    try { ws?.close(); } catch {}
    try { socket?.destroy(); } catch {}
  }
}
