# Platform spec — X (Twitter) video, 15s / 1080p / 16:9 / H.264

Release: `v2-coming-soon` · Staged 2026-08-12 · **Nothing uploaded.**

Scope: only the requirements that bear on this upload — a short, silent-friendly,
landscape H.264 clip posted from the web composer. X's full matrix (9:16, 4:20+ premium
long-form, GIF, live) is out of scope.

---

## 1. Requirements

| Property | Requirement | Our target |
|---|---|---|
| Container | MP4 (or MOV) | MP4 |
| Video codec | H.264 | H.264 High profile |
| Profile / level | High or Main, level 4.0 or below for 1080p | High |
| Pixel format | `yuv420p` — 4:2:0 chroma, 8-bit | `yuv420p` |
| Resolution | 1920x1080 is the right target. Export 1080p, not 4K — X re-encodes everything server-side, so a 4K master buys a slow upload and a downscaled result, not 4K playback. (The `32x32`–`1280x1024` bounds in X's developer docs are v1 **API** limits and do not apply to the web composer.) | 1920x1080 |
| Aspect ratio | 16:9 recommended; supported range 1:2.39 – 2.39:1, outside which X crops or letterboxes. 1:1 and 9:16 get more timeline height on mobile | 16:9 |
| Frame rate | up to 60 fps | 24 fps |
| Video bitrate | ~5,000–8,000 kbps for 1080p; 25 Mbps is the documented ceiling | ~8,000 kbps |
| Duration | 0.5s minimum; 140s maximum on a standard account | ~15s |
| File size | 512 MB via the web composer | well under |
| Audio codec | AAC-LC | AAC-LC |
| Audio sample rate | 44.1 or 48 kHz | 48 kHz |
| Audio channels | stereo | stereo |
| Audio bitrate | 128 kbps minimum, 192 kbps comfortable | ≥128 kbps |
| Loudness | not a hard requirement; playback normalises toward ~-14 LUFS | -14 LUFS, TP ≤ -1 dBTP |
| Post text | 280 characters on a standard account | ≤280 (see `post-copy.md`) |
| Attachment cost | an attached video consumes **0** characters | — |
| Link cost | any URL counts as a flat 23 characters via t.co, regardless of real length | no link planned |

Notes on the margins:

- **Duration** is the one to watch. 140s is the standard-account ceiling; a 15s trailer is
  nowhere near it, so no risk here. Premium tiers raise this substantially, but this post
  should not depend on a premium-only allowance.
- **Autoplay is muted.** Treat sound as an enhancement, not a carrier. This is a design
  constraint on the trailer, not a technical one — but it is the constraint most likely to
  cost reach.
- **X re-encodes everything.** Sending a clean, high-bitrate, correctly-flagged master is
  the only lever you have over the result; do not pre-compress to "help".
- **`yuv420p` is not optional.** A 4:2:2 or 10-bit master (common straight out of an edit
  or a LUT pass) is a frequent silent-failure mode on upload. Verified explicitly by the
  check script.

### Sourcing

Figures cross-checked against X's Help Center ("About longer videos for X Premium
subscribers") and the X Developer Platform "Media Best Practices" page. **Caveat worth
knowing:** X actively blocks automated fetching of both pages (403 / 402), so these were
read via search-engine extraction rather than directly. The numbers are stable and
consistent across years, but if a figure is load-bearing for a decision, eyeball the
official page in a browser first. Where guidance and observed behaviour differ, the table
takes the conservative number.

Not relevant to this post but worth knowing: X Premium raises the duration ceiling to
4 hours (web/iOS) and the size ceiling to 16 GB, and the text limit to 25,000 characters.
This post should not depend on a premium-only allowance.

---

## 2. Compliance checklist — final file

Target: `/Users/rajan/Dropbox/Projects/VidLens/marketing-round/art/v3-trailer-final.mp4`

**Status: PENDING VERIFICATION — the file does not exist.** Confirmed absent as of
2026-08-12 23:47; a search across `/Users/rajan/Dropbox/Projects/VidLens/` for any `.mp4`
or `.mov` returns no `v3-trailer-final`. Every row below is unverified.

| # | Check | Requirement | Measured | Result |
|---|---|---|---|---|
| 1 | File present | exists at target path | — | **PENDING — file missing** |
| 2 | Container | MP4 | — | PENDING |
| 3 | Video codec | H.264 | — | PENDING |
| 4 | Profile | High / Main | — | PENDING |
| 5 | Pixel format | `yuv420p` | — | PENDING |
| 6 | Resolution | 1920x1080 | — | PENDING |
| 7 | Aspect ratio | 16:9 (1.777…) | — | PENDING |
| 8 | Frame rate | ≤60 fps | — | PENDING |
| 9 | Duration | ≥0.5s and ≤140s | — | PENDING |
| 10 | File size | ≤512 MB | — | PENDING |
| 11 | Audio codec | AAC-LC | — | PENDING |
| 12 | Audio sample rate | 44.1 / 48 kHz | — | PENDING |
| 13 | Audio bitrate | ≥128 kbps | — | PENDING |
| 14 | Integrated loudness | ~-14 LUFS | — | PENDING (see warning below) |
| 15 | True peak | ≤ -1 dBTP | — | PENDING |
| 16 | Reads with sound off | judgement call | — | PENDING — your call |

Fill this table by running:

```
/Users/rajan/Dropbox/Projects/VidLens/marketing-round/releases/v2-coming-soon/verify-final.sh
```

### Advance warning on rows 14–15

The intended 15s score, `marketing-round/art/v3-trailer-score.wav`, measures **-40.1 LUFS
integrated, true peak -23.5 dBFS**. If it is laid under the picture as-is, rows 14 and 15
fail badly — roughly 26 LU below target. The already-shipped 7s intro has the same problem
at -30.0 LUFS. Normalise before the final render rather than after; a `loudnorm` pass on
the finished mux is fine but a re-encode you could have avoided.

### Reference: a file that does pass

`marketing-round/brand-v3/lens-intro-16x9-7s.mp4` was run through the same script and
passes rows 2–13 cleanly (7.50s, 1920x1080, H.264 High, yuv420p, 24fps, 7.64 Mbps video,
AAC-LC 48 kHz stereo 193 kbps, 7.01 MB). Its encode settings are a known-good template for
the final render. It fails row 14 at -30.0 LUFS.

---

## 3. Upload windows

Options with evidence. **The pick is yours** — I am not scheduling anything, and X does
not allow scheduling from this package regardless.

### Read this before the table

Three things the research actually established, which matter more than the specific hours:

1. **Day-of-week evidence is solid. Hour-of-day evidence is weak.** Four large independent
   studies (Sprout ~2B engagements, Buffer 8.7M posts, Hootsuite 1M+, SocialPilot ~700K)
   agree on **Tuesday–Thursday, avoid Saturday**. They flatly contradict each other on the
   hour — there is a morning camp and an afternoon camp.
2. **Every one of those studies reports times in the reader's local time.** Buffer says so
   explicitly. For an audience spread across ~9 timezones, "post at 9 a.m." has no single
   UTC answer. The overlap reasoning in the table below is constructed, not measured.
3. **Nobody has measured posting time for a dev-tool / MCP / AI-agent-tooling audience on
   X.** That research does not exist. Anything claiming to know is marketing content
   without a dataset. The effect size where it *has* been measured is small — one HN study
   found only ~11% variance across hours and ~3% across days.

Times use **summer offsets** (correct for August 2026): EDT UTC−4, PDT UTC−7, CEST UTC+2.
In winter the UTC anchor shifts an hour, and for ~3 weeks each spring/autumn the US and EU
DST transitions are misaligned and the overlap narrows.

### Candidates

| | Window (UTC) | US East | US West | Central EU | Trade-off |
|---|---|---|---|---|---|
| **W1** *(suggested)* | Tue/Wed/Thu **15:00–16:00** | 11:00–12:00 | 08:00–09:00 | 17:00–18:00 | Only hour all three regions are plausibly at a keyboard. Compromise slot — nobody's peak. |
| **W2** | Tue **13:00–14:00** | 09:00–10:00 | 06:00–07:00 | 15:00–16:00 | Buffer's single best slot, anchored to US East. **Sacrifices US West** — 6 a.m. PT. |
| **W3** | Tue/Wed/Thu **17:00–18:00** | 13:00–14:00 | 10:00–11:00 | 19:00–20:00 | Proper US Pacific working hours. **Gives up EU** — 7–8 p.m. CEST is post-work. |
| **W4** | Mon/Tue: HN 06:00–12:00, then X **14:00–16:00** | — | — | — | The one dev-native rhythm found. Evidence is 6 years old and about HN, not X. |
| **W5** | Sat/Sun 14:00–17:00 | — | — | — | Contrarian. X studies say Saturday is the worst day; HN data says weekends are marginally better. **Not recommended.** |

### On each

- **W1 — Tue/Wed/Thu 15:00–16:00 UTC.** My suggestion if you want one. Catches EU
  end-of-day scroll, US East late morning, US West start of day. Sits inside Sprout
  Social's software/tech recommendation (Tue–Thu, 11 a.m.–4 p.m. local) read against US
  Eastern. *Evidence: moderate.* Sprout's dataset is large and real, but their per-industry
  "software/tech" cut is published as a recommendation without the underlying data, and the
  three-way overlap construction is inference on top of it.

- **W2 — Tue 13:00–14:00 UTC.** Buffer's highest-engagement slot is Tuesday 9 a.m. local.
  *Evidence: moderate on the day, weak on the hour* — directly contradicted by Sprout. The
  real cost is US West Coast, which is where a large share of the MCP and AI-agent-tooling
  audience actually sits.

- **W3 — Tue/Wed/Thu 17:00–18:00 UTC.** Inside Sprout's 12–6 p.m. finding for US Eastern
  and properly inside US Pacific hours. *Evidence: moderate.* One reconciliation offered by
  a study-comparison blog: the morning studies measure engagement *per post* while Sprout
  measures engagement *volume*, so "publish late morning, harvest through the afternoon"
  partly dissolves the contradiction. That is a blog's interpretation, not a finding.

- **W4 — HN coupling.** Submit to Hacker News 06:00–12:00 UTC (lowest submission
  competition while the US sleeps), then post to X at 14:00–16:00 UTC as US morning traffic
  arrives; front-page posts averaged ~8 hours of visibility, so the HN post is still live.
  *Evidence: weak and stale* — 13,159 posts, but collected over a 2-week window in **2020**,
  and about HN rather than X. A hypothesis to test, not a finding. Also: a "coming soon"
  with nothing installable is a poor HN submission. This one probably belongs to the actual
  launch, not this post.

- **W5 — weekend.** Included only because the two evidence bases genuinely conflict.
  Would not lead with it.

### Claims deliberately excluded

- "Tech audiences are most active 10 a.m.–2 p.m." — recurs across several blogs with **no
  cited dataset**. Marketing-blog-tier; not weighted.
- "Accounts posting daily see 40% higher engagement" and the idea that posting at a
  consistent time builds an algorithmic "reliability signal" — **no source, no disclosed
  mechanism.** Treated as fiction.

### The two things that would actually beat all of this

1. **Your own X analytics.** Follower geo-distribution and per-post impression timing would
   settle the US/EU weighting question definitively and make this entire section moot. That
   data is not something I can reach — pull it before optimising against generic studies.
2. **Being available to reply.** For a dev-tool announcement, an hour of you answering
   "does it handle X?" in the replies is worth more than any window in this table. Pick the
   slot you can staff.

One counterweight to hold onto: X engagement is reported down ~9% platform-wide in 2026
(secondary source, unverified). If that is true, timing optimisation is a small lever
relative to the trailer and the copy — which even the timing studies concede is the
dominant factor.
