"use strict";

const assert = require("node:assert/strict");
const Homey = require("homey");

class TonieboxDevice extends Homey.Device {
  async onInit() {
    this.closed = false;
    this.accountId = this.getStoreValue("accountId");
    this.account = await this.homey.app.getAccount(this.accountId);
    this.box = this.account.boxes.find(box => box.id === this.getData().id);
    assert(this.box?.product === "tb2" && this.box.generation === "tng", "This is not a Toniebox 2");
    this.account.devices.add(this);
    this.sdk = await this.homey.app.sdk();
    this.pending = Promise.resolve();
    this.stateListener = event => {
      if (event.boxId === this.box.id && !this.closed) this.pending = this.pending.then(() => this.updateState(event));
    };
    this.account.realtime.on("state", this.stateListener);
    this.registerCapabilityListener("night_mode", enabled => enabled ? this.nightModeOn({ minutes: this.getSetting("night_minutes") ?? 30 }) : this.nightModeOff());
    this.registerCapabilityListener("speaker_playing", playing => playing ? this.play() : this.pause());
    this.registerCapabilityListener("speaker_next", () => this.next());
    this.registerCapabilityListener("speaker_prev", () => this.previous());
    this.registerCapabilityListener("volume_set", value => this.setVolume({ percent: value * 100 }));
    this.registerCapabilityListener("volume_up", () => this.volumeUp());
    this.registerCapabilityListener("volume_down", () => this.volumeDown());
    this.registerCapabilityListener("ring_brightness", brightness => this.setRingBrightness({ brightness }));
    await this.refresh();
    const state = this.account.realtime.states.get(this.box.id);
    if (state) await this.updateState({ boxId: this.box.id, state, previous: {}, retained: true, topic: "snapshot" });
    this.refreshTimer = this.homey.setInterval(() => this.refresh(), 60000);
    this.countdownTimer = this.homey.setInterval(() => this.updateCountdown(), 15000);
  }

  async refresh() {
    const box = await this.account.cloud.getToniebox(this.box.householdId, this.box.id);
    if (this.closed) return;
    this.box = { ...this.box, ...box };
    if (typeof box.lightringBrightness === "number") await this.setCapabilityValue("ring_brightness", box.lightringBrightness);
    await this.setSettings({ firmware: String(box.firmwareVersion ?? "Unknown"), box_id: this.box.id });
  }

  async updateState(event) {
    if (this.closed) return;
    const { state, previous, retained, topic } = event;
    if (state.onlineState !== undefined) {
      const online = state.onlineState === "connected";
      await this.setCapabilityValue("toniebox_online", online);
      if (online) await this.setAvailable();
      else await this.setUnavailable("Toniebox is sleeping or offline; squeeze an ear to wake it");
      if (!online) {
        await this.setCapabilityValue("speaker_playing", false);
        await this.setCapabilityValue("tonie_id", "");
        await this.setCapabilityValue("speaker_track", "");
        await this.setCapabilityValue("chapter_number", 0);
      }
    }
    if (state.battery?.percent !== undefined) {
      await this.setCapabilityValue("measure_battery", state.battery.percent);
      await this.setCapabilityValue("alarm_battery", state.battery.percent <= 20);
    }
    if (typeof state.volume?.level === "number") await this.setCapabilityValue("volume_set", state.volume.level / 13);
    if (state.headphones) await this.setCapabilityValue("headphones_connected", this.headphonesConnected(state));
    if (state.playback) {
      const playback = state.playback;
      if (!playback.tonie) this.metadata = undefined;
      await this.setCapabilityValue("speaker_playing", state.onlineState === "connected" && this.sdk.isPlaying(playback));
      await this.setCapabilityValue("tonie_id", playback.tonie ?? "");
      await this.setCapabilityValue("chapter_number", Number.isInteger(playback.chapter) ? playback.chapter + 1 : 0);
      if (playback.tonie && (playback.tonie !== previous.playback?.tonie || playback.contentVersion !== previous.playback?.contentVersion)) {
        this.metadata = await this.account.cloud.playbackInfo(this.box.id, playback.tonie, playback.contentVersion ?? 0);
      }
      const chapter = this.metadata?.chapters?.[playback.chapter];
      await this.setCapabilityValue("speaker_track", chapter?.title ?? this.metadata?.title ?? "");
    }
    if (state.bedtime?.stl) {
      await this.setCapabilityValue("night_mode", state.bedtime.stl.state === "on");
      this.sleepTimer = state.bedtime.stl;
      await this.updateCountdown();
    }
    if (retained) return;
    const tokens = { tonie_id: state.playback?.tonie ?? "", chapter: (state.playback?.chapter ?? -1) + 1, title: this.getCapabilityValue("speaker_track") ?? "" };
    if (topic === "playback/state") {
      if (this.sdk.isPlaying(state.playback) && !this.sdk.isPlaying(previous.playback)) await this.trigger("playback_started", tokens);
      if (state.playback?.paused === true && previous.playback?.paused === false) await this.trigger("playback_paused", tokens);
      if (state.playback?.ended === true && previous.playback?.ended === false) await this.trigger("playback_ended", tokens);
      if (previous.playback && state.playback?.tonie !== previous.playback.tonie) await this.trigger("tonie_changed", tokens);
      if (previous.playback && state.playback?.chapter !== previous.playback.chapter) await this.trigger("chapter_changed", tokens);
    }
    if (topic === "online-state" && state.onlineState !== previous.onlineState) await this.trigger(state.onlineState === "connected" ? "box_online" : "box_offline");
    if (topic === "app-reply/bedtime-state" && state.bedtime?.stl?.state !== previous.bedtime?.stl?.state) {
      const timerState = state.bedtime?.stl?.state;
      if (timerState === "on") await this.trigger("night_mode_started");
      else if (previous.bedtime?.stl?.state === "on") await this.trigger("night_mode_ended");
      if (timerState === "completed") await this.trigger("sleep_timer_completed");
    }
    if (topic === "metrics/headphones" && previous.headphones && this.headphonesConnected(state) !== this.headphonesConnected(previous)) await this.trigger("headphones_changed", { connected: this.headphonesConnected(state) });
    if (topic === "metrics/battery" && previous.battery?.percent > 20 && state.battery?.percent <= 20) await this.trigger("battery_low", { percent: state.battery.percent });
    if (topic === "settings-applied") await this.trigger("settings_applied");
  }

  headphonesConnected(state) {
    return state.headphones?.speaker?.output === false || (Array.isArray(state.headphones?.connected) && state.headphones.connected.length > 0);
  }

  async updateCountdown() {
    if (this.closed) return;
    const timer = this.sleepTimer;
    const remaining = timer?.state === "on" ? (typeof timer.until === "number" ? Math.max(0, (timer.until * 1000 - Date.now()) / 60000) : null) : 0;
    await this.setCapabilityValue("sleep_timer_remaining", remaining === null ? null : Math.round(remaining * 10) / 10);
  }

  trigger(id, tokens = {}) { return this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens, {}); }
  play() { return this.account.realtime.play(this.box.id); }
  pause() { return this.account.realtime.pause(this.box.id); }
  next() { return this.account.realtime.skip(this.box.id, 1); }
  previous() { return this.account.realtime.skip(this.box.id, -1); }
  volumeUp() { return this.account.realtime.changeVolume(this.box.id, 1); }
  volumeDown() { return this.account.realtime.changeVolume(this.box.id, -1); }
  sleepNow() { return this.account.realtime.sleep(this.box.id); }
  nightModeOff() {
    return this.account.realtime.sleepTimer(this.box.id, 0).then(() => this.account.realtime.waitForState(this.box.id, state => state.bedtime?.stl?.state === "off"));
  }

  nightModeOn({ minutes }) {
    assert(Number.isFinite(minutes) && minutes >= 1 && minutes <= 720, "Night mode duration must be 1–720 minutes");
    return this.account.realtime.sleepTimer(this.box.id, Math.round(minutes * 60)).then(() => this.account.realtime.waitForState(this.box.id, state => state.bedtime?.stl?.state === "on"));
  }

  setVolume({ percent }) {
    assert(Number.isFinite(percent) && percent >= 0 && percent <= 100, "Volume must be 0–100%");
    return this.account.realtime.setVolume(this.box.id, Math.round(percent / 100 * 13));
  }

  seek({ chapter, seconds = 0 }) {
    assert(Number.isInteger(chapter) && chapter >= 1 && Number.isFinite(seconds) && seconds >= 0, "Use chapter 1 or higher and nonnegative seconds");
    return this.account.realtime.seek(this.box.id, chapter - 1, Math.round(seconds * 1000));
  }

  setNightLight({ color, brightness }) {
    assert(/^#[a-fA-F0-9]{6}$/.test(color), "Use a hex color such as #ff8800");
    assert(Number.isInteger(brightness) && brightness >= 0 && brightness <= 100, "Brightness must be 0–100%");
    return this.settings({ bedtimeLightringColor: color.toLowerCase(), bedtimeLightringBrightness: brightness });
  }

  setNightVolume({ speaker, headphones }) {
    assert([speaker, headphones].every(value => Number.isInteger(value) && value >= 1 && value <= 100), "Night volume limits must be 1–100%");
    return this.settings({ bedtimeMaxVolume: speaker, bedtimeMaxHeadphoneVolume: headphones });
  }

  setVolumeLimit({ percent }) {
    const value = Number(percent);
    assert([25, 50, 75, 100].includes(value), "Volume limit must be 25, 50, 75, or 100%");
    return this.settings({ maxVolume: value });
  }

  setRingBrightness({ brightness }) {
    assert(Number.isInteger(brightness) && brightness >= 0 && brightness <= 100, "Brightness must be 0–100%");
    return this.settings({ lightringBrightness: brightness });
  }

  settings(settings) { return this.account.cloud.setTonieboxSettings(this.box.householdId, this.box.id, settings); }

  async onUninit() {
    this.closed = true;
    if (this.refreshTimer) this.homey.clearInterval(this.refreshTimer);
    if (this.countdownTimer) this.homey.clearInterval(this.countdownTimer);
    if (this.stateListener) this.account?.realtime.off("state", this.stateListener);
    try {
      await this.pending;
    } finally {
      await this.homey.app.releaseAccount(this.accountId, this);
    }
  }

  async onDeleted() {
    const accountId = this.accountId;
    await this.onUninit();
    const remaining = this.driver.getDevices().filter(device => device !== this && device.getStoreValue("accountId") === accountId);
    if (!remaining.length) this.homey.settings.unset(`tonies.auth.${accountId}`);
  }
}

module.exports = TonieboxDevice;
