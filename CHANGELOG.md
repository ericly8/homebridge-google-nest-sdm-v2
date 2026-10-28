# Changelog

All notable changes to this fork are documented here. This project is a maintained
fork of [`homebridge-google-nest-sdm`](https://github.com/potmat/homebridge-google-nest-sdm)
by potmat; it follows the same ISC license.

## 2.0.7

### Fixed
- **Cameras no longer stay dead after a restart during a Google API bad spell.** Device
  discovery called Google's device LIST exactly once at startup; if it failed (Google's SDM
  API intermittently returns `HTTP 500 INTERNAL` — on 2026-10-28 roughly 5 of 6 LIST calls),
  every cached camera/doorbell stayed in HomeKit but was never wired up (no streams, no
  motion/ring events) until the next Homebridge restart. Discovery now retries with backoff
  (30s, 1m, 2m, 5m, then every 10m) until it succeeds, logging
  `Nest devices not set up yet: device list failed (HTTP 500). Retry N in …`. This covers
  `429` rate-limit responses too. A missing Pub/Sub setup (a permanent misconfiguration,
  already logged at startup) does not retry.
- **Discovery runs exactly once.** It latches before wiring accessories, so a second run —
  which would throw in HAP (`configureController` twice) and detach Pub/Sub events from the
  accessories — can't happen, even if wiring throws partway. A wiring error is now logged
  instead of becoming an unhandled rejection.
- **An empty device list can no longer wipe cached accessories.** If LIST returns no devices
  while accessories are cached, the stale-accessory cleanup is skipped and discovery retries
  (remove accessories manually in the Homebridge UI if that was intentional).

### Changed
- `list_devices()` returns a `{ok, devices} | {ok: false, reason, status}` result instead of
  a possibly-stale device array, so a failure can never be mistaken for the full device list.
- Smoke driver gained 13 checks: discovery retry-until-success, exactly-once, wiring-error
  latch, empty-list guard (both ways), not-subscribed, shutdown (mid-LIST, pending retry,
  after shutdown), capped retry delay, in-flight guard, and `list_devices` itself (an error —
  including one after a success — never carries a device list; not-subscribed is reported).
  Every guard was mutation-checked (each one, removed, fails a check).
- Discovery's `didFinishLaunching` and retry-timer calls now `.catch` and log instead of
  risking an unhandled rejection.

## 2.0.6

### Security
- **Bumped `ffmpeg-for-homebridge` `2.1.1` → `2.2.2`.** Clears the remaining transitive
  `tar` advisory (GHSA-vmf3-w455-68vh, `<= 7.5.15`) — the new version pulls patched
  `tar@7.5.16`. `tar` is only used by ffmpeg-for-homebridge's install step to unpack the
  bundled ffmpeg binary; the binary itself still provides the hardware encoders
  (`h264_videotoolbox` etc.).

### Changed
- **Raised the minimum Node version to `>=22`** (`engines.node`, was `>=18`).
  `ffmpeg-for-homebridge@2.2.2` itself requires Node ≥22, so the plugin's floor is raised
  to match and avoid an `EBADENGINE` mismatch.
- **The bundled ffmpeg binary moves from 6.x to 8.0** (carried by ffmpeg-for-homebridge
  2.2.2). It still ships `h264_videotoolbox`/`hevc_videotoolbox`; users with a custom
  `ffmpegPath` are unaffected.

The one remaining Dependabot `uuid` advisory (GHSA-w5hq-g745-h8pq) is **not applicable**:
it concerns `uuid` v3/v5/v6 when a `buf` argument is supplied, but every transitive
consumer here (gaxios, google-gax, werift) uses `uuid.v4()` with no buffer. Forcing a
`uuid@11` override across those packages' declared ranges would add risk without fixing a
reachable issue, so the alert is dismissed as not-affected rather than overridden.

## 2.0.5

### Security
- **Bumped `@google-cloud/pubsub` `^2.18.1` → `^4.11.0` (resolves 4.11.0).** Clears 13
  transitive Dependabot advisories that all came in through the old pubsub →
  `google-gax@2` → `@grpc/grpc-js@1.6` + `protobufjs` chain: 10 `protobufjs` (code
  injection / prototype-pollution / unbounded-recursion DoS), 2 `@grpc/grpc-js`
  (malformed-message crash), and 1 `@protobufjs/utf8`. v4 pulls patched
  `@grpc/grpc-js` 1.14.4 and `protobufjs` 7.6.4. (Chose v4 over v5 for a smaller
  dependency delta; v3 was insufficient — it caps grpc-js below the patched version.)
  The Pub/Sub event path in `src/sdm/Api.ts` (subscription + message ack/parse) is
  unchanged across the major — the `PubSub` constructor credentials option,
  `subscription()`, and `message` events behave identically.

### Changed
- **Dev toolchain: `typescript` `^4.4.3` → `~5.6`.** Required because pubsub v4's gax
  pulls `@opentelemetry/api` type definitions the old TypeScript parser can't read.
  Pinned to the `5.6` minor deliberately (TS ≥5.7 changes typed-array generics, which
  is unrelated churn). No runtime effect — `dist` is recompiled output only.
- **`src/sdm/Device.ts`: constrained the `executeCommand<T, …>` generic to
  `T extends Record<string, any> | null`.** Type-only fix so TypeScript 5.6 selects the
  correct SDM `executeCommand` overload (an unconstrained `T` no longer matched the
  request-body `params` shape). The command payload sent to Google is byte-identical.

Transitive advisories from the `googleapis` (uuid) and `ffmpeg-for-homebridge` (tar)
chains are tracked separately and require their own major upgrades.

## 2.0.4

### Security
- **Bumped `axios` `^1.3.5` → `^1.16.0` (resolves to 1.18.0).** Clears several Dependabot
  high-severity advisories: prototype-pollution gadgets (MitM via `config.proxy`, credential
  theft / response hijacking in config merge), `Proxy-Authorization` leak across HTTP→HTTPS
  redirect, and ReDoS via cookie-name injection. Only call site is the event-image `axios.get`
  in `src/sdm/Camera.ts`; the GET API and `AxiosError` shape are unchanged across 1.x, so no
  behavior change.
- **Bumped `systeminformation` `^5.9.3` → `^5.31.6` (resolves to 5.31.7).** Clears the
  high-severity Linux command-injection advisory in `networkInterfaces()`. This plugin only
  calls `networkInterfaceDefault()`, whose contract is unchanged.

Dependency-only release — no source changes. (Transitive advisories from the older
`@google-cloud/pubsub` / `googleapis` chains are tracked separately and require major
upgrades.)

## 2.0.3

### Fixed
- **Spurious "Error closing UDP connection to FFMpeg: Not running" log.** A snapshot grab
  on a camera that never streamed (e.g. "not available for streaming" / no media session)
  left the dgram socket unbound, so `teardown()` logged an error-level message on a normal
  path. The WebRTC streamer now nulls the peer connection/socket after closing (so the
  caller's `finally` teardown can't double-close) and treats `ERR_SOCKET_DGRAM_NOT_RUNNING`
  as benign (debug, not error).

## 2.0.2

Follow-up fixes from a full whole-codebase review, including two issues introduced by
the 2.0.1 hardening.

### Fixed
- **HKSV SIGKILL escalation never fired (regression in 2.0.1):** the new guard tested
  `!childProcess.killed`, but Node sets `killed` to `true` the instant a signal is *sent*,
  so the guard was always false and a stalled ffmpeg was never force-killed. Now checks
  `exitCode`/`signalCode` (true liveness), restoring the orphaned-process cleanup.
- **Device list pagination / stale-accessory safety:** `list_devices()` now follows
  `nextPageToken` and fetches every page. Previously only the first page was read, so on
  accounts with more devices than one page the 2.0.1 stale-accessory cleanup would
  unregister (and re-add) every device beyond page one on each run.
- **Recording-stream leak:** if the SDM stream `initialize()` failed during an HKSV
  recording request, the partially-opened WebRTC PeerConnection/UDP socket leaked because
  the session wasn't tracked yet; it is now torn down on failure.
- **Live-stream leak / crash on missing prepare:** `startStream` now bails cleanly when
  there is no matching prepared session instead of dereferencing it (which threw after the
  SDM stream was already opened, leaking it).
- **Falsy-zero in characteristic values:** `convertToNullable` mapped legitimate `false`
  and `0` to `null` — most notably reporting `null` for the normal eco-OFF state and for a
  0°C / 0% reading. It now only nulls `undefined`/`null`.
- **Unhandled rejection on camera events:** the motion/person/sound event handlers run
  inside the Pub/Sub message listener; a rejected `getVideoProtocol()` is now caught and
  logged instead of becoming an unhandled rejection.
- **Thermostat 0°C handling:** setpoint-range setters and the setpoint-changed event no
  longer treat a legitimate 0°C value as "unset" (truthy checks replaced with
  `undefined`/`null` checks; `||` fallbacks replaced with `??`).
- **HKSV recording audio:** audio is now encoded based on the *value* of the
  `RecordingAudioActive` characteristic rather than the mere presence of the characteristic
  object, so disabling recording audio is honored.

## 2.0.1

Hardening release following a full code review. No config or behavior changes for a
correctly configured setup; all items are robustness/correctness fixes.

### Fixed / Hardened
- **Pub/Sub message handler:** malformed event payloads are now caught and discarded
  with a warning instead of throwing inside the `message` listener; events without a
  `resourceUpdate` (e.g. resource-relation events) are tolerated.
- **Subscription errors are no longer fatal:** a transient Pub/Sub `error` no longer
  permanently disables the plugin — only a hard setup failure does. Events are
  redelivered by the auto-reconnecting client.
- **Startup config validation** reports exactly which required field(s) are missing,
  and still never logs the config object (which carries the client secret / refresh
  token).
- **Stale accessories** (a device removed from the account, or the Fan disabled) are now
  unregistered on successful discovery, instead of lingering as "not responding" tiles.
- **WebRTC keep-alive timer leak:** the RTCP-PLI interval is now cleared on every
  teardown and on the 429 abort path, so streams/snapshots/recordings no longer leak a
  timer per session.
- **AccessoryInformation** (Manufacturer/Model/Serial) is now set on the real service
  instead of a discarded throwaway one.
- **Thermostat setpoints:** `setTargetTemperatureRange` no longer falls through between
  HEAT/COOL cases; `setFan` only sends a duration when one is provided.
- **Stream/snapshot error paths:** snapshot, prepare-stream and start-stream failures are
  caught, summarized (no token leakage), and reported back via their callbacks instead of
  surfacing as unhandled rejections; failed stream starts tear down cleanly.
- **`setupEvents` is serialized** so concurrent invocations (constructor + mode/eco
  update handlers) can't interleave and leave threshold characteristics inconsistent.
- **EcoMode** custom characteristic is declared optional on the service to avoid
  Homebridge 2.x warnings.

### Changed
- Dev dependency `homebridge` bumped to `^1.6.0 || ^2.0.0` to compile against the v2 types
  it declares support for.

## 2.0.0

First release of the `homebridge-google-nest-sdm-v2` fork, based on upstream `1.1.23`.

### Added
- **Refreshing camera snapshots.** Home-app tiles show a recent frame instead of the
  static Nest/Google placeholder. Stills are grabbed on motion/person events and
  (optionally) when the Home app requests snapshots, via a single serialized,
  rate-limited queue. New options: `snapshotRefresh`, `snapshotRefreshOnAppOpen`,
  `snapshotRefreshSpacing`, `snapshotRefreshTtl`. (upstream #45)
- **`ffmpegPath` option** to use a custom ffmpeg binary (e.g. a hardware-accelerated
  build for `h264_qsv` / `h264_vaapi` / `h264_nvenc` / `h264_videotoolbox`), instead of
  being locked to the bundled binary.

### Fixed / Hardened
- **Security:** SDM command/list/event-image errors no longer log the full Axios error
  object, which contained the OAuth `Authorization: Bearer` token (and cookies). Errors
  are now summarized to status + message only. (relates to upstream #99)
- **Graceful 429 handling:** a `RESOURCE_EXHAUSTED` on WebRTC stream start now throws a
  clear "rate-limited" error instead of `TypeError: Cannot read properties of undefined
  (reading 'mediaSessionId')`. (upstream #99)
- **HKSV teardown:** recording streams now escalate to SIGKILL and always close the
  server/socket, and the recording generator tears down in a `finally` — reducing
  orphaned ffmpeg processes and growing memory use. (upstream #150)

### Changed
- **Homebridge v2 support:** `engines.homebridge` is now `^1.6.0 || ^2.0.0`. (upstream #200)
- Snapshot cache is stored under the Homebridge storage path (`api.user.storagePath()`),
  which is correct even when Homebridge runs under a non-login service account
  (e.g. Windows LocalSystem), rather than `os.homedir()`.
- Clearer config field descriptions and README setup guide: disambiguates the three
  "project" identifiers and foregrounds the required Pub/Sub OAuth scope.

### Attribution
- Original plugin © potmat; Homebridge plugin template © 2020 Andreas Bauer. ISC license
  retained. This fork is maintained on a best-effort basis and is not affiliated with Google.
