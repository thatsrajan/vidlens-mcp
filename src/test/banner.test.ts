import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBanner, resolveBannerColorMode } from "../lib/banner.js";

describe("lens-v3 terminal banner", () => {
  it("keeps the locked copy and quiet layout under 12 rows", () => {
    const output = renderBanner({ version: "1.5.0", color: false });
    const rows = output.split("\n").filter((line) => line.length > 0);

    assert.ok(rows.length < 12);
    assert.match(output, /VidLens v1\.5\.0/);
    assert.match(output, /Your AI can read the web\./);
    assert.match(output, /Now it can also watch it\./);
    assert.match(output, /FREE · OPEN SOURCE · MIT/);
    assert.match(output, /◀  ◇  ▶/);
    assert.doesNotMatch(output, /\x1b\[/);
  });

  it("uses the specified truecolor inks without background fills", () => {
    const output = renderBanner({ colorMode: "truecolor" });

    assert.match(output, /\x1b\[38;2;4;79;103m/);
    assert.match(output, /\x1b\[38;2;196;169;135m/);
    assert.doesNotMatch(output, /\x1b\[48;/);
  });

  it("uses the specified 256-color fallbacks", () => {
    const output = renderBanner({ colorMode: "ansi256" });

    assert.match(output, /\x1b\[38;5;30m/);
    assert.match(output, /\x1b\[38;5;180m/);
    assert.doesNotMatch(output, /\x1b\[48;/);
  });

  it("is identical on light and dark terminal backgrounds", () => {
    const light = renderBanner({ env: { COLORTERM: "truecolor", COLORFGBG: "0;15" } });
    const dark = renderBanner({ env: { COLORTERM: "truecolor", COLORFGBG: "15;0" } });

    assert.equal(light, dark);
  });

  it("detects truecolor, falls back to ANSI 256, and respects NO_COLOR", () => {
    assert.equal(resolveBannerColorMode({ env: { COLORTERM: "truecolor", TERM: "dumb" } }), "truecolor");
    assert.equal(resolveBannerColorMode({ env: { TERM: "xterm-256color" } }), "ansi256");
    assert.equal(resolveBannerColorMode({ env: { NO_COLOR: "1" } }), "none");
  });
});
