"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const root = join(__dirname, "..");

test("store manifest uses the brand name, public support links, and distinct product imagery", async () => {
  const manifest = JSON.parse(await readFile(join(root, "app.json"), "utf8"));
  assert.equal(manifest.name.en, "Tonies");
  assert.equal(manifest.drivers[0].name.en, "Toniebox 2");
  assert.equal(manifest.source, "https://github.com/kamilio/tonies-homey");
  assert.equal(manifest.bugs.url, manifest.support);
  for (const [size, width, height] of [["small", 250, 175], ["large", 500, 350], ["xlarge", 1000, 700]]) {
    const metadata = await sharp(join(root, manifest.images[size])).metadata();
    assert.deepEqual([metadata.width, metadata.height], [width, height]);
    assert.equal(metadata.hasAlpha, false);
  }
  for (const [size, pixels] of [["small", 75], ["large", 500], ["xlarge", 1000]]) {
    const metadata = await sharp(join(root, manifest.drivers[0].images[size])).metadata();
    assert.deepEqual([metadata.width, metadata.height], [pixels, pixels]);
    const corner = await sharp(join(root, manifest.drivers[0].images[size])).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert([...corner].every(channel => channel >= 245), "Driver images need a white background");
  }
  assert.notDeepEqual(manifest.images, manifest.drivers[0].images);
});

test("brand and device icons use separate visible monochrome vectors", async () => {
  const icons = await Promise.all(["assets/icon.svg", "drivers/toniebox2/assets/icon.svg"].map(path => readFile(join(root, path), "utf8")));
  assert.notEqual(icons[0], icons[1]);
  for (const icon of icons) {
    assert.match(icon, /viewBox="0 0 960 960"/);
    assert.doesNotMatch(icon, /<(?:image|script|foreignObject)\b/);
    const pixels = await sharp(Buffer.from(icon)).resize(96, 96).ensureAlpha().raw().toBuffer();
    let visible = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] < 128) continue;
      visible++;
      assert.equal(pixels[offset], pixels[offset + 1]);
      assert.equal(pixels[offset + 1], pixels[offset + 2]);
    }
    assert(visible > 400 && visible < 8500, `Unexpected icon coverage: ${visible}`);
  }
});

test("store text is concise plain text and Flow titles omit the device name", async () => {
  const listing = await readFile(join(root, "README.txt"), "utf8");
  assert.equal(listing.trim().split(/\n\s*\n/).length, 2);
  assert(listing.length < 1500);
  assert.match(listing, /Toniebox 2 only/);
  assert.match(listing, /not stored/);
  assert.doesNotMatch(listing, /https?:\/\/|^#|\*\*/m);
  const manifest = JSON.parse(await readFile(join(root, "app.json"), "utf8"));
  for (const group of Object.values(manifest.flow)) for (const card of group) assert.doesNotMatch(card.title.en, /Toniebox|[()]/);
});
