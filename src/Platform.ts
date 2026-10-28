import {
    API,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Characteristic,
    Categories
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './Settings';
import { CameraAccessory } from './CameraAccessory';
import {SmartDeviceManagement} from './sdm/Api';
import {Config} from "./Config";
import {ThermostatAccessory} from "./ThermostatAccessory";
import {Camera} from "./sdm/Camera";
import {Thermostat} from "./sdm/Thermostat";
import {Doorbell} from "./sdm/Doorbell";
import {DoorbellAccessory} from "./DoorbellAccessory";
import EcoMode = require('./EcoMode');
import {FanAccessory} from "./FanAccessory";
import {Device} from "./sdm/Device";
import {UnknownDevice} from "./sdm/UnknownDevice";
import * as SnapshotRefresher from "./SnapshotRefresher";
import {summarizeError} from "./util";

let IEcoMode: any;

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class Platform implements DynamicPlatformPlugin {
    public readonly Characteristic: typeof Characteristic & typeof IEcoMode;
    public readonly debugMode: boolean;
    private readonly smartDeviceManagement: SmartDeviceManagement | undefined;
    private readonly accessories: PlatformAccessory[] = [];
    private readonly EcoMode;
    private readonly config: Config;

    // Device discovery retries until Google's device LIST succeeds (it 500s in bad spells),
    // then latches: wiring an accessory twice throws in HAP (configureController) and would
    // detach Pub/Sub events from the accessories, so discovery must never run again.
    private discovered = false;
    private discoveryInFlight = false;
    private shuttingDown = false;
    private discoveryTimer: NodeJS.Timeout | undefined;
    private discoveryAttempt = 0;
    /** Wait before each retry after a failed discovery; the last value repeats. */
    discoveryRetryDelaysMs = [30_000, 60_000, 120_000, 300_000, 600_000];

    constructor(
        public readonly log: Logger,
        public readonly platformConfig: PlatformConfig,
        public readonly api: API,
    ) {
        this.debugMode = process.argv.includes('-D') || process.argv.includes('--debug');
        this.EcoMode = EcoMode(api);
        IEcoMode = this.EcoMode;

        this.config = platformConfig as unknown as Config;
        const required = ['projectId', 'clientId', 'clientSecret', 'refreshToken', 'subscriptionId'] as const;
        const missing = required.filter(k => !this.config || !(this.config as unknown as Record<string, unknown>)[k]);
        if (missing.length > 0) {
            // NEVER log the config object — it carries clientSecret + the OAuth refresh token.
            log.error(`${platformConfig.platform} is not configured correctly. Missing/empty required field(s): ${missing.join(', ')}`);
            return;
        }

        this.smartDeviceManagement = new SmartDeviceManagement(this.config, log);
        this.api.on('shutdown', () => this.onShutdown());
        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            // Configure the snapshot refresher once, rooted at the Homebridge storage path
            // (NOT os.homedir(), which is wrong under non-login service accounts).
            SnapshotRefresher.configure({
                storagePath: this.api.user.storagePath(),
                ffmpegPath: this.config.ffmpegPath,
                enabled: this.config.snapshotRefresh !== false,
                appOpenEnabled: this.config.snapshotRefreshOnAppOpen !== false,
                spacingMs: (this.config.snapshotRefreshSpacing ?? 30) * 1000,
                ttlMs: (this.config.snapshotRefreshTtl ?? 15) * 60000,
                log: this.log,
            });
            // run the method to discover / register your devices as accessories
            this.discoverDevices().catch(error => this.log.error('Device discovery failed: ' + summarizeError(error)));
        });

        this.Characteristic = Object.defineProperty(this.api.hap.Characteristic, 'EcoMode', {value: this.EcoMode});
    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory: PlatformAccessory) {
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
            } catch (error: any) {
                this.log.error('Failed to set up Nest accessories: ' + summarizeError(error));
            }
        } finally {
            this.discoveryInFlight = false;
        }
    }

    private onShutdown() {
        this.shuttingDown = true;
        if (this.discoveryTimer) {
            clearTimeout(this.discoveryTimer);
            this.discoveryTimer = undefined;
        }
    }

    private scheduleDiscoveryRetry(why: string) {
        if (this.shuttingDown)
            return;
        const delays = this.discoveryRetryDelaysMs;
        const delay = delays[Math.min(this.discoveryAttempt, delays.length - 1)];
        this.discoveryAttempt++;
        const wait = delay >= 60_000 ? `${Math.round(delay / 60_000)} min` : `${Math.round(delay / 1000)}s`;
        this.log.warn(`Nest devices not set up yet: ${why}. Retry ${this.discoveryAttempt} in ${wait}.`);
        this.discoveryTimer = setTimeout(() => {
            this.discoveryTimer = undefined;
            this.discoverDevices().catch(error => this.log.error('Device discovery failed: ' + summarizeError(error)));
        }, delay);
        this.discoveryTimer.unref?.();
    }

    /** Register/restore an accessory for each discovered device, then prune stale ones. Runs once. */
    private wireDevices(devices: Device[]) {

        const deviceInfos = devices
            .map(device => {
                const uuid = this.api.hap.uuid.generate(device.getName());
                const category = (() => {
                    if (device instanceof Doorbell)
                        return this.api.hap.Categories.VIDEO_DOORBELL;
                    else if (device instanceof Camera)
                        return this.api.hap.Categories.CAMERA;
                    else if (device instanceof Thermostat)
                        return this.api.hap.Categories.THERMOSTAT;
                    else if (device instanceof UnknownDevice)
                        return this.api.hap.Categories.OTHER;
                })();

                return {
                    device: device,
                    uuid: uuid,
                    category: category,
                    existingAccessory: this.accessories.find(accessory => accessory.UUID === uuid)
                }
            });

        devices.filter(device => device instanceof Thermostat).forEach(thermostatDevice => {
            if (this.config.showFan) {
                const uuid = this.api.hap.uuid.generate(thermostatDevice.getName() + ' Fan');
                deviceInfos.push({
                    device: thermostatDevice,
                    uuid: uuid,
                    category: this.api.hap.Categories.FAN,
                    existingAccessory: this.accessories.find(accessory => accessory.UUID === uuid)
                })
            }
        });

        // loop over the discovered devices and register each one if it has not already been registered
        for (const deviceInfo of deviceInfos) {

            if (deviceInfo.category === this.api.hap.Categories.OTHER)
                continue;

            if (deviceInfo.existingAccessory) {
                this.log.info('Restoring existing accessory from cache:', deviceInfo.existingAccessory.displayName);

                // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
                deviceInfo.existingAccessory.context.device = deviceInfo.device;
                this.api.updatePlatformAccessories([deviceInfo.existingAccessory]);

                switch (deviceInfo.category) {
                    case this.api.hap.Categories.VIDEO_DOORBELL:
                        new DoorbellAccessory(this.api, this.log, this, deviceInfo.existingAccessory, deviceInfo.device as Doorbell);
                        break;
                    case this.api.hap.Categories.CAMERA:
                        new CameraAccessory(this.api, this.log, this, deviceInfo.existingAccessory, deviceInfo.device as Camera);
                        break;
                    case this.api.hap.Categories.THERMOSTAT:
                        new ThermostatAccessory(this.api, this.log, this, deviceInfo.existingAccessory, deviceInfo.device as Thermostat);
                        break;
                    case this.api.hap.Categories.FAN:
                        new FanAccessory(this.api, this.log, this, deviceInfo.existingAccessory, deviceInfo.device as Thermostat);
                        break;
                }

                // update accessory cache with any changes to the accessory details and information
                this.api.updatePlatformAccessories([deviceInfo.existingAccessory]);
            } else {
                switch (deviceInfo.category) {
                    case this.api.hap.Categories.VIDEO_DOORBELL:
                        const doorbellPlatformAccessory = this.getPlatformAccessory(deviceInfo.device, deviceInfo.device.getDisplayName(), deviceInfo.uuid, this.api.hap.Categories.VIDEO_DOORBELL);
                        new DoorbellAccessory(this.api, this.log, this, doorbellPlatformAccessory, deviceInfo.device as Doorbell);
                        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [doorbellPlatformAccessory]);
                        break;
                    case this.api.hap.Categories.CAMERA:
                        const cameraPlatformAccessory = this.getPlatformAccessory(deviceInfo.device, deviceInfo.device.getDisplayName(), deviceInfo.uuid, this.api.hap.Categories.CAMERA);
                        new CameraAccessory(this.api, this.log, this, cameraPlatformAccessory, deviceInfo.device as Camera);
                        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cameraPlatformAccessory]);
                        break;
                    case this.api.hap.Categories.THERMOSTAT:
                        let thermostatPlatformAccessory = this.getPlatformAccessory(deviceInfo.device, deviceInfo.device.getDisplayName(), deviceInfo.uuid, this.api.hap.Categories.THERMOSTAT);
                        new ThermostatAccessory(this.api, this.log, this, thermostatPlatformAccessory, deviceInfo.device as Thermostat);
                        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [thermostatPlatformAccessory]);
                        break;
                    case this.api.hap.Categories.FAN:
                        let fanPlatformAccessory = this.getPlatformAccessory(deviceInfo.device, deviceInfo.device.getDisplayName() + ' Fan', deviceInfo.uuid, this.api.hap.Categories.FAN);
                        new FanAccessory(this.api, this.log, this, fanPlatformAccessory, deviceInfo.device as Thermostat);
                        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [fanPlatformAccessory]);
                        break;
                }
            }
        }

        // Remove cached accessories that no longer map to a discovered device — e.g. a device was
        // removed from the account, or the Fan was disabled (showFan off). Only runs when discovery
        // succeeded (a failed or suspiciously empty LIST never reaches wireDevices), so a transient
        // API failure won't wipe accessories.
        const validUuids = new Set(
            deviceInfos.filter(d => d.category !== this.api.hap.Categories.OTHER).map(d => d.uuid),
        );
        const stale = this.accessories.filter(a => !validUuids.has(a.UUID));
        if (stale.length > 0) {
            this.log.info(`Removing ${stale.length} stale accessory(ies): ${stale.map(a => a.displayName).join(', ')}`);
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
            for (const s of stale) {
                const idx = this.accessories.indexOf(s);
                if (idx >= 0) this.accessories.splice(idx, 1);
            }
        }
    }

    private getPlatformAccessory(device: Device, name: string, uuid: string, category: Categories) {
        this.log.info('Adding new accessory:', name);
        const accessory = new this.api.platformAccessory(name || "Unknown Name", uuid, category);
        accessory.context.device = device;
        return accessory;
    }
}
