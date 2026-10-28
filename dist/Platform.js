"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Platform = void 0;
const Settings_1 = require("./Settings");
const CameraAccessory_1 = require("./CameraAccessory");
const Api_1 = require("./sdm/Api");
const ThermostatAccessory_1 = require("./ThermostatAccessory");
const Camera_1 = require("./sdm/Camera");
const Thermostat_1 = require("./sdm/Thermostat");
const Doorbell_1 = require("./sdm/Doorbell");
const DoorbellAccessory_1 = require("./DoorbellAccessory");
const EcoMode = require("./EcoMode");
const FanAccessory_1 = require("./FanAccessory");
const UnknownDevice_1 = require("./sdm/UnknownDevice");
const SnapshotRefresher = __importStar(require("./SnapshotRefresher"));
const util_1 = require("./util");
let IEcoMode;
/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
class Platform {
    constructor(log, platformConfig, api) {
        this.log = log;
        this.platformConfig = platformConfig;
        this.api = api;
        this.accessories = [];
        // Device discovery retries until Google's device LIST succeeds (it 500s in bad spells),
        // then latches: wiring an accessory twice throws in HAP (configureController) and would
        // detach Pub/Sub events from the accessories, so discovery must never run again.
        this.discovered = false;
        this.discoveryInFlight = false;
        this.shuttingDown = false;
        this.discoveryAttempt = 0;
        /** Wait before each retry after a failed discovery; the last value repeats. */
        this.discoveryRetryDelaysMs = [30000, 60000, 120000, 300000, 600000];
        this.debugMode = process.argv.includes('-D') || process.argv.includes('--debug');
        this.EcoMode = EcoMode(api);
        IEcoMode = this.EcoMode;
        this.config = platformConfig;
        const required = ['projectId', 'clientId', 'clientSecret', 'refreshToken', 'subscriptionId'];
        const missing = required.filter(k => !this.config || !this.config[k]);
        if (missing.length > 0) {
            // NEVER log the config object — it carries clientSecret + the OAuth refresh token.
            log.error(`${platformConfig.platform} is not configured correctly. Missing/empty required field(s): ${missing.join(', ')}`);
            return;
        }
        this.smartDeviceManagement = new Api_1.SmartDeviceManagement(this.config, log);
        this.api.on('shutdown', () => this.onShutdown());
        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on('didFinishLaunching', () => {
            var _a, _b;
            log.debug('Executed didFinishLaunching callback');
            // Configure the snapshot refresher once, rooted at the Homebridge storage path
            // (NOT os.homedir(), which is wrong under non-login service accounts).
            SnapshotRefresher.configure({
                storagePath: this.api.user.storagePath(),
                ffmpegPath: this.config.ffmpegPath,
                enabled: this.config.snapshotRefresh !== false,
                appOpenEnabled: this.config.snapshotRefreshOnAppOpen !== false,
                spacingMs: ((_a = this.config.snapshotRefreshSpacing) !== null && _a !== void 0 ? _a : 30) * 1000,
                ttlMs: ((_b = this.config.snapshotRefreshTtl) !== null && _b !== void 0 ? _b : 15) * 60000,
                log: this.log,
            });
            // run the method to discover / register your devices as accessories
            this.discoverDevices().catch(error => this.log.error('Device discovery failed: ' + (0, util_1.summarizeError)(error)));
        });
        this.Characteristic = Object.defineProperty(this.api.hap.Characteristic, 'EcoMode', { value: this.EcoMode });
    }
    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        // add the restored accessory to the accessories cache so we can track if it has already been registered
        this.accessories.push(accessory);
    }
    /**
     * This is an example method showing how to register discovered accessories.
     * Accessories must only be registered once, previously created accessories
     * must not be registered again to prevent "duplicate UUID" errors.
     */
    async discoverDevices() {
        if (!this.smartDeviceManagement || this.discovered || this.discoveryInFlight || this.shuttingDown)
            return;
        this.discoveryInFlight = true;
        try {
            const result = await this.smartDeviceManagement.list_devices();
            if (this.shuttingDown)
                return;
            if (!result.ok) {
                // Not subscribed is permanent (logged at startup) — retrying can't fix it.
                if (result.reason === 'error')
                    this.scheduleDiscoveryRetry(`device list failed${result.status ? ` (HTTP ${result.status})` : ''}`);
                return;
            }
            // An empty list while accessories are cached is far more likely a bad response than
            // every device being removed — don't let the stale cleanup wipe them all.
            if (result.devices.length === 0 && this.accessories.length > 0) {
                this.scheduleDiscoveryRetry(`Google returned no devices but ${this.accessories.length} are cached, so none were removed ` +
                    '(if you removed them all on purpose, remove the cached accessories in the Homebridge UI)');
                return;
            }
            // Latch BEFORE wiring, so a constructor that throws partway can't trigger a re-run
            // that double-wires the accessories already set up.
            this.discovered = true;
            if (this.discoveryAttempt > 0)
                this.log.info(`Device discovery succeeded on attempt ${this.discoveryAttempt + 1}.`);
            try {
                this.wireDevices(result.devices);
            }
            catch (error) {
                this.log.error('Failed to set up Nest accessories: ' + (0, util_1.summarizeError)(error));
            }
        }
        finally {
            this.discoveryInFlight = false;
        }
    }
    onShutdown() {
        this.shuttingDown = true;
        if (this.discoveryTimer) {
            clearTimeout(this.discoveryTimer);
            this.discoveryTimer = undefined;
        }
    }
    scheduleDiscoveryRetry(why) {
        var _a, _b;
        if (this.shuttingDown)
            return;
        const delays = this.discoveryRetryDelaysMs;
        const delay = delays[Math.min(this.discoveryAttempt, delays.length - 1)];
        this.discoveryAttempt++;
        const wait = delay >= 60000 ? `${Math.round(delay / 60000)} min` : `${Math.round(delay / 1000)}s`;
        this.log.warn(`Nest devices not set up yet: ${why}. Retry ${this.discoveryAttempt} in ${wait}.`);
        this.discoveryTimer = setTimeout(() => {
            this.discoveryTimer = undefined;
            this.discoverDevices().catch(error => this.log.error('Device discovery failed: ' + (0, util_1.summarizeError)(error)));
        }, delay);
        (_b = (_a = this.discoveryTimer).unref) === null || _b === void 0 ? void 0 : _b.call(_a);
    }
    /** Register/restore an accessory for each discovered device, then prune stale ones. Runs once. */
    wireDevices(devices) {
        const deviceInfos = devices
            .map(device => {
            const uuid = this.api.hap.uuid.generate(device.getName());
            const category = (() => {
                if (device instanceof Doorbell_1.Doorbell)
                    return 18 /* this.api.hap.Categories.VIDEO_DOORBELL */;
                else if (device instanceof Camera_1.Camera)
                    return 17 /* this.api.hap.Categories.CAMERA */;
                else if (device instanceof Thermostat_1.Thermostat)
                    return 9 /* this.api.hap.Categories.THERMOSTAT */;
                else if (device instanceof UnknownDevice_1.UnknownDevice)
                    return 1 /* this.api.hap.Categories.OTHER */;
            })();
            return {
                device: device,
                uuid: uuid,
                category: category,
                existingAccessory: this.accessories.find(accessory => accessory.UUID === uuid)
            };
        });
        devices.filter(device => device instanceof Thermostat_1.Thermostat).forEach(thermostatDevice => {
            if (this.config.showFan) {
                const uuid = this.api.hap.uuid.generate(thermostatDevice.getName() + ' Fan');
                deviceInfos.push({
                    device: thermostatDevice,
                    uuid: uuid,
                    category: 3 /* this.api.hap.Categories.FAN */,
                    existingAccessory: this.accessories.find(accessory => accessory.UUID === uuid)
                });
            }
        });
        // loop over the discovered devices and register each one if it has not already been registered
        for (const deviceInfo of deviceInfos) {
            if (deviceInfo.category === 1 /* this.api.hap.Categories.OTHER */)
                continue;
            if (deviceInfo.existingAccessory) {
                this.log.info('Restoring existing accessory from cache:', deviceInfo.existingAccessory.displayName);
                // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
                deviceInfo.existingAccessory.context.device = deviceInfo.device;
                this.api.updatePlatformAccessories([deviceInfo.existingAccessory]);
                switch (deviceInfo.category) {
                    case 18 /* this.api.hap.Categories.VIDEO_DOORBELL */:
                        new DoorbellAccessory_1.DoorbellAccessory(this.api, this.log, this, deviceInfo.existingAccessory, deviceInfo.device);
                        break;
                    case 17 /* this.api.hap.Categories.CAMERA */:
                        new CameraAccessory_1.CameraAccessory(this.api, this.log, this, deviceInfo.existingAccessory, deviceInfo.device);
                        break;
                    case 9 /* this.api.hap.Categories.THERMOSTAT */:
                        new ThermostatAccessory_1.ThermostatAccessory(this.api, this.log, this, deviceInfo.existingAccessory, deviceInfo.device);
                        break;
                    case 3 /* this.api.hap.Categories.FAN */:
                        new FanAccessory_1.FanAccessory(this.api, this.log, this, deviceInfo.existingAccessory, deviceInfo.device);
                        break;
                }
                // update accessory cache with any changes to the accessory details and information
                this.api.updatePlatformAccessories([deviceInfo.existingAccessory]);
            }
            else {
                switch (deviceInfo.category) {
                    case 18 /* this.api.hap.Categories.VIDEO_DOORBELL */:
                        const doorbellPlatformAccessory = this.getPlatformAccessory(deviceInfo.device, deviceInfo.device.getDisplayName(), deviceInfo.uuid, 18 /* this.api.hap.Categories.VIDEO_DOORBELL */);
                        new DoorbellAccessory_1.DoorbellAccessory(this.api, this.log, this, doorbellPlatformAccessory, deviceInfo.device);
                        this.api.registerPlatformAccessories(Settings_1.PLUGIN_NAME, Settings_1.PLATFORM_NAME, [doorbellPlatformAccessory]);
                        break;
                    case 17 /* this.api.hap.Categories.CAMERA */:
                        const cameraPlatformAccessory = this.getPlatformAccessory(deviceInfo.device, deviceInfo.device.getDisplayName(), deviceInfo.uuid, 17 /* this.api.hap.Categories.CAMERA */);
                        new CameraAccessory_1.CameraAccessory(this.api, this.log, this, cameraPlatformAccessory, deviceInfo.device);
                        this.api.registerPlatformAccessories(Settings_1.PLUGIN_NAME, Settings_1.PLATFORM_NAME, [cameraPlatformAccessory]);
                        break;
                    case 9 /* this.api.hap.Categories.THERMOSTAT */:
                        let thermostatPlatformAccessory = this.getPlatformAccessory(deviceInfo.device, deviceInfo.device.getDisplayName(), deviceInfo.uuid, 9 /* this.api.hap.Categories.THERMOSTAT */);
                        new ThermostatAccessory_1.ThermostatAccessory(this.api, this.log, this, thermostatPlatformAccessory, deviceInfo.device);
                        this.api.registerPlatformAccessories(Settings_1.PLUGIN_NAME, Settings_1.PLATFORM_NAME, [thermostatPlatformAccessory]);
                        break;
                    case 3 /* this.api.hap.Categories.FAN */:
                        let fanPlatformAccessory = this.getPlatformAccessory(deviceInfo.device, deviceInfo.device.getDisplayName() + ' Fan', deviceInfo.uuid, 3 /* this.api.hap.Categories.FAN */);
                        new FanAccessory_1.FanAccessory(this.api, this.log, this, fanPlatformAccessory, deviceInfo.device);
                        this.api.registerPlatformAccessories(Settings_1.PLUGIN_NAME, Settings_1.PLATFORM_NAME, [fanPlatformAccessory]);
                        break;
                }
            }
        }
        // Remove cached accessories that no longer map to a discovered device — e.g. a device was
        // removed from the account, or the Fan was disabled (showFan off). Only runs when discovery
        // succeeded (a failed or suspiciously empty LIST never reaches wireDevices), so a transient
        // API failure won't wipe accessories.
        const validUuids = new Set(deviceInfos.filter(d => d.category !== 1 /* this.api.hap.Categories.OTHER */).map(d => d.uuid));
        const stale = this.accessories.filter(a => !validUuids.has(a.UUID));
        if (stale.length > 0) {
            this.log.info(`Removing ${stale.length} stale accessory(ies): ${stale.map(a => a.displayName).join(', ')}`);
            this.api.unregisterPlatformAccessories(Settings_1.PLUGIN_NAME, Settings_1.PLATFORM_NAME, stale);
            for (const s of stale) {
                const idx = this.accessories.indexOf(s);
                if (idx >= 0)
                    this.accessories.splice(idx, 1);
            }
        }
    }
    getPlatformAccessory(device, name, uuid, category) {
        this.log.info('Adding new accessory:', name);
        const accessory = new this.api.platformAccessory(name || "Unknown Name", uuid, category);
        accessory.context.device = device;
        return accessory;
    }
}
exports.Platform = Platform;
//# sourceMappingURL=Platform.js.map