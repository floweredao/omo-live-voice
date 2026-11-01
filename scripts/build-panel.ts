import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const dist = "panel/dist";
mkdirSync(`${dist}/worklets`, { recursive: true });

const builds = [
  await Bun.build({ entrypoints: ["panel/app.ts"], outdir: dist, target: "browser" }),
  await Bun.build({
    entrypoints: ["panel/worklets/capture.worklet.ts", "panel/worklets/playback.worklet.ts"],
    outdir: `${dist}/worklets`,
    target: "browser",
  }),
];
for (const b of builds) {
  if (!b.success) {
    for (const l of b.logs) console.error(l);
    process.exit(1);
  }
}

copyFileSync("panel/index.html", `${dist}/index.html`);
copyFileSync("panel/styles.css", `${dist}/styles.css`);

const required = ["index.html", "app.js", "styles.css", "worklets/capture.worklet.js", "worklets/playback.worklet.js"];
const missing = required.filter((f) => !existsSync(`${dist}/${f}`));
if (missing.length) {
  console.error(`build-panel: missing in ${dist}: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`build-panel: ok (${required.length} assets in ${dist})`);
