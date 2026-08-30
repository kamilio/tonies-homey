import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { build as bundle } from "esbuild";
import definitions from "../lib/definitions.js";

export async function build() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifestSource = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const sdkSource = manifestSource.devDependencies["@kamils-jamco/tonies-sdk"];
  assert.match(sdkSource, /^git\+https:\/\/github\.com\/kamilio\/tonies-sdk\.git#[a-f0-9]{40}$/, "SDK must use a commit-pinned public GitHub URL");
  assert.equal(lock.packages["node_modules/@kamils-jamco/tonies-sdk"].resolved, sdkSource, "SDK lockfile must match the pinned GitHub source");
  const runtime = await bundle({
    absWorkingDir: root,
    stdin: {
      contents: 'export { TonieCloudClient, isToniebox2 } from "@kamils-jamco/tonies-sdk/cloud"; export { ToniesRealtime, isPlaying } from "@kamils-jamco/tonies-sdk/realtime";',
      resolveDir: root,
      sourcefile: "tonies-sdk-entry.js"
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["mqtt"],
    legalComments: "none",
    minifyWhitespace: true,
    metafile: true,
    write: false
  });
  assert.deepEqual(Object.keys(runtime.metafile.inputs).sort(), [
    "node_modules/@kamils-jamco/tonies-sdk/dist/cloud.js",
    "node_modules/@kamils-jamco/tonies-sdk/dist/realtime.js",
    "tonies-sdk-entry.js"
  ], "Homey must bundle only the SDK cloud and realtime modules");
  await writeFile(join(root, "lib/tonies-sdk.js"), runtime.outputFiles[0].contents);
  const { actions, triggers, conditions, capabilities, deviceCapabilities, flowCard } = definitions;
  const login = { id: "login_credentials", template: "login_credentials" };
  const images = { small: "/assets/images/small.png", large: "/assets/images/large.png", xlarge: "/assets/images/xlarge.png" };
  const manifest = {
    id: "com.kjopek.tonies", version: manifestSource.version, compatibility: ">=12.9.0", sdk: 3,
    runtime: "nodejs", platforms: ["local"], brandColor: "#6049AD",
    name: { en: "Toniebox 2" }, description: { en: "Night mode, playback controls, and listening automations for Toniebox 2." },
    author: { name: "Kamil Jopek", email: "kjopek@users.noreply.github.com" },
    category: ["music"], permissions: [], images,
    capabilities,
    flow: { actions: actions.map(flowCard), triggers: triggers.map(flowCard), conditions: conditions.map(flowCard) },
    drivers: [{
      id: "toniebox2", name: { en: "Toniebox 2" }, class: "speaker", platforms: ["local"], connectivity: ["cloud"],
      capabilities: deviceCapabilities, images, icon: "/drivers/toniebox2/assets/icon.svg",
      pair: [login, { id: "list_devices", template: "list_devices", navigation: { prev: "login_credentials", next: "add_devices" } }, { id: "add_devices", template: "add_devices" }],
      repair: [login],
      settings: [
        { id: "night_minutes", type: "number", label: { en: "Default night mode duration (minutes)" }, value: 30, min: 1, max: 720 },
        { id: "firmware", type: "label", label: { en: "Firmware" }, value: "Unknown" },
        { id: "box_id", type: "label", label: { en: "Toniebox ID" }, value: "" }
      ]
    }]
  };
  await writeFile(join(root, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(root, "assets/images"), { recursive: true });
  const icon = await readFile(join(root, "assets/icon.svg"), "utf8");
  await mkdir(join(root, "drivers/toniebox2/assets"), { recursive: true });
  await writeFile(join(root, "drivers/toniebox2/assets/icon.svg"), icon);
  const paths = icon.replace(/^.*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  for (const [size, width, height] of [["small", 250, 175], ["large", 500, 350], ["xlarge", 1000, 700]]) {
    const image = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 700"><rect width="1000" height="700" fill="#17142c"/><circle cx="780" cy="90" r="210" fill="#302350"/><circle cx="90" cy="650" r="300" fill="#262246"/><g transform="translate(325 125) scale(3.5)" fill="#bcaaff">${paths}</g><text x="500" y="565" text-anchor="middle" font-family="sans-serif" font-size="54" font-weight="700" fill="#ffffff">Toniebox 2</text><text x="500" y="620" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#cdc5e9">Listening. Night lights. Homey.</text></svg>`;
    await writeFile(join(root, `assets/images/${size}.png`), new Resvg(image).render().asPng());
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await build();
