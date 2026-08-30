import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function smoke() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const built = join(root, ".homeybuild");
  const manifest = JSON.parse(await readFile(join(built, "app.json"), "utf8"));
  assert.equal(manifest.drivers.length, 1);
  assert.equal(manifest.drivers[0].id, "toniebox2");
  assert(manifest.flow.actions.some(action => action.id === "night_mode_on"));
  assert(manifest.flow.triggers.some(trigger => trigger.id === "playback_started"));
  const require = createRequire(join(built, "app.js"));
  const sdkRoot = join(built, "node_modules/@kamils-jamco/tonies-sdk");
  const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
  const cloudPath = join(sdkRoot, sdkPackage.exports["./cloud"].import);
  const realtimePath = join(sdkRoot, sdkPackage.exports["./realtime"].import);
  assert(cloudPath.startsWith(built), "SDK must be shipped inside the Homey build");
  assert(realtimePath.startsWith(built), "Realtime SDK must be shipped inside the Homey build");
  const { TonieCloudClient } = await import(pathToFileURL(cloudPath).href);
  const { ToniesRealtime } = await import(pathToFileURL(realtimePath).href);
  assert.equal(typeof new ToniesRealtime(new TonieCloudClient()).sleepTimer, "function");
  for (const image of Object.values(manifest.images)) await access(join(built, image));
  assert(!Object.keys(require.cache).some(path => path.includes("classic-level")), "Homey must not load desktop browser-storage modules");
  console.log("Built Homey app resolves its own SDK, realtime controls, driver, flows, and artwork.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await smoke();
