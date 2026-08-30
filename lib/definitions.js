"use strict";

const number = (name, title, min, max, step = 1) => ({ name, type: "number", title: { en: title }, min, max, step });
const text = (name, title) => ({ name, type: "text", title: { en: title } });
const device = { name: "device", type: "device", filter: "driver_id=toniebox2" };
const actions = [
  { id: "night_mode_on", title: "Start night mode for [[minutes]] minutes", hint: "Starts the native sleep timer with light using the box’s bedtime light and volume settings; requires an online box.", method: "nightModeOn", args: [number("minutes", "Minutes", 1, 720)] },
  { id: "night_mode_off", title: "Stop night mode", hint: "Cancels the native sleep-light timer, not scheduled sunrise alarms.", method: "nightModeOff" },
  { id: "night_light", title: "Set night light to [[color]] at [[brightness]]%", method: "setNightLight", args: [text("color", "Hex color (#ff8800)"), number("brightness", "Brightness (%)", 0, 100)] },
  { id: "night_volume", title: "Set night volume limits to [[speaker]]% / [[headphones]]%", method: "setNightVolume", args: [number("speaker", "Speaker limit (%)", 1, 100), number("headphones", "Headphone limit (%)", 1, 100)] },
  { id: "play", title: "Resume playback", method: "play" },
  { id: "pause", title: "Pause playback", method: "pause" },
  { id: "next", title: "Next chapter", method: "next" },
  { id: "previous", title: "Previous chapter", method: "previous" },
  { id: "seek", title: "Go to chapter [[chapter]]", method: "seek", args: [number("chapter", "Chapter (starts at 1)", 1, 999)] },
  { id: "volume", title: "Set playback volume to [[percent]]%", method: "setVolume", args: [number("percent", "Volume (%)", 0, 100)] },
  { id: "volume_up", title: "Raise playback volume one step", method: "volumeUp" },
  { id: "volume_down", title: "Lower playback volume one step", method: "volumeDown" },
  { id: "volume_limit", title: "Set speaker volume limit to [[percent]]%", method: "setVolumeLimit", args: [{ name: "percent", type: "dropdown", title: { en: "Maximum volume" }, values: [25, 50, 75, 100].map(value => ({ id: String(value), label: { en: `${value}%` } })) }] },
  { id: "ring_brightness", title: "Set light ring brightness to [[brightness]]%", method: "setRingBrightness", args: [number("brightness", "Brightness (%)", 0, 100)] },
  { id: "sleep_now", title: "Put the Toniebox to sleep", hint: "The Toniebox cannot be woken remotely; squeeze an ear to wake it.", method: "sleepNow" },
  { id: "refresh", title: "Refresh Toniebox settings", method: "refresh" }
];

const tokens = {
  tonie_id: { type: "string", title: { en: "Tonie ID" } },
  chapter: { type: "number", title: { en: "Chapter (starts at 1)" } },
  title: { type: "string", title: { en: "Track title" } }
};

const triggers = [
  { id: "playback_started", title: "Playback started", tokens },
  { id: "playback_paused", title: "Playback paused", tokens },
  { id: "playback_ended", title: "Playback ended", tokens },
  { id: "tonie_changed", title: "The Tonie changed", tokens },
  { id: "chapter_changed", title: "The chapter changed", tokens },
  { id: "night_mode_started", title: "Night mode started" },
  { id: "night_mode_ended", title: "Night mode stopped" },
  { id: "sleep_timer_completed", title: "The sleep timer completed" },
  { id: "box_online", title: "The Toniebox came online" },
  { id: "box_offline", title: "The Toniebox went offline" },
  { id: "headphones_changed", title: "Headphone connection changed", tokens: { connected: { type: "boolean", title: { en: "Connected" } } } },
  { id: "battery_low", title: "Battery became low", tokens: { percent: { type: "number", title: { en: "Battery (%)" } } } },
  { id: "settings_applied", title: "The Toniebox applied its settings" }
];

const conditions = [
  { id: "is_playing", title: "Playback !{{is|is not}} active", capability: "speaker_playing" },
  { id: "is_online", title: "The Toniebox !{{is|is not}} online", capability: "toniebox_online" },
  { id: "is_night_mode", title: "Night mode !{{is|is not}} active", capability: "night_mode" },
  { id: "has_headphones", title: "Headphones !{{are|are not}} connected", capability: "headphones_connected" },
  { id: "is_tonie", title: "Tonie [[tonie_id]] !{{is|is not}} on the box", args: [text("tonie_id", "Tonie ID")] }
];

const capability = (type, title, getable, setable, extra = {}) => ({ type, title: { en: title }, getable, setable, ...extra });
const capabilities = {
  night_mode: capability("boolean", "Night mode", true, true, { uiComponent: "toggle", icon: "/assets/night.svg" }),
  toniebox_online: capability("boolean", "Online", true, false, { uiComponent: "sensor", icon: "/assets/icon.svg" }),
  headphones_connected: capability("boolean", "Headphones connected", true, false, { uiComponent: "sensor", icon: "/assets/icon.svg" }),
  sleep_timer_remaining: capability("number", "Night mode remaining", true, false, { units: { en: "min" }, min: 0, decimals: 1, uiComponent: "sensor", icon: "/assets/night.svg" }),
  tonie_id: capability("string", "Tonie ID", true, false, { uiComponent: "sensor", icon: "/assets/icon.svg" }),
  chapter_number: capability("number", "Chapter", true, false, { min: 0, decimals: 0, uiComponent: "sensor", icon: "/assets/icon.svg" }),
  ring_brightness: capability("number", "Light ring", true, true, { min: 0, max: 100, step: 1, decimals: 0, units: { en: "%" }, uiComponent: "slider", icon: "/assets/night.svg" })
};

const deviceCapabilities = ["night_mode", "speaker_playing", "speaker_next", "speaker_prev", "volume_set", "volume_up", "volume_down", "measure_battery", "alarm_battery", "toniebox_online", "sleep_timer_remaining", "speaker_track", "tonie_id", "chapter_number", "headphones_connected", "ring_brightness"];

function flowCard(card) {
  return {
    id: card.id,
    title: { en: card.title.replace(/\[\[[^\]]+\]\]/g, "…") },
    titleFormatted: { en: card.title },
    ...(card.hint ? { hint: { en: card.hint } } : {}),
    args: [device, ...(card.args ?? [])],
    ...(card.tokens ? { tokens: Object.entries(card.tokens).map(([name, token]) => ({ name, ...token })) } : {})
  };
}

module.exports = { actions, triggers, conditions, capabilities, deviceCapabilities, flowCard };
