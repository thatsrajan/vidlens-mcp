# v2-x-launch — VidLens V2 release package for X

One folder, everything needed to release VidLens V2 on X.
Assembled 2026-08-17. **Nothing has been posted, uploaded, or scheduled.**

## What is where

| Path | What it is |
|---|---|
| `video/v3-trailer-final.mp4` | **The video.** 15.04 s, 1920x1080, 24 fps, H.264/AAC, -14.5 LUFS. Passes all 10 X checks. |
| `video/verify-final.sh` | Read-only ffprobe + loudness check. Re-run any time: `./verify-final.sh v3-trailer-final.mp4` |
| `video/platform-spec.md` | X video requirements, compliance table, researched upload windows (W1–W5). |
| `post/post-copy.md` | Three post options (A/B/C), hashtag guidance, alt text, open decisions. |
| `article/x-article.md` | The X article draft. Claims verified; editor notes at the bottom. |
| `assets/cover-endcard-16x9.png` | End-card frame from the final render. Article cover / share image. |
| `assets/article-header-16x9.png` | Close-up frame (7.5 s) — in-article image. |
| `assets/hook-frame-16x9.png` | Early frame (1.0 s) — spare. |
| `assets/endcard-plate-16x9.png` | The transparent type plate composited onto the end card. |

## Release order (suggested)

1. Pick post copy A, B, or C in `post/post-copy.md`.
2. Pick an upload window from `video/platform-spec.md`.
3. Upload `video/v3-trailer-final.mp4`, paste the alt text from `post/post-copy.md`.
4. Post.
5. Publish `article/x-article.md` as an X article with
   `assets/cover-endcard-16x9.png` as the cover. Delete the editor notes first.

## Sources

- Final render, plates, takes, audio and QC frames:
  `~/Dropbox/Projects/vids/vid-vidlensv2/claude-edits/v2-comingsoon-launch/`
  (see its `../README.md` for full provenance — Seedance job IDs, loudness passes).
- The longer ~95 s announcement cut lives at
  `~/Dropbox/Projects/vids/vid-vidlensv2/claude-edits/VidLens-V2-Claude-X-16x9-clean-v2.mp4`
  with SRT captions — a candidate follow-up post after the trailer.
- Script and claim guardrails:
  `~/Dropbox/Projects/vids/vid-vidlensv2/vidlens-v2-announcement-script.md`.

This folder is tracked in git (the `.gitignore` has explicit exceptions for it,
including the mp4).
