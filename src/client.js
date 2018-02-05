/*
 * Created by Henry Leu (henryleu@126.com) on 2018/1/22
 */
const Primus = require('primus');
const EventEmitter = require('eventemitter3');

const ClientTracker = require('./tracker');
const { Disconnected, Timeout } = require('./outputs');
const relayer = (event, target) => (...args) => target.emit(event, ...args);

class WebSocketClient extends EventEmitter {
    constructor ({
        url,
        sessionId = {},
        transformer = 'WebSockets',
        websockets = true,
        reconnectTimeout = 15000,
        pingTimeout = 35000,
        pathname = '/primus' // server url parameter
    }) {
        super();
        this._readSessionId = sessionId.reader;
        this._writeSessionId = sessionId.writer;
        this.sessionId = this._readSessionId && this._readSessionId();

        const Socket = Primus.createSocket({
            transformer, // WebSockets | sockjs
            plugin: {
                'mirage': require('mirage'),
                'emit': require('primus-emit')
            }
        }); // WebSockets

        this._socket = new Socket(url, {
            manual: true,
            websockets,
            reconnect: {
                max: Infinity // Number: The max delay before we try to reconnect.
                , min: 500 // Number: The minimum delay before we try reconnect.
                , retries: 20 // Number: How many times we should try to reconnect.
                , 'reconnect timeout': 10000
                , factor: 2
            },
            // strategy: false,
            timeout: reconnectTimeout,
            pingTimeout,
            pathname, // server url parameter, by default, '/primus'
            fortress: 'spark', // validate target
            mirage: this.sessionId
        });
        this._tracker = new ClientTracker();
        this._opened = false;
        this._rid = new Date().getTime() * 1000;
        this._init();
    }

    open () {
        if (this._opened) return console.log('ignore opening the opened client');
        this._opened = true;
        this._socket.open();
    }

    end () {
        if (!this._opened) return console.log('ignore ending for the ended client');
        this._opened = false;
        this._socket.end();
    }

    request (name, body, cfg) {
        const timeout = (cfg && cfg.timeout) || 2000;
        const id = this._rid++; // todo generateId
        const meta = {id, name, timeout};

        if (!this._tracker.connected) {
            return new Promise((resolve) => {
                setTimeout(() => resolve({meta: Disconnected.clone(meta).toObject()}), 0);
            });
        }
        this._socket.emit('request', {meta, body});

        return new Promise((resolve) => {
            const event = `response [id=${id}]`;
            let resolved = false;
            this._socket.once(event, (result) => {
                if (resolved) return;
                resolved = true;
                resolve(result);
            });
            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                this._socket.removeAllListeners(event);
                resolve({meta: Timeout.clone(meta).toObject()});
            }, timeout);
        });
    }

    subscribe (topic, cb) {
        const id = this._rid++;
        if (!this._tracker.connected) {
            return new Promise((resolve) => {
                setTimeout(() => resolve(Disconnected.clone({id, topic}).toObject()), 0);
            });
        }
        this._socket.emit('subscribe', {topic, id});

        return new Promise((resolve) => {
            const event = `subscribed ${topic} ${id}`;
            let resolved = false;
            this._socket.once(event, (result) => {
                if (resolved) return;
                resolved = true;
                if (!result.code) { // subscribed successfully
                    this._socket.on('publish ' + topic, cb);
                }
                resolve(result);
            });
            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                this._socket.removeAllListeners(event);
                resolve({meta: Timeout.clone({id, topic}).toObject()});
            }, 2000);
        });
    }

    unsubscribe (topic, cfg) {
        const timeout = (cfg && cfg.timeout) || 2000;
        const id = this._rid++;
        if (!this._tracker.connected) {
            return new Promise((resolve) => {
                setTimeout(() => resolve(Disconnected.clone({id, topic}).toObject()), 0);
            });
        }
        this._socket.emit('unsubscribe', {topic, id});

        return new Promise((resolve) => {
            const event = `unsubscribed ${topic} ${id}`;
            let resolved = false;
            this._socket.once(event, (result) => {
                if (resolved) return;
                resolved = true;
                if (!result.code) { // unsubscribed successfully
                    this._socket.removeAllListeners('publish ' + topic);
                }
                resolve(result);
            });
            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                this._socket.removeAllListeners(event);
                resolve({meta: Timeout.clone({id, topic}).toObject()});
            }, timeout);
        });
    }

    publish (topic, ...args) {
        const id = this._rid++;
        if (!this._tracker.connected) {
            return new Promise((resolve) => {
                setTimeout(() => resolve(Disconnected.clone({id, topic, args}).toObject()), 0);
            });
        }
        this._socket.emit('publish', {topic, id, args});

        return new Promise((resolve) => {
            const event = `published ${topic} ${id}`;
            let resolved = false;
            this._socket.once(event, (result) => {
                if (resolved) return;
                resolved = true;
                resolve(result);
            });
            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                this._socket.removeAllListeners(event);
                resolve({meta: Timeout.clone({id, topic, args}).toObject()});
            }, 2000);
        });
    }

    _relay (...events) {
        for (const e of events) this._socket.on(e, relayer(e, this));
    }

    _init () {
        this._tracker.bind(this._socket);
        this._relay('open', 'close', 'reconnect', 'data', 'error');

        /**
         * get session id from server and save it at client side
         * if client is initiated without session id
         */
        this._writeSessionId && this._socket.on('mirage', (id) => this._writeSessionId(id));
    }
}

module.exports = WebSocketClient;
