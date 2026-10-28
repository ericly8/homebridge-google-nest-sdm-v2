#!/usr/bin/env node
// Smoke driver for homebridge-google-nest-sdm-v2.
//
// A Homebridge *plugin* cannot be "launched" on its own — it is loaded by the
// Homebridge runtime, which hands it an `api` object and (with valid Google SDM
// credentials + real Nest devices) drives it. There is no window to screenshot
// and no standalone server. So this driver does the next best, fully-offline
// thing: it loads the BUILT plugin (dist/) the way Homebridge would, asserts the
// registration contract, and exercises the internals that PRs here actually
// touch — config validation, the token-redaction security path, and ffmpeg
// resolution — with mock Homebridge/HAP objects. No network, no credentials.
//
// Usage:  node .claude/skills/run-homebridge-google-nest-sdm-v2/driver.mjs
// Requires a prior `npm run build` (so dist/ exists). Exits non-zero on any failure.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import bufferMod from 'node:buffer';

// HARNESS-ONLY SHIM (does not affect the shipped plugin or the live runtime):
// Node >= 25 removed `buffer.SlowBuffer`, which a transitive googleapis auth dep
// (buffer-equal-constant-time) reads at require-time -> "Cannot read properties of
// undefined (reading 'prototype')". The deployed Homebridge runtime is Node <= 24 where
// SlowBuffer still exists, so production is unaffected; we shim it so this offline smoke
// can load the module graph on newer Node too.
if (!bufferMod.SlowBuffer) bufferMod.SlowBuffer = Buffer;

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNIT = path.resolve(HERE, '../../..'); // <unit>/.claude/skills/run-xxx -> <unit>
const dist = (p) => path.join(UNIT, 'dist', p);

let failures = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); };
function check(name, fn) {
  try { fn(); ok(name); }
  catch (e) { bad(name, e && e.message ? e.message : String(e)); }
}

if (!existsSync(dist('index.js'))) {
  console.error('dist/index.js not found — run `npm run build` first.');
  process.exit(2);
}

console.log('homebridge-google-nest-sdm-v2 smoke driver\n');

// --- T1: the full built module graph loads (catches a bad import / missing dep) ---
let indexExport, Platform, Settings, util;
check('module graph loads (require dist/index.js + Platform + util)', () => {
  indexExport = require(dist('index.js'));
  Platform = require(dist('Platform.js')).Platform;
  Settings = require(dist('Settings.js'));
  util = require(dist('util.js'));
  if (typeof indexExport !== 'function') throw new Error('index.js does not export a function');
  if (typeof Platform !== 'function') throw new Error('Platform is not a class/function');
});

// --- T2: registration contract — index(api) calls registerPlatform(PLATFORM_NAME, Platform) ---
check('registers platform under the stable alias', () => {
  const calls = [];
  const fakeApi = { registerPlatform: (name, ctor) => calls.push([name, ctor]) };
  indexExport(fakeApi);
  if (calls.length !== 1) throw new Error(`expected 1 registerPlatform call, got ${calls.length}`);
  const [name, ctor] = calls[0];
  if (name !== Settings.PLATFORM_NAME) throw new Error(`registered name ${name} != PLATFORM_NAME ${Settings.PLATFORM_NAME}`);
  if (name !== 'homebridge-google-nest-sdm') throw new Error(`alias drifted from 'homebridge-google-nest-sdm' to '${name}' (breaks existing configs)`);
  if (ctor !== Platform) throw new Error('registered constructor is not Platform');
});

// --- T3: config validation — empty config logs the missing-fields error and does NOT throw/crash ---
check('missing config is reported, not crashed', () => {
  const logs = { error: [], warn: [], info: [], debug: [] };
  const mkLog = (k) => (...a) => logs[k].push(a.join(' '));
  const log = { error: mkLog('error'), warn: mkLog('warn'), info: mkLog('info'), debug: mkLog('debug') };
  class Characteristic {} // EcoMode(api) subclasses this; never instantiated on the missing-config path
  const api = { hap: { Characteristic }, on: () => {}, user: { storagePath: () => '/tmp/hb-smoke' } };

  // Empty config -> constructor must early-return after logging which required fields are missing.
  new Platform(log, { platform: 'homebridge-google-nest-sdm' }, api);

  const msg = logs.error.find((m) => /Missing\/empty required field/i.test(m));
  if (!msg) throw new Error('expected an error naming the missing required fields; got: ' + JSON.stringify(logs.error));
  for (const field of ['projectId', 'clientId', 'clientSecret', 'refreshToken', 'subscriptionId'])
    if (!msg.includes(field)) throw new Error(`missing-fields error omitted '${field}': ${msg}`);
  // Must not have leaked a config object / thrown.
});

// --- T4 (security): summarizeError never leaks the OAuth bearer token / headers ---
check('summarizeError redacts credentials', () => {
  const SECRET = 'ya29.SUPER_SECRET_BEARER_TOKEN_zzz';
  const gaxiosLike = {
    message: 'Request failed with status code 401',
    response: { status: 401, statusText: 'Unauthorized', data: { error: { message: 'Invalid Credentials' } } },
    config: { headers: { Authorization: 'Bearer ' + SECRET, cookie: 'session=' + SECRET }, url: 'https://smartdevicemanagement.googleapis.com/...' },
    request: { _header: 'Authorization: Bearer ' + SECRET },
  };
  const out = util.summarizeError(gaxiosLike);
  if (out.includes(SECRET)) throw new Error('LEAK: token appeared in summary -> ' + out);
  if (!out.includes('401')) throw new Error('expected HTTP status in summary -> ' + out);
  if (!out.includes('Invalid Credentials')) throw new Error('expected API message in summary -> ' + out);
});

// --- T5: ffmpeg path resolution honors an explicit path, else falls back to a real string ---
check('resolveFfmpegPath honors explicit path and has a fallback', () => {
  if (util.resolveFfmpegPath('/opt/custom/ffmpeg') !== '/opt/custom/ffmpeg')
    throw new Error('explicit ffmpegPath was not honored');
  const fallback = util.resolveFfmpegPath();
  if (typeof fallback !== 'string' || fallback.length === 0)
    throw new Error('fallback ffmpeg path was empty');
  console.log(`        (fallback ffmpeg: ${fallback})`);
});

// --- T6: discovery retries a failed LIST, latches once, guards empty lists ---------------
// Build a Platform without its constructor (no Pub/Sub, no network) and drive
// discoverDevices() against a scripted fake SDM client. wireDevices is stubbed: these
// checks are about WHEN wiring happens, not what it does.
const keepAlive = setInterval(() => {}, 1000); // unref'd retry timers alone won't hold Node open
const tick = () => new Promise((r) => setTimeout(r, 5));
async function checkAsync(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { bad(name, e && e.message ? e.message : String(e)); }
}
function fakePlatform(results, cached = 0) {
  const pf = Object.create(Platform.prototype);
  const calls = { list: 0, wire: 0, unregister: 0, warn: [] };
  Object.assign(pf, {
    log: { info: () => {}, debug: () => {}, error: () => {}, warn: (m) => calls.warn.push(m) },
    accessories: Array.from({ length: cached }, (_, i) => ({ UUID: 'u' + i, displayName: 'cam' + i })),
    api: { unregisterPlatformAccessories: () => calls.unregister++ },
    discovered: false, discoveryInFlight: false, shuttingDown: false, discoveryAttempt: 0,
    discoveryRetryDelaysMs: [0],
    smartDeviceManagement: { list_devices: async () => { calls.list++; return results[Math.min(calls.list - 1, results.length - 1)]; } },
    wireDevices: () => calls.wire++,
  });
  return { pf, calls };
}
const FAIL = { ok: false, reason: 'error', status: 500 };
const OK = { ok: true, devices: [{}] };

await checkAsync('failed LIST retries until success, then wires exactly once', async () => {
  const { pf, calls } = fakePlatform([FAIL, FAIL, OK]);
  await pf.discoverDevices();
  for (let i = 0; i < 20 && !pf.discovered; i++) await tick();
  if (calls.list !== 3) throw new Error(`expected 3 LIST calls, got ${calls.list}`);
  if (calls.wire !== 1) throw new Error(`expected 1 wire, got ${calls.wire}`);
  if (pf.discoveryTimer) throw new Error('retry timer left armed after success');
  if (!calls.warn.some((m) => /HTTP 500/.test(m))) throw new Error('retry warn did not name the HTTP status');
});

await checkAsync('discovery never runs again after success', async () => {
  const { pf, calls } = fakePlatform([OK]);
  await pf.discoverDevices();
  await pf.discoverDevices();
  if (calls.list !== 1 || calls.wire !== 1) throw new Error(`list=${calls.list} wire=${calls.wire}, want 1/1`);
});

await checkAsync('empty LIST with cached accessories retries and removes nothing', async () => {
  const { pf, calls } = fakePlatform([{ ok: true, devices: [] }, OK], 2);
  await pf.discoverDevices();
  if (calls.wire !== 0 || calls.unregister !== 0) throw new Error('empty list was wired/pruned');
  for (let i = 0; i < 20 && !pf.discovered; i++) await tick();
  if (calls.wire !== 1) throw new Error(`expected wiring after the retry, got ${calls.wire}`);
});

await checkAsync('empty LIST with nothing cached is a normal success', async () => {
  const { pf, calls } = fakePlatform([{ ok: true, devices: [] }]);
  await pf.discoverDevices();
  if (calls.wire !== 1 || pf.discoveryTimer) throw new Error(`wire=${calls.wire}, timer=${!!pf.discoveryTimer}`);
});

await checkAsync('not-subscribed does not retry', async () => {
  const { pf, calls } = fakePlatform([{ ok: false, reason: 'not-subscribed' }]);
  await pf.discoverDevices();
  await tick();
  if (calls.list !== 1 || pf.discoveryTimer || calls.wire !== 0) throw new Error(`list=${calls.list} timer=${!!pf.discoveryTimer}`);
});

await checkAsync('shutdown during a LIST wires nothing and schedules nothing', async () => {
  const { pf, calls } = fakePlatform([OK]);
  const p = pf.discoverDevices();
  pf.shuttingDown = true;
  await p;
  if (calls.wire !== 0 || pf.discoveryTimer) throw new Error(`wire=${calls.wire} timer=${!!pf.discoveryTimer}`);
});
await checkAsync('a wiring error latches discovery (no re-run that double-wires)', async () => {
  const { pf, calls } = fakePlatform([OK]);
  pf.wireDevices = () => { calls.wire++; throw new Error('boom'); };
  await pf.discoverDevices();
  await pf.discoverDevices();
  if (calls.list !== 1 || pf.discoveryTimer) throw new Error(`list=${calls.list} timer=${!!pf.discoveryTimer}`);
});
await checkAsync('shutdown cancels a pending retry', async () => {
  const { pf, calls } = fakePlatform([FAIL]);
  pf.discoveryRetryDelaysMs = [50];
  await pf.discoverDevices();
  if (!pf.discoveryTimer) throw new Error('no retry armed after a failure');
  pf.onShutdown();
  if (pf.discoveryTimer) throw new Error('shutdown left the retry timer armed');
  await new Promise((r) => setTimeout(r, 80));
  if (calls.list !== 1) throw new Error(`LIST ran ${calls.list}x after shutdown`);
  pf.scheduleDiscoveryRetry('test');
  if (pf.discoveryTimer) throw new Error('a retry was scheduled after shutdown');
  await pf.discoverDevices();
  if (calls.list !== 1) throw new Error('discoverDevices ran a LIST after shutdown');
});

await checkAsync('retry delay stays at the last value (no tight loop)', async () => {
  const { pf, calls } = fakePlatform([FAIL, FAIL, FAIL, FAIL, OK]);
  await pf.discoverDevices();
  for (let i = 0; i < 40 && !pf.discovered; i++) await tick();
  if (calls.warn.length < 4) throw new Error(`expected 4 retry warnings, got ${calls.warn.length}`);
  const badWarn = calls.warn.find((m) => !/ in 0s\.$/.test(m));
  if (badWarn) throw new Error('retry delay not the capped last value: ' + badWarn);
});

await checkAsync('a second call while a LIST is in flight is ignored', async () => {
  const { pf, calls } = fakePlatform([OK]);
  const first = pf.discoverDevices();
  await pf.discoverDevices();
  await first;
  if (calls.list !== 1) throw new Error(`LIST ran ${calls.list}x`);
});

// list_devices itself: a failure must never carry a device list.
const { SmartDeviceManagement } = require(dist('sdm/Api.js'));
function fakeSdm(listImpl, subscribed = true) {
  const sdm = Object.create(SmartDeviceManagement.prototype);
  Object.assign(sdm, {
    subscribed, projectId: 'p', devices: undefined,
    log: { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} },
    smartdevicemanagement: { enterprises: { devices: { list: listImpl } } },
  });
  return sdm;
}
await checkAsync('list_devices: an API error returns ok:false with the status and no devices', async () => {
  const sdm = fakeSdm(async () => { throw { response: { status: 500 } }; });
  const r = await sdm.list_devices();
  if (r.ok !== false || r.reason !== 'error' || r.status !== 500 || 'devices' in r)
    throw new Error('got ' + JSON.stringify(r));
});
await checkAsync('list_devices: an error after a success still returns no devices', async () => {
  let n = 0;
  const sdm = fakeSdm(async () => { if (n++ === 0) return { data: { devices: [] } }; throw { response: { status: 429 } }; });
  const first = await sdm.list_devices();
  if (first.ok !== true) throw new Error('first call should succeed: ' + JSON.stringify(first));
  const r = await sdm.list_devices();
  if (r.ok !== false || 'devices' in r || r.status !== 429) throw new Error('got ' + JSON.stringify(r));
});
await checkAsync('list_devices: not subscribed is reported as such', async () => {
  const r = await fakeSdm(async () => ({ data: {} }), false).list_devices();
  if (r.ok !== false || r.reason !== 'not-subscribed') throw new Error('got ' + JSON.stringify(r));
});
clearInterval(keepAlive);

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
