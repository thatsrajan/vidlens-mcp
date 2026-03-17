/**
 * Media Asset Store — SQLite-backed manifest for locally downloaded media assets.
 *
 * Manages metadata about downloaded videos, audio, and thumbnails.
 * Keeps a clear boundary: this module tracks *what we have locally*,
 * not transcript/embedding data (that's knowledge-base.ts).
 */
import { mkdirSync, existsSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/* ── Types ─────────────────────────────────────────────────────── */

export type AssetKind = "video" | "audio" | "thumbnail" | "keyframe";

export interface MediaAsset {
  assetId: string;
  videoId: string;
  kind: AssetKind;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  /** For keyframes: timestamp in seconds into the video */
  timestampSec?: number;
  /** For thumbnails/keyframes: image width */
  width?: number;
  /** For thumbnails/keyframes: image height */
  height?: number;
  /** For video/audio: duration in seconds */
  durationSec?: number;
  /** Arbitrary metadata JSON */
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface MediaAssetSummary {
  videoId: string;
  title?: string;
  assets: MediaAsset[];
  totalSizeBytes: number;
}

export interface StoreStats {
  totalAssets: number;
  totalSizeBytes: number;
  videoCount: number;
  byKind: Record<AssetKind, number>;
}

/* ── Config ────────────────────────────────────────────────────── */

export interface MediaStoreConfig {
  dataDir?: string;
}

function resolveDataDir(config?: MediaStoreConfig): string {
  const baseDir = config?.dataDir ?? process.env.VIDLENS_DATA_DIR ?? join(homedir(), "Library", "Application Support", "vidlens-mcp");
  const dir = join(baseDir, "media");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ── Store ─────────────────────────────────────────────────────── */

export class MediaStore {
  private readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly assetsDir: string;

  constructor(config?: MediaStoreConfig) {
    this.dataDir = resolveDataDir(config);
    this.assetsDir = join(this.dataDir, "files");
    mkdirSync(this.assetsDir, { recursive: true });

    const dbPath = join(this.dataDir, "media-manifest.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_assets (
        asset_id        TEXT PRIMARY KEY,
        video_id        TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK(kind IN ('video','audio','thumbnail','keyframe')),
        file_path       TEXT NOT NULL,
        file_name       TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL DEFAULT 0,
        mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
        timestamp_sec   REAL,
        width           INTEGER,
        height          INTEGER,
        duration_sec    REAL,
        meta_json       TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_media_video ON media_assets(video_id);
      CREATE INDEX IF NOT EXISTS idx_media_kind  ON media_assets(kind);
    `);
  }

  /* ── Write ──────────────────────────────────────────────────── */

  /**
   * Register a downloaded asset in the manifest.
   * The file must already exist on disk at `filePath`.
   */
  registerAsset(params: {
    videoId: string;
    kind: AssetKind;
    filePath: string;
    mimeType?: string;
    timestampSec?: number;
    width?: number;
    height?: number;
    durationSec?: number;
    meta?: Record<string, unknown>;
  }): MediaAsset {
    const assetId = randomUUID();
    const fileName = basename(params.filePath);
    const mimeType = params.mimeType ?? guessMimeType(params.filePath);

    let fileSizeBytes = 0;
    if (existsSync(params.filePath)) {
      fileSizeBytes = statSync(params.filePath).size;
    }

    const metaJson = params.meta ? JSON.stringify(params.meta) : null;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO media_assets
        (asset_id, video_id, kind, file_path, file_name, file_size_bytes,
         mime_type, timestamp_sec, width, height, duration_sec, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assetId,
      params.videoId,
      params.kind,
      params.filePath,
      fileName,
      fileSizeBytes,
      mimeType,
      params.timestampSec ?? null,
      params.width ?? null,
      params.height ?? null,
      params.durationSec ?? null,
      metaJson,
      now,
    );

    return {
      assetId,
      videoId: params.videoId,
      kind: params.kind,
      filePath: params.filePath,
      fileName,
      fileSizeBytes,
      mimeType,
      timestampSec: params.timestampSec,
      width: params.width,
      height: params.height,
      durationSec: params.durationSec,
      meta: params.meta,
      createdAt: now,
    };
  }

  /* ── Read ───────────────────────────────────────────────────── */

  getAsset(assetId: string): MediaAsset | null {
    const row = this.db.prepare(
      "SELECT * FROM media_assets WHERE asset_id = ?",
    ).get(assetId) as RawRow | undefined;
    return row ? rowToAsset(row) : null;
  }

  listAssetsForVideo(videoId: string): MediaAsset[] {
    const rows = this.db.prepare(
      "SELECT * FROM media_assets WHERE video_id = ? ORDER BY kind, created_at",
    ).all(videoId) as unknown as RawRow[];
    return rows.map(rowToAsset);
  }

  listAllAssets(options?: { kind?: AssetKind; limit?: number; offset?: number }): MediaAsset[] {
    let sql = "SELECT * FROM media_assets";
    const params: unknown[] = [];

    if (options?.kind) {
      sql += " WHERE kind = ?";
      params.push(options.kind);
    }

    sql += " ORDER BY created_at DESC";

    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...(params as Array<string | number | null>)) as unknown as RawRow[];
    return rows.map(rowToAsset);
  }

  getVideoSummary(videoId: string): MediaAssetSummary {
    const assets = this.listAssetsForVideo(videoId);
    const totalSizeBytes = assets.reduce((sum, a) => sum + a.fileSizeBytes, 0);
    return { videoId, assets, totalSizeBytes };
  }

  getStats(): StoreStats {
    const countRow = this.db.prepare(
      "SELECT COUNT(*) as cnt, COALESCE(SUM(file_size_bytes),0) as sz FROM media_assets",
    ).get() as { cnt: number; sz: number };

    const videoCountRow = this.db.prepare(
      "SELECT COUNT(DISTINCT video_id) as cnt FROM media_assets",
    ).get() as { cnt: number };

    const kindRows = this.db.prepare(
      "SELECT kind, COUNT(*) as cnt FROM media_assets GROUP BY kind",
    ).all() as Array<{ kind: string; cnt: number }>;

    const byKind: Record<string, number> = {};
    for (const r of kindRows) {
      byKind[r.kind] = r.cnt;
    }

    return {
      totalAssets: countRow.cnt,
      totalSizeBytes: countRow.sz,
      videoCount: videoCountRow.cnt,
      byKind: byKind as Record<AssetKind, number>,
    };
  }

  /* ── Delete ─────────────────────────────────────────────────── */

  /**
   * Remove an asset from the manifest and optionally delete the file on disk.
   */
  removeAsset(assetId: string, deleteFile = true): boolean {
    const asset = this.getAsset(assetId);
    if (!asset) return false;

    if (deleteFile && existsSync(asset.filePath)) {
      unlinkSync(asset.filePath);
    }

    this.db.prepare("DELETE FROM media_assets WHERE asset_id = ?").run(assetId);
    return true;
  }

  /**
   * Remove all assets for a given video.
   */
  removeVideoAssets(videoId: string, deleteFiles = true): number {
    const assets = this.listAssetsForVideo(videoId);
    if (deleteFiles) {
      for (const asset of assets) {
        if (existsSync(asset.filePath)) {
          unlinkSync(asset.filePath);
        }
      }
    }
    this.db.prepare("DELETE FROM media_assets WHERE video_id = ?").run(videoId);
    return assets.length;
  }

  /**
   * Return the base directory where asset files should be stored for a given video.
   */
  videoDir(videoId: string): string {
    const dir = join(this.assetsDir, videoId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  close(): void {
    this.db.close();
  }
}

/* ── Internal helpers ──────────────────────────────────────────── */

interface RawRow {
  asset_id: string;
  video_id: string;
  kind: string;
  file_path: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  timestamp_sec: number | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  meta_json: string | null;
  created_at: string;
}

function rowToAsset(row: RawRow): MediaAsset {
  return {
    assetId: row.asset_id,
    videoId: row.video_id,
    kind: row.kind as AssetKind,
    filePath: row.file_path,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    mimeType: row.mime_type,
    timestampSec: row.timestamp_sec ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    durationSec: row.duration_sec ?? undefined,
    meta: row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
  };
}

function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return map[ext] ?? "application/octet-stream";
}
