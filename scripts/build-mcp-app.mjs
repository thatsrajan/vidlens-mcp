import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(root, "web", "video-evidence-viewer.html");
const entryPoint = join(root, "web", "video-evidence-viewer.ts");
const outputDir = join(root, "dist", "ui");
const outputPath = join(outputDir, "video-evidence-viewer.html");
const marker = "/*__VIDLENS_APP_BUNDLE__*/";

const [template, bundle] = await Promise.all([
  readFile(templatePath, "utf8"),
  build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
  }),
]);

if (!template.includes(marker)) {
  throw new Error(`Missing ${marker} in ${templatePath}`);
}
const javascript = bundle.outputFiles[0].text.replaceAll("</script>", "<\\/script>");
await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, template.replace(marker, () => javascript), "utf8");
