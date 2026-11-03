/** Bounded, fair scheduling of already encrypted envelopes. */
export interface WritableDataChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: string): void;
}
interface Job {
  body: string; index: number; total: number; id: string;
  resolve(): void; reject(error: Error): void;
}
const CHUNK = 12 * 1024;
let sequence = 0;
export class DataChannelWriter {
  private urgent: Job[] = [];
  private media: Job[] = [];
  private running = false;
  private stopped = false;
  private queuedBytes = 0;
  constructor(private channel: WritableDataChannel) {}
  send(body: string): Promise<void> {
    if (this.stopped || this.channel.readyState !== 'open') return Promise.reject(new Error('DataChannel closed'));
    if (this.queuedBytes + body.length > 24 * 1024 * 1024) return Promise.reject(new Error('DataChannel queue full; retry later'));
    this.queuedBytes += body.length;
    const result = new Promise<void>((resolve, reject) => {
      const job: Job = {body, index: 0, total: Math.ceil(body.length / CHUNK), id: `cli_${Date.now()}_${++sequence}`, resolve, reject};
      (job.total <= 1 ? this.urgent : this.media).push(job);
    });
    void this.drain();
    return result;
  }
  close(): void {
    this.stopped = true;
    this.fail(new Error('DataChannel closed'));
  }
  private fail(error: Error): void {
    for (const job of [...this.urgent, ...this.media]) job.reject(error);
    this.urgent = []; this.media = []; this.queuedBytes = 0;
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let batch = 0;
    let blockedAt = 0;
    try {
      while (this.urgent.length || this.media.length) {
        if (this.stopped || this.channel.readyState !== 'open') throw new Error('DataChannel closed');
        if (this.channel.bufferedAmount > 96 * 1024) {
          blockedAt ||= Date.now();
          if (Date.now() - blockedAt > 30000) throw new Error('DataChannel stalled; retry later');
          await new Promise<void>(resolve => setTimeout(resolve, 4));
          continue;
        }
        blockedAt = 0;
        const job = this.urgent.shift() || this.media.shift()!;
        try {
          const packet = job.total <= 1 ? job.body : JSON.stringify({
            type: 'chunk', transfer_id: job.id, index: job.index, total: job.total,
            data: job.body.slice(job.index * CHUNK, (job.index + 1) * CHUNK),
          });
          this.channel.send(packet);
          job.index++;
          if (job.index >= job.total) { this.queuedBytes -= job.body.length; job.resolve(); }
          else this.media.push(job);
        } catch (error) {
          this.queuedBytes -= job.body.length;
          job.reject(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        // Give native bufferedAmount updates and newly queued text a turn.
        if (++batch >= 4) {
          batch = 0;
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    finally { this.running = false; }
  }
}
