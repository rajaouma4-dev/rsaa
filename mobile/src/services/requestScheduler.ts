type Task<T = unknown> = {run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; priority: number; key?: string};

/** Keep uncorrelated protocol responses serial, without queueing search behind photos. */
export class RequestScheduler {
  private pending: Task<any>[] = [];
  private busy = false;
  schedule<T>(run: () => Promise<T>, priority: number, key?: string): Promise<T> {
    if (key) {
      const obsolete = this.pending.filter(task => task.key === key);
      this.pending = this.pending.filter(task => task.key !== key);
      obsolete.forEach(task => task.reject(new Error('Request superseded')));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({run, resolve, reject, priority, key});
      void this.drain();
    });
  }
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.length) {
        // Stable sort preserves FIFO within the same priority.
        this.pending.sort((a, b) => a.priority - b.priority);
        const task = this.pending.shift()!;
        try { task.resolve(await task.run()); }
        catch (error) { task.reject(error); }
      }
    } finally { this.busy = false; }
  }
}
