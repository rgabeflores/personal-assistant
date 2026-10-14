import { describe, expect, it } from "vitest";
import { readSse } from "./sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("readSse", () => {
  it("handles events split across chunks and skips pings", async () => {
    const out = [];
    for await (const m of readSse(streamOf(['event: turn.started\ndata: {"a"', ':1}\n\n: ping\n\nevent: text.delta\n', 'data: {"text":"hi"}\n\n']))) out.push(m);
    expect(out).toEqual([
      { event: "turn.started", data: '{"a":1}' },
      { event: "text.delta", data: '{"text":"hi"}' },
    ]);
  });
});
