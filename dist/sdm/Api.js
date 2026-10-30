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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmartDeviceManagement = void 0;
const lodash_1 = __importDefault(require("lodash"));
const google = __importStar(require("googleapis"));
const pubsub = __importStar(require("@google-cloud/pubsub"));
const Camera_1 = require("./Camera");
const Doorbell_1 = require("./Doorbell");
const Thermostat_1 = require("./Thermostat");
const UnknownDevice_1 = require("./UnknownDevice");
const Display_1 = require("./Display");
const util_1 = require("../util");
class SmartDeviceManagement {
    constructor(config, log) {
        this.subscribed = true;
        this.log = log;
        this.oauth2Client = new google.Auth.OAuth2Client(config.clientId, config.clientSecret);
        this.projectId = config.projectId;
        this.oauth2Client.setCredentials({
            refresh_token: config.refreshToken
        });
        this.smartdevicemanagement = new google.smartdevicemanagement_v1.Smartdevicemanagement({
            auth: this.oauth2Client
        });
        try {
            this.pubSubClient = new pubsub.PubSub({
                //use GCP project ID if it's present
                projectId: config.gcpProjectId || config.projectId,
                credentials: {
                    // @ts-ignore
                    type: 'authorized_user',
                    // @ts-ignore
                    client_id: config.clientId,
                    // @ts-ignore
                    client_secret: config.clientSecret,
                    // @ts-ignore
                    refresh_token: config.refreshToken
                }
            });
            this.subscription = this.pubSubClient.subscription(config.subscriptionId);
            this.subscription.on('message', message => {
                message.ack();
                if (!this.devices)
                    return;
                this.log.debug('Event received: ' + message.data.toString());
                let event;
                try {
                    event = JSON.parse(message.data.toString());
                }
                catch (error) {
                    this.log.warn('Discarding malformed Pub/Sub event: ' + (0, util_1.summarizeError)(error));
                    return;
                }
                // Not every event carries resourceUpdate (e.g. resource-relation events) — guard it.
                const resourceUpdate = event.resourceUpdate;
                if (resourceUpdate === null || resourceUpdate === void 0 ? void 0 : resourceUpdate.events) {
                    const resourceEventEvent = event;
                    const device = lodash_1.default.find(this.devices, device => device.getName() === resourceEventEvent.resourceUpdate.name);
                    if (device)
                        device.event(resourceEventEvent);
                }
                else if (resourceUpdate === null || resourceUpdate === void 0 ? void 0 : resourceUpdate.traits) {
                    const resourceTraitEvent = event;
                    const device = lodash_1.default.find(this.devices, device => device.getName() === resourceTraitEvent.resourceUpdate.name);
                    if (device)
                        device.event(resourceTraitEvent);
                }
            });
            this.subscription.on('error', error => {
                // A transient subscription error should NOT permanently stop the plugin: events are
                // redelivered by the auto-reconnecting Pub/Sub client, and device discovery uses the
                // REST API independently. Only a hard setup failure (constructor catch) disables.
                this.log.error("Event subscription error. If this persists, ensure your refresh token was generated with the Pub/Sub scope - see https://github.com/nnmb2vgw4r-sudo/homebridge-google-nest-sdm-v2#-the-pubsub-scope-step--dont-skip-this -- " + (0, util_1.summarizeError)(error));
            });
        }
        catch (error) {
            this.log.error("Plugin initialization failed, there was a failure with event subscription. Make sure your refresh token was generated with the Pub/Sub scope - see https://github.com/nnmb2vgw4r-sudo/homebridge-google-nest-sdm-v2#-the-pubsub-scope-step--dont-skip-this -- " + (0, util_1.summarizeError)(error));
            this.subscribed = false;
        }
    }
    async list_devices() {
        var _a, _b;
        // Permanent: the Pub/Sub setup failed in the constructor (already logged there).
        if (!this.subscribed)
            return { ok: false, reason: 'not-subscribed' };
        try {
            // Follow nextPageToken to fetch ALL devices. Without this we only ever see the first
            // page; combined with the stale-accessory cleanup in Platform.discoverDevices, any
            // device beyond page one would be unregistered (and oscillate) on every run.
            const rawDevices = [];
            let pageToken = undefined;
            do {
                const response = await this.smartdevicemanagement.enterprises.devices.list({ parent: `enterprises/${this.projectId}`, pageToken });
                if (response.data.devices)
                    rawDevices.push(...response.data.devices);
                pageToken = (_a = response.data.nextPageToken) !== null && _a !== void 0 ? _a : undefined;
            } while (pageToken);
            this.log.debug('Receieved list of devices: ', rawDevices);
            this.devices = (0, lodash_1.default)(rawDevices)
                .filter(device => device.name !== null)
                .map(device => {
                switch (device.type) {
                    case 'sdm.devices.types.DOORBELL':
                        return new Doorbell_1.Doorbell(this.smartdevicemanagement, device, this.log);
                    case 'sdm.devices.types.CAMERA':
                        return new Camera_1.Camera(this.smartdevicemanagement, device, this.log);
                    case 'sdm.devices.types.DISPLAY':
                        return new Display_1.Display(this.smartdevicemanagement, device, this.log);
                    case 'sdm.devices.types.THERMOSTAT':
                        return new Thermostat_1.Thermostat(this.smartdevicemanagement, device, this.log);
                    default:
                        return new UnknownDevice_1.UnknownDevice(this.smartdevicemanagement, device, this.log);
                }
            })
                .value();
            return { ok: true, devices: this.devices };
        }
        catch (error) {
            this.log.error('Could not execute device LIST request: ' + (0, util_1.summarizeError)(error));
            return { ok: false, reason: 'error', status: (_b = error === null || error === void 0 ? void 0 : error.response) === null || _b === void 0 ? void 0 : _b.status };
        }
    }
}
exports.SmartDeviceManagement = SmartDeviceManagement;
//# sourceMappingURL=Api.js.map