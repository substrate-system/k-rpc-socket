import bencode from '@substrate-system/bencode'
import { isIP } from '@substrate-system/is-ip'
import { EventEmitter } from 'events'
import util from 'util'

// const dgram = require('dgram')
// const dns = require('dns')
// const util = require('util')

type Req = {
    ttl:number;
    peer:{ host, id }
    message
    callback
}

const ETIMEDOUT:Error & { code?:string } = new Error('Query timed out')
ETIMEDOUT.code = 'ETIMEDOUT'

const EUNEXPECTEDNODE:Error & { code?:string } = new Error('Unexpected node id')
EUNEXPECTEDNODE.code = 'EUNEXPECTEDNODE'

export class RPC extends EventEmitter {
    timeout:number = 2000
    inflight:number = 0
    destroyed:boolean = false
    isIP = isIP
    socket
    private _tick:number = 0
    private _ids:number[] = []
    private _reqs:(Req|null)[] = []
    private _timer:ReturnType<typeof setInterval>

    // this.socket = opts.socket || dgram.createSocket('udp4')
    // this.socket.on('message', onmessage)
    // this.socket.on('error', onerror)
    // this.socket.on('listening', onlistening)

    constructor (opts:{
        timeout:number;
        isIP:(s:string)=>0|4|6
    }) {
        super()
        if (opts.timeout) this.timeout = opts.timeout
        this._timer = setInterval(this.check, Math.floor(this.timeout / 4))
        if (opts.isIP) this.isIP = opts.isIP

        // need to do socket
    }

    check () {
        let missing = this.inflight
        if (!missing) return

        for (let i = 0; i < this._reqs.length; i++) {
            const req = this._reqs[i]
            if (!req) continue
            if (req.ttl) req.ttl--
            else this._cancel(i, ETIMEDOUT)
            if (!--missing) return
        }
    }

    private _cancel (index:number, err:Error) {
        const req = this._reqs[index]
        this._ids[index] = 0
        this._reqs[index] = null

        if (req) {
            this.inflight--
            req.callback(err || new Error('Query was cancelled'), null, req.peer)
            this.emit('update')
            this.emit('postupdate')
        }
    }
}

export function __RPC (opts) {
    if (!(this instanceof RPC)) return new RPC(opts)
    if (!opts) opts = {}

    const self = this

    this.timeout = opts.timeout || 2000
    this.inflight = 0
    this.destroyed = false
    this.isIP = opts.isIP || isIP
    this.socket = opts.socket || dgram.createSocket('udp4')
    this.socket.on('message', onmessage)
    this.socket.on('error', onerror)
    this.socket.on('listening', onlistening)

    this._tick = 0
    this._ids = []
    this._reqs = []
    this._timer = setInterval(check, Math.floor(this.timeout / 4))

    events.EventEmitter.call(this)

    function check () {
        let missing = self.inflight
        if (!missing) return
        for (let i = 0; i < self._reqs.length; i++) {
            const req = self._reqs[i]
            if (!req) continue
            if (req.ttl) req.ttl--
            else self._cancel(i, ETIMEDOUT)
            if (!--missing) return
        }
    }

    function onlistening () {
        self.emit('listening')
    }

    function onerror (err) {
        if (err.code === 'EACCES' || err.code === 'EADDRINUSE') self.emit('error', err)
        else self.emit('warning', err)
    }

    function onmessage (buf, rinfo) {
        if (self.destroyed) return
        if (!rinfo.port) return // seems like a node bug that this is nessesary?

        try {
            var message = bencode.decode(buf)
        } catch (e) {
            return self.emit('warning', e)
        }

        const type = message && message.y && message.y.toString()

        if (type === 'r' || type === 'e') {
            if (!Buffer.isBuffer(message.t)) return

            try {
                var tid = message.t.readUInt16BE(0)
            } catch (err) {
                return self.emit('warning', err)
            }

            const index = self._ids.indexOf(tid)
            if (index === -1 || tid === 0) {
                self.emit('response', message, rinfo)
                self.emit('warning', new Error('Unexpected transaction id: ' + tid))
                return
            }

            const req = self._reqs[index]
            if (req.peer.host !== rinfo.address) {
                self.emit('response', message, rinfo)
                self.emit('warning', new Error('Out of order response'))
                return
            }

            self._ids[index] = 0
            self._reqs[index] = null
            self.inflight--

            if (type === 'e') {
                const isArray = Array.isArray(message.e)
                const err = new Error(isArray ? message.e.join(' ') : 'Unknown error')
                err.code = isArray && message.e.length && typeof message.e[0] === 'number' ? message.e[0] : 0
                req.callback(err, message, rinfo, req.message)
                self.emit('update')
                self.emit('postupdate')
                return
            }

            const rid = message.r && message.r.id
            if (req.peer && req.peer.id && rid && !req.peer.id.equals(rid)) {
                req.callback(EUNEXPECTEDNODE, null, rinfo)
                self.emit('update')
                self.emit('postupdate')
                return
            }

            req.callback(null, message, rinfo, req.message)
            self.emit('update')
            self.emit('postupdate')
            self.emit('response', message, rinfo)
        } else if (type === 'q') {
            self.emit('query', message, rinfo)
        } else {
            self.emit('warning', new Error('Unknown type: ' + type))
        }
    }
}

util.inherits(RPC, events.EventEmitter)

RPC.prototype.address = function () {
    return this.socket.address()
}

RPC.prototype.response = function (peer, req, res, cb) {
    this.send(peer, { t: req.t, y: 'r', r: res }, cb)
}

RPC.prototype.error = function (peer, req, error, cb) {
    this.send(peer, { t: req.t, y: 'e', e: [].concat(error.message || error) }, cb)
}

RPC.prototype.send = function (peer, message, cb) {
    const buf = bencode.encode(message)
    this.socket.send(buf, 0, buf.length, peer.port, peer.address || peer.host, cb || noop)
}

// bind([port], [address], [callback])
RPC.prototype.bind = function () {
    this.socket.bind.apply(this.socket, arguments)
}

RPC.prototype.destroy = function (cb) {
    this.destroyed = true
    clearInterval(this._timer)
    if (cb) this.socket.on('close', cb)
    for (let i = 0; i < this._ids.length; i++) this._cancel(i)
    this.socket.close()
}

RPC.prototype.query = function (peer, query, cb) {
    if (!cb) cb = noop
    if (!this.isIP(peer.host)) return this._resolveAndQuery(peer, query, cb)

    const message = {
        t: Buffer.allocUnsafe(2),
        y: 'q',
        q: query.q,
        a: query.a
    }

    const req = {
        ttl: 4,
        peer,
        message,
        callback: cb
    }

    if (this._tick === 65535) this._tick = 0
    const tid = ++this._tick

    let free = this._ids.indexOf(0)
    if (free === -1) free = this._ids.push(0) - 1
    this._ids[free] = tid
    while (this._reqs.length < free) this._reqs.push(null)
    this._reqs[free] = req

    this.inflight++
    message.t.writeUInt16BE(tid, 0)
    this.send(peer, message)
    return tid
}

RPC.prototype.cancel = function (tid, err) {
    const index = this._ids.indexOf(tid)
    if (index > -1) this._cancel(index, err)
}

RPC.prototype._cancel = function (index, err) {
    const req = this._reqs[index]
    this._ids[index] = 0
    this._reqs[index] = null
    if (req) {
        this.inflight--
        req.callback(err || new Error('Query was cancelled'), null, req.peer)
        this.emit('update')
        this.emit('postupdate')
    }
}

RPC.prototype._resolveAndQuery = function (peer, query, cb) {
    const self = this

    dns.lookup(peer.host, function (err, ip) {
        if (err) return cb(err)
        if (self.destroyed) return cb(new Error('k-rpc-socket is destroyed'))
        self.query({ host: ip, port: peer.port }, query, cb)
    })
}

function noop () {}
