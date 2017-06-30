var mqtt = require("mqtt");
var debounce = require('debounce');
var Pushbullet = require('pushbullet');
var tmp = require('tmp');
var fs = require('fs');
var request = require('request');
var Service, Characteristic;

/*

Config:
    {
      "accessory": "MqttGarage",
      "name": "Left Garage Door",
      "description": "",
      "id": "LEFTGD",
      "mqttusername": "YOUR_MQTT_USERNAME",
      "mqttpassword": "YOUR_MQTT_PASSWORD",
      "pushbulletApiKey": "PUSHBULLET_API_KEY",
      "pushbulletDevice": "PUSHBULLET_DEVICE",
      "cameraSnapshotUrl": "CAMERA_SNAPSHOT_URL",
      "openNotificationThreshold": 300
    }

*/

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerAccessory("homebridge-mqtt-garage", "MqttGarage", MqttGarageAccessory);
}

function MqttGarageAccessory(log, config) {
  this.pusher = new Pushbullet(config['pushbulletApiKey']);
  this.pushbulletDevice = config['pushbulletDevice'];
  this.openNotificationThreshold = config['openNotificationThreshold'];
  this.cameraSnapshotUrl = config['cameraSnapshotUrl'];
  this.log = log;
  this.name = config["name"];
  this.id = config["id"];
  this.openTopic = `garage/${id}/openPin`;
  this.closedTopic = `garage/${id}/closedPin`;
  this.buttonTopic = `garage/${id}/button`;
	this.client_Id = 'mqttjs_' + Math.random().toString(16).substr(2, 8);
	this.options = {
	    keepalive: 10,
    	clientId: this.client_Id,
	    protocolId: 'MQTT',
    	protocolVersion: 4,
    	clean: true,
    	reconnectPeriod: 1000,
    	connectTimeout: 30 * 1000,
		will: {
			topic: 'WillMsg',
			payload: 'Connection Closed abnormally..!',
			qos: 0,
			retain: false
		},
	    username: config["mqttusername"],
	    password: config["mqttpassword"],
    	rejectUnauthorized: false
	};
  this.OPEN = 0;
  this.CLOSED = 1;
  this.OPENING = 2;
  this.CLOSING = 3;
  this.STOPPED = 4;
  this.currentState = this.CLOSED;
  this.targetState = this.CLOSED;
  this.obstructionDetected = false;
  this.currentStateCharacteristic = undefined;
  this.targetStateCharacteristic = undefined;
  this.obstructionCharacteristic = undefined;
  this.pinTriggered = false;
  
  this.service = new Service.GarageDoorOpener(this.name);

  this.service
    .getCharacteristic(Characteristic.CurrentDoorState)
    .on('get', this.getCurrentState.bind(this));

  this.service
    .getCharacteristic(Characteristic.TargetDoorState)
    .on('get', this.getTargetState.bind(this))
    .on('set', this.setTargetState.bind(this));

  this.service
    .getCharacteristic(Characteristic.ObstructionDetected)
    .on('get', this.getObstructionState.bind(this));

	// connect to MQTT broker
	this.client = mqtt.connect(this.url, this.options);
	var that = this;
	this.client.on('error', function () {
		that.log('Error event on MQTT');
	});


	this.client.on('message', function (topic, message) {
    that.log( `Got message on [${topic}]: ${message}` );
		switch(topic){
      case that.openTopic:
        that.openedChanged(parseInt(message));
        break;
      case that.closedTopic:
        that.closedChanged(parseInt(message));
    }
	});
  this.client.subscribe(this.openTopic);
  this.client.subscribe(this.closedTopic);

  this.service.setCharacteristic(Characteristic.CurrentDoorState, this.currentState);
  this.service.setCharacteristic(Characteristic.TargetDoorState, this.targetState);



}

  MqttGarageAccessory.prototype.openedChanged = debounce(function (value) {

    if (value == 1) {
      //closing
      if (this.currentState != this.OPEN) return;
      //this.log("closing...");
      this.currentState = this.CLOSING;
      this.pinTriggered = true;
      this.targetState = this.CLOSED;
      this.logState();
      this.service.setCharacteristic(Characteristic.CurrentDoorState, this.currentState);
    } else if (value == 0) {
      //open
      if (this.currentState === this.OPEN || this.currentState === this.CLOSED) return;
      //this.log("open.");
      if (this.currentState == this.CLOSING) {
        this.obstructionDetected = true;
        this.service.setCharacteristic(Characteristic.ObstructionDetected, this.obstructionDetected);
      }
      this.currentState = this.OPEN;
      this.logState();
      this.service.setCharacteristic(Characteristic.CurrentDoorState, this.currentState);
      //if(this.targetState == this.CLOSED){
      //  this.pushButton();
      //}
    }
  }.bind(this), 1000);


  MqttGarageAccessory.prototype.closedChanged = debounce(function (value) {
    if (value == 1) {
      //opening
      if (this.currentState != this.CLOSED) return;
      //this.log("opening...");
      this.currentState = this.OPENING;
      this.pinTriggered = true;
      this.targetState = this.OPEN;
      this.logState();
      this.service.setCharacteristic(Characteristic.CurrentDoorState, this.currentState);
      this.service.setCharacteristic(Characteristic.TargetDoorState, this.targetState);
      if (!this.closeTimeout) {
        this.closeTimeout = setInterval(function () {
          this.notify();
        }.bind(this), this.openNotificationThreshold * 1000);
      }
    } else if (value == 0) {
      //closed
      if (this.currentState === this.CLOSED) return;
      //this.log("closed.");
      if (this.obstructionDetected == true) {
        this.obstructionDetected = false;
        this.service.setCharacteristic(Characteristic.ObstructionDetected, this.obstructionDetected);
      }
      this.currentState = this.CLOSED;
      this.logState();
      this.service.setCharacteristic(Characteristic.CurrentDoorState, this.currentState);
      if (this.closeTimeout) {
        clearInterval(this.closeTimeout);
        this.closeTimeout = undefined;
      }
    }
  }.bind(this), 1000);

MqttGarageAccessory.prototype.notify = function () {
    this.log("notifying...");
    var that = this;
    that.log("creating temp file...");
    
    tmp.file(
        {mode: 0644, prefix: "Garage_", postfix: ".jpg"},
        function _tempFileCreated(err, path, fd, cleanupCallback) {
        that.log("temp file created.");
          
        if (err) throw err;

        //that.log("File: ", path);
        //that.log("Filedescriptor: ", fd);
        
        var capName = that.name.charAt(0).toUpperCase() + that.name.slice(1);
        that.log("getting snapshot...");
        request
        .get(that.cameraSnapshotUrl)
        .on('error', function(err) {
            that.log(err)
        })
        .on('response', function(response){
            that.log("got snapshot.");
            if(response.statusCode === 200){
            that.log("sending pushbullet...");            
            that.pusher.file(
                that.pushbulletDevice,
                path, 
                capName + ' is still open!', 
                function(error, response) {
                    that.log("pushbullet sent.");  
                    //that.log("error: " + JSON.stringify(error));
                    //that.log("response: " + JSON.stringify(response));
                    cleanupCallback();
                });
            }
        })
        .pipe(fs.createWriteStream(path));
    });
}

MqttGarageAccessory.prototype.getCurrentState = function (callback) {
  callback(null, this.currentState);
}

MqttGarageAccessory.prototype.getTargetState = function (callback) {
  callback(null, this.targetState);
}

MqttGarageAccessory.prototype.getObstructionState = function (callback) {
  callback(null, this.obstructionDetected);
}

MqttGarageAccessory.prototype.setTargetState = function (state, callback) {
  try {
    if(this.pinTriggered){
      this.pinTriggered = false;
      callback(null, this.targetState);
    }
    this.log(state);
    this.targetState = state;
    if (this.targetState != this.currentState) {
      this.pushButton();
    }
  }
  catch (ex) {
    that.log(ex);
  }
  callback(null, this.targetState);
}

MqttGarageAccessory.prototype.logState = function () {
  this.log(`Current: [${this.stateToString(this.currentState)}] | Target: [${this.stateToString(this.targetState)}]`);
}

MqttGarageAccessory.prototype.stateToString = function(state) {
  switch(state){
    case this.OPEN:
      return "OPEN";
      break;
    case this.OPENING:
      return "OPENING";
      break;
    case this.CLOSED:
      return "CLOSED";
      break;
    case this.CLOSING:
      return "CLOSING";
      break;
  }
}

MqttGarageAccessory.prototype.pushButton = function () {
  this.client.publish(this.buttonTopic, "#");
}

MqttGarageAccessory.prototype.getServices = function () {
  return [this.service];
}