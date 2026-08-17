# X article draft — "Your AI can read the web. Now it can also watch it."

Status: **draft, not published.** Cover image: `../assets/cover-endcard-16x9.png`.
Every claim below is checked against the shipped code and the script's
"say it like this / not like this" table. Safe to publish as written.

---

## Title

**Your AI can read the web. Now it can also watch it.**

Subtitle option: *VidLens V2 — what 3.8 million views taught us to build next.*

---

## Body

The VidLens launch video did 3.8 million views. The comments were kind, and they
were consistent. Two complaints came back over and over:

*"Love it — but I don't just live on YouTube."*

*"Love it — but I'm not always at my desk."*

Fair. Version 2 fixes both. Four upgrades.

### 1. It runs everywhere now

VidLens is no longer Claude-only. One setup command:

```
npx vidlens-mcp setup
```

That puts VidLens in Claude Desktop, Claude Code, and Codex. Same tools,
wherever you work.

### 2. You can trigger it from your phone

With Claude Dispatch, you ask from your phone. Your Mac runs VidLens in the
background. The answer lands back in your pocket. Claude Code remote works the
same way.

To be precise: the heavy lifting happens on your machine, not your phone. Your
Mac has to be awake with Claude Desktop open. The phone is the trigger and the
inbox.

### 3. It goes beyond YouTube

This is the big one. Point VidLens at TikTok, Instagram, X, Threads, Pinterest,
or Reddit and ask:

> Find the top trending TikToks about AI tools from the last 30 days, ranked by
> engagement.

It returns the actual top posts, with real engagement numbers — not whatever an
algorithm feels like showing you. The default window is the last 30 days.

Social search is powered by the ScrapeCreators API — the thing that made
"analyze any platform, not just YouTube" finally click. `SCRAPECREATORS_API_KEY`
is an optional key, like the YouTube and Gemini keys.

### 4. It can analyze any of them

Import the top result and VidLens reads what is on screen and what is said —
visual frames plus speech-to-text. You see what makes a viral video work
without watching a single one.

Everything it ingests — transcripts, frames, embeddings — lives in a local
library on your own disk, and your agent can search it.

### That's VidLens 2

Free. Open source, MIT. Set up in 30 seconds:

```
npx vidlens-mcp setup
```

github.com/thatsrajan/vidlens-mcp

---

## Editor notes (delete before publishing)

- **Do not say** "runs on my phone" — it runs on your Mac; the phone triggers it.
- **Do not say** "TikTok comment sentiment" — comment analysis is YouTube-only.
- **Do not imply** social search works with zero keys — it needs the
  ScrapeCreators key configured.
- The GitHub link renders as a plain-text line on purpose; X articles allow
  links, so make it a real link at publish time.
- If the article goes out while the product page still says "coming soon",
  swap the closing section's install framing to match.
