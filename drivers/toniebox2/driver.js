"use strict";

const assert = require("node:assert/strict");
const Homey = require("homey");

class TonieboxDriver extends Homey.Driver {
  async onPair(session) {
    let account;
    let generation = 0;
    let closed = false;
    session.setHandler("login", async ({ username, password }) => {
      if (closed) return false;
      const attempt = ++generation;
      account = undefined;
      const signedIn = await this.homey.app.signIn(username, password);
      if (closed || attempt !== generation) return false;
      account = signedIn;
      return true;
    });
    session.setHandler("list_devices", async () => {
      assert(account, "Sign in to Tonies first");
      return account.boxes.map(box => ({ name: box.name, data: { id: box.id }, store: { accountId: account.accountId } }));
    });
    session.setHandler("disconnect", async () => { closed = true; account = undefined; });
  }

  async onRepair(session, device) {
    let busy = false;
    let closed = false;
    session.setHandler("login", async ({ username, password }) => {
      if (closed) return false;
      assert(!busy, "A repair is already in progress");
      busy = true;
      try {
        const account = await this.homey.app.signIn(username, password);
        if (closed) return false;
        assert(account.boxes.some(box => box.id === device.getData().id), "This account does not contain this Toniebox 2");
        await device.onUninit();
        await device.setStoreValue("accountId", account.accountId);
        await device.onInit();
        return true;
      } finally {
        busy = false;
      }
    });
    session.setHandler("disconnect", async () => { closed = true; });
  }
}

module.exports = TonieboxDriver;
