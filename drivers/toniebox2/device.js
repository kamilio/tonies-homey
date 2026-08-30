"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Homey = require("homey");

class TonieboxDevice extends Homey.Device {
  async onInit() {
    if (this.stopping) await this.stopping;
    assert(!this.initializing && this.closed !== false, "Toniebox is already initialized");
    this.closed = false;
    this.initializing = this.initialize();
    let initialized = false;
    try {
      await this.initializing;
      initialized = true;
    } finally {
      this.initializing = undefined;
      if (!initialized) await this.onUninit();
    }
  }

  async initialize() {
    this.lifecycle = {};
    this.online = undefined;
    this.metadataCache = new Map();
    this.metadataTarget = undefined;
    this.accountId = this.getStoreValue("accountId");
    this.account = await this.homey.app.getAccount(this.accountId, this);
    if (this.closed) return;
    this.box = this.account.boxes.find(box => box.id === this.getData().id);
    assert(this.box?.product === "tb2" && this.box.generation === "tng", "This is not a Toniebox 2");
    this.account.devices.add(this);
    this.sdk = await this.homey.app.sdk();
    if (this.closed) return;
    const lifecycle = this.lifecycle;
    this.tasks = new EventEmitter({ captureRejections: true });
    this.tasks.on("error", error => {
      if (!this.closed && this.lifecycle === lifecycle) this.account.realtime.emit("error", error);
    });
    this.tasks.on("refresh", () => { if (!this.refreshing) return this.refresh(); });
    this.tasks.on("countdown", () => { if (!this.countdownPending) return this.updateCountdown(); });
    this.stateEvents = [];
    this.pending = undefined;
    this.stateListener = event => event.boxId === this.box.id ? this.queueState(event) : undefined;
    this.metadataListener = event => event.boxId === this.box.id ? this.queueMetadata(event.state) : undefined;
    this.account.realtime.on("state", this.stateListener);
    this.account.realtime.on("state", this.metadataListener);
    this.registerCapabilityListener("night_mode", enabled => enabled ? this.nightModeOn({ minutes: this.getSetting("night_minutes") ?? 30 }) : this.nightModeOff());
    this.registerCapabilityListener("speaker_playing", playing => playing ? this.play() : this.pause());
    this.registerCapabilityListener("speaker_next", () => this.next());
    this.registerCapabilityListener("speaker_prev", () => this.previous());
    this.registerCapabilityListener("volume_set", value => this.setVolume({ percent: value * 100 }));
    this.registerCapabilityListener("volume_up", () => this.volumeUp());
    this.registerCapabilityListener("volume_down", () => this.volumeDown());
    this.registerCapabilityListener("ring_brightness", brightness => this.setRingBrightness({ brightness }));
    await this.refresh();
    if (this.closed) return;
    this.refreshTimer = this.homey.setInterval(() => this.tasks.emit("refresh"), 60000);
    this.countdownTimer = this.homey.setInterval(() => this.tasks.emit("countdown"), 15000);
  }

  async refresh() {
    if (this.closed) return;
    this.refreshing ??= this.refreshSettings().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async refreshSettings() {
    const box = await this.account.cloud.getToniebox(this.box.householdId, this.box.id);
    if (this.closed) return;
    this.box = { ...this.box, ...box };
    if (typeof box.lightringBrightness === "number") await this.setValue("ring_brightness", box.lightringBrightness);
    if (this.closed) return;
    const firmware = String(box.firmwareVersion ?? "Unknown");
    if (this.getSetting("firmware") !== firmware || this.getSetting("box_id") !== this.box.id) await this.setSettings({ firmware, box_id: this.box.id });
    if (this.closed) return;
    const state = this.account.realtime.states.get(this.box.id);
    if (state) await Promise.all([
      this.queueState({ boxId: this.box.id, state, previous: {}, retained: true, topic: "snapshot" }),
      this.queueMetadata(state)
    ]);
  }

  queueState(event) {
    if (this.closed) return;
    this.latestState = event.state;
    const transitions = this.flowEvents(event);
    const queued = { event, transitions };
    const last = this.stateEvents.at(-1);
    if (last && !last.transitions.length && !transitions.length) this.stateEvents[this.stateEvents.length - 1] = queued;
    else {
      if (this.stateEvents.length >= 256) return Promise.reject(new Error("Toniebox Flow backlog exceeded 256 events"));
      this.stateEvents.push(queued);
    }
    if (this.pending) return;
    this.pending = this.drainState();
    return this.pending;
  }

  async drainState() {
    try {
      while (!this.closed && this.stateEvents.length) {
        const { event, transitions } = this.stateEvents.shift();
        await this.updateState({ ...event, retained: true });
        for (const [id, tokens] of transitions) {
          if (this.closed) break;
          if (tokens.tonie_id !== undefined) tokens.title = this.trackTitle(event.state);
          await this.trigger(id, tokens);
        }
      }
    } finally {
      this.pending = undefined;
    }
  }

  async setValue(name, value) {
    if (!this.closed && !Object.is(this.getCapabilityValue(name), value)) await this.setCapabilityValue(name, value);
  }

  queueMetadata(state) {
    if (this.closed) return;
    const playback = state.onlineState === "connected" ? state.playback : undefined;
    if (playback === this.metadataTarget?.playback && (this.metadataPending || this.metadataCache.has(this.metadataTarget?.key))) return;
    const key = playback?.tonie ? JSON.stringify([playback.tonie, playback.contentVersion ?? 0]) : undefined;
    this.metadataTarget = key ? { key, playback } : undefined;
    if (!key || this.metadataCache.has(key) || this.metadataPending) return;
    const lifecycle = this.lifecycle;
    this.metadataPending = this.loadMetadata(lifecycle).finally(() => {
      if (lifecycle === this.lifecycle) this.metadataPending = undefined;
    });
    return this.metadataPending;
  }

  async loadMetadata(lifecycle) {
    while (!this.closed && lifecycle === this.lifecycle && this.metadataTarget && !this.metadataCache.has(this.metadataTarget.key)) {
      const { key, playback } = this.metadataTarget;
      const metadata = await this.account.cloud.playbackInfo(this.box.id, playback.tonie, playback.contentVersion ?? 0);
      if (this.closed || lifecycle !== this.lifecycle) return;
      const title = value => typeof value === "string" ? value : undefined;
      this.metadataCache.set(key, {
        title: title(metadata?.title),
        chapters: Array.isArray(metadata?.chapters) ? metadata.chapters.map(chapter => ({ title: title(chapter?.title) })) : []
      });
      if (this.metadataCache.size > 16) this.metadataCache.delete(this.metadataCache.keys().next().value);
      if (this.metadataTarget?.key === key) {
        await this.queueState({ boxId: this.box.id, state: this.latestState, previous: {}, retained: true, topic: "metadata" });
      }
    }
  }

  trackTitle(state) {
    const playback = state.playback;
    const metadata = playback?.tonie && state.onlineState === "connected"
      ? this.metadataCache.get(JSON.stringify([playback.tonie, playback.contentVersion ?? 0])) : undefined;
    return metadata?.chapters?.[playback?.chapter]?.title ?? metadata?.title ?? "";
  }

  async updateState(event) {
    if (this.closed) return;
    const { state } = event;
    if (state.onlineState !== undefined) {
      const online = state.onlineState === "connected";
      await this.setValue("toniebox_online", online);
      if ((this.online !== online || this.getAvailable() !== online) && !this.closed) {
        if (online) await this.setAvailable();
        else await this.setUnavailable("Toniebox is sleeping or offline; squeeze an ear to wake it");
        this.online = online;
      }
      if (!online) {
        await this.setValue("speaker_playing", false);
        await this.setValue("tonie_id", "");
        await this.setValue("speaker_track", "");
        await this.setValue("chapter_number", 0);
        this.sleepTimer = undefined;
        await this.setValue("night_mode", null);
        await this.setValue("headphones_connected", null);
        await this.updateCountdown();
      }
    }
    if (state.battery?.percent !== undefined) {
      await this.setValue("measure_battery", state.battery.percent);
      await this.setValue("alarm_battery", state.battery.percent <= 20);
    }
    if (typeof state.volume?.level === "number") await this.setValue("volume_set", state.volume.level / 13);
    if (state.headphones && state.onlineState === "connected") await this.setValue("headphones_connected", this.headphonesConnected(state));
    if (state.playback && state.onlineState === "connected") {
      const playback = state.playback;
      await this.setValue("speaker_playing", state.onlineState === "connected" && this.sdk.isPlaying(playback));
      await this.setValue("tonie_id", playback.tonie ?? "");
      await this.setValue("chapter_number", Number.isInteger(playback.chapter) ? playback.chapter + 1 : 0);
      await this.setValue("speaker_track", this.trackTitle(state));
    }
    if (state.bedtime?.stl && state.onlineState === "connected") {
      await this.setValue("night_mode", state.bedtime.stl.state === "on");
      this.sleepTimer = state.bedtime.stl;
      await this.updateCountdown();
    }
    for (const [id, tokens] of this.flowEvents(event)) await this.trigger(id, tokens);
  }

  flowEvents({ state, previous, retained, topic }) {
    const events = [];
    if (retained) return events;
    const add = (id, tokens = {}) => events.push([id, tokens]);
    const tokens = { tonie_id: state.playback?.tonie ?? "", chapter: (state.playback?.chapter ?? -1) + 1, title: this.trackTitle(state) };
    if (topic === "playback/state") {
      if (this.sdk.isPlaying(state.playback) && !this.sdk.isPlaying(previous.playback)) add("playback_started", tokens);
      if (state.playback?.paused === true && previous.playback?.paused === false) add("playback_paused", tokens);
      if (state.playback?.ended === true && previous.playback?.ended === false) add("playback_ended", tokens);
      if (previous.playback && state.playback?.tonie !== previous.playback.tonie) add("tonie_changed", tokens);
      if (previous.playback && state.playback?.chapter !== previous.playback.chapter) add("chapter_changed", tokens);
    }
    if (topic === "online-state" && state.onlineState !== previous.onlineState) add(state.onlineState === "connected" ? "box_online" : "box_offline");
    if (topic === "app-reply/bedtime-state" && state.bedtime?.stl?.state !== previous.bedtime?.stl?.state) {
      const timerState = state.bedtime?.stl?.state;
      if (timerState === "on") add("night_mode_started");
      else if (previous.bedtime?.stl?.state === "on") add("night_mode_ended");
      if (timerState === "completed") add("sleep_timer_completed");
    }
    if (topic === "metrics/headphones" && previous.headphones && this.headphonesConnected(state) !== this.headphonesConnected(previous)) add("headphones_changed", { connected: this.headphonesConnected(state) });
    if (topic === "metrics/battery" && previous.battery?.percent > 20 && state.battery?.percent <= 20) add("battery_low", { percent: state.battery.percent });
    if (topic === "settings-applied") add("settings_applied");
    return events;
  }

  headphonesConnected(state) {
    return state.headphones?.speaker?.output === false || (Array.isArray(state.headphones?.connected) && state.headphones.connected.length > 0);
  }

  updateCountdown() {
    if (this.closed) return;
    this.countdownPending ??= this.applyCountdown().finally(() => { this.countdownPending = undefined; });
    return this.countdownPending;
  }

  async applyCountdown() {
    while (!this.closed) {
      const timer = this.sleepTimer;
      const remaining = !timer ? null : timer.state === "on" ? (typeof timer.until === "number" ? Math.max(0, (timer.until * 1000 - Date.now()) / 60000) : null) : 0;
      await this.setValue("sleep_timer_remaining", remaining === null ? null : Math.round(remaining * 10) / 10);
      if (timer === this.sleepTimer) return;
    }
  }

  trigger(id, tokens = {}) { return this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens, {}); }
  play() { return this.account.realtime.play(this.box.id); }
  pause() { return this.account.realtime.pause(this.box.id); }
  next() { return this.account.realtime.skip(this.box.id, 1); }
  previous() { return this.account.realtime.skip(this.box.id, -1); }
  volumeUp() { return this.account.realtime.changeVolume(this.box.id, 1); }
  volumeDown() { return this.account.realtime.changeVolume(this.box.id, -1); }
  sleepNow() { return this.account.realtime.sleep(this.box.id); }
  nightModeOff() { return this.nightMode(0); }

  nightModeOn({ minutes }) {
    assert(Number.isFinite(minutes) && minutes >= 1 && minutes <= 720, "Night mode duration must be 1–720 minutes");
    return this.nightMode(Math.round(minutes * 60));
  }

  nightMode(seconds) {
    const state = seconds > 0 ? "on" : "off";
    return this.account.realtime.withConfirmation(this.box.id, "app-reply/bedtime-state", reply => reply.bedtime?.stl?.state === state && (!seconds || reply.bedtime.stl.duration === seconds),
      () => this.account.realtime.sleepTimer(this.box.id, seconds));
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

  onUninit() {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = this.uninitialize().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async uninitialize() {
    this.stateEvents = [];
    if (this.refreshTimer) this.homey.clearInterval(this.refreshTimer);
    if (this.countdownTimer) this.homey.clearInterval(this.countdownTimer);
    this.tasks?.removeAllListeners("refresh");
    this.tasks?.removeAllListeners("countdown");
    if (this.stateListener) this.account?.realtime.off("state", this.stateListener);
    if (this.metadataListener) this.account?.realtime.off("state", this.metadataListener);
    const pending = [this.initializing, this.pending, this.metadataPending, this.refreshing, this.countdownPending];
    const drained = Promise.allSettled(pending);
    try {
      await Promise.all(pending);
    } finally {
      await drained;
      this.metadataCache?.clear();
      this.metadataTarget = undefined;
      this.latestState = undefined;
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
