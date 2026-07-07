import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDeno, managedDenoPath, denoDownloadUrl } from "../lib/diagnostics/deno-installer.js";

function response(opts: { ok?: boolean; status?: number; contentLength?: string; bytes?: Buffer }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? opts.contentLength ?? null : null) },
    arrayBuffer: async () => (opts.bytes ?? Buffer.alloc(0)).buffer,
  } as unknown as Response;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vidlens-deno-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("ensureDeno", () => {
  it("returns the existing managed binary without fetching", async () => {
    const existing = managedDenoPath(dataDir, "darwin");
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, "binary");
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return response({});
    }) as unknown as typeof fetch;

    const path = await ensureDeno(dataDir, "darwin", "arm64", fetchImpl);
    assert.equal(path, existing);
    assert.equal(fetched, false);
  });

  it("fails closed when the download exceeds the size cap", async () => {
    const fetchImpl = (async () =>
      response({ contentLength: String(500 * 1024 * 1024) })) as unknown as typeof fetch;
    await assert.rejects(() => ensureDeno(dataDir, "darwin", "arm64", fetchImpl), /too large/i);
  });

  it("rejects an empty archive body", async () => {
    const fetchImpl = (async () =>
      response({ bytes: Buffer.alloc(0) })) as unknown as typeof fetch;
    await assert.rejects(() => ensureDeno(dataDir, "darwin", "arm64", fetchImpl), /empty response/i);
  });

  it("rejects a failed HTTP status", async () => {
    const fetchImpl = (async () =>
      response({ ok: false, status: 404 })) as unknown as typeof fetch;
    await assert.rejects(() => ensureDeno(dataDir, "darwin", "arm64", fetchImpl), /HTTP 404/);
  });
});

describe("denoDownloadUrl", () => {
  it("maps darwin arm64 to the aarch64 apple-darwin asset", () => {
    assert.match(denoDownloadUrl("darwin", "arm64"), /deno-aarch64-apple-darwin\.zip$/);
  });

  it("maps linux x64 to the x86_64 gnu asset", () => {
    assert.match(denoDownloadUrl("linux", "x64"), /deno-x86_64-unknown-linux-gnu\.zip$/);
  });
});
