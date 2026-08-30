"use strict";

const assert = require("node:assert/strict");
const Homey = require("homey");
const { actions, conditions } = require("./lib/definitions");

class ToniesApp extends Homey.App {
  clients = new Map();

  async onInit() {
    this.accounts = new Map();
    this.connecting = new Map();
    for (const action of actions) this.homey.flow.getActionCard(action.id).registerRunListener(async args => {
      await args.device[action.method](args);
      return true;
    });
    for (const condition of conditions) this.homey.flow.getConditionCard(condition.id).registerRunListener(async args => {
      if (condition.id === "is_tonie") return args.device.getCapabilityValue("tonie_id")?.toUpperCase() === args.tonie_id.toUpperCase();
      return args.device.getCapabilityValue(condition.capability) === true;
    });
  }

  async sdk() {
    return require("./lib/tonies-sdk");
  }

  async signIn(email, password) {
    const { TonieCloudClient, isToniebox2 } = await this.sdk();
    const cloud = new TonieCloudClient();
    await cloud.login(email, password);
    const me = await cloud.request("GET", "/me");
    const accountId = me.uuid ?? me.id;
    assert(accountId, "The Tonies account has no identity");
    const boxes = (await cloud.listTonieboxes()).filter(isToniebox2);
    assert(boxes.length, "No Toniebox 2 devices were found; original Tonieboxes and Toniebox Lite are not supported");
    const existing = this.clients.get(accountId);
    if (existing) await existing.setAuth(cloud.auth);
    else this.homey.settings.set(`tonies.auth.${accountId}`, cloud.auth);
    return { accountId, boxes };
  }

  async getAccount(accountId, device) {
    if (this.accounts.has(accountId)) {
      const account = this.accounts.get(accountId);
      if (device) account.devices.add(device);
      return account;
    }
    if (!this.connecting.has(accountId)) {
      const connection = this.createAccount(accountId).then(account => {
        this.accounts.set(accountId, account);
        return account;
      }).finally(() => this.connecting.delete(accountId));
      this.connecting.set(accountId, connection);
    }
    const account = await this.connecting.get(accountId);
    if (device) account.devices.add(device);
    return account;
  }

  async createAccount(accountId) {
    const { TonieCloudClient, ToniesRealtime, isToniebox2 } = await this.sdk();
    const auth = this.homey.settings.get(`tonies.auth.${accountId}`);
    assert(auth?.refreshToken, "Repair this device to sign in to Tonies again");
    const cloud = new TonieCloudClient({ auth, onAuth: next => {
      if (this.clients.get(accountId) === cloud) this.homey.settings.set(`tonies.auth.${accountId}`, next);
    } });
    this.clients.set(accountId, cloud);
    const realtime = new ToniesRealtime(cloud);
    const account = { cloud, realtime, boxes: [], devices: new Set() };
    realtime.on("error", error => {
      for (const device of account.devices) device.setUnavailable(error.message);
    });
    realtime.on("disconnected", () => {
      for (const device of account.devices) device.setUnavailable("Tonies realtime connection is unavailable");
    });
    let connected = false;
    try {
      account.boxes = (await cloud.listTonieboxes()).filter(isToniebox2);
      realtime.setMaxListeners(Math.max(10, account.boxes.length * 2 + 8));
      await realtime.connect(account.boxes);
      connected = true;
      return account;
    } finally {
      if (!connected) {
        if (this.clients.get(accountId) === cloud) this.clients.delete(accountId);
        await realtime.disconnect();
      }
    }
  }

  async releaseAccount(accountId, device, deleted = false) {
    const account = this.accounts.get(accountId);
    if (!account?.devices.delete(device)) return;
    if (account.devices.size) return;
    this.accounts.delete(accountId);
    if (this.clients.get(accountId) === account.cloud) this.clients.delete(accountId);
    if (deleted) this.homey.settings.unset(`tonies.auth.${accountId}`);
    await account.realtime.disconnect();
  }
}

module.exports = ToniesApp;
