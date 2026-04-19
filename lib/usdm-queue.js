// ──────────────────────────────────────────────────────────────────────
// Simple in-memory FIFO queue with concurrency cap.
// Used to protect Gemini's free-tier 15 RPM rate limit and prevent
// the server from OOM-ing under concurrent large-PDF uploads.
//
// Each Job has:
//   - run()            — async function that does the real work
//   - onQueueUpdate(p,t) — called when position/total changes while queued
//   - onStart()          — called right before run()
//   - cancelled (bool)   — set by the caller (e.g., on client disconnect)
//
// run() is never invoked if cancelled === true.
// Failures bubble up via promise rejection from enqueue().
// ──────────────────────────────────────────────────────────────────────

class ExtractionQueue {
  constructor(concurrency = 1) {
    this.concurrency = Math.max(1, concurrency);
    this.running = new Set();   // active Jobs
    this.queue = [];            // pending Jobs in FIFO order
    this._counter = 0;
  }

  /**
   * Enqueue a job. Returns a Promise that resolves with run()'s return value,
   * or rejects with its error (or a cancellation Error).
   */
  enqueue(job) {
    if (!job || typeof job.run !== 'function') {
      return Promise.reject(new Error('Job must have a run() function'));
    }
    job._id = ++this._counter;
    job._queuedAt = Date.now();
    return new Promise((resolve, reject) => {
      job._resolve = resolve;
      job._reject  = reject;
      this.queue.push(job);
      this._notifyQueuePositions();
      this._process();
    });
  }

  /** Remove a queued (not yet running) job — e.g., client disconnected. */
  cancel(job) {
    const idx = this.queue.indexOf(job);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      job._reject?.(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      this._notifyQueuePositions();
      return true;
    }
    // Can't stop a running job cleanly without cooperative cancellation.
    // Mark it so the job can bail at its next checkpoint.
    job.cancelled = true;
    return false;
  }

  status() {
    return {
      concurrency: this.concurrency,
      running:     this.running.size,
      queued:      this.queue.length
    };
  }

  _notifyQueuePositions() {
    const total = this.queue.length + this.running.size;
    this.queue.forEach((j, i) => {
      const pos = i + 1;
      if (j._lastPosition !== pos) {
        j._lastPosition = pos;
        try { j.onQueueUpdate?.(pos, total); } catch {}
      }
    });
  }

  _process() {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job.cancelled) continue;
      this.running.add(job);
      this._notifyQueuePositions();
      this._execute(job).finally(() => {
        this.running.delete(job);
        this._notifyQueuePositions();
        this._process();
      });
    }
  }

  async _execute(job) {
    try {
      await job.onStart?.();
      const result = await job.run();
      job._resolve?.(result);
    } catch (err) {
      job._reject?.(err);
    }
  }
}

module.exports = { ExtractionQueue };
