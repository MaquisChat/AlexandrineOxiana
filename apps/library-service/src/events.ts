/**
 * Server-sent events (`GET /events`): `library.state`, `job.progress`, `import.progress`,
 * `capture.progress`, `watch.status` (Task W7), `zotero.sync` (Task Z8). Subscribers are removed when their client disconnects.
 */
export type EventType = "library.state" | "job.progress" | "import.progress" | "capture.progress" | "watch.status" | "zotero.sync";

export interface ServiceEvent {
  type: EventType;
  data: Record<string, unknown>;
}

export class EventBus {
  private readonly subs = new Set<(e: ServiceEvent) => void>();

  /** Adds a subscriber; returns the function that removes it. */
  subscribe(fn: (e: ServiceEvent) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  publish(type: EventType, data: Record<string, unknown>): void {
    for (const fn of [...this.subs]) {
      try {
        fn({ type, data });
      } catch {
        // one subscriber's failure never stops the others
      }
    }
  }

  /** Subscribers now (tests: cleanup on disconnect). */
  get size(): number {
    return this.subs.size;
  }

  clear(): void {
    this.subs.clear();
  }
}

/** One SSE frame. */
export function sseFrame(e: ServiceEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
