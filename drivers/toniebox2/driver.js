"use strict";

const assert = require("node:assert/strict");
const Homey = require("homey");

class TonieboxDriver extends Homey.Driver {
  async onPair(session) {
    let account;
    session.setHandler("login", async ({ username, password }) => {
      account = await this.homey.app.signIn(username, password);
      return true;
    });
    session.setHandler("list_devices", async () => {
      assert(account, "Sign in to Tonies first");
      return account.boxes.map(box => ({ name: box.name, data: { id: box.id }, store: { accountId: account.accountId } }));
    });
    session.setHandler("disconnect", async () => { account = undefined; });
  }

  async onRepair(session, device) {
    session.setHandler("login", async ({ username, password }) => {
      const account = await this.homey.app.signIn(username, password);
      assert(account.boxes.some(box => box.id === device.getData().id), "This account does not contain this Toniebox 2");
      await device.onUninit();
      await device.setStoreValue("accountId", account.accountId);
      await device.onInit();
      return true;
    });
  }
}

module.exports = TonieboxDriver;
