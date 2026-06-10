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
    var { randomBytes: randomBytes2, createHash: createHash3 } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
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
      const key = randomBytes2(16).toString("base64");
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
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
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
          ws.once("open", function open4() {
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
          ws.once("open", function open4() {
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
    var { createHash: createHash3 } = __require("crypto");
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
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
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

// ../core-daemon/cli/account-add.ts
import { randomBytes } from "node:crypto";
import { mkdir as mkdir7 } from "node:fs/promises";

// ../packages/core-contracts/dist/types.js
var SCHEMA_VERSION_ACCOUNT = 1;

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
import { createHash } from "node:crypto";

// ../core-daemon/config.ts
var DAEMON_NAME = "agents-comm-bus";
var DAEMON_VERSION = "0.2.20";
var IPC_PROTOCOL_VERSION = "1.2.0";
var IPC_HOST = "127.0.0.1";

// ../core-daemon/paths.ts
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
function resolveDiscoveryPaths(options = {}) {
  const root = discoveryRoot(options);
  return {
    root,
    pidFile: path2.join(root, "daemon.pid"),
    portFile: path2.join(root, "port"),
    spawnLock: path2.join(root, ".spawn.lock")
  };
}
function resolveTokenFilePath(options) {
  const paths = resolveStatePaths(options);
  const project = path2.resolve(options.project);
  const projectBase = safePathSegment(path2.basename(project) || "project");
  const projectHash = createHash("sha256").update(project).digest("hex").slice(0, 12);
  return path2.join(
    paths.tokensDir,
    safePathSegment(options.comm),
    `${projectBase}-${projectHash}`,
    safePathSegment(options.agent),
    `${safePathSegment(options.accountId)}.json`
  );
}
function safePathSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

// ../core-daemon/storage/sqlite.ts
import { createRequire } from "node:module";

// ../core-daemon/storage/schema/runner.ts
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
var schemaDir = dirname(fileURLToPath(import.meta.url));
var initialMigration = {
  version: 1,
  description: "initial storage schema",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "001_initial.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var conversationAgentIdentityMigration = {
  version: 2,
  description: "include agent in conversation identity",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "002_conversation_agent_identity.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var allowlistMigration = {
  version: 3,
  description: "add allowlist_global and allowlist_per_bot tables",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "003_allowlist.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var sessionOwnerProcessMigration = {
  version: 4,
  description: "track owning agent process for session leases",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "004_session_owner_process.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var conversationBotIdentityMigration = {
  version: 5,
  description: "store receiving bot identity on conversations",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "005_conversation_bot_identity.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var registrationIdentityMigration = {
  version: 6,
  description: "add immutable registration_id surrogate to registrations + conversations",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "006_registration_identity.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var registrationPkMigration = {
  version: 7,
  description: "make registration_id the canonical primary key of account_registrations",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "007_registration_pk.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var conversationRegistrationKeyMigration = {
  version: 8,
  description: "re-key conversations on (registration_id, chat, thread) + drop account_label",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "008_conversation_registration_key.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var multiOpenQueriesMigration = {
  version: 9,
  description: "AGE-9: drop the one-open-query-per-session unique index (policy moves to callers)",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "009_multi_open_queries.sql"), "utf8");
    await ctx.exec(sql);
  }
};
var durablePendingInboundMigration = {
  version: 10,
  description: "AGE-56: durable pending inbound delivery rows",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "010_durable_pending_inbound.sql"), "utf8");
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
    durablePendingInboundMigration
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
  static async open(path14) {
    const db = new DatabaseSync(path14);
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
          most_recent_inbound_conversation_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          agent = excluded.agent,
          project = excluded.project,
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
      rec.most_recent_inbound_conversation_id,
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
              lease_owner_process_pid = ?,
              lease_owner_process_label = ?,
              lease_owner_process_registered_at = ?
          WHERE session_id = ?
            AND (lease_holder_connection_id IS NULL OR lease_holder_connection_id = ?)
        `).run(
        connection_id,
        at,
        owner?.process_pid ?? null,
        owner?.process_label ?? null,
        owner?.process_pid ? at : null,
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
            lease_owner_process_registered_at = NULL
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
      most_recent_inbound_conversation_id: r.most_recent_inbound_conversation_id,
      status: r.status
    };
  }
};
async function openSqliteStorage(path14) {
  return SqliteStorage.open(path14);
}
function isConstraintError(error) {
  const sqliteError = error;
  return sqliteError.code === "SQLITE_CONSTRAINT" || sqliteError.code === "ERR_SQLITE_CONSTRAINT" || sqliteError.code === "ERR_SQLITE_ERROR" && sqliteError.errcode === 2067 || sqliteError.errstr === "constraint failed";
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

// ../core-daemon/ipc/client.ts
async function connectIpc(options) {
  const host = options.host ?? IPC_HOST;
  const timeoutMs = options.timeoutMs ?? 1e3;
  const socket = new wrapper_default(`ws://${host}:${options.port}`);
  const hello = await new Promise((resolve3, reject) => {
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
        resolve3(message);
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
    request: (method, params) => sendRequest(socket, createRequest(method, params)),
    close: () => socket.close()
  };
}
async function sendRequest(socket, request) {
  socket.send(JSON.stringify(request));
  return new Promise((resolve3, reject) => {
    const onMessage = (data) => {
      try {
        const message = parseIpcMessage(data);
        if (message.type !== IPC_MESSAGE_TYPES.response || message.id !== request.id) {
          return;
        }
        socket.off("message", onMessage);
        const response = message;
        if (!response.ok) {
          reject(new Error(response.error ?? "agents-comm-bus request failed"));
          return;
        }
        resolve3(response.result);
      } catch (error) {
        socket.off("message", onMessage);
        reject(error);
      }
    };
    socket.on("message", onMessage);
  });
}

// ../hosts/common/install/entry-ensures.js
import { existsSync as existsSync4 } from "node:fs";
import path11 from "node:path";

// dist/core-daemon/bootstrap/ensure-daemon.js
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir as mkdir3, readFile as readFile3, rm as rm2, writeFile } from "node:fs/promises";
import path5 from "node:path";

// dist/core-daemon/storage/audit.js
import { mkdir } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";

// dist/core-daemon/storage/jsonl.js
import { open } from "node:fs/promises";
async function appendJsonLine(path14, value) {
  const handle = await open(path14, "a");
  try {
    await handle.writeFile(`${JSON.stringify(value)}
`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// dist/core-daemon/storage/audit.js
function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}
var JsonlAuditStore = class {
  root;
  constructor(root) {
    this.root = root;
  }
  async append(event) {
    const path14 = this.pathFor(event.timestamp);
    await mkdir(dirname2(path14), { recursive: true });
    await appendJsonLine(path14, event);
  }
  pathFor(timestamp) {
    return join2(this.root, "audit", `${utcDay(timestamp)}.jsonl`);
  }
};

// dist/core-daemon/config.js
var DAEMON_NAME2 = "agents-comm-bus";
var DAEMON_VERSION2 = "0.2.20";
var IPC_PROTOCOL_VERSION2 = "1.2.0";
var IPC_HOST2 = "127.0.0.1";
var DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5e3;
var DEFAULT_BOOTSTRAP_RETRY_MS = 50;
var DEFAULT_SPAWN_LOCK_STALE_GRACE_MS = 2e3;
function protocolMajor(version) {
  return version.split(".", 1)[0] ?? version;
}
function isProtocolCompatible2(daemonProtocolVersion, clientProtocolVersion) {
  return protocolMajor(daemonProtocolVersion) === protocolMajor(clientProtocolVersion);
}

// dist/core-daemon/paths.js
import os2 from "node:os";
import path3 from "node:path";
function stateRoot2(options = {}) {
  return path3.resolve(options.stateRoot ?? path3.join(options.homeDir ?? os2.homedir(), `.${DAEMON_NAME2}`));
}
function resolveStatePaths2(options = {}) {
  const root = stateRoot2(options);
  const database = path3.join(root, `${DAEMON_NAME2}.db`);
  return {
    root,
    database,
    databaseWal: `${database}-wal`,
    databaseShm: `${database}-shm`,
    auditDir: path3.join(root, "audit"),
    chatsDir: path3.join(root, "chats"),
    tokensDir: path3.join(root, "tokens"),
    pidFile: path3.join(root, "daemon.pid"),
    portFile: path3.join(root, "port"),
    spawnLock: path3.join(root, ".spawn.lock")
  };
}
function discoveryRoot2(options = {}) {
  return path3.resolve(options.discoveryRoot ?? stateRoot2(options));
}
function resolveDiscoveryPaths2(options = {}) {
  const root = discoveryRoot2(options);
  return {
    root,
    pidFile: path3.join(root, "daemon.pid"),
    portFile: path3.join(root, "port"),
    spawnLock: path3.join(root, ".spawn.lock")
  };
}

// dist/core-daemon/ipc/protocol.js
var IPC_MESSAGE_TYPES2 = {
  clientHello: "client.hello",
  daemonHello: "daemon.hello",
  daemonError: "daemon.error",
  request: "request",
  response: "response"
};
function createClientHello2(input) {
  return {
    type: IPC_MESSAGE_TYPES2.clientHello,
    protocolVersion: input.protocolVersion ?? IPC_PROTOCOL_VERSION2,
    clientVersion: input.clientVersion,
    metadata: {
      pid: process.pid,
      cwd: process.cwd(),
      ...input.metadata
    }
  };
}
function parseIpcMessage2(data) {
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const parsed = JSON.parse(text);
  if (parsed.type !== IPC_MESSAGE_TYPES2.clientHello && parsed.type !== IPC_MESSAGE_TYPES2.daemonHello && parsed.type !== IPC_MESSAGE_TYPES2.daemonError && parsed.type !== IPC_MESSAGE_TYPES2.request && parsed.type !== IPC_MESSAGE_TYPES2.response) {
    throw new Error("Invalid agents-comm-bus IPC message type.");
  }
  return parsed;
}
function parseHandshakeMessage2(data) {
  const message = parseIpcMessage2(data);
  if (message.type !== IPC_MESSAGE_TYPES2.clientHello && message.type !== IPC_MESSAGE_TYPES2.daemonHello && message.type !== IPC_MESSAGE_TYPES2.daemonError) {
    throw new Error("Invalid agents-comm-bus IPC handshake message type.");
  }
  return message;
}
function createRequest2(method, params) {
  return {
    type: IPC_MESSAGE_TYPES2.request,
    id: cryptoRandomId2(),
    method,
    params
  };
}
function cryptoRandomId2() {
  return `ipc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// dist/core-daemon/ipc/client.js
async function connectIpc2(options) {
  const host = options.host ?? IPC_HOST2;
  const timeoutMs = options.timeoutMs ?? 1e3;
  const socket = new wrapper_default(`ws://${host}:${options.port}`);
  const hello = await new Promise((resolve3, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for agents-comm-bus IPC handshake on ${host}:${options.port}.`));
    }, timeoutMs);
    socket.once("open", () => {
      socket.send(JSON.stringify(createClientHello2({
        clientVersion: options.clientVersion,
        protocolVersion: options.protocolVersion ?? IPC_PROTOCOL_VERSION2,
        metadata: options.metadata
      })));
    });
    socket.once("message", (data) => {
      try {
        const message = parseHandshakeMessage2(data);
        if (message.type === IPC_MESSAGE_TYPES2.daemonError) {
          throw new Error(message.message);
        }
        if (message.type !== IPC_MESSAGE_TYPES2.daemonHello) {
          throw new Error("Expected agents-comm-bus daemon hello handshake.");
        }
        clearTimeout(timeout);
        resolve3(message);
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
    request: (method, params) => sendRequest2(socket, createRequest2(method, params)),
    close: () => socket.close()
  };
}
async function sendRequest2(socket, request) {
  socket.send(JSON.stringify(request));
  return new Promise((resolve3, reject) => {
    const onMessage = (data) => {
      try {
        const message = parseIpcMessage2(data);
        if (message.type !== IPC_MESSAGE_TYPES2.response || message.id !== request.id) {
          return;
        }
        socket.off("message", onMessage);
        const response = message;
        if (!response.ok) {
          reject(new Error(response.error ?? "agents-comm-bus request failed"));
          return;
        }
        resolve3(response.result);
      } catch (error) {
        socket.off("message", onMessage);
        reject(error);
      }
    };
    socket.on("message", onMessage);
  });
}

// dist/core-daemon/bootstrap/handshake.js
async function probeDaemon(options) {
  const connection = await connectIpc2({
    port: options.port,
    clientVersion: options.clientVersion ?? DAEMON_VERSION2,
    protocolVersion: options.protocolVersion ?? IPC_PROTOCOL_VERSION2,
    metadata: options.metadata,
    timeoutMs: options.timeoutMs
  });
  connection.close();
  return connection.hello;
}

// dist/core-daemon/bootstrap/spawn-lock.js
import { constants } from "node:fs";
import { open as open2, mkdir as mkdir2, readFile as readFile2, rm } from "node:fs/promises";
import path4 from "node:path";
function parseSpawnLockToken(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const parts = trimmed.split(":");
  if (parts.length !== 2) {
    return {};
  }
  const pid = Number(parts[0]);
  const timestamp = Number(parts[1]);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : void 0,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : void 0
  };
}
function isTokenContentStale(token, options) {
  const { pid, timestamp } = parseSpawnLockToken(token);
  if (pid === void 0 || timestamp === void 0) {
    return true;
  }
  if (!options.isPidAlive(pid)) {
    return true;
  }
  return Date.now() - timestamp > options.staleTimeoutMs;
}
async function removeSpawnLockIfTokenMatches(lockPath, expectedToken) {
  try {
    const current = await readFile2(lockPath, "utf8");
    if (current.trim() !== expectedToken) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
async function removeStaleSpawnLock(lockPath, options = {}) {
  const resolved = resolveSpawnLockOptions(options);
  let observedRaw;
  try {
    observedRaw = await readFile2(lockPath, "utf8");
  } catch {
    return false;
  }
  const observedToken = observedRaw.trim();
  if (!isTokenContentStale(observedToken, resolved)) {
    return false;
  }
  if (options.testHookAfterStaleCheck) {
    await options.testHookAfterStaleCheck();
  }
  return removeSpawnLockIfTokenMatches(lockPath, observedToken);
}
async function tryAcquireSpawnLock(lockPath, options = {}) {
  await mkdir2(path4.dirname(lockPath), { recursive: true });
  const acquired = await createSpawnLock(lockPath);
  if (acquired) {
    return acquired;
  }
  if (!await removeStaleSpawnLock(lockPath, options)) {
    return void 0;
  }
  return createSpawnLock(lockPath);
}
async function createSpawnLock(lockPath) {
  try {
    const handle = await open2(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    const token = `${process.pid}:${Date.now()}`;
    await handle.writeFile(`${token}
`, "utf8");
    await handle.close();
    return {
      path: lockPath,
      acquired: true,
      token,
      release: async () => {
        await removeSpawnLockIfTokenMatches(lockPath, token);
      }
    };
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return void 0;
    }
    throw error;
  }
}
function resolveSpawnLockOptions(options) {
  return {
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    staleTimeoutMs: options.staleTimeoutMs ?? defaultSpawnLockStaleTimeoutMs()
  };
}
function defaultSpawnLockStaleTimeoutMs(bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS) {
  return bootstrapTimeoutMs + DEFAULT_SPAWN_LOCK_STALE_GRACE_MS;
}
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function isAlreadyExistsError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

// dist/core-daemon/bootstrap/ensure-daemon.js
async function ensureDaemon(options = {}) {
  const env = options.env ?? process.env;
  const stateRoot3 = options.stateRoot ?? env.AGENTS_COMM_BUS_ROOT ?? env.AGENTS_COMM_BUS_STATE_ROOT;
  const paths = resolveStatePaths2({ stateRoot: stateRoot3 });
  const discoveryPaths = resolveDiscoveryPaths2({
    stateRoot: paths.root,
    discoveryRoot: options.discoveryRoot ?? env.AGENTS_COMM_BUS_DISCOVERY_ROOT
  });
  await mkdir3(paths.root, { recursive: true });
  await mkdir3(discoveryPaths.root, { recursive: true });
  warnIfSourceModeSharesDiscoveryRoot({
    stateRoot: paths.root,
    discoveryRoot: discoveryPaths.root,
    env,
    log: options.log ?? console.error
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_BOOTSTRAP_RETRY_MS;
  const clientProtocolVersion = options.protocolVersion ?? IPC_PROTOCOL_VERSION2;
  const deadline = Date.now() + timeoutMs;
  const probe = options.probeDaemon ?? ((port) => probeDaemon({
    port,
    clientVersion: options.clientVersion ?? DAEMON_VERSION2,
    protocolVersion: clientProtocolVersion,
    metadata: options.metadata,
    timeoutMs: Math.min(1e3, retryMs * 4)
  }));
  const existing = await probeFromPortFile(discoveryPaths.portFile, probe);
  if (existing) {
    const reuse = classifyDaemonReuse(existing.hello.protocolVersion, clientProtocolVersion);
    if (reuse === "compatible") {
      return { ...existing, spawned: false };
    }
    if (reuse === "daemon_newer") {
      throw new Error(`agents-comm-bus daemon protocol ${existing.hello.protocolVersion} is newer than this client's ${clientProtocolVersion}; restart this session to pick up the newer agent surface`);
    }
    await terminateMismatchedDaemon({
      paths: discoveryPaths,
      livePort: existing.port,
      liveProtocol: existing.hello.protocolVersion,
      clientProtocol: clientProtocolVersion,
      terminateDaemon: options.terminateDaemon ?? defaultTerminateDaemon,
      isPidAlive: options.isPidAlive ?? defaultIsPidAlive2,
      retryMs
    });
  }
  const afterTerminate = await probeFromPortFile(discoveryPaths.portFile, probe);
  if (afterTerminate && classifyDaemonReuse(afterTerminate.hello.protocolVersion, clientProtocolVersion) === "compatible") {
    return { ...afterTerminate, spawned: false };
  }
  await cleanupStalePidAndPort({
    stateRoot: paths.root,
    pidFile: discoveryPaths.pidFile,
    portFile: discoveryPaths.portFile,
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive2
  });
  let spawned = false;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive2;
  const spawnLockOptions = {
    isPidAlive,
    staleTimeoutMs: defaultSpawnLockStaleTimeoutMs(timeoutMs)
  };
  while (Date.now() <= deadline) {
    const lock = await tryAcquireSpawnLock(discoveryPaths.spawnLock, spawnLockOptions);
    if (lock) {
      try {
        const recheck = await probeFromPortFile(discoveryPaths.portFile, probe);
        if (recheck) {
          return { ...recheck, spawned };
        }
        if (options.spawnDaemon) {
          await options.spawnDaemon(paths, discoveryPaths);
        } else {
          defaultSpawnDaemon(paths, discoveryPaths, env);
        }
        spawned = true;
        const found2 = await waitForDaemon(discoveryPaths.portFile, probe, deadline, retryMs);
        if (found2) {
          return { ...found2, spawned: true };
        }
      } finally {
        await lock.release();
      }
    }
    const found = await waitForDaemon(discoveryPaths.portFile, probe, deadline, retryMs);
    if (found) {
      return { ...found, spawned };
    }
    await cleanupStalePidAndPort({
      stateRoot: paths.root,
      pidFile: discoveryPaths.pidFile,
      portFile: discoveryPaths.portFile,
      isPidAlive
    });
    await removeStaleSpawnLock(discoveryPaths.spawnLock, spawnLockOptions);
  }
  throw new Error(`Timed out starting agents-comm-bus daemon under ${discoveryPaths.root}.`);
}
function classifyDaemonReuse(daemonProtocol, clientProtocol) {
  if (isProtocolCompatible2(daemonProtocol, clientProtocol))
    return "compatible";
  return Number(protocolMajor(daemonProtocol)) > Number(protocolMajor(clientProtocol)) ? "daemon_newer" : "daemon_older";
}
async function terminateMismatchedDaemon(input) {
  const pid = await readPidFile(input.paths.pidFile);
  if (pid === void 0) {
    throw new Error(`agents-comm-bus daemon on port ${input.livePort} speaks incompatible IPC protocol ${input.liveProtocol} (client ${input.clientProtocol}); cannot restart because ${input.paths.pidFile} is missing`);
  }
  await input.terminateDaemon(pid);
  for (let attempt = 0; attempt < 20 && input.isPidAlive(pid); attempt += 1) {
    await sleep(input.retryMs);
  }
  if (input.isPidAlive(pid)) {
    throw new Error(`agents-comm-bus daemon pid ${pid} speaks incompatible IPC protocol ${input.liveProtocol} (client ${input.clientProtocol}); failed to terminate old daemon`);
  }
  await rm2(input.paths.pidFile, { force: true });
  await rm2(input.paths.portFile, { force: true });
}
async function probeFromPortFile(portFile, probe) {
  const port = await readPortFile(portFile);
  if (port === void 0) {
    return void 0;
  }
  try {
    return { port, hello: await probe(port) };
  } catch {
    await rm2(portFile, { force: true });
    return void 0;
  }
}
async function waitForDaemon(portFile, probe, deadline, retryMs) {
  while (Date.now() <= deadline) {
    const found = await probeFromPortFile(portFile, probe);
    if (found) {
      return found;
    }
    await sleep(retryMs);
  }
  return void 0;
}
function daemonStderrLogPath(stateRoot3) {
  return path5.join(stateRoot3, "daemon.stderr.log");
}
function daemonSpawnStdio(stateRoot3) {
  mkdirSync(stateRoot3, { recursive: true });
  const logFd = openSync(daemonStderrLogPath(stateRoot3), "a");
  return ["ignore", logFd, logFd];
}
async function cleanupStalePidAndPort(input) {
  const pid = await readPidFile(input.pidFile);
  if (pid !== void 0 && !input.isPidAlive(pid)) {
    await rm2(input.pidFile, { force: true });
    await rm2(input.portFile, { force: true });
    const audit = new JsonlAuditStore(input.stateRoot);
    await audit.append({
      timestamp: Date.now(),
      kind: "discovery_stale_cleanup",
      detail: { stale_pid: pid, pid_file: input.pidFile, port_file: input.portFile }
    }).catch(() => {
    });
  }
}
async function readPortFile(portFile) {
  try {
    const raw = (await readFile3(portFile, "utf8")).trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : void 0;
  } catch {
    return void 0;
  }
}
async function readPidFile(pidFile) {
  try {
    const raw = (await readFile3(pidFile, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : void 0;
  } catch {
    return void 0;
  }
}
function defaultIsPidAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function defaultTerminateDaemon(pid) {
  if (pid === process.pid) {
    throw new Error("refusing to terminate current process as daemon");
  }
  process.kill(pid, "SIGTERM");
}
function defaultSpawnDaemon(paths, discoveryPaths, env = process.env) {
  const binOverride = env.AGENTS_COMM_BUS_BIN;
  const daemonEntry = binOverride ? path5.resolve(binOverride) : path5.join(paths.root, "bin", "daemon.js");
  const stdio = daemonSpawnStdio(paths.root);
  const child = spawn(process.execPath, [daemonEntry, "serve"], {
    detached: true,
    stdio,
    env: {
      ...env,
      AGENTS_COMM_BUS_STATE_ROOT: paths.root,
      AGENTS_COMM_BUS_DISCOVERY_ROOT: discoveryPaths.root
    }
  });
  try {
    closeSync(stdio[1]);
  } catch {
  }
  child.unref();
}
function warnIfSourceModeSharesDiscoveryRoot(input) {
  if (!input.env.AGENTS_COMM_BUS_BIN)
    return;
  if (path5.resolve(input.stateRoot) !== path5.resolve(input.discoveryRoot))
    return;
  input.log("agents-comm-bus: source/dev daemon is sharing the production discovery root; set discoveryRoot in .agents-comm-bus-dev.json (for example .agents-comm-bus-discovery/) to let dev and prod daemons coexist.");
}
function sleep(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}

// ../hosts/common/install/ensure-central-install.js
import path9 from "node:path";
import { existsSync as existsSync2 } from "node:fs";
import { readFile as readFile6 } from "node:fs/promises";

// ../hosts/common/install/run-central-install.js
import path8 from "node:path";
import { existsSync } from "node:fs";

// ../hosts/common/install/reconcile-central-install.js
var VERSION_FILE_SCHEMA = 1;
function reconcileInstall(actor, state) {
  const daemon = reconcileArtifact("daemon", actor, state.daemonVersionFile, state.daemonExists, void 0);
  const adapter = reconcileArtifact("adapter", actor, state.adapterVersionFile, state.adapterExists, actor.comm);
  const requiresSpawn = !state.daemonRunning;
  const requiresDaemonRestart = state.daemonRunning && daemon.contentReplaced;
  const requiresAdapterReload = state.daemonRunning && adapter.contentReplaced;
  return {
    daemon,
    adapter,
    requiresSpawn,
    requiresDaemonRestart,
    requiresAdapterReload,
    reasons: [...daemon.reasons, ...adapter.reasons]
  };
}
function reconcileArtifact(kind, actor, existing, bundleExists, contentId) {
  const incomingVersion = kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion;
  const entry = makeEntry(actor, kind);
  if (!existing) {
    const record2 = {
      schema_version: VERSION_FILE_SCHEMA,
      content_version: incomingVersion,
      content_kind: kind,
      ...contentId ? { content_id: contentId } : {},
      content_source: entry,
      installed_by: [entry]
    };
    return {
      writeBundle: true,
      writeVersionFile: true,
      contentReplaced: true,
      resultingContentVersion: incomingVersion,
      resultingVersionFile: record2,
      reasons: [`cold install: no existing ${kind}`]
    };
  }
  const { list, changed } = upsertInstalledBy(existing.installed_by, entry);
  const record = { ...existing, installed_by: list };
  const reasons = [];
  let writeBundle = false;
  let contentReplaced = false;
  const cmp = compareVersions(incomingVersion, existing.content_version);
  if (cmp > 0) {
    writeBundle = true;
    contentReplaced = true;
    record.content_version = incomingVersion;
    record.content_source = entry;
    reasons.push(`upgrade ${kind}: incoming ${incomingVersion} > installed ${existing.content_version}`);
  } else if (cmp === 0) {
    reasons.push(`no content change: incoming ${kind} equals installed ${incomingVersion}`);
    if (!bundleExists) {
      writeBundle = true;
      reasons.push(`recovery: ${kind} blob missing on disk, rewriting at installed version`);
    }
  } else {
    reasons.push(`no downgrade: incoming ${kind} ${incomingVersion} < installed ${existing.content_version}`);
    if (!bundleExists) {
      writeBundle = true;
      contentReplaced = true;
      record.content_version = incomingVersion;
      record.content_source = entry;
      reasons.push(`recovery: ${kind} blob missing and only older bundle available; restoring at ${incomingVersion}`);
    }
  }
  return {
    writeBundle,
    writeVersionFile: changed || contentReplaced,
    contentReplaced,
    resultingContentVersion: record.content_version,
    resultingVersionFile: record,
    reasons
  };
}
function upsertInstalledBy(list, entry) {
  const idx = list.findIndex((e) => e.agent === entry.agent && e.comm === entry.comm);
  if (idx === -1) {
    return { list: [...list, entry], changed: true };
  }
  const prev = list[idx];
  if (prev.plugin_version === entry.plugin_version && prev.bundle_version === entry.bundle_version) {
    return { list, changed: false };
  }
  const next = list.slice();
  next[idx] = entry;
  return { list: next, changed: true };
}
function makeEntry(actor, kind) {
  return {
    agent: actor.agent,
    comm: actor.comm,
    plugin_version: actor.pluginVersion,
    bundle_version: kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion,
    installed_at: actor.installedAt
  };
}
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
  }
  return 0;
}
function parseVersion(v) {
  return String(v).split("-")[0].split(".").map((s) => {
    const num = Number(s);
    return Number.isInteger(num) ? num : s;
  });
}
async function executeInstallPlan(plan, actor, paths, fs) {
  const daemonSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/daemon.bundle.js` : null;
  const adapterSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/${actor.comm}.adapter.bundle.js` : null;
  if (plan.daemon.writeBundle && !daemonSrc) {
    throw new Error(
      "executeInstallPlan: daemon bundle write required but actor.pluginInstallDir is unset"
    );
  }
  if (plan.adapter.writeBundle && !adapterSrc) {
    throw new Error(
      "executeInstallPlan: adapter bundle write required but actor.pluginInstallDir is unset"
    );
  }
  const wroteBundles = [];
  const wroteVersionFiles = [];
  if (plan.daemon.writeBundle) {
    const binDir = dirname3(paths.daemonBundle);
    await fs.mkdirp(binDir);
    await fs.copyFile(
      /** @type {string} */
      daemonSrc,
      paths.daemonBundle
    );
    wroteBundles.push(paths.daemonBundle);
    for (const name of actor.daemonSidecars ?? []) {
      await fs.copyFile(`${actor.pluginInstallDir}/${name}`, join3(binDir, name));
    }
    await fs.writeFile(join3(binDir, "package.json"), '{\n  "type": "module"\n}\n');
  }
  if (plan.daemon.writeVersionFile) {
    await fs.mkdirp(dirname3(paths.daemonVersionFile));
    await fs.writeFile(paths.daemonVersionFile, serialize(plan.daemon.resultingVersionFile));
    wroteVersionFiles.push(paths.daemonVersionFile);
  }
  if (plan.adapter.writeBundle) {
    const adapterDir = dirname3(paths.adapterBundle);
    await fs.mkdirp(adapterDir);
    await fs.copyFile(
      /** @type {string} */
      adapterSrc,
      paths.adapterBundle
    );
    await fs.writeFile(join3(adapterDir, "package.json"), '{\n  "type": "module"\n}\n');
    wroteBundles.push(paths.adapterBundle);
  }
  if (plan.adapter.writeVersionFile) {
    await fs.mkdirp(dirname3(paths.adapterVersionFile));
    await fs.writeFile(paths.adapterVersionFile, serialize(plan.adapter.resultingVersionFile));
    wroteVersionFiles.push(paths.adapterVersionFile);
  }
  return { wroteBundles, wroteVersionFiles };
}
function serialize(record) {
  return `${JSON.stringify(record, null, 2)}
`;
}
var CLI_LAUNCHER_NAMES = ["agents-comm", "agents-comm-bus"];
async function installCliLaunchers(paths, cliSrc, fs) {
  const binDir = dirname3(paths.cliBundle);
  await fs.mkdirp(binDir);
  await fs.copyFile(cliSrc, paths.cliBundle);
  for (const name of CLI_LAUNCHER_NAMES) {
    await fs.writeFile(join3(binDir, `${name}.cmd`), `@echo off\r
node "%~dp0cli.js" %*\r
`);
    const posix = join3(binDir, name);
    await fs.writeFile(posix, `#!/bin/sh
exec node "$(dirname "$0")/cli.js" "$@"
`);
    await fs.chmod?.(posix, 493);
  }
}
function dirname3(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "." : p.slice(0, i);
}
function join3(dir, name) {
  return `${dir}/${name}`;
}

// ../hosts/common/install/node-fs-seam.js
import { mkdir as mkdir4, copyFile, writeFile as writeFile2, rename, access, readFile as readFile4, chmod } from "node:fs/promises";
import path6 from "node:path";

// ../hosts/common/install/strip-bom.js
function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}

// ../hosts/common/install/node-fs-seam.js
function createAtomicNodeFsSeam() {
  return {
    mkdirp: async (dir) => {
      await mkdir4(dir, { recursive: true });
    },
    copyFile: async (from, to) => {
      const tmp = `${to}.tmp`;
      await copyFile(from, tmp);
      await rename(tmp, to);
    },
    writeFile: async (file, data) => {
      const tmp = `${file}.tmp`;
      await writeFile2(tmp, data, "utf8");
      await rename(tmp, file);
    },
    chmod: async (file, mode) => {
      await chmod(file, mode);
    }
  };
}
async function readCentralState(stateRoot3, comm) {
  const paths = resolveCentralPaths(stateRoot3, comm);
  return {
    daemonExists: await pathExists(paths.daemonBundle),
    daemonVersionFile: await readJsonOrNull(paths.daemonVersionFile),
    adapterExists: await pathExists(paths.adapterBundle),
    adapterVersionFile: await readJsonOrNull(paths.adapterVersionFile),
    daemonRunning: false
  };
}
async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
async function readJsonOrNull(p) {
  try {
    return JSON.parse(stripBom(await readFile4(p, "utf8")));
  } catch {
    return null;
  }
}
function resolveCentralPaths(stateRoot3, comm) {
  const bin = path6.join(stateRoot3, "bin");
  const adapters = path6.join(stateRoot3, "adapters");
  return {
    daemonBundle: path6.join(bin, "daemon.js"),
    daemonVersionFile: path6.join(bin, "version.json"),
    // The admin CLI is centrally installed next to the daemon (it rides under
    // the daemon version) so `agents-comm` / `agents-comm-bus` work without npm.
    cliBundle: path6.join(bin, "cli.js"),
    adapterBundle: path6.join(adapters, `${comm}.js`),
    adapterVersionFile: path6.join(adapters, `${comm}.version.json`)
  };
}

// ../hosts/common/install/install-lock.js
import { constants as constants2 } from "node:fs";
import { open as open3, readFile as readFile5, rm as rm3, mkdir as mkdir5, stat } from "node:fs/promises";
import path7 from "node:path";
var DEFAULTS = { timeoutMs: 5e3, retryMs: 50, staleMs: 3e4 };
async function acquireInstallLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const retryMs = options.retryMs ?? DEFAULTS.retryMs;
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
  const now = options.now ?? Date.now;
  const sleep2 = options.sleep ?? defaultSleep;
  await mkdir5(path7.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${now()}`;
  const start = now();
  let stoleStale = false;
  for (; ; ) {
    try {
      const handle = await open3(lockPath, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY);
      await handle.writeFile(`${token}
`, "utf8");
      await handle.close();
      return {
        path: lockPath,
        token,
        stoleStale,
        release: async () => {
          try {
            const current = await readFile5(lockPath, "utf8");
            if (current.trim() === token) {
              await rm3(lockPath, { force: true });
            }
          } catch {
          }
        }
      };
    } catch (error) {
      if (!isAlreadyExistsError2(error)) throw error;
      if (await stealIfStale(lockPath, staleMs, now)) {
        stoleStale = true;
        continue;
      }
      if (now() - start >= timeoutMs) {
        throw new Error(`central install lock at ${lockPath} is held; timed out after ${timeoutMs}ms`);
      }
      await sleep2(retryMs);
    }
  }
}
async function stealIfStale(lockPath, staleMs, now) {
  try {
    const info = await stat(lockPath);
    if (now() - info.mtimeMs > staleMs) {
      await rm3(lockPath, { force: true });
      return true;
    }
  } catch {
  }
  return false;
}
function defaultSleep(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function isAlreadyExistsError2(error) {
  return typeof error === "object" && error !== null && "code" in error && /** @type {any} */
  error.code === "EEXIST";
}

// ../hosts/common/install/run-central-install.js
var INSTALL_LOCK_NAME = "install.lock";
async function runCentralInstall(stateRoot3, actor, deps = {}) {
  const fs = deps.fs ?? createAtomicNodeFsSeam();
  const lockPath = path8.join(stateRoot3, INSTALL_LOCK_NAME);
  const lock = await acquireInstallLock(lockPath, deps.lock ?? {});
  try {
    const state = await readCentralState(stateRoot3, actor.comm);
    state.daemonRunning = deps.daemonRunning ?? false;
    const plan = reconcileInstall(actor, state);
    const paths = resolveCentralPaths(stateRoot3, actor.comm);
    const result = await executeInstallPlan(plan, actor, paths, fs);
    if (plan.daemon.writeBundle && actor.pluginInstallDir) {
      const cliSrc = path8.join(actor.pluginInstallDir, "cli.bundle.js");
      if (existsSync(cliSrc)) {
        await installCliLaunchers(paths, cliSrc, fs);
        result.wroteBundles.push(paths.cliBundle);
      }
    }
    return { plan, result, stoleStale: lock.stoleStale };
  } finally {
    await lock.release();
  }
}

// ../hosts/common/install/ensure-central-install.js
var INSTALL_STAMP_NAME = "install-stamp.json";
function resolveInstallMode(env) {
  return env && env.AGENTS_COMM_BUS_BIN ? "source" : "production";
}
async function readInstallStamp(pluginInstallDir, deps = {}) {
  if (!pluginInstallDir) return null;
  const read = deps.readFile ?? readFile6;
  try {
    const raw = await read(path9.join(pluginInstallDir, INSTALL_STAMP_NAME), "utf8");
    const parsed = JSON.parse(stripBom(raw));
    if (!parsed || parsed.schema_version !== 1 || typeof parsed.plugin_version !== "string" || typeof parsed.daemon_bundle_version !== "string" || typeof parsed.adapter_bundle_version !== "string" || !isValidAdapterBundleVersionsMap(parsed.adapter_bundle_versions)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
async function ensureCentralInstall(options) {
  const env = options.env ?? process.env;
  const mode = resolveInstallMode(env);
  if (mode === "source") {
    return { mode: "source", skipped: true };
  }
  const stamp = await readInstallStamp(options.pluginInstallDir, options.deps);
  if (!options.pluginInstallDir || !stamp) {
    if (options.stateRoot && existsSync2(path9.join(options.stateRoot, "bin", "daemon.js"))) {
      return { mode: "production", skipped: true };
    }
    throw new Error(
      `central install (production mode): missing or invalid plugin install metadata.
  - no source-mode signal (no AGENTS_COMM_BUS_BIN, no .agents-comm-bus-dev.json marker resolved)
  - no valid packaged install artifact (expected ${INSTALL_STAMP_NAME} under pluginInstallDir=${options.pluginInstallDir ?? "<unset>"})
Fix one of:
  - source/dev checkout: create .agents-comm-bus-dev.json at the repo root (see .agents-comm-bus-dev.json.example), or set AGENTS_COMM_BUS_BIN
  - packaged install: provide the staged plugin artifacts incl. ${INSTALL_STAMP_NAME}`
    );
  }
  const resolvedAgent = options.agent ?? stamp.agent;
  const resolvedComm = options.comm ?? stamp.comm;
  const resolvedAdapterBundleVersion = resolveAdapterBundleVersion(stamp, resolvedComm);
  if (typeof resolvedAgent !== "string" || resolvedAgent.length === 0 || typeof resolvedComm !== "string" || resolvedComm.length === 0) {
    throw new Error(
      `central install (production mode): install stamp resolved an invalid actor identity (agent=${JSON.stringify(resolvedAgent)}, comm=${JSON.stringify(resolvedComm)}). The stamp must carry agent + comm, or the caller must supply them.`
    );
  }
  const actor = {
    agent: (
      /** @type {any} */
      resolvedAgent
    ),
    comm: resolvedComm,
    pluginVersion: stamp.plugin_version,
    daemonBundleVersion: stamp.daemon_bundle_version,
    adapterBundleVersion: resolvedAdapterBundleVersion,
    pluginInstallDir: options.pluginInstallDir,
    installedAt: options.installedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    ...Array.isArray(stamp.daemon_sidecars) ? { daemonSidecars: stamp.daemon_sidecars } : {}
  };
  if (await centralInstallContentIsCurrent(
    options.stateRoot,
    resolvedComm,
    stamp,
    resolvedAdapterBundleVersion,
    options.deps
  )) {
    return { mode: "production", actor, skipped: true };
  }
  if (options.readOnlyIfCentralInstalled && await centralInstallHasRunnableContent(options.stateRoot, resolvedComm, options.deps)) {
    return { mode: "production", actor, skipped: true };
  }
  const run = options.deps?.runCentralInstall ?? runCentralInstall;
  const outcome = await run(options.stateRoot, actor, {
    fs: options.deps?.fs,
    lock: options.lock,
    daemonRunning: options.daemonRunning ?? false
  });
  return { mode: "production", actor, ...outcome };
}
async function centralInstallContentIsCurrent(stateRoot3, comm, stamp, adapterBundleVersion, deps = {}) {
  const readState = deps.readCentralState ?? readCentralState;
  try {
    const state = await readState(stateRoot3, comm);
    return Boolean(
      state.daemonExists && state.adapterExists && state.daemonVersionFile?.content_version === stamp.daemon_bundle_version && state.adapterVersionFile?.content_version === adapterBundleVersion
    );
  } catch {
    return false;
  }
}
function resolveAdapterBundleVersion(stamp, comm) {
  const fromMap = stamp.adapter_bundle_versions?.[comm];
  if (typeof fromMap === "string" && fromMap.length > 0) {
    return fromMap;
  }
  return stamp.adapter_bundle_version;
}
function isValidAdapterBundleVersionsMap(value) {
  if (value === void 0) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0
  );
}
async function centralInstallHasRunnableContent(stateRoot3, comm, deps = {}) {
  const readState = deps.readCentralState ?? readCentralState;
  try {
    const state = await readState(stateRoot3, comm);
    return Boolean(state.daemonExists && state.adapterExists);
  } catch {
    return false;
  }
}

// ../hosts/common/install/dev-config-resolver.js
import { readFileSync, existsSync as existsSync3 } from "node:fs";
import path10 from "node:path";
var DEV_MARKER_NAME = ".agents-comm-bus-dev.json";
function resolveDevConfig(projectRoot, deps = {}) {
  const exists = deps.exists ?? existsSync3;
  const readFile10 = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const markerPath = path10.join(projectRoot, DEV_MARKER_NAME);
  if (!exists(markerPath)) {
    return { env: {}, status: "none", reasons: [`no dev marker at ${markerPath}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(readFile10(markerPath)));
  } catch (error) {
    return {
      env: {},
      status: "rejected",
      reasons: [`dev marker unparseable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
  const daemonBinRaw = parsed && typeof parsed.daemonBin === "string" ? parsed.daemonBin : null;
  if (!daemonBinRaw) {
    return { env: {}, status: "rejected", reasons: ["dev marker missing string field `daemonBin`"] };
  }
  const daemonBin = path10.resolve(projectRoot, daemonBinRaw);
  if (!isInside(projectRoot, daemonBin)) {
    return { env: {}, status: "rejected", reasons: [`dev marker daemonBin escapes project root: ${daemonBinRaw}`] };
  }
  if (!exists(daemonBin)) {
    return { env: {}, status: "rejected", reasons: [`dev marker daemonBin does not exist: ${daemonBin}`] };
  }
  const env = { AGENTS_COMM_BUS_BIN: daemonBin };
  const reasons = [`dev marker applied from ${markerPath}`];
  if (typeof parsed.stateRoot === "string" && parsed.stateRoot.length > 0) {
    const stateRoot3 = path10.resolve(projectRoot, parsed.stateRoot);
    if (isInside(projectRoot, stateRoot3)) env.AGENTS_COMM_BUS_ROOT = stateRoot3;
    else reasons.push(`ignoring stateRoot outside project root: ${parsed.stateRoot}`);
  }
  if (typeof parsed.discoveryRoot === "string" && parsed.discoveryRoot.length > 0) {
    const discoveryRoot3 = path10.resolve(projectRoot, parsed.discoveryRoot);
    if (isInside(projectRoot, discoveryRoot3)) env.AGENTS_COMM_BUS_DISCOVERY_ROOT = discoveryRoot3;
    else reasons.push(`ignoring discoveryRoot outside project root: ${parsed.discoveryRoot}`);
  }
  if (typeof parsed.adaptersDir === "string" && parsed.adaptersDir.length > 0) {
    const adaptersDir = path10.resolve(projectRoot, parsed.adaptersDir);
    if (isInside(projectRoot, adaptersDir)) env.AGENTS_COMM_BUS_ADAPTERS_DIR = adaptersDir;
    else reasons.push(`ignoring adaptersDir outside project root: ${parsed.adaptersDir}`);
  }
  return { env, status: "applied", reasons };
}
function applyDevConfig(baseEnv, projectRoot, deps = {}) {
  const devConfig = resolveDevConfig(projectRoot, deps);
  return { env: { ...baseEnv, ...devConfig.env }, devConfig };
}
function isInside(root, candidate) {
  const rel = path10.relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path10.isAbsolute(rel);
}

// ../hosts/common/install/entry-ensures.js
function resolveEntryContext(fromDir, deps = {}) {
  const exists = deps.exists ?? existsSync4;
  return {
    projectRoot: findAncestorContaining(fromDir, DEV_MARKER_NAME, exists),
    pluginInstallDir: findAncestorContaining(fromDir, INSTALL_STAMP_NAME, exists)
  };
}
function findAncestorContaining(dir, name, exists) {
  let current = path11.resolve(dir);
  for (; ; ) {
    if (exists(path11.join(current, name))) return current;
    const parent = path11.dirname(current);
    if (parent === current) return void 0;
    current = parent;
  }
}
async function entryEnsures(options) {
  const {
    agent,
    comm,
    stateRoot: stateRoot3,
    discoveryRoot: discoveryRoot3,
    fromDir,
    projectRoot,
    pluginInstallDir,
    env = process.env,
    ensureDaemonOptions = {},
    daemonRunning = false,
    readOnlyCentralInstall = false,
    deps = {}
  } = options ?? {};
  const ensureDaemonFn = deps.ensureDaemon ?? ensureDaemon;
  const ensureCentralInstallFn = deps.ensureCentralInstall ?? ensureCentralInstall;
  let resolvedProjectRoot = projectRoot;
  let resolvedPluginInstallDir = pluginInstallDir;
  if (fromDir && (resolvedProjectRoot === void 0 || resolvedPluginInstallDir === void 0)) {
    const ctx = resolveEntryContext(fromDir, deps.entryContextDeps);
    resolvedProjectRoot = resolvedProjectRoot ?? ctx.projectRoot;
    resolvedPluginInstallDir = resolvedPluginInstallDir ?? ctx.pluginInstallDir;
  }
  const resolvedEnv = resolvedProjectRoot ? applyDevConfig(env, resolvedProjectRoot, deps.devConfigDeps).env : env;
  const resolveStatePathsFn = deps.resolveStatePaths ?? resolveStatePaths2;
  const canonicalStateRoot = stateRoot3 ?? resolvedEnv.AGENTS_COMM_BUS_ROOT ?? resolveStatePathsFn({ stateRoot: resolvedEnv.AGENTS_COMM_BUS_STATE_ROOT }).root;
  const canonicalDiscoveryRoot = ensureDaemonOptions.discoveryRoot ?? discoveryRoot3 ?? resolvedEnv.AGENTS_COMM_BUS_DISCOVERY_ROOT ?? canonicalStateRoot;
  const centralInstall = await ensureCentralInstallFn({
    stateRoot: canonicalStateRoot,
    agent,
    comm,
    pluginInstallDir: resolvedPluginInstallDir,
    env: resolvedEnv,
    daemonRunning,
    readOnlyIfCentralInstalled: readOnlyCentralInstall,
    deps: deps.centralInstallDeps
  });
  const daemon = await ensureDaemonFn({
    ...ensureDaemonOptions,
    stateRoot: canonicalStateRoot,
    discoveryRoot: canonicalDiscoveryRoot,
    env: {
      ...resolvedEnv,
      AGENTS_COMM_BUS_DISCOVERY_ROOT: canonicalDiscoveryRoot
    }
  });
  return {
    ...daemon,
    centralInstall,
    stateRoot: canonicalStateRoot,
    discoveryRoot: canonicalDiscoveryRoot,
    env: {
      ...resolvedEnv,
      AGENTS_COMM_BUS_DISCOVERY_ROOT: canonicalDiscoveryRoot
    }
  };
}

// ../core-daemon/cli/identity-probe.ts
async function probeIdentityViaDaemon(options) {
  const daemon = await entryEnsures({
    agent: options.agent,
    comm: options.comm,
    stateRoot: options.stateRoot,
    fromDir: import.meta.dirname,
    env: process.env,
    ensureDaemonOptions: {
      timeoutMs: options.timeoutMs,
      metadata: { shimName: "agents-comm-bus/cli", operation: "probe_comm_identity" }
    }
  });
  const connection = await connectIpc({
    port: daemon.port,
    clientVersion: DAEMON_VERSION,
    timeoutMs: options.timeoutMs ?? 2e3,
    metadata: { shimName: "agents-comm-bus/cli", operation: "probe_comm_identity" }
  });
  try {
    const result = await connection.request("probe_comm_identity", {
      comm: options.comm,
      credentials: { botToken: options.botToken }
    });
    return parseProbeResult(result);
  } finally {
    connection.close();
  }
}
function parseProbeResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("probe_comm_identity returned an invalid response");
  }
  const record = result;
  if (record.account_id == null) {
    throw new Error("probe_comm_identity response is missing account_id");
  }
  return {
    bot_user_id: String(record.account_id),
    bot_username: record.account_username == null ? null : String(record.account_username)
  };
}

// ../core-daemon/cli/token-file.ts
import { chmod as chmod2, mkdir as mkdir6, writeFile as writeFile3 } from "node:fs/promises";
import path12 from "node:path";
async function writeTokenFile(options) {
  const tokenFile = resolveTokenFilePath({
    stateRoot: options.stateRoot,
    comm: options.comm,
    project: options.project,
    agent: options.agent,
    accountId: options.accountId
  });
  await mkdir6(path12.dirname(tokenFile), { recursive: true });
  const body = {
    botToken: options.botToken,
    ...options.userId && options.userId.length > 0 ? { userId: options.userId } : {}
  };
  await writeFile3(
    tokenFile,
    `${JSON.stringify(body, null, 2)}
`,
    { encoding: "utf8", mode: 384 }
  );
  try {
    await chmod2(tokenFile, 384);
  } catch {
  }
  return `file:${tokenFile}`;
}

// ../core-daemon/cli/account-add.ts
async function accountAdd(options) {
  const project = normalizeProjectPath(options.project);
  const comm = options.comm ?? "telegram";
  const botToken = options.botToken;
  if (!botToken) {
    throw new Error("--bot-token is required for account-add");
  }
  const identity = await (options.probeIdentity ?? ((token) => probeIdentityViaDaemon({
    comm,
    botToken: token,
    agent: options.agent,
    stateRoot: options.stateRoot
  })))(botToken);
  const paths = resolveStatePaths({ stateRoot: options.stateRoot });
  await mkdir7(paths.root, { recursive: true });
  const storage = await openSqliteStorage(paths.database);
  try {
    const labelMatches = await storage.listAccountRegistrations({
      project,
      comm,
      agent: options.agent
    });
    const existingLabel = labelMatches.find((row) => row.account_label === options.accountLabel);
    if (existingLabel) {
      throw new Error(
        `${comm} account label ${options.accountLabel} is already registered as bot_id=${existingLabel.bot_user_id} for project=${project}, agent=${options.agent}; use account-remove before re-adding, or an account-update command when available.`
      );
    }
    const existing = await storage.getAccountByBot(comm, identity.bot_user_id);
    if (existing) {
      throw new Error(
        `${comm} bot id ${identity.bot_user_id} is already registered as project=${existing.project}, agent=${existing.agent}, account_label=${existing.account_label}; use account-list to inspect it or account-remove --comm ${comm} --bot-id ${identity.bot_user_id} before re-adding.`
      );
    }
    const credentialsRef = await writeTokenFile({
      stateRoot: options.stateRoot,
      comm,
      project,
      agent: options.agent,
      accountId: identity.bot_user_id,
      botToken
    });
    const now = Date.now();
    const registration = {
      schema_version: SCHEMA_VERSION_ACCOUNT,
      registration_id: `reg_${randomBytes(16).toString("hex")}`,
      project,
      comm,
      agent: options.agent,
      account_label: options.accountLabel,
      bot_user_id: identity.bot_user_id,
      bot_username: identity.bot_username ?? void 0,
      credentials_ref: credentialsRef,
      created_at: now,
      updated_at: now,
      metadata: { source: "account-add" }
    };
    await storage.putAccountRegistration(registration);
    return registration;
  } finally {
    await storage.close();
  }
}

// ../core-daemon/cli/account-list.ts
async function accountList(options = {}) {
  const storage = await openSqliteStorage(resolveStatePaths().database);
  const rows = await storage.listAccountRegistrations({
    project: options.project === void 0 ? void 0 : normalizeProjectPath(options.project),
    comm: options.comm,
    agent: options.agent
  });
  await storage.close();
  return rows;
}

// ../core-daemon/cli/account-selector.ts
async function resolveAccountByLabel(storage, selector) {
  const candidates = await storage.listAccountRegistrations({
    project: selector.project,
    comm: selector.comm,
    agent: selector.agent
  });
  const matches = candidates.filter((row) => row.account_label === selector.accountLabel);
  if (matches.length === 0) {
    throw new Error(
      `no account registration found for (comm=${selector.comm}, account-label=${selector.accountLabel}${selector.agent ? `, agent=${selector.agent}` : ""}${selector.project ? `, project=${selector.project}` : ""}); use --bot-id, or run \`agents-comm account-list\` to inspect registered accounts`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `account label "${selector.accountLabel}" is ambiguous for ${selector.comm}; matched bot ids: ${matches.map((row) => row.bot_user_id).join(", ")}. Narrow with --agent/--project or use --bot-id.`
    );
  }
  return matches[0];
}

// ../core-daemon/cli/account-relabel.ts
async function accountRelabel(options) {
  const comm = options.comm ?? "telegram";
  if (!options.newAccountLabel) {
    throw new Error("--new-account-label is required for account-relabel");
  }
  const storage = await openSqliteStorage(resolveStatePaths({ stateRoot: options.stateRoot }).database);
  try {
    const current = await resolveCurrentAccount(storage, {
      comm,
      botId: options.botId,
      accountLabel: options.accountLabel,
      agent: options.agent,
      project: options.project
    });
    return storage.updateAccountRegistrationLabel({
      comm,
      bot_user_id: current.bot_user_id,
      account_label: options.newAccountLabel,
      updated_at: Date.now()
    });
  } finally {
    await storage.close();
  }
}
async function resolveCurrentAccount(storage, selector) {
  if (selector.botId) {
    const row = await storage.getAccountByBot(selector.comm, selector.botId);
    if (!row) {
      throw new Error(
        `no account registration found for (comm=${selector.comm}, bot-id=${selector.botId}); run \`agents-comm account-list\` to inspect registered accounts`
      );
    }
    return row;
  }
  if (!selector.accountLabel) {
    throw new Error(
      `account-relabel requires --bot-id or --account-label for ${selector.comm}; run \`agents-comm account-list\` to inspect registered accounts`
    );
  }
  return resolveAccountByLabel(storage, {
    comm: selector.comm,
    accountLabel: selector.accountLabel,
    agent: selector.agent,
    project: selector.project
  });
}

// ../core-daemon/cli/account-remove.ts
async function accountRemove(options) {
  const comm = options.comm ?? "telegram";
  const storage = await openSqliteStorage(resolveStatePaths({ stateRoot: options.stateRoot }).database);
  try {
    if (options.botId) {
      const row2 = await storage.getAccountByBot(comm, options.botId);
      if (!row2) {
        throw new Error(
          `no account registration found for (comm=${comm}, bot-id=${options.botId}); run \`agents-comm account-list\` to inspect registered accounts`
        );
      }
      await storage.deleteAccountRegistration(row2.project, row2.comm, row2.agent, row2.account_label);
      return;
    }
    if (!options.accountLabel) {
      throw new Error(
        `account-remove requires --bot-id or --account-label for ${comm}; run \`agents-comm account-list\` to inspect registered accounts`
      );
    }
    const row = await resolveAccountByLabel(storage, {
      comm,
      accountLabel: options.accountLabel,
      agent: options.agent,
      project: options.project
    });
    await storage.deleteAccountRegistration(row.project, row.comm, row.agent, row.account_label);
  } finally {
    await storage.close();
  }
}

// ../core-daemon/cli/account-update-token.ts
import { rm as rm4 } from "node:fs/promises";
async function accountUpdateToken(options) {
  const comm = options.comm ?? "telegram";
  if (!options.botToken) {
    throw new Error("--bot-token is required for account-update-token");
  }
  const identity = await (options.probeIdentity ?? ((token) => probeIdentityViaDaemon({
    comm,
    botToken: token,
    agent: options.agent,
    stateRoot: options.stateRoot
  })))(options.botToken);
  const storage = await openSqliteStorage(resolveStatePaths({ stateRoot: options.stateRoot }).database);
  let wroteTokenRef = null;
  let wroteReplacementToken = false;
  try {
    const current = await resolveCurrentAccount2(storage, {
      comm,
      botId: options.botId,
      accountLabel: options.accountLabel,
      agent: options.agent,
      project: options.project
    });
    const botChanged = current.bot_user_id !== identity.bot_user_id;
    if (botChanged && !options.allowBotChange) {
      throw new Error(
        `Token belongs to a different bot (current ${current.bot_user_id} -> ${identity.bot_user_id}). This changes the bot identity and will remap allowlist + conversation rows. Re-run with --allow-bot-change if intentional.`
      );
    }
    if (botChanged) {
      const existing = await storage.getAccountByBot(comm, identity.bot_user_id);
      if (existing) {
        throw new Error(
          `${comm} bot id ${identity.bot_user_id} is already registered as project=${existing.project}, agent=${existing.agent}, account_label=${existing.account_label}; account-update-token cannot replace ${current.bot_user_id} with an already-registered bot.`
        );
      }
    }
    const credentialsRef = await writeTokenFile({
      stateRoot: options.stateRoot,
      comm,
      project: current.project,
      agent: current.agent,
      accountId: identity.bot_user_id,
      botToken: options.botToken
    });
    wroteTokenRef = credentialsRef;
    wroteReplacementToken = botChanged;
    const result = await storage.updateAccountRegistrationToken({
      comm,
      current_bot_user_id: current.bot_user_id,
      new_bot_user_id: identity.bot_user_id,
      credentials_ref: credentialsRef,
      bot_username: identity.bot_username ?? void 0,
      updated_at: Date.now()
    });
    if (botChanged) {
      await removeOldTokenFile(current.credentials_ref, credentialsRef);
    }
    return result;
  } catch (error) {
    if (wroteTokenRef && wroteReplacementToken) {
      await removeTokenFile(wroteTokenRef);
    }
    throw error;
  } finally {
    await storage.close();
  }
}
async function resolveCurrentAccount2(storage, selector) {
  if (selector.botId) {
    const row = await storage.getAccountByBot(selector.comm, selector.botId);
    if (!row) {
      throw new Error(
        `no account registration found for (comm=${selector.comm}, bot-id=${selector.botId}); run \`agents-comm account-list\` to inspect registered accounts`
      );
    }
    return row;
  }
  if (!selector.accountLabel) {
    throw new Error(
      `account-update-token requires --bot-id or --account-label for ${selector.comm}; run \`agents-comm account-list\` to inspect registered accounts`
    );
  }
  return resolveAccountByLabel(storage, {
    comm: selector.comm,
    accountLabel: selector.accountLabel,
    agent: selector.agent,
    project: selector.project
  });
}
async function removeOldTokenFile(oldRef, newRef) {
  const oldPath = filePathFromRef(oldRef);
  const newPath = filePathFromRef(newRef);
  if (!oldPath || oldPath === newPath) return;
  await rm4(oldPath, { force: true });
}
async function removeTokenFile(ref) {
  const filePath = filePathFromRef(ref);
  if (!filePath) return;
  await rm4(filePath, { force: true });
}
function filePathFromRef(ref) {
  return ref.startsWith("file:") ? ref.slice("file:".length) : null;
}

// ../core-daemon/cli/allowlist-shared.ts
async function resolvePerBotSelector(storage, selector) {
  if (selector.botId) {
    return { bot_user_id: selector.botId };
  }
  if (!selector.accountLabel) {
    throw new Error(
      `per-bot allowlist scope requires --bot-id or --account-label for ${selector.comm}; run \`agents-comm account-list\` to find the bot_user_id.`
    );
  }
  const matched = await resolveAccountByLabel(storage, {
    comm: selector.comm,
    accountLabel: selector.accountLabel,
    agent: selector.agent,
    project: selector.project
  });
  return { bot_user_id: matched.bot_user_id, matched };
}

// ../core-daemon/cli/allowlist-add.ts
async function allowlistAdd(options) {
  const comm = options.comm;
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    const added_at = Date.now();
    const added_by = options.addedBy ?? "cli";
    if (options.scope === "global") {
      const rec2 = {
        comm,
        sender_id: options.user,
        added_at,
        added_by,
        note: options.note
      };
      await storage.addAllowlistGlobal(rec2);
      return { scope: "global", ...rec2 };
    }
    const selector = {
      comm,
      botId: options.botId,
      agent: options.agent,
      project: options.project,
      accountLabel: options.accountLabel
    };
    const { bot_user_id } = await resolvePerBotSelector(storage, selector);
    const rec = {
      comm,
      bot_user_id,
      sender_id: options.user,
      added_at,
      added_by,
      note: options.note
    };
    await storage.addAllowlistPerBot(rec);
    return { scope: "per-bot", ...rec };
  } finally {
    await storage.close();
  }
}

// ../core-daemon/cli/allowlist-import.ts
import { readFile as readFile7 } from "node:fs/promises";
async function allowlistImportFromEnv(options = {}) {
  const comm = options.comm ?? "telegram";
  if (comm !== "telegram") {
    throw new Error(`import-from-env: only telegram supported in this slice (got ${comm})`);
  }
  const raw = process.env.TELEGRAM_USER_ID ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const storage = await openSqliteStorage(resolveStatePaths().database);
  const details = [];
  let added = 0;
  let skipped3 = 0;
  try {
    for (const sender_id of ids) {
      const before = await storage.listAllowlistGlobal({ comm });
      const existed = before.some((row) => row.sender_id === sender_id);
      await storage.addAllowlistGlobal({
        comm,
        sender_id,
        added_at: Date.now(),
        added_by: "migration:env"
      });
      if (existed) {
        details.push({ scope: "global", sender_id, status: "duplicate" });
        skipped3 += 1;
      } else {
        details.push({ scope: "global", sender_id, status: "added" });
        added += 1;
      }
    }
  } finally {
    await storage.close();
  }
  return { comm, added, skipped: skipped3, details };
}
async function allowlistImportFromFiles(options = {}) {
  const comm = options.comm ?? "telegram";
  if (comm !== "telegram") {
    throw new Error(
      `import-from-files: only telegram supported in this slice (got ${comm})`
    );
  }
  const storage = await openSqliteStorage(resolveStatePaths().database);
  const details = [];
  let added = 0;
  let skipped3 = 0;
  try {
    const registrations = await storage.listAccountRegistrations({ comm });
    for (const reg of registrations) {
      const filePath = filePathFromCredentialsRef(reg.credentials_ref, reg.project);
      if (!filePath) continue;
      const ids = await readUserIdsFromJson(filePath);
      for (const sender_id of ids) {
        const before = await storage.listAllowlistPerBot({
          comm,
          bot_user_id: reg.bot_user_id
        });
        const existed = before.some((row) => row.sender_id === sender_id);
        if (options.dryRun) {
          details.push({
            scope: "per-bot",
            bot_user_id: reg.bot_user_id,
            sender_id,
            status: existed ? "duplicate" : "would-add"
          });
          if (!existed) added += 1;
          else skipped3 += 1;
          continue;
        }
        await storage.addAllowlistPerBot({
          comm,
          bot_user_id: reg.bot_user_id,
          sender_id,
          added_at: Date.now(),
          added_by: "migration:file"
        });
        if (existed) {
          details.push({
            scope: "per-bot",
            bot_user_id: reg.bot_user_id,
            sender_id,
            status: "duplicate"
          });
          skipped3 += 1;
        } else {
          details.push({
            scope: "per-bot",
            bot_user_id: reg.bot_user_id,
            sender_id,
            status: "added"
          });
          added += 1;
        }
      }
    }
  } finally {
    await storage.close();
  }
  return { comm, added, skipped: skipped3, details };
}
function filePathFromCredentialsRef(ref, _project) {
  if (!ref) return null;
  if (ref.startsWith("file:")) {
    return ref.slice("file:".length);
  }
  return null;
}
async function readUserIdsFromJson(filePath) {
  try {
    const raw = await readFile7(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeUserIdField(parsed.userId);
  } catch {
    return [];
  }
}
function normalizeUserIdField(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => typeof v === "string" || typeof v === "number" ? String(v) : "").map((s) => s.trim()).filter(Boolean);
  }
  if (typeof raw === "string") return [raw.trim()].filter(Boolean);
  if (typeof raw === "number") return [String(raw)];
  return [];
}

// ../core-daemon/cli/allowlist-list.ts
async function allowlistList(options = {}) {
  const scope = options.scope ?? "all";
  const comm = options.comm;
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    const global = scope === "per-bot" ? [] : await storage.listAllowlistGlobal({ comm });
    if (scope === "global") {
      return { global, per_bot: [] };
    }
    let per_bot;
    const hasPerBotSelector = Boolean(
      options.botId || options.agent || options.project || options.accountLabel
    );
    if (hasPerBotSelector) {
      if (!comm) {
        throw new Error("--comm is required when selecting per-bot rows");
      }
      const selector = {
        comm,
        botId: options.botId,
        agent: options.agent,
        project: options.project,
        accountLabel: options.accountLabel
      };
      const { bot_user_id } = await resolvePerBotSelector(storage, selector);
      per_bot = await storage.listAllowlistPerBot({ comm, bot_user_id });
    } else {
      per_bot = await storage.listAllowlistPerBot({ comm });
    }
    return { global, per_bot };
  } finally {
    await storage.close();
  }
}

// ../core-daemon/cli/allowlist-remove.ts
async function allowlistRemove(options) {
  const comm = options.comm;
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    if (options.scope === "global") {
      await storage.removeAllowlistGlobal(comm, options.user);
      return { scope: "global", comm, sender_id: options.user };
    }
    const selector = {
      comm,
      botId: options.botId,
      agent: options.agent,
      project: options.project,
      accountLabel: options.accountLabel
    };
    const { bot_user_id } = await resolvePerBotSelector(storage, selector);
    await storage.removeAllowlistPerBot(comm, bot_user_id, options.user);
    return { scope: "per-bot", comm, bot_user_id, sender_id: options.user };
  } finally {
    await storage.close();
  }
}

// ../core-daemon/cli/migrate.ts
import { writeFileSync } from "node:fs";
import { resolve as resolve2 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { pathToFileURL } from "node:url";

// ../core-daemon/migrations/legacy-readers.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync5, readdirSync, readFileSync as readFileSync2, statSync } from "node:fs";
import { basename, join as join4, resolve } from "node:path";
import { homedir } from "node:os";
var TRANSITION_ONLY_MARKER = "transition-only";
var TRANSITION_CLEANUP_RELEASE = "v4.1-cleanup";
function legacySessionDirForProject(projectRoot, agent, homeDir = homedir()) {
  const normalizedProject = resolve(projectRoot);
  const safeBase = basename(normalizedProject).replace(/[^a-zA-Z0-9-_]/g, "_");
  const hash = createHash2("md5").update(normalizedProject).digest("hex").slice(0, 6);
  return join4(homeDir, agent === "claude" ? ".claude-telegram" : ".codex-telegram", `${safeBase}-${hash}`);
}
function discoverLegacyInputs(options) {
  const projectRoot = resolve(options.projectRoot);
  const homeDir = options.homeDir ? resolve(options.homeDir) : homedir();
  const now = options.now ?? Date.now();
  const pendingTtlMs = options.pendingTtlMs ?? 5 * 60 * 1e3;
  const skipped3 = [];
  const sessionRoots = discoverLegacySessionRoots(projectRoot, homeDir, skipped3);
  const credentials = discoverCredentialCandidates(projectRoot, homeDir, skipped3);
  const lastChats = [];
  const pendingPermissions = [];
  const queues = [];
  for (const root of sessionRoots) {
    const lastChat = readLastChat(join4(root.path, "last-chat.json"), root.agent, root.path);
    if (lastChat.ok) lastChats.push(lastChat.file);
    else if (lastChat.exists) skipped3.push(skip("last-chat", root.agent, join4(root.path, "last-chat.json"), lastChat.reason));
    const pending = readPendingPermission(join4(root.path, "pending-permission.json"), root.agent, root.path, now, pendingTtlMs);
    if (pending.ok) pendingPermissions.push(pending.file);
    else if (pending.exists) skipped3.push(skip("pending-permission", root.agent, join4(root.path, "pending-permission.json"), pending.reason));
    const queue = readQueue(join4(root.path, "queue.json"), root.agent, root.path);
    if (queue.ok) queues.push(queue.file);
    else if (queue.exists) skipped3.push(skip("queue", root.agent, join4(root.path, "queue.json"), queue.reason));
  }
  return { projectRoot, homeDir, credentials, sessionRoots, lastChats, pendingPermissions, queues, skipped: skipped3 };
}
function discoverCredentialCandidates(projectRoot, homeDir, skipped3) {
  const paths = [
    { agent: "claude", scope: "project", path: join4(projectRoot, ".claude", "telegram.json"), priority: 10 },
    { agent: "codex", scope: "project", path: join4(projectRoot, ".codex", "telegram.json"), priority: 10 },
    { agent: "claude", scope: "home", path: join4(homeDir, ".claude", "telegram.json"), priority: 1 },
    { agent: "codex", scope: "home", path: join4(homeDir, ".codex", "telegram.json"), priority: 1 }
  ];
  const result = [];
  for (const candidate of paths) {
    if (!existsSync5(candidate.path)) continue;
    const parsed = readJson(candidate.path);
    if (!parsed.ok) {
      skipped3.push(skip("credential", candidate.agent, candidate.path, parsed.reason));
      continue;
    }
    if (!isObject(parsed.value)) {
      skipped3.push(skip("credential", candidate.agent, candidate.path, "credential file is not a JSON object"));
      continue;
    }
    const botToken = stringValue(parsed.value.botToken);
    const userIds = normalizeUserIds(parsed.value.userId);
    result.push({
      kind: "credential",
      agent: candidate.agent,
      path: candidate.path,
      scope: candidate.scope,
      priority: candidate.priority,
      hasBotToken: botToken.length > 0,
      userIds,
      credentialRef: `legacy-file:${candidate.path}`,
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE
    });
  }
  return result;
}
function discoverLegacySessionRoots(projectRoot, homeDir, skipped3) {
  const roots = [];
  for (const agent of ["claude", "codex"]) {
    const parent = join4(homeDir, agent === "claude" ? ".claude-telegram" : ".codex-telegram");
    if (!existsSync5(parent)) continue;
    let entries;
    try {
      entries = readdirSync(parent);
    } catch (error) {
      skipped3.push(skip("session-root", agent, parent, error instanceof Error ? error.message : "cannot read session root"));
      continue;
    }
    const expected = legacySessionDirForProject(projectRoot, agent, homeDir);
    for (const entry of entries) {
      const path14 = join4(parent, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(path14).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      roots.push({
        kind: "session-root",
        agent,
        path: path14,
        projectHint: entry.replace(/-[0-9a-f]{6}$/i, ""),
        expectedForProject: resolve(path14) === resolve(expected),
        transition: TRANSITION_ONLY_MARKER,
        cleanupRelease: TRANSITION_CLEANUP_RELEASE
      });
    }
  }
  return roots;
}
function readLastChat(path14, agent, sessionRoot) {
  const parsed = readOptionalObject(path14);
  if (!parsed.ok) return parsed;
  const chatId = stringValue(parsed.value.chat_id);
  if (!chatId) return { ok: false, exists: true, reason: "last-chat.json is missing chat_id" };
  return {
    ok: true,
    file: stateFile("last-chat", agent, path14, sessionRoot, {
      chat_id: chatId,
      message_thread_id: nullableString(parsed.value.message_thread_id),
      from_user_id: nullableString(parsed.value.from_user_id),
      updated_at: nullableString(parsed.value.updated_at)
    })
  };
}
function readPendingPermission(path14, agent, sessionRoot, now, ttlMs) {
  const parsed = readOptionalObject(path14);
  if (!parsed.ok) return parsed;
  const timestamp = stringValue(parsed.value.timestamp);
  if (!timestamp) return { ok: false, exists: true, reason: "pending-permission.json is missing timestamp" };
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, exists: true, reason: "pending-permission.json timestamp is invalid" };
  if (now - timestampMs >= ttlMs) return { ok: false, exists: true, reason: "pending permission is expired" };
  return {
    ok: true,
    file: stateFile("pending-permission", agent, path14, sessionRoot, {
      timestamp,
      tool_name: nullableString(parsed.value.tool_name),
      tool_input: isObject(parsed.value.tool_input) ? parsed.value.tool_input : null,
      prompt_type: stringValue(parsed.value.prompt_type) || "permission",
      chat_id: nullableString(parsed.value.chat_id),
      message_thread_id: nullableString(parsed.value.message_thread_id)
    })
  };
}
function readQueue(path14, agent, sessionRoot) {
  const parsed = readOptionalObject(path14);
  if (!parsed.ok) return parsed;
  const rawMessages = Array.isArray(parsed.value.messages) ? parsed.value.messages : [];
  const messages = [];
  for (const raw of rawMessages) {
    if (!isObject(raw)) continue;
    messages.push({
      id: stringValue(raw.id),
      timestamp: typeof raw.timestamp === "number" || typeof raw.timestamp === "string" ? raw.timestamp : null,
      text: stringValue(raw.text),
      from: nullableString(raw.from),
      chatId: nullableString(raw.chatId),
      imagePath: nullableString(raw.imagePath) ?? void 0
    });
  }
  return { ok: true, file: stateFile("queue", agent, path14, sessionRoot, messages) };
}
function readOptionalObject(path14) {
  if (!existsSync5(path14)) return { ok: false, exists: false, reason: "file does not exist" };
  const parsed = readJson(path14);
  if (!parsed.ok) return { ok: false, exists: true, reason: parsed.reason };
  if (!isObject(parsed.value)) return { ok: false, exists: true, reason: "file is not a JSON object" };
  return { ok: true, value: parsed.value };
}
function readJson(path14) {
  try {
    return { ok: true, value: JSON.parse(readFileSync2(path14, "utf8")) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid JSON" };
  }
}
function normalizeUserIds(raw) {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return values.map((value) => stringValue(value).trim()).filter(Boolean);
}
function stateFile(kind, agent, path14, sessionRoot, value) {
  return {
    kind,
    agent,
    path: path14,
    sessionRoot,
    value,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE
  };
}
function skip(kind, agent, path14, reason) {
  return {
    kind,
    agent,
    path: path14,
    reason,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE
  };
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return "";
}
function nullableString(value) {
  const text = stringValue(value);
  return text.length > 0 ? text : null;
}

// ../core-daemon/migrations/import-last-chat.ts
function importLastChat(file, options) {
  const chatId = file.value.chat_id?.trim();
  if (!chatId) return skipped(file.path, "missing chat_id");
  const updatedAt = file.value.updated_at ? Date.parse(file.value.updated_at) : NaN;
  const conversationId = stableConversationId(options.project, file.agent, options.accountLabel ?? "legacy", chatId, file.value.message_thread_id);
  const record = {
    conversation_id: conversationId,
    agent: file.agent,
    project: options.project,
    comm: "telegram",
    account_label: options.accountLabel ?? "legacy",
    chat_native_id: chatId,
    thread_native_id: file.value.message_thread_id,
    last_inbound_at: Number.isFinite(updatedAt) ? updatedAt : null,
    last_inbound_sender_id: file.value.from_user_id,
    source_file: file.path,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE
  };
  return {
    status: "imported",
    record,
    audit: {
      kind: "legacy_state_imported",
      source: "last-chat",
      path: file.path,
      detail: {
        agent: file.agent,
        chat_native_id: chatId,
        thread_native_id: file.value.message_thread_id,
        imported_as: "conversation-inventory"
      },
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE
    }
  };
}
function skipped(path14, reason) {
  return {
    status: "skipped",
    reason,
    source_file: path14,
    audit: {
      kind: "legacy_state_skipped",
      source: "last-chat",
      path: path14,
      reason,
      detail: {},
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE
    }
  };
}
function stableConversationId(project, agent, accountLabel, chatId, threadId) {
  return `legacy:${project}:${agent}:telegram:${accountLabel}:${chatId}:${threadId ?? ""}`;
}

// ../core-daemon/migrations/import-pending-permission.ts
function importPendingPermission(file, options) {
  const createdAt = Date.parse(file.value.timestamp);
  if (!Number.isFinite(createdAt)) return skipped2(file.path, "invalid timestamp");
  const ttlSeconds = options.ttlSeconds ?? 300;
  const now = options.now ?? Date.now();
  if (now - createdAt >= ttlSeconds * 1e3) return skipped2(file.path, "pending permission is expired");
  const kind = file.value.prompt_type === "question" ? "choice" : "approval";
  const record = {
    query_id: `legacy:${file.agent}:${createdAt}:${file.value.tool_name ?? "permission"}`,
    agent: file.agent,
    session: options.sessionId,
    kind,
    prompt_text: promptText(file.value),
    created_at: createdAt,
    ttl_seconds: ttlSeconds,
    chat_native_id: file.value.chat_id,
    thread_native_id: file.value.message_thread_id,
    source_file: file.path,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE
  };
  return {
    status: "imported",
    record,
    audit: {
      kind: "legacy_state_imported",
      source: "pending-permission",
      path: file.path,
      detail: {
        agent: file.agent,
        prompt_type: file.value.prompt_type,
        imported_as: "query"
      },
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE
    }
  };
}
function skipped2(path14, reason) {
  return {
    status: "skipped",
    reason,
    source_file: path14,
    audit: {
      kind: "legacy_state_skipped",
      source: "pending-permission",
      path: path14,
      reason,
      detail: {},
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE
    }
  };
}
function promptText(value) {
  const toolName = value.tool_name ?? "PermissionRequest";
  if (value.prompt_type === "question") return `${toolName} question`;
  if (value.prompt_type === "plan") return `${toolName} plan approval`;
  return `${toolName} approval`;
}

// ../core-daemon/cli/migrate.ts
function runMigration(options) {
  const startedAt = options.now ?? Date.now();
  const projectRoot = resolve2(options.projectRoot);
  const homeDir = resolve2(options.homeDir ?? homedir2());
  const audit = [
    { kind: "migration_scan_started", timestamp: startedAt, detail: { project_root: projectRoot, home_dir: homeDir } }
  ];
  const discovery = discoverLegacyInputs({ projectRoot, homeDir, now: startedAt });
  const warnings = [];
  const credentials = discovery.credentials.map((candidate) => {
    audit.push({
      kind: "credential_candidate_found",
      timestamp: startedAt,
      detail: sanitizedCredential(candidate),
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE
    });
    const confirmed = credentialConfirmed(candidate, options.confirmCredentials ?? "none");
    audit.push({
      kind: confirmed ? "credential_registration_accepted" : "credential_registration_skipped",
      timestamp: startedAt,
      detail: { ...sanitizedCredential(candidate), reason: confirmed ? "explicitly_confirmed" : "explicit_confirmation_required" },
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE
    });
    return { ...sanitizedCredential(candidate), confirmed };
  });
  const lastChatImports = [];
  const pendingImports = [];
  if (options.ingestState ?? true) {
    for (const file of discovery.lastChats) {
      const imported = importLastChat(file, { project: projectRoot });
      lastChatImports.push(imported);
      audit.push({ ...imported.audit, timestamp: startedAt });
    }
    for (const file of discovery.pendingPermissions) {
      const imported = importPendingPermission(file, {
        sessionId: `legacy:${file.agent}:${file.sessionRoot}`,
        now: startedAt
      });
      pendingImports.push(imported);
      audit.push({ ...imported.audit, timestamp: startedAt });
    }
  }
  for (const skipped3 of discovery.skipped) {
    audit.push({
      kind: "legacy_state_skipped",
      timestamp: startedAt,
      detail: { source: skipped3.kind, agent: skipped3.agent, path: skipped3.path, reason: skipped3.reason },
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE
    });
  }
  audit.push({
    kind: "migration_scan_completed",
    timestamp: startedAt,
    detail: {
      credentials: discovery.credentials.length,
      session_roots: discovery.sessionRoots.length,
      skipped: discovery.skipped.length
    }
  });
  if (credentials.some((credential) => credential.hasBotToken && !credential.confirmed)) {
    warnings.push("Credential candidates were discovered but not registered because explicit confirmation was not provided.");
  }
  const result = {
    schema_version: 1,
    started_at: startedAt,
    completed_at: options.now ?? Date.now(),
    project_root: projectRoot,
    home_dir: homeDir,
    credentials,
    state_ingestion: {
      mode: options.ingestState ?? true ? "read-only" : "disabled",
      last_chat: lastChatImports,
      pending_permission: pendingImports,
      queue_files_seen: discovery.queues.length
    },
    audit_events: audit,
    warnings,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE
  };
  if (options.outputJsonPath) {
    writeFileSync(options.outputJsonPath, `${JSON.stringify(result, null, 2)}
`, "utf8");
  }
  return result;
}
function parseMigrateArgs(argv) {
  const options = { projectRoot: process.cwd(), homeDir: homedir2(), confirmCredentials: "none", ingestState: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") options.projectRoot = requireValue(argv, ++index, arg);
    else if (arg === "--home") options.homeDir = requireValue(argv, ++index, arg);
    else if (arg === "--confirm-credentials") {
      const value = requireValue(argv, ++index, arg);
      options.confirmCredentials = value === "all" ? "all" : value.split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg === "--no-state-ingest") options.ingestState = false;
    else if (arg === "--json-out") options.outputJsonPath = requireValue(argv, ++index, arg);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}
function sanitizedCredential(candidate) {
  return {
    agent: candidate.agent,
    path: candidate.path,
    scope: candidate.scope,
    hasBotToken: candidate.hasBotToken,
    userIds: candidate.userIds,
    credentialRef: candidate.credentialRef
  };
}
function credentialConfirmed(candidate, confirmation) {
  if (confirmation === "all") return true;
  if (confirmation === "none" || confirmation == null) return false;
  return confirmation.includes(candidate.credentialRef) || confirmation.includes(candidate.path);
}
function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
function printHelp() {
  console.log(`agents-comm-bus migrate

Scans transition-only legacy Telegram files and emits an auditable migration result.

Options:
  --project <path>                 Project root to scan. Defaults to cwd.
  --home <path>                    Home directory containing legacy roots. Defaults to OS home.
  --confirm-credentials <all|refs> Explicitly accept credential refs or paths. Required for registration.
  --no-state-ingest                Disable read-only last-chat/pending-permission ingestion.
  --json-out <path>                Write result JSON to a file.
`);
}
var invokedPath = process.argv[1] ? pathToFileURL(resolve2(process.argv[1])).href : "";
var invokedIsMigrateEntry = /(^|[\\/])migrate(\.[cm]?[jt]s)?$/.test(process.argv[1] ?? "");
if (invokedIsMigrateEntry && import.meta.url === invokedPath) {
  try {
    const result = runMigration(parseMigrateArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// ../core-daemon/cli/reload-helper.ts
import { readFile as readFile8 } from "node:fs/promises";
async function reloadDaemonRegistrations(options = {}) {
  const statePaths = resolveStatePaths({
    stateRoot: process.env.AGENTS_COMM_BUS_ROOT ?? process.env.AGENTS_COMM_BUS_STATE_ROOT
  });
  const paths = resolveDiscoveryPaths({
    stateRoot: statePaths.root,
    discoveryRoot: process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT
  });
  const port = await readPortFile2(paths.portFile);
  if (port === void 0) {
    return { attempted: false, reason: "no daemon port file" };
  }
  const timeoutMs = options.timeoutMs ?? 2e3;
  let connection = null;
  try {
    connection = await connectIpc({
      port,
      clientVersion: DAEMON_VERSION,
      timeoutMs,
      metadata: { shimName: "agents-comm-bus/cli" }
    });
    const params = options.forceCredentialRefresh ? { forceCredentialRefresh: options.forceCredentialRefresh } : void 0;
    const summary = await connection.request("reload_registrations", params);
    return { attempted: true, ok: true, summary };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    connection?.close();
  }
}
async function readPortFile2(portFile) {
  try {
    const raw = (await readFile8(portFile, "utf8")).trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : void 0;
  } catch {
    return void 0;
  }
}

// ../core-daemon/cli/status.ts
import { readdir, readFile as readFile9 } from "node:fs/promises";
import os3 from "node:os";
import path13 from "node:path";
async function daemonStatus(options = {}) {
  const statePaths = resolveStatePaths({
    stateRoot: options.stateRoot ?? process.env.AGENTS_COMM_BUS_STATE_ROOT
  });
  const discoveryPaths = resolveDiscoveryPaths({
    stateRoot: statePaths.root,
    discoveryRoot: options.discoveryRoot ?? process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT
  });
  const pid = await readPidFile2(discoveryPaths.pidFile);
  const port = await readPortFile3(discoveryPaths.portFile);
  const commLeases = await listCommLeasesForPid(pid);
  const conversations = await listRecentConversations(statePaths.database);
  const watchers = await listWatcherPids(statePaths.root);
  if (port === void 0) {
    return {
      daemon: {
        reachable: false,
        pid,
        reason: pid === void 0 ? "daemon not running (no pid/port files)" : "daemon not running (stale port file)"
      },
      comm_leases: commLeases,
      conversations,
      watchers
    };
  }
  const timeoutMs = options.timeoutMs ?? 2e3;
  let connection = null;
  try {
    connection = await connectIpc({
      port,
      clientVersion: DAEMON_VERSION,
      timeoutMs,
      metadata: { shimName: "agents-comm-bus/cli", operation: "daemon_status" }
    });
    const runtime = await connection.request("daemon_status", {});
    return {
      daemon: {
        reachable: true,
        pid,
        port,
        version: connection.hello.daemonVersion,
        protocol_version: connection.hello.protocolVersion
      },
      runtime,
      comm_leases: commLeases,
      conversations,
      watchers
    };
  } catch (error) {
    return {
      daemon: {
        reachable: false,
        pid,
        port,
        reason: error instanceof Error ? error.message : String(error)
      },
      comm_leases: commLeases,
      conversations,
      watchers
    };
  } finally {
    connection?.close();
  }
}
function formatDaemonStatus(snapshot) {
  const lines = ["agents-comm-bus status", ""];
  if (snapshot.daemon.reachable) {
    lines.push(
      `daemon: up (pid ${snapshot.daemon.pid ?? "?"}, port ${snapshot.daemon.port ?? "?"}, version ${snapshot.daemon.version ?? "?"}, protocol ${snapshot.daemon.protocol_version ?? "?"})`
    );
    if (snapshot.runtime) {
      lines.push(
        `runtime: pendingInbound=${snapshot.runtime.pending_inbound_depth}, active_scopes=${snapshot.runtime.active_scope_count}, live_adapters=${snapshot.runtime.live_adapters.length}`
      );
      if (snapshot.runtime.live_adapters.length > 0) {
        lines.push(`  adapters: ${snapshot.runtime.live_adapters.join(", ")}`);
      }
    }
  } else {
    lines.push(`daemon: down (${snapshot.daemon.reason ?? "unreachable"})`);
    if (snapshot.daemon.pid !== void 0) {
      lines.push(`  pid file: ${snapshot.daemon.pid} (process may be stale)`);
    }
    if (snapshot.daemon.port !== void 0) {
      lines.push(`  port file: ${snapshot.daemon.port}`);
    }
  }
  lines.push("");
  lines.push(`comm leases (this pid): ${snapshot.comm_leases.length}`);
  for (const lease of snapshot.comm_leases.slice(0, 10)) {
    lines.push(`  ${lease.comm}/${lease.resource_id} rank=${lease.authority_rank} pid=${lease.pid}`);
  }
  if (snapshot.comm_leases.length > 10) {
    lines.push(`  ... +${snapshot.comm_leases.length - 10} more`);
  }
  lines.push("");
  lines.push(`recent conversations: ${snapshot.conversations.length}`);
  for (const row of snapshot.conversations.slice(0, 10)) {
    lines.push(
      `  ${row.agent}/${row.comm} chat=${row.chat_native_id} in=${formatTs(row.last_inbound_at)} out=${formatTs(row.last_outbound_at)}`
    );
  }
  if (snapshot.conversations.length > 10) {
    lines.push(`  ... +${snapshot.conversations.length - 10} more`);
  }
  lines.push("");
  lines.push(`claude watchers: ${snapshot.watchers.length}`);
  for (const watcher of snapshot.watchers.slice(0, 10)) {
    lines.push(`  ${watcher.session_key}: pid=${watcher.pid ?? "missing"}`);
  }
  if (snapshot.watchers.length > 10) {
    lines.push(`  ... +${snapshot.watchers.length - 10} more`);
  }
  return lines.join("\n");
}
async function readPidFile2(pidFile) {
  try {
    const raw = (await readFile9(pidFile, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : void 0;
  } catch {
    return void 0;
  }
}
async function readPortFile3(portFile) {
  try {
    const raw = (await readFile9(portFile, "utf8")).trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : void 0;
  } catch {
    return void 0;
  }
}
async function listCommLeasesForPid(pid) {
  if (pid === void 0) return [];
  const locksRoot = path13.join(os3.homedir(), ".agents-comm-bus", "comm-locks");
  const out = [];
  let commDirs;
  try {
    commDirs = await readdir(locksRoot);
  } catch {
    return out;
  }
  for (const comm of commDirs) {
    const commDir = path13.join(locksRoot, comm);
    let files;
    try {
      files = await readdir(commDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path13.join(commDir, file);
      try {
        const record = JSON.parse(await readFile9(filePath, "utf8"));
        if (record.pid !== pid) continue;
        out.push({
          comm: record.comm_id,
          resource_id: record.resource_id,
          pid: record.pid,
          authority_rank: record.authorityRank
        });
      } catch {
      }
    }
  }
  return out;
}
async function listRecentConversations(databasePath) {
  try {
    const storage = await openSqliteStorage(databasePath);
    const rows = await storage.listConversations({ limit: 25 });
    return rows.map((row) => ({
      conversation_id: row.conversation_id,
      agent: row.agent,
      comm: row.comm,
      chat_native_id: row.chat_native_id,
      last_inbound_at: row.last_inbound_at,
      last_outbound_at: row.last_outbound_at
    }));
  } catch {
    return [];
  }
}
async function listWatcherPids(stateRoot3) {
  const sessionsDir = path13.join(stateRoot3, "claude-wake", "sessions");
  const out = [];
  let sessionDirs;
  try {
    sessionDirs = await readdir(sessionsDir);
  } catch {
    return out;
  }
  for (const sessionKey of sessionDirs) {
    const pidFile = path13.join(sessionsDir, sessionKey, "watcher.pid");
    try {
      const raw = (await readFile9(pidFile, "utf8")).trim();
      const pid = Number(raw);
      out.push({
        session_key: sessionKey,
        pid: Number.isInteger(pid) && pid > 0 ? pid : null
      });
    } catch {
      out.push({ session_key: sessionKey, pid: null });
    }
  }
  return out;
}
function formatTs(value) {
  if (value == null) return "-";
  return new Date(value).toISOString();
}

// ../core-daemon/cli/index.ts
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case "account-add": {
      const rec = await accountAdd({
        project: required(args.project, "--project"),
        agent: required(args.agent, "--agent"),
        accountLabel: required(args.accountLabel ?? args["account-label"], "--account-label"),
        comm: args.comm,
        botToken: args.botToken ?? args["bot-token"]
      });
      const reload = await reloadDaemonRegistrations();
      console.log(JSON.stringify({ ...redact(rec), reload }, null, 2));
      return;
    }
    case "account-list": {
      const rows = await accountList({
        project: args.project,
        agent: args.agent,
        comm: args.comm
      });
      console.log(JSON.stringify(rows.map(redact), null, 2));
      return;
    }
    case "account-remove": {
      await accountRemove({
        project: args.project,
        agent: args.agent,
        comm: args.comm,
        accountLabel: args.accountLabel ?? args["account-label"],
        botId: args.botId ?? args["bot-id"]
      });
      const reload = await reloadDaemonRegistrations();
      console.log(JSON.stringify({ ok: true, reload }, null, 2));
      return;
    }
    case "account-relabel": {
      const result = await accountRelabel({
        project: args.project,
        agent: args.agent,
        comm: args.comm,
        accountLabel: args.accountLabel ?? args["account-label"],
        botId: args.botId ?? args["bot-id"],
        newAccountLabel: required(
          args.newAccountLabel ?? args["new-account-label"],
          "--new-account-label"
        )
      });
      const reload = await reloadDaemonRegistrations();
      console.log(JSON.stringify({ ...redact(result.next), relabel: relabelSummary(result), reload }, null, 2));
      return;
    }
    case "account-update-token": {
      const result = await accountUpdateToken({
        comm: args.comm,
        botId: args.botId ?? args["bot-id"],
        accountLabel: args.accountLabel ?? args["account-label"],
        agent: args.agent,
        project: args.project,
        botToken: required(args.botToken ?? args["bot-token"], "--bot-token"),
        allowBotChange: args.allowBotChange !== void 0 || args["allow-bot-change"] !== void 0
      });
      const reload = await reloadDaemonRegistrations({
        forceCredentialRefresh: result.bot_changed ? [] : [{ comm: result.next.comm, accountId: result.next.bot_user_id }]
      });
      console.log(JSON.stringify({ ...redact(result.next), update: resultSummary(result), reload }, null, 2));
      return;
    }
    case "allowlist": {
      await handleAllowlist(rest);
      return;
    }
    case "migrate": {
      const result = runMigration(parseMigrateArgs(rest));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "status": {
      const snapshot = await daemonStatus({
        stateRoot: args.stateRoot ?? args["state-root"],
        discoveryRoot: args.discoveryRoot ?? args["discovery-root"]
      });
      if (args.json !== void 0 || args["json"] !== void 0) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        console.log(formatDaemonStatus(snapshot));
      }
      return;
    }
    default:
      printHelp2();
      process.exit(command ? 1 : 0);
  }
}
async function handleAllowlist(rest) {
  const [sub, ...subRest] = rest;
  const args = parseArgs(subRest);
  switch (sub) {
    case "add": {
      const scope = allowlistScopeFromArgs(args);
      const out = await allowlistAdd({
        comm: required(args.comm, "--comm"),
        user: required(args.user, "--user"),
        note: args.note,
        scope,
        botId: args.botId ?? args["bot-id"],
        agent: args.agent,
        project: args.project,
        accountLabel: args.accountLabel ?? args["account-label"]
      });
      const reload = await reloadDaemonRegistrations();
      console.log(JSON.stringify({ ...out, reload }, null, 2));
      return;
    }
    case "remove": {
      const scope = allowlistScopeFromArgs(args);
      const out = await allowlistRemove({
        comm: required(args.comm, "--comm"),
        user: required(args.user, "--user"),
        scope,
        botId: args.botId ?? args["bot-id"],
        agent: args.agent,
        project: args.project,
        accountLabel: args.accountLabel ?? args["account-label"]
      });
      const reload = await reloadDaemonRegistrations();
      console.log(JSON.stringify({ ...out, reload }, null, 2));
      return;
    }
    case "list": {
      const scopeArg = args.scope;
      if (scopeArg && scopeArg !== "global" && scopeArg !== "per-bot" && scopeArg !== "all") {
        throw new Error("--scope must be one of: global | per-bot | all");
      }
      const out = await allowlistList({
        comm: args.comm,
        scope: scopeArg,
        botId: args.botId ?? args["bot-id"],
        agent: args.agent,
        project: args.project,
        accountLabel: args.accountLabel ?? args["account-label"]
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case "import-from-env": {
      const out = await allowlistImportFromEnv({ comm: args.comm });
      const reload = await reloadDaemonRegistrations();
      console.log(JSON.stringify({ ...out, reload }, null, 2));
      return;
    }
    case "import-from-files": {
      const dryRun = args.dryRun !== void 0 || args["dry-run"] !== void 0;
      const out = await allowlistImportFromFiles({ comm: args.comm, dryRun });
      const reload = dryRun ? { attempted: false, reason: "dry-run" } : await reloadDaemonRegistrations();
      console.log(JSON.stringify({ ...out, reload }, null, 2));
      return;
    }
    default:
      printHelp2();
      throw new Error(`unknown allowlist subcommand: ${sub ?? "(none)"}`);
  }
}
function allowlistScopeFromArgs(args) {
  const hasPerBotSelector = Boolean(
    args.botId ?? args["bot-id"] ?? args.agent ?? args.project ?? args.accountLabel ?? args["account-label"]
  );
  return hasPerBotSelector ? "per-bot" : "global";
}
function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = args[i + 1]?.startsWith("--") ? void 0 : args[++i];
    parsed[key] = value;
    parsed[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return parsed;
}
function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
function redact(row) {
  return { ...row, credentials_ref: row.credentials_ref ? "[redacted]" : row.credentials_ref };
}
function printHelp2() {
  console.error(`agents-comm-bus CLI

Account commands:
  agents-comm-bus account-add --project <path> --agent <agent> --account-label <label> --bot-token <token>
  agents-comm-bus account-list [--project <path>] [--agent <agent>] [--comm telegram]
  agents-comm-bus account-remove [--comm telegram] (--bot-id <id> | --account-label <label> [--agent <agent>] [--project <path>])
  agents-comm-bus account-relabel [--comm telegram] (--bot-id <id> | --account-label <label> [--agent <agent>] [--project <path>]) --new-account-label <label>
  agents-comm-bus account-update-token [--comm telegram] (--bot-id <id> | --account-label <label> [--agent <agent>] [--project <path>]) --bot-token <token> [--allow-bot-change]

Allowlist commands:
  agents-comm-bus allowlist add    --comm <c> --user <id> [--note "..."]                                                      # global
  agents-comm-bus allowlist add    --comm <c> --user <id> (--bot-id <id> | --account-label <label> [--agent <a>] [--project <p>])
  agents-comm-bus allowlist remove --comm <c> --user <id> (--bot-id <id> | --account-label <label> [--agent <a>] [--project <p>])
  agents-comm-bus allowlist list   [--comm <c>] [--scope global|per-bot|all] [--bot-id <id> | --account-label <label> [--agent <a>] [--project <p>]]
  agents-comm-bus allowlist import-from-env   [--comm telegram]
  agents-comm-bus allowlist import-from-files [--comm telegram] [--dry-run]

Diagnostics:
  agents-comm-bus status [--json] [--state-root <path>] [--discovery-root <path>]

--bot-id is canonical for per-bot commands. Label selectors are accepted only when they resolve to exactly one account.
account-add stores --bot-token in a daemon-owned file ref; credentials_ref is not user-supplied.
`);
}
function resultSummary(result) {
  return {
    previous_bot_user_id: result.previous.bot_user_id,
    bot_user_id: result.next.bot_user_id,
    bot_changed: result.bot_changed,
    migrated_allowlist_rows: result.migrated_allowlist_rows,
    migrated_conversation_rows: result.migrated_conversation_rows
  };
}
function relabelSummary(result) {
  return {
    previous_account_label: result.previous.account_label,
    account_label: result.next.account_label,
    bot_user_id: result.next.bot_user_id
  };
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
