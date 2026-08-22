import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tools } from "../server/mcp-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const agentSkillPath = join(root, ".agents", "skills", "vidlens-workflows", "SKILL.md");
const pluginSkillPath = join(root, "plugins", "vidlens", "skills", "vidlens-workflows", "SKILL.md");

function presentationSection(text: string): string {
  const match = text.match(/## Presentation contract\n([\s\S]*?)(?=\n## |$)/);
  assert.ok(match, "presentation contract section should exist");
  return match[0];
}

test("shared workflow skills carry the same outcome-level presentation contract", () => {
  const agentSkill = readFileSync(agentSkillPath, "utf8");
  const pluginSkill = readFileSync(pluginSkillPath, "utf8");
  const contract = presentationSection(agentSkill);

  assert.equal(contract, presentationSection(pluginSkill));
  assert.match(contract, /every completed user-facing VidLens analysis/i);
  assert.match(contract, /one video, several videos, or a larger collection/i);
  assert.match(contract, /item-count threshold/i);
  assert.match(contract, /polished Markdown foundation/i);

  for (const forbidden of ["visualize", "/dataviz", "show_widget", "renderVideoEvidence", "Evidence Atlas"]) {
    assert.ok(!contract.includes(forbidden), `shared contract must not name ${forbidden}`);
  }
});

test("MCP presentation guidance stays portable and evidence preserving", () => {
  const descriptions = tools.map((tool) => tool.description ?? "").join("\n");
  assert.doesNotMatch(descriptions, /ALWAYS create visual|infographic|show_widget|\/dataviz/i);

  const explore = tools.find((tool) => tool.name === "exploreYouTube");
  assert.ok(explore, "exploreYouTube tool should exist");
  assert.match(explore.description ?? "", /portable structured evidence/i);
  assert.match(explore.description ?? "", /sample sizes, freshness, provenance, source links/i);
});
