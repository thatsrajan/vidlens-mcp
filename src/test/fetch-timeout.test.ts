import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fetchWithTimeout } from "../lib/fetch-timeout.js";

async function listen(server: Server): Promise<number> {
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return address.port;
}

describe("fetchWithTimeout", () => {
  it("resolves normally when the server responds in time", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    const port = await listen(server);
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 1000);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok");
    } finally {
      server.close();
    }
  });

  it("aborts a stalled request once the timeout elapses", async () => {
    // Never sends a response body — the socket just hangs open.
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((_req, _res) => {
      /* intentionally never respond */
    });
    server.on("connection", (s) => sockets.add(s));
    const port = await listen(server);
    try {
      await assert.rejects(
        () => fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 50),
        (err: Error) => err.name === "TimeoutError" || err.name === "AbortError",
      );
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });

  it("still aborts when the caller passes its own signal", async () => {
    const controller = new AbortController();
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer(() => {
      /* never respond */
    });
    server.on("connection", (s) => sockets.add(s));
    const port = await listen(server);
    try {
      const pending = fetchWithTimeout(
        `http://127.0.0.1:${port}/`,
        { signal: controller.signal },
        5000,
      );
      controller.abort();
      await assert.rejects(() => pending, (err: Error) => err.name === "AbortError");
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});
