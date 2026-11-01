import {Buffer} from 'buffer';

export type SignalFrame = Record<string, unknown>;

/** Incremental UTF-8, newline-delimited frame decoder for the raw TLS signaling stream. */
export class JsonLineFrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly maxFrameBytes = 65_536,
    private readonly maxBufferedBytes = 1_048_576,
  ) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 256) throw new Error('Invalid frame limit');
    if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < maxFrameBytes) throw new Error('Invalid buffer limit');
  }

  push(chunk: Uint8Array | string): SignalFrame[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    if (this.buffer.length + incoming.length > this.maxBufferedBytes) {
      throw new Error('Signaling batch exceeds the receive buffer limit');
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, incoming]) : incoming;

    const frames: SignalFrame[] = [];
    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      if (newline > this.maxFrameBytes) throw new Error('Signaling frame exceeds the configured limit');
      const line = Buffer.from(this.buffer.subarray(0, newline)).toString('utf8').trim();
      this.buffer = Buffer.from(this.buffer.subarray(newline + 1));
      if (line) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new Error('Malformed JSON signaling frame');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Signaling frame must be a JSON object');
        }
        frames.push(value as SignalFrame);
      }
      newline = this.buffer.indexOf(0x0a);
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw new Error('Unterminated signaling frame exceeds the configured limit');
    }
    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
