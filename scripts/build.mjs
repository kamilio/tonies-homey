import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import definitions from "../lib/definitions.js";

export async function build() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const vendor = JSON.parse(await readFile(join(root, "vendor/sdk.json"), "utf8"));
  const archive = await readFile(join(root, "vendor", vendor.archive));
  assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, vendor.integrity, "Vendored SDK differs from the pinned source revision");
  const { actions, triggers, conditions, capabilities, deviceCapabilities, flowCard } = definitions;
  const login = { id: "login_credentials", template: "login_credentials" };
  const images = { small: "/assets/images/small.png", large: "/assets/images/large.png", xlarge: "/assets/images/xlarge.png" };
  const manifest = {
    id: "com.kjopek.tonies", version: "0.1.0", compatibility: ">=12.9.0", sdk: 3,
    runtime: "nodejs", platforms: ["local"], brandColor: "#6049AD",
    name: { en: "Toniebox 2" }, description: { en: "Night mode, playback controls, and listening automations for Toniebox 2." },
    author: { name: "Kamil Jopek", email: "kjopek@users.noreply.github.com" },
    category: ["music"], permissions: [], images,
    capabilities,
    flow: { actions: actions.map(flowCard), triggers: triggers.map(flowCard), conditions: conditions.map(flowCard) },
    drivers: [{
      id: "toniebox2", name: { en: "Toniebox 2" }, class: "speaker", platforms: ["local"], connectivity: ["cloud"],
      capabilities: deviceCapabilities, images, icon: "/assets/icon.svg",
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
  const paths = icon.replace(/^.*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  for (const [size, width, height] of [["small", 250, 175], ["large", 500, 350], ["xlarge", 1000, 700]]) {
    const image = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 700"><rect width="1000" height="700" fill="#17142c"/><circle cx="780" cy="90" r="210" fill="#302350"/><circle cx="90" cy="650" r="300" fill="#262246"/><g transform="translate(325 125) scale(3.5)" fill="#bcaaff">${paths}</g><text x="500" y="565" text-anchor="middle" font-family="sans-serif" font-size="54" font-weight="700" fill="#ffffff">Toniebox 2</text><text x="500" y="620" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#cdc5e9">Listening. Night lights. Homey.</text></svg>`;
    await writeFile(join(root, `assets/images/${size}.png`), new Resvg(image).render().asPng());
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await build();
