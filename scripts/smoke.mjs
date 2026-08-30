import assert from "node:assert/strict";
import { readFile, access, cp, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function smoke() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "tonies-homey-smoke-")));
  try {
    const built = join(temporary, "app");
    await cp(join(root, ".homeybuild"), built, { recursive: true });
    await smokeRuntime(built);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function smokeRuntime(built) {
  const manifest = JSON.parse(await readFile(join(built, "app.json"), "utf8"));
  assert.equal(manifest.drivers.length, 1);
  assert.equal(manifest.drivers[0].id, "toniebox2");
  assert(manifest.flow.actions.some(action => action.id === "night_mode_on"));
  assert(manifest.flow.triggers.some(trigger => trigger.id === "playback_started"));
  const require = createRequire(join(built, "app.js"));
  const { TonieCloudClient, ToniesRealtime, isPlaying, isToniebox2 } = require("./lib/tonies-sdk");
  assert.equal(typeof isPlaying, "function");
  assert.equal(typeof isToniebox2, "function");
  const cloud = new TonieCloudClient();
  const realtime = new ToniesRealtime(cloud);
  for (const method of ["connect", "disconnect", "play", "pause", "seek", "skip", "setVolume", "changeVolume", "sleep", "sleepTimer", "withConfirmation", "withCancellation"]) assert.equal(typeof realtime[method], "function", `Missing realtime SDK method: ${method}`);
  for (const method of ["login", "setAuth", "flushAuth", "listTonieboxes", "getToniebox", "setTonieboxSettings", "playbackInfo"]) assert.equal(typeof cloud[method], "function", `Missing cloud SDK method: ${method}`);
  for (const image of Object.values(manifest.images)) await access(join(built, image));
  for (const dependency of ["@kamils-jamco/tonies-sdk/cloud", "classic-level", "toolcraft", "music-metadata", "esbuild", "yaml"]) {
    assert.throws(() => require.resolve(dependency), { code: "MODULE_NOT_FOUND" }, `Desktop dependency must not be deployed: ${dependency}`);
  }
  assert(!Object.keys(require.cache).some(path => path.includes("classic-level")), "Homey must not load desktop browser-storage modules");
  const outside = Object.keys(require.cache).filter(path => !path.startsWith(`${built}/`));
  assert.equal(outside.length, 0, `Built dependencies must not fall back outside the package: ${outside.join(", ")}`);
  let bytes = 0;
  let files = 0;
  async function measure(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await measure(path);
      else {
        bytes += (await stat(path)).size;
        files++;
      }
    }
  }
  await measure(built);
  assert(bytes < 12 * 1024 * 1024, `Homey deployment exceeds the 12 MiB budget: ${bytes} bytes`);
  console.log(`Built Homey app resolves its cloud-only SDK, controls, flows, and artwork: ${bytes} bytes in ${files} files.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await smoke();
