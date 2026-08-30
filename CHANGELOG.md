# Changelog

## [0.2.0](https://github.com/kamilio/tonies-homey/tree/v0.2.0) - 2026-08-30

### Added

- prepare store listing and automated SemVer releases ([e94b045](https://github.com/kamilio/tonies-homey/commit/e94b04510de6487c4a3427a7a1b7aec1c92dd8ff))

### Earlier work

- Clarify Tonies account login and verify automatic token renewal ([0f8afc0](https://github.com/kamilio/tonies-homey/commit/0f8afc0791907a11c6ea56f8d10caa3d4772ac82))
- Fix Homey SDK property collision and ship a verified Toniebox icon ([9995e70](https://github.com/kamilio/tonies-homey/commit/9995e70e808b7ac50d8b5499e98c4c245364fb90))
- Record verified Homey Pro installation and startup ([6d1d51e](https://github.com/kamilio/tonies-homey/commit/6d1d51e58a613ace314a53f1c6b2f6cedc69c261))
- Use public GitHub SDK dependency and add complete Homey card guide ([c20c93b](https://github.com/kamilio/tonies-homey/commit/c20c93bb60478c0db8f00f35a62b87b90ed4e6bd))
- Match live chapter behavior and verify Homey controls against hardware ([7299434](https://github.com/kamilio/tonies-homey/commit/7299434b07a28285af5fb23d3af4c5de2a04527c))
- Serialize night mode and confirm sleep preparation independently ([953e596](https://github.com/kamilio/tonies-homey/commit/953e596fb01aff1518ba34d8e9e57d5c3fd934c2))
- Cancel controls on box sleep and require fresh wake telemetry ([e14e4e1](https://github.com/kamilio/tonies-homey/commit/e14e4e1302d2baf63e080535c14f960b2f42f187))
- Preserve replacement credentials during concurrent device deletion ([352d868](https://github.com/kamilio/tonies-homey/commit/352d8689858c12f0af87a561aae72c8851b67707))
- Confirm and serialize playback controls without blocking night mode ([eba1ecc](https://github.com/kamilio/tonies-homey/commit/eba1ecca5f6ecc730cf99c8c1fc0da497f2e76f0))
- Serialize confirmed volume changes with bounded expiring queues ([9933786](https://github.com/kamilio/tonies-homey/commit/9933786228c30dbb863e988ad4c285a0baa2ba9a))
- Release failed cloud response streams in the Homey runtime ([ec70480](https://github.com/kamilio/tonies-homey/commit/ec7048035c64bebf101ad1c876ab0b047dda5e3f))
- Cancel device-scoped controls and drain settings writes during shutdown ([f567507](https://github.com/kamilio/tonies-homey/commit/f567507d13f0e27ad8d4d4c4ece915592f5cdf9d))
- Drive availability from telemetry and log isolated SDK failures ([e3ac608](https://github.com/kamilio/tonies-homey/commit/e3ac6085e06b08f3066fc2611cd960560b86d846))
- Preserve rotated credentials while draining closing accounts ([c50ce48](https://github.com/kamilio/tonies-homey/commit/c50ce4853e41723aba8d0557e0d9fe5c355ddfe5))
- Bound control bursts and reject stale disconnected telemetry ([f3187df](https://github.com/kamilio/tonies-homey/commit/f3187df396033f3b19a87e8b2b1d4e3260beeca0))
- Prevent delayed night-mode commands after confirmation timeout ([b31ab60](https://github.com/kamilio/tonies-homey/commit/b31ab608588abff325bc4a79c39832c52e296404))
- Keep idle Toniebox connections authenticated without settings polling ([45ed71f](https://github.com/kamilio/tonies-homey/commit/45ed71f4db5115288acba33d42c43f98830fa5fa))
- Confirm exact night-mode duration and reject interrupted confirmations ([eac4afe](https://github.com/kamilio/tonies-homey/commit/eac4afe2e83aa5bba3c546cef0dcfd87b9d63af8))
- Bundle cloud-only SDK and enforce Homey deployment size budget ([a123257](https://github.com/kamilio/tonies-homey/commit/a123257f8a4828de1a1fe720193c2954bf0a49e1))
- Recover availability after refresh and retry rejected MQTT reconnects ([134fae1](https://github.com/kamilio/tonies-homey/commit/134fae132930abe2e8600b2e6b912bb63a9b238e))
- Confirm fresh night-mode replies and drain background device work safely ([a7a0808](https://github.com/kamilio/tonies-homey/commit/a7a080838dafe61976a989cd416d3bb52d273028))
- Bound device state work and harden Homey account and pairing lifecycles ([0991ec4](https://github.com/kamilio/tonies-homey/commit/0991ec4ccdf482c7c34f74354b1d5c9c12808263))
- Build Toniebox 2 Homey app with night mode and playback flows ([056abd4](https://github.com/kamilio/tonies-homey/commit/056abd4e291a4842d10a039719fb66ef4b32170b))
