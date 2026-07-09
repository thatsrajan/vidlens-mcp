import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MediaStore } from "../lib/media-store.js";
import { MediaDownloader } from "../lib/media-downloader.js";
import { resolveVideoSource } from "../lib/video-source.js";

function withStore(fn: (store: MediaStore) => Promise<void>): Promise<void> {
  const dataDir = join(tmpdir(), `vidlens-downloader-${randomUUID()}`);
  const store = new MediaStore({ dataDir });
  return fn(store).finally(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
}

/**
 * Fake yt-dlp that mimics the two behaviors under test: it resolves the `-o`
 * output template and — crucially — APPENDS to an existing file at that path,
 * the same resume behavior that corrupted real assets when video and audio
 * formats shared one filename.
 */
function writeFakeYtdlp(dir: string): string {
  const bin = join(dir, "fake-yt-dlp");
  writeFileSync(bin, `#!/bin/bash
if [[ " $* " == *" --dump-single-json "* ]]; then
  echo '{"duration": 214, "title": "Fake video", "extractor": "twitter", "webpage_url": "https://x.com/fake"}'
  exit 0
fi
out=""; fmt=""; prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  [[ "$prev" == "-f" ]] && fmt="$a"
  prev="$a"
done
ext="mp4"
[[ "$fmt" == bestaudio* ]] && ext="m4a"
path="\${out//%(ext)s/$ext}"
mkdir -p "$(dirname "$path")"
printf '%s' "\${FAKE_YTDLP_CONTENT:-MEDIA:$fmt;}" >> "$path"
`);
  chmodSync(bin, 0o755);
  return bin;
}

/** Fake ffprobe: fails on files containing "CORRUPT", succeeds otherwise. */
function writeFakeFfprobe(dir: string): string {
  const bin = join(dir, "fake-ffprobe");
  writeFileSync(bin, `#!/bin/bash
for last in "$@"; do :; done
if grep -q CORRUPT "$last" 2>/dev/null; then
  echo "moov atom not found" >&2
  exit 1
fi
echo '{"format":{"duration":"214.047"}}'
`);
  chmodSync(bin, 0o755);
  return bin;
}

const X_URL = "https://x.com/OpenAI/status/2074907025537224840/video/1";

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

test("video and audio downloads of the same post never share a file (X fMP4 collision)", async () => {
  await withStore(async (store) => {
    const ytdlp = writeFakeYtdlp(store.dataDir);
    const ffprobe = writeFakeFfprobe(store.dataDir);
    const downloader = new MediaDownloader(store, ytdlp, undefined, ffprobe);

    const video = await downloader.download({ videoIdOrUrl: X_URL, format: "worst_video" });
    const audio = await downloader.download({ videoIdOrUrl: X_URL, format: "best_audio" });

    assert.notEqual(video.asset.filePath, audio.asset.filePath);
    // The fake yt-dlp appends on re-download (real resume behavior); the video
    // file must be untouched by the audio download.
    assert.match(readFileSync(video.asset.filePath, "utf8"), /^MEDIA:worstvideo/);
    assert.match(readFileSync(audio.asset.filePath, "utf8"), /^MEDIA:bestaudio/);
    assert.ok(video.asset.fileName.includes(".worst_video."));
    assert.ok(audio.asset.fileName.includes(".best_audio."));
  });
});

test("unreadable downloads are rejected, deleted, and never registered", async () => {
  await withStore(async (store) => {
    const ytdlp = writeFakeYtdlp(store.dataDir);
    const ffprobe = writeFakeFfprobe(store.dataDir);
    const downloader = new MediaDownloader(store, ytdlp, undefined, ffprobe);

    process.env.FAKE_YTDLP_CONTENT = "CORRUPT";
    try {
      await assert.rejects(
        () => downloader.download({ videoIdOrUrl: X_URL, format: "best_video" }),
        /not readable by ffprobe/,
      );
    } finally {
      delete process.env.FAKE_YTDLP_CONTENT;
    }

    const videoId = resolveVideoSource(X_URL).assetKey;
    assert.equal(store.listAssetsForVideo(videoId).length, 0);
    assert.ok(!existsSync(join(store.videoDir(videoId), `${videoId}.best_video.mp4`)));
  });
});

test("concurrent same-format downloads share one in-flight task (no double write)", async () => {
  await withStore(async (store) => {
    const ytdlp = writeFakeYtdlp(store.dataDir);
    const ffprobe = writeFakeFfprobe(store.dataDir);
    const downloader = new MediaDownloader(store, ytdlp, undefined, ffprobe);

    const [a, b] = await Promise.all([
      downloader.download({ videoIdOrUrl: X_URL, format: "best_audio" }),
      downloader.download({ videoIdOrUrl: X_URL, format: "best_audio" }),
    ]);

    assert.equal(a.asset.assetId, b.asset.assetId);
    // The fake yt-dlp appends on every invocation; a race would run it twice
    // and leave two MEDIA markers in the file.
    const content = readFileSync(a.asset.filePath, "utf8");
    assert.equal(content.match(/MEDIA:/g)?.length, 1);
    const videoId = resolveVideoSource(X_URL).assetKey;
    assert.equal(store.listAssetsForVideo(videoId).filter((x) => x.kind === "audio").length, 1);
  });
});

test("stale STT chunk directories are cleaned up, never registered as the asset", async () => {
  await withStore(async (store) => {
    const ytdlp = writeFakeYtdlp(store.dataDir);
    const ffprobe = writeFakeFfprobe(store.dataDir);
    const downloader = new MediaDownloader(store, ytdlp, undefined, ffprobe);

    // Leftover from a crashed transcription: a directory sharing the audio
    // file's prefix (`<audio>.chunks/`), with content inside.
    const videoId = resolveVideoSource(X_URL).assetKey;
    const outDir = store.videoDir(videoId);
    const chunkDir = join(outDir, `${videoId}.best_audio.m4a.chunks`);
    mkdirSync(chunkDir, { recursive: true });
    writeFileSync(join(chunkDir, "chunk-001.m4a"), "stale");

    const result = await downloader.download({ videoIdOrUrl: X_URL, format: "best_audio" });

    assert.ok(!existsSync(chunkDir), "stale chunk dir should be removed before download");
    assert.match(readFileSync(result.asset.filePath, "utf8"), /^MEDIA:bestaudio/);
  });
});

test("corrupt legacy video rows without recorded format are swept on download", async () => {
  await withStore(async (store) => {
    const ytdlp = writeFakeYtdlp(store.dataDir);
    const ffprobe = writeFakeFfprobe(store.dataDir);
    const downloader = new MediaDownloader(store, ytdlp, undefined, ffprobe);

    // Legacy row: kind video, no meta.format — the format-scoped cache match
    // never inspects it, but visual/keyframe consumers pick it up by kind.
    const source = resolveVideoSource(X_URL);
    const videoId = source.assetKey;
    const outDir = store.videoDir(videoId);
    mkdirSync(outDir, { recursive: true });
    const legacyPath = join(outDir, `${videoId}.mp4`);
    writeFileSync(legacyPath, "CORRUPT-LEGACY");
    store.registerAsset({ videoId, kind: "video", filePath: legacyPath, sourcePlatform: source.platform });

    await downloader.download({ videoIdOrUrl: X_URL, format: "worst_video" });

    assert.ok(!existsSync(legacyPath), "corrupt legacy file should be deleted");
    const videos = store.listAssetsForVideo(videoId).filter((a) => a.kind === "video");
    assert.equal(videos.length, 1);
    assert.ok(videos[0]!.fileName.includes(".worst_video."));
  });
});

test("local ingestion never deletes the user's source file, even when corrupt", async () => {
  await withStore(async (store) => {
    const ffprobe = writeFakeFfprobe(store.dataDir);
    const downloader = new MediaDownloader(store, "yt-dlp-unused", undefined, ffprobe);

    // Ingest a corrupt local file with outputDir pointed at its own directory:
    // the ingest target IS the source, and validation failure must not rm it.
    const srcDir = join(store.dataDir, "user-files");
    mkdirSync(srcDir, { recursive: true });
    const srcFile = join(srcDir, "clip.mp4");
    writeFileSync(srcFile, "CORRUPT-USER-FILE");

    await assert.rejects(
      () => downloader.download({ videoIdOrUrl: srcFile, format: "best_video", outputDir: srcDir }),
      /not readable by ffprobe/,
    );
    assert.ok(existsSync(srcFile), "user's source file must never be deleted");
  });
});

test("corrupt cached assets are purged (including path-sharing rows) and re-downloaded", async () => {
  await withStore(async (store) => {
    const ytdlp = writeFakeYtdlp(store.dataDir);
    const ffprobe = writeFakeFfprobe(store.dataDir);
    const downloader = new MediaDownloader(store, ytdlp, undefined, ffprobe);

    // Recreate the pre-fix on-disk state: one corrupt file registered as BOTH
    // a video and an audio asset (legacy `${videoId}.mp4` naming).
    const source = resolveVideoSource(X_URL);
    const videoId = source.assetKey;
    const outDir = store.videoDir(videoId);
    mkdirSync(outDir, { recursive: true });
    const sharedPath = join(outDir, `${videoId}.mp4`);
    writeFileSync(sharedPath, "CORRUPT-CONCATENATED-STREAMS");
    store.registerAsset({
      videoId, kind: "video", filePath: sharedPath,
      sourcePlatform: source.platform, meta: { format: "worst_video" },
    });
    store.registerAsset({
      videoId, kind: "audio", filePath: sharedPath,
      sourcePlatform: source.platform, meta: { format: "best_audio" },
    });

    const result = await downloader.download({ videoIdOrUrl: X_URL, format: "best_audio" });

    assert.equal(result.cached, false);
    assert.ok(!existsSync(sharedPath), "corrupt shared file should be deleted");
    const remaining = store.listAssetsForVideo(videoId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.kind, "audio");
    assert.match(readFileSync(remaining[0]!.filePath, "utf8"), /^MEDIA:bestaudio/);
  });
});
