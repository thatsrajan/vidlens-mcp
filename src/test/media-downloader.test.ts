import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MediaStore } from "../lib/media-store.js";
import { MediaDownloader } from "../lib/media-downloader.js";

function withStore(fn: (store: MediaStore) => Promise<void>): Promise<void> {
  const dataDir = join(tmpdir(), `vidlens-downloader-${randomUUID()}`);
  const store = new MediaStore({ dataDir });
  return fn(store).finally(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
}

test("download rejects non-finite maxSizeMb before touching the network", async () => {
  await withStore(async (store) => {
    const downloader = new MediaDownloader(store);
    await assert.rejects(
      () => downloader.download({
        videoIdOrUrl: "https://youtu.be/dQw4w9WgXcQ",
        format: "best_video",
        maxSizeMb: Infinity,
      }),
      /finite/,
    );
  });
});

test("download refuses private/link-local URLs (SSRF guard wired)", async () => {
  await withStore(async (store) => {
    const downloader = new MediaDownloader(store);
    await assert.rejects(
      () => downloader.download({
        videoIdOrUrl: "http://169.254.169.254/latest/meta-data/",
        format: "best_video",
      }),
      /private|loopback|link-local/i,
    );
  });
});
