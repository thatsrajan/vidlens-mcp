# VidLens Brand Guide — lens-v3

Audience: Codex (and any agent) building the README, the npm package page,
the CLI install banner, and future brand assets. Follow this file. Do not
invent new colors, fonts, or motifs.

Folder layout:

- `assets/brand/` — the live brand. Everything in this folder is current.
- `assets/arch/` — the ARCHIVE. Old brand files (previous banner, social
  previews, old CLI banner, retired demo GIFs, v2 drafts) plus the
  architecture diagrams (`arch-*.png`, still referenced by the README).
  Never pull retired brand files from here into new surfaces.
- Production masters (takes, plates, audio, render scripts) stay outside the
  repo at `~/Dropbox/Projects/vids/vid-vidlensv2/claude-edits/`.

---

## 1. Brand essence

VidLens turns video into a queryable local asset for AI agents. The brand
expresses that as **archival care**: video evidence pinned, indexed, and
cataloged like specimens in a naturalist's notebook.

Design around this phrase (from `design.md`):

> A mythic intelligence cataloged with scientific care.

The visual language is Japanese wabi-sabi: watercolor pigment bleeding into
handmade washi paper, sumi ink, one gold-leaf accent, seigaiha wave pattern.
Calm, old-world, exacting. Never glossy futurism.

Mood words: scholarly, curious, archival, precise, quiet.

Never: neon gradients, cyberpunk palettes, purple-blue "AI" styling, glow,
glassmorphism, rounded SaaS cards, robots, brains, particle effects, spinners.

## 2. Logo

The mark is a **six-blade camera aperture painted in indigo watercolor, with a
white hexagon center, enclosed in a hand-drawn gold-leaf ring**, on washi
paper.

Files (all in `assets/brand/`):

| File | Size | Use |
|---|---|---|
| `mark-square.png` / `vidlens-logo.png` (identical) | 1024x1024 | Large logo placements, video, print |
| `vidlens-aperture-mark.png` | 256x256 | Inline marks, avatars, UI headers |
| `vidlens-favicon.png` | 128x128 | Favicon source |
| `readme-banner.png` | 1376x768 | README/hero banner (wordmark + tagline + command + mark) |
| `endcard-16x9.png`, `endcard-9x16.png`, `intro-end.png` | 1376x768 / 768x1376 | Video endcards |

Rules:

- Do not recolor, flip, outline, or add effects to the mark.
- Do not place the mark on dark backgrounds. It lives on washi cream. If a
  surface must be dark, put a washi-colored plate behind it (the Evidence
  Atlas mockup shows the approved dark-frame treatment: mark on a small
  circular washi plate).
- Clear space around the ring: at least 25% of the ring diameter.
- Below 48px, use `vidlens-favicon.png`-derived sizes and check legibility;
  if 16px reads as a smudge, redraw a flat indigo `#053054` glyph for the
  tiny sizes only.

## 3. Wordmark and typography

| Role | Typeface | Where |
|---|---|---|
| Wordmark + display | **Shippori Mincho Medium** (`assets/brand/ShipporiMincho-Medium.ttf`, also on Google Fonts) | "VidLens" wordmark, headings on brand surfaces, plates |
| Interface sans | Inter or IBM Plex Sans | Body text on web/product pages |
| Mono / commands | IBM Plex Mono or JetBrains Mono | Install commands, code, data labels |

- The wordmark is "VidLens" set in Shippori Mincho Medium, sumi ink, normal
  case (capital V, capital L). Reference: `assets/brand/type_block.png`.
  Never bold it, never all-caps.
- Small badge text (e.g. `FREE · OPEN SOURCE · MIT`) is letterspaced
  uppercase, gold, small — see bottom-right of `endcard-16x9.png`.
- Captions should read like museum labels: small, quiet, exact.

## 4. Color

Measured from the shipped lens-v3 pixels; the two inks were pinned during
production. Use these values; do not resample or "improve" them.

| Token | Hex | Use |
|---|---|---|
| Washi cream (base) | `#E9E5DA` | Backgrounds, banners, cards |
| Washi highlight | `#F5F3EA` | Lightest paper areas, inner plates |
| Sumi ink | `#27221F` | Wordmark, headings, primary text |
| Indigo deep | `#053054` | Aperture blades, strongest accent |
| Indigo teal | `#044F67` | Second tagline line, links, secondary accent |
| Command indigo | `#3D4864` | Mono/command text on washi |
| Indigo wash | `#B1C1C7` | Watercolor tints, subtle fills, wave pattern |
| Gold leaf | `#A6946B` – `#E3D3AD` (flat use: `#C4A987`) | Ring, badge text, thin rules. One gold element per surface, maximum |

Color is evidence, not decoration: surfaces are paper-led, accents appear only
as marks, stamps, and rules. For richer product/web pages, the extended
archival palette in `design.md` §Palette (parchment, terracotta, botanical
green, specimen teal, ochre) is approved as secondary — the Evidence Atlas
mockup (`assets/brand/video-evidence-atlas.png`) shows this in practice.
Washi + sumi + indigo + gold always lead.

## 5. Texture and pattern

- **Washi grain**: brand surfaces sit on handmade-paper texture. Full-res
  blank plate: `assets/brand/washi-blank.png` (1376x768). Lightweight web
  tile: `assets/brand/vidlens-washi-bg.webp` (720x402, 15 KB). For flat UI
  contexts (npm README, terminals) plain hex fills are acceptable.
- **Seigaiha waves**: overlapping indigo wave arcs, bottom band only, drawn
  faint (`#B1C1C7`-strength). See the banner footer. Never tile it across a
  whole surface.
- **Deckled edges**: masters have torn-paper edges. Keep them; do not crop
  to hard rectangles when the surface allows.

## 6. Voice and locked copy

- Tagline (locked, verbatim, two lines):
  Line 1 in sumi: `Your AI can read the web.`
  Line 2 in indigo teal: `Now it can also watch it.`
- Install command (always mono, command indigo, `$ ` prefix optional):
  `npx vidlens-mcp setup`
- Badge line: `FREE · OPEN SOURCE · MIT`
- Prose voice: plain, active, short sentences. No hype words ("blazingly",
  "supercharge", "unleash"). Explain like the reader is smart but new.

## 7. Product UI reference — Evidence Atlas

`assets/brand/video-evidence-atlas.png` is the approved product-UI mockup and
the bridge between this brand and `design.md`'s component language:

- Specimen-board layout: parchment ground, full-width bands, no SaaS cards.
- Serif display headlines (query text in specimen teal), letterspaced
  micro-labels (`RETRIEVAL METHOD`, `EVIDENCE PLATE 01`) as museum captions.
- Evidence plates: dark video frames carry the aperture mark on a circular
  washi plate with a timestamp; metadata as stamped labels (OCR, SEMANTIC).
- Provenance is always visible: method, scope, index, time coverage.

Any future web page, viewer, or screenshot styling should extend this mockup
and `design.md` §Components (Source Plate, Specimen Frame Grid, Field Note,
Provenance Ledger).

## 8. Asset generation pipeline (Higgsfield + plates)

New animated/painterly assets are generated on **Higgsfield**
(higgsfield.ai), model `seedance_2_0`, from a start image, 16:9, 1080p,
`generate_audio: false`. The approved prompt language (keep this vocabulary):

> ... watercolor medallion icons bloom into existence one by one, pigment
> bleeding organically into the paper fibers; fine indigo ink lines draw
> themselves forward ... gold-leaf ring catches a slow glint of light ...
> Japanese wabi-sabi elegance, soft pastel palette, nihonga watercolor,
> delicate paper grain, soft natural daylight, no hands, no people, serene
> and cinematic.

Full approved job: `~/Dropbox/Projects/vids/vid-vidlensv2/claude-edits/`
`v2-comingsoon-launch/02-takes/take-a-approved/v3-trailer-raw.json`.

Text plates (wordmark, taglines) are rendered locally, not generated:
`v2-comingsoon-launch/05-plates-and-fonts/render_plates.py` with
ShipporiMincho-Medium.ttf, sumi `#27221F` / teal `#044F67` on transparent
1920x1080 RGBA. Extend that script for new plates; do not typeset text inside
Higgsfield.

Motion rules (from `design.md`): slow drift, gentle parallax, ink-draw
reveals, match-cuts where evidence resolves into one shape. No bounce, no
carousels, no particles.

## 9. Surface specs

### 9.1 GitHub README (`README.md`)

Already rebranded (banner, tagline, and v2 system diagram).
Remaining rules for edits:

- Banner imagery loads from `assets/brand/`; architecture imagery loads from
  `assets/arch/`. Use absolute `raw.githubusercontent.com` URLs in the README.
  Keep images referenced by absolute raw URLs, width 800, centered. Add a
  `?v=` cache-buster whenever an image's content changes under the same name.
- Weight budget: hero images should be < 400 KB. `readme-banner.png` is
  currently 1.9 MB — serve an optimized copy (resize to 1280 wide,
  `-quality 85`) rather than the master.
- Architecture diagrams stay at `assets/arch/arch-*.png`.
- Section separators: thin horizontal rules; a faint seigaiha band is
  approved as a single footer element.
- Demo GIFs (to be re-recorded): terminal recordings should use a light
  cream terminal theme (washi `#E9E5DA` background, sumi text, indigo
  accents). Old GIFs are retired in `assets/arch/gifs/` — do not re-embed.

### 9.2 npm package page (npmjs.com/package/vidlens-mcp)

The npm page renders the same README with stricter rules:

- Images must be absolute URLs (raw.githubusercontent) — already the pattern.
- npm strips some HTML; keep to `<p align="center"><img ...></p>` and plain
  markdown. No `<picture>`, no CSS.
- npm's content column is ~792px: the 800-wide banner is correct.
- First screenful priority: banner → tagline → install command → three
  capability bullets. Long architecture detail stays below the fold.

### 9.3 CLI install banner (`npx vidlens-mcp setup`)

The old banner (`assets/arch/banner.ts`, archived) is the previous brand.
Build the replacement into the CLI source:

- ASCII/Unicode aperture: a small hexagon-in-circle glyph or minimal
  six-line aperture; do not attempt to draw the watercolor mark in ASCII.
- Wordmark line: `VidLens` plain text, then the two-line tagline.
- Truecolor ANSI when supported, with 256-color fallback:
  sumi text = default foreground; indigo teal `#044F67` (ANSI 24-bit
  `\x1b[38;2;4;79;103m`, fallback color 30) for tagline line 2 and accents;
  gold `#C4A987` (fallback color 180) for the one rule/badge line.
- No background fills (terminal themes vary); never assume dark or light.
- Keep it under 12 rows; a quiet banner is on-brand.

## 10. Asset checklist

| Asset | Status | Source / action |
|---|---|---|
| README banner | Done (optimize) | `readme-banner.png`; serve < 400 KB web copy |
| Logo mark | Done | `mark-square.png` / `vidlens-logo.png`, `vidlens-aperture-mark.png` |
| Favicon | Done (verify 16px) | `vidlens-favicon.png`; flat redraw only if 16px is illegible |
| Evidence Atlas concept mockup | Internal reference | `video-evidence-atlas.png`; retain as brand imagery, not a shipped or README-embedded product UI |
| Washi web tile | Done | `vidlens-washi-bg.webp` |
| Endcards 16:9 / 9:16 | Done | `endcard-*.png`, `intro-end.png` (video use) |
| X trailer 15s | Done | `releases/v2-x-launch/video/v3-trailer-final.mp4` |
| CLI install banner | **Build** | Per §9.3; old one archived at `assets/arch/banner.ts` |
| GitHub social preview (1280x640) | **Create** | Compose from `washi-blank.png` + mark + wordmark + tagline; upload via repo Settings → Social preview |
| README demo GIFs (x3) | **Re-record** | Per §9.1; interactive task, done with Rajan |
| YouTube thumbnail | **Create when needed** | Endcard layout + one sumi headline, 1280x720 |

## 11. Provenance

- Production source of truth: `~/Dropbox/Projects/vids/vid-vidlensv2/claude-edits/`
  (README.md there documents every take, plate, and render).
- Design direction: `design.md` at repo root (Claude Fable 5 promo-inspired
  archival brief) — palette, layout, motion, and component language.
- Rejected directions: `claude-edits/brand-assets/lens-v3/3D-lens-rejected/`
  and take B in `02-takes/take-b-rejected/` (do not reuse).
- Archive: `assets/arch/` — previous brand and drafts; `assets/arch/v2/` is
  gitignored (large drafts).
