// Transport-neutral request/response types, so the same app runs in Lambda and in the local adapter.

export type HttpRequest = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>; // lower-case names
  body: string;
};

export interface ResponseSink {
  /** Sends the status line and headers. Must be called once, before write. */
  start(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export function sendJson(res: ResponseSink, status: number, body: unknown): void {
  res.start(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.write(JSON.stringify(body));
  res.end();
}

export function sendError(res: ResponseSink, status: number, code: string, message: string, retryable = false): void {
  sendJson(res, status, { error: { code, message, retryable } });
}

/** Writes Server-Sent Events. `event:` equals the payload's `type` (api/README.md §3). */
export class SseWriter {
  private ping: NodeJS.Timeout | undefined;
  private started = false;

  constructor(private readonly res: ResponseSink) {}

  get isStarted(): boolean {
    return this.started;
  }

  send<E extends { type: string }>(event: E): void {
    if (!this.started) {
      this.res.start(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
      this.started = true;
      // Keeps mobile networks from dropping a quiet stream during long tool calls (chat-service.md §6).
      this.ping = setInterval(() => this.res.write(": ping\n\n"), 15_000);
    }
    this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  close(): void {
    if (this.ping) clearInterval(this.ping);
    this.res.end();
  }
}
