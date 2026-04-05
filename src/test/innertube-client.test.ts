import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTranscriptXml, InnertubeError } from "../lib/innertube-client.js";

// ── parseTranscriptXml ───────────────────────────────────────────────────────

describe("parseTranscriptXml", () => {
  it("parses basic XML with start and dur attributes", () => {
    const xml = `<transcript>
      <text start="0" dur="3.2">Hello world</text>
      <text start="3.2" dur="2.5">Second segment</text>
    </transcript>`;
    const segments = parseTranscriptXml(xml);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments[0], { tStartSec: 0, tEndSec: 3.2, text: "Hello world" });
    assert.deepEqual(segments[1], { tStartSec: 3.2, tEndSec: 5.7, text: "Second segment" });
  });

  it("decodes HTML entities in text", () => {
    const xml = `<transcript>
      <text start="0" dur="1">rock &amp; roll</text>
      <text start="1" dur="1">it&#39;s fine</text>
      <text start="2" dur="1">&#x27;quoted&#x27;</text>
      <text start="3" dur="1">&lt;tag&gt;</text>
      <text start="4" dur="1">&quot;hello&quot;</text>
      <text start="5" dur="1">&apos;apos&apos;</text>
    </transcript>`;
    const segments = parseTranscriptXml(xml);
    assert.equal(segments[0].text, "rock & roll");
    assert.equal(segments[1].text, "it's fine");
    assert.equal(segments[2].text, "'quoted'");
    assert.equal(segments[3].text, "<tag>");
    assert.equal(segments[4].text, '"hello"');
    assert.equal(segments[5].text, "'apos'");
  });

  it("strips HTML tags from text", () => {
    const xml = `<transcript>
      <text start="0" dur="1"><b>bold</b> and <i>italic</i></text>
    </transcript>`;
    const segments = parseTranscriptXml(xml);
    assert.equal(segments[0].text, "bold and italic");
  });

  it("skips nodes with empty text", () => {
    const xml = `<transcript>
      <text start="0" dur="1">real text</text>
      <text start="1" dur="1">   </text>
      <text start="2" dur="1"></text>
      <text start="3" dur="1">more text</text>
    </transcript>`;
    const segments = parseTranscriptXml(xml);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].text, "real text");
    assert.equal(segments[1].text, "more text");
  });

  it("leaves tEndSec undefined when dur is missing", () => {
    const xml = `<transcript>
      <text start="5.5">no duration</text>
    </transcript>`;
    const segments = parseTranscriptXml(xml);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].tStartSec, 5.5);
    assert.equal(segments[0].tEndSec, undefined);
    assert.equal(segments[0].text, "no duration");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseTranscriptXml(""), []);
  });

  it("returns empty array for malformed XML", () => {
    assert.deepEqual(parseTranscriptXml("<not-transcript>garbage</not-transcript>"), []);
    assert.deepEqual(parseTranscriptXml("just plain text, no xml at all"), []);
  });

  it("collapses internal whitespace to single spaces", () => {
    const xml = `<transcript>
      <text start="0" dur="1">hello\n  world\t!</text>
    </transcript>`;
    const segments = parseTranscriptXml(xml);
    assert.equal(segments[0].text, "hello world !");
  });
});

// ── InnertubeError ───────────────────────────────────────────────────────────

describe("InnertubeError", () => {
  it("has correct name, message, videoId, code, and retryable", () => {
    const err = new InnertubeError("something broke", "abc123", "NETWORK_ERROR", true);
    assert.equal(err.name, "InnertubeError");
    assert.equal(err.message, "something broke");
    assert.equal(err.videoId, "abc123");
    assert.equal(err.code, "NETWORK_ERROR");
    assert.equal(err.retryable, true);
    assert.ok(err instanceof Error);
  });

  it("defaults retryable to false", () => {
    const err = new InnertubeError("disabled", "xyz", "TRANSCRIPTS_DISABLED");
    assert.equal(err.retryable, false);
  });
});
