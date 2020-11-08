var ping = require('ping');
var moment = require('moment');
var request = require("request");
var http = require('http');
var url = require('url');
var gpio = require('rpi-gpio');
var DEFAULT_REQUEST_TIMEOUT = 10000;
var SENSOR_ANYONE = 'Anyone';
var SENSOR_NOONE = 'No One';
var FakeGatoHistoryService;
const EPOCH_OFFSET = 978307200;

var Service, Characteristic, HomebridgeAPI;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    HomebridgeAPI = homebridge;
    FakeGatoHistoryService = require('fakegato-history')(homebridge);

    homebridge.registerPlatform("homebridge-people-fusion", "PeopleFusion", PeoplePlatform);
    homebridge.registerAccessory("homebridge-people", "PeopleAccessory", PeopleAccessory);
    homebridge.registerAccessory("homebridge-people", "PeopleAllAccessory", PeopleAllAccessory);
    homebridge.registerAccessory("homebridge-people", "SensorAccessory", SensorAccessory);
}

// #######################
// PeoplePlatform
// #######################

function PeoplePlatform(log, config){
    this.log = log;
    this.threshold = config['threshold'] || 15;
    this.anyoneSensor = ((typeof(config['anyoneSensor']) != "undefined" && config['anyoneSensor'] !== null)?config['anyoneSensor']:true);
    this.nooneSensor = ((typeof(config['nooneSensor']) != "undefined" && config['nooneSensor'] !== null)?config['nooneSensor']:true);
    this.webhookPort = config["webhookPort"] || 51828;
    this.cacheDirectory = config["cacheDirectory"] || HomebridgeAPI.user.persistPath();
    this.pingInterval = config["pingInterval"] || 10000;
    this.ignoreReEnterExitSeconds = config["ignoreReEnterExitSeconds"] || 0;
    this.people = config['people'];
    this.sensors = config['sensors'];
    this.storage = require('node-persist');
    this.storage.initSync({dir:this.cacheDirectory});
    this.webhookQueue = [];

}

PeoplePlatform.prototype = {

    accessories: function(callback) {
        this.accessories = [];
        this.peopleAccessories = [];
        for(var i = 0; i < this.people.length; i++){
            var peopleAccessory = new PeopleAccessory(this.log, this.people[i], this);
            this.accessories.push(peopleAccessory);
            this.peopleAccessories.push(peopleAccessory);
        }
        if(this.anyoneSensor) {
            this.peopleAnyOneAccessory = new PeopleAllAccessory(this.log, SENSOR_ANYONE, this);
            this.accessories.push(this.peopleAnyOneAccessory);
        }
        if(this.nooneSensor) {
            this.peopleNoOneAccessory = new PeopleAllAccessory(this.log, SENSOR_NOONE, this);
            this.accessories.push(this.peopleNoOneAccessory);
        }
        for(var i = 0; i < this.sensors.length; i++){
            var sensorAccessory = new SensorAccessory(this.log, this.sensors[i], this);
            this.accessories.push(sensorAccessory);
        }
        callback(this.accessories);

        this.startServer();
    },

    startServer: function() {
        //
        // HTTP webserver code influenced by benzman81's great
        // homebridge-http-webhooks homebridge plugin.
        // https://github.com/benzman81/homebridge-http-webhooks
        //

        // Start the HTTP webserver
        http.createServer((function(request, response) {
            var theUrl = request.url;
            var theUrlParts = url.parse(theUrl, true);
            var theUrlParams = theUrlParts.query;
            var body = [];
            request.on('error', (function(err) {
                this.log("WebHook error: %s.", err);
            }).bind(this)).on('data', function(chunk) {
                body.push(chunk);
            }).on('end', (function() {
                body = Buffer.concat(body).toString();

                response.on('error', function(err) {
                    this.log("WebHook error: %s.", err);
                });

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');

                if(!theUrlParams.sensor || !theUrlParams.state) {
                    response.statusCode = 404;
                    response.setHeader("Content-Type", "text/plain");
                    var errorText = "WebHook error: No sensor or state specified in request.";
                    this.log(errorText);
                    response.write(errorText);
                    response.end();
                }
                else {
                    var sensor = theUrlParams.sensor.toLowerCase();
                    var newState = (theUrlParams.state == "true");
                    this.log('Received hook for ' + sensor + ' -> ' + newState);
                    var responseBody = {
                        success: true
                    };
                    for(var i = 0; i < this.peopleAccessories.length; i++){
                        var peopleAccessory = this.peopleAccessories[i];
                        var target = peopleAccessory.target
                        if(peopleAccessory.name.toLowerCase() === sensor) {
                            this.clearWebhookQueueForTarget(target);
                            this.webhookQueue.push({"target": target, "newState": newState, "timeoutvar": setTimeout((function(){
                                    this.runWebhookFromQueueForTarget(target);
                                }).bind(this),  peopleAccessory.ignoreReEnterExitSeconds * 1000)});
                            break;
                        }
                    }
                    response.write(JSON.stringify(responseBody));
                    response.end();
                }
            }).bind(this));
        }).bind(this)).listen(this.webhookPort);
        this.log("WebHook: Started server on port '%s'.", this.webhookPort);
    },

    clearWebhookQueueForTarget: function(target) {
        for (var i = 0; i < this.webhookQueue.length; i++) {
            var webhookQueueEntry = this.webhookQueue[i];
            if(webhookQueueEntry.target == target) {
                clearTimeout(webhookQueueEntry.timeoutvar);
                this.webhookQueue.splice(i, 1);
                break;
            }
        }
    },

    runWebhookFromQueueForTarget: function(target) {
        for (var i = 0; i < this.webhookQueue.length; i++) {
            var webhookQueueEntry = this.webhookQueue[i];
            if(webhookQueueEntry.target == target) {
                this.log('Running hook for ' + target + ' -> ' + webhookQueueEntry.newState);
                this.webhookQueue.splice(i, 1);
                this.storage.setItemSync('lastWebhook_' + target, Date.now());
                this.getPeopleAccessoryForTarget(target).setNewState(webhookQueueEntry.newState);
                break;
            }
        }
    },

    getPeopleAccessoryForTarget: function(target) {
        for(var i = 0; i < this.peopleAccessories.length; i++){
            var peopleAccessory = this.peopleAccessories[i];
            if(peopleAccessory.target === target) {
                return peopleAccessory;
            }
        }
        return null;
    }
}

// #######################
// PeopleAccessory
// #######################

function PeopleAccessory(log, config, platform) {
    this.log = log;
    this.name = config['name'];
    this.target = config['target'];
    this.platform = platform;
    this.threshold = config['threshold'] || this.platform.threshold;
    this.pingInterval = config['pingInterval'] || this.platform.pingInterval;
    this.ignoreReEnterExitSeconds = config['ignoreReEnterExitSeconds'] || this.platform.ignoreReEnterExitSeconds;
    this.stateCache = false;

    class LastActivationCharacteristic extends Characteristic {
        constructor(accessory) {
            super('LastActivation', 'E863F11A-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT32,
                unit: Characteristic.Units.SECONDS,
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY
                ]
            });
        }
    }

    class SensitivityCharacteristic extends Characteristic {
        constructor(accessory) {
            super('Sensitivity', 'E863F120-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT8,
                minValue: 0,
                maxValue: 7,
                validValues: [0, 4, 7],
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY,
                    Characteristic.Perms.WRITE
                ]
            });
        }
    }

    class DurationCharacteristic extends Characteristic {
        constructor(accessory) {
            super('Duration', 'E863F12D-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT16,
                unit: Characteristic.Units.SECONDS,
                minValue: 5,
                maxValue: 15 * 3600,
                validValues: [
                    5, 10, 20, 30,
                    1 * 60, 2 * 60, 3 * 60, 5 * 60, 10 * 60, 20 * 60, 30 * 60,
                    1 * 3600, 2 * 3600, 3 * 3600, 5 * 3600, 10 * 3600, 12 * 3600, 15 * 3600
                ],
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY,
                    Characteristic.Perms.WRITE
                ]
            });
        }
    }

    this.service = new Service.MotionSensor(this.name);
    this.service
        .getCharacteristic(Characteristic.MotionDetected)
        .on('get', this.getState.bind(this));

    this.service.addCharacteristic(LastActivationCharacteristic);
    this.service
        .getCharacteristic(LastActivationCharacteristic)
        .on('get', this.getLastActivation.bind(this));


    this.service.addCharacteristic(SensitivityCharacteristic);
    this.service
        .getCharacteristic(SensitivityCharacteristic)
        .on('get', function(callback){
            callback(null, 4);
        }.bind(this));

    this.service.addCharacteristic(DurationCharacteristic);
    this.service
        .getCharacteristic(DurationCharacteristic)
        .on('get', function(callback){
            callback(null, 5);
        }.bind(this));

    this.accessoryService = new Service.AccessoryInformation;
    this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, "hps-"+this.name.toLowerCase())
        .setCharacteristic(Characteristic.Manufacturer, "Elgato");

    this.historyService = new FakeGatoHistoryService("motion", {
            displayName: this.name,
            log: this.log
        },
        {
            storage: 'fs',
            disableTimer: true
        });

    this.initStateCache();

    if(this.pingInterval > -1) {
        this.ping();
    }
}

PeopleAccessory.encodeState = function(state) {
    if (state)
        return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    else
        return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
}

PeopleAccessory.prototype.getState = function(callback) {
    callback(null, PeopleAccessory.encodeState(this.stateCache));
}

PeopleAccessory.prototype.getLastActivation = function(callback) {
    var lastSeenUnix = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
    if (lastSeenUnix) {
        var lastSeenMoment = moment(lastSeenUnix).unix();
        callback(null, lastSeenMoment - this.historyService.getInitialTime());
    }
}

PeopleAccessory.prototype.identify = function(callback) {
    this.log("Identify: "+this.name);
    callback();
}

PeopleAccessory.prototype.initStateCache = function() {
    var isActive = this.isActive();
    this.stateCache = isActive;
}

PeopleAccessory.prototype.isActive = function() {
    var lastSeenUnix = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
    if (lastSeenUnix) {
        var lastSeenMoment = moment(lastSeenUnix);
        var activeThreshold = moment().subtract(this.threshold, 'm');
        return lastSeenMoment.isAfter(activeThreshold);
    }
    return false;
}

PeopleAccessory.prototype.ping = function() {
    if(this.webhookIsOutdated()) {
        ping.sys.probe(this.target, function(state){
            if(this.webhookIsOutdated()) {
                if (state) {
                    this.platform.storage.setItemSync('lastSuccessfulPing_' + this.target, Date.now());
                }
                if(this.successfulPingOccurredAfterWebhook()) {
                    var newState = this.isActive();
                    this.setNewState(newState);
                }
            }
            setTimeout(PeopleAccessory.prototype.ping.bind(this), this.pingInterval);
        }.bind(this));
    }
    else {
        setTimeout(PeopleAccessory.prototype.ping.bind(this), this.pingInterval);
    }
}

PeopleAccessory.prototype.webhookIsOutdated = function() {
    var lastWebhookUnix = this.platform.storage.getItemSync('lastWebhook_' + this.target);
    if (lastWebhookUnix) {
        var lastWebhookMoment = moment(lastWebhookUnix);
        var activeThreshold = moment().subtract(this.threshold, 'm');
        return lastWebhookMoment.isBefore(activeThreshold);
    }
    return true;
}

PeopleAccessory.prototype.successfulPingOccurredAfterWebhook = function() {
    var lastSuccessfulPing = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
    if(!lastSuccessfulPing) {
        return false;
    }
    var lastWebhook = this.platform.storage.getItemSync('lastWebhook_' + this.target);
    if(!lastWebhook) {
        return true;
    }
    var lastSuccessfulPingMoment = moment(lastSuccessfulPing);
    var lastWebhookMoment = moment(lastWebhook);
    return lastSuccessfulPingMoment.isAfter(lastWebhookMoment);
}

PeopleAccessory.prototype.setNewState = function(newState) {
    var oldState = this.stateCache;
    if (oldState != newState) {
        this.stateCache = newState;
        this.service.getCharacteristic(Characteristic.MotionDetected).updateValue(PeopleAccessory.encodeState(newState));

        if(this.platform.peopleAnyOneAccessory) {
            this.platform.peopleAnyOneAccessory.refreshState();
        }

        if(this.platform.peopleNoOneAccessory) {
            this.platform.peopleNoOneAccessory.refreshState();
        }

        var lastSuccessfulPingMoment = "none";
        var lastWebhookMoment = "none";
        var lastSuccessfulPing = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
        if(lastSuccessfulPing) {
            lastSuccessfulPingMoment = moment(lastSuccessfulPing).format();
        }
        var lastWebhook = this.platform.storage.getItemSync('lastWebhook_' + this.target);
        if(lastWebhook) {
            lastWebhookMoment = moment(lastWebhook).format();
        }

        this.historyService.addEntry(
            {
                time: moment().unix(),
                status: (newState) ? 1 : 0
            });
        this.log('Changed occupancy state for %s to %s. Last successful ping %s , last webhook %s .', this.target, newState, lastSuccessfulPingMoment, lastWebhookMoment);
    }
}

PeopleAccessory.prototype.getServices = function() {

    var servicesList = [this.service];

    if(this.historyService) {
        servicesList.push(this.historyService)
    }
    if(this.accessoryService) {
        servicesList.push(this.accessoryService)
    }

    return servicesList;

}

// #######################
// PeopleAllAccessory
// #######################

function PeopleAllAccessory(log, name, platform) {
    this.log = log;
    this.name = name;
    this.platform = platform;

    this.service = new Service.OccupancySensor(this.name);
    this.service
        .getCharacteristic(Characteristic.OccupancyDetected)
        .on('get', this.getState.bind(this));

    this.accessoryService = new Service.AccessoryInformation;
    this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, (this.name === SENSOR_NOONE)?"hps-noone":"hps-all")
        .setCharacteristic(Characteristic.Manufacturer, "Elgato");
}

PeopleAllAccessory.prototype.getState = function(callback) {
    callback(null, PeopleAccessory.encodeState(this.getStateFromCache()));
}

PeopleAllAccessory.prototype.identify = function(callback) {
    this.log("Identify: "+this.name);
    callback();
}

PeopleAllAccessory.prototype.getStateFromCache = function() {
    var isAnyoneActive = this.getAnyoneStateFromCache();
    if(this.name === SENSOR_NOONE) {
        return !isAnyoneActive;
    }
    else {
        return isAnyoneActive;
    }
}

PeopleAllAccessory.prototype.getAnyoneStateFromCache = function() {
    for(var i = 0; i < this.platform.peopleAccessories.length; i++){
        var peopleAccessory = this.platform.peopleAccessories[i];
        var isActive = peopleAccessory.stateCache;
        if(isActive) {
            return true;
        }
    }
    return false;
}

PeopleAllAccessory.prototype.refreshState = function() {
    this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(PeopleAccessory.encodeState(this.getStateFromCache()));
}

PeopleAllAccessory.prototype.getServices = function() {
    return [this.service, this.accessoryService];
}

// #######################
// Motion or door sensor
// #######################

function SensorAccessory(log, config, platform) {
    this.log = log;
    this.name = config['name'] + ' ' + config['type'];
    this.pin = config['pin'];
    this.platform = platform;
    this.checkInterval = config['checkInterval'] || this.platform.checkInterval;
    this.isDoorClosed = true;
    this.timesOpened = 0;
    this.lastActivation = 0;

    class LastActivationCharacteristic extends Characteristic {
        constructor(accessory) {
            super('LastActivation', 'E863F11A-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT32,
                unit: Characteristic.Units.SECONDS,
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY
                ]
            });
        }
    }

    class TimesOpenedCharacteristic extends Characteristic {
        constructor(accessory) {
            super('TimesOpened', 'E863F129-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT32,
                unit: Characteristic.Units.SECONDS,
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY
                ]
            });
        }
    }

    class ResetTotalCharacteristic extends Characteristic {
        constructor(accessory) {
            super('ResetTotal', 'E863F112-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT32,
                unit: Characteristic.Units.SECONDS,
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY,
                    Characteristic.Perms.WRITE
                ]
            });
        }
    }

    class Char118Characteristic extends Characteristic {
        constructor(accessory) {
            super('Char118', 'E863F118-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT32,
                unit: Characteristic.Units.SECONDS,
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY,
                    Characteristic.Perms.WRITE
                ]
            });
        }
    }

    class Char119Characteristic extends Characteristic {
        constructor(accessory) {
            super('Char119', 'E863F119-079E-48FF-8F27-9C2605A29F52');
            this.setProps({
                format: Characteristic.Formats.UINT32,
                unit: Characteristic.Units.SECONDS,
                perms: [
                    Characteristic.Perms.READ,
                    Characteristic.Perms.NOTIFY,
                    Characteristic.Perms.WRITE
                ]
            });
        }
    }

    this.service = new Service.ContactSensor(this.name);
    this.service
        .getCharacteristic(Characteristic.ContactSensorState)
        .on('get', this.getState.bind(this));

    this.service.addCharacteristic(LastActivationCharacteristic);
    this.service
        .getCharacteristic(LastActivationCharacteristic)
        .on('get', this.getLastActivation.bind(this));

    this.service.addOptionalCharacteristic(TimesOpenedCharacteristic);
    this.service.addCharacteristic(Char118Characteristic);
    this.service.addCharacteristic(Char119Characteristic);

    this.accessoryService = new Service.AccessoryInformation;
    this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, "hps-"+this.name.toLowerCase())
        .setCharacteristic(Characteristic.Manufacturer, "Elgato");

    this.historyService = new FakeGatoHistoryService("door", {
            displayName: this.name,
            log: this.log
        },
        {
            storage: 'fs',
            disableTimer: true,
            path: HomebridgeAPI.user.storagePath() + '/accessories',
            filename: 'history_' + "hps-" + this.name.toLowerCase() + '.json'
        });

    this.historyService.addCharacteristic(ResetTotalCharacteristic);

    this.setDefaults();

    this.arp();
}

SensorAccessory.encodeState = function(state) {
    if (state) {
        return Characteristic.ContactSensorState.CONTACT_DETECTED;
    } else {
        return Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    }
}

SensorAccessory.prototype.getState = function(callback) {
    callback(null, SensorAccessory.encodeState(this.isDoorClosed));
}

SensorAccessory.prototype.getLastActivation = function(callback) {
    callback(null, this.lastActivation);
}

SensorAccessory.prototype.identify = function(callback) {
    this.log("Identify: %s", this.name);
    callback();
}

SensorAccessory.prototype.setDefaults = function() {
    this.service.getCharacteristic(Characteristic.ContactSensorState).updateValue(SensorAccessory.encodeState(this.isDoorClosed));
}

SensorAccessory.prototype.readInput = function(err,value) {
  if (err) throw err;
  gpio.read(7, function(err, value) {
      if (err) throw err;
      return value;
  });
}

SensorAccessory.prototype.arp = function() {
  var newState = false;
  gpio.setup(7, gpio.DIR_IN, this.readInput);

  setTimeout(SensorAccessory.prototype.arp.bind(this), this.checkInterval);
}

SensorAccessory.prototype.setNewState = function(newState) {
    var oldState = this.isDoorClosed;
    if (oldState != newState) {
        this.isDoorClosed = newState;
        this.service.getCharacteristic(Characteristic.ContactSensorState).updateValue(SensorAccessory.encodeState(newState));

        var now = moment().unix();
        this.lastActivation = now - this.historyService.getInitialTime();

        this.historyService.addEntry(
            {
                time: moment().unix(),
                status: (newState) ? 0 : 1
            });
        this.log('Changed Contact sensor state for %s to %s.', this.name, newState);
    }
}

SensorAccessory.prototype.getServices = function() {

    var servicesList = [this.service];

    if(this.historyService) {
        servicesList.push(this.historyService)
    }
    if(this.accessoryService) {
        servicesList.push(this.accessoryService)
    }

    return servicesList;

}
