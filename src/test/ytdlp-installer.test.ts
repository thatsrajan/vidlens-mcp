import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  downloadYtDlp,
  fetchExpectedChecksum,
  managedBinaryPath,
} from "../lib/ytdlp-installer.js";

const BINARY_BYTES = Buffer.from("#!/bin/sh\necho fake yt-dlp\n");
const BINARY_SHA = createHash("sha256").update(BINARY_BYTES).digest("hex");

function textResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}

function binaryResponse(bytes: Buffer): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

/** Builds a fake fetch serving the checksum manifest and the binary asset. */
function fakeFetch(opts: {
  manifestFor?: string; // asset name to list in SHA2-256SUMS
  manifestHash?: string;
  binary?: Buffer;
}): typeof fetch {
  return (async (input: string | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("SHA2-256SUMS")) {
      if (!opts.manifestFor) {
        return textResponse("");
      }
      return textResponse(`${opts.manifestHash ?? BINARY_SHA}  ${opts.manifestFor}\n`);
    }
    return binaryResponse(opts.binary ?? BINARY_BYTES);
  }) as unknown as typeof fetch;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vidlens-ytdlp-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("fetchExpectedChecksum", () => {
  it("returns the digest for the matching asset", async () => {
    const fetchImpl = fakeFetch({ manifestFor: "yt-dlp_macos", manifestHash: "a".repeat(64) });
    const hash = await fetchExpectedChecksum("yt-dlp_macos", fetchImpl);
    assert.equal(hash, "a".repeat(64));
  });

  it("returns undefined when the asset is not listed", async () => {
    const fetchImpl = fakeFetch({ manifestFor: "yt-dlp_linux", manifestHash: "b".repeat(64) });
    const hash = await fetchExpectedChecksum("yt-dlp_macos", fetchImpl);
    assert.equal(hash, undefined);
  });

  it("returns undefined when the manifest fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const hash = await fetchExpectedChecksum("yt-dlp_macos", fetchImpl);
    assert.equal(hash, undefined);
  });
});

describe("downloadYtDlp atomic install (WS5-3)", () => {
  it("writes the binary atomically when the checksum matches", async () => {
    const fetchImpl = fakeFetch({ manifestFor: "yt-dlp_macos" });
    const path = await downloadYtDlp(dataDir, "darwin", "arm64", fetchImpl);

    assert.equal(path, managedBinaryPath(dataDir, "darwin"));
    assert.ok(existsSync(path));
    assert.deepEqual(readFileSync(path), BINARY_BYTES);
    // POSIX: installed executable.
    assert.equal(statSync(path).mode & 0o111, 0o111);
    // No leftover temp download files.
    assert.ok(!readdirSync(join(dataDir, "bin")).some((f) => f.endsWith(".download")));
  });

  it("rejects and leaves nothing behind on a checksum mismatch (truncated download)", async () => {
    const truncated = BINARY_BYTES.subarray(0, 5);
    // Manifest advertises the full-file hash; the served bytes are truncated.
    const fetchImpl = fakeFetch({ manifestFor: "yt-dlp_macos", binary: truncated });

    await assert.rejects(
      () => downloadYtDlp(dataDir, "darwin", "arm64", fetchImpl),
      /checksum mismatch/i,
    );

    const destPath = managedBinaryPath(dataDir, "darwin");
    assert.ok(!existsSync(destPath), "no binary should be installed on mismatch");
    const binDir = join(dataDir, "bin");
    if (existsSync(binDir)) {
      assert.ok(!readdirSync(binDir).some((f) => f.endsWith(".download")));
    }
  });

  it("installs without verification when the checksum manifest omits the asset", async () => {
    const fetchImpl = fakeFetch({}); // empty manifest
    const path = await downloadYtDlp(dataDir, "darwin", "arm64", fetchImpl);
    assert.ok(existsSync(path));
    assert.deepEqual(readFileSync(path), BINARY_BYTES);
  });

  it("rejects an empty response body", async () => {
    const fetchImpl = fakeFetch({ manifestFor: "yt-dlp_macos", binary: Buffer.alloc(0) });
    await assert.rejects(() => downloadYtDlp(dataDir, "darwin", "arm64", fetchImpl), /empty response/i);
  });
});
