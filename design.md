# Design Brief: Claude Fable 5 Promo-Inspired Direction

Source: https://x.com/claudeai/status/2064394146916229443

This design brief is based on the Claude Fable 5 launch promo video posted by
`@claudeai` on June 9, 2026. The post copy introduces "Claude Fable 5" as a
"Mythos-class model" whose capabilities exceed previous generally available
Claude models. The video itself is a 20.48 second, square, 24 fps composition.

Note: the source tweet spells the product name "Fable 5"; use that spelling
instead of "Fabel 5" in final UI copy unless intentionally parodying or
renaming it.

## Core Creative Idea

The promo makes advanced AI feel like a discovered artifact: part scientific
specimen, part folklore, part museum catalog. It avoids glossy futurism. The
emotional tone is curious, old-world, exacting, and quietly uncanny.

Design around the phrase:

> A mythic intelligence cataloged with scientific care.

The best translation into product design is not a generic AI dashboard. It is a
calm, archival interface where evidence, media, citations, frames, and model
outputs feel carefully pinned, indexed, and revealed.

## Visual Observations From The Video

The video moves through a sequence of archival and specimen-like imagery:

- Butterflies and moths drifting across cream natural-history plates.
- Antique map fragments and atlas textures.
- Ceramic vessels, profile portraiture, and cabinet-of-curiosity objects.
- Engraving-style diagrams and mechanical/weather-like plates.
- Bird taxonomy illustrations with small labels.
- Green algae or microscopic organisms on a pale field.
- Dense historical text columns.
- Botanical fig branches, flowers, and pressed-flora compositions.
- A large hand-drawn map-shaped numeral `5`.
- Yellow paper tiles arranged into a `5`.
- Circuit-board imagery forming a `5`.
- Constellation points forming a `5` on deep teal.
- A petri dish with living green colonies forming a `5`.
- A terracotta title field reading `Fable 5`.
- A final white grid field resolving to the `Claude` wordmark.

The repeated motif is transformation: many unrelated knowledge domains briefly
organize themselves into the same symbol. The `5` becomes a shared attractor
across nature, maps, circuits, stars, biology, and paper notes.

## Mood

- Scholarly without being dry.
- Magical without being childish.
- Premium without chrome, glow, or glassmorphism.
- Curious rather than loud.
- Archival rather than futuristic.
- Precise, slow, and deliberate.

Avoid:

- Neon gradients.
- Cyberpunk palettes.
- Heavy purple-blue AI styling.
- Overly rounded SaaS cards.
- Generic chatbot bubbles as the main visual language.
- Stock images of robots, brains, clouds, or abstract networks.

## Palette

Use a restrained archival palette with one warm signal color and one cool
scientific contrast.

Primary surfaces:

- Parchment: `#F4EBDD`
- Warm paper: `#E9DCC7`
- Grid white: `#F8F6F0`
- Ink black: `#15130F`
- Faded graphite: `#56514A`

Accent colors:

- Terracotta title field: `#C8664F`
- Botanical green: `#5F8B63`
- Deep specimen teal: `#1F6668`
- Ochre note paper: `#E6C65B`
- Muted butterfly red: `#B84E42`

Use color as evidence, not decoration. Most screens should feel paper-led, with
accents appearing through specimen marks, highlights, timestamps, pins, or
active states.

## Typography

Use a high-contrast serif for hero and artifact labels, paired with a quiet
interface sans.

Recommended pairings:

- Display serif: `Cormorant Garamond`, `Libre Baskerville`, or `Fraunces`.
- Interface sans: `Inter`, `IBM Plex Sans`, or `Geist`.
- Mono/data: `IBM Plex Mono`, `JetBrains Mono`, or `Geist Mono`.

Type behavior:

- Hero titles should feel bookish and editorial.
- Interface text should be small, scan-friendly, and utilitarian.
- Captions should resemble museum labels or plate annotations.
- Avoid oversized marketing copy except in the opening hero.

## Layout System

Favor a specimen-board layout over a card-heavy SaaS layout.

Recommended structure:

1. Hero: full-bleed archival motion or still frame with sparse title text.
2. Evidence strip: thumbnails, timestamps, source URL, model/source metadata.
3. Main work surface: a grid-paper or parchment canvas with pinned media
   evidence and extracted observations.
4. Detail drawer: transcript, frame notes, OCR, citations, and tool provenance.
5. Output panel: the final synthesis, styled like a field note or catalog entry.

Page sections should be full-width bands or unframed layouts. Use cards only for
individual repeated evidence items, modals, or compact tools.

## Motion Language

Motion should feel like objects being discovered, sorted, and classified.

Use:

- Slow drift for butterflies, paper scraps, and botanical fragments.
- Gentle parallax on map/plate layers.
- Match-cuts where different evidence types resolve into the same shape.
- Soft focus pulls from texture to annotation.
- Wipe/reveal animations based on scanning, page turns, or magnification.
- Small mechanical ticks for indexes, timestamps, and frame selection.

Avoid:

- Bouncy UI motion.
- Fast carousel behavior.
- Shiny particle explosions.
- Generic AI loading spinners.

The `5` motif from the promo can become a product pattern: multiple evidence
types assemble into one answer. In VidLens terms, transcript, comments, frames,
OCR, visual matches, and source metadata can converge into a single synthesis.

## Components

### Source Plate

A compact source summary with:

- Source platform and URL.
- Video duration, frame count, and capture time.
- Availability or ingestion status.
- Primary thumbnail or contact sheet.

Visual style: museum label plus technical receipt.

### Specimen Frame Grid

A square thumbnail grid for extracted frames. Each frame has:

- Timestamp.
- Source type, such as `frame`, `OCR`, `visual match`, or `transcript`.
- A small confidence or relevance marker.

Interaction:

- Hover reveals annotations.
- Click opens an inspection drawer.
- Selected frames get a thin ink outline, not a glowing border.

### Field Note

A text block for model synthesis.

Style:

- Slightly warmer paper background.
- Serif heading.
- Sans body text.
- Inline citations as small stamped labels.

### Provenance Ledger

A dense table-like list showing:

- Tool name.
- Query or operation.
- Timestamp.
- Result status.
- File path or source reference.

Use mono text and compact spacing. It should feel operational and trustworthy.

### Mythos Mark

If a branded symbol is needed, use a constructed numeral or glyph made from
evidence fragments:

- Thumbnails.
- Map lines.
- OCR snippets.
- Transcript segments.
- Pins and constellation points.

Do not copy Claude's logo or brand mark. Treat the promo as visual inspiration,
not as an asset license.

## Recommended Hero Direction

Hero composition:

- Background: animated or static archival plate collage.
- Foreground: one quiet serif title.
- Secondary line: short product promise.
- Bottom edge: visible hint of the evidence grid below the fold.

Example copy for a VidLens-flavored page:

```text
VidLens
Turn video into evidence you can inspect.
```

Example source-specific page copy:

```text
Fable 5 Promo Analysis
Twenty seconds of archival motion, indexed frame by frame.
```

Keep copy restrained. Let the visual evidence carry the atmosphere.

## Implementation Notes

- Use real extracted frames where possible instead of generated abstractions.
- Prefer CSS grid backgrounds, paper textures, and actual thumbnail assets.
- Use stable dimensions for frame grids and tool panels to prevent layout shift.
- Keep cards at `8px` radius or less.
- Use thin borders: `1px solid rgba(21, 19, 15, 0.14)`.
- Use soft shadows only when an object is meant to feel like paper on a desk.
- Use `mix-blend-mode: multiply` sparingly for printed/specimen overlays.
- Keep text readable on mobile; do not place small captions over busy images.
- Use icons for actions like inspect, download, copy, search, and expand.

## Accessibility

- Maintain high contrast for operational text and controls.
- Do not rely on color alone for frame status.
- Provide text labels for all icon buttons.
- Respect reduced-motion preferences by replacing drifting/parallax motion with
  still frame transitions.
- Ensure contact sheets and frame grids have useful alt text or captions.

## Design Principles To Preserve

1. Evidence first: every beautiful element should point back to a source,
   frame, timestamp, or artifact.
2. Archival calm: keep the interface quiet enough for inspection and repeated
   use.
3. Mythic precision: blend wonder with exact provenance.
4. Transformation: show scattered media becoming a structured answer.
5. Material texture: paper, ink, maps, botanical plates, and grids beat glossy
   AI abstraction.

### Evidence copy priority

For any future evidence presentation, prefer the match-specific explanation
over the generic frame description (`explanation || description`). This was
the one functional improvement worth retaining from the discarded viewer
redesign. It is a presentation rule, not a reason to restore an embedded
viewer or host resource reads.

## Build Checklist

- [ ] Use the exact source spelling `Fable 5` if referencing the promo.
- [ ] Include the source URL in any analysis/demo surface.
- [ ] Use real frame thumbnails or a contact sheet from the video.
- [ ] Keep the first viewport focused on the product/source, not a marketing
      explanation.
- [ ] Preserve a visible path from source video to extracted evidence to final
      synthesis.
- [ ] Test desktop and mobile layouts for text overlap and frame-grid stability.
- [ ] Provide a reduced-motion mode for archival drift and parallax effects.
