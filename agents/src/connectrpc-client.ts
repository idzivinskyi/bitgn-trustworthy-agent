// ── Connect-RPC transport factory ────────────────────────
//
// Creates typed Connect-RPC clients using the generated buf.build SDK.
// Uses the Connect protocol (JSON over HTTP) with Node's built-in fetch.

import { createClient, type Client } from "@connectrpc/connect";
import { createTransport } from "@connectrpc/connect/protocol-connect";
import type { GenService } from "@bufbuild/protobuf/codegenv2";

export { ConnectError } from "@connectrpc/connect";

// Node's fetch requires `duplex: "half"` for requests with streaming bodies.
// The built-in createFetchClient doesn't set this, so we provide our own.
async function nodeFetchClient(req: { url: string; method: string; header: Headers; body?: AsyncIterable<Uint8Array>; signal?: AbortSignal }) {
  const body = req.body === undefined ? null : readableStreamFrom(req.body);
  // Prevent Node's fetch from requesting gzip — the Connect transport
  // doesn't register decompression and would reject the response.
  req.header.set("Accept-Encoding", "identity");
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.header,
    body,
    signal: req.signal,
    duplex: "half",
  } as RequestInit);
  return {
    status: res.status,
    header: res.headers,
    body: res.body as unknown as AsyncIterable<Uint8Array>,
    trailer: new Headers(),
  };
}

function readableStreamFrom(iter: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      for await (const chunk of iter) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

export function createConnectClient<T extends GenService<any>>(
  service: T,
  baseUrl: string,
): Client<T> {
  const transport = createTransport({
    baseUrl: baseUrl.replace(/\/+$/, ""),
    httpClient: nodeFetchClient,
    useBinaryFormat: false,
    interceptors: [],
    acceptCompression: [],
    sendCompression: null,
    compressMinBytes: Number.MAX_SAFE_INTEGER,
    readMaxBytes: 0xffffffff,
    writeMaxBytes: 0xffffffff,
  });
  return createClient(service, transport);
}
