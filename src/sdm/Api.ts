import _ from 'lodash';
import * as google from 'googleapis';
import * as pubsub from '@google-cloud/pubsub';
import {Logger} from 'homebridge';
import {Config} from "../Config";
import * as Events from './Events';
import {Device} from "./Device";
import {Camera} from "./Camera";
import {Doorbell} from "./Doorbell";
import {Thermostat} from "./Thermostat";
import {UnknownDevice} from "./UnknownDevice";
import {Display} from "./Display";
import {summarizeError} from "../util";

/**
 * Outcome of a device LIST. A failure never carries a (possibly stale) device list, so a
 * caller can't mistake an error for "these are all the devices" and prune accessories.
 */
export type ListDevicesResult =
    | {ok: true, devices: Device[]}
    | {ok: false, reason: 'error' | 'not-subscribed', status?: number};

export class SmartDeviceManagement {
    private oauth2Client: google.Auth.OAuth2Client;
    private smartdevicemanagement: google.smartdevicemanagement_v1.Smartdevicemanagement;
    private pubSubClient: pubsub.PubSub | undefined;
    private subscription: pubsub.Subscription | undefined;
    private projectId: string;
    private log: Logger;
    private devices: Device[] | undefined;
    private subscribed = true;

    constructor(config: Config, log: Logger) {
        this.log = log;

        this.oauth2Client = new google.Auth.OAuth2Client(
            config.clientId,
            config.clientSecret
        );
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

                let event: Events.Event;
                try {
                    event = JSON.parse(message.data.toString());
                } catch (error: any) {
                    this.log.warn('Discarding malformed Pub/Sub event: ' + summarizeError(error));
                    return;
                }

                // Not every event carries resourceUpdate (e.g. resource-relation events) — guard it.
                const resourceUpdate = (event as Partial<Events.ResourceEventEvent>).resourceUpdate;
                if (resourceUpdate?.events) {
                    const resourceEventEvent = event as Events.ResourceEventEvent;
                    const device = _.find(this.devices, device => device.getName() === resourceEventEvent.resourceUpdate.name);
                    if (device)
                        device.event(resourceEventEvent);
                } else if ((resourceUpdate as Events.ResourceTraitEvent['resourceUpdate'] | undefined)?.traits) {
                    const resourceTraitEvent = event as Events.ResourceTraitEvent;
                    const device = _.find(this.devices, device => device.getName() === resourceTraitEvent.resourceUpdate.name);
                    if (device)
                        device.event(resourceTraitEvent);
                }
            });
            this.subscription.on('error', error => {
                // A transient subscription error should NOT permanently stop the plugin: events are
                // redelivered by the auto-reconnecting Pub/Sub client, and device discovery uses the
                // REST API independently. Only a hard setup failure (constructor catch) disables.
                this.log.error("Event subscription error. If this persists, ensure your refresh token was generated with the Pub/Sub scope - see https://github.com/nnmb2vgw4r-sudo/homebridge-google-nest-sdm-v2#-the-pubsub-scope-step--dont-skip-this -- " + summarizeError(error));
            });
        } catch (error: any) {
            this.log.error("Plugin initialization failed, there was a failure with event subscription. Make sure your refresh token was generated with the Pub/Sub scope - see https://github.com/nnmb2vgw4r-sudo/homebridge-google-nest-sdm-v2#-the-pubsub-scope-step--dont-skip-this -- " + summarizeError(error));
            this.subscribed = false;
        }
    }

    async list_devices(): Promise<ListDevicesResult> {

        // Permanent: the Pub/Sub setup failed in the constructor (already logged there).
        if (!this.subscribed)
            return {ok: false, reason: 'not-subscribed'};

        try {
            // Follow nextPageToken to fetch ALL devices. Without this we only ever see the first
            // page; combined with the stale-accessory cleanup in Platform.discoverDevices, any
            // device beyond page one would be unregistered (and oscillate) on every run.
            const rawDevices: google.smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device[] = [];
            let pageToken: string | undefined = undefined;
            do {
                const response: { data: google.smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1ListDevicesResponse } =
                    await this.smartdevicemanagement.enterprises.devices.list({parent: `enterprises/${this.projectId}`, pageToken});
                if (response.data.devices)
                    rawDevices.push(...response.data.devices);
                pageToken = response.data.nextPageToken ?? undefined;
            } while (pageToken);

            this.log.debug('Receieved list of devices: ', rawDevices)

            this.devices = _(rawDevices)
                .filter(device => device.name !== null)
                .map(device => {
                    switch (device.type) {
                        case 'sdm.devices.types.DOORBELL':
                            return new Doorbell(this.smartdevicemanagement, device, this.log)
                        case 'sdm.devices.types.CAMERA':
                            return new Camera(this.smartdevicemanagement, device, this.log)
                        case 'sdm.devices.types.DISPLAY':
                            return new Display(this.smartdevicemanagement, device, this.log)
                        case 'sdm.devices.types.THERMOSTAT':
                            return new Thermostat(this.smartdevicemanagement, device, this.log)
                        default:
                            return new UnknownDevice(this.smartdevicemanagement, device, this.log);
                    }
                })
                .value();
            return {ok: true, devices: this.devices};
        } catch (error: any) {
            this.log.error('Could not execute device LIST request: ' + summarizeError(error));
            return {ok: false, reason: 'error', status: error?.response?.status};
        }
    }
}
