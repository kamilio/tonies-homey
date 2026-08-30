"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const definitions = require("../lib/definitions");

function load(file) {
  const path = join(__dirname, "..", file);
  const module = { exports: {} };
  const homey = { App: class {}, Driver: class {}, Device: class {} };
  vm.runInNewContext(readFileSync(path, "utf8"), { module, require: name => name === "homey" ? homey : createRequire(path)(name), console, setTimeout }, { filename: path });
  return module.exports;
}

const App = load("app.js");
const Device = load("drivers/toniebox2/device.js");
const Driver = load("drivers/toniebox2/driver.js");
const box = { id: "TB2", householdId: "household", product: "tb2", generation: "tng", name: "Bedroom", features: ["playbackControls", "sleepTimerAlarm"], lightringBrightness: 30 };

async function fixture() {
  const values = new Map();
  const listeners = new Map();
  const triggers = [];
  const controls = [];
  const timers = new Set();
  const realtime = new EventEmitter();
  realtime.states = new Map();
  realtime.waitForState = async () => ({});
  for (const method of ["play", "pause", "skip", "changeVolume", "setVolume", "sleepTimer", "seek", "sleep"]) realtime[method] = async (...args) => { controls.push({ method, args }); return { acknowledged: true, deviceConfirmed: false }; };
  const account = { realtime, boxes: [box], devices: new Set(), cloud: {
    getToniebox: async () => box,
    playbackInfo: async () => ({ title: "Story", chapters: [{ title: "First" }, { title: "Second" }] }),
    setTonieboxSettings: async (...args) => { controls.push({ method: "settings", args }); }
  } };
  const device = new Device();
  const sdk = await import("@kamils-jamco/tonies-sdk/realtime");
  device.homey = {
    app: { getAccount: async () => account, sdk: async () => sdk, releaseAccount: async () => { account.devices.delete(device); } },
    setInterval: callback => { timers.add(callback); return callback; },
    clearInterval: callback => timers.delete(callback),
    settings: { unset: () => {} },
    flow: { getDeviceTriggerCard: id => ({ trigger: async (_, tokens) => { triggers.push({ id, tokens }); } }) }
  };
  device.getData = () => ({ id: box.id });
  device.getStoreValue = () => "account";
  device.getSetting = () => 30;
  device.getCapabilityValue = name => values.get(name);
  device.setCapabilityValue = async (name, value) => values.set(name, value);
  device.setSettings = async () => {};
  device.setAvailable = async () => { device.available = true; };
  device.setUnavailable = async message => { device.available = false; device.unavailableMessage = message; };
  device.registerCapabilityListener = (name, listener) => listeners.set(name, listener);
  await device.onInit();
  const send = async (topic, state, previous = {}, retained = false) => device.updateState({ topic, state, previous, retained, boxId: box.id });
  return { device, account, values, listeners, triggers, controls, timers, send };
}

test("every advertised action maps to an implemented device method", () => {
  for (const action of definitions.actions) assert.equal(typeof Device.prototype[action.method], "function", action.id);
  for (const group of [definitions.actions, definitions.triggers, definitions.conditions]) assert.equal(new Set(group.map(card => card.id)).size, group.length);
  assert(definitions.deviceCapabilities.includes("night_mode"));
});

test("app registers every action and condition and dispatches to the selected device", async () => {
  const app = new App();
  const registered = new Map();
  app.homey = { flow: {
    getActionCard: id => ({ registerRunListener: listener => registered.set(`action:${id}`, listener) }),
    getConditionCard: id => ({ registerRunListener: listener => registered.set(`condition:${id}`, listener) })
  } };
  await app.onInit();
  let minutes;
  assert.equal(await registered.get("action:night_mode_on")({ device: { nightModeOn: args => { minutes = args.minutes; } }, minutes: 45 }), true);
  assert.equal(minutes, 45);
  assert.equal(await registered.get("condition:is_online")({ device: { getCapabilityValue: () => false } }), false);
  assert.equal(registered.size, definitions.actions.length + definitions.conditions.length);
});

test("pairing creates only discovered Toniebox devices and stores no plaintext password", async () => {
  const driver = new Driver();
  const handlers = new Map();
  driver.homey = { app: { signIn: async () => ({ accountId: "account", boxes: [box] }) } };
  await driver.onPair({ setHandler: (name, handler) => handlers.set(name, handler) });
  await assert.rejects(handlers.get("list_devices")());
  await handlers.get("login")({ username: "test@example.com", password: "private" });
  const listed = await handlers.get("list_devices")();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].data.id, box.id);
  assert.equal(listed[0].store.accountId, "account");
  assert(!JSON.stringify(listed).includes("private"));
  await handlers.get("disconnect")();
  await assert.rejects(handlers.get("list_devices")());
});

test("account connection sharing deduplicates logins and releases failed initialization", async () => {
  const app = new App();
  app.accounts = new Map();
  app.connecting = new Map();
  let calls = 0;
  const account = {};
  app.createAccount = async () => { calls++; return account; };
  const results = await Promise.all([app.getAccount("account"), app.getAccount("account")]);
  assert.equal(calls, 1);
  assert.equal(results[0], results[1]);
  assert.equal(app.connecting.size, 0);
  app.createAccount = async () => { throw new Error("offline"); };
  await assert.rejects(app.getAccount("other"), /offline/);
  assert.equal(app.connecting.size, 0);
  assert(!app.accounts.has("other"));
});

test("sign-in filters original boxes and other TNG products before pairing", async () => {
  const app = new App();
  const stored = new Map();
  app.accounts = new Map();
  app.homey = { settings: { set: (key, value) => stored.set(key, value) } };
  const { isToniebox2 } = await import("@kamils-jamco/tonies-sdk/cloud");
  app.sdk = async () => ({ isToniebox2, TonieCloudClient: class {
    auth = { accessToken: "access", refreshToken: "refresh" };
    async login() {}
    async request() { return { uuid: "account" }; }
    async listTonieboxes() { return [box, { ...box, id: "LITE", product: "tbl" }, { ...box, id: "OLD", generation: "classic" }]; }
  } });
  const account = await app.signIn("user", "password");
  assert.equal(account.boxes.length, 1);
  assert.equal(account.boxes[0].id, "TB2");
  assert.equal(stored.get("tonies.auth.account").refreshToken, "refresh");
  assert(!JSON.stringify([...stored.values()]).includes("password"));
});

test("night-mode toggle and Flow controls send native timer commands and reject bad values", async () => {
  const { device, controls, listeners, values } = await fixture();
  await listeners.get("night_mode")(true);
  await listeners.get("night_mode")(false);
  await device.nightModeOn({ minutes: 45 });
  assert.deepEqual(controls.map(row => [row.method, ...row.args]), [
    ["sleepTimer", "TB2", 1800], ["sleepTimer", "TB2", 0], ["sleepTimer", "TB2", 2700]
  ]);
  assert.equal(values.get("night_mode"), undefined);
  assert.throws(() => device.nightModeOn({ minutes: 0 }));
  assert.throws(() => device.nightModeOn({ minutes: NaN }));
  await device.onUninit();
});

test("volume and chapters convert Homey units without confusing limits with playback", async () => {
  const { device, controls } = await fixture();
  await device.setVolume({ percent: 50 });
  await device.seek({ chapter: 2, seconds: 1.5 });
  await device.setVolumeLimit({ percent: "50" });
  await device.setNightLight({ color: "#FF8800", brightness: 0 });
  assert.deepEqual(controls[0], { method: "setVolume", args: ["TB2", 7] });
  assert.deepEqual(controls[1], { method: "seek", args: ["TB2", 1, 1500] });
  assert.equal(controls[2].args[2].maxVolume, 50);
  assert.equal(controls[3].args[2].bedtimeLightringColor, "#ff8800");
  assert.equal(controls[3].args[2].bedtimeLightringBrightness, 0);
  assert.throws(() => device.setVolume({ percent: 101 }));
  assert.throws(() => device.seek({ chapter: 0 }));
  await device.onUninit();
});

test("retained snapshots update UI without triggering flows; real starts trigger once", async () => {
  const { device, send, values, triggers } = await fixture();
  const paused = { onlineState: "connected", playback: { tonie: "TONIE", chapter: 0, paused: true, ended: false } };
  await send("playback/state", paused, {}, true);
  assert.equal(values.get("speaker_playing"), false);
  assert.equal(values.get("speaker_track"), "First");
  assert.equal(triggers.length, 0);
  const playing = { ...paused, playback: { ...paused.playback, paused: false } };
  await send("playback/state", playing, paused);
  await send("playback/state", playing, playing);
  assert.equal(values.get("speaker_playing"), true);
  assert.equal(triggers.filter(event => event.id === "playback_started").length, 1);
  assert.equal(triggers[0].tokens.chapter, 1);
  assert.equal(triggers[0].tokens.tonie_id, "TONIE");
  await device.onUninit();
});

test("native bedtime replies drive toggle, remaining time, and transitions", async () => {
  const { device, send, values, triggers } = await fixture();
  const off = { onlineState: "connected", bedtime: { stl: { state: "off" } } };
  const on = { ...off, bedtime: { stl: { state: "on", until: Date.now() / 1000 + 1800 } } };
  await send("app-reply/bedtime-state", off, {}, true);
  await send("app-reply/bedtime-state", on, off);
  assert.equal(values.get("night_mode"), true);
  assert(values.get("sleep_timer_remaining") > 29);
  await send("app-reply/bedtime-state", on, on);
  const ended = { ...off, bedtime: { stl: { state: "completed" } } };
  await send("app-reply/bedtime-state", ended, on);
  assert.equal(values.get("night_mode"), false);
  assert.equal(values.get("sleep_timer_remaining"), 0);
  assert.deepEqual(triggers.map(event => event.id), ["night_mode_started", "night_mode_ended", "sleep_timer_completed"]);
  await device.onUninit();
});

test("offline, battery, headphones and cleanup preserve device lifecycle", async () => {
  const { device, send, account, values, timers, triggers } = await fixture();
  const before = { onlineState: "connected", battery: { percent: 30 }, headphones: { connected: [] } };
  await send("metrics/battery", { ...before, battery: { percent: 20 } }, before);
  await send("metrics/headphones", { ...before, headphones: { connected: ["headphones"] } }, before);
  await send("online-state", { ...before, onlineState: "offline" }, before);
  assert.equal(device.available, false);
  assert.equal(values.get("speaker_playing"), false);
  assert(triggers.some(event => event.id === "battery_low"));
  assert(triggers.some(event => event.id === "headphones_changed"));
  assert(triggers.some(event => event.id === "box_offline"));
  assert.equal(timers.size, 2);
  await device.onUninit();
  assert.equal(timers.size, 0);
  assert.equal(account.realtime.listenerCount("state"), 0);
  assert.equal(account.devices.size, 0);
});
