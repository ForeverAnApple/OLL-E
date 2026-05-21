// Tiny helper to build a ReadableStream from an array of stream parts
// for MockLanguageModelV3 in adapter tests. Kept untyped at the part
// level so adapter tests can emit whatever shape they need (text deltas,
// tool calls, finish events) without re-declaring the V3 union locally.

export function streamOf<T>(parts: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}
