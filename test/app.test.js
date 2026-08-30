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

function deferred() {
  return Promise.withResolvers();
}

async function fixture(options = {}) {
  const values = new Map();
  const listeners = new Map();
  const triggers = [];
  const controls = [];
  const confirmations = [];
  const timers = new Set();
  const errors = [];
  const realtime = new EventEmitter({ captureRejections: true });
  realtime.on("error", error => errors.push(error));
  realtime.states = new Map();
  realtime.withConfirmation = async (boxId, topic, predicate, operation) => {
    confirmations.push({ boxId, topic, predicate });
    return operation();
  };
  for (const method of ["play", "pause", "skip", "changeVolume", "setVolume", "sleepTimer", "seek", "sleep"]) realtime[method] = async (...args) => { controls.push({ method, args }); return { acknowledged: true, deviceConfirmed: false }; };
  const account = { realtime, boxes: [box], devices: new Set(), cloud: {
    getToniebox: async () => box,
    playbackInfo: async () => ({ title: "Story", chapters: [{ title: "First" }, { title: "Second" }] }),
    setTonieboxSettings: async (...args) => { controls.push({ method: "settings", args }); }
  } };
  const device = new Device();
  const sdk = require("../lib/tonies-sdk");
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
  device.getAvailable = () => device.available;
  device.setCapabilityValue = async (name, value) => values.set(name, value);
  device.setSettings = async () => {};
  device.setAvailable = async () => { device.available = true; };
  device.setUnavailable = async message => { device.available = false; device.unavailableMessage = message; };
  device.registerCapabilityListener = (name, listener) => listeners.set(name, listener);
  if (options.initialize !== false) await device.onInit();
  const emit = (topic, state, previous = {}, retained = false) => {
    realtime.states.set(box.id, state);
    realtime.emit("state", { topic, state, previous, retained, boxId: box.id });
  };
  const send = async (...args) => {
    emit(...args);
    await device.pending;
    await device.metadataPending;
    await device.pending;
  };
  return { device, account, values, listeners, triggers, controls, confirmations, timers, send, emit, errors };
}

test("every advertised action maps to an implemented device method", () => {
  for (const action of definitions.actions) assert.equal(typeof Device.prototype[action.method], "function", action.id);
  for (const group of [definitions.actions, definitions.triggers, definitions.conditions]) assert.equal(new Set(group.map(card => card.id)).size, group.length);
  assert(definitions.deviceCapabilities.includes("night_mode"));
});

test("app reuses its bundled cloud-only SDK without loading desktop modules", async () => {
  const app = new App();
  const sdk = await app.sdk();
  assert.equal(await app.sdk(), sdk);
  assert.deepEqual(Object.keys(sdk).sort(), ["TonieCloudClient", "ToniesRealtime", "isPlaying", "isToniebox2"]);
  assert.equal(typeof sdk.TonieCloudClient.prototype.login, "function");
  assert.equal(typeof sdk.ToniesRealtime.prototype.withConfirmation, "function");
  assert(!Object.keys(require.cache).some(path => path.includes("classic-level")));
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

test("pairing cannot reuse a previous login after a failed replacement", async () => {
  const driver = new Driver();
  const handlers = new Map();
  driver.homey = { app: { signIn: async username => {
    assert.equal(username, "valid");
    return { accountId: username, boxes: [box] };
  } } };
  await driver.onPair({ setHandler: (name, handler) => handlers.set(name, handler) });
  await handlers.get("login")({ username: "valid" });
  await assert.rejects(handlers.get("login")({ username: "invalid" }));
  await assert.rejects(handlers.get("list_devices")(), /Sign in/);
});

test("pairing discards superseded and disconnected login results", async () => {
  const driver = new Driver();
  const handlers = new Map();
  const first = deferred();
  const second = deferred();
  driver.homey = { app: { signIn: username => username === "first" ? first.promise : second.promise } };
  await driver.onPair({ setHandler: (name, handler) => handlers.set(name, handler) });
  const oldLogin = handlers.get("login")({ username: "first" });
  const latestLogin = handlers.get("login")({ username: "second" });
  second.resolve({ accountId: "second", boxes: [box] });
  assert.equal(await latestLogin, true);
  first.resolve({ accountId: "first", boxes: [box] });
  assert.equal(await oldLogin, false);
  assert.equal((await handlers.get("list_devices")())[0].store.accountId, "second");
  await handlers.get("disconnect")();
  assert.equal(await handlers.get("login")({ username: "second" }), false);
  await assert.rejects(handlers.get("list_devices")());
});

test("disconnect during pairing never resurrects a pending account", async () => {
  const driver = new Driver();
  const handlers = new Map();
  const pending = deferred();
  driver.homey = { app: { signIn: () => pending.promise } };
  await driver.onPair({ setHandler: (name, handler) => handlers.set(name, handler) });
  const login = handlers.get("login")({ username: "user" });
  await handlers.get("disconnect")();
  pending.resolve({ accountId: "account", boxes: [box] });
  assert.equal(await login, false);
  await assert.rejects(handlers.get("list_devices")());
});

test("releasing an account cannot lend or delete a closing connection", async () => {
  const app = new App();
  const closing = deferred();
  const device = {};
  const previous = { devices: new Set([device]), cloud: { flushAuth: async () => {} }, realtime: { disconnect: () => closing.promise } };
  const replacement = { devices: new Set(), realtime: {} };
  app.accounts = new Map([["account", previous]]);
  app.connecting = new Map();
  app.createAccount = async () => replacement;
  const release = app.releaseAccount("account", device);
  const next = app.getAccount("account");
  assert.equal(app.accounts.size, 0);
  assert.equal(app.closing.size, 1);
  closing.resolve();
  await release;
  assert.equal(await next, replacement);
  assert.equal(app.closing.size, 0);
  assert.equal(app.accounts.get("account"), replacement);
  await app.releaseAccount("account", device);
  assert.equal(app.accounts.get("account"), replacement);
});

test("repair rejects overlapping logins and ignores disconnect before authentication", async () => {
  const driver = new Driver();
  const handlers = new Map();
  const pending = deferred();
  let uninitializations = 0;
  driver.homey = { app: { signIn: () => pending.promise } };
  const device = { getData: () => box, onUninit: async () => { uninitializations++; } };
  await driver.onRepair({ setHandler: (name, handler) => handlers.set(name, handler) }, device);
  const repair = handlers.get("login")({ username: "user" });
  await assert.rejects(handlers.get("login")({ username: "other" }), /already in progress/);
  await handlers.get("disconnect")();
  pending.resolve({ accountId: "account", boxes: [box] });
  assert.equal(await repair, false);
  assert.equal(uninitializations, 0);
});

test("sign-in filters original boxes and other TNG products before pairing", async () => {
  const app = new App();
  const stored = new Map();
  app.accounts = new Map();
  app.homey = { settings: { set: (key, value) => stored.set(key, value) } };
  const { isToniebox2 } = require("../lib/tonies-sdk");
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

test("repair adopts credentials into an account still connecting", async () => {
  const app = new App();
  const stored = new Map([["tonies.auth.account", { accessToken: "old", refreshToken: "old-refresh" }]]);
  const listing = deferred();
  const started = deferred();
  const device = {};
  let existing;
  app.accounts = new Map();
  app.connecting = new Map();
  app.homey = { settings: { get: key => stored.get(key), set: (key, value) => stored.set(key, value) } };
  app.sdk = async () => ({
    isToniebox2: value => value.product === "tb2",
    TonieCloudClient: class {
      constructor(options = {}) { this.options = options; this.auth = options.auth; if (options.auth) existing = this; }
      async login() { this.auth = { accessToken: "repaired", refreshToken: "repaired-refresh" }; }
      async request() { return { uuid: "account" }; }
      async listTonieboxes() { if (this.options.auth) { started.resolve(); await listing.promise; } return [box]; }
      async setAuth(auth) { this.auth = auth; this.options.onAuth(auth); }
      async flushAuth() {}
    },
    ToniesRealtime: class extends EventEmitter { async connect() {} async disconnect() {} }
  });
  const connecting = app.getAccount("account", device);
  await started.promise;
  await app.signIn("user", "password");
  assert.equal(existing.auth.accessToken, "repaired");
  assert.equal(stored.get("tonies.auth.account").accessToken, "repaired");
  listing.resolve();
  const account = await connecting;
  assert.equal(account.cloud, existing);
  await app.releaseAccount("account", device);
  existing.options.onAuth({ accessToken: "late-old-token" });
  assert.equal(stored.get("tonies.auth.account").accessToken, "repaired");
  assert.equal(app.clients.size, 0);
});

test("account teardown preserves an in-flight refresh before opening its replacement", async () => {
  const app = new App();
  const { TonieCloudClient } = require("../lib/tonies-sdk");
  const stored = new Map([["tonies.auth.account", { accessToken: "old", refreshToken: "old-refresh", expiresAt: Date.now() + 3600000 }]]);
  const response = deferred();
  const device = {};
  const replacementDevice = {};
  let cloudInstances = 0;
  app.accounts = new Map();
  app.connecting = new Map();
  app.homey = { settings: { get: key => stored.get(key), set: (key, value) => stored.set(key, value) } };
  app.sdk = async () => ({
    isToniebox2: value => value.product === "tb2",
    TonieCloudClient: class extends TonieCloudClient {
      constructor(options) { super({ ...options, fetch: () => response.promise }); cloudInstances++; }
      async listTonieboxes() { return [box]; }
    },
    ToniesRealtime: class extends EventEmitter { async connect() {} async disconnect() {} }
  });
  const account = await app.getAccount("account", device);
  const refresh = account.cloud.refresh();
  const released = app.releaseAccount("account", device);
  const replacement = app.getAccount("account", replacementDevice);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cloudInstances, 1);
  response.resolve(Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 300 }));
  await refresh;
  await released;
  const next = await replacement;
  assert.equal(stored.get("tonies.auth.account").refreshToken, "rotated-refresh");
  assert.equal(next.cloud.auth.refreshToken, "rotated-refresh");
  assert.equal(app.clients.size, 1);
  await app.releaseAccount("account", replacementDevice);
  assert.equal(app.clients.size, 0);
});

test("deleting the last device removes credentials after late token persistence", async () => {
  const app = new App();
  const stored = new Map([["tonies.auth.account", { refreshToken: "old-refresh" }]]);
  const pending = deferred();
  const flushing = deferred();
  const device = {};
  const cloud = { flushAuth: async () => { flushing.resolve(); await pending.promise; stored.set("tonies.auth.account", { refreshToken: "rotated" }); } };
  const account = { cloud, devices: new Set([device]), realtime: { disconnect: async () => {} } };
  app.accounts = new Map([["account", account]]);
  app.connecting = new Map();
  app.clients.set("account", cloud);
  app.homey = { settings: { get: key => stored.get(key), unset: key => stored.delete(key) } };
  const released = app.releaseAccount("account", device, true);
  await flushing.promise;
  const replacement = assert.rejects(app.getAccount("account", {}), /Repair/);
  pending.resolve();
  await released;
  await replacement;
  assert.equal(stored.size, 0);
  assert.equal(app.clients.size, 0);
  assert.equal(app.closing.size, 0);
  assert.equal(app.connecting.size, 0);
});

test("failed credential draining releases lifecycle maps and allows a later retry", async () => {
  const app = new App();
  const device = {};
  const cloud = { flushAuth: async () => { throw new Error("credential persistence failed"); } };
  app.clients.set("account", cloud);
  app.accounts = new Map([["account", { cloud, devices: new Set([device]), realtime: { disconnect: async () => { throw new Error("socket close failed"); } } }]]);
  app.connecting = new Map();
  await assert.rejects(app.releaseAccount("account", device), /credential persistence failed/);
  assert.equal(app.clients.size, 0);
  assert.equal(app.accounts.size, 0);
  assert.equal(app.closing.size, 0);
  const replacement = { devices: new Set() };
  app.createAccount = async () => replacement;
  assert.equal(await app.getAccount("account", device), replacement);
});

test("a repair during teardown cannot be overwritten by the closing client's token", async () => {
  const app = new App();
  const stored = new Map();
  const pending = deferred();
  const listing = deferred();
  const device = {};
  const cloud = { flushAuth: async () => { await pending.promise; stored.set("tonies.auth.account", { refreshToken: "rotated-old" }); } };
  app.clients.set("account", cloud);
  app.accounts = new Map([["account", { cloud, devices: new Set([device]), realtime: { disconnect: async () => {} } }]]);
  app.homey = { settings: { set: (key, value) => stored.set(key, value) } };
  app.sdk = async () => ({ isToniebox2: value => value.product === "tb2", TonieCloudClient: class {
    async login() { this.auth = { refreshToken: "repaired" }; }
    async request() { return { uuid: "account" }; }
    async listTonieboxes() { listing.resolve(); return [box]; }
  } });
  const released = app.releaseAccount("account", device);
  const repaired = app.signIn("user", "password");
  await listing.promise;
  assert.equal(stored.size, 0);
  pending.resolve();
  await released;
  await repaired;
  assert.equal(stored.get("tonies.auth.account").refreshToken, "repaired");
  assert.equal(app.clients.size, 0);
  assert.equal(app.closing.size, 0);
});

test("night-mode toggle and Flow controls send native timer commands and reject bad values", async () => {
  const { device, controls, confirmations, listeners, values } = await fixture();
  await listeners.get("night_mode")(true);
  await listeners.get("night_mode")(false);
  await device.nightModeOn({ minutes: 45 });
  assert.deepEqual(controls.map(row => [row.method, ...row.args]), [
    ["sleepTimer", "TB2", 1800], ["sleepTimer", "TB2", 0], ["sleepTimer", "TB2", 2700]
  ]);
  assert.equal(values.get("night_mode"), undefined);
  assert(confirmations.every(item => item.boxId === "TB2" && item.topic === "app-reply/bedtime-state"));
  assert.equal(confirmations[0].predicate({ bedtime: { stl: { state: "on", duration: 1800 } } }), true);
  assert.equal(confirmations[0].predicate({ bedtime: { stl: { state: "on", duration: 300 } } }), false);
  assert.equal(confirmations[0].predicate({ bedtime: { stl: { state: "on" } } }), false);
  assert.equal(confirmations[2].predicate({ bedtime: { stl: { state: "on", duration: 2700 } } }), true);
  assert.equal(confirmations[1].predicate({ bedtime: { stl: { state: "on" } } }), false);
  assert.equal(confirmations[1].predicate({ bedtime: { stl: { state: "off" } } }), true);
  assert.throws(() => device.nightModeOn({ minutes: 0 }));
  assert.throws(() => device.nightModeOn({ minutes: NaN }));
  await device.onUninit();
});

test("bundled SDK confirms Homey night duration and cancels interrupted or timed-out controls", async context => {
  const { device, account, values, errors } = await fixture({ initialize: false });
  const { TonieCloudClient, ToniesRealtime } = require("../lib/tonies-sdk");
  const cloud = new TonieCloudClient({
    auth: { accessToken: "test-token", expiresAt: Date.now() + 3600000 },
    fetch: async () => Response.json({ uuid: "test-account" })
  });
  const socket = new EventEmitter();
  socket.connected = true;
  socket.published = [];
  socket.subscribeAsync = async () => {};
  socket.publishAsync = async (topic, payload) => { socket.published.push({ topic, payload: JSON.parse(payload) }); };
  socket.getLastMessageId = () => socket.published.length;
  socket.removeOutgoingMessage = () => {};
  socket.endAsync = async () => {};
  const realtime = new ToniesRealtime(cloud, { connect: async (url, options) => { socket.options = options; return socket; } });
  realtime.on("error", error => errors.push(error));
  account.realtime = realtime;
  context.after(() => device.onUninit());
  context.after(() => realtime.disconnect());
  await realtime.connect([{ ...box, macAddress: "aabbccddeeff" }]);
  const send = (topic, payload, retain = false) => socket.emit("message", `external/toniebox/AABBCCDDEEFF/${topic}`, Buffer.from(JSON.stringify(payload)), { retain });
  send("online-state", { onlineState: "connected" }, true);
  await device.onInit();
  let confirmed = false;
  const starting = device.nightModeOn({ minutes: 45 }).then(result => { confirmed = true; return result; });
  const settled = Promise.allSettled([starting]);
  context.after(() => settled);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.published[0], { topic: "external/toniebox/AABBCCDDEEFF/app-control/stl", payload: { state: "on", duration: 2700 } });
  send("app-reply/bedtime-state", { stl: { state: "on", duration: 2700 } }, true);
  send("app-reply/bedtime-state", { stl: { state: "on", duration: 300 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, false);
  send("app-reply/bedtime-state", { stl: { state: "on", duration: 2700 } });
  assert.equal((await starting).deviceConfirmed, true);
  await device.pending;
  assert.equal(values.get("night_mode"), true);
  const stopped = assert.rejects(device.nightModeOff(), /broker disconnected/);
  await new Promise(resolve => setImmediate(resolve));
  socket.connected = false;
  socket.emit("close");
  await stopped;
  await device.pending;
  assert.equal(values.get("night_mode"), null);
  await realtime.disconnect();
  socket.connected = true;
  await realtime.connect([{ ...box, macAddress: "aabbccddeeff" }]);
  const withConfirmation = realtime.withConfirmation.bind(realtime);
  realtime.withConfirmation = (...args) => withConfirmation(...args, 5);
  const publishedBeforeTimeout = socket.published.length;
  await assert.rejects(device.nightModeOn({ minutes: 30 }), { name: "AbortError" });
  send("online-state", { onlineState: "connected" }, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.published.length, publishedBeforeTimeout);
  assert.equal(values.get("night_mode"), null);
  assert.deepEqual(errors, []);
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

test("20,000 telemetry snapshots coalesce without redundant Homey writes", async context => {
  const { device, emit, values } = await fixture();
  const blocked = deferred();
  let writes = 0;
  device.setCapabilityValue = async (name, value) => {
    writes++;
    await blocked.promise;
    values.set(name, value);
  };
  const initial = { onlineState: "connected", volume: { level: 1 } };
  emit("volume/state", initial, {}, true);
  global.gc?.();
  const memoryBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let index = 0; index < 20000; index++) emit("volume/state", { ...initial, volume: { level: index % 14 } }, initial);
  const elapsed = performance.now() - started;
  global.gc?.();
  const memoryGrowth = process.memoryUsage().heapUsed - memoryBefore;
  assert.equal(device.stateEvents.length, 1);
  if (global.gc) assert(memoryGrowth < 8 * 1024 * 1024, `Unexpected retained heap growth: ${memoryGrowth}`);
  blocked.resolve();
  await device.pending;
  assert(writes <= 3, `Expected at most three writes, saw ${writes}`);
  assert.equal(values.get("volume_set"), 19999 % 14 / 13);
  context.diagnostic(`20,000 snapshots: ${elapsed.toFixed(1)} ms; ${writes} capability writes; retained heap delta ${memoryGrowth} bytes${global.gc ? " after GC" : " (GC not forced)"}`);
  await device.onUninit();
});

test("telemetry coalescing preserves meaningful playback transitions", async () => {
  const { device, emit, triggers } = await fixture();
  const playing = { onlineState: "connected", playback: { tonie: "TONIE", chapter: 0, paused: false } };
  const paused = { ...playing, playback: { ...playing.playback, paused: true } };
  emit("playback/state", paused, {}, true);
  emit("playback/state", playing, paused);
  for (let index = 0; index < 2000; index++) emit("playback/state", { ...playing, playback: { ...playing.playback, chapterPositionMs: index } }, playing);
  emit("playback/state", paused, playing);
  assert(device.stateEvents.length <= 3);
  await device.pending;
  await device.metadataPending;
  await device.pending;
  assert.deepEqual(triggers.map(event => event.id), ["playback_started", "playback_paused"]);
  await device.onUninit();
});

test("slow metadata never blocks night mode or duplicates requests", async () => {
  const { device, account, emit, values, triggers } = await fixture();
  const blocked = deferred();
  let requests = 0;
  account.cloud.playbackInfo = async () => { requests++; return blocked.promise; };
  const initial = { onlineState: "connected", playback: { tonie: "TONIE", chapter: 0, paused: false }, bedtime: { stl: { state: "off" } } };
  emit("playback/state", initial, {}, true);
  await new Promise(resolve => setImmediate(resolve));
  const night = { ...initial, bedtime: { stl: { state: "on" } } };
  emit("app-reply/bedtime-state", night, initial);
  for (let index = 0; index < 2000; index++) emit("playback/state", night, night);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values.get("night_mode"), true);
  assert.equal(triggers.filter(event => event.id === "night_mode_started").length, 1);
  assert.equal(requests, 1);
  blocked.resolve({ title: "Story", chapters: [{ title: "First" }] });
  await device.metadataPending;
  await device.pending;
  assert.equal(values.get("speaker_track"), "First");
  await device.onUninit();
});

test("metadata responses cannot overwrite a different Tonie and cache stays bounded", async () => {
  const { device, account, send, emit, values } = await fixture();
  const blocked = deferred();
  const requests = [];
  account.cloud.playbackInfo = async (_, tonie) => {
    requests.push(tonie);
    return tonie === "OLD" ? blocked.promise : { title: tonie };
  };
  const state = tonie => ({ onlineState: "connected", playback: { tonie, chapter: 0, paused: true } });
  emit("playback/state", state("OLD"), {}, true);
  emit("playback/state", state("NEW"), state("OLD"));
  blocked.resolve({ title: "Stale title" });
  await device.metadataPending;
  await device.pending;
  assert.equal(values.get("speaker_track"), "NEW");
  assert.deepEqual(requests, ["OLD", "NEW"]);
  for (let index = 0; index < 40; index++) await send("playback/state", state(`TONIE${index}`), {}, true);
  assert.equal(device.metadataCache.size, 16);
  assert(!device.metadataCache.has(JSON.stringify(["OLD", 0])));
  const before = requests.length;
  await send("playback/state", state("TONIE39"), {}, true);
  assert.equal(requests.length, before);
  await device.onUninit();
  assert.equal(device.metadataCache.size, 0);
});

test("state-write failures are reported without poisoning later updates", async () => {
  const { device, emit, send, values, errors } = await fixture();
  const write = device.setCapabilityValue;
  device.setCapabilityValue = async () => { throw new Error("write unavailable"); };
  emit("volume/state", { onlineState: "connected", volume: { level: 2 } }, {}, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /write unavailable/);
  device.setCapabilityValue = write;
  await send("volume/state", { onlineState: "connected", volume: { level: 5 } }, {}, true);
  assert.equal(values.get("volume_set"), 5 / 13);
  await device.onUninit();
});

test("a metadata failure is reported and a later state can retry", async () => {
  const { device, account, emit, send, values, errors } = await fixture();
  account.cloud.playbackInfo = async () => { throw new Error("metadata unavailable"); };
  const state = { onlineState: "connected", playback: { tonie: "TONIE", chapter: 0, paused: false } };
  emit("playback/state", state, {}, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(values.get("speaker_playing"), true);
  account.cloud.playbackInfo = async () => ({ title: "Recovered" });
  await send("playback/state", state, state);
  assert.equal(values.get("speaker_track"), "Recovered");
  await device.onUninit();
});

test("meaningful Flow backlogs are capped and explicitly reject overflow", async () => {
  const { device, values, triggers } = await fixture();
  const blocked = deferred();
  device.setCapabilityValue = async (name, value) => { await blocked.promise; values.set(name, value); };
  const event = { boxId: box.id, topic: "settings-applied", state: { onlineState: "connected" }, previous: {}, retained: false };
  const first = device.queueState(event);
  for (let index = 0; index < 256; index++) await device.queueState(event);
  await assert.rejects(device.queueState(event), /backlog exceeded/);
  assert.equal(device.stateEvents.length, 256);
  blocked.resolve();
  await first;
  assert.equal(triggers.length, 257);
  assert.equal(device.stateEvents.length, 0);
  await device.onUninit();
});

test("concurrent settings refreshes share one request and avoid late writes", async () => {
  const { device, account, values } = await fixture();
  const blocked = deferred();
  let requests = 0;
  account.cloud.getToniebox = async () => { requests++; return blocked.promise; };
  const refreshes = Array.from({ length: 100 }, () => device.refresh());
  const stopping = device.onUninit();
  blocked.resolve({ ...box, lightringBrightness: 99 });
  await Promise.all([...refreshes, stopping]);
  assert.equal(requests, 1);
  assert.equal(values.get("ring_brightness"), 30);
});

test("uninitialization during discovery never resurrects listeners or timers", async () => {
  const { device, account, timers } = await fixture({ initialize: false });
  const blocked = deferred();
  device.homey.app.getAccount = async () => { await blocked.promise; account.devices.add(device); return account; };
  const initializing = device.onInit();
  const stopping = device.onUninit();
  blocked.resolve();
  await Promise.all([initializing, stopping]);
  assert.equal(timers.size, 0);
  assert.equal(account.realtime.listenerCount("state"), 0);
  assert.equal(account.devices.size, 0);
  await device.onInit();
  assert.equal(timers.size, 2);
  await device.onUninit();
});

test("failed initialization releases its acquired account and state listeners", async () => {
  const { device, account, timers } = await fixture({ initialize: false });
  account.cloud.getToniebox = async () => { throw new Error("settings unavailable"); };
  await assert.rejects(device.onInit(), /settings unavailable/);
  assert.equal(account.devices.size, 0);
  assert.equal(account.realtime.listenerCount("state"), 0);
  assert.equal(timers.size, 0);
  assert.equal(device.closed, true);
});

test("50 initialize/uninitialize cycles release every listener and timer", async () => {
  const { device, account, timers } = await fixture({ initialize: false });
  for (let index = 0; index < 50; index++) {
    await device.onInit();
    assert.equal(account.realtime.listenerCount("state"), 2);
    await device.onUninit();
    assert.equal(account.realtime.listenerCount("state"), 0);
    assert.equal(timers.size, 0);
    assert.equal(account.devices.size, 0);
  }
});

test("valid state restores availability after a transient SDK error", async () => {
  const { device, send } = await fixture();
  const state = { onlineState: "connected", volume: { level: 3 } };
  await send("volume/state", state, {}, true);
  await device.setUnavailable("Temporary metadata failure");
  await send("volume/state", state, state);
  assert.equal(device.available, true);
  await device.onUninit();
});

test("successful refresh restores availability without new MQTT traffic", async () => {
  const { device, send } = await fixture();
  await send("volume/state", { onlineState: "connected", volume: { level: 3 } }, {}, true);
  await device.setUnavailable("Temporary settings failure");
  await device.refresh();
  assert.equal(device.available, true);
  await device.onUninit();
});

test("broker loss clears stale night-mode and headphone conditions", async () => {
  const { device, send, values, triggers } = await fixture();
  const state = { onlineState: "connected", bedtime: { stl: { state: "on" } }, headphones: { connected: ["headphones"] } };
  await send("app-reply/bedtime-state", state, {}, true);
  assert.equal(values.get("night_mode"), true);
  assert.equal(values.get("headphones_connected"), true);
  await send("connection", { onlineState: "unknown" }, state, true);
  assert.equal(values.get("night_mode"), null);
  assert.equal(values.get("headphones_connected"), null);
  assert.equal(values.get("sleep_timer_remaining"), null);
  assert.equal(triggers.length, 0);
  await device.onUninit();
});

test("periodic refresh failures use the existing error channel instead of unhandled promises", async () => {
  const { device, account, timers, errors } = await fixture();
  account.cloud.getToniebox = async () => { throw new Error("refresh unavailable"); };
  const refresh = [...timers][0];
  assert.equal(refresh(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /refresh unavailable/);
  account.cloud.getToniebox = async () => box;
  refresh();
  await device.refreshing;
  await device.onUninit();
});

test("countdown ticks share one write and catch up to the latest timer state", async () => {
  const { device, values, timers } = await fixture();
  const blocked = deferred();
  let writes = 0;
  device.setCapabilityValue = async (name, value) => { writes++; await blocked.promise; values.set(name, value); };
  device.sleepTimer = { state: "on", until: Date.now() / 1000 + 1800 };
  const countdown = [...timers][1];
  for (let index = 0; index < 1000; index++) countdown();
  assert.equal(writes, 1);
  device.sleepTimer = { state: "off" };
  blocked.resolve();
  await device.countdownPending;
  assert.equal(writes, 2);
  assert.equal(values.get("sleep_timer_remaining"), 0);
  await device.onUninit();
});

test("shutdown drains other workers even when one worker fails", async () => {
  const { device, account, emit } = await fixture();
  const metadata = deferred();
  const settings = deferred();
  account.cloud.playbackInfo = () => metadata.promise;
  account.cloud.getToniebox = () => settings.promise;
  emit("playback/state", { onlineState: "connected", playback: { tonie: "TONIE", chapter: 0, paused: true } }, {}, true);
  const refresh = assert.rejects(device.refresh(), /settings failed/);
  let stopped = false;
  const stopping = assert.rejects(device.onUninit(), /settings failed/).then(() => { stopped = true; });
  settings.reject(new Error("settings failed"));
  await refresh;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(account.devices.size, 1);
  metadata.resolve({ title: "Old result" });
  await stopping;
  assert.equal(account.devices.size, 0);
  assert.equal(account.realtime.listenerCount("state"), 0);
});
