# Toniebox 2 for Homey

This unofficial app pairs **only Toniebox 2** devices (`product=tb2`, `generation=tng`). Original Tonieboxes, Toniebox Lite, households, and figurines are not added as Homey devices. Sign in using your Tonies email and password when pairing; only rotating account tokens are retained in private app settings, not your password. Devices on the same account share one session so token rotation does not invalidate another box.

## Night mode

Use the **Night mode** tile or the **Start night mode for … minutes** Flow action. This activates the box's native **sleep timer with light**. The default tile duration is 30 minutes and can be changed in device settings. Configure bedtime light color/brightness and speaker/headphone limits with separate Flow actions. Night mode state and countdown are updated from actual device replies, not optimistically assumed from a published command.

Stopping night mode cancels the sleep-light timer, not scheduled sunrise alarms or every possible bedtime routine. The box must be awake and online. A sleeping box cannot be woken via the cloud; squeeze an ear to wake it. There is no invented remote-wake action.

Starting night mode requires a fresh, non-retained bedtime reply with the requested state and duration, even when the cached timer state already matches. Stopping an already-confirmed-off timer is a no-op. Listening starts before publishing, so a reply arriving before the broker acknowledgment is not missed; unrelated telemetry cannot falsely confirm a timer command. A lost broker connection cancels pending confirmation. Homey serializes night actions in a separate bounded queue so one uncorrelated reply cannot confirm overlapping commands.

A confirmation timeout also cancels its pending SDK command, including one waiting for initial telemetry or broker acknowledgment, so the action cannot silently send a delayed night-mode command after reporting failure. Cancellation cannot undo an action the box has already processed.

## Playback and automations

The device supports play/pause, next/previous chapter, chapter selection, volume, volume steps, speaker volume limits, light-ring brightness, and immediate sleep. Volume percentages map to the box's 14 discrete levels; volume limits are separate from current volume. Homey chapter numbers start at 1. Precise time seeking is not supported: the box tested on August 30, 2026 restarted the selected chapter instead of honoring a nonzero offset.

Flow triggers include playback started/paused/ended, chapter or Tonie changes, night mode started/stopped, timer completed, online/offline, low battery, headphone connection changes, and settings applied. Retained snapshots and duplicate packets do not fire spurious playback-start triggers when the app restarts. Conditions expose playing, online, night mode, headphones, and a specific Tonie ID.

Example: **When playback starts → And a specific Tonie is on the box → Start night mode for 30 minutes**. You can also use a Homey time or bedtime routine trigger to start night mode on an already awake box.

## Runtime limits

Telemetry bursts keep only the newest waiting snapshot instead of building an unbounded promise chain. Meaningful Flow transitions remain ordered, with an explicit failure if more than 256 events are waiting. Unchanged capabilities are not written again. Metadata requests run separately from state/Flow updates, so a slow title lookup cannot delay night mode; each device keeps at most 16 metadata entries and one lookup in flight. A playback Flow's title may be empty until metadata is available, rather than delaying the trigger or using the previous Tonie's title.

Concurrent settings refreshes share one request, and countdown ticks share one write operation. Background failures use the existing error channel rather than becoming unhandled promises; valid subsequent state restores availability. Pairing discards superseded or disconnected logins, repairs cannot overlap, and device teardown drains all workers before releasing listeners, timers, metadata, and account ownership. Broker disconnects invalidate cached online/playback state and unknown night/headphone conditions, and commands are never replayed after acknowledgment timeout. None of these safeguards provide cloud wake or turn broker acknowledgment into proof of a physical device action.

The realtime SDK maintains credentials independently of settings polling, using one non-overlapping check every 30 seconds and no HTTP request while instance tokens remain valid. Rotated tokens are available to automatic MQTT reconnects. Next/previous and volume-step actions fail promptly when the broker or box goes offline rather than waiting for unavailable telemetry.

## Installation and packaging

The SDK comes directly from the public `kamilio/tonies-sdk` GitHub repository, pinned to a full commit in `package.json` and `package-lock.json`; no SDK package publication or private archive is required. npm prepares the SDK from source during installation. The app bundles only its cloud/realtime entry points, leaving MQTT as the sole direct production dependency; desktop storage, CLI tooling, and audio parsers are not deployed. Follow the [installation steps](README.md#install-from-github) to install on your Homey Pro. Building or pushing this repository does not install the app on a hub or publish it to the App Store.

`npm run test:memory` runs the regressions with explicit garbage collection, including a 20,000-snapshot burst, a retained-heap bound, capability-write counts, and repeated initialization/teardown. Timing diagnostics describe the machine running the test, not Homey hardware performance.

The build smoke test loads the generated SDK from an isolated temporary directory, checks every SDK method used by Homey, rejects desktop dependencies or fallback into the development installation, and enforces a 12 MiB deployment budget.

App manifests and raster artwork are generated by `scripts/build.mjs` from the definitions and vector assets; do not hand-edit `app.json`. Credentials, hardware IDs, or live account captures must not be committed. Full end-to-end behavior requires an online Toniebox 2 and a Homey Pro; mocked tests establish wire formats and app logic, not physical device effects.
