import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";
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
  const login = {
    id: "login_credentials", template: "login_credentials",
    options: {
      title: { en: "Sign in to your Tonies account" },
      usernameLabel: { en: "Tonies email address" },
      usernamePlaceholder: { en: "you@example.com" },
      passwordLabel: { en: "Tonies password" },
      passwordPlaceholder: { en: "Password used in the Tonies app" }
    }
  };
  const images = { small: "/assets/images/small.jpg", large: "/assets/images/large.jpg", xlarge: "/assets/images/xlarge.jpg" };
  const driverImages = { small: "/drivers/toniebox2/assets/images/small.jpg", large: "/drivers/toniebox2/assets/images/large.jpg", xlarge: "/drivers/toniebox2/assets/images/xlarge.jpg" };
  const manifest = {
    id: "com.kjopek.tonies", version: manifestSource.version, compatibility: ">=12.9.0", sdk: 3,
    runtime: "nodejs", platforms: ["local"], brandColor: "#D2000F",
    name: { en: "Tonies" }, description: { en: "Little stories, gentler bedtimes" },
    author: { name: "Kamil Jopek", email: "kjopek@users.noreply.github.com" },
    category: ["music"], permissions: [], images,
    tags: { en: ["Toniebox 2", "bedtime", "night light", "audio", "stories"] },
    source: "https://github.com/kamilio/tonies-homey",
    homepage: "https://github.com/kamilio/tonies-homey#readme",
    bugs: { url: "https://github.com/kamilio/tonies-homey/issues" },
    support: "https://github.com/kamilio/tonies-homey/issues",
    capabilities,
    flow: { actions: actions.map(flowCard), triggers: triggers.map(flowCard), conditions: conditions.map(flowCard) },
    drivers: [{
      id: "toniebox2", name: { en: "Toniebox 2" }, class: "speaker", platforms: ["local"], connectivity: ["cloud"],
      capabilities: deviceCapabilities, images: driverImages, icon: "/drivers/toniebox2/assets/icon.svg",
      energy: { batteries: ["INTERNAL"] },
      pair: [login, { id: "list_devices", template: "list_devices", navigation: { prev: "login_credentials", next: "add_devices" } }, { id: "add_devices", template: "add_devices" }],
      repair: [{ ...login, options: { ...login.options, title: { en: "Reconnect your Tonies account" } } }],
      settings: [
        { id: "night_minutes", type: "number", label: { en: "Default night mode duration (minutes)" }, value: 30, min: 1, max: 720 },
        { id: "firmware", type: "label", label: { en: "Firmware" }, value: "Unknown" },
        { id: "box_id", type: "label", label: { en: "Toniebox ID" }, value: "" }
      ]
    }]
  };
  await writeFile(join(root, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(root, "assets/images"), { recursive: true });
  await mkdir(join(root, "drivers/toniebox2/assets/images"), { recursive: true });
  for (const [size, width, height] of [["small", 250, 175], ["large", 500, 350], ["xlarge", 1000, 700]]) {
    await sharp(join(root, "assets/source/toniebox2-lifestyle.png")).resize(width, height, { fit: "cover" }).jpeg({ quality: 88, mozjpeg: true }).toFile(join(root, images[size]));
  }
  for (const [size, pixels] of [["small", 75], ["large", 500], ["xlarge", 1000]]) {
    await sharp(join(root, "assets/source/toniebox2-product.png")).resize(pixels, pixels, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).jpeg({ quality: 90, mozjpeg: true }).toFile(join(root, driverImages[size]));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await build();
