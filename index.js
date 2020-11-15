var ping = require('ping');
var moment = require('moment');
var request = require("request");
var http = require('http');
var url = require('url');
var gpio = require('rpi-gpio');
var DEFAULT_REQUEST_TIMEOUT = 10000;
var SENSOR_ANYONE = 'Anyone';
var SENSOR_INTRUDOR = 'Intrudor';
var FakeGatoHistoryService;
const EPOCH_OFFSET = 978307200;

var Service, Characteristic, HomebridgeAPI;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    HomebridgeAPI = homebridge;
    FakeGatoHistoryService = require('fakegato-history')(homebridge);

    homebridge.registerPlatform("homebridge-people-fusion", "PeopleFusion", PeoplePlatform);
    homebridge.registerAccessory("homebridge-people-fusion", "PeopleAccessory", PeopleAccessory);
    homebridge.registerAccessory("homebridge-people-fusion", "PeopleAllAccessory", PeopleAllAccessory);
    homebridge.registerAccessory("homebridge-people-fusion", "ContactSensorAccessory", ContactSensorAccessory);
    homebridge.registerAccessory("homebridge-people-fusion", "MotionSensorAccessory", MotionSensorAccessory);
}

// #######################
// PeoplePlatform
// #######################

function PeoplePlatform(log, config){
    this.log = log;
    this.anyoneSensor = ((typeof(config['anyoneSensor']) != "undefined" && config['anyoneSensor'] !== null)?config['anyoneSensor']:true);
    this.intrudorSensor = ((typeof(config['intrudorSensor']) != "undefined" && config['intrudorSensor'] !== null)?config['intrudorSensor']:true);
    this.webhookPort = config["webhookPort"] || 51828;
    this.cacheDirectory = config["cacheDirectory"] || HomebridgeAPI.user.persistPath();
    this.pingInterval = config["pingInterval"] || 10000;
    this.ignoreReEnterExitSeconds = config["ignoreReEnterExitSeconds"] || 0;
    this.wifiLeaveThreshold = config["wifiLeaveThreshold"] || 120;
    this.grantWifiJoin = config["grantWifiJoin"] || 30;
    this.motionAfterDoorCloseIgnore = config["motionAfterDoorCloseIgnore"] || 5;
    this.people = config['people'];
    this.sensors = config['sensors'];
    this.storage = require('node-persist');
    this.storage.initSync({dir:this.cacheDirectory});
    this.webhookQueue = [];
    this.doorSensor = [];
    this.motionSensor = [];
    this.entryMoment = 0;
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
        if(this.intrudorSensor) {
            this.peopleIntrudorAccessory = new PeopleAllAccessory(this.log, SENSOR_INTRUDOR, this);
            this.accessories.push(this.peopleIntrudorAccessory);
        }
        for(var i = 0; i < this.sensors.length; i++){
          switch (this.sensors[i]['type']) {
            case 'contact':
              var sensorAccessory = new ContactSensorAccessory(this.log, this.sensors[i], this);
              this.doorSensor = sensorAccessory;
              this.accessories.push(sensorAccessory);
            break;
            case 'motion':
              var sensorAccessory = new MotionSensorAccessory(this.log, this.sensors[i], this);
              this.motionSensor = sensorAccessory;
              this.accessories.push(sensorAccessory);
            break;
          }
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
    this.wifiLeaveThreshold = config['wifiLeaveThreshold'] || this.platform.wifiLeaveThreshold;
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

    this.service = new Service.OccupancySensor(this.name);
    this.service
        .getCharacteristic(Characteristic.OccupancyDetected)
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

    this.motionService = new Service.MotionSensor(this.name);
    this.motionService
        .getCharacteristic(Characteristic.MotionDetected)
        .on('get', this.getState.bind(this));


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
            disableTimer: false
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
        var activeThreshold = moment().subtract(this.wifiLeaveThreshold, 's');
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
        var activeThreshold = moment().subtract(this.wifiLeaveThreshold, 's');
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

        if (!newState) {
          //this.log('setNewState for %s to false', this.name);
          var lastSuccessfulPing = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target)/1000;
          //this.log('lastSuccessfulPing = ' + lastSuccessfulPing);
          var lastDoorActivation = this.platform.storage.getItemSync('lastDoorChange_' + this.platform.doorSensor.name);
          //this.log('lastDoorActivation = ' + lastDoorActivation);
          //this.log('platform.wifiLeaveThreshold = ' + this.platform.wifiLeaveThreshold);
          if (lastSuccessfulPing > (lastDoorActivation + this.platform.wifiLeaveThreshold)) {
            this.log('Change of occupancy state for %s to %s ignored, because last successful ping %s was later than lastDoorOpen %s plus threshold %s', this.name, newState, lastSuccessfulPing, lastDoorActivation, this.platform.wifiLeaveThreshold);
            //this.log('is denied because lastPing was later than lastDoorOpen + threshold');
            return(null);
          }
        }

        this.stateCache = newState;
        this.service.getCharacteristic(Characteristic.MotionDetected).updateValue(PeopleAccessory.encodeState(newState));
        this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(PeopleAccessory.encodeState(newState));

        if(this.platform.peopleAnyOneAccessory) {
            this.platform.peopleAnyOneAccessory.refreshState();
        }

        if(this.platform.peopleIntrudorAccessory) {
            this.platform.peopleIntrudorAccessory.refreshState();
        }

        var lastSuccessfulPingMoment = "none";
        var lastWebhookMoment = "none";
        lastSuccessfulPing = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.target);
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

    if(this.motionService) {
      servicesList.push(this.motionService)
    }

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
    this.state = false;

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

    this.service = new Service.OccupancySensor(this.name);
    this.service
        .getCharacteristic(Characteristic.OccupancyDetected)
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

    this.motionService = new Service.MotionSensor(this.name);
    this.motionService
        .getCharacteristic(Characteristic.MotionDetected)
        .on('get', this.getState.bind(this));

    this.accessoryService = new Service.AccessoryInformation;
    this.accessoryService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, (this.name === SENSOR_INTRUDOR)?"hps-intrudor":"hps-anyone")
        .setCharacteristic(Characteristic.Manufacturer, "Elgato");

    this.historyService = new FakeGatoHistoryService("motion", {
            displayName: this.name,
            log: this.log
        },
        {
            storage: 'fs',
            disableTimer: false
        });
}

PeopleAllAccessory.prototype.getState = function(callback) {
  this.log.debug('getState triggered for %s', this.name);
  var getState = this.getStateFromCache();
  this.log.debug('getStateFromCache result for %s is %s',this.name,getState);
  callback(null, PeopleAccessory.encodeState(getState));
}

PeopleAllAccessory.prototype.identify = function(callback) {
    this.log("Identify: "+this.name);
    callback();
}

PeopleAllAccessory.prototype.getLastActivation = function(callback) {
    var lastSeenUnix = this.platform.storage.getItemSync('lastSuccessfulPing_' + this.name);
    if (lastSeenUnix) {
        var lastSeenMoment = moment(lastSeenUnix).unix();
        callback(null, lastSeenMoment - this.historyService.getInitialTime());
    }
}

PeopleAllAccessory.prototype.getStateFromCache = function() {
  this.log.debug('getStateFromCache function triggered for %s', this.name);
  var isAnyoneActive = this.getAnyoneStateFromCache();
  this.log.debug('isAnyoneActive is %s', isAnyoneActive);
  if(this.name === SENSOR_INTRUDOR) {
    if (isAnyoneActive) {
      var newState = ((this.platform.entryMoment != 0) && (moment().unix() - this.platform.entryMoment > this.platform.grantWifiJoin));
      this.log.debug('... this.platform.entryMoment is %s', this.platform.entryMoment);
      this.log.debug('... moment().unix() - this.platform.entryMoment is %s', moment().unix() - this.platform.entryMoment);
      this.log.debug('... this.platform.grantWifiJoin is %s', this.platform.grantWifiJoin);
      this.log.debug('... hence returning %s', newState);
      if (newState != this.state) {
        this.state = newState;
        if (newState) {
          this.historyService.addEntry(
            {
              time: moment().unix(),
              status: 1
            }
          );
          this.platform.storage.setItemSync('lastSuccessfulPing_' + this.name, Date.now());
        } else {
          this.historyService.addEntry(
            {
              time: moment().unix(),
              status: 0
            }
          );
        }
      }
      return this.state;
    }
  }

  if(this.name === SENSOR_ANYONE) {
    if (this.state != isAnyoneActive) {
      this.state = isAnyoneActive;
      if (isAnyoneActive) {
        this.historyService.addEntry(
          {
            time: moment().unix(),
            status: 1
          }
        );
        this.platform.storage.setItemSync('lastSuccessfulPing_' + this.name, Date.now());
      } else {
        this.historyService.addEntry(
          {
            time: moment().unix(),
            status: 0
          }
        );
      }
    }
    return isAnyoneActive;
  }
}

PeopleAllAccessory.prototype.getAnyoneStateFromCache = function() {
    this.log.debug('getAnyoneStateFromCache triggered for %s', this.name);
    var lastDoorActivation = this.platform.storage.getItemSync('lastDoorChange_' + this.platform.doorSensor.name);
    this.log.debug('... lastDoorActivation is %s', lastDoorActivation);
    var lastMotionDetected = this.platform.storage.getItemSync('lastMotion_' + this.platform.motionSensor.name);
    this.log.debug('... lastMotionDetected is %s', lastMotionDetected);

    this.log.debug('... this.platform.motionAfterDoorCloseIgnore is %s seconds', this.platform.motionAfterDoorCloseIgnore);
    this.log.debug('... lastDoorActivation was %s seconds ago', moment().unix() - lastDoorActivation);
    this.log.debug('... this.platform.grantWifiJoin is %s seconds', this.platform.grantWifiJoin);

    for(var i = 0; i < this.platform.peopleAccessories.length; i++){
        var peopleAccessory = this.platform.peopleAccessories[i];
        var isActive = peopleAccessory.stateCache;
        if(isActive) {
            this.platform.entryMoment = 0;
            this.log.debug('... returning true because at least %s is present', peopleAccessory.name);
            return true;
        }
    }

    if (lastMotionDetected > (lastDoorActivation + this.platform.motionAfterDoorCloseIgnore)) {
      this.log.debug('... returning true because lastMotionDetected after lastDoorActivation + threshold');
      this.platform.entryMoment = lastDoorActivation;
      return true;
    }

    if ((moment().unix() - lastDoorActivation) < this.platform.grantWifiJoin) {
      this.log.debug('... returning true because lastDoorActivation was less than grantWifiJoin ago');
      this.platform.entryMoment = lastDoorActivation;
      return true;
    }

    this.log.debug('... returning false');
    return false;
}

PeopleAllAccessory.prototype.refreshState = function() {
    this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(PeopleAccessory.encodeState(this.getStateFromCache()));
    this.service.getCharacteristic(Characteristic.MotionDetected).updateValue(PeopleAccessory.encodeState(this.getStateFromCache()));
}

PeopleAllAccessory.prototype.getServices = function() {

    var servicesList = [this.service];

    if(this.motionService) {
      servicesList.push(this.motionService)
    }

    if(this.historyService) {
        servicesList.push(this.historyService)
    }
    if(this.accessoryService) {
        servicesList.push(this.accessoryService)
    }

    return servicesList;

}

// #######################
// Contact sensor
// #######################

function ContactSensorAccessory(log, config, platform) {
    this.log = log;
    this.name = config['name'];
    this.type = config['type'];
    this.pin = config['pin'];
    this.platform = platform;
    this.checkInterval = config['checkInterval'] || this.platform.checkInterval;
    this.isDoorClosed = true;

    this.timesOpened = 0;
    var timesOpened = this.platform.storage.getItemSync('timesOpened_' + this.name);
    if (timesOpened) {
        this.log('Loaded timesOpened value of %s from storage',timesOpened);
        this.timesOpened = timesOpened;
    }

    this.lastActivation = 0;
    var lastDoorActivation = this.platform.storage.getItemSync('lastDoorChange_' + this.name);
    if (lastDoorActivation) {
        this.log('Loaded lastDoorActivation value of %s from storage',lastDoorActivation);
        this.lastActivation = lastDoorActivation;
    }

    this.lastResetReference = 978285600;
    this.lastReset = moment().unix() - this.lastResetReference;
    var lastReset = this.platform.storage.getItemSync('lastReset_' + this.name);
    if (lastReset) {
        this.log('Loaded lastReset value of %s from storage',lastReset);
        this.lastReset = lastReset;
    }

    this.closedDuration = 0;
    var closedDuration = this.platform.storage.getItemSync('closedDuration_' + this.name);
    if (closedDuration) {
        this.log('Loaded closedDuration value of %s from storage',closedDuration);
        this.closedDuration = closedDuration;
    }

    this.openDuration = 0;
    var openDuration = this.platform.storage.getItemSync('openDuration_' + this.name);
    if (openDuration) {
        this.log('Loaded openDuration value of %s from storage',openDuration);
        this.openDuration = openDuration;
    }


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

    class BatteryLevelCharacteristic extends Characteristic {
      constructor(accessory) {
        super('BatteryLevel', 'E863F11B-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
          format: Characteristic.Formats.UINT16,
          unit: Characteristic.Units.PERCENTAGE,
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

    class OpenDurationCharacteristic extends Characteristic {
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

    class ClosedDurationCharacteristic extends Characteristic {
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

    this.service.addCharacteristic(TimesOpenedCharacteristic);
    this.service
        .getCharacteristic(TimesOpenedCharacteristic)
        .on('get',this.getTimesOpened.bind(this));

    this.service.addCharacteristic(BatteryLevelCharacteristic);
    this.service
        .getCharacteristic(BatteryLevelCharacteristic)
        .on('get',this.getBatteryLevel.bind(this));

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
            disableTimer: false
        });

    this.service.addCharacteristic(ResetTotalCharacteristic);
    this.service
      .getCharacteristic(ResetTotalCharacteristic)
      .on('get', this.getEveResetTotal.bind(this))
      .on('set', this.setEveResetTotal.bind(this))

    this.service.addCharacteristic(OpenDurationCharacteristic);
    this.service
      .getCharacteristic(OpenDurationCharacteristic)
      .on('get', this.getOpenDuration.bind(this))

    this.service.addCharacteristic(ClosedDurationCharacteristic);
    this.service
      .getCharacteristic(ClosedDurationCharacteristic)
      .on('get', this.getClosedDuration.bind(this))

    this.setDefaults();

    this.arp();
}

ContactSensorAccessory.encodeState = function(state) {
    if (state) {
        return Characteristic.ContactSensorState.CONTACT_DETECTED;
    } else {
        return Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    }
}

ContactSensorAccessory.prototype.getOpenDuration = function(callback) {
    callback(null, this.openDuration);
}

ContactSensorAccessory.prototype.getClosedDuration = function(callback) {
    callback(null, this.closedDuration);
}

ContactSensorAccessory.prototype.getEveResetTotal = function(callback) {
    callback(null, this.lastReset);
}

ContactSensorAccessory.prototype.setEveResetTotal = function (callback) {
  this.timesOpened = 0;
  this.platform.storage.setItemSync('timesOpened_' + this.name, this.timesOpened);

  this.openDuration = 0;
  this.platform.storage.setItemSync('openDuration_' + this.name, this.openDuration);

  this.closeDuration = 0;
  this.platform.storage.setItemSync('closeDuration_' + this.name, this.closeDuration);

  this.lastReset = moment().unix() - this.lastResetReference;
  this.platform.storage.setItemSync('lastReset_' + this.name, this.lastReset);

  this.historyService.getCharacteristic(ResetTotalCharacteristic).updateValue(this.lastReset)
  callback(null);
}




ContactSensorAccessory.prototype.getBatteryLevel = function(callback) {
    callback(null, 100);
}

ContactSensorAccessory.prototype.getState = function(callback) {
    callback(null, ContactSensorAccessory.encodeState(this.isDoorClosed));
}

ContactSensorAccessory.prototype.getLastActivation = function(callback) {
    callback(null, this.lastActivation - this.historyService.getInitialTime());
}

ContactSensorAccessory.prototype.getTimesOpened = function(callback) {
    callback(null, this.timesOpened);
}

ContactSensorAccessory.prototype.identify = function(callback) {
    this.log("Identify: %s", this.name);
    callback();
}

ContactSensorAccessory.prototype.setDefaults = function() {
    this.service.getCharacteristic(Characteristic.ContactSensorState).updateValue(ContactSensorAccessory.encodeState(this.isDoorClosed));
}

ContactSensorAccessory.prototype.readInput = function(err) {
  //this.log('worked');
  if (err) {
    this.log('Error in GPIO setup of ' + this.name + ' with message: ' + err.message);
    throw err;
  }
  //var value = 2;
  gpio.read(this.pin, this.processInput.bind(this));
  //this.log('value = ' + value);
}

ContactSensorAccessory.prototype.processInput = function(err,value) {
  if (err) {
    this.log('Error in GPIO reading of ' + this.name + ' with message: ' + err.message);
    throw err;
  }
  //this.log('OK');
  //this.log('value for ' + this.name + ' is ' + value);
  this.setNewState(value);
}

ContactSensorAccessory.prototype.arp = function() {
  //var newState = false;
  //this.log('Been here.');
  gpio.setup(this.pin, gpio.DIR_IN, this.readInput.bind(this));
  //this.log('Done that.');
  //this.log('newState = ' + newState);

  setTimeout(ContactSensorAccessory.prototype.arp.bind(this), this.checkInterval);
}

ContactSensorAccessory.prototype.setNewState = function(newState) {
    var oldState = this.isDoorClosed;
    if (oldState != newState) {
        var delta = moment().unix() - this.lastChange;
        this.isDoorClosed = newState;
        this.service.getCharacteristic(Characteristic.ContactSensorState).updateValue(ContactSensorAccessory.encodeState(newState));

        var now = moment().unix();
        this.lastActivation = now;
        this.platform.storage.setItemSync('lastDoorChange_' + this.name, now);

        if (newState) {
          this.openDuration += delta;
          this.platform.storage.setItemSync('openDuration_' + this.name, this.openDuration);

          this.timesOpened += 1;
          this.platform.storage.setItemSync('timesOpened_' + this.name, this.timesOpened);

          this.historyService.addEntry(
            {
              time: moment().unix(),
              status: 0
            }
          );
        } else {
          this.closeDuration += delta;
          this.platform.storage.setItemSync('closeDuration_' + this.name, this.closeDuration);

          this.historyService.addEntry(
            {
              time: moment().unix(),
              status: 1
            }
          );
        }

        this.log('Changed Contact sensor state for %s to %s.', this.name, newState);

        if(this.platform.peopleAnyOneAccessory) {
            this.platform.peopleAnyOneAccessory.refreshState();
        }

        if(this.platform.peopleIntrudorAccessory) {
            this.platform.peopleIntrudorAccessory.refreshState();
        }
    }
}

ContactSensorAccessory.prototype.getServices = function() {

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
// Motion sensor
// #######################

function MotionSensorAccessory(log, config, platform) {
    this.log = log;
    this.name = config['name'];
    this.pin = config['pin'];
    this.platform = platform;
    this.checkInterval = config['checkInterval'] || this.platform.checkInterval;
    this.stateCache = false;
    this.hold = 30;
    var hold = this.platform.storage.getItemSync('hold_' + this.name);
    if (hold) {
      this.hold = hold;
      this.log('HoldDuration of %s read from storage with value %s', this.name, this.hold);
    }
    this.sensitivity = 4;
    var sensitivity = this.platform.storage.getItemSync('sensitivity_' + this.name);
    if (sensitivity) {
      this.sensitivity = sensitivity - 1; // in storage, the value +1 will be stored
      this.log('Sensitivity of %s read from storage with value %s', this.name, this.sensitivity);
    }
    this.motionCounter = 0;

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
      callback(null, this.sensitivity);
    }.bind(this))
    .on('set', (value, callback) => {
      this.setSensitivity(value);
      callback(null);
    });


    this.service.addCharacteristic(DurationCharacteristic);
    this.service
    .getCharacteristic(DurationCharacteristic)
    .on('get', function(callback){
      callback(null, this.hold);
    }.bind(this))
    .on('set', (value, callback) => {
      this.setDuration(value);
      callback(null);
    });

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
      disableTimer: false
    });

    this.initStateCache();

    this.arp();
}

MotionSensorAccessory.encodeState = function(state) {
    if (state)
        return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    else
        return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
}

MotionSensorAccessory.prototype.getState = function(callback) {
    callback(null, PeopleAccessory.encodeState(this.stateCache));
}

MotionSensorAccessory.prototype.setDuration = function(value) {
  this.log('setDuration triggered with value of %s', value);
  this.platform.storage.setItemSync('hold_' + this.name, value);
  this.hold = value;
}

MotionSensorAccessory.prototype.setSensitivity = function(value) {
  this.log('setSensitivity triggered with value of %s', value);
  this.platform.storage.setItemSync('sensitivity_' + this.name, value + 1); // in storage, the value +1 will be stored
  this.sensitivity = value;
}

MotionSensorAccessory.prototype.getLastActivation = function(callback) {
    var lastSeenMoment = this.platform.storage.getItemSync('lastMotion_' + this.name);
    if (lastSeenMoment) {
        callback(null, lastSeenMoment - this.historyService.getInitialTime());
    }
}

MotionSensorAccessory.prototype.identify = function(callback) {
    this.log("Identify: "+this.name);
    callback();
}

MotionSensorAccessory.prototype.initStateCache = function() {
    var isActive = this.isActive();
    this.stateCache = isActive;
}

MotionSensorAccessory.prototype.isActive = function() {
    this.log.debug('isActive called for %s',this.name);
    var lastSeenUnix = this.platform.storage.getItemSync('lastMotion_' + this.name);

    if (lastSeenUnix) {
        this.log.debug('....lastSeenUnix is ' + lastSeenUnix);
        var activeThreshold = moment().unix() - this.hold;
        this.log.debug('... activeThreshold is ' + activeThreshold);
        var result = (lastSeenUnix > activeThreshold);
        this.log.debug('... result is ' + result);
        return result;
    }
    return false;
}

MotionSensorAccessory.prototype.readInput = function(err) {
  //this.log('worked');
  if (err) {
    this.log('Error in GPIO setup of ' + this.name + ' with message: ' + err.message);
    throw err;
  }
  //var value = 2;
  gpio.read(this.pin, this.processInput.bind(this));
  //this.log('value = ' + value);
}

MotionSensorAccessory.prototype.processInput = function(err,value) {
  if (err) {
    this.log('Error in GPIO reading of ' + this.name + ' with message: ' + err.message);
    throw err;
  }
  //this.log('OK');
  //this.log('Read value for ' + this.name + ' is ' + value);
  if (value) {
    this.motionCounter += 1;
    this.log('Motion detected, counter is now at %s', this.motionCounter);
    if (this.motionCounter > (this.sensitivity/3)) {
      //this.log('Setting lastMotion for ' + this.name);
      this.platform.storage.setItemSync('lastMotion_' + this.name, moment().unix());
    }
  } else {
    if (this.motionCounter > 0) {
      this.log('No motion detected, counter is set to zero.');
    }
    this.motionCounter = 0;
  }
  var newState = this.isActive();
  this.setNewState(newState);
}

MotionSensorAccessory.prototype.arp = function() {
  //var newState = false;
  //this.log('Been here.');
  try {
    gpio.setup(this.pin, gpio.DIR_IN, this.readInput.bind(this));
  } catch (err) {
    this.log('GPIO setup failed with ' + err.message);
  }
  //this.log('Done that.');
  //this.log('newState = ' + newState);
  finally {
    setTimeout(MotionSensorAccessory.prototype.arp.bind(this), this.checkInterval);
  }
}

MotionSensorAccessory.prototype.setNewState = function(newState) {
    //this.log('Arrived at setNewState');
    var oldState = this.stateCache;
    //this.log('oldState is ' + oldState);
    //this.log('newState is ' + newState);
    if (oldState != newState) {
        this.stateCache = newState;
        this.service.getCharacteristic(Characteristic.MotionDetected).updateValue(PeopleAccessory.encodeState(newState));

        if(this.platform.peopleAnyOneAccessory) {
            this.platform.peopleAnyOneAccessory.refreshState();
        }

        if(this.platform.peopleIntrudorAccessory) {
            this.platform.peopleIntrudorAccessory.refreshState();
        }

        if (newState) {
          this.historyService.addEntry(
            {
              time: moment().unix(),
              status: 1
            }
          );
        } else {
          this.historyService.addEntry(
            {
              time: moment().unix(),
              status: 0
            }
          );
        }

        this.log('Changed motion sensor state for %s to %s.', this.name, newState);

        if(this.platform.peopleAnyOneAccessory) {
            this.platform.peopleAnyOneAccessory.refreshState();
        }

        if(this.platform.peopleIntrudorAccessory) {
            this.platform.peopleIntrudorAccessory.refreshState();
        }
    }
}

MotionSensorAccessory.prototype.getServices = function() {

    var servicesList = [this.service];

    if(this.historyService) {
        servicesList.push(this.historyService)
    }
    if(this.accessoryService) {
        servicesList.push(this.accessoryService)
    }

    return servicesList;

}
