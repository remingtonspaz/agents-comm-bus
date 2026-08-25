#!/usr/bin/env node
import { createRequire as __acbCreateRequire } from 'module'; const require = __acbCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// ../node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       * @param {Boolean} [isServer=false] Create the instance in either server or
       *     client mode
       * @param {Number} [maxPayload=0] The maximum allowed message length
       */
      constructor(options, isServer, maxPayload) {
        this._maxPayload = maxPayload | 0;
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._isServer = !!isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// ../node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var PerMessageDeflate = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else {
            buf.set(data, 2);
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension) => {
        let configurations = extensions[extension];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// ../node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes, createHash: createHash2 } = __require("crypto");
    var { Duplex, Readable: Readable2 } = __require("stream");
    var { URL } = __require("url");
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate.extensionName]) {
          this._extensions[PerMessageDeflate.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL(address);
        } catch (e) {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate(
          opts.perMessageDeflate !== true ? opts.perMessageDeflate : {},
          false,
          opts.maxPayload
        );
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open5() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open5() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// ../node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// ../node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash: createHash2 } = __require("crypto");
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var subprotocol = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate(
            this.options.perMessageDeflate,
            true,
            this.options.maxPayload
          );
          try {
            const offers = extension.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
              extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate.extensionName]) {
          const params = extensions[PerMessageDeflate.extensionName].params;
          const value = extension.format({
            [PerMessageDeflate.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// ../core-daemon/serve.ts
import path7 from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// ../core-daemon/daemon.ts
import { mkdir as mkdir6 } from "node:fs/promises";
import os3 from "node:os";

// ../core-daemon/config.ts
var DAEMON_NAME = "agents-comm-bus";
var DAEMON_VERSION = "0.2.49";
var IPC_PROTOCOL_VERSION = "1.2.0";
var IPC_HOST = "127.0.0.1";
function protocolMajor(version) {
  return version.split(".", 1)[0] ?? version;
}
function isProtocolCompatible(daemonProtocolVersion, clientProtocolVersion) {
  return protocolMajor(daemonProtocolVersion) === protocolMajor(clientProtocolVersion);
}

// ../core-daemon/project-path.ts
import path from "node:path";
function normalizeProjectPath(project) {
  let resolved = path.resolve(project);
  if (path.sep === "\\") {
    resolved = resolved.replace(/\//g, "\\");
  } else {
    resolved = resolved.replace(/\\/g, "/");
  }
  if (/^[A-Za-z]:/.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1);
  }
  const isBareRoot = resolved === path.sep || path.sep === "\\" && /^[A-Za-z]:\\$/.test(resolved);
  if (resolved.length > 1 && resolved.endsWith(path.sep) && !isBareRoot) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

// ../core-daemon/paths.ts
import os from "node:os";
import path2 from "node:path";
function stateRoot(options = {}) {
  return path2.resolve(options.stateRoot ?? path2.join(options.homeDir ?? os.homedir(), `.${DAEMON_NAME}`));
}
function resolveStatePaths(options = {}) {
  const root = stateRoot(options);
  const database = path2.join(root, `${DAEMON_NAME}.db`);
  return {
    root,
    database,
    databaseWal: `${database}-wal`,
    databaseShm: `${database}-shm`,
    auditDir: path2.join(root, "audit"),
    chatsDir: path2.join(root, "chats"),
    tokensDir: path2.join(root, "tokens"),
    pidFile: path2.join(root, "daemon.pid"),
    portFile: path2.join(root, "port"),
    spawnLock: path2.join(root, ".spawn.lock")
  };
}
function discoveryRoot(options = {}) {
  return path2.resolve(options.discoveryRoot ?? stateRoot(options));
}
function normalizeDaemonRootPath(root) {
  return normalizeProjectPath(root);
}
function resolveDiscoveryPaths(options = {}) {
  const root = discoveryRoot(options);
  return {
    root,
    pidFile: path2.join(root, "daemon.pid"),
    portFile: path2.join(root, "port"),
    spawnLock: path2.join(root, ".spawn.lock")
  };
}

// ../core-daemon/runtime/comm-lease.ts
import { constants, existsSync, statSync } from "node:fs";
import { open, mkdir, readFile, rm, stat } from "node:fs/promises";
import os2 from "node:os";
import path3 from "node:path";
var DEFAULT_STALENESS_MS = 9e4;
var DEFAULT_IPC_RECENCY_MARGIN_MS = 3e4;
var AUTHORITY_RANK_ORDER = {
  "main-dev": 2,
  production: 1,
  worktree: 0
};
function commLeasePath(commId, resourceId, homeDir = os2.homedir()) {
  return path3.join(
    homeDir,
    `.${DAEMON_NAME}`,
    "comm-locks",
    safeSegment(commId),
    `${safeSegment(resourceId)}.json`
  );
}
function safeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}
function inferAuthorityRank(input) {
  const homeDir = input.homeDir ?? os2.homedir();
  const fileExists = input.fileExists ?? defaultFileExists;
  const isDirectory = input.isDirectory ?? defaultIsDirectory;
  const bin = input.daemonBin ? path3.resolve(input.daemonBin) : null;
  if (bin) {
    const centralBinDir = path3.resolve(path3.join(homeDir, `.${DAEMON_NAME}`, "bin"));
    if (isUnder(bin, centralBinDir)) {
      return { authorityRank: "production", checkoutRoot: path3.dirname(bin) };
    }
  }
  const startDirs = [bin ? path3.dirname(bin) : null, path3.resolve(input.cwd)].filter(
    (d) => d !== null
  );
  for (const start of startDirs) {
    const found = findGitRoot(start, fileExists);
    if (found) {
      const gitPath = path3.join(found, ".git");
      const rank = isDirectory(gitPath) ? "main-dev" : "worktree";
      return { authorityRank: rank, checkoutRoot: found };
    }
  }
  return { authorityRank: "worktree", checkoutRoot: null };
}
function findGitRoot(start, fileExists) {
  let current = path3.resolve(start);
  for (let i = 0; i < 64; i += 1) {
    if (fileExists(path3.join(current, ".git"))) return current;
    const parent = path3.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
function isUnder(child, parent) {
  const rel = path3.relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !path3.isAbsolute(rel);
}
function defaultFileExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
function defaultIsDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function decideContention(input) {
  const { self, existing, now, isPidAlive: isPidAlive2, stalenessMs } = input;
  if (!existing) return { take: true, reason: "no-holder" };
  if (!isPidAlive2(existing.pid)) return { take: true, reason: "holder-dead" };
  if (now - existing.renewedAt > stalenessMs) return { take: true, reason: "holder-stale" };
  const selfRank = AUTHORITY_RANK_ORDER[self.authorityRank];
  const holderRank = AUTHORITY_RANK_ORDER[existing.authorityRank];
  if (selfRank > holderRank) return { take: true, reason: "higher-rank" };
  if (selfRank < holderRank) {
    return { take: false, reason: "held-by-higher-rank", holder: existing };
  }
  const holderClearlyStaler = existing.lastIpcServedAt + input.ipcRecencyMarginMs < input.selfLastIpcServedAt;
  if (holderClearlyStaler) {
    return { take: true, reason: "same-rank-staler-holder" };
  }
  return { take: false, reason: "held-by-same-rank-fresh", holder: existing };
}
var CommLeaseArbiter = class {
  self;
  lastIpcServedAt;
  homeDir;
  isPidAlive;
  now;
  stalenessMs;
  ipcRecencyMarginMs;
  onAudit;
  /**
   * Per-resource signature of the last `comm_lease_denied` we actually audited,
   * keyed by `${commId}:${resourceId}` → `${reason}:${holderPid}`. The slow
   * re-acquire poll ({@link wrapWithLease.startReacquireTimer}, every
   * DEFAULT_REACQUIRE_INTERVAL_MS) re-attempts a lease it cannot win forever
   * (`held-by-higher-rank` is a STABLE condition), so without dedup it writes an
   * identical denial row every poll — thousands/day per held bot. Audit is for
   * state TRANSITIONS: emit a denial only when it first occurs or when the
   * holder/reason changes, and reset on a successful take so the next genuine
   * denial logs again.
   */
  lastDenyAudit = /* @__PURE__ */ new Map();
  /** AGE-36: runtime-local inventory of leases this arbiter currently holds. */
  heldLeases = /* @__PURE__ */ new Set();
  constructor(options) {
    this.self = options.self;
    this.lastIpcServedAt = options.lastIpcServedAt;
    this.homeDir = options.homeDir ?? os2.homedir();
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.now = options.now ?? Date.now;
    this.stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS;
    this.ipcRecencyMarginMs = options.ipcRecencyMarginMs ?? DEFAULT_IPC_RECENCY_MARGIN_MS;
    this.onAudit = options.onAudit;
  }
  get authorityRank() {
    return this.self.authorityRank;
  }
  /** Count of `(comm, resource)` leases this arbiter currently owns. */
  heldLeaseCount() {
    return this.heldLeases.size;
  }
  /** Snapshot of held lease keys — for retirement eligibility and tests. */
  heldLeaseSnapshot() {
    return [...this.heldLeases].map((key) => {
      const sep = key.indexOf(":");
      return {
        comm_id: key.slice(0, sep),
        resource_id: key.slice(sep + 1)
      };
    });
  }
  /**
   * Attempt to acquire (or reclaim) the lease for `(commId, resourceId)`. Reads
   * the existing record under a guard lock, applies {@link decideContention},
   * and writes the self record on a take. Returns a discriminated result.
   */
  async tryAcquire(commId, resourceId) {
    const leasePath = this.leasePath(commId, resourceId);
    const guard = await this.acquireGuard(leasePath);
    if (!guard) {
      const holder = await this.readRecord(leasePath) ?? this.placeholderHolder(commId, resourceId);
      return { ok: false, reason: "guard-contended", holder };
    }
    try {
      const existing = await this.readRecord(leasePath);
      const decision = decideContention({
        self: this.self,
        selfLastIpcServedAt: this.lastIpcServedAt(),
        existing,
        now: this.now(),
        isPidAlive: this.isPidAlive,
        stalenessMs: this.stalenessMs,
        ipcRecencyMarginMs: this.ipcRecencyMarginMs
      });
      if (!decision.take) {
        const denyKey = `${commId}:${resourceId}`;
        const denySig = `${decision.reason}:${decision.holder.pid}`;
        if (this.lastDenyAudit.get(denyKey) !== denySig) {
          this.lastDenyAudit.set(denyKey, denySig);
          this.audit({
            kind: "comm_lease_denied",
            comm_id: commId,
            resource_id: resourceId,
            detail: {
              reason: decision.reason,
              self_pid: this.self.pid,
              self_rank: this.self.authorityRank,
              holder_pid: decision.holder.pid,
              holder_rank: decision.holder.authorityRank,
              holder_checkout: decision.holder.checkoutRoot
            }
          });
        }
        return { ok: false, reason: decision.reason, holder: decision.holder };
      }
      this.lastDenyAudit.delete(`${commId}:${resourceId}`);
      const record = this.buildRecord(commId, resourceId, existing);
      await this.writeRecord(leasePath, record);
      const reclaimed = decision.reason === "higher-rank" || decision.reason === "same-rank-staler-holder";
      this.audit({
        kind: reclaimed ? "comm_lease_reclaimed" : "comm_lease_acquired",
        comm_id: commId,
        resource_id: resourceId,
        detail: {
          reason: decision.reason,
          self_pid: this.self.pid,
          self_rank: this.self.authorityRank,
          previous_holder_pid: existing?.pid ?? null,
          previous_holder_rank: existing?.authorityRank ?? null
        }
      });
      this.heldLeases.add(this.leaseKey(commId, resourceId));
      return { ok: true, record };
    } finally {
      await this.releaseGuard(leasePath, guard);
    }
  }
  /**
   * Re-write `renewedAt` + `lastIpcServedAt` — but ONLY if the on-disk record's
   * pid is still self. If a higher/equal-rank daemon reclaimed the lease in the
   * meantime, the on-disk pid differs; renew reports "lost" so the wrapper can
   * stop the inner adapter.
   */
  async renew(commId, resourceId) {
    const leasePath = this.leasePath(commId, resourceId);
    const guard = await this.acquireGuard(leasePath);
    if (!guard) {
      const holder = await this.readRecord(leasePath);
      if (holder && holder.pid === this.self.pid) {
        return { ok: true, record: holder };
      }
      this.heldLeases.delete(this.leaseKey(commId, resourceId));
      return { ok: false, reason: "lost", holder };
    }
    try {
      const existing = await this.readRecord(leasePath);
      if (!existing || existing.pid !== this.self.pid) {
        this.heldLeases.delete(this.leaseKey(commId, resourceId));
        this.audit({
          kind: "comm_lease_lost",
          comm_id: commId,
          resource_id: resourceId,
          detail: {
            self_pid: this.self.pid,
            on_disk_pid: existing?.pid ?? null,
            on_disk_rank: existing?.authorityRank ?? null
          }
        });
        return { ok: false, reason: "lost", holder: existing };
      }
      const renewed = {
        ...existing,
        renewedAt: this.now(),
        lastIpcServedAt: this.lastIpcServedAt()
      };
      await this.writeRecord(leasePath, renewed);
      return { ok: true, record: renewed };
    } finally {
      await this.releaseGuard(leasePath, guard);
    }
  }
  /** Delete the lease file when still self's; always drop local held inventory. */
  async release(commId, resourceId) {
    const leasePath = this.leasePath(commId, resourceId);
    const key = this.leaseKey(commId, resourceId);
    const guard = await this.acquireGuard(leasePath);
    try {
      const existing = await this.readRecord(leasePath);
      if (existing && existing.pid === this.self.pid) {
        await rm(leasePath, { force: true });
        this.audit({
          kind: "comm_lease_released",
          comm_id: commId,
          resource_id: resourceId,
          detail: { self_pid: this.self.pid }
        });
      }
    } finally {
      this.heldLeases.delete(key);
      if (guard) await this.releaseGuard(leasePath, guard);
    }
  }
  leasePath(commId, resourceId) {
    return commLeasePath(commId, resourceId, this.homeDir);
  }
  leaseKey(commId, resourceId) {
    return `${commId}:${resourceId}`;
  }
  buildRecord(commId, resourceId, existing) {
    const now = this.now();
    return {
      comm_id: commId,
      resource_id: resourceId,
      pid: this.self.pid,
      stateRoot: this.self.stateRoot,
      checkoutRoot: this.self.checkoutRoot,
      daemonBin: this.self.daemonBin,
      daemonVersion: this.self.daemonVersion,
      authorityRank: this.self.authorityRank,
      // Preserve the original acquisition time only if WE already held it.
      acquiredAt: existing && existing.pid === this.self.pid ? existing.acquiredAt : now,
      renewedAt: now,
      lastIpcServedAt: this.lastIpcServedAt()
    };
  }
  placeholderHolder(commId, resourceId) {
    return {
      comm_id: commId,
      resource_id: resourceId,
      pid: -1,
      stateRoot: "",
      checkoutRoot: null,
      daemonBin: null,
      daemonVersion: "",
      authorityRank: "worktree",
      acquiredAt: 0,
      renewedAt: 0,
      lastIpcServedAt: 0
    };
  }
  async readRecord(leasePath) {
    try {
      const raw = await readFile(leasePath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.pid !== "number" || typeof parsed.comm_id !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }
  async writeRecord(leasePath, record) {
    await mkdir(path3.dirname(leasePath), { recursive: true });
    const handle = await open(leasePath, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}
`, "utf8");
    } finally {
      await handle.close();
    }
  }
  /**
   * Guard lock that serializes the read-decide-write. Uses the spawn-lock idiom
   * (O_EXCL create) on `<resource>.json.guard`. If the guard exists but its owner
   * pid is dead, reclaim it (stale-guard reclaim) so a crashed acquirer can't
   * wedge the lease forever.
   */
  async acquireGuard(leasePath) {
    const guardPath = `${leasePath}.guard`;
    await mkdir(path3.dirname(guardPath), { recursive: true });
    const token = `${this.self.pid}:${this.now()}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(guardPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        await handle.writeFile(`${token}
`, "utf8");
        await handle.close();
        return token;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        if (attempt === 0 && await this.guardIsStale(guardPath)) {
          await rm(guardPath, { force: true });
          continue;
        }
        return null;
      }
    }
    return null;
  }
  async guardIsStale(guardPath) {
    try {
      const raw = (await readFile(guardPath, "utf8")).trim();
      const pid = Number(raw.split(":")[0]);
      if (!Number.isInteger(pid) || pid <= 0) return true;
      if (pid === this.self.pid) return true;
      return !this.isPidAlive(pid);
    } catch {
      try {
        const info = await stat(guardPath);
        return this.now() - info.mtimeMs > this.stalenessMs;
      } catch {
        return false;
      }
    }
  }
  async releaseGuard(leasePath, token) {
    const guardPath = `${leasePath}.guard`;
    try {
      const current = (await readFile(guardPath, "utf8")).trim();
      if (current === token) {
        await rm(guardPath, { force: true });
      }
    } catch {
    }
  }
  audit(event) {
    if (!this.onAudit) return;
    try {
      this.onAudit(event);
    } catch {
    }
  }
};
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function isAlreadyExistsError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
var DEFAULT_RENEW_INTERVAL_MS = 1e4;
var DEFAULT_REACQUIRE_INTERVAL_MS = 6e4;
function wrapWithLease(inner, arbiter, options = {}) {
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  const reacquireIntervalMs = options.reacquireIntervalMs ?? DEFAULT_REACQUIRE_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? ((fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h));
  const log = options.log ?? ((m) => console.error(m));
  let renewTimer = null;
  let reacquireTimer = null;
  let innerStarted = false;
  let holdingLease = false;
  const resource = inner.exclusiveResource?.() ?? null;
  const clearTimers = () => {
    if (renewTimer != null) {
      clearIntervalFn(renewTimer);
      renewTimer = null;
    }
    if (reacquireTimer != null) {
      clearIntervalFn(reacquireTimer);
      reacquireTimer = null;
    }
  };
  const startRenewTimer = (resourceId) => {
    if (renewTimer != null) return;
    renewTimer = setIntervalFn(() => {
      void arbiter.renew(inner.id, resourceId).then(async (result) => {
        if (result.ok) return;
        holdingLease = false;
        if (renewTimer != null) {
          clearIntervalFn(renewTimer);
          renewTimer = null;
        }
        log(
          `comm ${inner.id} resource ${resourceId}: LOST the poll lease (reclaimed by pid ${result.holder?.pid ?? "?"}); stopping this consumer.`
        );
        if (innerStarted) {
          try {
            await inner.stop();
          } catch {
          }
          innerStarted = false;
        }
        startReacquireTimer(resourceId);
      }).catch(() => {
      });
    }, renewIntervalMs);
  };
  const startReacquireTimer = (resourceId) => {
    if (reacquireTimer != null) return;
    reacquireTimer = setIntervalFn(() => {
      void arbiter.tryAcquire(inner.id, resourceId).then(async (result) => {
        if (!result.ok) return;
        if (reacquireTimer != null) {
          clearIntervalFn(reacquireTimer);
          reacquireTimer = null;
        }
        holdingLease = true;
        log(
          `comm ${inner.id} resource ${resourceId}: acquired the poll lease on re-acquire; starting this consumer.`
        );
        try {
          await inner.start();
          innerStarted = true;
          startRenewTimer(resourceId);
        } catch (error) {
          innerStarted = false;
          holdingLease = false;
          log(
            `comm ${inner.id} resource ${resourceId}: inner.start() failed after re-acquire: ${error instanceof Error ? error.message : String(error)}; releasing lease.`
          );
          await arbiter.release(inner.id, resourceId).catch(() => {
          });
          startReacquireTimer(resourceId);
        }
      }).catch(() => {
      });
    }, reacquireIntervalMs);
  };
  const proxy = {
    get id() {
      return inner.id;
    },
    get accountId() {
      return inner.accountId;
    },
    get allowedSenderIds() {
      return inner.allowedSenderIds;
    },
    updateAllowedSenderIds: inner.updateAllowedSenderIds ? (ids) => inner.updateAllowedSenderIds(ids) : void 0,
    exclusiveResource: inner.exclusiveResource ? () => inner.exclusiveResource() : void 0,
    async start() {
      if (!resource) {
        await inner.start();
        innerStarted = true;
        return;
      }
      const result = await arbiter.tryAcquire(inner.id, resource.resourceId);
      if (!result.ok) {
        holdingLease = false;
        log(
          `comm ${inner.id} resource ${resource.resourceId}: another daemon owns the poll lease (holder pid ${result.holder.pid}, checkout ${result.holder.checkoutRoot ?? "?"}); not starting a second consumer.`
        );
        startReacquireTimer(resource.resourceId);
        return;
      }
      holdingLease = true;
      try {
        await inner.start();
        innerStarted = true;
        startRenewTimer(resource.resourceId);
      } catch (error) {
        innerStarted = false;
        holdingLease = false;
        await inner.stop().catch(() => {
        });
        await arbiter.release(inner.id, resource.resourceId).catch(() => {
        });
        throw error;
      }
    },
    async stop() {
      clearTimers();
      try {
        if (innerStarted) await inner.stop();
      } finally {
        innerStarted = false;
        if (resource && holdingLease) {
          await arbiter.release(inner.id, resource.resourceId).catch(() => {
          });
        }
        holdingLease = false;
      }
    },
    onInbound(handler) {
      inner.onInbound(handler);
    },
    onConnectionState(handler) {
      inner.onConnectionState(handler);
    },
    send(target, payload, idempotencyKey) {
      return inner.send(target, payload, idempotencyKey);
    },
    reportPressure() {
      return inner.reportPressure();
    },
    classifyFailure(error) {
      return inner.classifyFailure(error);
    },
    onCallback: inner.onCallback ? (handler) => inner.onCallback(handler) : void 0,
    answerCallback: inner.answerCallback ? (callbackId, opts) => inner.answerCallback(callbackId, opts) : void 0,
    editMessage: inner.editMessage ? (chatNativeId, messageNativeId, text, opts) => inner.editMessage(chatNativeId, messageNativeId, text, opts) : void 0
  };
  return proxy;
}

// ../core-daemon/runtime/session-owner-liveness.ts
var DEFAULT_SESSION_OWNER_RECENCY_MS = 24 * 60 * 60 * 1e3;
function defaultIsPidAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function classifySessionOwnerProcess(session, options = {}) {
  const pid = session.lease_owner_process_pid;
  const registeredAt = session.lease_owner_process_registered_at;
  if (pid == null || registeredAt == null) return "no_owner";
  const isPidAlive2 = options.isPidAlive ?? defaultIsPidAlive2;
  if (!isPidAlive2(pid)) return "dead";
  const now = options.now ?? Date.now;
  const recencyMs = options.recencyMs ?? DEFAULT_SESSION_OWNER_RECENCY_MS;
  if (now() - registeredAt > recencyMs) return "stale";
  return "live";
}
function createSessionOwnerLiveness(options = {}) {
  return (session) => session.lease_holder_connection_id != null || classifySessionOwnerProcess(session, options) === "live";
}

// ../core-daemon/runtime/session-deliverability.ts
function isSessionLocallyDeliverable(session, hasDaemonLocalWakeRoute, sessionOwnerIsLive) {
  return hasDaemonLocalWakeRoute && sessionOwnerIsLive(session);
}

// ../core-daemon/session-label-scope.ts
function parseAgentsCommLabels(raw) {
  if (raw === void 0 || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const map = {};
  for (const entry of trimmed.split(",")) {
    const piece = entry.trim();
    if (piece.length === 0) {
      throw new Error(`AGENTS_COMM_LABELS contains an empty entry in "${raw}"`);
    }
    const colon = piece.indexOf(":");
    if (colon <= 0 || colon === piece.length - 1) {
      throw new Error(
        `AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`
      );
    }
    const comm = piece.slice(0, colon).trim();
    const label = piece.slice(colon + 1).trim();
    if (comm.length === 0 || label.length === 0) {
      throw new Error(
        `AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`
      );
    }
    if (map[comm] !== void 0) {
      throw new Error(`AGENTS_COMM_LABELS lists comm "${comm}" more than once`);
    }
    map[comm] = label;
  }
  return map;
}
function serializeAccountLabelScope(scope) {
  if (!scope || Object.keys(scope).length === 0) return null;
  const sorted = Object.keys(scope).sort();
  const canonical = {};
  for (const comm of sorted) {
    canonical[comm] = scope[comm];
  }
  return JSON.stringify(canonical);
}
function parseAccountLabelScope(stored) {
  if (stored === void 0 || stored === null) return null;
  const trimmed = stored.trim();
  if (trimmed.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`account_label_scope is not valid JSON: ${stored}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`account_label_scope must be a JSON object: ${stored}`);
  }
  const map = {};
  for (const [comm, label] of Object.entries(parsed)) {
    if (typeof label !== "string" || label.length === 0) {
      throw new Error(`account_label_scope value for "${comm}" must be a non-empty string`);
    }
    map[comm] = label;
  }
  return map;
}
function accountLabelScopeFromParams(params) {
  if (params.account_label_scope === null) return null;
  if (typeof params.account_label_scope === "string") {
    return serializeAccountLabelScope(parseAccountLabelScope(params.account_label_scope));
  }
  if (typeof params.comm_labels === "string") {
    return serializeAccountLabelScope(parseAgentsCommLabels(params.comm_labels));
  }
  return null;
}
function filterRegistrationsByScope(registrations, scopeStored) {
  const scope = parseRoutingScope(scopeStored);
  if (scope === void 0) return [];
  if (!scope) return [...registrations];
  return registrations.filter((reg) => {
    const expected = scope[reg.comm];
    return expected !== void 0 && reg.account_label === expected;
  });
}
function liveSessionScopeCandidates(target, sessions, isSessionLive) {
  const liveSiblings = sessions.filter(
    (session) => session.session_id !== target.session_id && session.project === target.project && session.agent === target.agent && session.status === "active" && isSessionLive(session)
  );
  return [target, ...liveSiblings];
}
function filterRegistrationsForSession(registrations, target, sessions, isSessionLive = hasLiveConnectionLease) {
  if (target.account_label_scope != null) {
    return filterRegistrationsByScope(
      registrations,
      target.account_label_scope
    );
  }
  const labeledSiblings = liveSessionScopeCandidates(
    target,
    sessions,
    isSessionLive
  ).filter(
    (session) => session.session_id !== target.session_id && session.account_label_scope != null
  );
  if (labeledSiblings.length === 0) return [...registrations];
  return registrations.filter(
    (registration) => !labeledSiblings.some(
      (session) => registrationMatchesConversationScope(
        session.account_label_scope,
        registration
      )
    )
  );
}
function sessionOwnsConversation(target, sessions, conversation, isSessionLive = hasLiveConnectionLease) {
  if (conversation.project !== target.project || conversation.agent !== target.agent) {
    return false;
  }
  const resolved = resolveSessionForConversation(
    liveSessionScopeCandidates(target, sessions, isSessionLive),
    conversation,
    (session) => session.session_id
  );
  return resolved?.session_id === target.session_id;
}
function registrationMatchesConversationScope(scopeStored, conversation) {
  const scope = parseRoutingScope(scopeStored);
  if (scope === void 0) return false;
  if (!scope) return true;
  const expected = scope[conversation.comm];
  return expected !== void 0 && expected === conversation.account_label;
}
function resolveSessionForConversation(sessions, conversation, pickSessionId) {
  const labeledMatches = sessions.filter(
    (sess) => sess.account_label_scope != null && registrationMatchesConversationScope(sess.account_label_scope, conversation)
  );
  if (labeledMatches.length > 0) {
    return labeledMatches[0];
  }
  const unlabeled = sessions.filter((sess) => sess.account_label_scope == null);
  if (unlabeled.length === 1) {
    return unlabeled[0];
  }
  if (unlabeled.length > 1) {
    return void 0;
  }
  return void 0;
}
function hasLiveConnectionLease(session) {
  return session.lease_holder_connection_id != null;
}
function parseRoutingScope(stored) {
  try {
    return parseAccountLabelScope(stored ?? null);
  } catch (error) {
    console.error(
      `agents-comm-bus: invalid persisted account_label_scope; treating session as scope-inert: ${error instanceof Error ? error.message : String(error)}`
    );
    return void 0;
  }
}

// ../core-daemon/runtime/inspect-inbound-target.ts
function resolveSessionForConversationDetailed(sessions, conversation, sessionOwnerIsLive) {
  const live = sessions.filter((sess) => sessionOwnerIsLive(sess));
  const labeled = live.filter(
    (sess) => sess.account_label_scope != null && registrationMatchesConversationScope(sess.account_label_scope, conversation)
  );
  if (labeled.length === 1) {
    return { resolution: "resolved", session: labeled[0], candidates: [] };
  }
  if (labeled.length > 1) {
    return { resolution: "ambiguous", candidates: labeled };
  }
  const unlabeled = live.filter((sess) => sess.account_label_scope == null);
  if (unlabeled.length === 1) {
    return { resolution: "resolved", session: unlabeled[0], candidates: [] };
  }
  if (unlabeled.length > 1) {
    return { resolution: "ambiguous", candidates: unlabeled };
  }
  return { resolution: "cold", candidates: [] };
}
function normalizeDaemonRoot(value) {
  return value ? normalizeDaemonRootPath(value) : "";
}
async function handleInspectInboundTarget(params, deps) {
  const target = await resolveTarget(params, deps.storage);
  if (!target) {
    return { resolution: "not_found", locally_deliverable: false };
  }
  const registration = target;
  const sessions = await deps.storage.listSessions({
    project: target.project,
    agent: target.agent,
    status: "active"
  });
  const detailed = resolveSessionForConversationDetailed(
    sessions,
    { comm: target.comm, account_label: target.account_label },
    deps.sessionOwnerIsLive
  );
  if (detailed.resolution !== "resolved" || !detailed.session) {
    return {
      resolution: detailed.resolution,
      registration,
      routed_session: null,
      locally_deliverable: false,
      // Diagnostic only, and only for `ambiguous`. A caller that branches on
      // these is doing routing, and routing is daemon-owned.
      ...detailed.resolution === "ambiguous" ? {
        // Diagnostic only, and ONLY for ambiguous. A caller that branches
        // on candidates is doing routing, and routing is daemon-owned.
        candidate_sessions: detailed.candidates.map((c) => ({
          session_id: c.session_id,
          account_label_scope: c.account_label_scope
        }))
      } : {}
    };
  }
  const session = detailed.session;
  const bridge = deps.bridges.find((b) => b.agentId === target.agent);
  const ownerDaemonMatches = normalizeDaemonRoot(session.lease_owner_daemon_discovery_root) === normalizeDaemonRoot(deps.daemonOwner.discoveryRoot);
  const routeReady = ownerDaemonMatches && bridge?.routeReady !== void 0 ? bridge.routeReady(session.session_id) : false;
  return {
    resolution: "resolved",
    registration,
    routed_session: {
      session_id: session.session_id,
      account_label_scope: session.account_label_scope,
      owner_pid: session.lease_owner_process_pid ?? null,
      owner_registered_at: session.lease_owner_process_registered_at ?? null,
      // Process-owner classification ONLY — diagnostics. Not the verdict:
      // the canonical predicate is an OR with the connection lease, so a live
      // connection with no PID is `no_owner` here and still deliverable.
      owner_state: classifySessionOwnerProcess(session),
      owner_daemon_matches: ownerDaemonMatches,
      route_ready: routeReady
    },
    locally_deliverable: isSessionLocallyDeliverable(
      session,
      routeReady,
      deps.sessionOwnerIsLive
    )
  };
}
async function resolveTarget(params, storage) {
  const conversationId = params.conversation_id;
  if (typeof conversationId === "string" && conversationId.length > 0) {
    const conv = await storage.getConversation(conversationId);
    if (!conv) return void 0;
    return {
      project: conv.project,
      agent: conv.agent,
      comm: conv.comm,
      // Legacy rows may predate bot-id backfill; report the empty string rather
      // than null so the target shape stays uniform across both lookups.
      account: conv.bot_user_id ?? "",
      account_label: conv.account_label
    };
  }
  const comm = params.comm;
  const account = params.account;
  if (typeof comm !== "string" || typeof account !== "string") return void 0;
  const reg = await storage.getAccountByBot(comm, account);
  if (!reg) return void 0;
  return {
    project: reg.project,
    agent: reg.agent,
    comm: reg.comm,
    account: reg.bot_user_id,
    account_label: reg.account_label
  };
}

// ../node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// ../core-daemon/ipc/protocol.ts
var IPC_MESSAGE_TYPES = {
  clientHello: "client.hello",
  daemonHello: "daemon.hello",
  daemonError: "daemon.error",
  request: "request",
  response: "response"
};
function createClientHello(input) {
  return {
    type: IPC_MESSAGE_TYPES.clientHello,
    protocolVersion: input.protocolVersion ?? IPC_PROTOCOL_VERSION,
    clientVersion: input.clientVersion,
    metadata: {
      pid: process.pid,
      cwd: process.cwd(),
      ...input.metadata
    }
  };
}
function createDaemonHello(input = {}) {
  return {
    type: IPC_MESSAGE_TYPES.daemonHello,
    protocolVersion: input.protocolVersion ?? IPC_PROTOCOL_VERSION,
    daemonVersion: input.daemonVersion ?? DAEMON_VERSION,
    daemonName: DAEMON_NAME,
    metadata: {
      pid: process.pid,
      cwd: process.cwd(),
      ...input.metadata
    }
  };
}
function createProtocolMismatchError(input) {
  const protocolVersion = input.protocolVersion ?? IPC_PROTOCOL_VERSION;
  return {
    type: IPC_MESSAGE_TYPES.daemonError,
    code: "protocol_version_mismatch",
    message: `agents-comm-bus IPC protocol mismatch: daemon supports ${protocolVersion}, client requested ${input.clientProtocolVersion}. Upgrade the older daemon or plugin shim so their major protocol versions match.`,
    protocolVersion,
    daemonVersion: input.daemonVersion ?? DAEMON_VERSION,
    metadata: input.metadata ?? {}
  };
}
function parseIpcMessage(data) {
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const parsed = JSON.parse(text);
  if (parsed.type !== IPC_MESSAGE_TYPES.clientHello && parsed.type !== IPC_MESSAGE_TYPES.daemonHello && parsed.type !== IPC_MESSAGE_TYPES.daemonError && parsed.type !== IPC_MESSAGE_TYPES.request && parsed.type !== IPC_MESSAGE_TYPES.response) {
    throw new Error("Invalid agents-comm-bus IPC message type.");
  }
  return parsed;
}
function parseHandshakeMessage(data) {
  const message = parseIpcMessage(data);
  if (message.type !== IPC_MESSAGE_TYPES.clientHello && message.type !== IPC_MESSAGE_TYPES.daemonHello && message.type !== IPC_MESSAGE_TYPES.daemonError) {
    throw new Error("Invalid agents-comm-bus IPC handshake message type.");
  }
  return message;
}
function validateClientHello(message) {
  if (message.type !== IPC_MESSAGE_TYPES.clientHello || typeof message.protocolVersion !== "string" || typeof message.clientVersion !== "string") {
    throw new Error("Expected agents-comm-bus client hello handshake.");
  }
  return message;
}
function isClientCompatible(clientHello, daemonProtocolVersion = IPC_PROTOCOL_VERSION) {
  return isProtocolCompatible(daemonProtocolVersion, clientHello.protocolVersion);
}
function createRequest(method, params) {
  return {
    type: IPC_MESSAGE_TYPES.request,
    id: cryptoRandomId(),
    method,
    params
  };
}
function cryptoRandomId() {
  return `ipc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// ../core-daemon/ipc/server.ts
async function startIpcServer(options = {}) {
  const host = options.host ?? IPC_HOST;
  const port = options.port ?? 0;
  const protocolVersion = options.protocolVersion ?? IPC_PROTOCOL_VERSION;
  const daemonVersion = options.daemonVersion ?? DAEMON_VERSION;
  const metadata = options.metadata ?? {};
  const server = new import_websocket_server.default({ host, port });
  let liveConnectionCount = 0;
  server.on("connection", (socket) => {
    liveConnectionCount += 1;
    socket.once("close", () => {
      liveConnectionCount -= 1;
    });
    handleHandshake(socket, { protocolVersion, daemonVersion, metadata, onRequest: options.onRequest });
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("agents-comm-bus IPC server did not bind to a TCP port.");
  }
  const boundPort = address.port;
  const hello = createDaemonHello({ daemonVersion, protocolVersion, metadata });
  return {
    port: boundPort,
    host,
    url: `ws://${host}:${boundPort}`,
    hello,
    getLiveConnectionCount: () => liveConnectionCount,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
function handleHandshake(socket, daemon) {
  socket.once("message", (data) => {
    try {
      const clientHello = validateClientHello(parseHandshakeMessage(data));
      if (!isClientCompatible(clientHello, daemon.protocolVersion)) {
        socket.send(JSON.stringify(createProtocolMismatchError({
          clientProtocolVersion: clientHello.protocolVersion,
          daemonVersion: daemon.daemonVersion,
          protocolVersion: daemon.protocolVersion,
          metadata: daemon.metadata
        })));
        socket.close(4002, "IPC protocol mismatch");
        return;
      }
      socket.send(JSON.stringify(createDaemonHello({
        daemonVersion: daemon.daemonVersion,
        protocolVersion: daemon.protocolVersion,
        metadata: daemon.metadata
      })));
      socket.on("message", (requestData) => {
        void handleRequest(socket, requestData, daemon.onRequest);
      });
    } catch (error) {
      socket.send(JSON.stringify({
        type: IPC_MESSAGE_TYPES.daemonError,
        code: "bad_handshake",
        message: error instanceof Error ? error.message : "Invalid agents-comm-bus IPC handshake.",
        protocolVersion: daemon.protocolVersion,
        daemonVersion: daemon.daemonVersion,
        metadata: daemon.metadata
      }));
      socket.close(4003, "Bad IPC handshake");
    }
  });
}
async function handleRequest(socket, data, onRequest) {
  let request;
  try {
    const message = parseIpcMessage(data);
    if (message.type !== IPC_MESSAGE_TYPES.request) return;
    request = message;
  } catch {
    return;
  }
  try {
    if (!onRequest) throw new Error("daemon has no IPC request handler");
    const result = await onRequest(request, socket);
    socket.send(JSON.stringify({
      type: IPC_MESSAGE_TYPES.response,
      id: request.id,
      ok: true,
      result
    }));
  } catch (error) {
    socket.send(JSON.stringify({
      type: IPC_MESSAGE_TYPES.response,
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

// ../core-daemon/bootstrap/ensure-daemon.ts
import { mkdir as mkdir3, open as open3, readFile as readFile2, rm as rm2, writeFile } from "node:fs/promises";

// ../core-daemon/storage/audit.ts
import { createReadStream } from "node:fs";
import { mkdir as mkdir2 } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

// ../core-daemon/storage/jsonl.ts
import { open as open2 } from "node:fs/promises";
async function appendJsonLine(path8, value) {
  const handle = await open2(path8, "a");
  try {
    await handle.writeFile(`${JSON.stringify(value)}
`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ../core-daemon/storage/audit.ts
function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}
var JsonlAuditStore = class {
  constructor(root) {
    this.root = root;
  }
  root;
  async append(event) {
    const path8 = this.pathFor(event.timestamp);
    await mkdir2(dirname(path8), { recursive: true });
    await appendJsonLine(path8, event);
  }
  pathFor(timestamp) {
    return join(this.root, "audit", `${utcDay(timestamp)}.jsonl`);
  }
  async hasInboundReceived(conversation_id, message, auditTimestamp) {
    const path8 = this.pathFor(auditTimestamp ?? Date.now());
    try {
      const lines = createInterface({
        input: createReadStream(path8, { encoding: "utf8" }),
        crlfDelay: Infinity
      });
      for await (const line of lines) {
        if (line.trim() === "") continue;
        const event = JSON.parse(line);
        if (event.kind === "inbound_received" && event.conversation_id === conversation_id && event.detail?.platform_message_id === message.platform_message_id) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }
};

// ../core-daemon/ipc/client.ts
var DEFAULT_IPC_REQUEST_TIMEOUT_MS = 10 * 60 * 1e3;
var IpcRequestTimeoutError = class extends Error {
  requestId;
  method;
  timeoutMs;
  constructor(requestId, method, timeoutMs) {
    super(
      `agents-comm-bus IPC request timed out after ${timeoutMs}ms (method=${method}, id=${requestId}). The daemon may be hung; restart it (kill the PID in ~/.agents-comm-bus/daemon.pid, remove port + daemon.pid) and retry.`
    );
    this.name = "IpcRequestTimeoutError";
    this.requestId = requestId;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
};
async function connectIpc(options) {
  const host = options.host ?? IPC_HOST;
  const timeoutMs = options.timeoutMs ?? 1e3;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_IPC_REQUEST_TIMEOUT_MS;
  const socket = new wrapper_default(`ws://${host}:${options.port}`);
  const hello = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for agents-comm-bus IPC handshake on ${host}:${options.port}.`));
    }, timeoutMs);
    socket.once("open", () => {
      socket.send(JSON.stringify(createClientHello({
        clientVersion: options.clientVersion,
        protocolVersion: options.protocolVersion ?? IPC_PROTOCOL_VERSION,
        metadata: options.metadata
      })));
    });
    socket.once("message", (data) => {
      try {
        const message = parseHandshakeMessage(data);
        if (message.type === IPC_MESSAGE_TYPES.daemonError) {
          throw new Error(message.message);
        }
        if (message.type !== IPC_MESSAGE_TYPES.daemonHello) {
          throw new Error("Expected agents-comm-bus daemon hello handshake.");
        }
        clearTimeout(timeout);
        resolve(message);
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return {
    socket,
    hello,
    request: (method, params) => sendRequest(socket, createRequest(method, params), requestTimeoutMs),
    close: () => socket.close()
  };
}
async function sendRequest(socket, request, requestTimeoutMs) {
  socket.send(JSON.stringify(request));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onMessage = (data) => {
      try {
        const message = parseIpcMessage(data);
        if (message.type !== IPC_MESSAGE_TYPES.response || message.id !== request.id) {
          return;
        }
        const response = message;
        if (!response.ok) {
          settle(() => {
            reject(new Error(response.error ?? "agents-comm-bus request failed"));
          });
          return;
        }
        settle(() => {
          resolve(response.result);
        });
      } catch (error) {
        settle(() => {
          reject(error);
        });
      }
    };
    const onError = (error) => {
      settle(() => {
        reject(error);
      });
    };
    const onClose = () => {
      settle(() => {
        reject(new Error("agents-comm-bus IPC socket closed before the request completed."));
      });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const timeout = setTimeout(() => {
      settle(() => {
        reject(new IpcRequestTimeoutError(request.id, request.method, requestTimeoutMs));
      });
    }, requestTimeoutMs);
    timeout.unref?.();
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

// ../core-daemon/bootstrap/handshake.ts
async function probeDaemon(options) {
  const connection = await connectIpc({
    port: options.port,
    clientVersion: options.clientVersion ?? DAEMON_VERSION,
    protocolVersion: options.protocolVersion ?? IPC_PROTOCOL_VERSION,
    metadata: options.metadata,
    timeoutMs: options.timeoutMs
  });
  connection.close();
  return connection.hello;
}

// ../core-daemon/bootstrap/ensure-daemon.ts
async function readPortFile(portFile) {
  try {
    const raw = (await readFile2(portFile, "utf8")).trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : void 0;
  } catch {
    return void 0;
  }
}
async function writeDaemonDiscoveryFiles(input) {
  const paths = resolveDiscoveryPaths({
    stateRoot: input.stateRoot,
    discoveryRoot: input.discoveryRoot
  });
  await mkdir3(paths.root, { recursive: true });
  const existingPort = await readPortFile(paths.portFile);
  if (existingPort !== void 0 && existingPort !== input.port) {
    const probe = input.probeDaemon ?? ((port) => probeDaemon({ port }));
    let existingDaemonIsLive = false;
    try {
      await probe(existingPort);
      existingDaemonIsLive = true;
    } catch {
      existingDaemonIsLive = false;
    }
    if (existingDaemonIsLive) {
      throw new Error(
        `agents-comm-bus daemon already running on port ${existingPort}; refusing to overwrite discovery with port ${input.port}`
      );
    }
  }
  await writeFile(paths.pidFile, `${input.pid ?? process.pid}
`, "utf8");
  await writeFile(paths.portFile, `${input.port}
`, "utf8");
}

// ../core-daemon/bootstrap/boot-scope-restore.ts
import { access } from "node:fs/promises";
import { join as join2 } from "node:path";
var DEFAULT_BOOT_RESTORE_RECENCY_MS = DEFAULT_SESSION_OWNER_RECENCY_MS;
async function defaultPathExists(path8) {
  try {
    await access(path8);
    return true;
  } catch {
    return false;
  }
}
function scopeDedupeKey(agent, project, accountLabelScope) {
  return `${agent}:${normalizeProjectPath(project)}:${accountLabelScope ?? ""}`;
}
function classifySessionDaemonOwner(session, currentDiscoveryRoot) {
  const stamped = session.lease_owner_daemon_discovery_root;
  if (stamped == null || stamped.length === 0) return "missing";
  return normalizeDaemonRootPath(stamped) === normalizeDaemonRootPath(currentDiscoveryRoot) ? "match" : "foreign";
}
async function auditBootRestore(audit, timestamp, summary, error) {
  if (!audit) return;
  const detail = { ...summary };
  if (error !== void 0) {
    detail.error = error instanceof Error ? error.message : String(error);
  }
  await audit.append({
    timestamp,
    kind: "daemon_boot_restore",
    detail
  }).catch(() => {
  });
}
async function runBootScopeRestore(input) {
  const now = input.now ?? (() => Date.now());
  const isPidAlive2 = input.isPidAlive ?? defaultIsPidAlive2;
  const recencyMs = input.recencyMs ?? DEFAULT_BOOT_RESTORE_RECENCY_MS;
  const pathExists = input.pathExists ?? defaultPathExists;
  const summary = {
    status: "completed",
    candidates: 0,
    restored: 0,
    skipped_dead: 0,
    skipped_stale: 0,
    skipped_no_owner: 0,
    skipped_no_daemon_owner: 0,
    skipped_foreign_owner: 0
  };
  try {
    const pausedPath = join2(input.stateRoot, "paused");
    if (await pathExists(pausedPath)) {
      summary.status = "skipped_paused";
      console.error(
        "agents-comm-bus: boot scope restore skipped (paused marker present)"
      );
      await auditBootRestore(input.audit, now(), summary);
      return summary;
    }
    const sessions = await input.storage.listSessions({ status: "active" });
    summary.candidates = sessions.length;
    const scopesToRestore = /* @__PURE__ */ new Map();
    for (const session of sessions) {
      const ownerState = classifySessionOwnerProcess(session, {
        now,
        isPidAlive: isPidAlive2,
        recencyMs
      });
      switch (ownerState) {
        case "no_owner":
          summary.skipped_no_owner += 1;
          continue;
        case "stale":
          summary.skipped_stale += 1;
          continue;
        case "dead":
          summary.skipped_dead += 1;
          continue;
        case "live":
          break;
      }
      const ownerClass = classifySessionDaemonOwner(session, input.discoveryRoot);
      if (ownerClass === "missing") {
        summary.skipped_no_daemon_owner += 1;
        continue;
      }
      if (ownerClass === "foreign") {
        summary.skipped_foreign_owner += 1;
        continue;
      }
      const canonicalProject = normalizeProjectPath(session.project);
      const key = scopeDedupeKey(session.agent, canonicalProject, session.account_label_scope);
      if (!scopesToRestore.has(key)) {
        scopesToRestore.set(key, {
          project: canonicalProject,
          agent: session.agent,
          accountLabelScope: session.account_label_scope
        });
      }
    }
    for (const scope of scopesToRestore.values()) {
      try {
        await input.ensureCommsForSession(scope.project, scope.agent, {
          accountLabelScope: scope.accountLabelScope
        });
        summary.restored += 1;
      } catch (error) {
        console.error(
          `agents-comm-bus: boot scope restore ensure failed for ${scope.project}/${scope.agent}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    console.error(
      `agents-comm-bus: boot scope restore complete: candidates=${summary.candidates} restored=${summary.restored} skipped_dead=${summary.skipped_dead} skipped_stale=${summary.skipped_stale} skipped_no_owner=${summary.skipped_no_owner} skipped_no_daemon_owner=${summary.skipped_no_daemon_owner} skipped_foreign_owner=${summary.skipped_foreign_owner}`
    );
    await auditBootRestore(input.audit, now(), summary);
    return summary;
  } catch (error) {
    console.error(
      `agents-comm-bus: boot scope restore failed: ${error instanceof Error ? error.message : String(error)}`
    );
    await auditBootRestore(input.audit, now(), summary, error);
    return summary;
  }
}

// ../core-daemon/bootstrap/daemon-retirement.ts
import { readFile as readFile3, rm as rm3 } from "node:fs/promises";
var IDLE_NO_OWNED_RESOURCES_REASON = "idle_no_owned_resources";
function discoveryFilesMatchSelf(input) {
  return input.onDiskPid === input.selfPid && input.onDiskPort === input.selfPort;
}
async function removeDiscoveryFilesIfOwned(input) {
  const paths = resolveDiscoveryPaths({
    stateRoot: input.stateRoot,
    discoveryRoot: input.discoveryRoot
  });
  const readPid = input.readPidFile ?? readDiscoveryPidFile;
  const readPort = input.readPortFile ?? readDiscoveryPortFile;
  const onDiskPid = await readPid(paths.pidFile);
  const onDiskPort = await readPort(paths.portFile);
  if (!discoveryFilesMatchSelf({
    selfPid: input.selfPid,
    selfPort: input.selfPort,
    onDiskPid,
    onDiskPort
  })) {
    return false;
  }
  await rm3(paths.pidFile, { force: true });
  await rm3(paths.portFile, { force: true });
  return true;
}
var globalRetiring = false;
async function retireDaemon(options) {
  if (globalRetiring) return false;
  globalRetiring = true;
  const selfPid = options.selfPid ?? process.pid;
  const log = options.log ?? ((message) => console.error(message));
  const exit = options.exitProcess ?? ((code) => process.exit(code));
  try {
    bestEffortSync(options.stopTimers, "stop daemon retirement timers");
    await appendRetirementAudit(options.audit, options.reason, selfPid, options.port);
    log(
      `agents-comm-bus: retiring daemon pid=${selfPid} port=${options.port} reason=${options.reason}`
    );
    await bestEffort(options.stopBus, "stop comm adapters during daemon retirement");
    await bestEffort(options.closeIpc, "close IPC server during daemon retirement");
    await bestEffort(options.closeStorage, "close storage during daemon retirement");
    const removeDiscovery = options.removeDiscoveryFiles ?? removeDiscoveryFilesIfOwned;
    await bestEffort(
      () => removeDiscovery({
        stateRoot: options.stateRoot,
        discoveryRoot: options.discoveryRoot,
        selfPid,
        selfPort: options.port
      }).then(() => void 0),
      "remove discovery files during daemon retirement"
    );
  } catch (error) {
    log(
      `agents-comm-bus: daemon retirement failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    exit(0);
  }
  return true;
}
async function appendRetirementAudit(audit, reason, selfPid, port) {
  if (!audit) return;
  await audit.append({
    timestamp: Date.now(),
    kind: "daemon_retired",
    detail: { reason, self_pid: selfPid, port }
  }).catch(() => {
  });
}
async function bestEffort(action, label) {
  if (!action) return;
  try {
    await action();
  } catch (error) {
    console.error(
      `agents-comm-bus: failed to ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function bestEffortSync(action, label) {
  if (!action) return;
  try {
    action();
  } catch (error) {
    console.error(
      `agents-comm-bus: failed to ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
async function readDiscoveryPidFile(pidFile) {
  try {
    const raw = (await readFile3(pidFile, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
async function readDiscoveryPortFile(portFile) {
  try {
    const raw = (await readFile3(portFile, "utf8")).trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

// ../core-daemon/bootstrap/pid-watchdog.ts
import { readFile as readFile4 } from "node:fs/promises";
function startDaemonPidWatchdog(options) {
  const intervalMs = options.intervalMs ?? 3e4;
  const initialDelayMs = options.initialDelayMs ?? 5e3;
  let stopped = false;
  let running = false;
  let interval;
  const run = () => {
    if (stopped || running) return;
    running = true;
    void runDaemonPidWatchdogTick(options).catch((error) => {
      console.error(
        `agents-comm-bus: daemon pid watchdog failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }).finally(() => {
      running = false;
    });
  };
  const timeout = setTimeout(() => {
    run();
    interval = setInterval(run, intervalMs);
  }, initialDelayMs);
  return {
    stop() {
      stopped = true;
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    }
  };
}
async function runDaemonPidWatchdogTick(options) {
  const result = await checkDaemonPidOwnership(options);
  if (result.status === "superseded") {
    await appendAudit(options.audit, {
      kind: "daemon_superseded",
      detail: {
        self_pid: result.selfPid,
        canonical_pid: result.ownerPid
      }
    });
    await options.stopDaemon?.();
    (options.exitProcess ?? ((code) => process.exit(code)))(0);
    return result;
  }
  if (result.status === "reclaimed") {
    await appendAudit(options.audit, {
      kind: "daemon_discovery_reclaimed",
      detail: {
        self_pid: result.selfPid,
        reason: result.reason,
        previous_pid: result.ownerPid
      }
    });
  } else if (result.status === "stayed_alive") {
    await appendAudit(options.audit, {
      kind: "daemon_pid_watchdog_error",
      detail: {
        self_pid: result.selfPid,
        reason: result.reason,
        owner_pid: result.ownerPid,
        error: result.error
      }
    });
  }
  return result;
}
async function checkDaemonPidOwnership(options) {
  const selfPid = options.selfPid ?? process.pid;
  const read = options.readPidFile ?? readPidFile;
  const isPidAlive2 = options.isPidAlive ?? defaultIsPidAlive3;
  const writeDiscovery = options.writeDiscoveryFiles ?? writeDaemonDiscoveryFiles;
  const pidFile = await read(options.pidFile);
  if (pidFile.status === "missing") {
    try {
      await writeDiscovery({
        stateRoot: options.stateRoot,
        discoveryRoot: options.discoveryRoot,
        pid: selfPid,
        port: options.port
      });
      return { status: "reclaimed", selfPid, reason: "missing" };
    } catch (error) {
      return {
        status: "stayed_alive",
        selfPid,
        reason: "reclaim_error",
        error: errorMessage(error)
      };
    }
  }
  if (pidFile.status === "invalid") {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "invalid_pid",
      error: `invalid pid file content: ${JSON.stringify(pidFile.raw)}`
    };
  }
  if (pidFile.status === "error") {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "read_error",
      error: errorMessage(pidFile.error)
    };
  }
  if (pidFile.pid === selfPid) {
    return { status: "current", selfPid };
  }
  let ownerAlive;
  try {
    ownerAlive = isPidAlive2(pidFile.pid);
  } catch (error) {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "liveness_error",
      ownerPid: pidFile.pid,
      error: errorMessage(error)
    };
  }
  if (ownerAlive) {
    return { status: "superseded", selfPid, ownerPid: pidFile.pid };
  }
  try {
    await writeDiscovery({
      stateRoot: options.stateRoot,
      discoveryRoot: options.discoveryRoot,
      pid: selfPid,
      port: options.port
    });
    return {
      status: "reclaimed",
      selfPid,
      reason: "dead_owner",
      ownerPid: pidFile.pid
    };
  } catch (error) {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "reclaim_error",
      ownerPid: pidFile.pid,
      error: errorMessage(error)
    };
  }
}
async function readPidFile(pidFile) {
  try {
    const raw = (await readFile4(pidFile, "utf8")).trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0) return { status: "pid", pid };
    return { status: "invalid", raw };
  } catch (error) {
    if (isFileNotFound(error)) return { status: "missing" };
    return { status: "error", error };
  }
}
function defaultIsPidAlive3(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function appendAudit(audit, event) {
  if (!audit) return;
  await audit.append({ timestamp: Date.now(), ...event });
}
function isFileNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ../core-daemon/bus.ts
import crypto from "node:crypto";

// ../packages/core-contracts/dist/types.js
var SCHEMA_VERSION_QUERY = 1;
var SCHEMA_VERSION_CONVERSATION = 1;
var SCHEMA_VERSION_SESSION = 1;

// ../packages/core-contracts/dist/query-semantics.js
function isExpired(query, now) {
  return query.created_at + query.ttl_seconds * 1e3 <= now;
}
function tryResolve(query, decision, now) {
  if (query.resolution !== void 0) {
    return { kind: "rejected", reason: "already_resolved" };
  }
  if (isExpired(query, now)) {
    return { kind: "rejected", reason: "expired" };
  }
  if (query.origin_chat !== void 0 && !sameChat(query.origin_chat, decision.decided_in_chat)) {
    return { kind: "rejected", reason: "wrong_chat" };
  }
  return { kind: "accepted" };
}
function sameChat(a, b) {
  return a.comm === b.comm && a.account === b.account && a.chat_native_id === b.chat_native_id && a.thread_native_id === b.thread_native_id;
}

// ../packages/core-contracts/dist/security.js
function assertHasOrigin(message) {
  if (!message.origin || !message.origin.agent && !message.origin.comm) {
    throw new Error("Message missing origin label");
  }
}
var RecentSeenCache = class {
  ttlMs;
  seenMap = /* @__PURE__ */ new Map();
  constructor(ttlMs = 6e4) {
    this.ttlMs = ttlMs;
  }
  /** True if the key is currently tracked. Also evicts expired entries. */
  seen(key, now) {
    this.evict(now);
    return this.seenMap.has(key);
  }
  /** Record a key at time `now`. Also evicts expired entries. */
  record(key, now) {
    this.evict(now);
    this.seenMap.set(key, now);
  }
  evict(now) {
    for (const [id, ts] of this.seenMap) {
      if (now - ts > this.ttlMs)
        this.seenMap.delete(id);
    }
  }
};
var DEFAULT_FOREIGN_BOT_POLICY = {
  allowForeignBots: false
};
function isForeignBotAllowed(sender, policy = DEFAULT_FOREIGN_BOT_POLICY) {
  if (!sender.isForeignBot)
    return true;
  if (policy.allowForeignBots)
    return true;
  return policy.allowedBotIds?.includes(sender.id) ?? false;
}

// ../core-daemon/runtime/inbound-message-context.ts
var INBOUND_MESSAGE_CONTEXT_KEY = "__agents_comm_bus_inbound_context";
function readInboundMessageContext(message) {
  const descriptor = Object.getOwnPropertyDescriptor(message, INBOUND_MESSAGE_CONTEXT_KEY);
  const ctx = descriptor?.value;
  if (!ctx || ctx.kind !== "curl_idempotency") return null;
  if (typeof ctx.scope?.registration_id !== "string") return null;
  if (typeof ctx.scope?.sender_id !== "string") return null;
  if (typeof ctx.scope?.client_key !== "string") return null;
  return ctx;
}
function readCurlIdempotencyScope(message) {
  return readInboundMessageContext(message)?.scope ?? null;
}

// ../core-daemon/bus.ts
var MessageBus = class {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.sessionOwnerIsLive = options.sessionOwnerIsLive ?? createSessionOwnerLiveness();
    for (const comm of options.comms ?? []) {
      this.registerComm(comm);
    }
  }
  options;
  /**
   * Adapter map keyed by `${commId}:${accountId}` so multiple bots can share
   * `comm.id` (e.g. one Telegram adapter per agent, each bound to a different
   * `bot_user_id`). `bus.send` resolves `target.account` by concrete bot id
   * only; account labels are display metadata and are rejected as send targets.
   */
  comms = /* @__PURE__ */ new Map();
  seen = new RecentSeenCache();
  now;
  sessionOwnerIsLive;
  dispatchSink = null;
  resolveSinks = [];
  registerComm(comm) {
    const key = adapterKey(comm.id, comm.accountId);
    const existing = this.comms.get(key);
    if (existing && existing !== comm) {
      throw new Error(
        `agents-comm-bus: a comm adapter is already registered for ${key}; each (commId, accountId) pair must be unique`
      );
    }
    this.comms.set(key, comm);
    comm.onInbound(async (message) => {
      const conversation = await this.receiveInbound(message);
      return { conversation_id: conversation.conversation_id };
    });
    comm.onConnectionState((state) => {
      void this.options.audit.append({
        timestamp: this.now(),
        kind: "connection_state_changed",
        detail: { comm: comm.id, account: comm.accountId, connection_state: state }
      });
    });
    comm.onFilterDrop?.((event) => {
      void this.options.audit.append({
        timestamp: this.now(),
        kind: "inbound_filter_drop",
        detail: { comm: comm.id, account: comm.accountId, ...event }
      });
    });
  }
  /**
   * Detach a comm adapter from the bus map. Does NOT call `comm.stop()` —
   * callers (typically the daemon's reload path) are responsible for the
   * lifecycle so they can sequence stop + detach in the order they want.
   * Returns the removed adapter so the caller can stop it, or null if no
   * adapter was registered for that `(commId, accountId)`.
   */
  unregisterComm(commId, accountId) {
    const key = adapterKey(commId, accountId);
    const adapter = this.comms.get(key);
    if (!adapter) return null;
    this.comms.delete(key);
    return adapter;
  }
  /** List the `(commId, accountId)` pairs currently attached to the bus. */
  listComms() {
    return Array.from(this.comms.values()).map((comm) => ({
      commId: comm.id,
      accountId: comm.accountId
    }));
  }
  /**
   * Look up a currently-attached adapter by `(commId, accountId)`. Used by
   * the daemon's reload path to refresh per-adapter state (e.g. allowlist
   * updates) without tearing down and recreating the adapter.
   */
  getComm(commId, accountId) {
    return this.comms.get(adapterKey(commId, accountId)) ?? null;
  }
  setDispatchSink(sink) {
    this.dispatchSink = sink;
  }
  setResolveSink(sink) {
    this.resolveSinks.push(sink);
  }
  async start() {
    for (const comm of this.comms.values()) {
      await comm.start();
    }
  }
  async stop() {
    for (const comm of this.comms.values()) {
      await comm.stop();
    }
  }
  async receiveInbound(message) {
    assertHasOrigin(message);
    const curlScope = readCurlIdempotencyScope(message);
    if (curlScope) {
      return this.receiveInboundForCurlIdempotency(message, curlScope);
    }
    const seenKey = `${message.chat.comm}:${message.chat.account}:${message.message_id}`;
    if (this.seen.seen(seenKey, this.now())) {
      await this.options.audit.append({
        timestamp: this.now(),
        kind: "loop_prevention_drop",
        detail: {
          message_id: message.message_id,
          comm: message.chat.comm,
          account: message.chat.account,
          reason: "recently_seen"
        }
      });
      throw new Error(`duplicate inbound message: ${seenKey}`);
    }
    this.seen.record(seenKey, this.now());
    const receivingAdapter = this.comms.get(
      adapterKey(message.chat.comm, message.chat.account)
    );
    const foreignBotPolicy = {
      allowForeignBots: false,
      allowedBotIds: receivingAdapter?.allowedSenderIds
    };
    if (!isForeignBotAllowed(message.sender, foreignBotPolicy)) {
      await this.options.audit.append({
        timestamp: this.now(),
        kind: "loop_prevention_drop",
        detail: {
          message_id: message.message_id,
          reason: "foreign_bot",
          sender_id: message.sender.id,
          // AGE-10: enough context to identify WHICH bot/chat dropped the
          // message without a bypass probe.
          comm: message.chat.comm,
          account: message.chat.account,
          chat_native_id: message.chat.chat_native_id,
          platform_message_id: message.platform_message_id,
          sender_is_bot: message.sender.isBot
        }
      });
      throw new Error(`foreign bot sender rejected: ${message.sender.id}`);
    }
    const registration = await this.registrationFor(message.chat);
    const conversation = await this.upsertConversation(registration, message);
    await this.options.transcripts.append({
      conversation_id: conversation.conversation_id,
      timestamp: message.received_at,
      direction: "inbound",
      message_id: message.message_id,
      payload: message
    });
    await this.options.storage.touchConversationInbound(
      conversation.conversation_id,
      message.received_at,
      message.message_id
    );
    await this.options.audit.append({
      timestamp: this.now(),
      kind: "inbound_received",
      agent: registration.agent,
      conversation_id: conversation.conversation_id,
      detail: {
        comm: registration.comm,
        account: message.chat.account,
        account_label: registration.account_label,
        platform_message_id: message.platform_message_id
      }
    });
    const consumedByQuery = await this.tryResolveOpenQuery(conversation, message);
    if (consumedByQuery) return conversation;
    if (this.dispatchSink) {
      await this.dispatchSink.enqueueInbound(message, conversation);
    }
    return conversation;
  }
  /**
   * AGE-96: crash-resumable inbound path for curl POSTs that carry an
   * idempotency scope. Progress markers live on the scoped curl receipt —
   * the default receiveInbound path above is unchanged for all other comms.
   */
  async receiveInboundForCurlIdempotency(message, scope) {
    const storage = this.options.storage;
    let receipt = await storage.getCurlInboundReceipt(scope);
    if (!receipt) {
      throw new Error(
        `curl idempotency receipt missing for ${scope.registration_id}/${scope.sender_id}`
      );
    }
    if (receipt.state === "accepted" && receipt.conversation_id) {
      const done = await storage.getConversation(receipt.conversation_id);
      if (done) return done;
    }
    const receivingAdapter = this.comms.get(
      adapterKey(message.chat.comm, message.chat.account)
    );
    const foreignBotPolicy = {
      allowForeignBots: false,
      allowedBotIds: receivingAdapter?.allowedSenderIds
    };
    if (!isForeignBotAllowed(message.sender, foreignBotPolicy)) {
      await this.options.audit.append({
        timestamp: this.now(),
        kind: "loop_prevention_drop",
        detail: {
          message_id: message.message_id,
          reason: "foreign_bot",
          sender_id: message.sender.id,
          comm: message.chat.comm,
          account: message.chat.account,
          chat_native_id: message.chat.chat_native_id,
          platform_message_id: message.platform_message_id,
          sender_is_bot: message.sender.isBot
        }
      });
      throw new Error(`foreign bot sender rejected: ${message.sender.id}`);
    }
    const registration = await this.registrationFor(message.chat);
    this.assertCurlIdempotencyScope(message, scope, registration, receipt);
    let conversation;
    if (receipt.conversation_id) {
      conversation = await storage.getConversation(receipt.conversation_id) ?? await this.upsertConversation(registration, message);
    } else {
      conversation = await this.upsertConversation(registration, message);
      await storage.markCurlReceiptConversation(scope, conversation.conversation_id);
    }
    receipt = await storage.getCurlInboundReceipt(scope) ?? receipt;
    const now = this.now();
    if (receipt.transcript_recorded_at == null) {
      const recordedAt = await this.transcriptInboundTimestamp(
        conversation.conversation_id,
        message.message_id
      );
      if (recordedAt == null) {
        await this.options.transcripts.append({
          conversation_id: conversation.conversation_id,
          timestamp: message.received_at,
          direction: "inbound",
          message_id: message.message_id,
          payload: message
        });
      }
      await storage.touchConversationInbound(
        conversation.conversation_id,
        recordedAt ?? message.received_at,
        message.message_id
      );
      await storage.markCurlReceiptTranscript(scope, now);
    }
    receipt = await storage.getCurlInboundReceipt(scope) ?? receipt;
    const auditAt = receipt.audit_recorded_at ?? receipt.reserved_at;
    const auditDone = receipt.audit_recorded_at != null || await this.auditHasInboundReceived(conversation.conversation_id, message, auditAt);
    if (!auditDone) {
      await this.options.audit.append({
        timestamp: auditAt,
        kind: "inbound_received",
        agent: registration.agent,
        conversation_id: conversation.conversation_id,
        detail: {
          comm: registration.comm,
          account: message.chat.account,
          account_label: registration.account_label,
          platform_message_id: message.platform_message_id
        }
      });
      await storage.markCurlReceiptAudit(scope, auditAt);
    }
    receipt = await storage.getCurlInboundReceipt(scope) ?? receipt;
    if (receipt.query_consumed_at == null) {
      const consumedByQuery = await this.tryResolveOpenQuery(conversation, message, {
        scope,
        receipt,
        now
      });
      if (consumedByQuery) return conversation;
    }
    receipt = await storage.getCurlInboundReceipt(scope) ?? receipt;
    const dispatchDone = receipt.query_consumed_at != null || receipt.dispatch_recorded_at != null || await storage.hasPendingInboundDelivery({
      conversation_id: conversation.conversation_id,
      message_id: message.message_id,
      comm: message.chat.comm,
      account: String(message.chat.account)
    });
    if (!dispatchDone && this.dispatchSink) {
      await this.dispatchSink.enqueueInbound(message, conversation);
      await storage.markCurlReceiptDispatch(scope, now);
    }
    return conversation;
  }
  async transcriptInboundTimestamp(conversation_id, message_id) {
    for await (const entry of this.options.transcripts.read(conversation_id)) {
      if (entry.direction === "inbound" && entry.message_id === message_id) {
        return entry.timestamp;
      }
    }
    return null;
  }
  assertCurlIdempotencyScope(message, scope, registration, receipt) {
    if (message.chat.comm !== "curl") {
      throw new Error(
        `curl idempotency context on non-curl message: ${message.chat.comm}`
      );
    }
    if (scope.registration_id !== registration.registration_id) {
      throw new Error(
        `curl idempotency registration_id mismatch: scope=${scope.registration_id} registration=${registration.registration_id}`
      );
    }
    if (scope.sender_id !== message.sender.id) {
      throw new Error(
        `curl idempotency sender_id mismatch: scope=${scope.sender_id} message=${message.sender.id}`
      );
    }
    if (receipt.message_id !== message.message_id) {
      throw new Error(
        `curl idempotency message_id mismatch: receipt=${receipt.message_id} message=${message.message_id}`
      );
    }
  }
  async auditHasInboundReceived(conversation_id, message, auditProbeAt) {
    const audit = this.options.audit;
    if (typeof audit.hasInboundReceived !== "function") return false;
    return audit.hasInboundReceived(conversation_id, message, auditProbeAt);
  }
  async send(request) {
    let target;
    try {
      target = request.target ?? await this.targetFromSession(request.session);
    } catch (cause) {
      await this.auditRoutingFailure("target_resolution_failed", request, cause);
      throw cause;
    }
    if (target.comm !== request.comm) {
      const error = new Error(`target comm ${target.comm} does not match requested comm ${request.comm}`);
      await this.auditRoutingFailure("comm_mismatch", request, error, target);
      throw error;
    }
    let registration;
    try {
      registration = await this.registrationFor(target);
    } catch (cause) {
      await this.auditRoutingFailure("registration_resolution_failed", request, cause, target);
      throw cause;
    }
    const comm = this.comms.get(adapterKey(target.comm, registration.bot_user_id));
    if (!comm) {
      const error = new Error(
        `comm adapter not registered: ${target.comm}/${registration.bot_user_id}`
      );
      await this.auditRoutingFailure("adapter_not_registered", request, error, target, registration);
      throw error;
    }
    let sent;
    try {
      sent = await comm.send(
        target,
        request.payload,
        request.idempotencyKey ?? randomId("outbound")
      );
    } catch (error) {
      let failureClassification;
      try {
        failureClassification = comm.classifyFailure(error);
      } catch {
        failureClassification = void 0;
      }
      try {
        await this.options.audit.append({
          timestamp: this.now(),
          kind: "outbound_failed",
          agent: registration.agent,
          session: request.session,
          detail: {
            comm: request.comm,
            account: registration.bot_user_id,
            account_label: registration.account_label,
            chat_native_id: target.chat_native_id,
            thread_native_id: target.thread_native_id ?? null,
            requested_account: request.target?.account ?? null,
            error: error instanceof Error ? error.message : String(error),
            ...failureClassification !== void 0 ? { failure_classification: failureClassification } : {}
          }
        });
      } catch {
      }
      throw error;
    }
    const messageId = makeMessageId(request.comm, sent.platform_message_id);
    const conversation = await this.findConversationForTarget(target);
    await this.options.transcripts.append({
      conversation_id: conversation.conversation_id,
      timestamp: sent.sent_at,
      direction: "outbound",
      message_id: messageId,
      payload: { target, payload: request.payload, platform_message_id: sent.platform_message_id }
    });
    await this.options.storage.touchConversationOutbound(
      conversation.conversation_id,
      sent.sent_at,
      messageId
    );
    await this.options.audit.append({
      timestamp: this.now(),
      kind: "outbound_sent",
      agent: registration.agent,
      session: request.session,
      conversation_id: conversation.conversation_id,
      // Record the RESOLVED sending account so the audit can confirm which bot
      // a message went out on (AGE-15: this was `account=-`, making the
      // 2026-05-30 misroute undiagnosable from the audit alone). Also keep the
      // caller's original requested account to spot label-vs-id mismatches.
      detail: {
        comm: request.comm,
        platform_message_id: sent.platform_message_id,
        account: registration.bot_user_id,
        account_label: registration.account_label,
        chat_native_id: target.chat_native_id,
        thread_native_id: target.thread_native_id ?? null,
        requested_account: request.target?.account ?? null
      }
    });
    return messageId;
  }
  async openQuery(query) {
    let originChatId = null;
    if (query.origin_chat) {
      try {
        const registration = await this.registrationFor(query.origin_chat);
        const conversation = await this.options.storage.findConversation({
          project: normalizeProjectPath(registration.project),
          agent: registration.agent,
          comm: query.origin_chat.comm,
          bot_user_id: registration.bot_user_id,
          registration_id: registration.registration_id,
          chat_native_id: query.origin_chat.chat_native_id,
          thread_native_id: query.origin_chat.thread_native_id ?? null
        });
        originChatId = conversation?.conversation_id ?? null;
      } catch {
        originChatId = null;
      }
    }
    const record = {
      schema_version: SCHEMA_VERSION_QUERY,
      query_id: query.query_id,
      agent: query.agent,
      session: query.session,
      kind: query.kind,
      prompt_text: query.prompt_text,
      created_at: query.created_at,
      ttl_seconds: query.ttl_seconds,
      origin_chat_id: originChatId,
      source_message_id: query.source_message_id ?? null,
      resolved_at: null,
      resolution: null,
      options_json: query.options ? JSON.stringify(query.options) : null
    };
    await this.options.storage.insertQuery(record);
    await this.options.audit.append({
      timestamp: this.now(),
      kind: "query_opened",
      agent: query.agent,
      session: query.session,
      conversation_id: record.origin_chat_id ?? void 0,
      detail: { query_id: query.query_id, kind: query.kind }
    });
  }
  async tryResolveOpenQuery(conversation, message, curlRecovery) {
    const storage = this.options.storage;
    if (curlRecovery?.receipt.planned_query_id) {
      const plannedId = curlRecovery.receipt.planned_query_id;
      const record = await storage.getQuery(plannedId);
      if (!record) return false;
      if (record.resolved_at != null) {
        await storage.markCurlReceiptQueryConsumed(curlRecovery.scope, curlRecovery.now);
        return true;
      }
      if (!message.text) return false;
      const chat2 = chatRefFromConversation(conversation);
      const decision = decisionFromMessage(record, message, chat2, this.now());
      if (!decision) return false;
      return this.resolveQueryForCurlRecovery(plannedId, decision, curlRecovery);
    }
    if (!message.text) return false;
    const open5 = await this.options.storage.listOpenQueriesByConversation(
      conversation.conversation_id
    );
    if (open5.length === 0) return false;
    const chat = chatRefFromConversation(conversation);
    if (message.reply_to) {
      const target = open5.find((q) => q.source_message_id === message.reply_to);
      if (target) {
        const decision = decisionFromMessage(target, message, chat, this.now());
        if (!decision) return false;
        return this.resolveQueryForCurlRecovery(
          target.query_id,
          decision,
          curlRecovery
        );
      }
    }
    const candidates = open5.map((q) => ({
      query: q,
      decision: decisionFromMessage(q, message, chat, this.now())
    })).filter((entry) => entry.decision !== null);
    const strict = candidates.filter((entry) => entry.query.kind !== "freetext");
    const pool = strict.length > 0 ? strict : candidates;
    if (pool.length === 1) {
      return this.resolveQueryForCurlRecovery(
        pool[0].query.query_id,
        pool[0].decision,
        curlRecovery
      );
    }
    if (pool.length > 1) {
      await this.sendAmbiguousReplyHelper(
        conversation,
        pool.map((entry) => entry.query),
        message
      );
      if (curlRecovery) {
        await storage.markCurlReceiptQueryConsumed(curlRecovery.scope, curlRecovery.now);
      }
      return true;
    }
    return false;
  }
  async resolveQueryForCurlRecovery(queryId, decision, curlRecovery) {
    if (curlRecovery) {
      await this.options.storage.markCurlReceiptPlannedQuery(
        curlRecovery.scope,
        queryId
      );
    }
    const resolved = await this.resolveQuery(queryId, decision);
    if (curlRecovery && resolved) {
      await this.options.storage.markCurlReceiptQueryConsumed(
        curlRecovery.scope,
        curlRecovery.now
      );
    }
    return resolved;
  }
  /**
   * AGE-9: a bare reply matched more than one open query — never guess which
   * one was meant. Tell the user how to disambiguate (buttons are precise;
   * replying to the specific prompt message is precise). Best-effort: a
   * helper-send failure must not block inbound processing.
   */
  async sendAmbiguousReplyHelper(conversation, matched, message) {
    try {
      await this.send({
        session: matched[0].session,
        comm: conversation.comm,
        target: chatRefFromConversation(conversation),
        payload: {
          text: `\u26A0\uFE0F ${matched.length} prompts are open \u2014 I can't tell which one you answered. Tap a button on the prompt, or reply directly to the specific prompt message.`
        },
        idempotencyKey: `query-ambiguous:${message.message_id}`
      });
      await this.options.audit.append({
        timestamp: this.now(),
        kind: "query_ambiguous_reply",
        detail: {
          message_id: message.message_id,
          open_query_ids: matched.map((q) => q.query_id)
        }
      });
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to send ambiguous-reply helper: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async resolveQuery(queryId, decision) {
    const record = await this.options.storage.getQuery(queryId);
    if (!record) return false;
    const query = {
      schema_version: record.schema_version,
      query_id: record.query_id,
      agent: record.agent,
      session: record.session,
      kind: record.kind,
      prompt_text: record.prompt_text,
      created_at: record.created_at,
      ttl_seconds: record.ttl_seconds,
      source_message_id: record.source_message_id ?? void 0,
      options: record.options_json ? JSON.parse(record.options_json) : void 0,
      resolution: record.resolution ?? void 0
    };
    const result = tryResolve(query, decision, this.now());
    if (result.kind === "rejected") {
      await this.options.audit.append({
        timestamp: this.now(),
        kind: result.reason === "expired" ? "query_expired" : "query_rejected_stale",
        agent: record.agent,
        session: record.session,
        detail: { query_id: queryId, reason: result.reason }
      });
      return false;
    }
    const resolved = await this.options.storage.resolveQuery(
      queryId,
      decision,
      decision.decided_at
    );
    if (resolved) {
      await this.options.audit.append({
        timestamp: this.now(),
        kind: "query_resolved",
        agent: record.agent,
        session: record.session,
        detail: { query_id: queryId, decision: decision.decision }
      });
      await this.notifyResolveSinks(record, decision, queryId);
    }
    return resolved;
  }
  async resolveQueryFromCallback(input) {
    const open5 = await this.options.storage.getOpenQueryById(input.queryId);
    if (!open5) {
      const existing = await this.options.storage.getQuery(input.queryId);
      return { kind: existing ? "already_resolved" : "unknown_query" };
    }
    if (input.value === "other") {
      const ok = await this.options.storage.updateQueryKind(input.queryId, "freetext");
      if (!ok) return { kind: "already_resolved" };
      return { kind: "awaiting_freetext", query: open5 };
    }
    const decision = decisionFromCallbackValue(open5, input.value, input.fromId, input.chat, this.now());
    if (!decision) return { kind: "invalid_value", value: input.value };
    const stored = await this.options.storage.resolveQuery(
      input.queryId,
      decision,
      decision.decided_at
    );
    if (!stored) {
      const post = await this.options.storage.getQuery(input.queryId);
      if (post && post.resolved_at != null) return { kind: "already_resolved" };
      return { kind: "expired" };
    }
    await this.options.audit.append({
      timestamp: this.now(),
      kind: "query_resolved",
      agent: open5.agent,
      session: open5.session,
      detail: { query_id: input.queryId, decision: decision.decision, via: "callback" }
    });
    await this.notifyResolveSinks(open5, decision, input.queryId);
    return { kind: "resolved", decision, query: open5 };
  }
  async listConversations(filter) {
    return this.options.storage.listConversations({
      project: this.options.project,
      comm: filter?.comm,
      limit: filter?.limit
    });
  }
  /**
   * Resolve a routing target to its registration by the concrete
   * `bot_user_id` ONLY (AGE-15). Account labels (e.g. `"main"`) are human
   * metadata, not durable routing keys: Claude and Codex both register
   * `account_label="main"`, so resolving a label is inherently ambiguous and
   * can surface one agent's outbound on the other's bot (`cbc4a43`, the
   * 2026-05-30 misroute). The prior cross-project label fallback was the bug;
   * it is removed. Every legitimate caller already passes a concrete bot id:
   * inbound carries it from the adapter, session-derived sends resolve it via
   * `targetFromSession`, and `origin_chat` is built by `chatRefForConversation`
   * (which returns `bot_user_id`). A label reaching here now fails loud.
   */
  /**
   * AGE-95: best-effort audit of a pre-adapter routing failure. NEVER throws —
   * an audit-append failure must not mask the original routing error
   * (rethrow-literal, same discipline as AGE-93). Context is progressive:
   * request comm/session/requested account always; resolved target when known;
   * registration identity only after it resolves. No payload content.
   */
  async auditRoutingFailure(reason, request, cause, target, registration) {
    try {
      await this.options.audit.append({
        timestamp: this.now(),
        kind: "outbound_routing_failed",
        agent: registration?.agent,
        session: request.session,
        detail: {
          reason,
          comm: request.comm,
          requested_account: request.target?.account ?? null,
          ...target ? {
            target_comm: target.comm,
            target_account: target.account,
            chat_native_id: target.chat_native_id,
            thread_native_id: target.thread_native_id ?? null
          } : {},
          ...registration ? {
            account: registration.bot_user_id,
            account_label: registration.account_label
          } : {},
          error: cause instanceof Error ? cause.message : String(cause)
        }
      });
    } catch {
    }
  }
  async registrationFor(chat) {
    const byBot = await this.options.storage.getAccountByBot(
      chat.comm,
      String(chat.account)
    );
    if (byBot) return byBot;
    throw new Error(
      `Cannot route to ${chat.comm} account "${chat.account}": not a registered bot id. Routing requires a concrete bot_user_id (shown as account=<id> in your inbound block); account labels like "main" are not accepted as routing targets. Omit target to reply to your most-recent inbound conversation.`
    );
  }
  async upsertConversation(registration, message) {
    const conversation = {
      schema_version: SCHEMA_VERSION_CONVERSATION,
      project: normalizeProjectPath(registration.project),
      comm: registration.comm,
      account_label: registration.account_label,
      bot_user_id: registration.bot_user_id,
      registration_id: registration.registration_id,
      chat_native_id: message.chat.chat_native_id,
      thread_native_id: message.chat.thread_native_id ?? null,
      // AGE-20 Phase 3a: a NEW conversation gets a pure opaque surrogate, never
      // derived from any mutable field. Storage reuses the existing stable id for
      // an existing conversation (the candidate here is only used on first insert).
      conversation_id: freshConversationId(),
      agent: registration.agent,
      last_inbound_at: message.received_at,
      last_outbound_at: null,
      last_message_id: message.message_id,
      created_at: this.now(),
      metadata: {
        sender_id: message.sender.id,
        sender_display_name: message.sender.display_name
      }
    };
    const conversationId = await this.options.storage.upsertConversation(conversation);
    return { ...conversation, conversation_id: conversationId };
  }
  async targetFromSession(session) {
    const record = await this.options.storage.getSession(session);
    const conversationId = record?.most_recent_inbound_conversation_id;
    if (!conversationId) {
      throw new Error(
        `no explicit target and session ${session} has no most-recent inbound conversation`
      );
    }
    const conversation = await this.options.storage.getConversation(conversationId);
    if (!conversation) throw new Error(`conversation not found: ${conversationId}`);
    const sessions = record ? await this.options.storage.listSessions({
      project: record.project,
      agent: record.agent,
      status: "active"
    }) : [];
    if (record && !sessionOwnsConversation(
      record,
      sessions,
      conversation,
      this.sessionOwnerIsLive
    )) {
      throw new Error(
        `session ${session} does not own most-recent inbound conversation ${conversationId} (${conversation.comm}:${conversation.account_label})`
      );
    }
    const botUserId = await this.botUserIdForConversation(conversation);
    return {
      ...chatRefFromConversation(conversation),
      account: botUserId
    };
  }
  async findConversationForTarget(target) {
    const registration = await this.registrationFor(target);
    const conversation = await this.options.storage.findConversation({
      project: normalizeProjectPath(registration.project),
      agent: registration.agent,
      comm: target.comm,
      bot_user_id: registration.bot_user_id,
      registration_id: registration.registration_id,
      chat_native_id: target.chat_native_id,
      thread_native_id: target.thread_native_id ?? null
    });
    if (!conversation) {
      const created = {
        schema_version: SCHEMA_VERSION_CONVERSATION,
        project: normalizeProjectPath(registration.project),
        comm: registration.comm,
        account_label: registration.account_label,
        bot_user_id: registration.bot_user_id,
        registration_id: registration.registration_id,
        chat_native_id: target.chat_native_id,
        thread_native_id: target.thread_native_id ?? null,
        conversation_id: freshConversationId(),
        agent: registration.agent,
        last_inbound_at: null,
        last_outbound_at: null,
        last_message_id: null,
        created_at: this.now(),
        metadata: { created_from_explicit_target: true }
      };
      const conversationId = await this.options.storage.upsertConversation(created);
      return { ...created, conversation_id: conversationId };
    }
    return conversation;
  }
  async botUserIdForConversation(conversation) {
    if (conversation.bot_user_id) return conversation.bot_user_id;
    const registrations = await this.options.storage.listAccountRegistrations({
      project: conversation.project,
      comm: conversation.comm,
      agent: conversation.agent
    });
    const registration = registrations.find(
      (candidate) => candidate.registration_id === conversation.registration_id
    );
    if (!registration) {
      throw new Error(
        `no account registration for conversation ${conversation.conversation_id} (${conversation.agent}/${conversation.comm}/registration_id=${conversation.registration_id})`
      );
    }
    return registration.bot_user_id;
  }
  async notifyResolveSinks(record, decision, queryId) {
    for (const sink of this.resolveSinks) {
      try {
        await sink.onResolved(record, decision);
      } catch (error) {
        await this.options.audit.append({
          timestamp: this.now(),
          kind: "outbound_failed",
          agent: record.agent,
          session: record.session,
          detail: {
            query_id: queryId,
            reason: "resolve_sink_failed",
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }
};
function freshConversationId() {
  return `conv_${crypto.randomBytes(12).toString("hex")}`;
}
function chatRefFromConversation(conversation) {
  return {
    comm: conversation.comm,
    // Legacy/null bot_user_id fallback only preserves chat shape for display
    // and query resolution. Send paths must resolve a real bot id first.
    account: conversation.bot_user_id ?? conversation.account_label,
    chat_native_id: conversation.chat_native_id,
    thread_native_id: conversation.thread_native_id ?? void 0
  };
}
function makeMessageId(comm, platformMessageId) {
  return `${comm}:${platformMessageId}`;
}
function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
function decisionFromMessage(query, message, chat, now) {
  const text = message.text?.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  let decision = null;
  let selected_option_index;
  let responseText;
  if (query.kind === "approval") {
    if (["y", "yes", "allow"].includes(lower)) decision = "allow";
    else if (["n", "no", "deny"].includes(lower)) decision = "deny";
    else if (["a", "always", "always_allow"].includes(lower)) decision = "always_allow";
  } else if (query.kind === "choice") {
    const choice = Number.parseInt(text, 10);
    if (!Number.isNaN(choice) && choice > 0) {
      decision = "select_option";
      selected_option_index = choice - 1;
    }
  } else {
    decision = "text";
    responseText = text;
  }
  if (!decision) return null;
  return {
    query_id: query.query_id,
    decision,
    selected_option_index,
    text: responseText,
    decided_by_sender_id: message.sender.id,
    decided_in_chat: chat,
    decided_at: now
  };
}
function decisionFromCallbackValue(query, value, fromId, chat, now) {
  let decision = null;
  let selected_option_index;
  if (query.kind === "approval") {
    if (value === "y") decision = "allow";
    else if (value === "n") decision = "deny";
    else if (value === "a") decision = "always_allow";
  } else if (query.kind === "choice") {
    const choice = Number.parseInt(value, 10);
    if (!Number.isNaN(choice) && choice > 0) {
      decision = "select_option";
      selected_option_index = choice - 1;
    }
  }
  if (!decision) return null;
  return {
    query_id: query.query_id,
    decision,
    selected_option_index,
    decided_by_sender_id: fromId,
    decided_in_chat: chat,
    decided_at: now
  };
}
function adapterKey(commId, accountId) {
  return `${commId}:${accountId}`;
}

// ../core-daemon/storage/sqlite.ts
import { createRequire } from "node:module";

// ../core-daemon/storage/schema/runner.ts
import { readFile as readFile5 } from "node:fs/promises";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
var SqliteMigrationRunner = class {
  constructor(db) {
    this.db = db;
  }
  db;
  async getCurrentVersion() {
    const row = this.db.prepare("PRAGMA user_version").get();
    return row.user_version;
  }
  async setVersion(version) {
    this.db.exec(`PRAGMA user_version = ${version}`);
  }
  async apply(migrations) {
    const current = await this.getCurrentVersion();
    const pending = migrations.filter((migration) => migration.version > current).sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      await migration.up({ exec: async (sql) => this.db.exec(sql) });
      await this.setVersion(migration.version);
    }
  }
};
var schemaDir = dirname2(fileURLToPath(import.meta.url));
var initialMigration = {
  version: 1,
  description: "initial storage schema",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "001_initial.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var conversationAgentIdentityMigration = {
  version: 2,
  description: "include agent in conversation identity",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "002_conversation_agent_identity.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var allowlistMigration = {
  version: 3,
  description: "add allowlist_global and allowlist_per_bot tables",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "003_allowlist.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var sessionOwnerProcessMigration = {
  version: 4,
  description: "track owning agent process for session leases",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "004_session_owner_process.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var conversationBotIdentityMigration = {
  version: 5,
  description: "store receiving bot identity on conversations",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "005_conversation_bot_identity.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var registrationIdentityMigration = {
  version: 6,
  description: "add immutable registration_id surrogate to registrations + conversations",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "006_registration_identity.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var registrationPkMigration = {
  version: 7,
  description: "make registration_id the canonical primary key of account_registrations",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "007_registration_pk.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var conversationRegistrationKeyMigration = {
  version: 8,
  description: "re-key conversations on (registration_id, chat, thread) + drop account_label",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "008_conversation_registration_key.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var multiOpenQueriesMigration = {
  version: 9,
  description: "AGE-9: drop the one-open-query-per-session unique index (policy moves to callers)",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "009_multi_open_queries.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var durablePendingInboundMigration = {
  version: 10,
  description: "AGE-56: durable pending inbound delivery rows",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "010_durable_pending_inbound.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var sessionDaemonOwnerMigration = {
  version: 11,
  description: "AGE-58: stamp daemon-instance identity on session leases",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "011_session_daemon_owner.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var sessionLabelScopeMigration = {
  version: 12,
  description: "AGE-72: per-session comm account-label scoping",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "012_session_label_scope.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var curlInboundIdempotencyMigration = {
  version: 13,
  description: "AGE-96: curl inbound idempotency receipts + acceptance progress",
  async up(ctx) {
    const sql = await readFile5(join3(schemaDir, "013_curl_inbound_idempotency.sql"), "utf8");
    await ctx.exec(sql);
  }
};
async function runStorageMigrations(db) {
  await new SqliteMigrationRunner(db).apply([
    initialMigration,
    conversationAgentIdentityMigration,
    allowlistMigration,
    sessionOwnerProcessMigration,
    conversationBotIdentityMigration,
    registrationIdentityMigration,
    registrationPkMigration,
    conversationRegistrationKeyMigration,
    multiOpenQueriesMigration,
    durablePendingInboundMigration,
    sessionDaemonOwnerMigration,
    sessionLabelScopeMigration,
    curlInboundIdempotencyMigration
  ]);
}

// ../core-daemon/storage/sqlite.ts
var require2 = createRequire(import.meta.url);
var { DatabaseSync } = require2("node:sqlite");
function encodeJson(value) {
  return value === void 0 || value === null ? null : JSON.stringify(value);
}
function decodeJson(value) {
  return typeof value === "string" ? JSON.parse(value) : null;
}
function dbThreadId(value) {
  return value ?? "";
}
function recordThreadId(value) {
  return value === "" ? null : value;
}
var SqliteStorage = class _SqliteStorage {
  constructor(db) {
    this.db = db;
  }
  db;
  static async open(path8) {
    const db = new DatabaseSync(path8);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    await runStorageMigrations(db);
    return new _SqliteStorage(db);
  }
  async putAccountRegistration(rec) {
    const project = normalizeProjectPath(rec.project);
    this.db.prepare(`
        INSERT INTO account_registrations (
          schema_version, registration_id, project, comm, agent, account_label,
          bot_user_id, credentials_ref, bot_username, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, comm, agent, account_label) DO UPDATE SET
          bot_user_id = excluded.bot_user_id,
          credentials_ref = excluded.credentials_ref,
          bot_username = excluded.bot_username,
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json
      `).run(
      rec.schema_version,
      rec.registration_id ?? null,
      project,
      rec.comm,
      rec.agent,
      rec.account_label,
      rec.bot_user_id,
      rec.credentials_ref,
      rec.bot_username ?? null,
      rec.created_at,
      rec.updated_at,
      encodeJson(rec.metadata)
    );
  }
  async getAccountByBot(comm, bot_user_id) {
    const row = this.db.prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?").get(comm, bot_user_id);
    return row ? this.accountFromRow(row) : null;
  }
  async listAccountRegistrations(filter = {}) {
    const normalizedFilter = {
      ...filter,
      project: filter.project === void 0 ? void 0 : normalizeProjectPath(filter.project)
    };
    const clauses = [];
    const params = [];
    for (const key of ["project", "comm", "agent"]) {
      if (normalizedFilter[key] !== void 0) {
        clauses.push(`${key} = ?`);
        params.push(normalizedFilter[key]);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM account_registrations ${where} ORDER BY created_at, account_label`).all(...params);
    return rows.map((row) => this.accountFromRow(row));
  }
  async deleteAccountRegistration(project, comm, agent, account_label) {
    this.db.prepare(`
        DELETE FROM account_registrations
        WHERE project = ? AND comm = ? AND agent = ? AND account_label = ?
      `).run(normalizeProjectPath(project), comm, agent, account_label);
  }
  async updateAccountRegistrationToken(input) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousRow = this.db.prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?").get(input.comm, input.current_bot_user_id);
      if (!previousRow) {
        throw new Error(
          `no account registration found for (comm=${input.comm}, bot-id=${input.current_bot_user_id})`
        );
      }
      const previous = this.accountFromRow(previousRow);
      const botChanged = input.current_bot_user_id !== input.new_bot_user_id;
      if (botChanged) {
        const existing = this.db.prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?").get(input.comm, input.new_bot_user_id);
        if (existing) {
          const row = this.accountFromRow(existing);
          throw new Error(
            `${input.comm} bot id ${input.new_bot_user_id} is already registered as project=${row.project}, agent=${row.agent}, account_label=${row.account_label}`
          );
        }
        const allowlistConflict = this.db.prepare(`
            SELECT sender_id FROM allowlist_per_bot
            WHERE comm = ? AND bot_user_id = ?
              AND sender_id IN (
                SELECT sender_id FROM allowlist_per_bot
                WHERE comm = ? AND bot_user_id = ?
              )
            LIMIT 1
          `).get(input.comm, input.current_bot_user_id, input.comm, input.new_bot_user_id);
        if (allowlistConflict) {
          const row = allowlistConflict;
          throw new Error(
            `cannot move ${input.comm} bot id ${input.current_bot_user_id} to ${input.new_bot_user_id}: allowlist row already exists for sender ${row.sender_id ?? "(unknown)"}`
          );
        }
      }
      const accountResult = this.db.prepare(`
          UPDATE account_registrations
          SET bot_user_id = ?,
              credentials_ref = ?,
              bot_username = ?,
              updated_at = ?
          WHERE comm = ? AND bot_user_id = ?
        `).run(
        input.new_bot_user_id,
        input.credentials_ref,
        input.bot_username ?? null,
        input.updated_at,
        input.comm,
        input.current_bot_user_id
      );
      if (Number(accountResult.changes ?? 0) !== 1) {
        throw new Error(
          `failed to update account registration for ${input.comm}/${input.current_bot_user_id}`
        );
      }
      let migratedAllowlistRows = 0;
      let migratedConversationRows = 0;
      if (botChanged) {
        const allowlistResult = this.db.prepare(`
            UPDATE allowlist_per_bot
            SET bot_user_id = ?
            WHERE comm = ? AND bot_user_id = ?
          `).run(input.new_bot_user_id, input.comm, input.current_bot_user_id);
        migratedAllowlistRows = Number(allowlistResult.changes ?? 0);
        const conversationResult = this.db.prepare(`
            UPDATE conversations
            SET bot_user_id = ?
            WHERE comm = ? AND bot_user_id = ?
          `).run(input.new_bot_user_id, input.comm, input.current_bot_user_id);
        migratedConversationRows = Number(conversationResult.changes ?? 0);
      }
      const nextRow = this.db.prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?").get(input.comm, input.new_bot_user_id);
      if (!nextRow) {
        throw new Error(
          `updated account registration not found for ${input.comm}/${input.new_bot_user_id}`
        );
      }
      this.db.exec("COMMIT");
      return {
        previous,
        next: this.accountFromRow(nextRow),
        bot_changed: botChanged,
        migrated_allowlist_rows: migratedAllowlistRows,
        migrated_conversation_rows: migratedConversationRows
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async updateAccountRegistrationLabel(input) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousRow = this.db.prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?").get(input.comm, input.bot_user_id);
      if (!previousRow) {
        throw new Error(
          `no account registration found for (comm=${input.comm}, bot-id=${input.bot_user_id})`
        );
      }
      const previous = this.accountFromRow(previousRow);
      if (previous.account_label === input.account_label) {
        this.db.exec("COMMIT");
        return { previous, next: previous };
      }
      const collision = this.db.prepare(`
          SELECT * FROM account_registrations
          WHERE project = ? AND comm = ? AND agent = ? AND account_label = ?
        `).get(previous.project, previous.comm, previous.agent, input.account_label);
      if (collision) {
        const row = this.accountFromRow(collision);
        throw new Error(
          `account label ${input.account_label} is already registered for project=${row.project}, comm=${row.comm}, agent=${row.agent} as bot id ${row.bot_user_id}`
        );
      }
      const result = this.db.prepare(`
          UPDATE account_registrations
          SET account_label = ?,
              updated_at = ?
          WHERE registration_id = ?
        `).run(input.account_label, input.updated_at, previous.registration_id);
      if (Number(result.changes ?? 0) !== 1) {
        throw new Error(
          `failed to relabel account registration for ${input.comm}/${input.bot_user_id}`
        );
      }
      const nextRow = this.db.prepare("SELECT * FROM account_registrations WHERE registration_id = ?").get(previous.registration_id);
      if (!nextRow) {
        throw new Error(`updated account registration not found for ${previous.registration_id}`);
      }
      this.db.exec("COMMIT");
      return { previous, next: this.accountFromRow(nextRow) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async upsertConversation(rec) {
    rec = { ...rec, project: normalizeProjectPath(rec.project) };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingId = this.findExistingConversationId(rec);
      let result;
      if (existingId) {
        this.db.prepare(`
            UPDATE conversations SET
              bot_user_id = ?,
              registration_id = ?,
              last_inbound_at = ?,
              last_outbound_at = ?,
              last_message_id = ?,
              metadata_json = ?
            WHERE conversation_id = ?
          `).run(
          rec.bot_user_id,
          rec.registration_id ?? null,
          rec.last_inbound_at,
          rec.last_outbound_at,
          rec.last_message_id,
          encodeJson(rec.metadata),
          existingId
        );
        result = existingId;
      } else {
        this.db.prepare(`
            INSERT INTO conversations (
              schema_version, project, comm, bot_user_id, registration_id,
              chat_native_id, thread_native_id, conversation_id, agent, last_inbound_at,
              last_outbound_at, last_message_id, created_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(registration_id, chat_native_id, thread_native_id) DO UPDATE SET
              bot_user_id = excluded.bot_user_id,
              last_inbound_at = excluded.last_inbound_at,
              last_outbound_at = excluded.last_outbound_at,
              last_message_id = excluded.last_message_id,
              metadata_json = excluded.metadata_json
          `).run(
          rec.schema_version,
          rec.project,
          rec.comm,
          rec.bot_user_id,
          rec.registration_id ?? null,
          rec.chat_native_id,
          dbThreadId(rec.thread_native_id),
          rec.conversation_id,
          rec.agent,
          rec.last_inbound_at,
          rec.last_outbound_at,
          rec.last_message_id,
          rec.created_at,
          encodeJson(rec.metadata)
        );
        result = rec.conversation_id;
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /**
   * Resolve an existing conversation's stable conversation_id by its immutable
   * (registration_id, chat, thread) key — the conversations primary key as of
   * AGE-22. Returns null when no conversation exists yet (or, defensively, when
   * the record has no registration_id, which should not happen now that the
   * column is NOT NULL).
   */
  findExistingConversationId(rec) {
    if (rec.registration_id == null) return null;
    const byReg = this.db.prepare(`
        SELECT conversation_id FROM conversations
        WHERE registration_id = ? AND chat_native_id = ? AND thread_native_id = ?
      `).get(rec.registration_id, rec.chat_native_id, dbThreadId(rec.thread_native_id));
    return byReg?.conversation_id ?? null;
  }
  // AGE-22: a conversation's account_label is resolved purely from its owning
  // registration (registration_id -> account_registrations). conversations no
  // longer stores account_label (the column was dropped in migration 008), so a
  // relabel is visible immediately on every read and no behavior path keys off a
  // mutable stored label. The join misses only for an orphan/retired
  // registration; the row mapper surfaces "" in that case.
  conversationSelect = `
    SELECT c.*, ar.account_label AS effective_account_label
    FROM conversations c
    LEFT JOIN account_registrations ar ON ar.registration_id = c.registration_id
  `;
  async getConversation(id) {
    const row = this.db.prepare(`${this.conversationSelect} WHERE c.conversation_id = ?`).get(id);
    return row ? this.conversationFromRow(row) : null;
  }
  async findConversation(pk) {
    if (pk.registration_id) {
      const byReg = this.db.prepare(`
          ${this.conversationSelect}
          WHERE c.registration_id = ? AND c.chat_native_id = ? AND c.thread_native_id = ?
        `).get(pk.registration_id, pk.chat_native_id, dbThreadId(pk.thread_native_id));
      if (byReg) return this.conversationFromRow(byReg);
    }
    if (pk.bot_user_id) {
      const byBot = this.db.prepare(`
          ${this.conversationSelect}
          WHERE c.project = ? AND c.agent = ? AND c.comm = ? AND c.bot_user_id = ?
            AND c.chat_native_id = ? AND c.thread_native_id = ?
        `).get(
        normalizeProjectPath(pk.project),
        pk.agent,
        pk.comm,
        pk.bot_user_id,
        pk.chat_native_id,
        dbThreadId(pk.thread_native_id)
      );
      if (byBot) return this.conversationFromRow(byBot);
    }
    return null;
  }
  async listConversations(filter = {}) {
    const normalizedFilter = {
      ...filter,
      project: filter.project === void 0 ? void 0 : normalizeProjectPath(filter.project)
    };
    const clauses = [];
    const params = [];
    for (const key of ["project", "comm", "agent"]) {
      if (normalizedFilter[key] !== void 0) {
        clauses.push(`c.${key} = ?`);
        params.push(normalizedFilter[key]);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit === void 0 ? "" : "LIMIT ?";
    if (filter.limit !== void 0) params.push(filter.limit);
    const rows = this.db.prepare(`${this.conversationSelect} ${where} ORDER BY c.created_at DESC ${limit}`).all(...params);
    return rows.map((row) => this.conversationFromRow(row));
  }
  async touchConversationInbound(id, at, message_id) {
    this.db.prepare(`
        UPDATE conversations
        SET last_inbound_at = ?, last_message_id = ?
        WHERE conversation_id = ?
      `).run(at, message_id, id);
  }
  async touchConversationOutbound(id, at, message_id) {
    this.db.prepare(`
        UPDATE conversations
        SET last_outbound_at = ?, last_message_id = ?
        WHERE conversation_id = ?
      `).run(at, message_id, id);
  }
  async insertQuery(rec) {
    this.db.prepare(`
        INSERT INTO queries (
          schema_version, query_id, agent, session_id, kind, prompt_text,
          created_at, ttl_seconds, origin_chat_id, source_message_id,
          resolved_at, resolution_json, options_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      rec.schema_version,
      rec.query_id,
      rec.agent,
      rec.session,
      rec.kind,
      rec.prompt_text,
      rec.created_at,
      rec.ttl_seconds,
      rec.origin_chat_id,
      rec.source_message_id,
      rec.resolved_at,
      encodeJson(rec.resolution),
      rec.options_json
    );
  }
  async resolveQuery(query_id, resolution, resolved_at) {
    const result = this.db.prepare(`
        UPDATE queries
        SET resolved_at = ?, resolution_json = ?
        WHERE query_id = ? AND resolved_at IS NULL
      `).run(resolved_at, encodeJson(resolution), query_id);
    return result.changes === 1;
  }
  async getOpenQueryForSession(session) {
    const row = this.db.prepare("SELECT * FROM queries WHERE session_id = ? AND resolved_at IS NULL").get(session);
    return row ? this.queryFromRow(row) : null;
  }
  async getOpenQueryByConversation(conversation_id) {
    const row = this.db.prepare(`
        SELECT * FROM queries
        WHERE origin_chat_id = ? AND resolved_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `).get(conversation_id);
    return row ? this.queryFromRow(row) : null;
  }
  async getQuery(query_id) {
    const row = this.db.prepare("SELECT * FROM queries WHERE query_id = ?").get(query_id);
    return row ? this.queryFromRow(row) : null;
  }
  async getOpenQueryById(query_id) {
    const row = this.db.prepare("SELECT * FROM queries WHERE query_id = ? AND resolved_at IS NULL").get(query_id);
    return row ? this.queryFromRow(row) : null;
  }
  async listOpenQueriesForSession(session) {
    const rows = this.db.prepare(`
        SELECT * FROM queries
        WHERE session_id = ? AND resolved_at IS NULL
        ORDER BY created_at ASC
      `).all(session);
    return rows.map((row) => this.queryFromRow(row));
  }
  async listOpenQueriesByConversation(conversation_id) {
    const rows = this.db.prepare(`
        SELECT * FROM queries
        WHERE origin_chat_id = ? AND resolved_at IS NULL
        ORDER BY created_at ASC
      `).all(conversation_id);
    return rows.map((row) => this.queryFromRow(row));
  }
  async setQuerySourceMessage(query_id, source_message_id) {
    const result = this.db.prepare("UPDATE queries SET source_message_id = ? WHERE query_id = ? AND resolved_at IS NULL").run(source_message_id, query_id);
    return Number(result.changes ?? 0) > 0;
  }
  async updateQueryKind(query_id, kind) {
    const result = this.db.prepare("UPDATE queries SET kind = ? WHERE query_id = ? AND resolved_at IS NULL").run(kind, query_id);
    return Number(result.changes ?? 0) > 0;
  }
  async supersedeOpenQueriesForSession(session_id, now) {
    const result = this.db.prepare(`
        UPDATE queries
        SET resolved_at = ?,
            resolution_json = ?
        WHERE session_id = ?
          AND resolved_at IS NULL
      `).run(now, JSON.stringify({ kind: "superseded" }), session_id);
    return Number(result.changes ?? 0);
  }
  async cancelOpenQuery(query_id, now) {
    const result = this.db.prepare(`
        UPDATE queries
        SET resolved_at = ?,
            resolution_json = ?
        WHERE query_id = ?
          AND resolved_at IS NULL
      `).run(now, JSON.stringify({ kind: "cancelled" }), query_id);
    return Number(result.changes ?? 0) > 0;
  }
  async upsertSession(rec) {
    const project = normalizeProjectPath(rec.project);
    this.db.prepare(`
        INSERT INTO sessions (
          schema_version, session_id, agent, project, created_at,
          lease_holder_connection_id, lease_acquired_at, lease_released_at,
          lease_owner_process_pid, lease_owner_process_label,
          lease_owner_process_registered_at,
          lease_owner_daemon_discovery_root, lease_owner_daemon_checkout_root,
          lease_owner_daemon_state_root, lease_owner_daemon_bin,
          lease_owner_daemon_authority_rank,
          most_recent_inbound_conversation_id, account_label_scope, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          agent = excluded.agent,
          project = excluded.project,
          account_label_scope = excluded.account_label_scope,
          status = excluded.status
      `).run(
      rec.schema_version,
      rec.session_id,
      rec.agent,
      project,
      rec.created_at,
      rec.lease_holder_connection_id,
      rec.lease_acquired_at,
      rec.lease_released_at,
      rec.lease_owner_process_pid,
      rec.lease_owner_process_label,
      rec.lease_owner_process_registered_at,
      rec.lease_owner_daemon_discovery_root,
      rec.lease_owner_daemon_checkout_root,
      rec.lease_owner_daemon_state_root,
      rec.lease_owner_daemon_bin,
      rec.lease_owner_daemon_authority_rank,
      rec.most_recent_inbound_conversation_id,
      rec.account_label_scope ?? null,
      rec.status
    );
  }
  async acquireSessionLease(session, connection_id, at, owner) {
    try {
      const result = this.db.prepare(`
          UPDATE sessions
          SET lease_holder_connection_id = ?,
              lease_acquired_at = ?,
              lease_released_at = NULL,
              -- AGE-82: acquiring a lease revives the row. Registration is
              -- upsert(active) + acquire, and the sweep can end the row in
              -- between; without this a live lease would sit on an ended
              -- row, invisible to every status='active' filter and outside
              -- the partial live-lease indexes.
              status = 'active',
              lease_owner_process_pid = ?,
              lease_owner_process_label = ?,
              lease_owner_process_registered_at = ?,
              lease_owner_daemon_discovery_root = ?,
              lease_owner_daemon_checkout_root = ?,
              lease_owner_daemon_state_root = ?,
              lease_owner_daemon_bin = ?,
              lease_owner_daemon_authority_rank = ?
          WHERE session_id = ?
            AND (lease_holder_connection_id IS NULL OR lease_holder_connection_id = ?)
        `).run(
        connection_id,
        at,
        owner?.process_pid ?? null,
        owner?.process_label ?? null,
        owner?.process_pid ? at : null,
        owner?.daemon?.discovery_root ?? null,
        owner?.daemon?.checkout_root ?? null,
        owner?.daemon?.state_root ?? null,
        owner?.daemon?.daemon_bin ?? null,
        owner?.daemon?.authority_rank ?? null,
        session,
        connection_id
      );
      return result.changes === 1;
    } catch (error) {
      if (isConstraintError(error)) return false;
      throw error;
    }
  }
  async releaseSessionLease(session, connection_id, at) {
    this.db.prepare(`
        UPDATE sessions
        SET lease_holder_connection_id = NULL,
            lease_released_at = ?,
            lease_owner_process_pid = NULL,
            lease_owner_process_label = NULL,
            lease_owner_process_registered_at = NULL,
            lease_owner_daemon_discovery_root = NULL,
            lease_owner_daemon_checkout_root = NULL,
            lease_owner_daemon_state_root = NULL,
            lease_owner_daemon_bin = NULL,
            lease_owner_daemon_authority_rank = NULL
        WHERE session_id = ? AND lease_holder_connection_id = ?
      `).run(at, session, connection_id);
  }
  async releaseSessionConnectionLeasePreservingOwner(session, connection_id, at) {
    this.db.prepare(`
        UPDATE sessions
        SET lease_holder_connection_id = NULL,
            lease_released_at = ?
        WHERE session_id = ? AND lease_holder_connection_id = ?
      `).run(at, session, connection_id);
  }
  async endSessionIfUnchanged(session, observed, at) {
    const result = this.db.prepare(`
        UPDATE sessions
        SET status = 'ended',
            lease_holder_connection_id = NULL,
            lease_released_at = ?
        WHERE session_id = ?
          AND status = ?
          AND (
            (lease_holder_connection_id IS NULL AND ? IS NULL)
            OR lease_holder_connection_id = ?
          )
          AND (
            (lease_owner_process_pid IS NULL AND ? IS NULL)
            OR lease_owner_process_pid = ?
          )
          AND (
            (lease_owner_process_registered_at IS NULL AND ? IS NULL)
            OR lease_owner_process_registered_at = ?
          )
      `).run(
      at,
      session,
      observed.status,
      observed.lease_holder_connection_id,
      observed.lease_holder_connection_id,
      observed.lease_owner_process_pid,
      observed.lease_owner_process_pid,
      observed.lease_owner_process_registered_at,
      observed.lease_owner_process_registered_at
    );
    return Number(result.changes ?? 0) > 0;
  }
  async getSession(session) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(session);
    return row ? this.sessionFromRow(row) : null;
  }
  async listSessions(filter = {}) {
    const where = [];
    const params = [];
    if (filter.project !== void 0) {
      where.push("project = ?");
      params.push(normalizeProjectPath(filter.project));
    }
    if (filter.agent !== void 0) {
      where.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter.status !== void 0) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.account_label_scope === null) {
      where.push("account_label_scope IS NULL");
    } else if (filter.account_label_scope !== void 0) {
      where.push("account_label_scope = ?");
      params.push(filter.account_label_scope);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM sessions ${whereClause} ORDER BY created_at DESC`).all(...params);
    return rows.map((row) => this.sessionFromRow(row));
  }
  async setSessionMostRecentInbound(session, conversation_id) {
    this.db.prepare(`
        UPDATE sessions
        SET most_recent_inbound_conversation_id = ?
        WHERE session_id = ?
      `).run(conversation_id, session);
  }
  async addAllowlistGlobal(rec) {
    this.db.prepare(`
        INSERT INTO allowlist_global (comm, sender_id, added_at, added_by, note)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(comm, sender_id) DO NOTHING
      `).run(rec.comm, rec.sender_id, rec.added_at, rec.added_by ?? null, rec.note ?? null);
  }
  async removeAllowlistGlobal(comm, sender_id) {
    this.db.prepare("DELETE FROM allowlist_global WHERE comm = ? AND sender_id = ?").run(comm, sender_id);
  }
  async listAllowlistGlobal(filter = {}) {
    const clauses = [];
    const params = [];
    if (filter.comm !== void 0) {
      clauses.push("comm = ?");
      params.push(filter.comm);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM allowlist_global ${where} ORDER BY comm, sender_id`).all(...params);
    return rows.map((row) => this.allowlistGlobalFromRow(row));
  }
  async addAllowlistPerBot(rec) {
    this.db.prepare(`
        INSERT INTO allowlist_per_bot
          (comm, bot_user_id, sender_id, added_at, added_by, note)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(comm, bot_user_id, sender_id) DO NOTHING
      `).run(
      rec.comm,
      rec.bot_user_id,
      rec.sender_id,
      rec.added_at,
      rec.added_by ?? null,
      rec.note ?? null
    );
  }
  async removeAllowlistPerBot(comm, bot_user_id, sender_id) {
    this.db.prepare(
      "DELETE FROM allowlist_per_bot WHERE comm = ? AND bot_user_id = ? AND sender_id = ?"
    ).run(comm, bot_user_id, sender_id);
  }
  async listAllowlistPerBot(filter = {}) {
    const clauses = [];
    const params = [];
    if (filter.comm !== void 0) {
      clauses.push("comm = ?");
      params.push(filter.comm);
    }
    if (filter.bot_user_id !== void 0) {
      clauses.push("bot_user_id = ?");
      params.push(filter.bot_user_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM allowlist_per_bot ${where} ORDER BY comm, bot_user_id, sender_id`
    ).all(...params);
    return rows.map((row) => this.allowlistPerBotFromRow(row));
  }
  async recordPendingInboundDelivery(row) {
    const project = normalizeProjectPath(row.project);
    this.db.prepare(`
        INSERT INTO pending_inbound_deliveries (
          conversation_id, message_id, comm, account, project, agent, enqueued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, message_id, comm, account) DO NOTHING
      `).run(
      row.conversation_id,
      row.message_id,
      row.comm,
      row.account,
      project,
      row.agent,
      row.enqueued_at
    );
  }
  async listPendingInboundDeliveries(filter) {
    const project = normalizeProjectPath(filter.project);
    const rows = this.db.prepare(`
        SELECT * FROM pending_inbound_deliveries
        WHERE project = ? AND agent = ?
        ORDER BY enqueued_at, conversation_id, message_id
      `).all(project, filter.agent);
    return rows.map((row) => this.pendingInboundDeliveryFromRow(row));
  }
  async acknowledgePendingInboundDeliveries(keys) {
    if (keys.length === 0) return;
    const stmt = this.db.prepare(`
      DELETE FROM pending_inbound_deliveries
      WHERE conversation_id = ? AND message_id = ? AND comm = ? AND account = ?
    `);
    for (const key of keys) {
      stmt.run(key.conversation_id, key.message_id, key.comm, key.account);
    }
  }
  async reserveCurlInboundReceipt(input) {
    const existing = await this.getCurlInboundReceipt(input);
    if (existing) {
      if (existing.state === "accepted" && existing.expires_at <= input.reserved_at) {
        this.db.prepare(`
            DELETE FROM curl_inbound_receipts
            WHERE registration_id = ? AND sender_id = ? AND client_key = ?
          `).run(input.registration_id, input.sender_id, input.client_key);
      } else if (existing.request_hash !== input.request_hash) {
        return { kind: "conflict" };
      } else if (existing.state === "accepted") {
        return {
          kind: "replay",
          message_id: existing.message_id,
          conversation_id: existing.conversation_id
        };
      } else {
        return {
          kind: "resume",
          message_id: existing.message_id,
          conversation_id: existing.conversation_id
        };
      }
    }
    try {
      this.db.prepare(`
          INSERT INTO curl_inbound_receipts (
            registration_id, sender_id, client_key, request_hash, message_id,
            conversation_id, state, reserved_at, accepted_at, expires_at,
            transcript_recorded_at, audit_recorded_at, dispatch_recorded_at,
            query_consumed_at, planned_query_id
          ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL)
        `).run(
        input.registration_id,
        input.sender_id,
        input.client_key,
        input.request_hash,
        input.message_id,
        input.reserved_at,
        input.expires_at
      );
      return { kind: "reserved", message_id: input.message_id };
    } catch (error) {
      if (!isSqliteUniqueViolation(error)) throw error;
      return this.reserveCurlInboundReceipt(input);
    }
  }
  async acceptCurlInboundReceipt(input) {
    const result = this.db.prepare(`
        UPDATE curl_inbound_receipts
        SET state = 'accepted',
            conversation_id = ?,
            accepted_at = ?
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
          AND state = 'pending'
      `).run(
      input.conversation_id,
      input.accepted_at,
      input.registration_id,
      input.sender_id,
      input.client_key
    );
    return (result.changes ?? 0) === 1;
  }
  async getCurlInboundReceipt(scope) {
    const row = this.db.prepare(`
        SELECT * FROM curl_inbound_receipts
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `).get(scope.registration_id, scope.sender_id, scope.client_key);
    return row ? this.curlInboundReceiptFromRow(row) : null;
  }
  async deleteExpiredCurlInboundReceipts(now) {
    const result = this.db.prepare(
      "DELETE FROM curl_inbound_receipts WHERE state = 'accepted' AND expires_at <= ?"
    ).run(now);
    return result.changes ?? 0;
  }
  async markCurlReceiptConversation(scope, conversation_id) {
    this.db.prepare(`
        UPDATE curl_inbound_receipts
        SET conversation_id = COALESCE(conversation_id, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `).run(conversation_id, scope.registration_id, scope.sender_id, scope.client_key);
  }
  async markCurlReceiptTranscript(scope, at) {
    this.db.prepare(`
        UPDATE curl_inbound_receipts
        SET transcript_recorded_at = COALESCE(transcript_recorded_at, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `).run(at, scope.registration_id, scope.sender_id, scope.client_key);
  }
  async markCurlReceiptAudit(scope, at) {
    this.db.prepare(`
        UPDATE curl_inbound_receipts
        SET audit_recorded_at = COALESCE(audit_recorded_at, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `).run(at, scope.registration_id, scope.sender_id, scope.client_key);
  }
  async markCurlReceiptDispatch(scope, at) {
    this.db.prepare(`
        UPDATE curl_inbound_receipts
        SET dispatch_recorded_at = COALESCE(dispatch_recorded_at, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `).run(at, scope.registration_id, scope.sender_id, scope.client_key);
  }
  async markCurlReceiptQueryConsumed(scope, at) {
    this.db.prepare(`
        UPDATE curl_inbound_receipts
        SET query_consumed_at = COALESCE(query_consumed_at, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `).run(at, scope.registration_id, scope.sender_id, scope.client_key);
  }
  async markCurlReceiptPlannedQuery(scope, query_id) {
    this.db.prepare(`
        UPDATE curl_inbound_receipts
        SET planned_query_id = ?
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
          AND planned_query_id IS NULL
      `).run(query_id, scope.registration_id, scope.sender_id, scope.client_key);
  }
  async hasPendingInboundDelivery(key) {
    const row = this.db.prepare(`
        SELECT 1 AS present FROM pending_inbound_deliveries
        WHERE conversation_id = ? AND message_id = ? AND comm = ? AND account = ?
        LIMIT 1
      `).get(key.conversation_id, key.message_id, key.comm, key.account);
    return row != null;
  }
  async close() {
    this.db.close();
  }
  allowlistGlobalFromRow(row) {
    const r = row;
    return {
      comm: r.comm,
      sender_id: r.sender_id,
      added_at: r.added_at,
      added_by: r.added_by ?? void 0,
      note: r.note ?? void 0
    };
  }
  allowlistPerBotFromRow(row) {
    const r = row;
    return {
      comm: r.comm,
      bot_user_id: r.bot_user_id,
      sender_id: r.sender_id,
      added_at: r.added_at,
      added_by: r.added_by ?? void 0,
      note: r.note ?? void 0
    };
  }
  accountFromRow(row) {
    const r = row;
    return {
      schema_version: r.schema_version,
      registration_id: r.registration_id,
      project: r.project,
      comm: r.comm,
      agent: r.agent,
      account_label: r.account_label,
      bot_user_id: r.bot_user_id,
      credentials_ref: r.credentials_ref,
      bot_username: r.bot_username ?? void 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
      metadata: decodeJson(r.metadata_json) ?? void 0
    };
  }
  conversationFromRow(row) {
    const r = row;
    return {
      schema_version: r.schema_version,
      project: r.project,
      comm: r.comm,
      // AGE-22: registration-resolved current label (see conversationSelect).
      // "" when the join misses (orphan / retired registration).
      account_label: r.effective_account_label ?? "",
      bot_user_id: r.bot_user_id ?? null,
      registration_id: r.registration_id ?? null,
      chat_native_id: r.chat_native_id,
      thread_native_id: recordThreadId(r.thread_native_id),
      conversation_id: r.conversation_id,
      agent: r.agent,
      last_inbound_at: r.last_inbound_at,
      last_outbound_at: r.last_outbound_at,
      last_message_id: r.last_message_id,
      created_at: r.created_at,
      metadata: decodeJson(r.metadata_json) ?? void 0
    };
  }
  queryFromRow(row) {
    const r = row;
    return {
      schema_version: r.schema_version,
      query_id: r.query_id,
      agent: r.agent,
      session: r.session_id,
      kind: r.kind,
      prompt_text: r.prompt_text,
      created_at: r.created_at,
      ttl_seconds: r.ttl_seconds,
      origin_chat_id: r.origin_chat_id,
      source_message_id: r.source_message_id,
      resolved_at: r.resolved_at,
      resolution: decodeJson(r.resolution_json),
      options_json: r.options_json
    };
  }
  curlInboundReceiptFromRow(row) {
    const r = row;
    return {
      registration_id: r.registration_id,
      sender_id: r.sender_id,
      client_key: r.client_key,
      request_hash: r.request_hash,
      message_id: r.message_id,
      conversation_id: r.conversation_id ?? null,
      state: r.state,
      reserved_at: r.reserved_at,
      accepted_at: r.accepted_at ?? null,
      expires_at: r.expires_at,
      transcript_recorded_at: r.transcript_recorded_at ?? null,
      audit_recorded_at: r.audit_recorded_at ?? null,
      dispatch_recorded_at: r.dispatch_recorded_at ?? null,
      query_consumed_at: r.query_consumed_at ?? null,
      planned_query_id: r.planned_query_id ?? null
    };
  }
  pendingInboundDeliveryFromRow(row) {
    const r = row;
    return {
      conversation_id: r.conversation_id,
      message_id: r.message_id,
      comm: r.comm,
      account: r.account,
      project: r.project,
      agent: r.agent,
      enqueued_at: r.enqueued_at
    };
  }
  sessionFromRow(row) {
    const r = row;
    return {
      schema_version: r.schema_version,
      session_id: r.session_id,
      agent: r.agent,
      project: r.project,
      created_at: r.created_at,
      lease_holder_connection_id: r.lease_holder_connection_id,
      lease_acquired_at: r.lease_acquired_at,
      lease_released_at: r.lease_released_at,
      lease_owner_process_pid: r.lease_owner_process_pid,
      lease_owner_process_label: r.lease_owner_process_label,
      lease_owner_process_registered_at: r.lease_owner_process_registered_at,
      lease_owner_daemon_discovery_root: r.lease_owner_daemon_discovery_root,
      lease_owner_daemon_checkout_root: r.lease_owner_daemon_checkout_root,
      lease_owner_daemon_state_root: r.lease_owner_daemon_state_root,
      lease_owner_daemon_bin: r.lease_owner_daemon_bin,
      lease_owner_daemon_authority_rank: r.lease_owner_daemon_authority_rank,
      most_recent_inbound_conversation_id: r.most_recent_inbound_conversation_id,
      account_label_scope: r.account_label_scope ?? null,
      status: r.status
    };
  }
};
function isSqliteUniqueViolation(error) {
  if (error == null || typeof error !== "object") return false;
  const sqliteError = error;
  return sqliteError.code === "SQLITE_CONSTRAINT_UNIQUE" || sqliteError.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || sqliteError.errcode === 2067 || sqliteError.errcode === 1555;
}
async function openSqliteStorage(path8) {
  return SqliteStorage.open(path8);
}
function isConstraintError(error) {
  const sqliteError = error;
  return sqliteError.code === "SQLITE_CONSTRAINT" || sqliteError.code === "ERR_SQLITE_CONSTRAINT" || sqliteError.code === "ERR_SQLITE_ERROR" && sqliteError.errcode === 2067 || sqliteError.errstr === "constraint failed";
}

// ../core-daemon/storage/transcripts.ts
import { createReadStream as createReadStream2 } from "node:fs";
import { mkdir as mkdir4, stat as stat2 } from "node:fs/promises";
import { dirname as dirname3, join as join4 } from "node:path";
import { createInterface as createInterface2 } from "node:readline/promises";
function safeSegment2(value) {
  return encodeURIComponent(value);
}
var JsonlTranscriptStore = class {
  constructor(root) {
    this.root = root;
  }
  root;
  async append(entry) {
    const path8 = this.pathFor(entry.conversation_id);
    await mkdir4(dirname3(path8), { recursive: true });
    await appendJsonLine(path8, entry);
  }
  async *read(conversation_id, opts = {}) {
    const path8 = this.pathFor(conversation_id);
    try {
      await stat2(path8);
    } catch {
      return;
    }
    let yielded = 0;
    const lines = createInterface2({
      input: createReadStream2(path8, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line);
      if (opts.since !== void 0 && entry.timestamp < opts.since) continue;
      yield entry;
      yielded += 1;
      if (opts.limit !== void 0 && yielded >= opts.limit) break;
    }
  }
  pathFor(conversation_id) {
    return join4(this.root, "chats", safeSegment2(conversation_id), "transcript.jsonl");
  }
};

// ../core-daemon/storage/blobs.ts
import { createHash } from "node:crypto";
import { createReadStream as createReadStream3 } from "node:fs";
import { mkdir as mkdir5, open as open4, stat as stat3 } from "node:fs/promises";
import { join as join5 } from "node:path";
import { Readable } from "node:stream";
var ContentAddressedBlobStore = class {
  constructor(root) {
    this.root = root;
  }
  root;
  async put(content, mime) {
    const hash = createHash("sha256").update(content).digest("hex");
    const ref = { hash, size: content.byteLength, mime };
    const path8 = this.pathFor(ref);
    await mkdir5(join5(this.root, "blobs", hash.slice(0, 2)), { recursive: true });
    let handle;
    try {
      handle = await open4(path8, "wx");
      await handle.writeFile(content);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
    }
    return ref;
  }
  async open(ref) {
    return Readable.toWeb(createReadStream3(this.pathFor(ref)));
  }
  pathFor(ref) {
    return join5(this.root, "blobs", ref.hash.slice(0, 2), ref.hash);
  }
  async exists(ref) {
    try {
      const info = await stat3(this.pathFor(ref));
      return info.isFile() && info.size === ref.size;
    } catch {
      return false;
    }
  }
};

// ../core-daemon/runtime/register-comm-ipc-methods.ts
var DuplicateCommIpcMethodError = class extends Error {
  constructor(method, existingCommId, newCommId) {
    super(
      `IPC method "${method}" is already registered for comm "${existingCommId}" (refusing duplicate registration from comm "${newCommId}")`
    );
    this.method = method;
    this.existingCommId = existingCommId;
    this.newCommId = newCommId;
    this.name = "DuplicateCommIpcMethodError";
  }
  method;
  existingCommId;
  newCommId;
};
function registerCommIpcMethods(ipcMethods, factory, deps, options) {
  if (!factory.ipcMethods) return;
  const ownerByMethod = options?.commIdByMethod;
  const pending = [...factory.ipcMethods(deps)];
  for (const [method] of pending) {
    if (ipcMethods.has(method) || ownerByMethod?.has(method)) {
      const existingCommId = ownerByMethod?.get(method) ?? "unknown";
      throw new DuplicateCommIpcMethodError(method, existingCommId, factory.commId);
    }
  }
  for (const [method, handler] of pending) {
    ipcMethods.set(method, handler);
    ownerByMethod?.set(method, factory.commId);
  }
}

// ../core-daemon/runtime/comm-factory-registry.ts
function createCommFactoryRegistry(input) {
  const factories = [...input.initial];
  const loadedCommIds = new Set(factories.map((factory) => factory.commId));
  const commIdByMethod = /* @__PURE__ */ new Map();
  let rescanInFlight = null;
  for (const factory of factories) {
    registerCommIpcMethods(input.ipcMethods, factory, input.ipcDeps, { commIdByMethod });
  }
  async function runRescan() {
    if (rescanInFlight) {
      await rescanInFlight;
      return;
    }
    rescanInFlight = (async () => {
      try {
        const discovered = await input.loadFactories();
        for (const factory of discovered) {
          if (loadedCommIds.has(factory.commId)) continue;
          registerCommIpcMethods(input.ipcMethods, factory, input.ipcDeps, { commIdByMethod });
          factories.push(factory);
          loadedCommIds.add(factory.commId);
        }
      } finally {
        rescanInFlight = null;
      }
    })();
    await rescanInFlight;
  }
  async function rescanFactoriesForComm(comm) {
    const existing = factories.find((factory) => factory.commId === comm);
    if (existing) return existing;
    await runRescan();
    return factories.find((factory) => factory.commId === comm);
  }
  return {
    get factories() {
      return factories;
    },
    rescanFactoriesForComm
  };
}

// ../core-daemon/runtime/dispatch-inbound.ts
async function dispatchInboundToBridges(bridges, conversation, message, audit, pendingInbound) {
  for (const bridge of bridges) {
    if (bridge.agentId !== conversation.agent) continue;
    if (!bridge.onInboundConversation) continue;
    try {
      await audit.append({
        timestamp: Date.now(),
        kind: "inbound_dispatch_bridge_invoked",
        agent: bridge.agentId,
        conversation_id: conversation.conversation_id,
        detail: {
          conversation_agent: conversation.agent,
          platform_message_id: message.platform_message_id,
          message_id: message.message_id,
          queue_length: pendingInbound.length
        }
      });
      await bridge.onInboundConversation(conversation, message);
      await audit.append({
        timestamp: Date.now(),
        kind: "inbound_dispatch_bridge_completed",
        agent: bridge.agentId,
        conversation_id: conversation.conversation_id,
        detail: {
          conversation_agent: conversation.agent,
          platform_message_id: message.platform_message_id,
          message_id: message.message_id,
          queue_length: pendingInbound.length
        }
      });
    } catch (error) {
      await audit.append({
        timestamp: Date.now(),
        kind: "inbound_dispatch_bridge_failed",
        agent: bridge.agentId,
        conversation_id: conversation.conversation_id,
        detail: {
          conversation_agent: conversation.agent,
          platform_message_id: message.platform_message_id,
          message_id: message.message_id,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      console.error(
        `agents-comm-bus: bridge ${bridge.agentId} onInboundConversation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

// ../core-daemon/runtime/daemon-idle-reaper.ts
var DEFAULT_IDLE_REAPER_GRACE_MS = 9e4;
var DEFAULT_IDLE_REAPER_INTERVAL_MS = 5e3;
function sampleStructuralEligibility(input) {
  const heldLeases = input.heldLeaseCount();
  const liveIpcConnections = input.liveIpcConnectionCount();
  const pendingInbound = input.pendingInboundLength();
  const inFlightAdapters = input.inFlightAdapterCount();
  const rawBridgeBlockers = input.bridgeBlockers();
  const bridgeBlockers = {};
  for (const [agentId, snapshot] of Object.entries(rawBridgeBlockers)) {
    if (snapshot) bridgeBlockers[agentId] = snapshot;
  }
  const ipcQuietForGrace = input.now - input.lastIpcServedAt >= input.graceMs;
  const reasons = [];
  if (heldLeases > 0) reasons.push("held_leases");
  if (liveIpcConnections > 0) reasons.push("live_ipc_connections");
  if (pendingInbound > 0) reasons.push("pending_inbound");
  if (inFlightAdapters > 0) reasons.push("in_flight_adapters");
  if (Object.keys(bridgeBlockers).length > 0) reasons.push("bridge_blockers");
  return {
    structurallyEligible: reasons.length === 0,
    blockers: {
      held_leases: heldLeases,
      live_ipc_connections: liveIpcConnections,
      pending_inbound: pendingInbound,
      in_flight_adapters: inFlightAdapters,
      bridge_blockers: bridgeBlockers,
      ipc_quiet_for_grace: ipcQuietForGrace
    },
    reasons
  };
}
function shouldIdleReaperRetire(input) {
  if (!input.structurallyEligible || input.structuralEligibleSince === null) return false;
  return input.now - input.structuralEligibleSince >= input.graceMs && input.now - input.lastIpcServedAt >= input.graceMs;
}
function startIdleReaper(options) {
  const graceMs = options.graceMs ?? DEFAULT_IDLE_REAPER_GRACE_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_IDLE_REAPER_INTERVAL_MS;
  const nowFn = options.now ?? Date.now;
  const setIntervalFn = options.setIntervalFn ?? ((fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h));
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
  const log = options.log ?? (() => {
  });
  let structuralEligibleSince = null;
  let retired = false;
  let interval = null;
  const tick = () => {
    if (retired) return;
    const now = nowFn();
    const structural = sampleStructuralEligibility({
      now,
      lastIpcServedAt: options.lastIpcServedAt(),
      graceMs,
      heldLeaseCount: options.heldLeaseCount,
      liveIpcConnectionCount: options.liveIpcConnectionCount,
      pendingInboundLength: options.pendingInboundLength,
      inFlightAdapterCount: options.inFlightAdapterCount,
      bridgeBlockers: options.bridgeBlockers
    });
    if (!structural.structurallyEligible) {
      structuralEligibleSince = null;
      return;
    }
    if (structuralEligibleSince === null) {
      structuralEligibleSince = now;
    }
    if (shouldIdleReaperRetire({
      now,
      graceMs,
      structuralEligibleSince,
      lastIpcServedAt: options.lastIpcServedAt(),
      structurallyEligible: true
    })) {
      retired = true;
      log(
        `agents-comm-bus: idle reaper retiring daemon after ${graceMs}ms with no owned resources (structural blockers cleared at ${new Date(structuralEligibleSince).toISOString()})`
      );
      void Promise.resolve(options.retire()).catch((error) => {
        console.error(
          `agents-comm-bus: idle reaper retire failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
  };
  const initialDelayMs = options.initialDelayMs ?? intervalMs;
  const initial = setTimeoutFn(() => {
    tick();
    interval = setIntervalFn(tick, intervalMs);
  }, initialDelayMs);
  return {
    stop() {
      clearTimeoutFn(initial);
      if (interval != null) clearIntervalFn(interval);
      interval = null;
    }
  };
}

// ../core-daemon/runtime/session-end-sweep.ts
var DEFAULT_SESSION_END_SWEEP_INTERVAL_MS = 60 * 60 * 1e3;
function sessionEndObservation(session) {
  return {
    status: session.status,
    lease_holder_connection_id: session.lease_holder_connection_id,
    lease_owner_process_pid: session.lease_owner_process_pid,
    lease_owner_process_registered_at: session.lease_owner_process_registered_at
  };
}
function shouldSweepEndSession(session, options = {}) {
  const ownerState = classifySessionOwnerProcess(session, options);
  if (ownerState === "live" || ownerState === "stale") return false;
  if (ownerState === "no_owner") {
    return session.lease_holder_connection_id == null;
  }
  return true;
}
async function runSessionEndSweep(input) {
  const counts = {
    ended: 0,
    kept_live: 0,
    kept_stale: 0,
    kept_no_owner_leased: 0,
    cas_lost: 0
  };
  const livenessOptions = {
    now: input.now,
    isPidAlive: input.isPidAlive,
    recencyMs: input.recencyMs
  };
  const at = (input.now ?? Date.now)();
  const sessions = await input.storage.listSessions({ status: "active" });
  for (const session of sessions) {
    const ownerState = classifySessionOwnerProcess(session, livenessOptions);
    if (!shouldSweepEndSession(session, livenessOptions)) {
      if (ownerState === "live") counts.kept_live += 1;
      else if (ownerState === "stale") counts.kept_stale += 1;
      else if (ownerState === "no_owner" && session.lease_holder_connection_id != null) {
        counts.kept_no_owner_leased += 1;
      }
      continue;
    }
    const ended = await input.storage.endSessionIfUnchanged(
      session.session_id,
      sessionEndObservation(session),
      at
    );
    if (ended) counts.ended += 1;
    else counts.cas_lost += 1;
  }
  const log = input.log ?? (() => {
  });
  log(
    `agents-comm-bus: session end sweep: ended=${counts.ended} kept_live=${counts.kept_live} kept_stale=${counts.kept_stale} kept_no_owner_leased=${counts.kept_no_owner_leased} cas_lost=${counts.cas_lost}`
  );
  return counts;
}
function startSessionEndSweep(options) {
  const intervalMs = options.intervalMs ?? DEFAULT_SESSION_END_SWEEP_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? ((fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h));
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
  let sweepInFlight = false;
  let interval = null;
  const tick = () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void runSessionEndSweep({
      storage: options.storage,
      now: options.now,
      isPidAlive: options.isPidAlive,
      recencyMs: options.recencyMs,
      log: options.log
    }).catch((error) => {
      const log = options.log ?? console.error;
      log(
        `agents-comm-bus: session end sweep failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }).finally(() => {
      sweepInFlight = false;
    });
  };
  if (options.runOnStart !== false) {
    tick();
  }
  const initial = setTimeoutFn(() => {
    interval = setIntervalFn(tick, intervalMs);
  }, intervalMs);
  return {
    stop() {
      clearTimeoutFn(initial);
      if (interval != null) clearIntervalFn(interval);
      interval = null;
    }
  };
}

// ../core-daemon/runtime/durable-inbound.ts
function durableInboundKey(entry) {
  return deliveryKey(
    entry.conversation.conversation_id,
    entry.message.message_id,
    entry.message.chat.comm,
    entry.message.chat.account
  );
}
function deliveryKeyFromRow(row) {
  return deliveryKey(row.conversation_id, row.message_id, row.comm, row.account);
}
function deliveryKey(conversationId, messageId, comm, account) {
  return `${conversationId}::${messageId}::${comm}::${account}`;
}
function queueHasDurableKey(queue, key) {
  return queue.some((entry) => durableInboundKey(entry) === key);
}
function deliveryRowFromEntry(entry, enqueuedAt) {
  return {
    conversation_id: entry.conversation.conversation_id,
    message_id: entry.message.message_id,
    comm: entry.message.chat.comm,
    account: entry.message.chat.account,
    project: normalizeProjectPath(entry.conversation.project),
    agent: entry.conversation.agent,
    enqueued_at: enqueuedAt
  };
}
async function acknowledgePendingInboundEntries(storage, entries) {
  if (entries.length === 0) return;
  const keys = entries.map((entry) => ({
    conversation_id: entry.conversation.conversation_id,
    message_id: entry.message.message_id,
    comm: entry.message.chat.comm,
    account: entry.message.chat.account
  }));
  await storage.acknowledgePendingInboundDeliveries(keys);
}
async function removePendingInboundEntries(storage, queue, entries) {
  if (entries.length === 0) return;
  await acknowledgePendingInboundEntries(storage, entries);
  removePendingInboundFromMemory(queue, entries);
}
function removePendingInboundFromMemory(queue, entries) {
  const keys = new Set(entries.map((entry) => durableInboundKey(entry)));
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (keys.has(durableInboundKey(queue[i]))) {
      queue.splice(i, 1);
    }
  }
}
function selectPendingInboundForDrain(queue, params = {}) {
  const raw = params?.comm;
  const commFilter = typeof raw === "string" && raw.length > 0 ? raw : null;
  const owned = params?.ownedAccountKeys instanceof Set ? params.ownedAccountKeys : null;
  if (!commFilter && owned === null) {
    return [...queue];
  }
  const selected = [];
  for (const entry of queue) {
    if (commFilter && entry.message.chat.comm !== commFilter) continue;
    if (owned !== null && !owned.has(pendingAccountKey(entry))) continue;
    selected.push(entry);
  }
  return selected;
}
async function drainAndAcknowledgePendingInbound(storage, queue, params = {}) {
  const selected = selectPendingInboundForDrain(queue, params);
  await removePendingInboundEntries(storage, queue, selected);
  return selected;
}
function pendingAccountKey(entry) {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}
async function rehydratePendingInboundForScope(input) {
  const project = normalizeProjectPath(input.project);
  const rows = await input.storage.listPendingInboundDeliveries({
    project,
    agent: input.agent
  });
  let rehydrated = 0;
  for (const row of rows) {
    const key = deliveryKeyFromRow(row);
    if (queueHasDurableKey(input.queue, key)) continue;
    const conversation = await input.storage.getConversation(row.conversation_id);
    if (!conversation) {
      await auditReplayMiss(input.audit, row, "conversation_not_found");
      continue;
    }
    const message = await findInboundTranscriptMessage(
      input.transcripts,
      row.conversation_id,
      row.message_id
    );
    if (!message) {
      await auditReplayMiss(input.audit, row, "transcript_payload_missing");
      continue;
    }
    if (message.chat.comm !== row.comm || message.chat.account !== row.account) {
      await auditReplayMiss(input.audit, row, "transcript_key_mismatch");
      continue;
    }
    input.queue.push({ message, conversation });
    rehydrated += 1;
  }
  return rehydrated;
}
async function findInboundTranscriptMessage(transcripts, conversationId, messageId) {
  for await (const entry of transcripts.read(conversationId)) {
    if (entry.direction !== "inbound" || entry.message_id !== messageId) continue;
    return entry.payload;
  }
  return null;
}
async function auditReplayMiss(audit, row, reason) {
  await audit.append({
    timestamp: Date.now(),
    kind: "durable_inbound_replay_miss",
    agent: row.agent,
    conversation_id: row.conversation_id,
    detail: {
      message_id: row.message_id,
      comm: row.comm,
      account: row.account,
      project: row.project,
      reason
    }
  }).catch(() => {
  });
}

// ../core-daemon/daemon.ts
async function runDaemon(options) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const paths = resolveStatePaths({ stateRoot: options.stateRoot ?? env.AGENTS_COMM_BUS_STATE_ROOT });
  const discoveryPaths = resolveDiscoveryPaths({
    stateRoot: paths.root,
    discoveryRoot: options.discoveryRoot ?? env.AGENTS_COMM_BUS_DISCOVERY_ROOT
  });
  if (argv.includes("--print-paths")) {
    console.log(JSON.stringify({ ...paths, discovery: discoveryPaths }, null, 2));
    return;
  }
  await mkdir6(paths.root, { recursive: true });
  await mkdir6(discoveryPaths.root, { recursive: true });
  const storage = await openSqliteStorage(paths.database);
  const transcripts = new JsonlTranscriptStore(paths.root);
  const audit = new JsonlAuditStore(paths.root);
  const blobs = new ContentAddressedBlobStore(paths.root);
  const pendingInbound = [];
  const sessionOwnerIsLive = createSessionOwnerLiveness();
  const daemonBin = env.AGENTS_COMM_BUS_BIN ?? process.argv[1] ?? null;
  const { authorityRank, checkoutRoot } = inferAuthorityRank({
    env,
    daemonBin,
    cwd: process.cwd()
  });
  const ipcActivity = { value: Date.now() };
  const leaseArbiter = new CommLeaseArbiter({
    self: {
      pid: process.pid,
      stateRoot: paths.root,
      checkoutRoot,
      daemonBin,
      daemonVersion: DAEMON_VERSION,
      authorityRank
    },
    lastIpcServedAt: () => ipcActivity.value,
    onAudit: (event) => {
      void audit.append({
        timestamp: Date.now(),
        kind: event.kind,
        detail: { comm_id: event.comm_id, resource_id: event.resource_id, ...event.detail }
      }).catch(() => {
      });
    }
  });
  console.error(
    `agents-comm-bus ${DAEMON_VERSION} starting: stateRoot=${paths.root} discoveryRoot=${discoveryPaths.root} checkoutRoot=${checkoutRoot ?? "?"} daemonBin=${daemonBin ?? "?"} authorityRank=${authorityRank} pid=${process.pid} home=${os3.homedir()}`
  );
  const comms = [];
  const bus = new MessageBus({
    project: normalizeProjectPath(process.cwd()),
    storage,
    transcripts,
    audit,
    blobs,
    comms,
    sessionOwnerIsLive
  });
  const daemonSelfIdentity = {
    discoveryRoot: discoveryPaths.root,
    checkoutRoot,
    stateRoot: paths.root,
    daemonBin,
    authorityRank
  };
  const bridges = [];
  const inFlightAdapters = /* @__PURE__ */ new Set();
  const activeScopes = /* @__PURE__ */ new Set();
  const ipcMethods = /* @__PURE__ */ new Map();
  const ipcDeps = { bus, storage, pendingInbound };
  let commAdapterFactories;
  let rescanFactoriesForComm;
  if (options.loadCommAdapterFactories) {
    const registry = createCommFactoryRegistry({
      initial: options.commAdapterFactories,
      loadFactories: options.loadCommAdapterFactories,
      ipcMethods,
      ipcDeps
    });
    commAdapterFactories = registry.factories;
    rescanFactoriesForComm = (comm) => registry.rescanFactoriesForComm(comm);
  } else {
    commAdapterFactories = [...options.commAdapterFactories];
    const commIdByMethod = /* @__PURE__ */ new Map();
    for (const factory of commAdapterFactories) {
      registerCommIpcMethods(ipcMethods, factory, ipcDeps, { commIdByMethod });
    }
  }
  const ensureCommsForSessionFn = async (project, agent, options2) => {
    const canonicalProject = normalizeProjectPath(project);
    const accountLabelScope = options2?.accountLabelScope ?? null;
    activeScopes.add(scopeKey(agent, canonicalProject, accountLabelScope));
    await ensureCommsForSession({
      project: canonicalProject,
      requestedProject: project,
      agent,
      accountLabelScope,
      factories: commAdapterFactories,
      rescanFactories: rescanFactoriesForComm,
      bus,
      bridges,
      storage,
      env,
      blobs,
      stateRoot: paths.root,
      leaseArbiter,
      inFlight: inFlightAdapters,
      audit
    });
    await rehydratePendingInboundForScope({
      storage,
      transcripts,
      audit,
      queue: pendingInbound,
      project: canonicalProject,
      agent
    });
    return { rehydrated: true };
  };
  bridges.push(
    ...options.agentBridgeFactories.map(
      (factory) => factory.create({
        storage,
        bus,
        audit,
        pendingInbound,
        ensureCommsForSession: ensureCommsForSessionFn,
        daemonOwner: daemonSelfIdentity,
        sessionOwnerIsLive
      })
    )
  );
  const pendingInboundMax = 100;
  bus.setDispatchSink({
    enqueueInbound: async (message, conversation) => {
      const entry = { message, conversation };
      const enqueuedAt = Date.now();
      await storage.recordPendingInboundDelivery(
        deliveryRowFromEntry(entry, enqueuedAt)
      );
      if (!queueHasDurableKey(pendingInbound, durableInboundKey(entry))) {
        pendingInbound.push(entry);
        if (pendingInbound.length > pendingInboundMax) {
          const spillCount = pendingInbound.length - pendingInboundMax;
          const spilled = pendingInbound.splice(0, spillCount);
          await audit.append({
            timestamp: Date.now(),
            kind: "pending_inbound_overflow_spill",
            agent: conversation.agent,
            conversation_id: conversation.conversation_id,
            detail: {
              spilled_count: spillCount,
              queue_length_before: pendingInbound.length + spillCount,
              queue_length_after: pendingInbound.length,
              spilled_keys: spilled.map((spilledEntry) => durableInboundKey(spilledEntry))
            }
          });
        }
      }
      await audit.append({
        timestamp: Date.now(),
        kind: "inbound_dispatch_enqueued",
        agent: conversation.agent,
        conversation_id: conversation.conversation_id,
        detail: {
          comm: message.chat.comm,
          account: message.chat.account,
          account_label: conversation.account_label,
          platform_message_id: message.platform_message_id,
          message_id: message.message_id,
          queue_length: pendingInbound.length
        }
      });
      await dispatchInboundToBridges(
        bridges,
        conversation,
        message,
        audit,
        pendingInbound
      );
    }
  });
  for (const bridge of bridges) {
    bridge.attach(comms);
  }
  ipcMethods.set("drain_pending_inbound", async (params) => {
    const base = params ?? {};
    const ownedAccountKeys = await resolveOwnedAccountKeys(storage, base.session);
    return drainAndAcknowledgePendingInbound(storage, pendingInbound, {
      ...base,
      ownedAccountKeys
    });
  });
  const bridgesByMethod = /* @__PURE__ */ new Map();
  for (const bridge of bridges) {
    for (const method of bridge.ipcMethods) {
      bridgesByMethod.set(method, bridge);
    }
  }
  const reloadRegistrations = (reloadOptions) => reloadAdapters({
    factories: commAdapterFactories,
    bridges,
    bus,
    storage,
    env,
    blobs,
    stateRoot: paths.root,
    leaseArbiter,
    activeScopes,
    audit,
    options: reloadOptions
  });
  const server = await startIpcServer({
    metadata: { stateRoot: paths.root },
    onRequest: async (request, socket) => {
      ipcActivity.value = Date.now();
      return dispatchIpc(request, {
        bus,
        ipcMethods,
        bridgesByMethod,
        commAdapterFactories,
        rescanFactories: rescanFactoriesForComm,
        env,
        socket,
        reloadRegistrations,
        ensureCommsForSession: ensureCommsForSessionFn,
        pendingInbound,
        activeScopes,
        storage,
        bridges,
        daemonOwner: daemonSelfIdentity,
        sessionOwnerIsLive
      });
    }
  });
  try {
    await writeDaemonDiscoveryFiles({
      stateRoot: paths.root,
      discoveryRoot: discoveryPaths.root,
      port: server.port
    });
  } catch (error) {
    await server.close();
    throw error;
  }
  await bus.start();
  const collectBridgeBlockers = () => {
    const blockers = {};
    for (const bridge of bridges) {
      blockers[bridge.agentId] = bridge.getRetirementBlockers?.() ?? null;
    }
    return blockers;
  };
  let pidWatchdogHandle = null;
  let idleReaperHandle = null;
  let sessionEndSweepHandle = null;
  const runDaemonRetirement = async (reason, recordAudit) => {
    await retireDaemon({
      reason,
      port: server.port,
      stateRoot: paths.root,
      discoveryRoot: discoveryPaths.root,
      audit: recordAudit ? audit : void 0,
      stopTimers: () => {
        pidWatchdogHandle?.stop();
        idleReaperHandle?.stop();
        sessionEndSweepHandle?.stop();
      },
      stopBus: () => bestEffortWithTimeout(
        () => bus.stop(),
        5e3,
        "stop comm adapters during daemon retirement"
      ),
      closeIpc: () => bestEffortWithTimeout(
        () => server.close(),
        1e3,
        "close IPC server during daemon retirement"
      ),
      closeStorage: () => storage.close()
    });
  };
  pidWatchdogHandle = startDaemonPidWatchdog({
    stateRoot: paths.root,
    discoveryRoot: discoveryPaths.root,
    pidFile: discoveryPaths.pidFile,
    port: server.port,
    audit,
    stopDaemon: async () => {
      await runDaemonRetirement("daemon_superseded", false);
    }
  });
  idleReaperHandle = startIdleReaper({
    lastIpcServedAt: () => ipcActivity.value,
    heldLeaseCount: () => leaseArbiter.heldLeaseCount(),
    liveIpcConnectionCount: () => server.getLiveConnectionCount(),
    pendingInboundLength: () => pendingInbound.length,
    inFlightAdapterCount: () => inFlightAdapters.size,
    bridgeBlockers: collectBridgeBlockers,
    retire: async () => {
      await runDaemonRetirement(IDLE_NO_OWNED_RESOURCES_REASON, true);
    },
    log: (message) => console.error(message)
  });
  sessionEndSweepHandle = startSessionEndSweep({
    storage,
    log: (message) => console.error(message)
  });
  void runBootScopeRestore({
    stateRoot: paths.root,
    discoveryRoot: discoveryPaths.root,
    storage,
    ensureCommsForSession: ensureCommsForSessionFn,
    audit
  });
  console.error(`agents-comm-bus ${DAEMON_VERSION} listening on ${server.url}`);
}
async function bestEffortWithTimeout(action, timeoutMs, label) {
  let timeout;
  let timedOut = false;
  try {
    await Promise.race([
      action(),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      })
    ]);
    if (timedOut) {
      console.error(`agents-comm-bus: timed out trying to ${label}`);
    }
  } catch (error) {
    console.error(
      `agents-comm-bus: failed to ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
async function addAdapterForRegistration(input) {
  const { adapter, resolution } = await createAdapterFromRegistration({
    factory: input.factory,
    registration: input.registration,
    env: input.env,
    blobs: input.blobs,
    stateRoot: input.stateRoot,
    storage: input.storage,
    leaseArbiter: input.leaseArbiter
  });
  if (!adapter) {
    if (resolution.status === "invalid") {
      logInvalidCredentialResolution(input.registration, input.factory.commId, resolution);
    }
    return {
      ok: false,
      reason: resolution.status === "invalid" ? resolution.reason : unresolvedCredentialsReason(input.registration.credentials_ref),
      resolution
    };
  }
  const accountId = input.registration.bot_user_id;
  try {
    input.bus.registerComm(adapter);
    for (const bridge of input.bridges) {
      bridge.attachComm?.(adapter);
    }
    await adapter.start();
    return { ok: true };
  } catch (error) {
    await adapter.stop().catch(() => {
    });
    input.bus.unregisterComm(input.registration.comm, accountId);
    for (const bridge of input.bridges) {
      bridge.detachComm?.(input.registration.comm, accountId);
    }
    return {
      ok: false,
      reason: `failed to start adapter: ${error instanceof Error ? error.message : String(error)}`,
      resolution
    };
  }
}
async function ensureCommsForSession(input) {
  const project = normalizeProjectPath(input.project);
  const accountLabelScope = input.accountLabelScope ?? null;
  const allRegistrations = await input.storage.listAccountRegistrations({
    project,
    agent: input.agent
  });
  const registrations = filterRegistrationsByScope(allRegistrations, accountLabelScope);
  if (accountLabelScope && registrations.length === 0) {
    const message = `agents-comm-bus: account_label_scope ${accountLabelScope} has no matching account registrations for project=${project} agent=${input.agent}`;
    console.error(message);
    await input.audit?.append({
      timestamp: Date.now(),
      kind: "account_label_scope_miss",
      agent: input.agent,
      detail: {
        project,
        account_label_scope: accountLabelScope,
        registration_count: allRegistrations.length
      }
    }).catch(() => {
    });
    throw new Error(message);
  }
  if (registrations.length === 0) {
    await reportRegistrationProjectNearMiss({
      agent: input.agent,
      requestedProject: input.requestedProject ?? input.project,
      canonicalProject: project,
      storage: input.storage,
      audit: input.audit
    });
    return;
  }
  for (const registration of registrations) {
    let factory = input.factories.find((f) => f.commId === registration.comm);
    const attemptedRescan = !factory && Boolean(input.rescanFactories);
    if (!factory && input.rescanFactories) {
      factory = await input.rescanFactories(registration.comm);
    }
    if (!factory) {
      if (attemptedRescan) {
        console.error(
          `agents-comm-bus: no comm adapter factory for "${registration.comm}" after on-demand re-scan (project=${project}, agent=${input.agent}, bot=${registration.bot_user_id}) \u2014 skipping adapter`
        );
      }
      await input.audit?.append({
        timestamp: Date.now(),
        kind: "comm_adapter_skip",
        agent: input.agent,
        detail: {
          comm: registration.comm,
          account_id: registration.bot_user_id,
          account_label: registration.account_label,
          project,
          reason: "no_comm_factory",
          rescanned: Boolean(input.rescanFactories)
        }
      }).catch(() => {
      });
      continue;
    }
    const accountId = registration.bot_user_id;
    const key = adapterMapKey(registration.comm, accountId);
    if (input.bus.getComm(registration.comm, accountId) || input.inFlight.has(key)) continue;
    input.inFlight.add(key);
    try {
      const result = await addAdapterForRegistration({
        factory,
        registration,
        bus: input.bus,
        bridges: input.bridges,
        env: input.env,
        blobs: input.blobs,
        stateRoot: input.stateRoot,
        storage: input.storage,
        leaseArbiter: input.leaseArbiter
      });
      if (!result.ok) {
        if (result.resolution.status === "invalid") {
          await appendCredentialResolutionFailedAudit(
            input.audit,
            registration,
            factory.commId,
            result.resolution
          );
        } else {
          console.error(
            `agents-comm-bus: ensureCommsForSession could not start ${key}: ${result.reason}`
          );
          await input.audit?.append({
            timestamp: Date.now(),
            kind: "comm_adapter_skip",
            agent: input.agent,
            detail: {
              comm: registration.comm,
              account_id: registration.bot_user_id,
              account_label: registration.account_label,
              project,
              reason: result.reason
            }
          }).catch(() => {
          });
        }
      }
    } finally {
      input.inFlight.delete(key);
    }
  }
}
async function createAdapterFromRegistration(input) {
  const resolved = await input.factory.resolveCredentials(input.registration, input.env, {
    storage: input.storage,
    stateRoot: input.stateRoot
  });
  if (resolved.status !== "ok") {
    return { adapter: null, resolution: resolved };
  }
  const adapter = input.factory.create(
    resolved.credentials,
    input.registration.bot_user_id,
    {
      blobs: input.blobs,
      stateRoot: input.stateRoot,
      registrationId: input.registration.registration_id,
      storage: input.storage
    }
  );
  if (adapter.exclusiveResource?.() != null) {
    return { adapter: wrapWithLease(adapter, input.leaseArbiter), resolution: resolved };
  }
  return { adapter, resolution: resolved };
}
async function reloadAdapters(input) {
  const added = [];
  const removed = [];
  const updated = [];
  const skipped = [];
  const current = /* @__PURE__ */ new Map();
  for (const entry of input.bus.listComms()) {
    current.set(adapterMapKey(entry.commId, entry.accountId), entry);
  }
  const desired = /* @__PURE__ */ new Map();
  for (const factory of input.factories) {
    const regs = await input.storage.listAccountRegistrations({ comm: factory.commId });
    for (const reg of regs) {
      const key = adapterMapKey(factory.commId, reg.bot_user_id);
      const scopeActive = input.activeScopes != null && isRegistrationScopeActive(reg, input.activeScopes);
      if (!current.has(key) && !scopeActive) continue;
      if (!desired.has(key)) desired.set(key, { factory, registration: reg });
    }
  }
  for (const [key, entry] of desired) {
    if (current.has(key)) continue;
    const result = await addAdapterForRegistration({
      factory: entry.factory,
      registration: entry.registration,
      bus: input.bus,
      bridges: input.bridges,
      env: input.env,
      blobs: input.blobs,
      stateRoot: input.stateRoot,
      storage: input.storage,
      leaseArbiter: input.leaseArbiter
    });
    if (result.ok) {
      added.push({
        comm: entry.registration.comm,
        account_id: entry.registration.bot_user_id
      });
    } else {
      skipped.push({
        comm: entry.registration.comm,
        account_id: entry.registration.bot_user_id,
        reason: result.reason
      });
      if (result.resolution.status === "invalid") {
        await appendCredentialResolutionFailedAudit(
          input.audit,
          entry.registration,
          entry.registration.comm,
          result.resolution
        );
      } else {
        await input.audit?.append({
          timestamp: Date.now(),
          kind: "comm_adapter_skip",
          agent: entry.registration.agent,
          detail: {
            comm: entry.registration.comm,
            account_id: entry.registration.bot_user_id,
            account_label: entry.registration.account_label,
            project: entry.registration.project,
            reason: result.reason,
            via: "reload_registrations"
          }
        }).catch(() => {
        });
      }
    }
  }
  for (const [key, entry] of current) {
    if (desired.has(key)) continue;
    const adapter = input.bus.unregisterComm(entry.commId, entry.accountId);
    for (const bridge of input.bridges) {
      bridge.detachComm?.(entry.commId, entry.accountId);
    }
    if (adapter) {
      try {
        await adapter.stop();
      } catch (error) {
        console.error(
          `agents-comm-bus: failed to stop ${entry.commId}/${entry.accountId} on reload: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    removed.push({ comm: entry.commId, account_id: entry.accountId });
  }
  const forceCredentialRefresh = new Set(
    input.options?.forceCredentialRefresh?.map(
      (target) => adapterMapKey(target.comm, target.accountId)
    ) ?? []
  );
  for (const [key, entry] of desired) {
    if (!current.has(key)) continue;
    if (forceCredentialRefresh.has(key)) {
      const { adapter, resolution } = await createAdapterFromRegistration({
        factory: entry.factory,
        registration: entry.registration,
        env: input.env,
        blobs: input.blobs,
        stateRoot: input.stateRoot,
        storage: input.storage,
        leaseArbiter: input.leaseArbiter
      });
      if (!adapter) {
        if (resolution.status === "invalid") {
          logInvalidCredentialResolution(entry.registration, entry.registration.comm, resolution);
          await appendCredentialResolutionFailedAudit(
            input.audit,
            entry.registration,
            entry.registration.comm,
            resolution
          );
        }
        skipped.push({
          comm: entry.registration.comm,
          account_id: entry.registration.bot_user_id,
          reason: resolution.status === "invalid" ? resolution.reason : unresolvedCredentialsReason(entry.registration.credentials_ref, "re-resolve")
        });
        continue;
      }
      const oldAdapter = input.bus.unregisterComm(
        entry.registration.comm,
        entry.registration.bot_user_id
      );
      for (const bridge of input.bridges) {
        bridge.detachComm?.(
          entry.registration.comm,
          entry.registration.bot_user_id
        );
      }
      if (oldAdapter) {
        try {
          await oldAdapter.stop();
        } catch (error) {
          console.error(
            `agents-comm-bus: failed to stop ${entry.registration.comm}/${entry.registration.bot_user_id} for credential refresh: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      try {
        input.bus.registerComm(adapter);
        for (const bridge of input.bridges) {
          bridge.attachComm?.(adapter);
        }
        await adapter.start();
        updated.push({
          comm: entry.registration.comm,
          account_id: entry.registration.bot_user_id,
          what: "credentials"
        });
      } catch (error) {
        input.bus.unregisterComm(
          entry.registration.comm,
          entry.registration.bot_user_id
        );
        for (const bridge of input.bridges) {
          bridge.detachComm?.(
            entry.registration.comm,
            entry.registration.bot_user_id
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `agents-comm-bus: failed to restart ${entry.registration.comm}/${entry.registration.bot_user_id} on credential refresh: ${reason}`
        );
        if (oldAdapter) {
          try {
            input.bus.registerComm(oldAdapter);
            for (const bridge of input.bridges) {
              bridge.attachComm?.(oldAdapter);
            }
            await oldAdapter.start();
          } catch (restoreError) {
            console.error(
              `agents-comm-bus: failed to restore previous ${entry.registration.comm}/${entry.registration.bot_user_id} adapter after credential refresh failure: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
            );
          }
        }
        skipped.push({
          comm: entry.registration.comm,
          account_id: entry.registration.bot_user_id,
          reason: `failed to refresh credentials: ${reason}`
        });
      }
      continue;
    }
    const liveAdapter = input.bus.getComm(
      entry.registration.comm,
      entry.registration.bot_user_id
    );
    if (!liveAdapter || !liveAdapter.updateAllowedSenderIds) continue;
    const resolved = await entry.factory.resolveCredentials(entry.registration, input.env, {
      storage: input.storage,
      stateRoot: input.stateRoot
    });
    if (resolved.status !== "ok") {
      if (resolved.status === "invalid") {
        logInvalidCredentialResolution(entry.registration, entry.registration.comm, resolved);
        await appendCredentialResolutionFailedAudit(
          input.audit,
          entry.registration,
          entry.registration.comm,
          resolved
        );
      }
      skipped.push({
        comm: entry.registration.comm,
        account_id: entry.registration.bot_user_id,
        reason: resolved.status === "invalid" ? resolved.reason : unresolvedCredentialsReason(entry.registration.credentials_ref, "re-resolve")
      });
      continue;
    }
    const newIds = Array.isArray(resolved.credentials.allowedUserIds) ? resolved.credentials.allowedUserIds.map(String) : [];
    const oldIds = liveAdapter.allowedSenderIds ?? [];
    if (sameStringSet(oldIds, newIds)) continue;
    liveAdapter.updateAllowedSenderIds(newIds);
    updated.push({
      comm: entry.registration.comm,
      account_id: entry.registration.bot_user_id,
      what: "allowlist"
    });
  }
  if (added.length > 0 || removed.length > 0 || updated.some((entry) => entry.what === "credentials")) {
    for (const bridge of input.bridges) {
      bridge.invalidateRegistrationCaches?.();
    }
  }
  return { ok: true, added, removed, updated, skipped };
}
async function resolveOwnedAccountKeys(storage, session) {
  if (typeof session !== "string" || session.length === 0) return void 0;
  const sess = await storage.getSession(session);
  if (!sess) return /* @__PURE__ */ new Set();
  const regs = filterRegistrationsByScope(
    await storage.listAccountRegistrations({
      project: sess.project,
      agent: sess.agent
    }),
    sess.account_label_scope
  );
  return new Set(regs.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
}
function sameStringSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const x of b) {
    if (!set.has(x)) return false;
  }
  return true;
}
function unresolvedCredentialsReason(ref, action = "resolve") {
  if (ref.startsWith("env:")) {
    return `could not ${action} credentials_ref=${ref}: env: credential refs are retired; rerun account-update-token with --bot-token to create a daemon-owned file: ref`;
  }
  return `could not ${action} credentials_ref=${ref}`;
}
function logInvalidCredentialResolution(registration, commId, resolution) {
  const pathSuffix = resolution.path ? ` [${resolution.path}]` : "";
  console.error(
    `agents-comm-bus: credential file for ${commId} account ${registration.account_label} (project ${registration.project}) exists but failed to resolve: ${resolution.reason}${pathSuffix}`
  );
}
async function appendCredentialResolutionFailedAudit(audit, registration, commId, resolution) {
  await audit?.append({
    timestamp: Date.now(),
    kind: "credential_resolution_failed",
    agent: registration.agent,
    detail: {
      comm: commId,
      account_label: registration.account_label,
      project: registration.project,
      bot_user_id: registration.bot_user_id,
      credential_path: resolution.path ?? null,
      failure_kind: resolution.failureKind,
      reason: resolution.reason
    }
  }).catch(() => {
  });
}
function adapterMapKey(commId, accountId) {
  return `${commId}:${accountId}`;
}
function scopeKey(agent, project, accountLabelScope) {
  return `${agent}:${normalizeProjectPath(project)}:${accountLabelScope ?? ""}`;
}
function isRegistrationScopeActive(registration, activeScopes) {
  const prefix = `${registration.agent}:${normalizeProjectPath(registration.project)}:`;
  const legacyKey = `${registration.agent}:${normalizeProjectPath(registration.project)}`;
  for (const key of activeScopes) {
    if (key === legacyKey) return true;
    if (!key.startsWith(prefix)) continue;
    const scopeStored = key.slice(prefix.length);
    const scope = scopeStored.length > 0 ? scopeStored : null;
    if (filterRegistrationsByScope([registration], scope).length > 0) return true;
  }
  return false;
}
async function reportRegistrationProjectNearMiss(input) {
  const allForAgent = await input.storage.listAccountRegistrations({ agent: input.agent });
  const nearMatchProjects = [
    ...new Set(
      allForAgent.filter((reg) => normalizeProjectPath(reg.project) === input.canonicalProject).map((reg) => reg.project)
    )
  ];
  if (nearMatchProjects.length === 0) return;
  const detail = {
    agent: input.agent,
    requested_project: input.requestedProject,
    canonical_project: input.canonicalProject,
    near_match_projects: nearMatchProjects
  };
  console.error(
    `agents-comm-bus: registration_project_near_miss for agent=${input.agent}: requested=${JSON.stringify(input.requestedProject)} canonical=${JSON.stringify(input.canonicalProject)} near_matches=${JSON.stringify(nearMatchProjects)} (run scripts/repair-project-paths.mjs to canonicalize stored rows)`
  );
  if (input.audit) {
    await input.audit.append({
      timestamp: Date.now(),
      kind: "registration_project_near_miss",
      detail
    }).catch(() => {
    });
  }
}
function handleDaemonStatus(input) {
  return {
    daemon_version: DAEMON_VERSION,
    live_adapters: input.bus.listComms().map((entry) => `${entry.commId}:${entry.accountId}`),
    pending_inbound_depth: input.pendingInbound.length,
    active_scope_count: input.activeScopes.size
  };
}
async function handleEnsureCommsForScope(params, ensureCommsForSession2) {
  const rawProject = params.project;
  if (typeof rawProject !== "string" || rawProject.trim() === "") {
    throw new Error("ensure_comms_for_scope requires params.project");
  }
  const agent = typeof params.agent === "string" && params.agent.trim() !== "" ? params.agent : "claude";
  const canonicalProject = normalizeProjectPath(rawProject);
  const accountLabelScope = typeof params.account_label_scope === "string" || params.account_label_scope === null ? params.account_label_scope : null;
  await ensureCommsForSession2(canonicalProject, agent, { accountLabelScope });
  return { ok: true, project: canonicalProject, agent };
}
async function dispatchIpc(request, context) {
  const params = request.params ?? {};
  if (request.method === "daemon_status") {
    return handleDaemonStatus({
      bus: context.bus,
      pendingInbound: context.pendingInbound,
      activeScopes: context.activeScopes
    });
  }
  if (request.method === "ensure_comms_for_scope") {
    return handleEnsureCommsForScope(params, context.ensureCommsForSession);
  }
  if (request.method === "inspect_inbound_target") {
    return handleInspectInboundTarget(params, {
      storage: context.storage,
      bridges: context.bridges,
      daemonOwner: context.daemonOwner,
      sessionOwnerIsLive: context.sessionOwnerIsLive
    });
  }
  if (request.method === "list_conversations") {
    return context.bus.listConversations({
      comm: params.comm,
      limit: typeof params.limit === "number" ? params.limit : 25
    });
  }
  if (request.method === "reload_registrations") {
    return context.reloadRegistrations(parseReloadOptions(params));
  }
  if (request.method === "probe_comm_identity") {
    return probeCommIdentity(
      params,
      context.commAdapterFactories,
      context.env,
      context.rescanFactories
    );
  }
  const bridge = context.bridgesByMethod.get(request.method);
  if (bridge) {
    return bridge.handleIpcMethod(request.method, params, { socket: context.socket });
  }
  const commHandler = context.ipcMethods.get(request.method);
  if (commHandler) {
    return commHandler(params, { socket: context.socket });
  }
  throw new Error(`unknown IPC method: ${request.method}`);
}
async function probeCommIdentity(params, factories, env, rescanFactories) {
  const comm = typeof params.comm === "string" ? params.comm : null;
  if (!comm) {
    throw new Error("probe_comm_identity requires params.comm");
  }
  const credentials = params.credentials && typeof params.credentials === "object" ? params.credentials : null;
  if (!credentials) {
    throw new Error("probe_comm_identity requires params.credentials");
  }
  let factory = factories.find((candidate) => candidate.commId === comm);
  if (!factory && rescanFactories) {
    factory = await rescanFactories(comm);
  }
  if (!factory) {
    throw new Error(`no comm adapter factory is loaded for ${comm}`);
  }
  if (!factory.probeIdentity) {
    throw new Error(`comm adapter ${comm} does not support identity probing`);
  }
  const identity = await factory.probeIdentity(credentials, env);
  return {
    comm,
    account_id: String(identity.accountId),
    account_username: identity.accountUsername ?? null
  };
}
function parseReloadOptions(params) {
  const raw = params.forceCredentialRefresh;
  if (!Array.isArray(raw)) return {};
  const forceCredentialRefresh = raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item;
    if (record.comm == null || record.accountId == null) return [];
    return [{
      comm: String(record.comm),
      accountId: String(record.accountId)
    }];
  });
  return { forceCredentialRefresh };
}

// ../core-daemon/bridges/claude/bridge.ts
import crypto3 from "node:crypto";

// ../core-daemon/runtime/agent-bridge.ts
function sessionLeaseOwnerWithDaemon(ownerFromParams, daemonOwner) {
  return {
    process_pid: ownerFromParams?.process_pid ?? null,
    process_label: ownerFromParams?.process_label,
    daemon: {
      discovery_root: daemonOwner.discoveryRoot,
      checkout_root: daemonOwner.checkoutRoot,
      state_root: daemonOwner.stateRoot,
      daemon_bin: daemonOwner.daemonBin,
      authority_rank: daemonOwner.authorityRank
    }
  };
}

// ../core-daemon/bridges/claude/wake.ts
import crypto2 from "node:crypto";
import { mkdir as mkdir7, writeFile as writeFile2 } from "node:fs/promises";
import os4 from "node:os";
import path4 from "node:path";
function hashProjectKey(projectPath) {
  let hash = 2166136261;
  for (let i = 0; i < projectPath.length; i += 1) {
    hash ^= projectPath.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function claudeWakeDirForProject(projectPath, homeDir = os4.homedir(), accountLabelScope = null) {
  const canonical = normalizeProjectPath(projectPath);
  const basename = path4.basename(canonical) || "project";
  const legacyDir = `${basename}-${hashProjectKey(canonical)}`;
  let canonicalScope;
  try {
    canonicalScope = serializeAccountLabelScope(
      parseAccountLabelScope(accountLabelScope)
    );
  } catch (error) {
    console.error(
      `agents-comm-bus: invalid persisted Claude account_label_scope; using a scope-inert wake directory: ${error instanceof Error ? error.message : String(error)}`
    );
    canonicalScope = `__invalid__:${accountLabelScope}`;
  }
  return path4.join(
    homeDir,
    ".agents-comm-bus",
    "claude-wake",
    "sessions",
    canonicalScope ? `${legacyDir}-${crypto2.createHash("sha256").update(canonicalScope).digest("hex").slice(0, 12)}` : legacyDir
  );
}
async function writeClaudeWakeTrigger(wakeDir, now = Date.now) {
  await mkdir7(wakeDir, { recursive: true });
  await writeFile2(path4.join(wakeDir, "trigger-enter"), `${now()}
`, "utf8");
}
var WAKE_SEED_MAX_CHARS = 2e3;
function sanitizeWakeSeed(text) {
  if (!text) return "";
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "").trim();
  return normalized.length > WAKE_SEED_MAX_CHARS ? normalized.slice(0, WAKE_SEED_MAX_CHARS) : normalized;
}
function buildWakeSeed(input) {
  const body = (input.body ?? "").trim();
  if (!body) return "";
  const comm = input.comm && input.comm.length > 0 ? input.comm : "message";
  const sender = input.sender && input.sender.length > 0 ? input.sender : "unknown sender";
  return sanitizeWakeSeed(`${comm} message from ${sender}: ${body}`);
}
async function writeClaudeWakeSeed(wakeDir, text) {
  await mkdir7(wakeDir, { recursive: true });
  await writeFile2(path4.join(wakeDir, "wake-seed.txt"), text, "utf8");
}
async function writeClaudeWakeResponse(wakeDir, payload) {
  await mkdir7(wakeDir, { recursive: true });
  await writeFile2(
    path4.join(wakeDir, "permission-response.json"),
    JSON.stringify(payload),
    "utf8"
  );
}
var ClaudeWakeRegistry = class {
  constructor(now = Date.now, sessionOwnerIsLive = createSessionOwnerLiveness()) {
    this.now = now;
    this.sessionOwnerIsLive = sessionOwnerIsLive;
  }
  now;
  sessionOwnerIsLive;
  registrations = /* @__PURE__ */ new Map();
  storage = null;
  /**
   * Inject the daemon's storage so wake lookups can fall back to the
   * persisted `sessions` table when the in-memory map is empty (e.g. after
   * a daemon restart, before the agent's MCP shim / hooks have re-issued
   * `claude_register_session`). The Claude wake_dir is deterministic from
   * project, so no extra schema column is needed — the session row's
   * `project` is enough to reconstruct the dir via
   * `claudeWakeDirForProject`.
   */
  setStorage(storage) {
    this.storage = storage;
  }
  register(input) {
    const project = normalizeProjectPath(input.project);
    const registration = {
      session: input.session,
      project,
      wakeDir: input.wakeDir ?? claudeWakeDirForProject(
        project,
        os4.homedir(),
        input.account_label_scope ?? null
      ),
      registeredAt: this.now(),
      account_label_scope: input.account_label_scope ?? null
    };
    this.registrations.set(input.session, registration);
    return registration;
  }
  latestForProject(project, conversation) {
    const resolved = normalizeProjectPath(project);
    const candidates = [...this.registrations.values()].filter(
      (registration) => registration.project === resolved
    );
    if (candidates.length === 0) return void 0;
    if (!conversation) {
      let latest;
      for (const registration of candidates) {
        if (!latest || registration.registeredAt > latest.registeredAt) {
          latest = registration;
        }
      }
      return latest;
    }
    const match = resolveSessionForConversation(
      candidates.map((registration) => ({
        project: registration.project,
        agent: "claude",
        account_label_scope: registration.account_label_scope,
        session_id: registration.session
      })),
      conversation,
      (candidate) => candidate.session_id
    );
    if (match) {
      return candidates.find((registration) => registration.session === match.session_id);
    }
    const unlabeled = candidates.filter((registration) => registration.account_label_scope == null);
    if (unlabeled.length === 1) return unlabeled[0];
    return void 0;
  }
  getForSession(session) {
    return this.registrations.get(session);
  }
  async writeResponseForSession(session, payload) {
    const registration = this.registrations.get(session) ?? await this.hydrateRegistrationForSession(session);
    if (!registration) return false;
    await writeClaudeWakeResponse(registration.wakeDir, payload);
    await writeClaudeWakeTrigger(registration.wakeDir, this.now);
    return true;
  }
  async wakeConversation(conversation, message) {
    if (conversation.agent !== "claude") return false;
    const registration = this.latestForProject(conversation.project, conversation) ?? await this.hydrateLatestForProject(conversation.project, conversation);
    if (!registration) return false;
    const seed = buildWakeSeed({
      comm: message?.chat.comm,
      sender: message?.sender?.display_name ?? message?.sender?.id,
      body: message?.text
    });
    if (seed) {
      try {
        await writeClaudeWakeSeed(registration.wakeDir, seed);
      } catch {
      }
    }
    await writeClaudeWakeTrigger(registration.wakeDir, this.now);
    return true;
  }
  /**
   * On a miss in `wakeConversation`, look up the most recent Claude session
   * for this project from storage and seed the in-memory map. The wake_dir
   * is deterministic from persisted project + label scope, so reconstruction
   * is lossless even across daemon restarts.
   */
  async hydrateLatestForProject(project, conversation) {
    if (!this.storage) return void 0;
    const resolved = normalizeProjectPath(project);
    const sessions = await this.storage.listSessions({
      project: resolved,
      agent: "claude",
      status: "active"
    });
    if (sessions.length === 0) return void 0;
    const live = sessions.filter(this.sessionOwnerIsLive);
    const pool = live.length > 0 ? live : sessions;
    let match = conversation ? resolveSessionForConversation(pool, conversation, (sess) => sess.session_id) : pool[0];
    if (conversation && !match) {
      match = pool.find(
        (session) => session.account_label_scope == null
      );
      if (!match) return void 0;
    }
    const latest = match;
    if (!latest) return void 0;
    return this.register({
      session: latest.session_id,
      project: resolved,
      account_label_scope: latest.account_label_scope
    });
  }
  /**
   * On a miss in `writeResponseForSession`, look up the specific session
   * row in storage and reconstruct its wake registration so we can write
   * the wake response after a daemon restart.
   */
  async hydrateRegistrationForSession(session) {
    if (!this.storage) return void 0;
    const record = await this.storage.getSession(session);
    if (!record || record.agent !== "claude") return void 0;
    return this.register({
      session,
      project: record.project,
      account_label_scope: record.account_label_scope
    });
  }
};

// ../core-daemon/bridges/claude/open-query-tracker.ts
var ClaudeOpenQueryTracker = class {
  openQueriesBySession = /* @__PURE__ */ new Map();
  querySessions = /* @__PURE__ */ new Map();
  queryTtlTimers = /* @__PURE__ */ new Map();
  setTimeoutFn;
  clearTimeoutFn;
  constructor(options = {}) {
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
  }
  openQueryCount() {
    let count = 0;
    for (const set of this.openQueriesBySession.values()) count += set.size;
    return count;
  }
  getRetirementBlockers() {
    const count = this.openQueryCount();
    return count > 0 ? { open_queries: count } : null;
  }
  trackOpenQuery(session, queryId, ttlSeconds) {
    let set = this.openQueriesBySession.get(session);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.openQueriesBySession.set(session, set);
    }
    set.add(queryId);
    this.querySessions.set(queryId, session);
    const ttlMs = Math.max(1, Math.round(ttlSeconds * 1e3));
    const timer = this.setTimeoutFn(() => {
      this.clearOpenQuery(queryId);
    }, ttlMs);
    this.queryTtlTimers.set(queryId, timer);
  }
  clearOpenQuery(queryId) {
    const timer = this.queryTtlTimers.get(queryId);
    if (timer != null) {
      this.clearTimeoutFn(timer);
      this.queryTtlTimers.delete(queryId);
    }
    const session = this.querySessions.get(queryId);
    this.querySessions.delete(queryId);
    if (!session) return;
    const set = this.openQueriesBySession.get(session);
    if (!set) return;
    set.delete(queryId);
    if (set.size === 0) this.openQueriesBySession.delete(session);
  }
  clearOpenQueriesForSession(session) {
    const set = this.openQueriesBySession.get(session);
    if (!set) return;
    for (const queryId of [...set]) {
      this.clearOpenQuery(queryId);
    }
  }
};

// ../core-daemon/bridges/claude/bridge.ts
var DEFAULT_TTL_SECONDS = 3600;
var CLAUDE_IPC_METHODS = /* @__PURE__ */ new Set([
  "claude_register_session",
  "claude_drain_inbound",
  "claude_open_query"
]);
var ClaudeBridge = class {
  constructor(options) {
    this.options = options;
    void options.pendingInboundMax;
    this.sessionOwnerIsLive = options.sessionOwnerIsLive ?? createSessionOwnerLiveness();
    this.wake = new ClaudeWakeRegistry(
      Date.now,
      this.sessionOwnerIsLive
    );
    this.wake.setStorage(options.storage);
    this.openQueryTracker = new ClaudeOpenQueryTracker({
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn
    });
  }
  options;
  agentId = "claude";
  ipcMethods = CLAUDE_IPC_METHODS;
  wake;
  ownedAccountsCache = null;
  /** AGE-37: sequential AskUserQuestion prompts keyed by the active query id. */
  questionSequences = /* @__PURE__ */ new Map();
  /** AGE-36: daemon-local open-query tracking for retirement eligibility. */
  openQueryTracker;
  sessionOwnerIsLive;
  /**
   * Wire Claude-specific behaviors into the bus + per-comm callbacks. The
   * shared dispatch sink (pendingInbound + onInboundConversation fan-out)
   * is set up by the daemon; here we only own resolve-on-sink (write the
   * wake response) and the inline-keyboard callback handler.
   */
  attach(comms) {
    this.options.bus.setResolveSink({
      onResolved: async (query, decision) => {
        if (query.agent !== this.agentId) return;
        this.openQueryTracker.clearOpenQuery(query.query_id);
        const payload = wakePayloadFromDecision(decision);
        if (!payload) return;
        try {
          const delivered = await this.wake.writeResponseForSession(query.session, payload);
          if (!delivered) {
            await this.auditWakeFailure({
              reason: "hydration_miss",
              session: query.session,
              detail: { path: "resolve_sink", prompt_type: payload.prompt_type }
            });
          }
        } catch (error) {
          await this.auditWakeFailure({
            reason: "write_failed",
            session: query.session,
            detail: {
              path: "resolve_sink",
              prompt_type: payload.prompt_type,
              error: error instanceof Error ? error.message : String(error)
            }
          });
        }
        const seq = this.questionSequences.get(query.query_id);
        if (seq) {
          this.questionSequences.delete(query.query_id);
          await this.openNextQuestion(seq);
        }
      }
    });
    for (const comm of comms) {
      this.attachComm(comm);
    }
  }
  attachComm(comm) {
    if (typeof comm.onCallback === "function") {
      comm.onCallback(async (event) => {
        await this.handleCommCallback(comm, event);
      });
    }
  }
  detachComm(_commId, _accountId) {
  }
  getRetirementBlockers() {
    return this.openQueryTracker.getRetirementBlockers();
  }
  invalidateRegistrationCaches() {
    this.ownedAccountsCache = null;
  }
  async onInboundConversation(conversation, message) {
    if (conversation.agent !== this.agentId) return;
    try {
      const delivered = await this.wake.wakeConversation(conversation, message);
      if (!delivered) {
        await this.auditWakeFailure({
          reason: "hydration_miss",
          conversation_id: conversation.conversation_id,
          detail: { path: "inbound_wake", project: conversation.project }
        });
      }
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to write Claude wake trigger for ${conversation.conversation_id}: ${error instanceof Error ? error.message : String(error)}`
      );
      await this.auditWakeFailure({
        reason: "write_failed",
        conversation_id: conversation.conversation_id,
        detail: {
          path: "inbound_wake",
          project: conversation.project,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
  async auditWakeFailure(input) {
    try {
      await this.options.audit?.append({
        timestamp: Date.now(),
        kind: "wake_delivery_failure",
        agent: this.agentId,
        session: input.session,
        conversation_id: input.conversation_id,
        detail: { reason: input.reason, ...input.detail }
      });
    } catch {
    }
  }
  async handleIpcMethod(method, params, ctx) {
    switch (method) {
      case "claude_register_session":
        return this.registerSession(params, ctx.socket);
      case "claude_drain_inbound":
        return this.drainInbound(params);
      case "claude_open_query":
        return this.openQuery(params);
      default:
        throw new Error(`ClaudeBridge does not handle IPC method: ${method}`);
    }
  }
  /**
   * Drain pending-inbound entries whose source `(comm, account)` belongs to
   * a Claude registration. The queue is daemon-wide and shared across
   * bridges, so each agent must filter to its own accounts — otherwise the
   * first bridge to drain sweeps the queue and starves the others. We
   * filter on `message.chat.account` (the bot_user_id) rather than the
   * derived `conversation.agent` so the check is rooted in the source
   * record contract: `(comm, bot_user_id)` uniquely identifies a
   * `(project, agent)` registration per the daemon design.
   */
  async drainPendingInbound(session) {
    const owned = await this.ownedAccountKeys(session);
    const drained = this.options.pendingInbound.filter(
      (entry) => owned.has(accountKey(entry))
    );
    if (drained.length > 0) {
      await removePendingInboundEntries(
        this.options.storage,
        this.options.pendingInbound,
        drained
      );
    }
    return drained;
  }
  /**
   * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. The
   * daemon's account registrations only change via the CLI, which requires
   * a daemon restart to take effect — so caching once per process is safe.
   * Future-proofing for runtime registration would re-fetch on miss; left
   * as a follow-up.
   */
  async ensureCommsBestEffort(project, accountLabelScope) {
    const hook = this.options.ensureCommsForSession;
    if (!hook) return false;
    try {
      const result = await hook(project, this.agentId, {
        accountLabelScope: accountLabelScope ?? null
      });
      return result.rehydrated;
    } catch (error) {
      console.error(
        `agents-comm-bus: ensureCommsForSession failed for ${project}/${this.agentId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }
  /** AGE-91: daemon-local route = a registered wake dir for this session. */
  routeReady(session) {
    return this.wake.getForSession(session) !== void 0;
  }
  isLocallyDeliverable(session) {
    return isSessionLocallyDeliverable(
      session,
      this.routeReady(session.session_id),
      this.sessionOwnerIsLive
    );
  }
  /**
   * AGE-89: after a deliverability edge with confirmed rehydration, wake once
   * for the newest in-scope pending row. The agent drain consumes the queue;
   * the daemon must never remove pendingInbound here (AGE-64).
   */
  async redrivePendingInboundCoalesced(sessionId) {
    const sess = await this.options.storage.getSession(sessionId);
    if (!sess) return;
    const [registrations, sessions] = await Promise.all([
      this.options.storage.listAccountRegistrations({
        project: sess.project,
        agent: this.agentId
      }),
      this.options.storage.listSessions({
        project: sess.project,
        agent: this.agentId,
        status: "active"
      })
    ]);
    const scopedRegs = filterRegistrationsForSession(
      registrations,
      sess,
      sessions,
      this.sessionOwnerIsLive
    );
    const ownedKeys = new Set(
      scopedRegs.map((reg) => `${reg.comm}:${reg.bot_user_id}`)
    );
    const inScope = this.options.pendingInbound.filter((entry) => {
      if (entry.conversation.project !== sess.project) return false;
      if (entry.conversation.agent !== this.agentId) return false;
      if (!ownedKeys.has(accountKey(entry))) return false;
      return sessionOwnsConversation(
        sess,
        sessions,
        entry.conversation,
        this.sessionOwnerIsLive
      );
    });
    if (inScope.length === 0) return;
    const seed = inScope.reduce(
      (latest, entry) => entry.message.received_at > latest.message.received_at ? entry : latest
    );
    await this.onInboundConversation(seed.conversation, seed.message);
  }
  async ownedAccountKeys(session) {
    if (session) {
      const sess = await this.options.storage.getSession(session);
      if (!sess) return /* @__PURE__ */ new Set();
      const [registrations2, sessions] = await Promise.all([
        this.options.storage.listAccountRegistrations({
          project: sess.project,
          agent: this.agentId
        }),
        this.options.storage.listSessions({
          project: sess.project,
          agent: this.agentId,
          status: "active"
        })
      ]);
      const scoped = filterRegistrationsForSession(
        registrations2,
        sess,
        sessions,
        this.sessionOwnerIsLive
      );
      return new Set(scoped.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
    }
    if (this.ownedAccountsCache) return this.ownedAccountsCache;
    const registrations = await this.options.storage.listAccountRegistrations({
      agent: this.agentId
    });
    this.ownedAccountsCache = new Set(
      registrations.map((reg) => `${reg.comm}:${reg.bot_user_id}`)
    );
    return this.ownedAccountsCache;
  }
  async registerSession(params, socket) {
    const session = requiredString(params.session, "session");
    const project = normalizeProjectPath(requiredString(params.project, "project"));
    const connectionId = typeof params.connection_id === "string" ? params.connection_id : `claude:${session}:${crypto3.randomUUID()}`;
    const now = Date.now();
    const wakeDir = typeof params.wake_dir === "string" ? params.wake_dir : typeof params.wakeDir === "string" ? params.wakeDir : void 0;
    const accountLabelScope = accountLabelScopeFromParams(params);
    await this.options.storage.upsertSession({
      schema_version: SCHEMA_VERSION_SESSION,
      session_id: session,
      agent: "claude",
      project,
      created_at: now,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: null,
      lease_owner_process_label: null,
      lease_owner_process_registered_at: null,
      lease_owner_daemon_discovery_root: null,
      lease_owner_daemon_checkout_root: null,
      lease_owner_daemon_state_root: null,
      lease_owner_daemon_bin: null,
      lease_owner_daemon_authority_rank: null,
      most_recent_inbound_conversation_id: null,
      account_label_scope: accountLabelScope,
      status: "active"
    });
    const baselineSession = await this.options.storage.getSession(session);
    const deliverabilityBaseline = baselineSession ? this.isLocallyDeliverable(baselineSession) : false;
    const acquired = await this.options.storage.acquireSessionLease(
      session,
      connectionId,
      now,
      this.options.daemonOwner ? sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams(params), this.options.daemonOwner) : sessionLeaseOwnerFromParams(params)
    );
    if (!acquired) {
      await this.ensureCommsBestEffort(project, accountLabelScope);
      return { ok: false, reason: "same-project claude session lease already held" };
    }
    const registration = this.wake.register({
      session,
      project,
      wakeDir,
      account_label_scope: accountLabelScope
    });
    socket?.once("close", () => {
      void this.options.storage.releaseSessionConnectionLeasePreservingOwner(
        session,
        connectionId,
        Date.now()
      );
    });
    const rehydrated = await this.ensureCommsBestEffort(project, accountLabelScope);
    const afterSession = await this.options.storage.getSession(session);
    const deliverabilityAfter = afterSession ? this.isLocallyDeliverable(afterSession) : false;
    if (!deliverabilityBaseline && deliverabilityAfter && rehydrated) {
      await this.redrivePendingInboundCoalesced(session);
    }
    return { ok: true, wake_dir: registration.wakeDir };
  }
  async drainInbound(params) {
    const session = typeof params.session === "string" ? params.session : void 0;
    const drained = await this.drainPendingInbound(session);
    if (session && drained.length > 0) {
      await this.options.storage.setSessionMostRecentInbound(
        session,
        drained[drained.length - 1].conversation.conversation_id
      );
    }
    return drained;
  }
  async openQuery(params) {
    const session = requiredString(params.session, "session");
    const queryInput = recordOrEmpty(params.query);
    const claudeInput = recordOrEmpty(params.claude);
    const toolName = typeof params.tool_name === "string" ? params.tool_name : typeof claudeInput.tool_name === "string" ? claudeInput.tool_name : void 0;
    const promptText = requiredString(
      params.prompt_text ?? queryInput.prompt_text,
      "prompt_text"
    );
    const rawKind = params.kind ?? queryInput.kind;
    const kind = rawKind === "choice" || rawKind === "freetext" || rawKind === "approval" ? rawKind : "approval";
    const sessionRecord = await this.options.storage.getSession(session);
    const conversation = sessionRecord?.most_recent_inbound_conversation_id ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id) : null;
    const originChat = conversation ? await this.chatRefForConversation(conversation) : void 0;
    const options = Array.isArray(params.options) ? params.options.map(String) : Array.isArray(queryInput.options) ? queryInput.options.map(String) : void 0;
    const ttlSeconds = typeof params.ttl_seconds === "number" ? params.ttl_seconds : DEFAULT_TTL_SECONDS;
    const promptFormatRaw = params.prompt_format ?? queryInput.prompt_format;
    const promptFormat = promptFormatRaw === "html" ? "html" : "plain";
    const supersede = params.supersede !== false;
    const questions = parseNormalizedQuestions(
      params.questions ?? queryInput.questions
    );
    if (questions && questions.length > 1) {
      const firstQuestion = questions[0];
      const sequencedPrompt = formatQuestionPrompt(firstQuestion, 0, questions.length);
      const sequencedOptions = questionOptionsFromNormalized(firstQuestion);
      const queryId2 = await this.openQueryCore({
        session,
        kind: "choice",
        promptText: sequencedPrompt,
        promptFormat: "html",
        options: sequencedOptions,
        originChat,
        ttlSeconds,
        supersede
      });
      this.questionSequences.set(queryId2, {
        session,
        questions,
        index: 0,
        ttlSeconds
      });
      const hookResponse2 = hookResponseForUnresolvedClaudeQuery({ ...params, tool_name: toolName });
      return {
        query_id: queryId2,
        hook_response: hookResponse2,
        hookJson: hookResponse2,
        nativeHookJson: hookResponse2
      };
    }
    const queryId = await this.openQueryCore({
      session,
      kind,
      promptText,
      promptFormat,
      options,
      originChat,
      ttlSeconds,
      supersede
    });
    const hookResponse = hookResponseForUnresolvedClaudeQuery({ ...params, tool_name: toolName });
    return {
      query_id: queryId,
      hook_response: hookResponse,
      hookJson: hookResponse,
      nativeHookJson: hookResponse
    };
  }
  /**
   * Shared open-query path: build → supersede? → bus.openQuery → send →
   * setQuerySourceMessage. Used by the IPC handler and the AGE-37 sequencer.
   */
  async openQueryCore(input) {
    const queryId = `q_${crypto3.randomUUID()}`;
    const query = {
      schema_version: 1,
      query_id: queryId,
      agent: "claude",
      session: input.session,
      kind: input.kind,
      prompt_text: input.promptText,
      options: input.options,
      origin_chat: input.originChat,
      created_at: Date.now(),
      ttl_seconds: input.ttlSeconds
    };
    if (input.supersede) {
      await this.options.storage.supersedeOpenQueriesForSession(input.session, Date.now());
      this.clearQuestionSequencesForSession(input.session);
      this.openQueryTracker.clearOpenQueriesForSession(input.session);
    }
    await this.options.bus.openQuery(query);
    this.openQueryTracker.trackOpenQuery(input.session, queryId, input.ttlSeconds);
    if (input.originChat) {
      try {
        const inlineKeyboard = inlineKeyboardForQuery(queryId, input.kind, input.options);
        const promptMessageId = await this.options.bus.send({
          session: input.session,
          comm: input.originChat.comm,
          target: input.originChat,
          payload: {
            text: input.promptText,
            format: input.promptFormat === "html" ? "html" : "plain",
            inline_keyboard: inlineKeyboard
          },
          idempotencyKey: `query:${queryId}`
        });
        try {
          await this.options.storage.setQuerySourceMessage(queryId, promptMessageId);
        } catch (error) {
          console.error(
            `agents-comm-bus: failed to record prompt message id for ${queryId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } catch (error) {
        try {
          await this.options.storage.cancelOpenQuery(queryId, Date.now());
        } catch (cancelError) {
          console.error(
            `agents-comm-bus: failed to cancel unsent query ${queryId}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`
          );
        }
        this.openQueryTracker.clearOpenQuery(queryId);
        throw error;
      }
    }
    return queryId;
  }
  /** Drop stale sequencer entries when any supersede=true open fires. */
  clearQuestionSequencesForSession(session) {
    for (const [queryId, seq] of this.questionSequences) {
      if (seq.session === session) {
        this.questionSequences.delete(queryId);
      }
    }
  }
  /** Open the next question in an AskUserQuestion sequence after resolution. */
  async openNextQuestion(seq) {
    const nextIndex = seq.index + 1;
    if (nextIndex >= seq.questions.length) return;
    const sessionRecord = await this.options.storage.getSession(seq.session);
    const conversation = sessionRecord?.most_recent_inbound_conversation_id ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id) : null;
    const originChat = conversation ? await this.chatRefForConversation(conversation) : void 0;
    const nextQuestion = seq.questions[nextIndex];
    const promptText = formatQuestionPrompt(nextQuestion, nextIndex, seq.questions.length);
    const options = questionOptionsFromNormalized(nextQuestion);
    const attemptOpen = async () => this.openQueryCore({
      session: seq.session,
      kind: "choice",
      promptText,
      promptFormat: "html",
      options,
      originChat,
      ttlSeconds: seq.ttlSeconds,
      supersede: false
    });
    try {
      const queryId = await attemptOpen();
      this.questionSequences.set(queryId, { ...seq, index: nextIndex });
    } catch (firstError) {
      try {
        const queryId = await attemptOpen();
        this.questionSequences.set(queryId, { ...seq, index: nextIndex });
      } catch (secondError) {
        console.error(
          `agents-comm-bus: failed to open AskUserQuestion ${nextIndex + 1}/${seq.questions.length} for session ${seq.session}: ${secondError instanceof Error ? secondError.message : String(secondError)} (retry after: ${firstError instanceof Error ? firstError.message : String(firstError)})`
        );
        if (originChat) {
          try {
            await this.options.bus.send({
              session: seq.session,
              comm: originChat.comm,
              target: originChat,
              payload: {
                text: `\u26A0\uFE0F Couldn't post question ${nextIndex + 1}/${seq.questions.length} \u2014 answer the remaining questions locally; this sequence is cancelled.`,
                format: "plain"
              },
              idempotencyKey: `query-seq-fail:${seq.session}:${nextIndex}:${Date.now()}`
            });
          } catch {
          }
        }
      }
    }
  }
  async handleCommCallback(comm, event) {
    const parsed = parseCallbackData(event.data);
    if (!parsed) {
      if (comm.answerCallback) {
        await comm.answerCallback(event.callback_id, {
          text: "Unrecognized button payload"
        });
      }
      return;
    }
    const openQuery = await this.options.storage.getOpenQueryById(parsed.queryId);
    if (!openQuery || openQuery.agent !== this.agentId) {
      return;
    }
    const chat = {
      comm: comm.id,
      account: "",
      chat_native_id: event.chat_native_id
    };
    const outcome = await this.options.bus.resolveQueryFromCallback({
      queryId: parsed.queryId,
      value: parsed.value,
      fromId: event.from_id,
      chat
    });
    if (!comm.answerCallback) return;
    switch (outcome.kind) {
      case "resolved": {
        const text = ackTextFor(outcome.decision);
        await comm.answerCallback(event.callback_id, { text });
        if (comm.editMessage) {
          try {
            await comm.editMessage(
              event.chat_native_id,
              event.message_native_id,
              `\u2713 Resolved via Telegram (${text}).`
            );
          } catch {
          }
        }
        return;
      }
      case "awaiting_freetext":
        await comm.answerCallback(event.callback_id, {
          text: "Now send your custom reply as a message.",
          showAlert: true
        });
        if (comm.editMessage) {
          try {
            await comm.editMessage(
              event.chat_native_id,
              event.message_native_id,
              "\u{1F4AC} Awaiting your custom reply\u2026 (send any text in this chat)."
            );
          } catch {
          }
        }
        return;
      case "already_resolved":
        await comm.answerCallback(event.callback_id, {
          text: "Already resolved.",
          showAlert: false
        });
        return;
      case "expired":
        await comm.answerCallback(event.callback_id, {
          text: "This prompt expired before you answered.",
          showAlert: true
        });
        return;
      case "unknown_query":
        await comm.answerCallback(event.callback_id, {
          text: "Unknown query."
        });
        return;
      case "invalid_value":
        await comm.answerCallback(event.callback_id, {
          text: `Unrecognized value: ${outcome.value}`
        });
        return;
    }
  }
  async chatRefForConversation(conversation) {
    if (conversation.bot_user_id) {
      return {
        comm: conversation.comm,
        account: conversation.bot_user_id,
        chat_native_id: conversation.chat_native_id,
        thread_native_id: conversation.thread_native_id ?? void 0
      };
    }
    const registrations = await this.options.storage.listAccountRegistrations({
      project: conversation.project,
      comm: conversation.comm,
      agent: conversation.agent
    });
    const registration = registrations.find(
      (candidate) => candidate.registration_id === conversation.registration_id
    );
    if (!registration) return void 0;
    return {
      comm: conversation.comm,
      account: registration.bot_user_id,
      chat_native_id: conversation.chat_native_id,
      thread_native_id: conversation.thread_native_id ?? void 0
    };
  }
};
function accountKey(entry) {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}
function inlineKeyboardForQuery(queryId, kind, options) {
  if (kind === "approval") {
    return [
      [
        { text: "\u2705 Allow", callback_data: `q:${queryId}:y` },
        { text: "\u274C Deny", callback_data: `q:${queryId}:n` }
      ],
      [{ text: "\u{1F513} Always", callback_data: `q:${queryId}:a` }]
    ];
  }
  if (kind === "choice") {
    const rows = (options ?? []).map((label, index) => [
      {
        text: `${index + 1}. ${truncateButtonText(label)}`,
        callback_data: `q:${queryId}:${index + 1}`
      }
    ]);
    rows.push([
      { text: "\u{1F4AC} Other (type a reply)", callback_data: `q:${queryId}:other` }
    ]);
    return rows;
  }
  return void 0;
}
function truncateButtonText(label) {
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 48) return trimmed;
  return `${trimmed.slice(0, 47)}\u2026`;
}
function wakePayloadFromDecision(decision) {
  switch (decision.decision) {
    case "allow":
      return { response: "y", prompt_type: "permission" };
    case "deny":
      return { response: "n", prompt_type: "permission" };
    case "always_allow":
      return { response: "a", prompt_type: "permission" };
    case "select_option": {
      const idx = decision.selected_option_index;
      if (typeof idx !== "number") return null;
      return { response: String(idx + 1), prompt_type: "question" };
    }
    case "text":
      if (!decision.text) return null;
      return { response: decision.text, prompt_type: "freetext" };
    default:
      return null;
  }
}
function parseCallbackData(data) {
  if (!data.startsWith("q:")) return null;
  const rest = data.slice(2);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const queryId = rest.slice(0, sep);
  const value = rest.slice(sep + 1);
  if (!queryId || !value) return null;
  return { queryId, value };
}
function ackTextFor(decision) {
  switch (decision.decision) {
    case "allow":
      return "Allowed";
    case "deny":
      return "Denied";
    case "always_allow":
      return "Always allowed";
    case "select_option":
      return `Selected option ${typeof decision.selected_option_index === "number" ? decision.selected_option_index + 1 : "?"}`;
    case "text":
      return "Reply received";
    default:
      return "Recorded";
  }
}
function hookResponseForUnresolvedClaudeQuery(params) {
  if (params.tool_name === "AskUserQuestion") {
    return { decision: { behavior: "allow" } };
  }
  return { decision: { behavior: "ask" } };
}
function requiredString(paramsValue, name) {
  if (typeof paramsValue !== "string" || paramsValue.length === 0) {
    throw new Error(`${name} is required`);
  }
  return paramsValue;
}
function recordOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function parseNormalizedQuestions(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed = [];
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry;
    if (typeof record.question !== "string" || !Array.isArray(record.options)) return null;
    const options = [];
    for (const opt of record.options) {
      if (!opt || typeof opt !== "object" || Array.isArray(opt)) return null;
      const optRecord = opt;
      if (typeof optRecord.label !== "string") return null;
      options.push({
        label: optRecord.label,
        description: typeof optRecord.description === "string" ? optRecord.description : void 0
      });
    }
    parsed.push({
      question: record.question,
      header: typeof record.header === "string" ? record.header : void 0,
      multiSelect: Boolean(record.multiSelect),
      options
    });
  }
  return parsed.length > 0 ? parsed : null;
}
function questionOptionsFromNormalized(q) {
  return q.options.map((option) => {
    const description = option.description ? ` - ${option.description}` : "";
    return `${option.label}${description}`;
  });
}
function formatQuestionPrompt(q, index, total) {
  let message = `\u2753 <b>Question ${index + 1}/${total}:</b> ${escapeHtml(q.question)}
`;
  const options = q.options;
  for (let i = 0; i < options.length; i += 1) {
    const opt = options[i];
    message += `
<b>${i + 1}.</b> ${escapeHtml(opt.label)}`;
    if (opt.description) {
      message += `
    <i>${escapeHtml(opt.description)}</i>`;
    }
  }
  message += `
<b>${options.length + 1}.</b> Other (custom text)`;
  if (q.multiSelect) {
    message += `

<i>(Multi-select: reply with comma-separated numbers)</i>`;
  }
  message += `

Reply with <b>number</b> to select`;
  return message;
}
function sessionLeaseOwnerFromParams(params) {
  const pid = numberParam(params.owner_process_pid);
  if (!pid) return void 0;
  return {
    process_pid: pid,
    process_label: typeof params.owner_process_label === "string" ? params.owner_process_label : "claude"
  };
}
function numberParam(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
var ClaudeBridgeFactory = class {
  agentId = "claude";
  create(context) {
    return new ClaudeBridge({
      storage: context.storage,
      bus: context.bus,
      audit: context.audit,
      pendingInbound: context.pendingInbound,
      ensureCommsForSession: context.ensureCommsForSession,
      daemonOwner: context.daemonOwner,
      sessionOwnerIsLive: context.sessionOwnerIsLive
    });
  }
};

// ../core-daemon/bridges/codex/bridge.ts
import crypto5 from "node:crypto";

// ../core-daemon/bridges/codex/adapter.ts
import crypto4 from "node:crypto";

// ../core-daemon/bridges/codex/app-server.ts
var DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:4500";
var CLIENT_INFO = {
  name: "agents-comm-bus-codex-bridge",
  version: "0.1.0"
};
var WebSocketCodexAppServerClient = class {
  constructor(url = DEFAULT_CODEX_APP_SERVER_URL) {
    this.url = url;
  }
  url;
  call(method, params, options = {}) {
    return callOnce(this.url, method, params, options);
  }
  listLoadedThreads() {
    return this.call("thread/loaded/list", {});
  }
  listThreadTurns(threadId) {
    return this.call("thread/turns/list", { threadId });
  }
  startTurn(threadId, text) {
    return this.call("turn/start", {
      threadId,
      input: [{ type: "text", text }]
    });
  }
  steerTurn(threadId, text, expectedTurnId) {
    return this.call("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text }]
    });
  }
  async wakeMostRecentThread(text = ".") {
    const thread = await this.mostRecentThread();
    if (!thread.ok) return thread;
    try {
      await this.startTurn(thread.threadId, text);
      return { ok: true, threadId: thread.threadId, method: "turn/start" };
    } catch (error) {
      return {
        ok: false,
        reason: "startTurn-failed",
        error: error instanceof Error ? error.message : String(error),
        threadId: thread.threadId
      };
    }
  }
  async steerMostRecentThread(text) {
    const thread = await this.mostRecentThread();
    if (!thread.ok) return thread;
    const turn = await this.activeTurn(thread.threadId);
    if (!turn.ok) return turn;
    try {
      await this.steerTurn(thread.threadId, text, turn.turnId);
      return { ok: true, threadId: thread.threadId, method: "turn/steer" };
    } catch (error) {
      return {
        ok: false,
        reason: "steerTurn-failed",
        error: error instanceof Error ? error.message : String(error),
        threadId: thread.threadId
      };
    }
  }
  async mostRecentThread() {
    let result;
    try {
      result = await this.listLoadedThreads();
    } catch (error) {
      return {
        ok: false,
        reason: "listLoadedThreads-failed",
        error: error instanceof Error ? error.message : String(error),
        url: this.url
      };
    }
    const threads = loadedThreads(result);
    if (threads.length === 0) {
      return {
        ok: false,
        reason: "no-threads-loaded",
        raw: stringifyShort(result)
      };
    }
    const target = [...threads].sort(compareThreadRecency)[0];
    const threadId = threadIdFrom(target);
    if (!threadId) {
      return {
        ok: false,
        reason: "no-thread-id-in-response",
        raw: stringifyShort(target)
      };
    }
    return { ok: true, threadId };
  }
  async activeTurn(threadId) {
    let result;
    try {
      result = await this.listThreadTurns(threadId);
    } catch (error) {
      return {
        ok: false,
        reason: "listThreadTurns-failed",
        error: error instanceof Error ? error.message : String(error),
        threadId,
        url: this.url
      };
    }
    const turns = listedTurns(result);
    if (turns.length === 0) {
      return {
        ok: false,
        reason: "no-turns-loaded",
        raw: stringifyShort(result),
        threadId
      };
    }
    const active = turns.find((turn) => turnStatus(turn) === "inProgress") ?? turns[0];
    const turnId = turnIdFrom(active);
    if (!turnId) {
      return {
        ok: false,
        reason: "no-turn-id-in-response",
        raw: stringifyShort(active),
        threadId
      };
    }
    return { ok: true, turnId };
  }
};
function callOnce(url, method, params, { timeoutMs = 5e3 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new wrapper_default(url);
    } catch (error) {
      reject(error);
      return;
    }
    const initId = 1;
    const callId = 2;
    let settled = false;
    let initialized = false;
    const timer = setTimeout(() => {
      finish(new Error(`app-server JSON-RPC timeout after ${timeoutMs}ms (method=${method}, url=${url})`));
    }, timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
      }
      if (error) reject(error);
      else resolve(value);
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }
      }));
    });
    ws.on("message", (data) => {
      const message = parseJsonMessage(data);
      if (!message) return;
      if (message.id === initId) {
        if (message.error) {
          finish(new Error(`app-server initialize failed: ${message.error.code} ${message.error.message ?? ""}`));
          return;
        }
        initialized = true;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }));
        return;
      }
      if (message.id === callId) {
        if (message.error) {
          finish(new Error(`app-server JSON-RPC error ${message.error.code}: ${message.error.message ?? ""}`));
        } else {
          finish(null, message.result);
        }
      }
    });
    ws.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    ws.on("close", () => {
      if (!settled) {
        finish(new Error(initialized ? "app-server connection closed after initialize but before reply" : "app-server connection closed before initialize completed"));
      }
    });
  });
}
function loadedThreads(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const record = result;
  const candidate = record.data ?? record.threads ?? record.items ?? record.loaded;
  return Array.isArray(candidate) ? candidate : [];
}
function listedTurns(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const record = result;
  const candidate = record.data ?? record.turns ?? record.items;
  return Array.isArray(candidate) ? candidate : [];
}
function compareThreadRecency(a, b) {
  if (typeof a === "string" || typeof b === "string") return 0;
  const left = Date.parse(String(a?.lastActiveAt ?? a?.updatedAt ?? a?.startedAt ?? 0)) || 0;
  const right = Date.parse(String(b?.lastActiveAt ?? b?.updatedAt ?? b?.startedAt ?? 0)) || 0;
  return right - left;
}
function threadIdFrom(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const record = value;
  const id = record.threadId ?? record.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
function turnIdFrom(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const record = value;
  const id = record.turnId ?? record.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
function turnStatus(value) {
  if (!value || typeof value !== "object") return null;
  const status = value.status;
  return typeof status === "string" ? status : null;
}
function parseJsonMessage(data) {
  try {
    const value = JSON.parse(data.toString());
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
function stringifyShort(value) {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

// ../core-daemon/bridges/codex/adapter.ts
var CodexAgentAdapter = class {
  constructor(options = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 300;
    this.defaultAppServerUrl = options.defaultAppServerUrl ?? DEFAULT_CODEX_APP_SERVER_URL;
    this.wakePlaceholder = options.wakePlaceholder ?? ".";
    this.queryIdFactory = options.queryIdFactory ?? (() => `codex:${crypto4.randomUUID()}`);
    this.appServerClientFactory = options.appServerClientFactory ?? ((url) => new WebSocketCodexAppServerClient(url));
  }
  options;
  id = "codex";
  capabilities = {
    canWake: true,
    canSteer: true,
    canInterrupt: false,
    midTurnPolicy: "steer",
    supportedQueryKinds: ["approval"]
  };
  sessions = /* @__PURE__ */ new Map();
  now;
  defaultTtlSeconds;
  defaultAppServerUrl;
  wakePlaceholder;
  queryIdFactory;
  appServerClientFactory;
  async connect(session, controlChannel) {
    const state = {
      controlChannel,
      queuedInbound: [],
      openQueries: /* @__PURE__ */ new Map()
    };
    this.sessions.set(session, state);
    controlChannel.onClose(() => {
      this.sessions.delete(session);
    });
    await controlChannel.send({
      type: "agent.connected",
      agent: this.id,
      session,
      capabilities: this.capabilities
    });
  }
  async disconnect(session) {
    this.sessions.delete(session);
  }
  setAppServerUrl(session, url) {
    const state = this.sessions.get(session);
    if (state && url) state.appServerUrl = url;
  }
  appServerUrlFor(session) {
    return this.sessions.get(session)?.appServerUrl ?? this.defaultAppServerUrl;
  }
  async deliverInbound(session, message) {
    const state = this.requireSession(session);
    state.queuedInbound.push(message);
    await state.controlChannel.send({
      type: "inbound.queued",
      agent: this.id,
      session,
      message,
      queueDepth: state.queuedInbound.length,
      midTurnPolicy: this.capabilities.midTurnPolicy
    });
  }
  async openQuery(session, query, queryChannel) {
    if (!this.supportsQueryKind(query.kind)) {
      throw new Error(`Codex adapter does not support query kind: ${query.kind}`);
    }
    const state = this.requireSession(session);
    state.openQueries.set(query.query_id, queryChannel);
    queryChannel.onClose(() => {
      state.openQueries.delete(query.query_id);
    });
    await queryChannel.send({
      type: "query.opened",
      agent: this.id,
      session,
      query
    });
    await state.controlChannel.send({
      type: "query.opened",
      agent: this.id,
      session,
      query_id: query.query_id,
      kind: query.kind
    });
  }
  async wake(session) {
    const result = await this.clientFor(session).wakeMostRecentThread(this.wakePlaceholder);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.wake",
      agent: this.id,
      session,
      result
    });
    throwIfTurnFailed(result);
  }
  async wakeOrSteer(session, payload) {
    const client = this.clientFor(session);
    const text = steerText(payload);
    const steerResult = await client.steerMostRecentThread(text);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.steer",
      agent: this.id,
      session,
      result: steerResult
    });
    if (steerResult.ok) return steerResult;
    const wakeResult = await client.wakeMostRecentThread(text);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.wake",
      agent: this.id,
      session,
      result: wakeResult,
      fallback_from: steerResult
    });
    throwIfTurnFailed(wakeResult);
    return wakeResult.ok ? { ...wakeResult, fallbackFrom: steerResult } : wakeResult;
  }
  async steer(session, payload) {
    const text = steerText(payload);
    const result = await this.clientFor(session).steerMostRecentThread(text);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.steer",
      agent: this.id,
      session,
      result
    });
    throwIfTurnFailed(result);
  }
  async interrupt(_session) {
    throw new Error("Codex adapter does not support interrupt");
  }
  drainQueuedInbound(session) {
    const state = this.requireSession(session);
    const drained = [...state.queuedInbound];
    state.queuedInbound.length = 0;
    return drained;
  }
  mapHookPayloadToQuery(session, payload) {
    return mapCodexHookPayloadToQuery(session, payload, {
      agent: this.id,
      now: this.now,
      ttlSeconds: this.defaultTtlSeconds,
      queryId: this.queryIdFactory(payload)
    });
  }
  supportsQueryKind(kind) {
    return this.capabilities.supportedQueryKinds.includes(kind);
  }
  clientFor(session) {
    const url = this.sessions.get(session)?.appServerUrl ?? this.defaultAppServerUrl;
    return this.appServerClientFactory(url);
  }
  requireSession(session) {
    const state = this.sessions.get(session);
    if (!state) throw new Error(`Codex session is not connected: ${session}`);
    return state;
  }
};
function mapCodexHookPayloadToQuery(session, payload, options = {}) {
  const agent = options.agent ?? "codex";
  const now = options.now ?? Date.now;
  const toolName = payload.tool_name ?? "PermissionRequest";
  const query = {
    schema_version: SCHEMA_VERSION_QUERY,
    query_id: options.queryId ?? `codex:${crypto4.randomUUID()}`,
    agent,
    session,
    kind: "approval",
    prompt_text: formatCodexPermissionPrompt(toolName, payload.tool_input),
    created_at: now(),
    ttl_seconds: options.ttlSeconds ?? 300
  };
  return {
    query,
    metadata: {
      hook_event_name: payload.hook_event_name,
      tool_name: toolName,
      prompt_type: "permission",
      codex_session_id: payload.session_id
    }
  };
}
function codexDecisionFromResolution(resolution) {
  if (!resolution) {
    return codexHookDecision("deny", "Telegram approval timed out");
  }
  if (resolution.decision === "allow" || resolution.decision === "always_allow") {
    return codexHookDecision("allow");
  }
  return codexHookDecision("deny", `Denied via Telegram (${resolution.decision})`);
}
function codexHookDecision(behavior, message) {
  const decision = { behavior };
  if (message) decision.message = message;
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision
    }
  };
}
function formatCodexPermissionPrompt(toolName, toolInput) {
  const input = recordOrEmpty2(toolInput);
  if (toolName === "Bash" && typeof input.command === "string") {
    return `Codex requests permission to run Bash: ${input.command}`;
  }
  if (typeof input.file_path === "string") {
    return `Codex requests permission to use ${toolName} on ${input.file_path}`;
  }
  return `Codex requests permission to use ${toolName}.`;
}
function steerText(payload) {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && typeof payload.text === "string") {
    return payload.text;
  }
  return JSON.stringify(payload);
}
function throwIfTurnFailed(result) {
  if (!result.ok) {
    throw new Error(`Codex app-server turn control failed: ${result.reason}${result.error ? `: ${result.error}` : ""}`);
  }
}
function recordOrEmpty2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// ../core-daemon/bridges/codex/app-server-lifecycle.ts
import { execFileSync } from "node:child_process";
import { readFile as readFile6, writeFile as writeFile3 } from "node:fs/promises";
import os5 from "node:os";
import path5 from "node:path";
var DEFAULT_STOPPED_BY = "codex-bridge-lease-release";
async function cleanupManagedCodexAppServer(session, options = {}) {
  const statePath = managedCodexAppServerStatePath(session, options.stateRoot);
  const state = await readManagedAppServerState(statePath);
  if (!state) {
    return { ok: false, statePath, reason: "state file not found" };
  }
  if (state.sessionId && state.sessionId !== session) {
    return { ok: false, statePath, reason: "state file session mismatch" };
  }
  const processManager = options.processManager ?? defaultProcessManager;
  const result = { ok: true, statePath };
  if (state.appServerPid && await isTrackedAppServer(processManager, state)) {
    if (await killTree(processManager, state.appServerPid)) {
      result.appServerStopped = state.appServerPid;
    }
  }
  if (state.appServerTerminalPid && await isTrackedAppServerTerminal(processManager, state)) {
    if (await processManager.kill(state.appServerTerminalPid)) {
      result.terminalStopped = state.appServerTerminalPid;
    }
  }
  state.stoppedAt = (options.now ?? (() => /* @__PURE__ */ new Date()))().toISOString();
  state.stoppedBy = DEFAULT_STOPPED_BY;
  await writeFile3(statePath, JSON.stringify(state, null, 2), "utf8");
  return result;
}
async function killTree(processManager, pid) {
  const descendants = processManager.descendants ? await processManager.descendants(pid) : [];
  for (const childPid of descendants.reverse()) {
    await processManager.kill(childPid);
  }
  return processManager.kill(pid);
}
function managedCodexAppServerStatePath(session, stateRoot2 = path5.join(os5.homedir(), ".agents-comm-bus", "codex-bootstrapper")) {
  return path5.join(stateRoot2, "sessions", `${session}.json`);
}
async function readManagedAppServerState(statePath) {
  try {
    return JSON.parse(await readFile6(statePath, "utf8"));
  } catch {
    return null;
  }
}
async function isTrackedAppServer(processManager, state) {
  if (!state.appServerPid || !state.appServerUrl) return false;
  const commandLine = await processManager.commandLine(state.appServerPid);
  return commandLine != null && /\bapp-server\b/i.test(commandLine) && /(^|\s)--listen(\s|$)/i.test(commandLine) && commandLine.includes(state.appServerUrl);
}
async function isTrackedAppServerTerminal(processManager, state) {
  if (!state.appServerTerminalPid || !state.wrapperPath) return false;
  const commandLine = await processManager.commandLine(state.appServerTerminalPid);
  return commandLine != null && /\b(powershell|pwsh|cmd)(\.exe)?\b/i.test(commandLine) && commandLine.includes(state.wrapperPath);
}
var defaultProcessManager = {
  async commandLine(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === "win32") {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
        "if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }"
      ].join("; ");
      try {
        const output = execFileSync(
          "powershell.exe",
          ["-NoProfile", "-Command", script],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        return output.trim() || null;
      } catch {
        return null;
      }
    }
    try {
      const output = execFileSync(
        "ps",
        ["-p", String(pid), "-o", "command="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      return output.trim() || null;
    } catch {
      return null;
    }
  },
  async descendants(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return [];
    if (process.platform === "win32") {
      const script = `
function Get-Children([int]$ParentPid) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentPid" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    [int]$child.ProcessId
    Get-Children -ParentPid ([int]$child.ProcessId)
  }
}
Get-Children -ParentPid ${pid}
`;
      try {
        const output = execFileSync(
          "powershell.exe",
          ["-NoProfile", "-Command", script],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        return output.split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((value) => Number.isInteger(value) && value > 0);
      } catch {
        return [];
      }
    }
    try {
      const output = execFileSync(
        "pgrep",
        ["-P", String(pid)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      return output.split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((value) => Number.isInteger(value) && value > 0);
    } catch {
      return [];
    }
  },
  async kill(pid) {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
};

// ../core-daemon/bridges/codex/bridge.ts
var DEFAULT_TTL_SECONDS2 = 3600;
var DEFAULT_QUERY_POLL_TIMEOUT_MS = 9 * 60 * 1e3;
var DEFAULT_APP_SERVER_CLEANUP_DELAY_MS = 3e3;
var DEFAULT_SESSION_OWNER_CHECK_INTERVAL_MS = 1e4;
var CODEX_IPC_METHODS = /* @__PURE__ */ new Set([
  "codex_bootstrap_status",
  "codex_register_session",
  "codex_drain_inbound",
  "codex_open_query",
  "codex_turn_control"
]);
var CodexBridge = class {
  constructor(options) {
    this.options = options;
    this.sessionOwnerIsLive = options.sessionOwnerIsLive ?? createSessionOwnerLiveness();
    this.adapter = new CodexAgentAdapter({
      defaultAppServerUrl: options.defaultAppServerUrl ?? process.env.CODEX_APP_SERVER_URL,
      appServerClientFactory: options.appServerClientFactory
    });
  }
  options;
  agentId = "codex";
  ipcMethods = CODEX_IPC_METHODS;
  adapter;
  waiters = /* @__PURE__ */ new Map();
  sessionRoutes = /* @__PURE__ */ new Map();
  activeLeases = /* @__PURE__ */ new Map();
  ownedAccountsCache = null;
  ownerCheckTimer = null;
  /** AGE-36: scheduled / in-flight managed app-server cleanup counters. */
  pendingManagedCleanups = 0;
  inFlightManagedCleanups = 0;
  sessionOwnerIsLive;
  attach(comms) {
    this.options.bus.setResolveSink({
      onResolved: async (query, decision) => {
        if (query.agent !== this.agentId) return;
        this.waiters.get(query.query_id)?.(decision);
      }
    });
    for (const comm of comms) {
      this.attachComm(comm);
    }
  }
  attachComm(comm) {
    if (typeof comm.onCallback === "function") {
      comm.onCallback(async (event) => {
        await this.handleCommCallback(comm, event);
      });
    }
  }
  detachComm(_commId, _accountId) {
  }
  invalidateRegistrationCaches() {
    this.ownedAccountsCache = null;
  }
  getRetirementBlockers() {
    const blockers = {};
    const managedLifecycle = [...this.activeLeases.values()].some(
      (lease) => !lease.released && lease.manageAppServerLifecycle
    );
    if (this.waiters.size > 0) blockers.open_queries = this.waiters.size;
    if (managedLifecycle) blockers.managed_lifecycle = 1;
    if (this.pendingManagedCleanups > 0 || this.inFlightManagedCleanups > 0) {
      blockers.pending_managed_cleanup = 1;
    }
    return Object.keys(blockers).length > 0 ? blockers : null;
  }
  async onInboundConversation(conversation) {
    if (conversation.agent !== this.agentId) return;
    const session = await this.resolveSessionForConversation(conversation);
    if (!session) {
      await this.auditWake("agent_wake_skipped", conversation, void 0, {
        reason: "no_codex_session_for_project"
      });
      return;
    }
    const pendingForSession = await this.pendingInboundForConversation(
      conversation,
      session
    );
    const mostRecentConversationId = pendingForSession.at(-1)?.conversation.conversation_id ?? conversation.conversation_id;
    await this.options.storage.setSessionMostRecentInbound(session, mostRecentConversationId);
    await this.auditWake("agent_wake_attempt", conversation, session, {
      app_server_url: this.adapter.appServerUrlFor(session),
      pending_count: pendingForSession.length,
      pending_message_ids: pendingForSession.map((entry) => entry.message.message_id),
      pending_conversation_ids: [...new Set(pendingForSession.map((entry) => entry.conversation.conversation_id))]
    });
    try {
      const result = await this.adapter.wakeOrSteer(
        session,
        formatInboundMessagesForTurn(pendingForSession)
      );
      if (result.ok) {
        await this.auditWake("agent_wake_succeeded", conversation, session, {
          app_server_url: this.adapter.appServerUrlFor(session),
          method: result.method,
          thread_id: result.threadId,
          fallback_reason: result.fallbackFrom?.reason,
          fallback_error: result.fallbackFrom?.error,
          fallback_thread_id: result.fallbackFrom?.threadId,
          pending_count: pendingForSession.length,
          removed_pending_count: pendingForSession.length
        });
        await this.removePendingInbound(session, pendingForSession);
      }
    } catch (error) {
      await this.auditWake("agent_wake_failed", conversation, session, {
        app_server_url: this.adapter.appServerUrlFor(session),
        pending_count: pendingForSession.length,
        error: error instanceof Error ? error.message : String(error)
      });
      console.error(
        `agents-comm-bus: failed to wake Codex for ${conversation.conversation_id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async handleIpcMethod(method, params, ctx) {
    switch (method) {
      case "codex_bootstrap_status":
        return this.bootstrapStatus(params);
      case "codex_register_session":
        return this.registerSession(params, ctx.socket);
      case "codex_drain_inbound":
        return this.drainInbound(params);
      case "codex_open_query":
        return this.openQuery(params);
      case "codex_turn_control":
        return this.turnControl(params);
      default:
        throw new Error(`CodexBridge does not handle IPC method: ${method}`);
    }
  }
  async bootstrapStatus(params) {
    const project = normalizeProjectPath(requiredString2(params.project, "project"));
    const accountLabelScope = accountLabelScopeFromParams(params);
    const [registrations, sessions] = await Promise.all([
      this.options.storage.listAccountRegistrations({
        project,
        agent: this.agentId
      }),
      this.options.storage.listSessions({
        project,
        agent: this.agentId,
        status: "active"
      })
    ]);
    const scopedRegistrations = filterRegistrationsForSession(
      registrations,
      {
        // SessionStart runs before registration and may not have a managed
        // session id yet. Use a non-persisted identity so every live session
        // remains a sibling candidate for precedence.
        session_id: "__codex_bootstrap_status__",
        project,
        agent: this.agentId,
        account_label_scope: accountLabelScope,
        status: "active",
        lease_holder_connection_id: null,
        lease_owner_process_pid: null,
        lease_owner_process_registered_at: null
      },
      sessions,
      this.sessionOwnerIsLive
    );
    const hasAppServerUrl = typeof params.app_server_url === "string" && params.app_server_url.trim().length > 0;
    const hasManagedSession = typeof params.managed_session_id === "string" && params.managed_session_id.trim().length > 0;
    const managedAppServerPresent = hasAppServerUrl && hasManagedSession && params.app_server_reachable === true;
    const hasAccountRegistration = scopedRegistrations.length > 0;
    const bootstrapRequired = hasAccountRegistration && !managedAppServerPresent;
    return {
      ok: true,
      has_account_registration: hasAccountRegistration,
      registration_count: scopedRegistrations.length,
      managed_app_server_present: managedAppServerPresent,
      bootstrap_required: bootstrapRequired,
      reason: !hasAccountRegistration ? "no codex comm account registration for project" : managedAppServerPresent ? "codex session already has a reachable managed app-server url" : "codex comm account registration exists but no managed app-server url is present"
    };
  }
  async registerSession(params, socket) {
    const session = requiredString2(params.session, "session");
    const project = normalizeProjectPath(requiredString2(params.project, "project"));
    const connectionId = typeof params.connection_id === "string" ? params.connection_id : `codex:${session}:${crypto5.randomUUID()}`;
    const now = Date.now();
    const accountLabelScope = accountLabelScopeFromParams(params);
    await this.options.storage.upsertSession({
      schema_version: SCHEMA_VERSION_SESSION,
      session_id: session,
      agent: this.agentId,
      project,
      created_at: now,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: null,
      lease_owner_process_label: null,
      lease_owner_process_registered_at: null,
      lease_owner_daemon_discovery_root: null,
      lease_owner_daemon_checkout_root: null,
      lease_owner_daemon_state_root: null,
      lease_owner_daemon_bin: null,
      lease_owner_daemon_authority_rank: null,
      most_recent_inbound_conversation_id: null,
      account_label_scope: accountLabelScope,
      status: "active"
    });
    const baselineSession = await this.options.storage.getSession(session);
    const deliverabilityBaseline = baselineSession ? this.isLocallyDeliverable(baselineSession) : false;
    const replaceExistingLease = params.replace_existing_lease === true || params.persist_after_disconnect === true;
    const leaseOwner = this.options.daemonOwner ? sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams2(params, "codex"), this.options.daemonOwner) : sessionLeaseOwnerFromParams2(params, "codex");
    let acquired = await this.options.storage.acquireSessionLease(
      session,
      connectionId,
      now,
      leaseOwner
    );
    if (!acquired) {
      const releasedDeadLease = await this.releaseDeadSameProjectLease(project, now);
      if (releasedDeadLease) {
        acquired = await this.options.storage.acquireSessionLease(
          session,
          connectionId,
          now,
          leaseOwner
        );
      }
    }
    if (!acquired) {
      const existing = await this.options.storage.getSession(session);
      if (existing?.lease_holder_connection_id && replaceExistingLease) {
        await this.options.storage.releaseSessionLease(
          session,
          existing.lease_holder_connection_id,
          now
        );
        const reacquired = await this.options.storage.acquireSessionLease(
          session,
          connectionId,
          now,
          leaseOwner
        );
        if (!reacquired) {
          await this.ensureCommsBestEffort(project, accountLabelScope);
          return { ok: false, reason: "same-project codex session lease already held" };
        }
      } else if (existing?.lease_holder_connection_id) {
        await this.ensureCommsBestEffort(project, accountLabelScope);
        return {
          ok: true,
          reason: "codex session lease already held; registration refreshed",
          capabilities: this.adapter.capabilities
        };
      } else {
        await this.ensureCommsBestEffort(project, accountLabelScope);
        return { ok: false, reason: "same-project codex session lease already held" };
      }
    }
    const control = new BridgeControlChannel();
    await this.adapter.connect(session, control);
    if (typeof params.app_server_url === "string") {
      this.adapter.setAppServerUrl(session, params.app_server_url);
    }
    this.trackSession(project, session, accountLabelScope);
    const rehydrated = await this.ensureCommsBestEffort(project, accountLabelScope);
    const afterSession = await this.options.storage.getSession(session);
    const deliverabilityAfter = afterSession ? this.isLocallyDeliverable(afterSession) : false;
    if (!deliverabilityBaseline && deliverabilityAfter && rehydrated) {
      await this.redrivePendingInbound(session);
    }
    const persistAfterDisconnect = params.persist_after_disconnect === true;
    const manageAppServerLifecycle = params.manage_app_server_lifecycle === true || params.source === "mcp-server";
    const lease = {
      session,
      project,
      connectionId,
      manageAppServerLifecycle,
      control,
      released: false
    };
    this.activeLeases.set(session, lease);
    this.ensureOwnerCheckTimer();
    const release = () => {
      if (persistAfterDisconnect) return;
      void this.releaseSessionLease(lease);
    };
    socket?.once("close", release);
    return { ok: true, capabilities: this.adapter.capabilities };
  }
  async drainInbound(params) {
    const session = typeof params.session === "string" ? params.session : void 0;
    const owned = await this.ownedAccountKeys(session);
    const drained = this.options.pendingInbound.filter(
      (entry) => owned.has(accountKey2(entry))
    );
    if (drained.length > 0) {
      await removePendingInboundEntries(
        this.options.storage,
        this.options.pendingInbound,
        drained
      );
    }
    if (session && drained.length > 0) {
      await this.options.storage.setSessionMostRecentInbound(
        session,
        drained[drained.length - 1].conversation.conversation_id
      );
    }
    return drained;
  }
  async openQuery(params) {
    const session = requiredString2(params.session, "session");
    const queryInput = recordOrEmpty3(params.query);
    const promptText = requiredString2(
      params.prompt_text ?? queryInput.prompt_text,
      "prompt_text"
    );
    const queryId = `q_${crypto5.randomUUID()}`;
    const sessionRecord = await this.options.storage.getSession(session);
    const conversation = sessionRecord?.most_recent_inbound_conversation_id ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id) : null;
    const originChat = conversation ? await this.chatRefForConversation(conversation) : void 0;
    if (!originChat) {
      const hookResponse = codexHookDecision(
        "deny",
        `No recent inbound comm conversation is associated with Codex session ${session}.`
      );
      return {
        query_id: queryId,
        hook_response: hookResponse,
        hookJson: hookResponse,
        nativeHookJson: hookResponse
      };
    }
    const query = {
      schema_version: 1,
      query_id: queryId,
      agent: this.agentId,
      session,
      kind: "approval",
      prompt_text: promptText,
      origin_chat: originChat,
      created_at: Date.now(),
      ttl_seconds: typeof params.ttl_seconds === "number" ? params.ttl_seconds : DEFAULT_TTL_SECONDS2
    };
    const supersede = params.supersede !== false;
    if (supersede) {
      await this.options.storage.supersedeOpenQueriesForSession(session, Date.now());
    }
    const resolutionPromise = this.waitForResolution(queryId, query.ttl_seconds);
    try {
      await this.options.bus.openQuery(query);
      const promptFormat = params.prompt_format ?? queryInput.prompt_format;
      const promptMessageId = await this.options.bus.send({
        session,
        comm: originChat.comm,
        target: originChat,
        payload: {
          text: promptText,
          format: promptFormat === "html" ? "html" : "plain",
          inline_keyboard: inlineKeyboardForQuery2(queryId)
        },
        idempotencyKey: `query:${queryId}`
      });
      try {
        await this.options.storage.setQuerySourceMessage(queryId, promptMessageId);
      } catch (error) {
        console.error(
          `agents-comm-bus: failed to record prompt message id for ${queryId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const decision = await resolutionPromise;
      const hookResponse = codexDecisionFromResolution(decision);
      return {
        query_id: queryId,
        hook_response: hookResponse,
        hookJson: hookResponse,
        nativeHookJson: hookResponse
      };
    } catch (error) {
      this.clearWaiter(queryId);
      throw error;
    }
  }
  async turnControl(params) {
    const session = requiredString2(params.session, "session");
    const kind = params.kind === "steer" ? "steer" : params.kind === "interrupt" ? "interrupt" : "start";
    if (typeof params.app_server_url === "string") {
      this.adapter.setAppServerUrl(session, params.app_server_url);
    }
    if (kind === "start") {
      await this.adapter.wake(session);
      return { ok: true, method: "turn/start" };
    }
    if (kind === "steer") {
      await this.adapter.steer(session, params.payload ?? params.text ?? "");
      return { ok: true, method: "turn/steer" };
    }
    await this.adapter.interrupt(session);
    return { ok: true, method: "turn/interrupt" };
  }
  async handleCommCallback(comm, event) {
    const parsed = parseCallbackData2(event.data);
    if (!parsed) return;
    const openQuery = await this.options.storage.getOpenQueryById(parsed.queryId);
    if (!openQuery || openQuery.agent !== this.agentId) {
      return;
    }
    const chat = {
      comm: comm.id,
      account: "",
      chat_native_id: event.chat_native_id
    };
    const outcome = await this.options.bus.resolveQueryFromCallback({
      queryId: parsed.queryId,
      value: parsed.value,
      fromId: event.from_id,
      chat
    });
    if (!comm.answerCallback) return;
    if (outcome.kind === "resolved") {
      await comm.answerCallback(event.callback_id, { text: ackTextFor2(outcome.decision) });
      if (comm.editMessage) {
        try {
          await comm.editMessage(
            event.chat_native_id,
            event.message_native_id,
            `Resolved via Telegram (${ackTextFor2(outcome.decision)}).`
          );
        } catch {
        }
      }
      return;
    }
    if (outcome.kind === "already_resolved") {
      await comm.answerCallback(event.callback_id, { text: "Already resolved." });
      return;
    }
    if (outcome.kind === "invalid_value") {
      await comm.answerCallback(event.callback_id, { text: `Unrecognized value: ${outcome.value}` });
      return;
    }
    await comm.answerCallback(event.callback_id, { text: outcome.kind });
  }
  waitForResolution(queryId, ttlSeconds) {
    const timeoutMs = Math.min(
      this.options.queryPollTimeoutMs ?? DEFAULT_QUERY_POLL_TIMEOUT_MS,
      Math.max(1, ttlSeconds) * 1e3
    );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.clearWaiter(queryId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(queryId, (decision) => {
        clearTimeout(timer);
        this.clearWaiter(queryId);
        resolve(decision);
      });
    });
  }
  clearWaiter(queryId) {
    this.waiters.delete(queryId);
  }
  async ensureCommsBestEffort(project, accountLabelScope) {
    const hook = this.options.ensureCommsForSession;
    if (!hook) return false;
    try {
      const result = await hook(project, this.agentId, {
        accountLabelScope: accountLabelScope ?? null
      });
      return result.rehydrated;
    } catch (error) {
      console.error(
        `agents-comm-bus: ensureCommsForSession failed for ${project}/${this.agentId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }
  /** AGE-91: daemon-local route = a tracked app-server route for this session. */
  routeReady(sessionId) {
    return this.sessionRoutes.has(sessionId);
  }
  isLocallyDeliverable(session) {
    return isSessionLocallyDeliverable(
      session,
      this.routeReady(session.session_id),
      this.sessionOwnerIsLive
    );
  }
  /**
   * AGE-90: after a deliverability edge with confirmed rehydration, wake once
   * via the newest in-scope pending row. `pendingInboundForConversation`
   * aggregates every owned-account entry in the project for one steer attempt.
   */
  async redrivePendingInbound(sessionId) {
    const sess = await this.options.storage.getSession(sessionId);
    if (!sess) return;
    const [registrations, sessions] = await Promise.all([
      this.options.storage.listAccountRegistrations({
        project: sess.project,
        agent: this.agentId
      }),
      this.options.storage.listSessions({
        project: sess.project,
        agent: this.agentId,
        status: "active"
      })
    ]);
    const scopedRegs = filterRegistrationsForSession(
      registrations,
      sess,
      sessions,
      this.sessionOwnerIsLive
    );
    const ownedKeys = new Set(
      scopedRegs.map((reg) => `${reg.comm}:${reg.bot_user_id}`)
    );
    const inScope = this.options.pendingInbound.filter((entry) => {
      if (entry.conversation.project !== sess.project) return false;
      if (entry.conversation.agent !== this.agentId) return false;
      if (!ownedKeys.has(accountKey2(entry))) return false;
      return sessionOwnsConversation(
        sess,
        sessions,
        entry.conversation,
        this.sessionOwnerIsLive
      );
    });
    if (inScope.length === 0) return;
    const seed = inScope.reduce(
      (latest, entry) => entry.message.received_at > latest.message.received_at ? entry : latest
    );
    await this.onInboundConversation(seed.conversation);
  }
  trackSession(project, session, accountLabelScope) {
    this.sessionRoutes.set(session, {
      project,
      account_label_scope: accountLabelScope
    });
  }
  untrackSession(project, session) {
    const route = this.sessionRoutes.get(session);
    if (!route || route.project !== project) return;
    this.sessionRoutes.delete(session);
  }
  async resolveSessionForConversation(conversation) {
    const project = normalizeProjectPath(conversation.project);
    const inMemory = [...this.sessionRoutes.entries()].filter(([, route]) => route.project === project).map(([sessionId, route]) => ({
      session_id: sessionId,
      project: route.project,
      agent: this.agentId,
      account_label_scope: route.account_label_scope
    }));
    const fromMemory = resolveSessionForConversation(
      inMemory,
      conversation,
      (sess) => sess.session_id
    );
    if (fromMemory) return fromMemory.session_id;
    const sessions = await this.options.storage.listSessions({
      project,
      agent: this.agentId,
      status: "active"
    });
    const live = sessions.filter((sess) => sess.lease_holder_connection_id != null);
    const pool = live.length > 0 ? live : sessions;
    const hydrated = resolveSessionForConversation(pool, conversation, (sess) => sess.session_id);
    if (!hydrated) return void 0;
    this.trackSession(project, hydrated.session_id, hydrated.account_label_scope);
    return hydrated.session_id;
  }
  async releaseSessionLease(input) {
    if (input.released) return;
    input.released = true;
    try {
      this.untrackSession(input.project, input.session);
      const active = this.activeLeases.get(input.session);
      if (active?.connectionId === input.connectionId) {
        this.activeLeases.delete(input.session);
      }
      await this.adapter.disconnect(input.session);
      if (input.manageAppServerLifecycle) {
        await this.options.storage.releaseSessionConnectionLeasePreservingOwner(
          input.session,
          input.connectionId,
          Date.now()
        );
      } else {
        await this.options.storage.releaseSessionLease(input.session, input.connectionId, Date.now());
      }
      input.control.close();
      if (input.manageAppServerLifecycle) {
        this.scheduleManagedAppServerCleanup(input.session);
      }
      this.stopOwnerCheckTimerIfIdle();
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to release Codex session ${input.session}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  ensureOwnerCheckTimer() {
    if (this.ownerCheckTimer || this.activeLeases.size === 0) return;
    const interval = this.options.sessionOwnerCheckIntervalMs ?? DEFAULT_SESSION_OWNER_CHECK_INTERVAL_MS;
    this.ownerCheckTimer = setInterval(() => {
      void this.releaseLeasesWithDeadOwners();
    }, interval);
    this.ownerCheckTimer.unref?.();
  }
  stopOwnerCheckTimerIfIdle() {
    if (!this.ownerCheckTimer || this.activeLeases.size > 0) return;
    clearInterval(this.ownerCheckTimer);
    this.ownerCheckTimer = null;
  }
  async releaseLeasesWithDeadOwners() {
    for (const lease of [...this.activeLeases.values()]) {
      const record = await this.options.storage.getSession(lease.session);
      if (record?.lease_holder_connection_id !== lease.connectionId) continue;
      const ownerPid = record.lease_owner_process_pid;
      if (!ownerPid) continue;
      const isAlive = this.options.isProcessAlive ?? isPidAlive;
      if (isAlive(ownerPid)) continue;
      await this.releaseSessionLease(lease);
    }
  }
  async releaseDeadSameProjectLease(project, at) {
    const isAlive = this.options.isProcessAlive ?? isPidAlive;
    const sessions = await this.options.storage.listSessions({
      project,
      agent: this.agentId,
      status: "active"
    });
    let released = false;
    for (const session of sessions) {
      const connectionId = session.lease_holder_connection_id;
      const ownerPid = session.lease_owner_process_pid;
      if (!connectionId || !ownerPid || isAlive(ownerPid)) continue;
      await this.options.storage.releaseSessionLease(session.session_id, connectionId, at);
      released = true;
    }
    return released;
  }
  scheduleManagedAppServerCleanup(session) {
    const delay = this.options.appServerCleanupDelayMs ?? DEFAULT_APP_SERVER_CLEANUP_DELAY_MS;
    this.pendingManagedCleanups += 1;
    const setTimeoutFn = this.options.setTimeoutFn ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
    setTimeoutFn(() => {
      this.pendingManagedCleanups -= 1;
      this.inFlightManagedCleanups += 1;
      void this.cleanupManagedAppServerIfLeaseIsIdle(session).finally(() => {
        this.inFlightManagedCleanups -= 1;
      });
    }, delay);
  }
  async cleanupManagedAppServerIfLeaseIsIdle(session) {
    try {
      const record = await this.options.storage.getSession(session);
      if (record?.lease_holder_connection_id) return;
      const result = await cleanupManagedCodexAppServer(session);
      if (!result.ok) return;
      const latest = await this.options.storage.getSession(session);
      if (!latest || latest.status !== "active" || latest.lease_holder_connection_id) {
        return;
      }
      await this.options.storage.endSessionIfUnchanged(
        session,
        sessionEndObservation(latest),
        Date.now()
      );
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to cleanup Codex app-server for ${session}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async chatRefForConversation(conversation) {
    if (conversation.bot_user_id) {
      return {
        comm: conversation.comm,
        account: conversation.bot_user_id,
        chat_native_id: conversation.chat_native_id,
        thread_native_id: conversation.thread_native_id ?? void 0
      };
    }
    const registrations = await this.options.storage.listAccountRegistrations({
      project: conversation.project,
      comm: conversation.comm,
      agent: conversation.agent
    });
    const registration = registrations.find(
      (candidate) => candidate.registration_id === conversation.registration_id
    );
    if (!registration) return void 0;
    return {
      comm: conversation.comm,
      account: registration.bot_user_id,
      chat_native_id: conversation.chat_native_id,
      thread_native_id: conversation.thread_native_id ?? void 0
    };
  }
  async auditWake(kind, conversation, session, detail) {
    try {
      await this.options.audit?.append({
        timestamp: Date.now(),
        kind,
        agent: this.agentId,
        session,
        conversation_id: conversation.conversation_id,
        detail: {
          comm: conversation.comm,
          account_label: conversation.account_label,
          chat_native_id: conversation.chat_native_id,
          thread_native_id: conversation.thread_native_id ?? void 0,
          project: conversation.project,
          ...detail
        }
      });
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to audit Codex wake event for ${conversation.conversation_id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async pendingInboundForConversation(conversation, session) {
    const owned = await this.ownedAccountKeys(session);
    return this.options.pendingInbound.filter(
      (entry) => owned.has(accountKey2(entry)) && entry.conversation.project === conversation.project
    );
  }
  /**
   * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. See
   * the matching comment in `ClaudeBridge` for the caching contract.
   */
  async ownedAccountKeys(session) {
    if (session) {
      const sess = await this.options.storage.getSession(session);
      if (!sess) return /* @__PURE__ */ new Set();
      const [registrations2, sessions] = await Promise.all([
        this.options.storage.listAccountRegistrations({
          project: sess.project,
          agent: this.agentId
        }),
        this.options.storage.listSessions({
          project: sess.project,
          agent: this.agentId,
          status: "active"
        })
      ]);
      const scoped = filterRegistrationsForSession(
        registrations2,
        sess,
        sessions,
        this.sessionOwnerIsLive
      );
      return new Set(scoped.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
    }
    if (this.ownedAccountsCache) return this.ownedAccountsCache;
    const registrations = await this.options.storage.listAccountRegistrations({
      agent: this.agentId
    });
    this.ownedAccountsCache = new Set(
      registrations.map((reg) => `${reg.comm}:${reg.bot_user_id}`)
    );
    return this.ownedAccountsCache;
  }
  async removePendingInbound(session, entries) {
    if (entries.length === 0) return;
    const owned = await this.ownedAccountKeys(session);
    const scoped = entries.filter((entry) => owned.has(accountKey2(entry)));
    await removePendingInboundEntries(
      this.options.storage,
      this.options.pendingInbound,
      scoped
    );
  }
};
function accountKey2(entry) {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}
function formatInboundMessagesForTurn(entries) {
  if (entries.length === 0) {
    return "Check for pending daemon-delivered messages and handle them if present.";
  }
  const lines = entries.map((entry) => {
    const message = entry.message;
    const conversation = entry.conversation;
    const sender = message.sender.display_name ?? message.sender.id ?? "unknown sender";
    const textParts = [];
    if (message.text) textParts.push(message.text);
    for (const attachment of message.attachments ?? []) {
      textParts.push(formatAttachmentForCodex(attachment));
    }
    const text = textParts.join(" ").trim() || "[no text]";
    const envelope = [
      `comm=${conversation.comm}`,
      // `account` is the concrete bot_user_id — the routing key to echo back on
      // sends (AGE-15). account_label is human metadata only and must NOT be
      // used as a send target; surfacing the label here previously taught the
      // agent to route by it, which cross-resolved to the other agent's bot.
      `account=${message.chat.account}`,
      `account_label=${conversation.account_label}`,
      `chat_native_id=${conversation.chat_native_id}`,
      conversation.thread_native_id ? `thread_native_id=${conversation.thread_native_id}` : null,
      `conversation_id=${conversation.conversation_id}`,
      message.platform_message_id ? `platform_message_id=${message.platform_message_id}` : null,
      `message_id=${message.message_id}`
    ].filter(Boolean).join(" ");
    return `[${new Date(message.received_at).toISOString()}] ${sender} (${envelope}): ${text}`;
  });
  return [
    inboundInstructionFor(entries),
    "[Daemon Inbound Messages]",
    ...lines,
    "[End Daemon Inbound Messages]"
  ].join("\n");
}
function inboundInstructionFor(entries) {
  const comms = [...new Set(entries.map((entry) => entry.conversation.comm))];
  if (comms.length === 1) {
    const commName = displayCommName(comms[0]);
    return `Process these daemon-delivered ${commName} messages as user input. If a reply is requested, use the ${commName} MCP tool.`;
  }
  return "Process these daemon-delivered messages as user input. If a reply is requested, use the MCP tool matching each message's comm value.";
}
function displayCommName(comm) {
  switch (comm) {
    case "discord":
      return "Discord";
    case "matrix":
      return "Matrix";
    case "telegram":
      return "Telegram";
    default:
      return String(comm);
  }
}
function formatAttachmentForCodex(attachment) {
  const fields = [
    attachment.local_path ? `path=${JSON.stringify(attachment.local_path)}` : null,
    attachment.filename ? `filename=${JSON.stringify(attachment.filename)}` : null,
    attachment.mime ? `mime=${JSON.stringify(attachment.mime)}` : null,
    typeof attachment.size === "number" ? `size=${attachment.size}` : null,
    attachment.blob_hash ? `blob_hash=${attachment.blob_hash}` : null
  ].filter(Boolean);
  return `[Attachment: ${fields.join(" ") || "attachment"}]`;
}
function inlineKeyboardForQuery2(queryId) {
  return [
    [
      { text: "Allow", callback_data: `q:${queryId}:y` },
      { text: "Deny", callback_data: `q:${queryId}:n` }
    ],
    [{ text: "Always", callback_data: `q:${queryId}:a` }]
  ];
}
function parseCallbackData2(data) {
  if (!data.startsWith("q:")) return null;
  const rest = data.slice(2);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const queryId = rest.slice(0, sep);
  const value = rest.slice(sep + 1);
  if (!queryId || !value) return null;
  return { queryId, value };
}
function ackTextFor2(decision) {
  switch (decision.decision) {
    case "allow":
      return "Allowed";
    case "always_allow":
      return "Allowed";
    case "deny":
      return "Denied";
    default:
      return "Recorded";
  }
}
function requiredString2(paramsValue, name) {
  if (typeof paramsValue !== "string" || paramsValue.length === 0) {
    throw new Error(`${name} is required`);
  }
  return paramsValue;
}
function recordOrEmpty3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function sessionLeaseOwnerFromParams2(params, fallbackLabel) {
  const pid = numberParam2(params.owner_process_pid);
  if (!pid) return void 0;
  return {
    process_pid: pid,
    process_label: typeof params.owner_process_label === "string" ? params.owner_process_label : fallbackLabel
  };
}
function numberParam2(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
var BridgeControlChannel = class {
  closeHandler = null;
  onClose(handler) {
    this.closeHandler = handler;
  }
  async send(_envelope) {
  }
  close() {
    this.closeHandler?.();
  }
};
var CodexBridgeFactory = class {
  agentId = "codex";
  create(context) {
    return new CodexBridge({
      storage: context.storage,
      bus: context.bus,
      audit: context.audit,
      pendingInbound: context.pendingInbound,
      ensureCommsForSession: context.ensureCommsForSession,
      daemonOwner: context.daemonOwner,
      sessionOwnerIsLive: context.sessionOwnerIsLive
    });
  }
};

// ../core-daemon/bridges/pi/bridge.ts
var PI_IPC_METHODS = /* @__PURE__ */ new Set([
  "pi_register_session",
  "pi_drain_inbound",
  "pi_unregister_session"
]);
var PiBridge = class {
  constructor(options) {
    this.options = options;
    this.sessionOwnerIsLive = options.sessionOwnerIsLive ?? createSessionOwnerLiveness();
  }
  options;
  agentId = "pi";
  ipcMethods = PI_IPC_METHODS;
  sessionOwnerIsLive;
  attach(_comms) {
  }
  async handleIpcMethod(method, params, ctx) {
    switch (method) {
      case "pi_register_session":
        return this.registerSession(params, ctx.socket);
      case "pi_drain_inbound":
        return this.drainInbound(params);
      case "pi_unregister_session":
        return this.unregisterSession(params);
      default:
        throw new Error(`PiBridge does not handle IPC method: ${method}`);
    }
  }
  async ensureCommsBestEffort(project, accountLabelScope) {
    try {
      await this.options.ensureCommsForSession?.(project, this.agentId, {
        accountLabelScope: accountLabelScope ?? null
      });
    } catch (error) {
      console.error(
        `agents-comm-bus: ensureCommsForSession failed for ${project}/${this.agentId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async ownedAccountKeys(session) {
    if (session) {
      const sess = await this.options.storage.getSession(session);
      if (!sess) return /* @__PURE__ */ new Set();
      const [registrations2, sessions] = await Promise.all([
        this.options.storage.listAccountRegistrations({
          project: sess.project,
          agent: this.agentId
        }),
        this.options.storage.listSessions({
          project: sess.project,
          agent: this.agentId,
          status: "active"
        })
      ]);
      const scoped = filterRegistrationsForSession(
        registrations2,
        sess,
        sessions,
        this.sessionOwnerIsLive
      );
      return new Set(scoped.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
    }
    const registrations = await this.options.storage.listAccountRegistrations({
      agent: this.agentId
    });
    return new Set(registrations.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
  }
  assertCallerProjectMatchesStored(session, storedProject, params) {
    if (typeof params.project !== "string" || params.project.length === 0) return;
    const callerProject = normalizeProjectPath(params.project);
    if (callerProject !== storedProject) {
      throw new Error(
        `project mismatch for session ${session}: caller ${callerProject} != stored ${storedProject}`
      );
    }
  }
  async registerSession(params, socket) {
    const session = requiredString3(params.session, "session");
    const project = normalizeProjectPath(requiredString3(params.project, "project"));
    const connectionId = requiredString3(params.connection_id, "connection_id");
    const now = Date.now();
    const accountLabelScope = accountLabelScopeFromParams(params);
    await this.options.storage.upsertSession({
      schema_version: SCHEMA_VERSION_SESSION,
      session_id: session,
      agent: "pi",
      project,
      created_at: now,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: null,
      lease_owner_process_label: null,
      lease_owner_process_registered_at: null,
      lease_owner_daemon_discovery_root: null,
      lease_owner_daemon_checkout_root: null,
      lease_owner_daemon_state_root: null,
      lease_owner_daemon_bin: null,
      lease_owner_daemon_authority_rank: null,
      most_recent_inbound_conversation_id: null,
      account_label_scope: accountLabelScope,
      status: "active"
    });
    const leaseOwner = this.options.daemonOwner ? sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams3(params), this.options.daemonOwner) : sessionLeaseOwnerFromParams3(params);
    const acquired = await this.options.storage.acquireSessionLease(
      session,
      connectionId,
      now,
      leaseOwner
    );
    if (!acquired) {
      await this.ensureCommsBestEffort(project, accountLabelScope);
      return { ok: false, reason: "pi session lease already held" };
    }
    socket?.once("close", () => {
      void this.options.storage.releaseSessionConnectionLeasePreservingOwner(
        session,
        connectionId,
        Date.now()
      );
    });
    await this.ensureCommsBestEffort(project, accountLabelScope);
    return { ok: true, session, project, agent: "pi" };
  }
  /**
   * AGE-91: Pi is route-ready by construction once a session is registered.
   *
   * This is NOT a stub. Pi has no wake route and no `onInboundConversation`
   * because its delivery is **pull-based**: the extension polls
   * `pi_drain_inbound` with its own session id, so the drain IS the delivery.
   * There is no daemon-local route object to check, and reporting `false`
   * would wrongly tell a caller that a live, polling Pi session cannot be
   * reached. Do not "fix" this by inventing a route check.
   */
  routeReady(_session) {
    return true;
  }
  async drainInbound(params) {
    const session = requiredString3(params.session, "session");
    const sess = await this.options.storage.getSession(session);
    if (!sess) return { messages: [] };
    this.assertCallerProjectMatchesStored(session, sess.project, params);
    const owned = await this.ownedAccountKeys(session);
    const commFilter = typeof params.comm === "string" && params.comm.length > 0 ? params.comm : null;
    const limit = typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0 ? params.limit : null;
    const drained = [];
    for (const entry of this.options.pendingInbound) {
      if (!owned.has(accountKey3(entry))) continue;
      if (commFilter && entry.message.chat.comm !== commFilter) continue;
      drained.push(entry);
      if (limit !== null && drained.length >= limit) break;
    }
    if (drained.length > 0) {
      await removePendingInboundEntries(
        this.options.storage,
        this.options.pendingInbound,
        drained
      );
      await this.options.storage.setSessionMostRecentInbound(
        session,
        drained[drained.length - 1].conversation.conversation_id
      );
    }
    return { messages: drained };
  }
  async unregisterSession(params) {
    const session = requiredString3(params.session, "session");
    const connectionId = requiredString3(params.connection_id, "connection_id");
    const sess = await this.options.storage.getSession(session);
    if (!sess) return { ok: true };
    this.assertCallerProjectMatchesStored(session, sess.project, params);
    if (sess.lease_holder_connection_id != null && sess.lease_holder_connection_id !== connectionId) {
      return { ok: true };
    }
    await this.options.storage.endSessionIfUnchanged(
      session,
      sessionEndObservation(sess),
      Date.now()
    );
    return { ok: true };
  }
};
function accountKey3(entry) {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}
function requiredString3(paramsValue, name) {
  if (typeof paramsValue !== "string" || paramsValue.length === 0) {
    throw new Error(`${name} is required`);
  }
  return paramsValue;
}
function sessionLeaseOwnerFromParams3(params) {
  const host = params.host && typeof params.host === "object" && !Array.isArray(params.host) ? params.host : null;
  const pid = numberParam3(host?.pid ?? params.owner_process_pid);
  if (!pid) return void 0;
  const label = typeof host?.label === "string" ? host.label : typeof params.owner_process_label === "string" ? params.owner_process_label : "pi";
  return {
    process_pid: pid,
    process_label: label
  };
}
function numberParam3(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
var PiBridgeFactory = class {
  agentId = "pi";
  create(context) {
    return new PiBridge({
      storage: context.storage,
      bus: context.bus,
      audit: context.audit,
      pendingInbound: context.pendingInbound,
      ensureCommsForSession: context.ensureCommsForSession,
      daemonOwner: context.daemonOwner,
      sessionOwnerIsLive: context.sessionOwnerIsLive
    });
  }
};

// ../core-daemon/runtime/comm-adapter-loader.ts
import { readdir, stat as stat4 } from "node:fs/promises";
import path6 from "node:path";
import { pathToFileURL } from "node:url";
function defaultOnError({ modulePath, error }) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agents-comm-bus] comm adapter not loaded (${modulePath}): ${message}`);
}
async function loadCommAdapterFactories(options) {
  const onError = options.onError ?? defaultOnError;
  let entries;
  try {
    entries = await readdir(options.adaptersDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const factories = [];
  let resolved = 0;
  for (const entry of entries.sort()) {
    const modulePath = await resolveAdapterModulePath(options.adaptersDir, entry);
    if (!modulePath) continue;
    resolved += 1;
    try {
      factories.push(await loadCommAdapterFactory(modulePath));
    } catch (error) {
      onError({ modulePath, error });
    }
  }
  if (resolved > 0 && factories.length === 0) {
    onError({
      modulePath: options.adaptersDir,
      error: new Error(
        `no comm adapters loaded: ${resolved} present but all failed \u2014 daemon starting with no comm channels`
      )
    });
  }
  return factories;
}
async function resolveAdapterModulePath(adaptersDir, entry) {
  const entryPath = path6.join(adaptersDir, entry);
  if (entry.endsWith(".js")) return entryPath;
  try {
    if (!(await stat4(entryPath)).isDirectory()) return null;
  } catch {
    return null;
  }
  const factoryPath = path6.join(entryPath, "factory.js");
  try {
    if ((await stat4(factoryPath)).isFile()) return factoryPath;
  } catch {
    return null;
  }
  return null;
}
async function loadCommAdapterFactory(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.createCommAdapterFactory !== "function") {
    throw new Error(
      `comm adapter bundle ${modulePath} must export createCommAdapterFactory()`
    );
  }
  const factory = mod.createCommAdapterFactory();
  assertCommAdapterFactory(modulePath, factory);
  return factory;
}
function assertCommAdapterFactory(modulePath, value) {
  if (!value || typeof value !== "object") {
    throw new Error(`comm adapter bundle ${modulePath} did not return a factory object`);
  }
  const factory = value;
  if (typeof factory.commId !== "string" || factory.commId.length === 0) {
    throw new Error(`comm adapter bundle ${modulePath} returned a factory without commId`);
  }
  if (typeof factory.resolveCredentials !== "function") {
    throw new Error(`comm adapter bundle ${modulePath} returned a factory without resolveCredentials`);
  }
  if (typeof factory.create !== "function") {
    throw new Error(`comm adapter bundle ${modulePath} returned a factory without create`);
  }
}

// ../core-daemon/serve.ts
async function startConfiguredDaemon() {
  process.title = `${DAEMON_NAME} daemon`;
  const paths = resolveStatePaths({ stateRoot: process.env.AGENTS_COMM_BUS_STATE_ROOT });
  const adaptersDir = resolveAdaptersDir(paths.root, process.env);
  const commAdapterFactories = await loadCommAdapterFactories({ adaptersDir });
  await runDaemon({
    commAdapterFactories,
    adaptersDir,
    loadCommAdapterFactories: () => loadCommAdapterFactories({ adaptersDir }),
    agentBridgeFactories: [
      new ClaudeBridgeFactory(),
      new CodexBridgeFactory(),
      new PiBridgeFactory()
    ]
  });
}
function resolveAdaptersDir(stateRoot2, env) {
  if (env.AGENTS_COMM_BUS_ADAPTERS_DIR) {
    return path7.resolve(env.AGENTS_COMM_BUS_ADAPTERS_DIR);
  }
  if (env.AGENTS_COMM_BUS_BIN) {
    return path7.resolve(path7.dirname(env.AGENTS_COMM_BUS_BIN), "..", "adapters");
  }
  return path7.join(stateRoot2, "adapters");
}
if (process.argv[1] && import.meta.url === pathToFileURL2(process.argv[1]).href) {
  startConfiguredDaemon().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
export {
  startConfiguredDaemon
};
