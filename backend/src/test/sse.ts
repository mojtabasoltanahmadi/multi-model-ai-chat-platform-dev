/**
 * Builds fake `fetch` Response objects for provider-adapter specs. The
 * adapters read only `.ok`, `.status`, `.body` (a ReadableStream of SSE
 * bytes) and `.text()` (error bodies) — a hand-rolled object covers exactly
 * that surface without depending on undici internals.
 */

/** Encodes strings into a byte stream, one enqueue per chunk. */
export function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    },
  });
}

/** A 200 Response streaming the given raw SSE chunks. */
export function sseResponse(chunks: string[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: streamFromChunks(chunks),
    text: async () => chunks.join(''),
  } as unknown as Response;
}

/** An error Response (no body stream — adapters read `.text()` for detail). */
export function errorResponse(status: number, body = ''): Response {
  return {
    ok: false,
    status,
    body: null,
    text: async () => body,
  } as unknown as Response;
}

/** A fetch rejection shaped like a DOMException abort. */
export function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
