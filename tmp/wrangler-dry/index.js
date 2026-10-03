var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/polyfills.js
import { EventEmitter } from "node:events";
import { Buffer as Buffer2 } from "node:buffer";
var Crypto = globalThis.crypto;
var ids = 1;
var tasks = /* @__PURE__ */ new Set();
var v4Seg = "(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])";
var v4Str = `(${v4Seg}[.]){3}${v4Seg}`;
var IPv4Reg = new RegExp(`^${v4Str}$`);
var v6Seg = "(?:[0-9a-fA-F]{1,4})";
var IPv6Reg = new RegExp(
  `^((?:${v6Seg}:){7}(?:${v6Seg}|:)|(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|(?:${v6Seg}:){5}(?::${v4Str}|(:${v6Seg}){1,2}|:)|(?:${v6Seg}:){4}(?:(:${v6Seg}){0,1}:${v4Str}|(:${v6Seg}){1,3}|:)|(?:${v6Seg}:){3}(?:(:${v6Seg}){0,2}:${v4Str}|(:${v6Seg}){1,4}|:)|(?:${v6Seg}:){2}(?:(:${v6Seg}){0,3}:${v4Str}|(:${v6Seg}){1,5}|:)|(?:${v6Seg}:){1}(?:(:${v6Seg}){0,4}:${v4Str}|(:${v6Seg}){1,6}|:)|(?::((?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:)))(%[0-9a-zA-Z-.:]{1,})?$`
);
var textEncoder = new TextEncoder();
var crypto2 = {
  randomBytes: /* @__PURE__ */ __name((l) => Crypto.getRandomValues(Buffer2.alloc(l)), "randomBytes"),
  pbkdf2Sync: /* @__PURE__ */ __name(async (password, salt, iterations, keylen) => Crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    await Crypto.subtle.importKey(
      "raw",
      textEncoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    ),
    keylen * 8,
    ["deriveBits"]
  ), "pbkdf2Sync"),
  createHash: /* @__PURE__ */ __name((type) => ({
    update: /* @__PURE__ */ __name((x) => ({
      digest: /* @__PURE__ */ __name((encoding) => {
        if (!(x instanceof Uint8Array)) {
          x = textEncoder.encode(x);
        }
        let prom;
        if (type === "sha256") {
          prom = Crypto.subtle.digest("SHA-256", x);
        } else if (type === "md5") {
          prom = Crypto.subtle.digest("md5", x);
        } else {
          throw Error("createHash only supports sha256 or md5 in this environment, not ${type}.");
        }
        if (encoding === "hex") {
          return prom.then((arrayBuf) => Buffer2.from(arrayBuf).toString("hex"));
        } else if (encoding) {
          throw Error(`createHash only supports hex encoding or unencoded in this environment, not ${encoding}`);
        } else {
          return prom;
        }
      }, "digest")
    }), "update")
  }), "createHash"),
  createHmac: /* @__PURE__ */ __name((type, key) => ({
    update: /* @__PURE__ */ __name((x) => ({
      digest: /* @__PURE__ */ __name(async () => Buffer2.from(
        await Crypto.subtle.sign(
          "HMAC",
          await Crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
          textEncoder.encode(x)
        )
      ), "digest")
    }), "update")
  }), "createHmac")
};
var performance = globalThis.performance;
var process = {
  env: {}
};
var os = {
  userInfo() {
    return { username: "postgres" };
  }
};
var fs = {
  readFile() {
    throw new Error("Reading files not supported on CloudFlare");
  }
};
var net = {
  isIP: /* @__PURE__ */ __name((x) => IPv4Reg.test(x) ? 4 : IPv6Reg.test(x) ? 6 : 0, "isIP"),
  Socket
};
var tls = {
  connect({ socket: tcp, servername }) {
    tcp.writer.releaseLock();
    tcp.reader.releaseLock();
    tcp.readyState = "upgrading";
    tcp.raw = tcp.raw.startTls({ servername });
    tcp.raw.closed.then(
      () => tcp.emit("close"),
      (e) => tcp.emit("error", e)
    );
    tcp.writer = tcp.raw.writable.getWriter();
    tcp.reader = tcp.raw.readable.getReader();
    tcp.writer.ready.then(() => {
      tcp.read();
      tcp.readyState = "upgrade";
    });
    return tcp;
  }
};
function Socket() {
  const tcp = Object.assign(new EventEmitter(), {
    readyState: "open",
    raw: null,
    writer: null,
    reader: null,
    connect,
    write,
    end,
    destroy,
    read
  });
  return tcp;
  async function connect(port, host) {
    try {
      tcp.readyState = "opening";
      const { connect: connect2 } = await import("cloudflare:sockets");
      tcp.raw = connect2(host + ":" + port, tcp.ssl ? { secureTransport: "starttls" } : {});
      tcp.raw.closed.then(
        () => {
          tcp.readyState !== "upgrade" ? close() : (tcp.readyState = "open", tcp.emit("secureConnect"));
        },
        (e) => tcp.emit("error", e)
      );
      tcp.writer = tcp.raw.writable.getWriter();
      tcp.reader = tcp.raw.readable.getReader();
      tcp.ssl ? readFirst() : read();
      tcp.writer.ready.then(() => {
        tcp.readyState = "open";
        tcp.emit("connect");
      });
    } catch (err) {
      error(err);
    }
  }
  __name(connect, "connect");
  function close() {
    if (tcp.readyState === "closed")
      return;
    tcp.readyState = "closed";
    tcp.emit("close");
  }
  __name(close, "close");
  function write(data, cb) {
    tcp.writer.write(data).then(cb, error);
    return true;
  }
  __name(write, "write");
  function end(data) {
    return data ? tcp.write(data, () => tcp.raw.close()) : tcp.raw.close();
  }
  __name(end, "end");
  function destroy() {
    tcp.destroyed = true;
    tcp.end();
  }
  __name(destroy, "destroy");
  async function read() {
    try {
      let done, value;
      while ({ done, value } = await tcp.reader.read(), !done)
        tcp.emit("data", Buffer2.from(value));
    } catch (err) {
      error(err);
    }
  }
  __name(read, "read");
  async function readFirst() {
    const { value } = await tcp.reader.read();
    tcp.emit("data", Buffer2.from(value));
  }
  __name(readFirst, "readFirst");
  function error(err) {
    tcp.emit("error", err);
    tcp.emit("close");
  }
  __name(error, "error");
}
__name(Socket, "Socket");
function setImmediate(fn) {
  const id = ids++;
  tasks.add(id);
  queueMicrotask(() => {
    if (tasks.has(id)) {
      fn();
      tasks.delete(id);
    }
  });
  return id;
}
__name(setImmediate, "setImmediate");
function clearImmediate(id) {
  tasks.delete(id);
}
__name(clearImmediate, "clearImmediate");

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/types.js
import { Buffer as Buffer3 } from "node:buffer";

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/query.js
var originCache = /* @__PURE__ */ new Map();
var originStackCache = /* @__PURE__ */ new Map();
var originError = /* @__PURE__ */ Symbol("OriginError");
var CLOSE = {};
var Query = class extends Promise {
  static {
    __name(this, "Query");
  }
  constructor(strings, args, handler, canceller, options = {}) {
    let resolve, reject;
    super((a, b2) => {
      resolve = a;
      reject = b2;
    });
    this.tagged = Array.isArray(strings.raw);
    this.strings = strings;
    this.args = args;
    this.handler = handler;
    this.canceller = canceller;
    this.options = options;
    this.state = null;
    this.statement = null;
    this.resolve = (x) => (this.active = false, resolve(x));
    this.reject = (x) => (this.active = false, reject(x));
    this.active = false;
    this.cancelled = null;
    this.executed = false;
    this.signature = "";
    this[originError] = this.handler.debug ? new Error() : this.tagged && cachedError(this.strings);
  }
  get origin() {
    return (this.handler.debug ? this[originError].stack : this.tagged && originStackCache.has(this.strings) ? originStackCache.get(this.strings) : originStackCache.set(this.strings, this[originError].stack).get(this.strings)) || "";
  }
  static get [Symbol.species]() {
    return Promise;
  }
  cancel() {
    return this.canceller && (this.canceller(this), this.canceller = null);
  }
  simple() {
    this.options.simple = true;
    this.options.prepare = false;
    return this;
  }
  async readable() {
    this.simple();
    this.streaming = true;
    return this;
  }
  async writable() {
    this.simple();
    this.streaming = true;
    return this;
  }
  cursor(rows = 1, fn) {
    this.options.simple = false;
    if (typeof rows === "function") {
      fn = rows;
      rows = 1;
    }
    this.cursorRows = rows;
    if (typeof fn === "function")
      return this.cursorFn = fn, this;
    let prev;
    return {
      [Symbol.asyncIterator]: () => ({
        next: /* @__PURE__ */ __name(() => {
          if (this.executed && !this.active)
            return { done: true };
          prev && prev();
          const promise = new Promise((resolve, reject) => {
            this.cursorFn = (value) => {
              resolve({ value, done: false });
              return new Promise((r) => prev = r);
            };
            this.resolve = () => (this.active = false, resolve({ done: true }));
            this.reject = (x) => (this.active = false, reject(x));
          });
          this.execute();
          return promise;
        }, "next"),
        return() {
          prev && prev(CLOSE);
          return { done: true };
        }
      })
    };
  }
  describe() {
    this.options.simple = false;
    this.onlyDescribe = this.options.prepare = true;
    return this;
  }
  stream() {
    throw new Error(".stream has been renamed to .forEach");
  }
  forEach(fn) {
    this.forEachFn = fn;
    this.handle();
    return this;
  }
  raw() {
    this.isRaw = true;
    return this;
  }
  values() {
    this.isRaw = "values";
    return this;
  }
  async handle() {
    !this.executed && (this.executed = true) && await 1 && this.handler(this);
  }
  execute() {
    this.handle();
    return this;
  }
  then() {
    this.handle();
    return super.then.apply(this, arguments);
  }
  catch() {
    this.handle();
    return super.catch.apply(this, arguments);
  }
  finally() {
    this.handle();
    return super.finally.apply(this, arguments);
  }
};
function cachedError(xs) {
  if (originCache.has(xs))
    return originCache.get(xs);
  const x = Error.stackTraceLimit;
  Error.stackTraceLimit = 4;
  originCache.set(xs, new Error());
  Error.stackTraceLimit = x;
  return originCache.get(xs);
}
__name(cachedError, "cachedError");

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/errors.js
var PostgresError = class extends Error {
  static {
    __name(this, "PostgresError");
  }
  constructor(x) {
    super(x.message);
    this.name = this.constructor.name;
    Object.assign(this, x);
  }
};
var Errors = {
  connection,
  postgres,
  generic,
  notSupported
};
function connection(x, options, socket) {
  const { host, port } = socket || options;
  const error = Object.assign(
    new Error("write " + x + " " + (options.path || host + ":" + port)),
    {
      code: x,
      errno: x,
      address: options.path || host
    },
    options.path ? {} : { port }
  );
  Error.captureStackTrace(error, connection);
  return error;
}
__name(connection, "connection");
function postgres(x) {
  const error = new PostgresError(x);
  Error.captureStackTrace(error, postgres);
  return error;
}
__name(postgres, "postgres");
function generic(code, message) {
  const error = Object.assign(new Error(code + ": " + message), { code });
  Error.captureStackTrace(error, generic);
  return error;
}
__name(generic, "generic");
function notSupported(x) {
  const error = Object.assign(
    new Error(x + " (B) is not supported"),
    {
      code: "MESSAGE_NOT_SUPPORTED",
      name: x
    }
  );
  Error.captureStackTrace(error, notSupported);
  return error;
}
__name(notSupported, "notSupported");

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/types.js
var types = {
  string: {
    to: 25,
    from: null,
    // defaults to string
    serialize: /* @__PURE__ */ __name((x) => "" + x, "serialize")
  },
  number: {
    to: 0,
    from: [21, 23, 26, 700, 701],
    serialize: /* @__PURE__ */ __name((x) => "" + x, "serialize"),
    parse: /* @__PURE__ */ __name((x) => +x, "parse")
  },
  json: {
    to: 114,
    from: [114, 3802],
    serialize: /* @__PURE__ */ __name((x) => JSON.stringify(x), "serialize"),
    parse: /* @__PURE__ */ __name((x) => JSON.parse(x), "parse")
  },
  boolean: {
    to: 16,
    from: 16,
    serialize: /* @__PURE__ */ __name((x) => x === true ? "t" : "f", "serialize"),
    parse: /* @__PURE__ */ __name((x) => x === "t", "parse")
  },
  date: {
    to: 1184,
    from: [1082, 1114, 1184],
    serialize: /* @__PURE__ */ __name((x) => (x instanceof Date ? x : new Date(x)).toISOString(), "serialize"),
    parse: /* @__PURE__ */ __name((x) => new Date(x), "parse")
  },
  bytea: {
    to: 17,
    from: 17,
    serialize: /* @__PURE__ */ __name((x) => "\\x" + Buffer3.from(x).toString("hex"), "serialize"),
    parse: /* @__PURE__ */ __name((x) => Buffer3.from(x.slice(2), "hex"), "parse")
  }
};
var NotTagged = class {
  static {
    __name(this, "NotTagged");
  }
  then() {
    notTagged();
  }
  catch() {
    notTagged();
  }
  finally() {
    notTagged();
  }
};
var Identifier = class extends NotTagged {
  static {
    __name(this, "Identifier");
  }
  constructor(value) {
    super();
    this.value = escapeIdentifier(value);
  }
};
var Parameter = class extends NotTagged {
  static {
    __name(this, "Parameter");
  }
  constructor(value, type, array) {
    super();
    this.value = value;
    this.type = type;
    this.array = array;
  }
};
var Builder = class extends NotTagged {
  static {
    __name(this, "Builder");
  }
  constructor(first, rest) {
    super();
    this.first = first;
    this.rest = rest;
  }
  build(before, parameters, types2, options) {
    const keyword = builders.map(([x, fn]) => ({ fn, i: before.search(x) })).sort((a, b2) => a.i - b2.i).pop();
    return keyword.i === -1 ? escapeIdentifiers(this.first, options) : keyword.fn(this.first, this.rest, parameters, types2, options);
  }
};
function handleValue(x, parameters, types2, options) {
  let value = x instanceof Parameter ? x.value : x;
  if (value === void 0) {
    x instanceof Parameter ? x.value = options.transform.undefined : value = x = options.transform.undefined;
    if (value === void 0)
      throw Errors.generic("UNDEFINED_VALUE", "Undefined values are not allowed");
  }
  return "$" + types2.push(
    x instanceof Parameter ? (parameters.push(x.value), x.array ? x.array[x.type || inferType(x.value)] || x.type || firstIsString(x.value) : x.type) : (parameters.push(x), inferType(x))
  );
}
__name(handleValue, "handleValue");
var defaultHandlers = typeHandlers(types);
function stringify(q, string, value, parameters, types2, options) {
  for (let i = 1; i < q.strings.length; i++) {
    string += stringifyValue(string, value, parameters, types2, options) + q.strings[i];
    value = q.args[i];
  }
  return string;
}
__name(stringify, "stringify");
function stringifyValue(string, value, parameters, types2, o) {
  return value instanceof Builder ? value.build(string, parameters, types2, o) : value instanceof Query ? fragment(value, parameters, types2, o) : value instanceof Identifier ? value.value : value && value[0] instanceof Query ? value.reduce((acc, x) => acc + " " + fragment(x, parameters, types2, o), "") : handleValue(value, parameters, types2, o);
}
__name(stringifyValue, "stringifyValue");
function fragment(q, parameters, types2, options) {
  q.fragment = true;
  return stringify(q, q.strings[0], q.args[0], parameters, types2, options);
}
__name(fragment, "fragment");
function valuesBuilder(first, parameters, types2, columns, options) {
  return first.map(
    (row) => "(" + columns.map(
      (column) => stringifyValue("values", row[column], parameters, types2, options)
    ).join(",") + ")"
  ).join(",");
}
__name(valuesBuilder, "valuesBuilder");
function values(first, rest, parameters, types2, options) {
  const multi = Array.isArray(first[0]);
  const columns = rest.length ? rest.flat() : Object.keys(multi ? first[0] : first);
  return valuesBuilder(multi ? first : [first], parameters, types2, columns, options);
}
__name(values, "values");
function select(first, rest, parameters, types2, options) {
  typeof first === "string" && (first = [first].concat(rest));
  if (Array.isArray(first))
    return escapeIdentifiers(first, options);
  let value;
  const columns = rest.length ? rest.flat() : Object.keys(first);
  return columns.map((x) => {
    value = first[x];
    return (value instanceof Query ? fragment(value, parameters, types2, options) : value instanceof Identifier ? value.value : handleValue(value, parameters, types2, options)) + " as " + escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x);
  }).join(",");
}
__name(select, "select");
var builders = Object.entries({
  values,
  in: /* @__PURE__ */ __name((...xs) => {
    const x = values(...xs);
    return x === "()" ? "(null)" : x;
  }, "in"),
  select,
  as: select,
  returning: select,
  "\\(": select,
  update(first, rest, parameters, types2, options) {
    return (rest.length ? rest.flat() : Object.keys(first)).map(
      (x) => escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x) + "=" + stringifyValue("values", first[x], parameters, types2, options)
    );
  },
  insert(first, rest, parameters, types2, options) {
    const columns = rest.length ? rest.flat() : Object.keys(Array.isArray(first) ? first[0] : first);
    return "(" + escapeIdentifiers(columns, options) + ")values" + valuesBuilder(Array.isArray(first) ? first : [first], parameters, types2, columns, options);
  }
}).map(([x, fn]) => [new RegExp("((?:^|[\\s(])" + x + "(?:$|[\\s(]))(?![\\s\\S]*\\1)", "i"), fn]);
function notTagged() {
  throw Errors.generic("NOT_TAGGED_CALL", "Query not called as a tagged template literal");
}
__name(notTagged, "notTagged");
var serializers = defaultHandlers.serializers;
var parsers = defaultHandlers.parsers;
function firstIsString(x) {
  if (Array.isArray(x))
    return firstIsString(x[0]);
  return typeof x === "string" ? 1009 : 0;
}
__name(firstIsString, "firstIsString");
var mergeUserTypes = /* @__PURE__ */ __name(function(types2) {
  const user = typeHandlers(types2 || {});
  return {
    serializers: Object.assign({}, serializers, user.serializers),
    parsers: Object.assign({}, parsers, user.parsers)
  };
}, "mergeUserTypes");
function typeHandlers(types2) {
  return Object.keys(types2).reduce((acc, k) => {
    types2[k].from && [].concat(types2[k].from).forEach((x) => acc.parsers[x] = types2[k].parse);
    if (types2[k].serialize) {
      acc.serializers[types2[k].to] = types2[k].serialize;
      types2[k].from && [].concat(types2[k].from).forEach((x) => acc.serializers[x] = types2[k].serialize);
    }
    return acc;
  }, { parsers: {}, serializers: {} });
}
__name(typeHandlers, "typeHandlers");
function escapeIdentifiers(xs, { transform: { column } }) {
  return xs.map((x) => escapeIdentifier(column.to ? column.to(x) : x)).join(",");
}
__name(escapeIdentifiers, "escapeIdentifiers");
var escapeIdentifier = /* @__PURE__ */ __name(function escape(str) {
  return '"' + str.replace(/"/g, '""').replace(/\./g, '"."') + '"';
}, "escape");
var inferType = /* @__PURE__ */ __name(function inferType2(x) {
  return x instanceof Parameter ? x.type : x instanceof Date ? 1184 : x instanceof Uint8Array ? 17 : x === true || x === false ? 16 : typeof x === "bigint" ? 20 : Array.isArray(x) ? inferType2(x[0]) : 0;
}, "inferType");
var escapeBackslash = /\\/g;
var escapeQuote = /"/g;
function arrayEscape(x) {
  return x.replace(escapeBackslash, "\\\\").replace(escapeQuote, '\\"');
}
__name(arrayEscape, "arrayEscape");
var arraySerializer = /* @__PURE__ */ __name(function arraySerializer2(xs, serializer, options, typarray) {
  if (Array.isArray(xs) === false)
    return xs;
  if (!xs.length)
    return "{}";
  const first = xs[0];
  const delimiter = typarray === 1020 ? ";" : ",";
  if (Array.isArray(first) && !first.type)
    return "{" + xs.map((x) => arraySerializer2(x, serializer, options, typarray)).join(delimiter) + "}";
  return "{" + xs.map((x) => {
    if (x === void 0) {
      x = options.transform.undefined;
      if (x === void 0)
        throw Errors.generic("UNDEFINED_VALUE", "Undefined values are not allowed");
    }
    return x === null ? "null" : '"' + arrayEscape(serializer ? serializer(x.type ? x.value : x) : "" + x) + '"';
  }).join(delimiter) + "}";
}, "arraySerializer");
var arrayParserState = {
  i: 0,
  char: null,
  str: "",
  quoted: false,
  last: 0
};
var arrayParser = /* @__PURE__ */ __name(function arrayParser2(x, parser, typarray) {
  arrayParserState.i = arrayParserState.last = 0;
  return arrayParserLoop(arrayParserState, x, parser, typarray);
}, "arrayParser");
function arrayParserLoop(s, x, parser, typarray) {
  const xs = [];
  const delimiter = typarray === 1020 ? ";" : ",";
  for (; s.i < x.length; s.i++) {
    s.char = x[s.i];
    if (s.quoted) {
      if (s.char === "\\") {
        s.str += x[++s.i];
      } else if (s.char === '"') {
        xs.push(parser ? parser(s.str) : s.str);
        s.str = "";
        s.quoted = x[s.i + 1] === '"';
        s.last = s.i + 2;
      } else {
        s.str += s.char;
      }
    } else if (s.char === '"') {
      s.quoted = true;
    } else if (s.char === "{") {
      s.last = ++s.i;
      xs.push(arrayParserLoop(s, x, parser, typarray));
    } else if (s.char === "}") {
      s.quoted = false;
      s.last < s.i && xs.push(parser ? parser(x.slice(s.last, s.i)) : x.slice(s.last, s.i));
      s.last = s.i + 1;
      break;
    } else if (s.char === delimiter && s.p !== "}" && s.p !== '"') {
      xs.push(parser ? parser(x.slice(s.last, s.i)) : x.slice(s.last, s.i));
      s.last = s.i + 1;
    }
    s.p = s.char;
  }
  s.last < s.i && xs.push(parser ? parser(x.slice(s.last, s.i + 1)) : x.slice(s.last, s.i + 1));
  return xs;
}
__name(arrayParserLoop, "arrayParserLoop");
var toCamel = /* @__PURE__ */ __name((x) => {
  let str = x[0];
  for (let i = 1; i < x.length; i++)
    str += x[i] === "_" ? x[++i].toUpperCase() : x[i];
  return str;
}, "toCamel");
var toPascal = /* @__PURE__ */ __name((x) => {
  let str = x[0].toUpperCase();
  for (let i = 1; i < x.length; i++)
    str += x[i] === "_" ? x[++i].toUpperCase() : x[i];
  return str;
}, "toPascal");
var toKebab = /* @__PURE__ */ __name((x) => x.replace(/_/g, "-"), "toKebab");
var fromCamel = /* @__PURE__ */ __name((x) => x.replace(/([A-Z])/g, "_$1").toLowerCase(), "fromCamel");
var fromPascal = /* @__PURE__ */ __name((x) => (x.slice(0, 1) + x.slice(1).replace(/([A-Z])/g, "_$1")).toLowerCase(), "fromPascal");
var fromKebab = /* @__PURE__ */ __name((x) => x.replace(/-/g, "_"), "fromKebab");
function createJsonTransform(fn) {
  return /* @__PURE__ */ __name(function jsonTransform(x, column) {
    return typeof x === "object" && x !== null && (column.type === 114 || column.type === 3802) ? Array.isArray(x) ? x.map((x2) => jsonTransform(x2, column)) : Object.entries(x).reduce((acc, [k, v]) => Object.assign(acc, { [fn(k)]: jsonTransform(v, column) }), {}) : x;
  }, "jsonTransform");
}
__name(createJsonTransform, "createJsonTransform");
toCamel.column = { from: toCamel };
toCamel.value = { from: createJsonTransform(toCamel) };
fromCamel.column = { to: fromCamel };
var camel = { ...toCamel };
camel.column.to = fromCamel;
toPascal.column = { from: toPascal };
toPascal.value = { from: createJsonTransform(toPascal) };
fromPascal.column = { to: fromPascal };
var pascal = { ...toPascal };
pascal.column.to = fromPascal;
toKebab.column = { from: toKebab };
toKebab.value = { from: createJsonTransform(toKebab) };
fromKebab.column = { to: fromKebab };
var kebab = { ...toKebab };
kebab.column.to = fromKebab;

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/connection.js
import { Buffer as Buffer5 } from "node:buffer";
import Stream from "node:stream";

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/result.js
var Result = class extends Array {
  static {
    __name(this, "Result");
  }
  constructor() {
    super();
    Object.defineProperties(this, {
      count: { value: null, writable: true },
      state: { value: null, writable: true },
      command: { value: null, writable: true },
      columns: { value: null, writable: true },
      statement: { value: null, writable: true }
    });
  }
  static get [Symbol.species]() {
    return Array;
  }
};

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/queue.js
var queue_default = Queue;
function Queue(initial = []) {
  let xs = initial.slice();
  let index = 0;
  return {
    get length() {
      return xs.length - index;
    },
    remove: /* @__PURE__ */ __name((x) => {
      const index2 = xs.indexOf(x);
      return index2 === -1 ? null : (xs.splice(index2, 1), x);
    }, "remove"),
    push: /* @__PURE__ */ __name((x) => (xs.push(x), x), "push"),
    shift: /* @__PURE__ */ __name(() => {
      const out = xs[index++];
      if (index === xs.length) {
        index = 0;
        xs = [];
      } else {
        xs[index - 1] = void 0;
      }
      return out;
    }, "shift")
  };
}
__name(Queue, "Queue");

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/bytes.js
import { Buffer as Buffer4 } from "node:buffer";
var size = 256;
var buffer = Buffer4.allocUnsafe(size);
var messages = "BCcDdEFfHPpQSX".split("").reduce((acc, x) => {
  const v = x.charCodeAt(0);
  acc[x] = () => {
    buffer[0] = v;
    b.i = 5;
    return b;
  };
  return acc;
}, {});
var b = Object.assign(reset, messages, {
  N: String.fromCharCode(0),
  i: 0,
  inc(x) {
    b.i += x;
    return b;
  },
  str(x) {
    const length = Buffer4.byteLength(x);
    fit(length);
    b.i += buffer.write(x, b.i, length, "utf8");
    return b;
  },
  i16(x) {
    fit(2);
    buffer.writeUInt16BE(x, b.i);
    b.i += 2;
    return b;
  },
  i32(x, i) {
    if (i || i === 0) {
      buffer.writeUInt32BE(x, i);
      return b;
    }
    fit(4);
    buffer.writeUInt32BE(x, b.i);
    b.i += 4;
    return b;
  },
  z(x) {
    fit(x);
    buffer.fill(0, b.i, b.i + x);
    b.i += x;
    return b;
  },
  raw(x) {
    buffer = Buffer4.concat([buffer.subarray(0, b.i), x]);
    b.i = buffer.length;
    return b;
  },
  end(at = 1) {
    buffer.writeUInt32BE(b.i - at, at);
    const out = buffer.subarray(0, b.i);
    b.i = 0;
    buffer = Buffer4.allocUnsafe(size);
    return out;
  }
});
var bytes_default = b;
function fit(x) {
  if (buffer.length - b.i < x) {
    const prev = buffer, length = prev.length;
    buffer = Buffer4.allocUnsafe(length + (length >> 1) + x);
    prev.copy(buffer);
  }
}
__name(fit, "fit");
function reset() {
  b.i = 0;
  return b;
}
__name(reset, "reset");

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/connection.js
var connection_default = Connection;
var uid = 1;
var Sync = bytes_default().S().end();
var Flush = bytes_default().H().end();
var SSLRequest = bytes_default().i32(8).i32(80877103).end(8);
var ExecuteUnnamed = Buffer5.concat([bytes_default().E().str(bytes_default.N).i32(0).end(), Sync]);
var DescribeUnnamed = bytes_default().D().str("S").str(bytes_default.N).end();
var noop = /* @__PURE__ */ __name(() => {
}, "noop");
var retryRoutines = /* @__PURE__ */ new Set([
  "FetchPreparedStatement",
  "RevalidateCachedQuery",
  "transformAssignedExpr"
]);
var errorFields = {
  83: "severity_local",
  // S
  86: "severity",
  // V
  67: "code",
  // C
  77: "message",
  // M
  68: "detail",
  // D
  72: "hint",
  // H
  80: "position",
  // P
  112: "internal_position",
  // p
  113: "internal_query",
  // q
  87: "where",
  // W
  115: "schema_name",
  // s
  116: "table_name",
  // t
  99: "column_name",
  // c
  100: "data type_name",
  // d
  110: "constraint_name",
  // n
  70: "file",
  // F
  76: "line",
  // L
  82: "routine"
  // R
};
function Connection(options, queues = {}, { onopen = noop, onend = noop, onclose = noop } = {}) {
  const {
    sslnegotiation,
    ssl,
    max,
    user,
    host,
    port,
    database,
    parsers: parsers2,
    transform,
    onnotice,
    onnotify,
    onparameter,
    max_pipeline,
    keep_alive,
    backoff: backoff2,
    target_session_attrs
  } = options;
  const sent = queue_default(), id = uid++, backend = { pid: null, secret: null }, idleTimer = timer(end, options.idle_timeout), lifeTimer = timer(end, options.max_lifetime), connectTimer = timer(connectTimedOut, options.connect_timeout);
  let socket = null, cancelMessage, errorResponse = null, result = new Result(), incoming = Buffer5.alloc(0), needsTypes = options.fetch_types, backendParameters = {}, statements = {}, statementId = Math.random().toString(36).slice(2), statementCount = 1, closedTime = 0, remaining = 0, hostIndex = 0, retries = 0, length = 0, delay = 0, rows = 0, serverSignature = null, nextWriteTimer = null, terminated = false, incomings = null, results = null, initial = null, ending = null, stream = null, chunk = null, ended = null, nonce = null, query = null, final = null;
  const connection2 = {
    queue: queues.closed,
    idleTimer,
    connect(query2) {
      initial = query2;
      reconnect();
    },
    terminate,
    execute,
    cancel,
    end,
    count: 0,
    id
  };
  queues.closed && queues.closed.push(connection2);
  return connection2;
  async function createSocket() {
    let x;
    try {
      x = options.socket ? await Promise.resolve(options.socket(options)) : new net.Socket();
    } catch (e) {
      error(e);
      return;
    }
    x.on("error", error);
    x.on("close", closed);
    x.on("drain", drain);
    return x;
  }
  __name(createSocket, "createSocket");
  async function cancel({ pid, secret }, resolve, reject) {
    try {
      cancelMessage = bytes_default().i32(16).i32(80877102).i32(pid).i32(secret).end(16);
      await connect();
      socket.once("error", reject);
      socket.once("close", resolve);
    } catch (error2) {
      reject(error2);
    }
  }
  __name(cancel, "cancel");
  function execute(q) {
    if (terminated)
      return queryError(q, Errors.connection("CONNECTION_DESTROYED", options));
    if (stream)
      return queryError(q, Errors.generic("COPY_IN_PROGRESS", "You cannot execute queries during copy"));
    if (q.cancelled)
      return;
    try {
      q.state = backend;
      query ? sent.push(q) : (query = q, query.active = true);
      build(q);
      return write(toBuffer(q)) && !q.describeFirst && !q.cursorFn && sent.length < max_pipeline && (!q.options.onexecute || q.options.onexecute(connection2));
    } catch (error2) {
      sent.length === 0 && write(Sync);
      errored(error2);
      return true;
    }
  }
  __name(execute, "execute");
  function toBuffer(q) {
    if (q.parameters.length >= 65534)
      throw Errors.generic("MAX_PARAMETERS_EXCEEDED", "Max number of parameters (65534) exceeded");
    return q.options.simple ? bytes_default().Q().str(q.statement.string + bytes_default.N).end() : q.describeFirst ? Buffer5.concat([describe(q), Flush]) : q.prepare ? q.prepared ? prepared(q) : Buffer5.concat([describe(q), prepared(q)]) : unnamed(q);
  }
  __name(toBuffer, "toBuffer");
  function describe(q) {
    return Buffer5.concat([
      Parse(q.statement.string, q.parameters, q.statement.types, q.statement.name),
      Describe("S", q.statement.name)
    ]);
  }
  __name(describe, "describe");
  function prepared(q) {
    return Buffer5.concat([
      Bind(q.parameters, q.statement.types, q.statement.name, q.cursorName),
      q.cursorFn ? Execute("", q.cursorRows) : ExecuteUnnamed
    ]);
  }
  __name(prepared, "prepared");
  function unnamed(q) {
    return Buffer5.concat([
      Parse(q.statement.string, q.parameters, q.statement.types),
      DescribeUnnamed,
      prepared(q)
    ]);
  }
  __name(unnamed, "unnamed");
  function build(q) {
    const parameters = [], types2 = [];
    const string = stringify(q, q.strings[0], q.args[0], parameters, types2, options);
    !q.tagged && q.args.forEach((x) => handleValue(x, parameters, types2, options));
    q.prepare = options.prepare && ("prepare" in q.options ? q.options.prepare : true);
    q.string = string;
    q.signature = q.prepare && types2 + string;
    q.onlyDescribe && delete statements[q.signature];
    q.parameters = q.parameters || parameters;
    q.prepared = q.prepare && q.signature in statements;
    q.describeFirst = q.onlyDescribe || parameters.length && !q.prepared;
    q.statement = q.prepared ? statements[q.signature] : { string, types: types2, name: q.prepare ? statementId + statementCount++ : "" };
    typeof options.debug === "function" && options.debug(id, string, parameters, types2);
  }
  __name(build, "build");
  function write(x, fn) {
    chunk = chunk ? Buffer5.concat([chunk, x]) : Buffer5.from(x);
    if (fn || chunk.length >= 1024)
      return nextWrite(fn);
    nextWriteTimer === null && (nextWriteTimer = setImmediate(nextWrite));
    return true;
  }
  __name(write, "write");
  function nextWrite(fn) {
    const x = socket.write(chunk, fn);
    nextWriteTimer !== null && clearImmediate(nextWriteTimer);
    chunk = nextWriteTimer = null;
    return x;
  }
  __name(nextWrite, "nextWrite");
  function connectTimedOut() {
    errored(Errors.connection("CONNECT_TIMEOUT", options, socket));
    socket.destroy();
  }
  __name(connectTimedOut, "connectTimedOut");
  async function secure() {
    if (sslnegotiation !== "direct") {
      write(SSLRequest);
      const canSSL = await new Promise((r) => socket.once("data", (x) => r(x[0] === 83)));
      if (!canSSL && ssl === "prefer")
        return connected();
    }
    const options2 = {
      socket,
      servername: net.isIP(socket.host) ? void 0 : socket.host
    };
    if (sslnegotiation === "direct")
      options2.ALPNProtocols = ["postgresql"];
    if (ssl === "require" || ssl === "allow" || ssl === "prefer")
      options2.rejectUnauthorized = false;
    else if (typeof ssl === "object")
      Object.assign(options2, ssl);
    socket.removeAllListeners();
    socket = tls.connect(options2);
    socket.on("secureConnect", connected);
    socket.on("error", error);
    socket.on("close", closed);
    socket.on("drain", drain);
  }
  __name(secure, "secure");
  function drain() {
    !query && onopen(connection2);
  }
  __name(drain, "drain");
  function data(x) {
    if (incomings) {
      incomings.push(x);
      remaining -= x.length;
      if (remaining > 0)
        return;
    }
    incoming = incomings ? Buffer5.concat(incomings, length - remaining) : incoming.length === 0 ? x : Buffer5.concat([incoming, x], incoming.length + x.length);
    while (incoming.length > 4) {
      length = incoming.readUInt32BE(1);
      if (length >= incoming.length) {
        remaining = length - incoming.length;
        incomings = [incoming];
        break;
      }
      try {
        handle(incoming.subarray(0, length + 1));
      } catch (e) {
        query && (query.cursorFn || query.describeFirst) && write(Sync);
        errored(e);
      }
      incoming = incoming.subarray(length + 1);
      remaining = 0;
      incomings = null;
    }
  }
  __name(data, "data");
  async function connect() {
    terminated = false;
    backendParameters = {};
    socket || (socket = await createSocket());
    if (!socket)
      return;
    connectTimer.start();
    if (options.socket)
      return ssl ? secure() : connected();
    socket.on("connect", ssl ? secure : connected);
    if (options.path)
      return socket.connect(options.path);
    socket.ssl = ssl;
    socket.connect(port[hostIndex], host[hostIndex]);
    socket.host = host[hostIndex];
    socket.port = port[hostIndex];
    hostIndex = (hostIndex + 1) % port.length;
  }
  __name(connect, "connect");
  function reconnect() {
    setTimeout(connect, closedTime ? Math.max(0, closedTime + delay - performance.now()) : 0);
  }
  __name(reconnect, "reconnect");
  function connected() {
    try {
      statements = {};
      needsTypes = options.fetch_types;
      statementId = Math.random().toString(36).slice(2);
      statementCount = 1;
      lifeTimer.start();
      socket.on("data", data);
      keep_alive && socket.setKeepAlive && socket.setKeepAlive(true, 1e3 * keep_alive);
      const s = StartupMessage();
      write(s);
    } catch (err) {
      error(err);
    }
  }
  __name(connected, "connected");
  function error(err) {
    if (connection2.queue === queues.connecting && options.host[retries + 1])
      return;
    errored(err);
    while (sent.length)
      queryError(sent.shift(), err);
  }
  __name(error, "error");
  function errored(err) {
    stream && (stream.destroy(err), stream = null);
    query && queryError(query, err);
    initial && (queryError(initial, err), initial = null);
  }
  __name(errored, "errored");
  function queryError(query2, err) {
    if (query2.reserve)
      return query2.reject(err);
    if (!err || typeof err !== "object")
      err = new Error(err);
    "query" in err || "parameters" in err || Object.defineProperties(err, {
      stack: { value: err.stack + query2.origin.replace(/.*\n/, "\n"), enumerable: options.debug },
      query: { value: query2.string, enumerable: options.debug },
      parameters: { value: query2.parameters, enumerable: options.debug },
      args: { value: query2.args, enumerable: options.debug },
      types: { value: query2.statement && query2.statement.types, enumerable: options.debug }
    });
    query2.reject(err);
  }
  __name(queryError, "queryError");
  function end() {
    return ending || (!connection2.reserved && onend(connection2), !connection2.reserved && !initial && !query && sent.length === 0 ? (terminate(), new Promise((r) => socket && socket.readyState !== "closed" ? socket.once("close", r) : r())) : ending = new Promise((r) => ended = r));
  }
  __name(end, "end");
  function terminate() {
    terminated = true;
    if (stream || query || initial || sent.length)
      error(Errors.connection("CONNECTION_DESTROYED", options));
    clearImmediate(nextWriteTimer);
    if (socket) {
      socket.removeListener("data", data);
      socket.removeListener("connect", connected);
      socket.readyState === "open" && socket.end(bytes_default().X().end());
    }
    ended && (ended(), ending = ended = null);
  }
  __name(terminate, "terminate");
  async function closed(hadError) {
    incoming = Buffer5.alloc(0);
    remaining = 0;
    incomings = null;
    clearImmediate(nextWriteTimer);
    socket.removeListener("data", data);
    socket.removeListener("connect", connected);
    idleTimer.cancel();
    lifeTimer.cancel();
    connectTimer.cancel();
    socket.removeAllListeners();
    socket = null;
    if (initial)
      return reconnect();
    !hadError && (query || sent.length) && error(Errors.connection("CONNECTION_CLOSED", options, socket));
    closedTime = performance.now();
    hadError && options.shared.retries++;
    delay = (typeof backoff2 === "function" ? backoff2(options.shared.retries) : backoff2) * 1e3;
    onclose(connection2, Errors.connection("CONNECTION_CLOSED", options, socket));
  }
  __name(closed, "closed");
  function handle(xs, x = xs[0]) {
    (x === 68 ? DataRow : (
      // D
      x === 100 ? CopyData : (
        // d
        x === 65 ? NotificationResponse : (
          // A
          x === 83 ? ParameterStatus : (
            // S
            x === 90 ? ReadyForQuery : (
              // Z
              x === 67 ? CommandComplete : (
                // C
                x === 50 ? BindComplete : (
                  // 2
                  x === 49 ? ParseComplete : (
                    // 1
                    x === 116 ? ParameterDescription : (
                      // t
                      x === 84 ? RowDescription : (
                        // T
                        x === 82 ? Authentication : (
                          // R
                          x === 110 ? NoData : (
                            // n
                            x === 75 ? BackendKeyData : (
                              // K
                              x === 69 ? ErrorResponse : (
                                // E
                                x === 115 ? PortalSuspended : (
                                  // s
                                  x === 51 ? CloseComplete : (
                                    // 3
                                    x === 71 ? CopyInResponse : (
                                      // G
                                      x === 78 ? NoticeResponse : (
                                        // N
                                        x === 72 ? CopyOutResponse : (
                                          // H
                                          x === 99 ? CopyDone : (
                                            // c
                                            x === 73 ? EmptyQueryResponse : (
                                              // I
                                              x === 86 ? FunctionCallResponse : (
                                                // V
                                                x === 118 ? NegotiateProtocolVersion : (
                                                  // v
                                                  x === 87 ? CopyBothResponse : (
                                                    // W
                                                    /* c8 ignore next */
                                                    UnknownMessage
                                                  )
                                                )
                                              )
                                            )
                                          )
                                        )
                                      )
                                    )
                                  )
                                )
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    ))(xs);
  }
  __name(handle, "handle");
  function DataRow(x) {
    let index = 7;
    let length2;
    let column;
    let value;
    const row = query.isRaw ? new Array(query.statement.columns.length) : {};
    for (let i = 0; i < query.statement.columns.length; i++) {
      column = query.statement.columns[i];
      length2 = x.readInt32BE(index);
      index += 4;
      value = length2 === -1 ? null : query.isRaw === true ? x.subarray(index, index += length2) : column.parser === void 0 ? x.toString("utf8", index, index += length2) : column.parser.array === true ? column.parser(x.toString("utf8", index + 1, index += length2)) : column.parser(x.toString("utf8", index, index += length2));
      query.isRaw ? row[i] = query.isRaw === true ? value : transform.value.from ? transform.value.from(value, column) : value : row[column.name] = transform.value.from ? transform.value.from(value, column) : value;
    }
    query.forEachFn ? query.forEachFn(transform.row.from ? transform.row.from(row) : row, result) : result[rows++] = transform.row.from ? transform.row.from(row) : row;
  }
  __name(DataRow, "DataRow");
  function ParameterStatus(x) {
    const [k, v] = x.toString("utf8", 5, x.length - 1).split(bytes_default.N);
    backendParameters[k] = v;
    if (options.parameters[k] !== v) {
      options.parameters[k] = v;
      onparameter && onparameter(k, v);
    }
  }
  __name(ParameterStatus, "ParameterStatus");
  function ReadyForQuery(x) {
    if (query) {
      if (errorResponse) {
        query.retried ? errored(query.retried) : query.prepared && retryRoutines.has(errorResponse.routine) ? retry(query, errorResponse) : errored(errorResponse);
      } else {
        query.resolve(results || result);
      }
    } else if (errorResponse) {
      errored(errorResponse);
    }
    query = results = errorResponse = null;
    result = new Result();
    connectTimer.cancel();
    if (initial) {
      if (target_session_attrs) {
        if (!backendParameters.in_hot_standby || !backendParameters.default_transaction_read_only)
          return fetchState();
        else if (tryNext(target_session_attrs, backendParameters))
          return terminate();
      }
      if (needsTypes) {
        initial.reserve && (initial = null);
        return fetchArrayTypes();
      }
      initial && !initial.reserve && execute(initial);
      options.shared.retries = retries = 0;
      initial = null;
      return;
    }
    while (sent.length && (query = sent.shift()) && (query.active = true, query.cancelled))
      Connection(options).cancel(query.state, query.cancelled.resolve, query.cancelled.reject);
    if (query)
      return;
    connection2.reserved ? !connection2.reserved.release && x[5] === 73 ? ending ? terminate() : (connection2.reserved = null, onopen(connection2)) : connection2.reserved() : ending ? terminate() : onopen(connection2);
  }
  __name(ReadyForQuery, "ReadyForQuery");
  function CommandComplete(x) {
    rows = 0;
    for (let i = x.length - 1; i > 0; i--) {
      if (x[i] === 32 && x[i + 1] < 58 && result.count === null)
        result.count = +x.toString("utf8", i + 1, x.length - 1);
      if (x[i - 1] >= 65) {
        result.command = x.toString("utf8", 5, i);
        result.state = backend;
        break;
      }
    }
    final && (final(), final = null);
    if (result.command === "BEGIN" && max !== 1 && !connection2.reserved)
      return errored(Errors.generic("UNSAFE_TRANSACTION", "Only use sql.begin, sql.reserved or max: 1"));
    if (query.options.simple)
      return BindComplete();
    if (query.cursorFn) {
      result.count && query.cursorFn(result);
      write(Sync);
    }
  }
  __name(CommandComplete, "CommandComplete");
  function ParseComplete() {
    query.parsing = false;
  }
  __name(ParseComplete, "ParseComplete");
  function BindComplete() {
    !result.statement && (result.statement = query.statement);
    result.columns = query.statement.columns;
  }
  __name(BindComplete, "BindComplete");
  function ParameterDescription(x) {
    const length2 = x.readUInt16BE(5);
    for (let i = 0; i < length2; ++i)
      !query.statement.types[i] && (query.statement.types[i] = x.readUInt32BE(7 + i * 4));
    query.prepare && (statements[query.signature] = query.statement);
    query.describeFirst && !query.onlyDescribe && (write(prepared(query)), query.describeFirst = false);
  }
  __name(ParameterDescription, "ParameterDescription");
  function RowDescription(x) {
    if (result.command) {
      results = results || [result];
      results.push(result = new Result());
      result.count = null;
      query.statement.columns = null;
    }
    const length2 = x.readUInt16BE(5);
    let index = 7;
    let start;
    query.statement.columns = Array(length2);
    for (let i = 0; i < length2; ++i) {
      start = index;
      while (x[index++] !== 0) ;
      const table = x.readUInt32BE(index);
      const number = x.readUInt16BE(index + 4);
      const type = x.readUInt32BE(index + 6);
      query.statement.columns[i] = {
        name: transform.column.from ? transform.column.from(x.toString("utf8", start, index - 1)) : x.toString("utf8", start, index - 1),
        parser: parsers2[type],
        table,
        number,
        type
      };
      index += 18;
    }
    result.statement = query.statement;
    if (query.onlyDescribe)
      return query.resolve(query.statement), write(Sync);
  }
  __name(RowDescription, "RowDescription");
  async function Authentication(x, type = x.readUInt32BE(5)) {
    (type === 3 ? AuthenticationCleartextPassword : type === 5 ? AuthenticationMD5Password : type === 10 ? SASL : type === 11 ? SASLContinue : type === 12 ? SASLFinal : type !== 0 ? UnknownAuth : noop)(x, type);
  }
  __name(Authentication, "Authentication");
  async function AuthenticationCleartextPassword() {
    const payload = await Pass();
    write(
      bytes_default().p().str(payload).z(1).end()
    );
  }
  __name(AuthenticationCleartextPassword, "AuthenticationCleartextPassword");
  async function AuthenticationMD5Password(x) {
    const payload = "md5" + await md5(
      Buffer5.concat([
        Buffer5.from(await md5(await Pass() + user)),
        x.subarray(9)
      ])
    );
    write(
      bytes_default().p().str(payload).z(1).end()
    );
  }
  __name(AuthenticationMD5Password, "AuthenticationMD5Password");
  async function SASL() {
    nonce = (await crypto2.randomBytes(18)).toString("base64");
    bytes_default().p().str("SCRAM-SHA-256" + bytes_default.N);
    const i = bytes_default.i;
    write(bytes_default.inc(4).str("n,,n=*,r=" + nonce).i32(bytes_default.i - i - 4, i).end());
  }
  __name(SASL, "SASL");
  async function SASLContinue(x) {
    const res = x.toString("utf8", 9).split(",").reduce((acc, x2) => (acc[x2[0]] = x2.slice(2), acc), {});
    const saltedPassword = await crypto2.pbkdf2Sync(
      await Pass(),
      Buffer5.from(res.s, "base64"),
      parseInt(res.i),
      32,
      "sha256"
    );
    const clientKey = await hmac(saltedPassword, "Client Key");
    const auth = "n=*,r=" + nonce + ",r=" + res.r + ",s=" + res.s + ",i=" + res.i + ",c=biws,r=" + res.r;
    serverSignature = (await hmac(await hmac(saltedPassword, "Server Key"), auth)).toString("base64");
    const payload = "c=biws,r=" + res.r + ",p=" + xor(
      clientKey,
      Buffer5.from(await hmac(await sha256(clientKey), auth))
    ).toString("base64");
    write(
      bytes_default().p().str(payload).end()
    );
  }
  __name(SASLContinue, "SASLContinue");
  function SASLFinal(x) {
    if (x.toString("utf8", 9).split(bytes_default.N, 1)[0].slice(2) === serverSignature)
      return;
    errored(Errors.generic("SASL_SIGNATURE_MISMATCH", "The server did not return the correct signature"));
    socket.destroy();
  }
  __name(SASLFinal, "SASLFinal");
  function Pass() {
    return Promise.resolve(
      typeof options.pass === "function" ? options.pass() : options.pass
    );
  }
  __name(Pass, "Pass");
  function NoData() {
    result.statement = query.statement;
    result.statement.columns = [];
    if (query.onlyDescribe)
      return query.resolve(query.statement), write(Sync);
  }
  __name(NoData, "NoData");
  function BackendKeyData(x) {
    backend.pid = x.readUInt32BE(5);
    backend.secret = x.readUInt32BE(9);
  }
  __name(BackendKeyData, "BackendKeyData");
  async function fetchArrayTypes() {
    needsTypes = false;
    const types2 = await new Query([`
      select b.oid, b.typarray
      from pg_catalog.pg_type a
      left join pg_catalog.pg_type b on b.oid = a.typelem
      where a.typcategory = 'A'
      group by b.oid, b.typarray
      order by b.oid
    `], [], execute);
    types2.forEach(({ oid, typarray }) => addArrayType(oid, typarray));
  }
  __name(fetchArrayTypes, "fetchArrayTypes");
  function addArrayType(oid, typarray) {
    if (!!options.parsers[typarray] && !!options.serializers[typarray]) return;
    const parser = options.parsers[oid];
    options.shared.typeArrayMap[oid] = typarray;
    options.parsers[typarray] = (xs) => arrayParser(xs, parser, typarray);
    options.parsers[typarray].array = true;
    options.serializers[typarray] = (xs) => arraySerializer(xs, options.serializers[oid], options, typarray);
  }
  __name(addArrayType, "addArrayType");
  function tryNext(x, xs) {
    return x === "read-write" && xs.default_transaction_read_only === "on" || x === "read-only" && xs.default_transaction_read_only === "off" || x === "primary" && xs.in_hot_standby === "on" || x === "standby" && xs.in_hot_standby === "off" || x === "prefer-standby" && xs.in_hot_standby === "off" && options.host[retries];
  }
  __name(tryNext, "tryNext");
  function fetchState() {
    const query2 = new Query([`
      show transaction_read_only;
      select pg_catalog.pg_is_in_recovery()
    `], [], execute, null, { simple: true });
    query2.resolve = ([[a], [b2]]) => {
      backendParameters.default_transaction_read_only = a.transaction_read_only;
      backendParameters.in_hot_standby = b2.pg_is_in_recovery ? "on" : "off";
    };
    query2.execute();
  }
  __name(fetchState, "fetchState");
  function ErrorResponse(x) {
    if (query) {
      (query.cursorFn || query.describeFirst) && write(Sync);
      errorResponse = Errors.postgres(parseError(x));
    } else {
      errored(Errors.postgres(parseError(x)));
    }
  }
  __name(ErrorResponse, "ErrorResponse");
  function retry(q, error2) {
    delete statements[q.signature];
    q.retried = error2;
    execute(q);
  }
  __name(retry, "retry");
  function NotificationResponse(x) {
    if (!onnotify)
      return;
    let index = 9;
    while (x[index++] !== 0) ;
    onnotify(
      x.toString("utf8", 9, index - 1),
      x.toString("utf8", index, x.length - 1)
    );
  }
  __name(NotificationResponse, "NotificationResponse");
  async function PortalSuspended() {
    try {
      const x = await Promise.resolve(query.cursorFn(result));
      rows = 0;
      x === CLOSE ? write(Close(query.portal)) : (result = new Result(), write(Execute("", query.cursorRows)));
    } catch (err) {
      write(Sync);
      query.reject(err);
    }
  }
  __name(PortalSuspended, "PortalSuspended");
  function CloseComplete() {
    result.count && query.cursorFn(result);
    query.resolve(result);
  }
  __name(CloseComplete, "CloseComplete");
  function CopyInResponse() {
    stream = new Stream.Writable({
      autoDestroy: true,
      write(chunk2, encoding, callback) {
        socket.write(bytes_default().d().raw(chunk2).end(), callback);
      },
      destroy(error2, callback) {
        callback(error2);
        socket.write(bytes_default().f().str(error2 + bytes_default.N).end());
        stream = null;
      },
      final(callback) {
        socket.write(bytes_default().c().end());
        final = callback;
        stream = null;
      }
    });
    query.resolve(stream);
  }
  __name(CopyInResponse, "CopyInResponse");
  function CopyOutResponse() {
    stream = new Stream.Readable({
      read() {
        socket.resume();
      }
    });
    query.resolve(stream);
  }
  __name(CopyOutResponse, "CopyOutResponse");
  function CopyBothResponse() {
    stream = new Stream.Duplex({
      autoDestroy: true,
      read() {
        socket.resume();
      },
      /* c8 ignore next 11 */
      write(chunk2, encoding, callback) {
        socket.write(bytes_default().d().raw(chunk2).end(), callback);
      },
      destroy(error2, callback) {
        callback(error2);
        socket.write(bytes_default().f().str(error2 + bytes_default.N).end());
        stream = null;
      },
      final(callback) {
        socket.write(bytes_default().c().end());
        final = callback;
      }
    });
    query.resolve(stream);
  }
  __name(CopyBothResponse, "CopyBothResponse");
  function CopyData(x) {
    stream && (stream.push(x.subarray(5)) || socket.pause());
  }
  __name(CopyData, "CopyData");
  function CopyDone() {
    stream && stream.push(null);
    stream = null;
  }
  __name(CopyDone, "CopyDone");
  function NoticeResponse(x) {
    onnotice ? onnotice(parseError(x)) : console.log(parseError(x));
  }
  __name(NoticeResponse, "NoticeResponse");
  function EmptyQueryResponse() {
  }
  __name(EmptyQueryResponse, "EmptyQueryResponse");
  function FunctionCallResponse() {
    errored(Errors.notSupported("FunctionCallResponse"));
  }
  __name(FunctionCallResponse, "FunctionCallResponse");
  function NegotiateProtocolVersion() {
    errored(Errors.notSupported("NegotiateProtocolVersion"));
  }
  __name(NegotiateProtocolVersion, "NegotiateProtocolVersion");
  function UnknownMessage(x) {
    console.error("Postgres.js : Unknown Message:", x[0]);
  }
  __name(UnknownMessage, "UnknownMessage");
  function UnknownAuth(x, type) {
    console.error("Postgres.js : Unknown Auth:", type);
  }
  __name(UnknownAuth, "UnknownAuth");
  function Bind(parameters, types2, statement = "", portal = "") {
    let prev, type;
    bytes_default().B().str(portal + bytes_default.N).str(statement + bytes_default.N).i16(0).i16(parameters.length);
    parameters.forEach((x, i) => {
      if (x === null)
        return bytes_default.i32(4294967295);
      type = types2[i];
      parameters[i] = x = type in options.serializers ? options.serializers[type](x) : "" + x;
      prev = bytes_default.i;
      bytes_default.inc(4).str(x).i32(bytes_default.i - prev - 4, prev);
    });
    bytes_default.i16(0);
    return bytes_default.end();
  }
  __name(Bind, "Bind");
  function Parse(str, parameters, types2, name = "") {
    bytes_default().P().str(name + bytes_default.N).str(str + bytes_default.N).i16(parameters.length);
    parameters.forEach((x, i) => bytes_default.i32(types2[i] || 0));
    return bytes_default.end();
  }
  __name(Parse, "Parse");
  function Describe(x, name = "") {
    return bytes_default().D().str(x).str(name + bytes_default.N).end();
  }
  __name(Describe, "Describe");
  function Execute(portal = "", rows2 = 0) {
    return Buffer5.concat([
      bytes_default().E().str(portal + bytes_default.N).i32(rows2).end(),
      Flush
    ]);
  }
  __name(Execute, "Execute");
  function Close(portal = "") {
    return Buffer5.concat([
      bytes_default().C().str("P").str(portal + bytes_default.N).end(),
      bytes_default().S().end()
    ]);
  }
  __name(Close, "Close");
  function StartupMessage() {
    return cancelMessage || bytes_default().inc(4).i16(3).z(2).str(
      Object.entries(Object.assign(
        {
          user,
          database,
          client_encoding: "UTF8"
        },
        options.connection
      )).filter(([, v]) => v).map(([k, v]) => k + bytes_default.N + v).join(bytes_default.N)
    ).z(2).end(0);
  }
  __name(StartupMessage, "StartupMessage");
}
__name(Connection, "Connection");
function parseError(x) {
  const error = {};
  let start = 5;
  for (let i = 5; i < x.length - 1; i++) {
    if (x[i] === 0) {
      error[errorFields[x[start]]] = x.toString("utf8", start + 1, i);
      start = i + 1;
    }
  }
  return error;
}
__name(parseError, "parseError");
function md5(x) {
  return crypto2.createHash("md5").update(x).digest("hex");
}
__name(md5, "md5");
function hmac(key, x) {
  return crypto2.createHmac("sha256", key).update(x).digest();
}
__name(hmac, "hmac");
function sha256(x) {
  return crypto2.createHash("sha256").update(x).digest();
}
__name(sha256, "sha256");
function xor(a, b2) {
  const length = Math.max(a.length, b2.length);
  const buffer2 = Buffer5.allocUnsafe(length);
  for (let i = 0; i < length; i++)
    buffer2[i] = a[i] ^ b2[i];
  return buffer2;
}
__name(xor, "xor");
function timer(fn, seconds) {
  seconds = typeof seconds === "function" ? seconds() : seconds;
  if (!seconds)
    return { cancel: noop, start: noop };
  let timer2;
  return {
    cancel() {
      timer2 && (clearTimeout(timer2), timer2 = null);
    },
    start() {
      timer2 && clearTimeout(timer2);
      timer2 = setTimeout(done, seconds * 1e3, arguments);
    }
  };
  function done(args) {
    fn.apply(null, args);
    timer2 = null;
  }
  __name(done, "done");
}
__name(timer, "timer");

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/subscribe.js
import { Buffer as Buffer6 } from "node:buffer";
var noop2 = /* @__PURE__ */ __name(() => {
}, "noop");
function Subscribe(postgres2, options) {
  const subscribers = /* @__PURE__ */ new Map(), slot = "postgresjs_" + Math.random().toString(36).slice(2), state = {};
  let connection2, stream, ended = false;
  const sql = subscribe.sql = postgres2({
    ...options,
    transform: { column: {}, value: {}, row: {} },
    max: 1,
    fetch_types: false,
    idle_timeout: null,
    max_lifetime: null,
    connection: {
      ...options.connection,
      replication: "database"
    },
    onclose: /* @__PURE__ */ __name(async function() {
      if (ended)
        return;
      stream = null;
      state.pid = state.secret = void 0;
      connected(await init(sql, slot, options.publications));
      subscribers.forEach((event) => event.forEach(({ onsubscribe }) => onsubscribe()));
    }, "onclose"),
    no_subscribe: true
  });
  const end = sql.end, close = sql.close;
  sql.end = async () => {
    ended = true;
    stream && await new Promise((r) => (stream.once("close", r), stream.end()));
    return end();
  };
  sql.close = async () => {
    stream && await new Promise((r) => (stream.once("close", r), stream.end()));
    return close();
  };
  return subscribe;
  async function subscribe(event, fn, onsubscribe = noop2, onerror = noop2) {
    event = parseEvent(event);
    if (!connection2)
      connection2 = init(sql, slot, options.publications);
    const subscriber = { fn, onsubscribe };
    const fns = subscribers.has(event) ? subscribers.get(event).add(subscriber) : subscribers.set(event, /* @__PURE__ */ new Set([subscriber])).get(event);
    const unsubscribe = /* @__PURE__ */ __name(() => {
      fns.delete(subscriber);
      fns.size === 0 && subscribers.delete(event);
    }, "unsubscribe");
    return connection2.then((x) => {
      connected(x);
      onsubscribe();
      stream && stream.on("error", onerror);
      return { unsubscribe, state, sql };
    });
  }
  __name(subscribe, "subscribe");
  function connected(x) {
    stream = x.stream;
    state.pid = x.state.pid;
    state.secret = x.state.secret;
  }
  __name(connected, "connected");
  async function init(sql2, slot2, publications) {
    if (!publications)
      throw new Error("Missing publication names");
    const xs = await sql2.unsafe(
      `CREATE_REPLICATION_SLOT ${slot2} TEMPORARY LOGICAL pgoutput NOEXPORT_SNAPSHOT`
    );
    const [x] = xs;
    const stream2 = await sql2.unsafe(
      `START_REPLICATION SLOT ${slot2} LOGICAL ${x.consistent_point} (proto_version '1', publication_names '${publications}')`
    ).writable();
    const state2 = {
      lsn: Buffer6.concat(x.consistent_point.split("/").map((x2) => Buffer6.from(("00000000" + x2).slice(-8), "hex")))
    };
    stream2.on("data", data);
    stream2.on("error", error);
    stream2.on("close", sql2.close);
    return { stream: stream2, state: xs.state };
    function error(e) {
      console.error("Unexpected error during logical streaming - reconnecting", e);
    }
    __name(error, "error");
    function data(x2) {
      if (x2[0] === 119) {
        parse(x2.subarray(25), state2, sql2.options.parsers, handle, options.transform);
      } else if (x2[0] === 107 && x2[17]) {
        state2.lsn = x2.subarray(1, 9);
        pong();
      }
    }
    __name(data, "data");
    function handle(a, b2) {
      const path = b2.relation.schema + "." + b2.relation.table;
      call("*", a, b2);
      call("*:" + path, a, b2);
      b2.relation.keys.length && call("*:" + path + "=" + b2.relation.keys.map((x2) => a[x2.name]), a, b2);
      call(b2.command, a, b2);
      call(b2.command + ":" + path, a, b2);
      b2.relation.keys.length && call(b2.command + ":" + path + "=" + b2.relation.keys.map((x2) => a[x2.name]), a, b2);
    }
    __name(handle, "handle");
    function pong() {
      const x2 = Buffer6.alloc(34);
      x2[0] = "r".charCodeAt(0);
      x2.fill(state2.lsn, 1);
      x2.writeBigInt64BE(BigInt(Date.now() - Date.UTC(2e3, 0, 1)) * BigInt(1e3), 25);
      stream2.write(x2);
    }
    __name(pong, "pong");
  }
  __name(init, "init");
  function call(x, a, b2) {
    subscribers.has(x) && subscribers.get(x).forEach(({ fn }) => fn(a, b2, x));
  }
  __name(call, "call");
}
__name(Subscribe, "Subscribe");
function Time(x) {
  return new Date(Date.UTC(2e3, 0, 1) + Number(x / BigInt(1e3)));
}
__name(Time, "Time");
function parse(x, state, parsers2, handle, transform) {
  const char = /* @__PURE__ */ __name((acc, [k, v]) => (acc[k.charCodeAt(0)] = v, acc), "char");
  Object.entries({
    R: /* @__PURE__ */ __name((x2) => {
      let i = 1;
      const r = state[x2.readUInt32BE(i)] = {
        schema: x2.toString("utf8", i += 4, i = x2.indexOf(0, i)) || "pg_catalog",
        table: x2.toString("utf8", i + 1, i = x2.indexOf(0, i + 1)),
        columns: Array(x2.readUInt16BE(i += 2)),
        keys: []
      };
      i += 2;
      let columnIndex = 0, column;
      while (i < x2.length) {
        column = r.columns[columnIndex++] = {
          key: x2[i++],
          name: transform.column.from ? transform.column.from(x2.toString("utf8", i, i = x2.indexOf(0, i))) : x2.toString("utf8", i, i = x2.indexOf(0, i)),
          type: x2.readUInt32BE(i += 1),
          parser: parsers2[x2.readUInt32BE(i)],
          atttypmod: x2.readUInt32BE(i += 4)
        };
        column.key && r.keys.push(column);
        i += 4;
      }
    }, "R"),
    Y: /* @__PURE__ */ __name(() => {
    }, "Y"),
    // Type
    O: /* @__PURE__ */ __name(() => {
    }, "O"),
    // Origin
    B: /* @__PURE__ */ __name((x2) => {
      state.date = Time(x2.readBigInt64BE(9));
      state.lsn = x2.subarray(1, 9);
    }, "B"),
    I: /* @__PURE__ */ __name((x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      const { row } = tuples(x2, relation.columns, i += 7, transform);
      handle(row, {
        command: "insert",
        relation
      });
    }, "I"),
    D: /* @__PURE__ */ __name((x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      i += 4;
      const key = x2[i] === 75;
      handle(
        key || x2[i] === 79 ? tuples(x2, relation.columns, i += 3, transform).row : null,
        {
          command: "delete",
          relation,
          key
        }
      );
    }, "D"),
    U: /* @__PURE__ */ __name((x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      i += 4;
      const key = x2[i] === 75;
      const xs = key || x2[i] === 79 ? tuples(x2, relation.columns, i += 3, transform) : null;
      xs && (i = xs.i);
      const { row } = tuples(x2, relation.columns, i + 3, transform);
      handle(row, {
        command: "update",
        relation,
        key,
        old: xs && xs.row
      });
    }, "U"),
    T: /* @__PURE__ */ __name(() => {
    }, "T"),
    // Truncate,
    C: /* @__PURE__ */ __name(() => {
    }, "C")
    // Commit
  }).reduce(char, {})[x[0]](x);
}
__name(parse, "parse");
function tuples(x, columns, xi, transform) {
  let type, column, value;
  const row = transform.raw ? new Array(columns.length) : {};
  for (let i = 0; i < columns.length; i++) {
    type = x[xi++];
    column = columns[i];
    value = type === 110 ? null : type === 117 ? void 0 : column.parser === void 0 ? x.toString("utf8", xi + 4, xi += 4 + x.readUInt32BE(xi)) : column.parser.array === true ? column.parser(x.toString("utf8", xi + 5, xi += 4 + x.readUInt32BE(xi))) : column.parser(x.toString("utf8", xi + 4, xi += 4 + x.readUInt32BE(xi)));
    transform.raw ? row[i] = transform.raw === true ? value : transform.value.from ? transform.value.from(value, column) : value : row[column.name] = transform.value.from ? transform.value.from(value, column) : value;
  }
  return { i: xi, row: transform.row.from ? transform.row.from(row) : row };
}
__name(tuples, "tuples");
function parseEvent(x) {
  const xs = x.match(/^(\*|insert|update|delete)?:?([^.]+?\.?[^=]+)?=?(.+)?/i) || [];
  if (!xs)
    throw new Error("Malformed subscribe pattern: " + x);
  const [, command, path, key] = xs;
  return (command || "*") + (path ? ":" + (path.indexOf(".") === -1 ? "public." + path : path) : "") + (key ? "=" + key : "");
}
__name(parseEvent, "parseEvent");

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/large.js
import Stream2 from "node:stream";
function largeObject(sql, oid, mode = 131072 | 262144) {
  return new Promise(async (resolve, reject) => {
    await sql.begin(async (sql2) => {
      let finish;
      !oid && ([{ oid }] = await sql2`select lo_creat(-1) as oid`);
      const [{ fd }] = await sql2`select lo_open(${oid}, ${mode}) as fd`;
      const lo = {
        writable,
        readable,
        close: /* @__PURE__ */ __name(() => sql2`select lo_close(${fd})`.then(finish), "close"),
        tell: /* @__PURE__ */ __name(() => sql2`select lo_tell64(${fd})`, "tell"),
        read: /* @__PURE__ */ __name((x) => sql2`select loread(${fd}, ${x}) as data`, "read"),
        write: /* @__PURE__ */ __name((x) => sql2`select lowrite(${fd}, ${x})`, "write"),
        truncate: /* @__PURE__ */ __name((x) => sql2`select lo_truncate64(${fd}, ${x})`, "truncate"),
        seek: /* @__PURE__ */ __name((x, whence = 0) => sql2`select lo_lseek64(${fd}, ${x}, ${whence})`, "seek"),
        size: /* @__PURE__ */ __name(() => sql2`
          select
            lo_lseek64(${fd}, location, 0) as position,
            seek.size
          from (
            select
              lo_lseek64($1, 0, 2) as size,
              tell.location
            from (select lo_tell64($1) as location) tell
          ) seek
        `, "size")
      };
      resolve(lo);
      return new Promise(async (r) => finish = r);
      async function readable({
        highWaterMark = 2048 * 8,
        start = 0,
        end = Infinity
      } = {}) {
        let max = end - start;
        start && await lo.seek(start);
        return new Stream2.Readable({
          highWaterMark,
          async read(size2) {
            const l = size2 > max ? size2 - max : size2;
            max -= size2;
            const [{ data }] = await lo.read(l);
            this.push(data);
            if (data.length < size2)
              this.push(null);
          }
        });
      }
      __name(readable, "readable");
      async function writable({
        highWaterMark = 2048 * 8,
        start = 0
      } = {}) {
        start && await lo.seek(start);
        return new Stream2.Writable({
          highWaterMark,
          write(chunk, encoding, callback) {
            lo.write(chunk).then(() => callback(), callback);
          }
        });
      }
      __name(writable, "writable");
    }).catch(reject);
  });
}
__name(largeObject, "largeObject");

// node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cf/src/index.js
Object.assign(Postgres, {
  PostgresError,
  toPascal,
  pascal,
  toCamel,
  camel,
  toKebab,
  kebab,
  fromPascal,
  fromCamel,
  fromKebab,
  BigInt: {
    to: 20,
    from: [20],
    parse: /* @__PURE__ */ __name((x) => BigInt(x), "parse"),
    // eslint-disable-line
    serialize: /* @__PURE__ */ __name((x) => x.toString(), "serialize")
  }
});
var src_default = Postgres;
function Postgres(a, b2) {
  const options = parseOptions(a, b2), subscribe = options.no_subscribe || Subscribe(Postgres, { ...options });
  let ending = false;
  const queries = queue_default(), connecting = queue_default(), reserved = queue_default(), closed = queue_default(), ended = queue_default(), open = queue_default(), busy = queue_default(), full = queue_default(), queues = { connecting, reserved, closed, ended, open, busy, full };
  const connections = [...Array(options.max)].map(() => connection_default(options, queues, { onopen, onend, onclose }));
  const sql = Sql(handler);
  Object.assign(sql, {
    get parameters() {
      return options.parameters;
    },
    largeObject: largeObject.bind(null, sql),
    subscribe,
    CLOSE,
    END: CLOSE,
    PostgresError,
    options,
    reserve,
    listen,
    begin,
    close,
    end
  });
  return sql;
  function Sql(handler2) {
    handler2.debug = options.debug;
    Object.entries(options.types).reduce((acc, [name, type]) => {
      acc[name] = (x) => new Parameter(x, type.to);
      return acc;
    }, typed);
    Object.assign(sql2, {
      types: typed,
      typed,
      unsafe,
      notify,
      array,
      json: json2,
      file
    });
    return sql2;
    function typed(value, type) {
      return new Parameter(value, type);
    }
    __name(typed, "typed");
    function sql2(strings, ...args) {
      const query = strings && Array.isArray(strings.raw) ? new Query(strings, args, handler2, cancel) : typeof strings === "string" && !args.length ? new Identifier(options.transform.column.to ? options.transform.column.to(strings) : strings) : new Builder(strings, args);
      return query;
    }
    __name(sql2, "sql");
    function unsafe(string, args = [], options2 = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options2 = args, args = []);
      const query = new Query([string], args, handler2, cancel, {
        prepare: false,
        ...options2,
        simple: "simple" in options2 ? options2.simple : args.length === 0
      });
      return query;
    }
    __name(unsafe, "unsafe");
    function file(path, args = [], options2 = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options2 = args, args = []);
      const query = new Query([], args, (query2) => {
        fs.readFile(path, "utf8", (err, string) => {
          if (err)
            return query2.reject(err);
          query2.strings = [string];
          handler2(query2);
        });
      }, cancel, {
        ...options2,
        simple: "simple" in options2 ? options2.simple : args.length === 0
      });
      return query;
    }
    __name(file, "file");
  }
  __name(Sql, "Sql");
  async function listen(name, fn, onlisten) {
    const listener = { fn, onlisten };
    const sql2 = listen.sql || (listen.sql = Postgres({
      ...options,
      max: 1,
      idle_timeout: null,
      max_lifetime: null,
      fetch_types: false,
      onclose() {
        Object.entries(listen.channels).forEach(([name2, { listeners }]) => {
          delete listen.channels[name2];
          Promise.all(listeners.map((l) => listen(name2, l.fn, l.onlisten).catch(() => {
          })));
        });
      },
      onnotify(c, x) {
        c in listen.channels && listen.channels[c].listeners.forEach((l) => l.fn(x));
      }
    }));
    const channels = listen.channels || (listen.channels = {}), exists = name in channels;
    if (exists) {
      channels[name].listeners.push(listener);
      const result2 = await channels[name].result;
      listener.onlisten && listener.onlisten();
      return { state: result2.state, unlisten };
    }
    channels[name] = { result: sql2`listen ${sql2.unsafe('"' + name.replace(/"/g, '""') + '"')}`, listeners: [listener] };
    const result = await channels[name].result;
    listener.onlisten && listener.onlisten();
    return { state: result.state, unlisten };
    async function unlisten() {
      if (name in channels === false)
        return;
      channels[name].listeners = channels[name].listeners.filter((x) => x !== listener);
      if (channels[name].listeners.length)
        return;
      delete channels[name];
      return sql2`unlisten ${sql2.unsafe('"' + name.replace(/"/g, '""') + '"')}`;
    }
    __name(unlisten, "unlisten");
  }
  __name(listen, "listen");
  async function notify(channel, payload) {
    return await sql`select pg_notify(${channel}, ${"" + payload})`;
  }
  __name(notify, "notify");
  async function reserve() {
    const queue = queue_default();
    const c = open.length ? open.shift() : await new Promise((resolve, reject) => {
      const query = { reserve: resolve, reject };
      queries.push(query);
      closed.length && connect(closed.shift(), query);
    });
    move(c, reserved);
    c.reserved = () => queue.length ? c.execute(queue.shift()) : move(c, reserved);
    c.reserved.release = true;
    const sql2 = Sql(handler2);
    sql2.release = () => {
      c.reserved = null;
      onopen(c);
    };
    return sql2;
    function handler2(q) {
      c.queue === full ? queue.push(q) : c.execute(q) || move(c, full);
    }
    __name(handler2, "handler");
  }
  __name(reserve, "reserve");
  async function begin(options2, fn) {
    !fn && (fn = options2, options2 = "");
    const queries2 = queue_default();
    let savepoints = 0, connection2, prepare = null;
    try {
      await sql.unsafe("begin " + options2.replace(/[^a-z ]/ig, ""), [], { onexecute }).execute();
      return await Promise.race([
        scope(connection2, fn),
        new Promise((_, reject) => connection2.onclose = reject)
      ]);
    } catch (error) {
      throw error;
    }
    async function scope(c, fn2, name) {
      const sql2 = Sql(handler2);
      sql2.savepoint = savepoint;
      sql2.prepare = (x) => prepare = x.replace(/[^a-z0-9$-_. ]/gi);
      let uncaughtError, result;
      name && await sql2`savepoint ${sql2(name)}`;
      try {
        result = await new Promise((resolve, reject) => {
          const x = fn2(sql2);
          Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(resolve, reject);
        });
        if (uncaughtError)
          throw uncaughtError;
      } catch (e) {
        await (name ? sql2`rollback to ${sql2(name)}` : sql2`rollback`);
        throw e instanceof PostgresError && e.code === "25P02" && uncaughtError || e;
      }
      if (!name) {
        prepare ? await sql2`prepare transaction '${sql2.unsafe(prepare)}'` : await sql2`commit`;
      }
      return result;
      function savepoint(name2, fn3) {
        if (name2 && Array.isArray(name2.raw))
          return savepoint((sql3) => sql3.apply(sql3, arguments));
        arguments.length === 1 && (fn3 = name2, name2 = null);
        return scope(c, fn3, "s" + savepoints++ + (name2 ? "_" + name2 : ""));
      }
      __name(savepoint, "savepoint");
      function handler2(q) {
        q.catch((e) => uncaughtError || (uncaughtError = e));
        c.queue === full ? queries2.push(q) : c.execute(q) || move(c, full);
      }
      __name(handler2, "handler");
    }
    __name(scope, "scope");
    function onexecute(c) {
      connection2 = c;
      move(c, reserved);
      c.reserved = () => queries2.length ? c.execute(queries2.shift()) : move(c, reserved);
    }
    __name(onexecute, "onexecute");
  }
  __name(begin, "begin");
  function move(c, queue) {
    c.queue.remove(c);
    queue.push(c);
    c.queue = queue;
    queue === open ? c.idleTimer.start() : c.idleTimer.cancel();
    return c;
  }
  __name(move, "move");
  function json2(x) {
    return new Parameter(x, 3802);
  }
  __name(json2, "json");
  function array(x, type) {
    if (!Array.isArray(x))
      return array(Array.from(arguments));
    return new Parameter(x, type || (x.length ? inferType(x) || 25 : 0), options.shared.typeArrayMap);
  }
  __name(array, "array");
  function handler(query) {
    if (ending)
      return query.reject(Errors.connection("CONNECTION_ENDED", options, options));
    if (open.length)
      return go(open.shift(), query);
    if (closed.length)
      return connect(closed.shift(), query);
    busy.length ? go(busy.shift(), query) : queries.push(query);
  }
  __name(handler, "handler");
  function go(c, query) {
    return c.execute(query) ? move(c, busy) : move(c, full);
  }
  __name(go, "go");
  function cancel(query) {
    return new Promise((resolve, reject) => {
      query.state ? query.active ? connection_default(options).cancel(query.state, resolve, reject) : query.cancelled = { resolve, reject } : (queries.remove(query), query.cancelled = true, query.reject(Errors.generic("57014", "canceling statement due to user request")), resolve());
    });
  }
  __name(cancel, "cancel");
  async function end({ timeout = null } = {}) {
    if (ending)
      return ending;
    await 1;
    let timer2;
    return ending = Promise.race([
      new Promise((r) => timeout !== null && (timer2 = setTimeout(destroy, timeout * 1e3, r))),
      Promise.all(connections.map((c) => c.end()).concat(
        listen.sql ? listen.sql.end({ timeout: 0 }) : [],
        subscribe.sql ? subscribe.sql.end({ timeout: 0 }) : []
      ))
    ]).then(() => clearTimeout(timer2));
  }
  __name(end, "end");
  async function close() {
    await Promise.all(connections.map((c) => c.end()));
  }
  __name(close, "close");
  async function destroy(resolve) {
    await Promise.all(connections.map((c) => c.terminate()));
    while (queries.length)
      queries.shift().reject(Errors.connection("CONNECTION_DESTROYED", options));
    resolve();
  }
  __name(destroy, "destroy");
  function connect(c, query) {
    move(c, connecting);
    c.connect(query);
    return c;
  }
  __name(connect, "connect");
  function onend(c) {
    move(c, ended);
  }
  __name(onend, "onend");
  function onopen(c) {
    if (queries.length === 0)
      return move(c, open);
    let max = Math.ceil(queries.length / (connecting.length + 1)), ready = true;
    while (ready && queries.length && max-- > 0) {
      const query = queries.shift();
      if (query.reserve)
        return query.reserve(c);
      ready = c.execute(query);
    }
    ready ? move(c, busy) : move(c, full);
  }
  __name(onopen, "onopen");
  function onclose(c, e) {
    move(c, closed);
    c.reserved = null;
    c.onclose && (c.onclose(e), c.onclose = null);
    options.onclose && options.onclose(c.id);
    queries.length && connect(c, queries.shift());
  }
  __name(onclose, "onclose");
}
__name(Postgres, "Postgres");
function parseOptions(a, b2) {
  if (a && a.shared)
    return a;
  const env = process.env, o = (!a || typeof a === "string" ? b2 : a) || {}, { url, multihost } = parseUrl(a), query = [...url.searchParams].reduce((a2, [b3, c]) => (a2[b3] = c, a2), {}), host = o.hostname || o.host || multihost || url.hostname || env.PGHOST || "localhost", port = o.port || url.port || env.PGPORT || 5432, user = o.user || o.username || url.username || env.PGUSERNAME || env.PGUSER || osUsername();
  o.no_prepare && (o.prepare = false);
  query.sslmode && (query.ssl = query.sslmode, delete query.sslmode);
  "timeout" in o && (console.log("The timeout option is deprecated, use idle_timeout instead"), o.idle_timeout = o.timeout);
  query.sslrootcert === "system" && (query.ssl = "verify-full");
  const ints = ["idle_timeout", "connect_timeout", "max_lifetime", "max_pipeline", "backoff", "keep_alive"];
  const defaults = {
    max: globalThis.Cloudflare ? 3 : 10,
    ssl: false,
    sslnegotiation: null,
    idle_timeout: null,
    connect_timeout: 30,
    max_lifetime,
    max_pipeline: 100,
    backoff,
    keep_alive: 60,
    prepare: true,
    debug: false,
    fetch_types: true,
    publications: "alltables",
    target_session_attrs: null
  };
  return {
    host: Array.isArray(host) ? host : host.split(",").map((x) => x.split(":")[0]),
    port: Array.isArray(port) ? port : host.split(",").map((x) => parseInt(x.split(":")[1] || port)),
    path: o.path || host.indexOf("/") > -1 && host + "/.s.PGSQL." + port,
    database: o.database || o.db || (url.pathname || "").slice(1) || env.PGDATABASE || user,
    user,
    pass: o.pass || o.password || url.password || env.PGPASSWORD || "",
    ...Object.entries(defaults).reduce(
      (acc, [k, d]) => {
        const value = k in o ? o[k] : k in query ? query[k] === "disable" || query[k] === "false" ? false : query[k] : env["PG" + k.toUpperCase()] || d;
        acc[k] = typeof value === "string" && ints.includes(k) ? +value : value;
        return acc;
      },
      {}
    ),
    connection: {
      application_name: env.PGAPPNAME || "postgres.js",
      ...o.connection,
      ...Object.entries(query).reduce((acc, [k, v]) => (k in defaults || (acc[k] = v), acc), {})
    },
    types: o.types || {},
    target_session_attrs: tsa(o, url, env),
    onnotice: o.onnotice,
    onnotify: o.onnotify,
    onclose: o.onclose,
    onparameter: o.onparameter,
    socket: o.socket,
    transform: parseTransform(o.transform || { undefined: void 0 }),
    parameters: {},
    shared: { retries: 0, typeArrayMap: {} },
    ...mergeUserTypes(o.types)
  };
}
__name(parseOptions, "parseOptions");
function tsa(o, url, env) {
  const x = o.target_session_attrs || url.searchParams.get("target_session_attrs") || env.PGTARGETSESSIONATTRS;
  if (!x || ["read-write", "read-only", "primary", "standby", "prefer-standby"].includes(x))
    return x;
  throw new Error("target_session_attrs " + x + " is not supported");
}
__name(tsa, "tsa");
function backoff(retries) {
  return (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20);
}
__name(backoff, "backoff");
function max_lifetime() {
  return 60 * (30 + Math.random() * 30);
}
__name(max_lifetime, "max_lifetime");
function parseTransform(x) {
  return {
    undefined: x.undefined,
    column: {
      from: typeof x.column === "function" ? x.column : x.column && x.column.from,
      to: x.column && x.column.to
    },
    value: {
      from: typeof x.value === "function" ? x.value : x.value && x.value.from,
      to: x.value && x.value.to
    },
    row: {
      from: typeof x.row === "function" ? x.row : x.row && x.row.from,
      to: x.row && x.row.to
    }
  };
}
__name(parseTransform, "parseTransform");
function parseUrl(url) {
  if (!url || typeof url !== "string")
    return { url: { searchParams: /* @__PURE__ */ new Map() } };
  let host = url;
  host = host.slice(host.indexOf("://") + 3).split(/[?/]/)[0];
  host = decodeURIComponent(host.slice(host.indexOf("@") + 1));
  const urlObj = new URL(url.replace(host, host.split(",")[0]));
  return {
    url: {
      username: decodeURIComponent(urlObj.username),
      password: decodeURIComponent(urlObj.password),
      host: urlObj.host,
      hostname: urlObj.hostname,
      port: urlObj.port,
      pathname: urlObj.pathname,
      searchParams: urlObj.searchParams
    },
    multihost: host.indexOf(",") > -1 && host
  };
}
__name(parseUrl, "parseUrl");
function osUsername() {
  try {
    return os.userInfo().username;
  } catch (_) {
    return process.env.USERNAME || process.env.USER || process.env.LOGNAME;
  }
}
__name(osUsername, "osUsername");

// src/lib/db.ts
function createDb(env) {
  return src_default(env.DIRECT_URL, {
    // Worker dibatasi 6 koneksi bersamaan; sisakan ruang.
    max: 3,
    // Hemat satu round-trip kalau tipe array tidak dipakai.
    fetch_types: false,
    // Prepared statement butuh round-trip tambahan (Parse/Describe).
    // Jalur kita sudah rawan kena batas subrequest, jadi dimatikan.
    prepare: false,
    // EKSPLISIT: tanpa enkripsi. Lihat catatan di atas.
    // Jangan diubah jadi `true`: TLS ke Postgres dari Workers memang gagal,
    // dan kalaupun "jalan" ia bisa turun diam-diam ke tanpa enkripsi.
    ssl: false,
    connect_timeout: 10,
    idle_timeout: 5
  });
}
__name(createDb, "createDb");

// src/config.ts
var WORKER_NAME = "worker-toko";
var DB_MODE = "langsung (tanpa Hyperdrive)";
var DB_ENCRYPTED = false;
var TABLE_GAME = "game_list";
var TABLE_ASSET = "game_asset";
var TABLE_USER = "user";
var TABLE_OTP = "otp";
var TABLE_RECOVERY = "recovery_user";
var ALLOWED_TABLES = /* @__PURE__ */ new Set([TABLE_GAME, TABLE_ASSET]);
var DEFAULT_PAGE_SIZE = 24;
var MAX_PAGE_SIZE = 100;
var MAX_PAGE = 1e4;
var MAX_SEARCH_LENGTH = 100;
var MAX_FILTER_VALUES = 50;
var MAX_FILTER_LENGTH = 64;
var WRITE_TOKEN_HEADER = "x-write-token";
var STEAM_API_URL = "https://store.steampowered.com/api/appdetails";
var STEAM_CC = "us";
var STEAM_FETCH_CONCURRENCY = 8;
var STEAM_FETCH_TIMEOUT_MS = 3e3;
var STEAM_IMAGE_CACHE_TTL_S = 86400;
var MAX_HEADER_IMAGE_LENGTH = 512;
var STEAM_MAX_APP_ID = 4294967295;
var PASSWORD_HASH_TAG = "sha256-v1";
var MAX_PASSWORD_LENGTH = 200;
var MAX_EMAIL_LENGTH = 254;
var MAX_MACHINE_INFO_LENGTH = 8e3;
var OTP_TTL_S = 300;
var ACCESS_TOKEN_TTL_S = 7 * 86400;
var ACCESS_TOKEN_MAX_TTL_S = ACCESS_TOKEN_TTL_S;
var MAX_BODY_BYTES = 16384;
var OTP_DIGITS_HEADER = "x-otp-digits";
var TOKEN_TTL_HEADER = "x-token-ttl-seconds";
var OTP_DIGITS_DEFAULT = 4;
var OTP_DIGITS_MIN = 4;
var OTP_DIGITS_MAX = 6;
var ACCESS_TOKEN_MIN_TTL_S = 60;
var AUTH_SECRET_DEV = "dev-secret-JANGAN-DIPAKAI-DI-PRODUKSI";
var MACHINE_SESSION_KEY = "sesi";
var MACHINE_INFO_KEY = "mesin";
var MACHINE_DEVICE_KEY = "perangkat";
var MACHINE_SESSION_VERSION = 1;
var DEVICE_ID_HEADER = "x-device-id";
var MAX_DEVICE_ID_LENGTH = 128;
var MAX_DEVICE_NAME_LENGTH = 64;
var MIN_DEVICE_ID_LENGTH = 8;
var DEVICE_NAME_HEADER = "x-device-name";
var RECOVERY_MAX_ATTEMPTS = 3;
var RECOVERY_ATTEMPT_WINDOW_S = 900;
var RECOVERY_FAILURE_MARK = 1;
var OTP_REAL_CODE_MIN = 1e3;
var OTP_MIN_INTERVAL_S = 60;
var OTP_MAX_PER_HOUR = 5;
var OTP_MAX_ATTEMPTS = 3;
var STEAM_DETAIL_TIMEOUT_MS = 1e4;
var STEAM_DETAIL_CACHE_TTL_S = 86400;
var MAX_IMAGE_URL_LENGTH = 512;

// src/lib/auth.ts
function resolveAuthSecret(env) {
  const configured = typeof env.AUTH_SECRET === "string" ? env.AUTH_SECRET.trim() : "";
  if (configured) return { secret: configured, temporary: false };
  return { secret: AUTH_SECRET_DEV, temporary: true };
}
__name(resolveAuthSecret, "resolveAuthSecret");
var HEX = "0123456789abcdef";
function bytesToHex(bytes) {
  let out = "";
  for (const b2 of bytes) out += HEX[b2 >> 4] + HEX[b2 & 15];
  return out;
}
__name(bytesToHex, "bytesToHex");
function constantTimeEqual(a, b2) {
  if (a.length !== b2.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b2.charCodeAt(i);
  return diff === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
var MD5_K = [
  3614090360,
  3905402710,
  606105819,
  3250441966,
  4118548399,
  1200080426,
  2821735955,
  4249261313,
  1770035416,
  2336552879,
  4294925233,
  2304563134,
  1804603682,
  4254626195,
  2792965006,
  1236535329,
  4129170786,
  3225465664,
  643717713,
  3921069994,
  3593408605,
  38016083,
  3634488961,
  3889429448,
  568446438,
  3275163606,
  4107603335,
  1163531501,
  2850285829,
  4243563512,
  1735328473,
  2368359562,
  4294588738,
  2272392833,
  1839030562,
  4259657740,
  2763975236,
  1272893353,
  4139469664,
  3200236656,
  681279174,
  3936430074,
  3572445317,
  76029189,
  3654602809,
  3873151461,
  530742520,
  3299628645,
  4096336452,
  1126891415,
  2878612391,
  4237533241,
  1700485571,
  2399980690,
  4293915773,
  2240044497,
  1873313359,
  4264355552,
  2734768916,
  1309151649,
  4149444226,
  3174756917,
  718787259,
  3951481745
];
var MD5_S = [
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21
];
function rotl(x, c) {
  return (x << c | x >>> 32 - c) >>> 0;
}
__name(rotl, "rotl");
function md5Bytes(input) {
  const bitLen = input.length * 8;
  const withPad = new Uint8Array((input.length + 8 >> 6) + 1 << 6);
  withPad.set(input);
  withPad[input.length] = 128;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 8, bitLen >>> 0, true);
  view.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 1732584193;
  let b0 = 4023233417;
  let c0 = 2562383102;
  let d0 = 271733878;
  const m = new Uint32Array(16);
  for (let chunk = 0; chunk < withPad.length; chunk += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(chunk + i * 4, true);
    let a = a0;
    let b2 = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = b2 & c | ~b2 & d;
        g = i;
      } else if (i < 32) {
        f = d & b2 | ~d & c;
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b2 ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b2 | ~d);
        g = 7 * i % 16;
      }
      const rotated = rotl(a + f + MD5_K[i] + m[g] >>> 0, MD5_S[i]);
      const next = b2 + rotated >>> 0;
      a = d;
      d = c;
      c = b2;
      b2 = next;
    }
    a0 = a0 + a >>> 0;
    b0 = b0 + b2 >>> 0;
    c0 = c0 + c >>> 0;
    d0 = d0 + d >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}
__name(md5Bytes, "md5Bytes");
var textEncoder2 = new TextEncoder();
function md5Hex(text) {
  return bytesToHex(md5Bytes(textEncoder2.encode(text)));
}
__name(md5Hex, "md5Hex");
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder2.encode(text));
  return bytesToHex(new Uint8Array(digest));
}
__name(sha256Hex, "sha256Hex");
async function verifyPassword(raw, stored) {
  if (!stored) return false;
  if (stored.startsWith(`${PASSWORD_HASH_TAG}$`)) {
    const rest = stored.slice(PASSWORD_HASH_TAG.length + 1);
    const sep = rest.indexOf("$");
    if (sep < 0) return false;
    const salt = rest.slice(0, sep);
    const expected = rest.slice(sep + 1);
    if (!/^[0-9a-f]{8,64}$/.test(salt) || !/^[0-9a-f]{64}$/.test(expected)) return false;
    return constantTimeEqual(await sha256Hex(`${salt}:${raw}`), expected);
  }
  if (looksLikeMd5(stored)) {
    return constantTimeEqual(md5Hex(raw), stored.toLowerCase());
  }
  return false;
}
__name(verifyPassword, "verifyPassword");
function looksLikeMd5(stored) {
  return typeof stored === "string" && /^[0-9a-f]{32}$/i.test(stored);
}
__name(looksLikeMd5, "looksLikeMd5");
var DUMMY_PASSWORD_HASH = "sha256-v1$00000000000000000000000000000000$a0df811e79069d7cb898d02e7336c1880b93579dabb9aaa84c199917005ae298";
async function burnPasswordTime(raw) {
  await verifyPassword(raw, DUMMY_PASSWORD_HASH);
}
__name(burnPasswordTime, "burnPasswordTime");
function normalizeEmail(raw) {
  return raw.trim().toLowerCase();
}
__name(normalizeEmail, "normalizeEmail");
function isValidEmail(email) {
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return false;
  if (email.length > MAX_EMAIL_LENGTH) return false;
  return true;
}
__name(isValidEmail, "isValidEmail");
var TOKEN_TAG = "v1";
var FINGERPRINT_RE = /^[0-9a-f]{32}$/;
function credentialFingerprint(passwordHash) {
  return md5Hex(passwordHash ?? "");
}
__name(credentialFingerprint, "credentialFingerprint");
function signToken(userId, exp, secret) {
  return md5Hex(`${userId}.${exp}.${secret}`);
}
__name(signToken, "signToken");
function issueAccessToken(userId, passwordHash, secret, ttlS, nowS) {
  const base = Number.isFinite(nowS) ? nowS : Math.floor(Date.now() / 1e3);
  const exp = base + ttlS;
  const signature = signToken(userId, exp, secret);
  const fingerprint = credentialFingerprint(passwordHash);
  return `${TOKEN_TAG}.${userId}.${exp}.${signature}.${fingerprint}`;
}
__name(issueAccessToken, "issueAccessToken");
function tokenHash(token) {
  return md5Hex(token);
}
__name(tokenHash, "tokenHash");
function readAccessToken(token, secret, options = {}) {
  if (!token) return { ok: false, reason: "format" };
  if (token.length > 200) return { ok: false, reason: "bocor" };
  const parts = token.split(".");
  if (parts.length !== 5) return { ok: false, reason: "format" };
  const [tag, userId, expText, signature, fingerprint] = parts;
  if (tag !== TOKEN_TAG) return { ok: false, reason: "format" };
  if (!/^[0-9]{1,20}$/.test(userId)) return { ok: false, reason: "format" };
  if (!/^[0-9]{1,12}$/.test(expText)) return { ok: false, reason: "format" };
  if (!/^[0-9a-f]{32}$/.test(signature)) return { ok: false, reason: "format" };
  if (!FINGERPRINT_RE.test(fingerprint)) return { ok: false, reason: "format" };
  const exp = Number(expText);
  if (!constantTimeEqual(signToken(userId, exp, secret), signature)) {
    return { ok: false, reason: "signature" };
  }
  const nowS = Math.floor((options.nowMs ?? Date.now()) / 1e3);
  const remainingS = exp - nowS;
  if (remainingS <= 0) return { ok: false, reason: "expired" };
  if (options.passwordHash !== void 0 && options.passwordHash !== null) {
    if (!constantTimeEqual(credentialFingerprint(options.passwordHash), fingerprint)) {
      return { ok: false, reason: "signature" };
    }
  }
  const info = { userId, exp, remainingS, fingerprint };
  if (options.withTtl) info.ttlS = remainingS;
  return { ok: true, info };
}
__name(readAccessToken, "readAccessToken");
function generateOtpCode(digits) {
  const max = 10 ** digits;
  const limit = Math.floor(4294967296 / max) * max;
  const buf = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return String(value % max).padStart(digits, "0");
}
__name(generateOtpCode, "generateOtpCode");
function generateStoredOtpCode(digits) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateOtpCode(digits);
    if (code[0] !== "0") return code;
  }
  return generateOtpCode(digits);
}
__name(generateStoredOtpCode, "generateStoredOtpCode");

// src/lib/http.ts
function json(body, status = 200) {
  return Response.json(body, { status });
}
__name(json, "json");
function fail(status, error, code) {
  const body = { ok: false, error };
  if (code) body.code = code;
  return json(body, status);
}
__name(fail, "fail");
var SECRET_PATTERNS = [
  /postgres(?:ql)?:\/\/\S+/gi,
  // connection string
  /sb_secret_[A-Za-z0-9_-]+/g,
  // secret key gaya baru
  /sb_publishable_[A-Za-z0-9_-]+/g,
  // publishable key gaya baru
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
  // JWT lama
];
function scrub(input) {
  const text = input instanceof Error ? `${input.name}: ${input.message}` : String(input);
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, "[RAHASIA DISENSOR]"), text);
}
__name(scrub, "scrub");
function safeEqual(a, b2) {
  if (a.length !== b2.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b2.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
function checkWriteToken(request, env) {
  if (!env.WRITE_TOKEN) return "not-configured";
  const sent = request.headers.get(WRITE_TOKEN_HEADER) ?? "";
  return safeEqual(sent, env.WRITE_TOKEN) ? "ok" : "mismatch";
}
__name(checkWriteToken, "checkWriteToken");

// src/lib/mail.ts
function mailMode(env) {
  if (typeof env.RESEND_API_KEY === "string" && env.RESEND_API_KEY.trim()) return "resend";
  if (typeof env.MAIL_WEBHOOK_URL === "string" && env.MAIL_WEBHOOK_URL.trim()) return "webhook";
  return "uji";
}
__name(mailMode, "mailMode");
var OTP_SUBJECT = "Kode verifikasi akun";
var APP_NAME = "worker-toko";
function otpText(mail) {
  const menit = Math.max(1, Math.round(mail.berlakuDetik / 60));
  return [
    `Kode verifikasi ${APP_NAME}: ${mail.code}`,
    "",
    `Kode ini berlaku ${menit} menit dan hanya bisa dipakai sekali.`,
    "Kalau kamu tidak meminta kode ini, abaikan saja email ini \u2014 tanpa kode, akunmu tidak berubah."
  ].join("\n");
}
__name(otpText, "otpText");
function otpHtml(mail) {
  const menit = Math.max(1, Math.round(mail.berlakuDetik / 60));
  return [
    `<p>Kode verifikasi <strong>${APP_NAME}</strong>:</p>`,
    `<p style="font-size:28px;letter-spacing:6px;font-family:monospace"><strong>${mail.code}</strong></p>`,
    `<p>Kode ini berlaku ${menit} menit dan hanya bisa dipakai sekali.</p>`,
    "<p>Kalau kamu tidak meminta kode ini, abaikan saja email ini \u2014 tanpa kode, akunmu tidak berubah.</p>"
  ].join("");
}
__name(otpHtml, "otpHtml");
async function sendOtpMail(env, mail) {
  const mode = mailMode(env);
  if (mode === "uji") {
    console.log(`[otp][mode-uji] kirim ke ${mail.to}: kode ${mail.code} (berlaku ${mail.berlakuDetik}s)`);
    return { ok: true, mode, error: null };
  }
  try {
    if (mode === "resend") {
      const from = (env.MAIL_FROM ?? "").trim();
      if (!from) {
        return { ok: false, mode, error: "MAIL_FROM belum di-set (wajib untuk Resend)." };
      }
      const res2 = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from,
          to: [mail.to],
          subject: OTP_SUBJECT,
          text: otpText(mail),
          html: otpHtml(mail)
        })
      });
      if (!res2.ok) {
        const detail = (await res2.text().catch(() => "")).slice(0, 300);
        return { ok: false, mode, error: `Resend membalas ${res2.status}: ${detail}` };
      }
      return { ok: true, mode, error: null };
    }
    const webhookUrl = (env.MAIL_WEBHOOK_URL ?? "").trim();
    if (!webhookUrl) {
      return { ok: false, mode, error: "MAIL_WEBHOOK_URL kosong." };
    }
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jenis: "otp",
        to: mail.to,
        kode: mail.code,
        berlaku_detik: mail.berlakuDetik,
        subjek: OTP_SUBJECT,
        teks: otpText(mail)
      })
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, mode, error: `Webhook email membalas ${res.status}: ${detail}` };
    }
    return { ok: true, mode, error: null };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, mode, error: `Pengiriman email gagal: ${message}`.slice(0, 300) };
  }
}
__name(sendOtpMail, "sendOtpMail");

// src/routes/health.ts
function healthRoute(listRoutes) {
  return {
    method: "GET",
    path: "/api/health",
    token: "none",
    requiresDb: false,
    handle: /* @__PURE__ */ __name((ctx) => json({
      ok: true,
      worker: WORKER_NAME,
      db: DB_MODE,
      encrypted: DB_ENCRYPTED,
      routes: listRoutes(),
      directUrlConfigured: Boolean(ctx.env.DIRECT_URL),
      writeTokenConfigured: Boolean(ctx.env.WRITE_TOKEN),
      // Status konfigurasi auth. `authSecretTemporary: true` berarti
      // AUTH_SECRET belum dipasang dan token ditandatangani nilai
      // pengembangan — JANGAN dipakai di produksi.
      authSecretTemporary: resolveAuthSecret(ctx.env).temporary,
      modeEmail: mailMode(ctx.env)
    }), "handle")
  };
}
__name(healthRoute, "healthRoute");

// src/routes/inspect.ts
var inspectRoute = {
  method: "GET",
  path: "/api/db/inspect",
  token: "write",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(({ url }) => {
    const table = url.searchParams.get("table") ?? TABLE_GAME;
    if (!ALLOWED_TABLES.has(table)) {
      return fail(
        400,
        `Tabel tidak diizinkan. Pilihan: ${[...ALLOWED_TABLES].join(", ")}`
      );
    }
    return { input: { table } };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({}, { table }, sql) => {
    const columns = await sql`
			select column_name, data_type, is_nullable, column_default
			from information_schema.columns
			where table_name = ${table}
			order by ordinal_position
		`;
    const exists = await sql`
			select to_regclass(${`public.${table}`}) is not null as table_exists
		`;
    return json({
      ok: true,
      table,
      exists: exists[0]?.table_exists ?? false,
      columns
    });
  }, "handle")
};

// src/lib/params.ts
function readInt(raw, fallback, min, max) {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
__name(readInt, "readInt");
function readBool(raw, fallback = false) {
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "") return fallback;
  return ["1", "true", "ya", "yes", "on"].includes(v);
}
__name(readBool, "readBool");
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
__name(escapeLike, "escapeLike");
function readList(values2, maxValues = 50, maxLength = 64) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of values2) {
    for (const part of raw.split(",")) {
      const value = part.trim().slice(0, maxLength);
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= maxValues) return out;
    }
  }
  return out;
}
__name(readList, "readList");

// src/lib/steam.ts
function toSteamAppId(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > STEAM_MAX_APP_ID) return null;
  return n;
}
__name(toSteamAppId, "toSteamAppId");
function pickHeaderImage(payload, appId) {
  if (!payload || typeof payload !== "object") return null;
  const entry = payload[String(appId)];
  if (!entry || entry.success !== true) return null;
  const image = entry.data?.header_image;
  if (typeof image !== "string") return null;
  const trimmed = image.trim();
  if (!trimmed || trimmed.length > MAX_HEADER_IMAGE_LENGTH) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}
__name(pickHeaderImage, "pickHeaderImage");
async function mapWithLimit(items, limit, fn) {
  if (items.length === 0) return [];
  const out = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (; ; ) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}
__name(mapWithLimit, "mapWithLimit");
async function fetchHeaderImage(appId, fetcher = fetch) {
  const url = `${STEAM_API_URL}?appids=${appId}&cc=${STEAM_CC}&l=en&filters=basic`;
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      // Batas keras: 1 game yang lambat tidak boleh menahan seluruh respons.
      signal: AbortSignal.timeout(STEAM_FETCH_TIMEOUT_MS),
      // Simpan di cache tepi Cloudflare; halaman yang sama tidak menembak
      // Steam lagi selama TTL. Ini yang membuat panggilan berikutnya murah.
      cf: {
        cacheEverything: true,
        cacheTtl: STEAM_IMAGE_CACHE_TTL_S
      }
    });
    if (!response.ok) return null;
    return pickHeaderImage(await response.json(), appId);
  } catch {
    return null;
  }
}
__name(fetchHeaderImage, "fetchHeaderImage");
async function fetchHeaderImages(gameIds, fetcher = fetch) {
  const unique = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of gameIds) {
    const appId = toSteamAppId(raw);
    if (appId === null || seen.has(appId)) continue;
    seen.add(appId);
    unique.push(appId);
  }
  const images = await mapWithLimit(
    unique,
    STEAM_FETCH_CONCURRENCY,
    (appId) => fetchHeaderImage(appId, fetcher)
  );
  const found = /* @__PURE__ */ new Map();
  unique.forEach((appId, index) => {
    const image = images[index];
    if (image) found.set(appId, image);
  });
  return found;
}
__name(fetchHeaderImages, "fetchHeaderImages");
function pickImageUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IMAGE_URL_LENGTH) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}
__name(pickImageUrl, "pickImageUrl");
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
__name(asArray, "asArray");
function pickNamed(value) {
  return asArray(value).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry;
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!description) return [];
    const id = typeof item.id === "string" || typeof item.id === "number" ? item.id : null;
    return id === null ? [] : [{ id, description }];
  });
}
__name(pickNamed, "pickNamed");
function pickRequirements(value) {
  if (value === null || value === void 0) return null;
  if (Array.isArray(value)) return value.length > 0 ? value : null;
  if (typeof value !== "object") return null;
  const obj = value;
  const out = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (typeof raw === "string") {
      if (raw.trim()) out[key] = raw;
    } else if (raw !== null && raw !== void 0) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
__name(pickRequirements, "pickRequirements");
function pickScreenshots(value) {
  return asArray(value).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry;
    const thumbnail = pickImageUrl(item.path_thumbnail);
    const full = pickImageUrl(item.path_full);
    if (!thumbnail && !full) return [];
    const id = typeof item.id === "number" ? item.id : null;
    return [{ id, thumbnail, full }];
  });
}
__name(pickScreenshots, "pickScreenshots");
function shapeSteamDetail(data) {
  return {
    name: typeof data.name === "string" ? data.name : null,
    detailed_description: typeof data.detailed_description === "string" ? data.detailed_description : null,
    short_description: typeof data.short_description === "string" ? data.short_description : null,
    pc_requirements: pickRequirements(data.pc_requirements),
    categories: pickNamed(data.categories),
    genres: pickNamed(data.genres),
    screenshots: pickScreenshots(data.screenshots)
  };
}
__name(shapeSteamDetail, "shapeSteamDetail");
async function fetchSteamDetail(appId, fetcher = fetch) {
  if (toSteamAppId(appId) === null) return { ok: false, reason: "unknown" };
  const url = `${STEAM_API_URL}?appids=${appId}&cc=${STEAM_CC}&l=en`;
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(STEAM_DETAIL_TIMEOUT_MS),
      cf: {
        cacheEverything: true,
        cacheTtl: STEAM_DETAIL_CACHE_TTL_S
      }
    });
    if (!response.ok) return { ok: false, reason: "unreachable" };
    const payload = await response.json();
    const entry = payload?.[String(appId)];
    if (!entry || entry.success !== true) return { ok: false, reason: "unknown" };
    if (!entry.data || typeof entry.data !== "object") {
      return { ok: false, reason: "unknown" };
    }
    return { ok: true, detail: shapeSteamDetail(entry.data) };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
__name(fetchSteamDetail, "fetchSteamDetail");

// src/shape.ts
function tryParseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
__name(tryParseJson, "tryParseJson");
function shapeGame(row, full, headerImage = null) {
  const hasAsset = row.asset_game_id !== null && row.asset_game_id !== void 0;
  const asset = {
    has_asset: hasAsset,
    created_at: row.asset_created_at ?? null,
    updated_at: row.asset_updated_at ?? null
  };
  if (full) {
    asset.lua_data = row.asset_lua_data ?? null;
    asset.metadata = row.asset_metadata ?? null;
    asset.metadata_json = tryParseJson(row.asset_metadata);
    asset.encyription = row.asset_encyription ?? null;
  } else {
    asset.lua_bytes = row.asset_lua_bytes ?? null;
    asset.metadata_bytes = row.asset_metadata_bytes ?? null;
    asset.encyription_bytes = row.asset_ency_bytes ?? null;
  }
  return {
    id: row.id,
    game_id: row.game_id,
    game_name: row.game_name,
    description: row.description ?? null,
    category: row.category ?? null,
    genre: row.genre ?? null,
    tags: row.tags ?? null,
    // URL gambar header dari Steam Store. null kalau Steam tidak menjawab.
    header_image: headerImage,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    asset
  };
}
__name(shapeGame, "shapeGame");

// src/routes/games-list.ts
var gamesListRoute = {
  method: "GET",
  path: "/api/games",
  token: "none",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(({ url }) => {
    const params = url.searchParams;
    return {
      input: {
        page: readInt(params.get("page"), 1, 1, MAX_PAGE),
        pageSize: readInt(
          params.get("page_size"),
          DEFAULT_PAGE_SIZE,
          1,
          MAX_PAGE_SIZE
        ),
        search: (params.get("search") ?? "").trim().slice(0, MAX_SEARCH_LENGTH),
        categories: readList(
          params.getAll("category"),
          MAX_FILTER_VALUES,
          MAX_FILTER_LENGTH
        ),
        genres: readList(
          params.getAll("genre"),
          MAX_FILTER_VALUES,
          MAX_FILTER_LENGTH
        ),
        // Sama seperti kolomnya, nama parameternya tetap "tags" (jamak).
        tags: readList(
          params.getAll("tags"),
          MAX_FILTER_VALUES,
          MAX_FILTER_LENGTH
        ),
        full: readBool(params.get("full"))
      }
    };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({}, input, sql) => {
    const { page, pageSize, search, categories, genres, tags, full } = input;
    const conditions = [];
    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      conditions.push(
        sql`(g.game_name ilike ${pattern} or g.description ilike ${pattern} or g.genre ilike ${pattern} or g.category ilike ${pattern} or g.tags ilike ${pattern})`
      );
    }
    if (categories.length > 0) {
      conditions.push(sql`g.category in ${sql(categories)}`);
    }
    if (genres.length > 0) {
      conditions.push(sql`g.genre in ${sql(genres)}`);
    }
    if (tags.length > 0) {
      const tagConditions = tags.map(
        (tag) => sql`g.tags ilike ${`%${escapeLike(tag)}%`}`
      );
      conditions.push(sql`(${tagConditions.reduce((a, b2) => sql`${a} or ${b2}`)})`);
    }
    const where = conditions.length > 0 ? sql`where ${conditions.reduce((a, b2) => sql`${a} and ${b2}`)}` : sql``;
    const assetColumns = full ? sql`a.lua_data as asset_lua_data, a.metadata as asset_metadata, a.encyription as asset_encyription` : sql`length(a.lua_data) as asset_lua_bytes, length(a.metadata) as asset_metadata_bytes, length(a.encyription) as asset_ency_bytes`;
    const offset = (page - 1) * pageSize;
    const totalRows = await sql`
			select count(*)::int as total
			from ${sql(TABLE_GAME)} g
			${where}
		`;
    const total = Number(totalRows[0]?.total ?? 0);
    const rows = await sql`
			select
				g.id, g.game_id, g.game_name, g.description, g.category,
				g.genre, g.tags, g.created_at, g.updated_at,
				a.game_id as asset_game_id,
				a.created_at as asset_created_at,
				a.updated_at as asset_updated_at,
				${assetColumns}
			from ${sql(TABLE_GAME)} g
			left join ${sql(TABLE_ASSET)} a on a.game_id = g.game_id
			${where}
			order by g.id
			limit ${pageSize + 1} offset ${offset}
		`;
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const headerImages = await fetchHeaderImages(pageRows.map((row) => row.game_id));
    const data = pageRows.map(
      (row) => shapeGame(
        row,
        full,
        headerImages.get(Number(row.game_id)) ?? null
      )
    );
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return json({
      ok: true,
      count: data.length,
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages,
      has_more: hasMore && page < totalPages,
      full,
      search: search || null,
      filters: {
        category: categories,
        genre: genres,
        tags
      },
      data
    });
  }, "handle")
};

// src/routes/games-detail.ts
var gamesDetailRoute = {
  method: "GET",
  path: "/api/games/:game_id",
  pattern: /^\/api\/games\/([^/]+)$/,
  token: "none",
  requiresDb: false,
  prepare: /* @__PURE__ */ __name(({ params }) => {
    const rawId = params[0] ?? "";
    if (!/^\d{1,15}$/.test(rawId)) {
      return fail(400, "game_id harus berupa angka.");
    }
    const gameId = Number(rawId);
    if (gameId <= 0 || gameId > STEAM_MAX_APP_ID) {
      return fail(400, `game_id ${rawId} di luar rentang appid Steam.`);
    }
    return { input: { gameId } };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({}, { gameId }) => {
    const result = await fetchSteamDetail(gameId);
    if (result.ok) {
      return json({ ok: true, data: result.detail });
    }
    if (result.reason === "unknown") {
      return fail(404, `game_id ${gameId} tidak ada di Steam Store.`);
    }
    return fail(502, `Steam tidak bisa dihubungi untuk game_id ${gameId}.`);
  }, "handle")
};

// src/lib/auth-time.ts
function readSeconds(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  let total = 0;
  let matched = false;
  const unitSeconds = {
    day: 86400,
    days: 86400,
    hour: 3600,
    hours: 3600,
    minute: 60,
    minutes: 60,
    second: 1,
    seconds: 1
  };
  for (const part of text.split(" ")) {
    const pair = /^(-?\d+(?:\.\d+)?)(day|days|hour|hours|minute|minutes|second|seconds)?$/.exec(part);
    if (pair) {
      total += Number(pair[1]) * (pair[2] ? unitSeconds[pair[2]] : 1);
      matched = true;
      continue;
    }
    const clock = /^(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(part);
    if (clock) {
      const sign = clock[1] ? -1 : 1;
      total += sign * (Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]));
      matched = true;
    }
  }
  return matched ? total : null;
}
__name(readSeconds, "readSeconds");

// src/lib/auth-store.ts
var OTP_FAILURE_MARK = 0;
var USER_COLUMNS = /* @__PURE__ */ __name((sql) => sql`
	user_id, email, password_hash, access_role_code, access_role_name,
	is_verified, free_claim_game, machine_info, created_at, updated_at
`, "USER_COLUMNS");
function shapeUser(row) {
  return {
    user_id: String(row.user_id),
    email: row.email,
    is_verified: row.is_verified,
    access_role_code: row.access_role_code,
    access_role_name: row.access_role_name,
    free_claim_game: row.free_claim_game,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    // machine_info tidak ikut: isinya keterangan komputer user, bukan untuk
    // ditampilkan. Rutenya sendiri yang mengabarkan "sudah terpasang".
    machine_info_terpasang: Boolean(row.machine_info)
  };
}
__name(shapeUser, "shapeUser");
async function findUserByEmail(sql, email) {
  const rows = await sql`
		select ${USER_COLUMNS(sql)} from ${sql(TABLE_USER)}
		where lower(email) = ${email}
		limit 1
	`;
  return rows[0] ?? null;
}
__name(findUserByEmail, "findUserByEmail");
async function findUserById(sql, userId) {
  const rows = await sql`
		select ${USER_COLUMNS(sql)} from ${sql(TABLE_USER)}
		where user_id = ${userId}::int8
		limit 1
	`;
  return rows[0] ?? null;
}
__name(findUserById, "findUserById");
async function readDbNow(sql) {
  const rows = await sql`select now() as now`;
  return rows[0]?.now ?? /* @__PURE__ */ new Date();
}
__name(readDbNow, "readDbNow");
async function readOtpActivity(sql, userId) {
  const rows = await sql`
		select
			(select count(*)::int from ${sql(TABLE_OTP)}
				where user_id = ${userId}::int8
				  and otp_code >= ${OTP_REAL_CODE_MIN}
				  and created_at > now() - interval '1 hour') as kode_per_jam,
			(select extract(epoch from (now() - max(created_at))) from ${sql(TABLE_OTP)}
				where user_id = ${userId}::int8
				  and otp_code >= ${OTP_REAL_CODE_MIN}) as jeda_detik
	`;
  const row = rows[0];
  return {
    kodePerJam: Number(row?.kode_per_jam ?? 0),
    jedaDetik: readSeconds(row?.jeda_detik)
  };
}
__name(readOtpActivity, "readOtpActivity");
async function issueOtp(sql, userId, code) {
  const activity = await readOtpActivity(sql, userId);
  if (activity.jedaDetik !== null && activity.jedaDetik < OTP_MIN_INTERVAL_S) {
    return {
      ok: false,
      reason: "baru-saja",
      tungguDetik: Math.ceil(OTP_MIN_INTERVAL_S - activity.jedaDetik),
      berlakuDetik: OTP_TTL_S
    };
  }
  if (activity.kodePerJam >= OTP_MAX_PER_HOUR) {
    return { ok: false, reason: "terlalu-sering", tungguDetik: 3600, berlakuDetik: 0 };
  }
  await sql`
		update ${sql(TABLE_OTP)} set is_used = true, updated_at = now()
		where user_id = ${userId}::int8 and is_used = false
	`;
  await sql`
		insert into ${sql(TABLE_OTP)}
			(user_id, otp_code, is_used, expired_at, created_at, updated_at)
		values
			(${userId}::int8, ${code}::int4, false,
			 now() + ${OTP_TTL_S} * interval '1 second', now(), now())
	`;
  return { ok: true, reason: null, tungguDetik: 0, berlakuDetik: OTP_TTL_S };
}
__name(issueOtp, "issueOtp");
async function findLiveOtp(sql, userId) {
  const rows = await sql`
		select id, otp_code, extract(epoch from (expired_at - now())) as sisa_detik
		from ${sql(TABLE_OTP)}
		where user_id = ${userId}::int8 and is_used = false
		order by created_at desc
		limit 1
	`;
  const row = rows[0];
  if (!row) return null;
  return { id: String(row.id), otp_code: Number(row.otp_code), sisaDetik: readSeconds(row.sisa_detik) };
}
__name(findLiveOtp, "findLiveOtp");
async function recordFailedOtpAttempt(sql, userId) {
  await sql`
		insert into ${sql(TABLE_OTP)}
			(user_id, otp_code, is_used, expired_at, created_at, updated_at)
		values
			(${userId}::int8, ${OTP_FAILURE_MARK}, true, now(), now(), now())
	`;
}
__name(recordFailedOtpAttempt, "recordFailedOtpAttempt");
async function countFailedOtpAttempts(sql, userId, liveOtpId) {
  const rows = await sql`
		select count(*)::int as jumlah from ${sql(TABLE_OTP)}
		where user_id = ${userId}::int8
			and otp_code = ${OTP_FAILURE_MARK}
			and created_at >= (select created_at from ${sql(TABLE_OTP)} where id = ${liveOtpId}::int8)
	`;
  return Number(rows[0]?.jumlah ?? 0);
}
__name(countFailedOtpAttempts, "countFailedOtpAttempts");
async function closeOtp(sql, otpId) {
  await sql`
		update ${sql(TABLE_OTP)} set is_used = true, updated_at = now()
		where id = ${otpId}::int8
	`;
}
__name(closeOtp, "closeOtp");
async function markVerified(sql, userId) {
  const rows = await sql`
		update ${sql(TABLE_USER)} set is_verified = true, updated_at = now()
		where user_id = ${userId}::int8
		returning user_id
	`;
  return rows.length > 0;
}
__name(markVerified, "markVerified");
async function readMachineInfo(sql, userId) {
  const rows = await sql`
		select machine_info from ${sql(TABLE_USER)}
		where user_id = ${userId}::int8
		limit 1
	`;
  return rows[0]?.machine_info ?? null;
}
__name(readMachineInfo, "readMachineInfo");
async function saveMachineInfoIf(sql, userId, expected, next) {
  const rows = expected === null ? await sql`
					update ${sql(TABLE_USER)} set machine_info = ${next}, updated_at = now()
					where user_id = ${userId}::int8 and machine_info is null
					returning user_id
				` : await sql`
					update ${sql(TABLE_USER)} set machine_info = ${next}, updated_at = now()
					where user_id = ${userId}::int8 and machine_info = ${expected}
					returning user_id
				`;
  return rows.length > 0;
}
__name(saveMachineInfoIf, "saveMachineInfoIf");

// src/lib/session.ts
function readMachineParts(raw) {
  const empty = { sesi: null, perangkat: null, mesin: null, lain: {} };
  if (typeof raw !== "string" || !raw.trim()) return empty;
  const text = raw.trim();
  if (!text.startsWith("{")) {
    return { sesi: null, perangkat: null, mesin: text, lain: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { sesi: null, perangkat: null, mesin: text, lain: {} };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { sesi: null, perangkat: null, mesin: parsed, lain: {} };
  }
  const obj = parsed;
  const lain = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === MACHINE_SESSION_KEY || key === MACHINE_INFO_KEY || key === MACHINE_DEVICE_KEY) {
      continue;
    }
    lain[key] = value;
  }
  return {
    sesi: parseSession(obj[MACHINE_SESSION_KEY]),
    perangkat: parseDevice(obj[MACHINE_DEVICE_KEY]),
    mesin: obj[MACHINE_INFO_KEY] ?? null,
    lain
  };
}
__name(readMachineParts, "readMachineParts");
function parseSession(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value;
  const exp = Number(obj.exp);
  const iat = Number(obj.iat);
  const fp = typeof obj.fp === "string" ? obj.fp : "";
  const th = typeof obj.th === "string" ? obj.th : "";
  if (!Number.isFinite(exp) || exp <= 0) return null;
  if (!Number.isFinite(iat) || iat < 0) return null;
  if (!/^[0-9a-f]{8,64}$/.test(fp)) return null;
  if (!/^[0-9a-f]{8,64}$/.test(th)) return null;
  return {
    v: Number(obj.v) || MACHINE_SESSION_VERSION,
    exp: Math.trunc(exp),
    iat: Math.trunc(iat),
    fp,
    th
  };
}
__name(parseSession, "parseSession");
function parseDevice(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value;
  const deviceId = typeof obj.device_id === "string" ? obj.device_id.trim() : "";
  if (!deviceId || deviceId.length > MAX_DEVICE_ID_LENGTH) return null;
  const deviceName = typeof obj.device_name === "string" ? obj.device_name.trim() : "";
  const terdaftar = Number(obj.terdaftar_pada);
  const terakhir = Number(obj.terakhir_masuk);
  return {
    device_id: deviceId,
    device_name: deviceName.slice(0, MAX_DEVICE_NAME_LENGTH),
    terdaftar_pada: Number.isFinite(terdaftar) && terdaftar > 0 ? Math.trunc(terdaftar) : 0,
    terakhir_masuk: Number.isFinite(terakhir) && terakhir > 0 ? Math.trunc(terakhir) : 0
  };
}
__name(parseDevice, "parseDevice");
function buildMachineParts(parts) {
  const obj = { ...parts.lain };
  if (parts.sesi) obj[MACHINE_SESSION_KEY] = parts.sesi;
  if (parts.perangkat) obj[MACHINE_DEVICE_KEY] = parts.perangkat;
  if (parts.mesin !== null && parts.mesin !== void 0 && parts.mesin !== "") {
    obj[MACHINE_INFO_KEY] = parts.mesin;
  }
  return JSON.stringify(obj);
}
__name(buildMachineParts, "buildMachineParts");
function withSession(raw, sesi) {
  return buildMachineParts({ ...readMachineParts(raw), sesi });
}
__name(withSession, "withSession");
function withMachineInfo(raw, mesin) {
  return buildMachineParts({ ...readMachineParts(raw), mesin });
}
__name(withMachineInfo, "withMachineInfo");
function withDevice(raw, perangkat) {
  return buildMachineParts({ ...readMachineParts(raw), perangkat });
}
__name(withDevice, "withDevice");
function withoutSession(raw) {
  return buildMachineParts({ ...readMachineParts(raw), sesi: null });
}
__name(withoutSession, "withoutSession");
function hasDevice(perangkat) {
  return perangkat !== null && perangkat.device_id.length > 0;
}
__name(hasDevice, "hasDevice");
function perangkatSah(loginDevice, recoveryDevice) {
  if (hasDevice(recoveryDevice)) return { perangkat: recoveryDevice, sumber: "pemulihan" };
  if (hasDevice(loginDevice)) return { perangkat: loginDevice, sumber: "login" };
  return { perangkat: null, sumber: "kosong" };
}
__name(perangkatSah, "perangkatSah");
function parseRecoveryDevice(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    return parseDevice(JSON.parse(text));
  } catch {
    return null;
  }
}
__name(parseRecoveryDevice, "parseRecoveryDevice");
function sessionMatches(sesi, token) {
  if (!sesi) return false;
  if (sesi.exp !== token.exp) return false;
  if (sesi.fp !== token.fingerprint) return false;
  return true;
}
__name(sessionMatches, "sessionMatches");
function sessionAcceptsFingerprint(sesi, providedHash, credentialFp, nowDbS) {
  if (!sesi) return false;
  if (!constantTimeEqual(sesi.th, providedHash)) return false;
  if (!constantTimeEqual(sesi.fp, credentialFp)) return false;
  return sesi.exp > nowDbS;
}
__name(sessionAcceptsFingerprint, "sessionAcceptsFingerprint");
function sessionExpired(sesi, nowS) {
  return sesi.exp <= nowS;
}
__name(sessionExpired, "sessionExpired");
function machineInfoFits(text) {
  return new TextEncoder().encode(text).length <= MAX_MACHINE_INFO_LENGTH;
}
__name(machineInfoFits, "machineInfoFits");

// src/lib/auth-session.ts
function clampTtl(requested) {
  if (!Number.isFinite(requested)) return ACCESS_TOKEN_TTL_S;
  return Math.min(Math.max(Math.trunc(requested), ACCESS_TOKEN_MIN_TTL_S), ACCESS_TOKEN_MAX_TTL_S);
}
__name(clampTtl, "clampTtl");
function ttlDariRequest(request, url) {
  const teks = request.headers.get(TOKEN_TTL_HEADER)?.trim() || url?.searchParams.get("ttl_s")?.trim() || "";
  const parsed = Number(teks);
  if (!teks || !Number.isFinite(parsed)) return ACCESS_TOKEN_TTL_S;
  return clampTtl(parsed);
}
__name(ttlDariRequest, "ttlDariRequest");
async function startSession(sql, env, userId, passwordHash, ttlS) {
  const { secret } = resolveAuthSecret(env);
  const nowS = Math.floor((await readDbNow(sql)).getTime() / 1e3);
  const sesi = {
    v: 1,
    exp: nowS + ttlS,
    iat: nowS,
    fp: "",
    th: ""
  };
  const token = issueAccessToken(userId, passwordHash, secret, ttlS, nowS);
  const hash = tokenHash(token);
  sesi.fp = credentialFingerprint(passwordHash);
  sesi.th = hash;
  let written = false;
  for (let attempt = 0; attempt < 2 && !written; attempt++) {
    const current = await readMachineInfo(sql, userId);
    const next = withSession(current, sesi);
    if (!machineInfoFits(next)) {
      throw new Error("machine_info kepanjangan untuk menyimpan catatan sesi.");
    }
    written = await saveMachineInfoIf(sql, userId, current, next);
  }
  if (!written) throw new Error("Gagal menyimpan catatan sesi (kolom machine_info berubah terus).");
  return { token, tokenHash: hash, exp: sesi.exp, ttlS };
}
__name(startSession, "startSession");
function sessionSummary(started, nowS) {
  return {
    token: started.token,
    token_hash: started.tokenHash,
    token_type: "x-access-token + x-user-id",
    exp: started.exp,
    expired_at: new Date(started.exp * 1e3).toISOString(),
    ttl_s: started.ttlS,
    sisa_detik: Math.max(0, started.exp - nowS)
  };
}
__name(sessionSummary, "sessionSummary");

// src/lib/auth-otp.ts
function otpDigitsFromHeader(request) {
  const raw = Number(request.headers.get(OTP_DIGITS_HEADER) ?? "");
  if (!Number.isFinite(raw)) return OTP_DIGITS_DEFAULT;
  return Math.min(Math.max(Math.trunc(raw), OTP_DIGITS_MIN), OTP_DIGITS_MAX);
}
__name(otpDigitsFromHeader, "otpDigitsFromHeader");
async function issueAndSendOtp(sql, env, email, userId, digits) {
  const code = generateStoredOtpCode(digits);
  const issued = await issueOtp(sql, userId, code);
  if (!issued.ok) {
    return {
      ok: false,
      alasan: issued.reason ?? "baru-saja",
      pesan: issued.reason === "terlalu-sering" ? "Terlalu banyak permintaan kode. Coba lagi nanti." : `Kode sebelumnya masih berlaku. Tunggu ${issued.tungguDetik} detik lagi.`,
      tunggu_detik: issued.tungguDetik
    };
  }
  const mode = mailMode(env);
  const sent = await sendOtpMail(env, { to: email, code, berlakuDetik: issued.berlakuDetik });
  const hasil = {
    ok: true,
    digits,
    berlaku_detik: issued.berlakuDetik,
    maks_percobaan: OTP_MAX_ATTEMPTS,
    otp_dikirim: sent.ok,
    mode_email: sent.mode ?? mode,
    galat_email: sent.error
  };
  if (mode === "uji") hasil.kode_otp_dev = code;
  return hasil;
}
__name(issueAndSendOtp, "issueAndSendOtp");
function otpResponseBody(hasil) {
  const body = {
    otp_dikirim: hasil.otp_dikirim,
    mode_email: hasil.mode_email,
    berlaku_detik: hasil.berlaku_detik,
    digits: hasil.digits,
    // Dikirim supaya aplikasi tidak perlu menyalin konstanta 60 detik ke
    // dalam kodenya sendiri. Kalau nilainya diubah di Worker, hitung
    // mundurnya ikut berubah tanpa ada rilis aplikasi baru.
    kirim_ulang_detik: OTP_MIN_INTERVAL_S,
    maks_percobaan: OTP_MAX_ATTEMPTS
  };
  if (hasil.galat_email) body.galat_email = hasil.galat_email;
  if (hasil.kode_otp_dev) body.kode_otp_dev = hasil.kode_otp_dev;
  return body;
}
__name(otpResponseBody, "otpResponseBody");

// src/lib/auth-recovery.ts
async function findRecoveryRow(sql, userId, recoveryKey) {
  const rows = await sql`
		select id, user_id, recovery_key, is_used, machine_info
		from ${sql(TABLE_RECOVERY)}
		where user_id = ${userId}::int8 and recovery_key = ${recoveryKey}::int4
		limit 1
	`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    recovery_key: Number(row.recovery_key),
    is_used: Boolean(row.is_used),
    machine_info: row.machine_info ?? null
  };
}
__name(findRecoveryRow, "findRecoveryRow");
async function readRecoveryDevice(sql, userId) {
  const rows = await sql`
		select machine_info from ${sql(TABLE_RECOVERY)}
		where user_id = ${userId}::int8 and machine_info is not null
		order by updated_at desc
		limit 1
	`;
  return parseRecoveryDevice(rows[0]?.machine_info ?? null);
}
__name(readRecoveryDevice, "readRecoveryDevice");
async function claimRecoveryRow(sql, rowId, expectMachineInfo, catatan) {
  let claimed = false;
  await sql.begin(async (tx) => {
    const rows = expectMachineInfo === null ? await tx`
						update ${tx(TABLE_RECOVERY)}
						set machine_info = ${catatan}, is_used = true, updated_at = now()
						where id = ${rowId}::int8 and is_used = false and machine_info is null
						returning id
					` : await tx`
						update ${tx(TABLE_RECOVERY)}
						set is_used = true, updated_at = now()
						where id = ${rowId}::int8
							and is_used = false
							and machine_info = ${expectMachineInfo}
						returning id
					`;
    claimed = rows.length > 0;
    if (!claimed) {
      throw new ClaimCancelled();
    }
  });
  return claimed;
}
__name(claimRecoveryRow, "claimRecoveryRow");
var ClaimCancelled = class extends Error {
  static {
    __name(this, "ClaimCancelled");
  }
  constructor() {
    super("baris pemulihan berubah bersamaan");
    this.name = "ClaimCancelled";
  }
};
function isClaimCancelled(err) {
  return err instanceof ClaimCancelled;
}
__name(isClaimCancelled, "isClaimCancelled");
async function recordFailedRecoveryAttempt(sql, userId) {
  await sql`
		insert into ${sql(TABLE_OTP)}
			(user_id, otp_code, is_used, expired_at, created_at, updated_at)
		values
			(${userId}::int8, ${RECOVERY_FAILURE_MARK}, true, now(), now(), now())
	`;
}
__name(recordFailedRecoveryAttempt, "recordFailedRecoveryAttempt");
async function countFailedRecoveryAttempts(sql, userId, windowS) {
  const rows = await sql`
		select count(*)::int as jumlah
		from ${sql(TABLE_OTP)}
		where user_id = ${userId}::int8
			and otp_code = ${RECOVERY_FAILURE_MARK}
			and created_at > now() - ${windowS} * interval '1 second'
	`;
  return Number(rows[0]?.jumlah ?? 0);
}
__name(countFailedRecoveryAttempts, "countFailedRecoveryAttempts");
async function recoveryRetryAfterS(sql, userId, windowS) {
  const rows = await sql`
		select extract(epoch from (now() - min(created_at))) as jeda_detik
		from ${sql(TABLE_OTP)}
		where user_id = ${userId}::int8
			and otp_code = ${RECOVERY_FAILURE_MARK}
			and created_at > now() - ${windowS} * interval '1 second'
	`;
  const jeda = readSeconds(rows[0]?.jeda_detik);
  if (jeda === null) return 0;
  return Math.max(0, Math.ceil(windowS - jeda));
}
__name(recoveryRetryAfterS, "recoveryRetryAfterS");
function recoveryMachineInfo(device) {
  return JSON.stringify(device);
}
__name(recoveryMachineInfo, "recoveryMachineInfo");

// src/lib/auth-device.ts
function deviceIdFrom(request, body) {
  const dariBody = body ? body.device_id : void 0;
  if (typeof dariBody === "string" && dariBody.trim()) return dariBody.trim().slice(0, MAX_DEVICE_ID_LENGTH);
  if (typeof dariBody === "number" && Number.isFinite(dariBody)) return String(dariBody).slice(0, MAX_DEVICE_ID_LENGTH);
  return (request.headers.get(DEVICE_ID_HEADER) ?? "").trim().slice(0, MAX_DEVICE_ID_LENGTH);
}
__name(deviceIdFrom, "deviceIdFrom");
function deviceNameFrom(request, body) {
  const dariBody = body ? body.device_name : void 0;
  if (typeof dariBody === "string" && dariBody.trim()) return dariBody.trim().slice(0, MAX_DEVICE_NAME_LENGTH);
  return (request.headers.get(DEVICE_NAME_HEADER) ?? "").trim().slice(0, MAX_DEVICE_NAME_LENGTH);
}
__name(deviceNameFrom, "deviceNameFrom");
function deviceIdProblem(deviceId) {
  if (!deviceId) return `Header/field \`device_id\` wajib diisi (${DEVICE_ID_HEADER}).`;
  if (deviceId.length < MIN_DEVICE_ID_LENGTH) {
    return `Nilai \`device_id\` terlalu pendek (minimum ${MIN_DEVICE_ID_LENGTH} karakter).`;
  }
  if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
    return `Nilai \`device_id\` terlalu panjang (maksimum ${MAX_DEVICE_ID_LENGTH} karakter).`;
  }
  return null;
}
__name(deviceIdProblem, "deviceIdProblem");
async function decideDevice(sql, userId, input, nowS) {
  const [login, pemulihan] = await Promise.all([
    readLoginDevice(sql, userId),
    readRecoveryDevice(sql, userId)
  ]);
  const sah = perangkatSah(login, pemulihan);
  if (!sah.perangkat) {
    return {
      ok: true,
      perangkat: null,
      sumber: "kosong",
      perluDaftar: true,
      catatanBaru: buatCatatan(input, nowS)
    };
  }
  if (sah.perangkat.device_id !== input.device_id) {
    return {
      ok: false,
      code: "PERANGKAT_LAIN",
      perangkat: sah.perangkat,
      sumber: sah.sumber,
      perluDaftar: false,
      catatanBaru: null
    };
  }
  return {
    ok: true,
    perangkat: sah.perangkat,
    sumber: sah.sumber,
    perluDaftar: sah.sumber === "login",
    catatanBaru: sah.sumber === "login" ? perbaruiCatatan(sah.perangkat, input, nowS) : null
  };
}
__name(decideDevice, "decideDevice");
async function rememberDevice(sql, userId, catatan) {
  let tersimpan = false;
  for (let attempt = 0; attempt < 3 && !tersimpan; attempt++) {
    const current = await readMachineInfo(sql, userId);
    const next = withDevice(current, catatan);
    if (!machineInfoFits(next)) return false;
    tersimpan = await saveMachineInfoIf(sql, userId, current, next);
  }
  return tersimpan;
}
__name(rememberDevice, "rememberDevice");
function deviceInputProblem(input) {
  return deviceIdProblem(input.device_id);
}
__name(deviceInputProblem, "deviceInputProblem");
function buatCatatan(input, nowS) {
  return {
    device_id: input.device_id,
    device_name: input.device_name,
    terdaftar_pada: nowS,
    terakhir_masuk: nowS
  };
}
__name(buatCatatan, "buatCatatan");
function perbaruiCatatan(lama, input, nowS) {
  return {
    device_id: lama.device_id,
    device_name: input.device_name || lama.device_name,
    terdaftar_pada: lama.terdaftar_pada || nowS,
    terakhir_masuk: nowS
  };
}
__name(perbaruiCatatan, "perbaruiCatatan");
async function readLoginDevice(sql, userId) {
  const parts = readMachineParts(await readMachineInfo(sql, userId));
  return parts.perangkat ?? null;
}
__name(readLoginDevice, "readLoginDevice");

// src/lib/body.ts
async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, `Body terlalu besar (maksimum ${MAX_BODY_BYTES} byte).`);
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return fail(400, "Body permintaan tidak bisa dibaca.");
  }
  if (text.length > MAX_BODY_BYTES) {
    return fail(413, `Body terlalu besar (maksimum ${MAX_BODY_BYTES} byte).`);
  }
  if (!text.trim()) {
    return fail(400, "Body permintaan kosong; kirim JSON.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(400, "Body bukan JSON yang sah.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(400, "Body harus berupa objek JSON.");
  }
  return { value: parsed };
}
__name(readJsonBody, "readJsonBody");
function stringField(body, key) {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}
__name(stringField, "stringField");
function rawField(body, key) {
  const value = body[key];
  if (typeof value === "string") return value;
  if (value === void 0 || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
__name(rawField, "rawField");

// src/routes/auth-login.ts
var authLoginRoute = {
  method: "POST",
  path: "/api/auth/login",
  token: "none",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(async ({ request, url }) => {
    const parsed = await readJsonBody(request);
    if (parsed instanceof Response) return parsed;
    const email = normalizeEmail(stringField(parsed.value, "email"));
    const password = stringField(parsed.value, "password");
    if (!email || !password) {
      return fail(400, "Field `email` dan `password` wajib diisi.");
    }
    if (!isValidEmail(email)) {
      return fail(400, "Bentuk email tidak sah.");
    }
    if (email.length > MAX_EMAIL_LENGTH) {
      return fail(400, `Email terlalu panjang (maksimum ${MAX_EMAIL_LENGTH} karakter).`);
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return fail(400, `Password terlalu panjang (maksimum ${MAX_PASSWORD_LENGTH} karakter).`);
    }
    const deviceId = deviceIdFrom(request, parsed.value);
    const masalahPerangkat = deviceIdProblem(deviceId);
    if (masalahPerangkat) return fail(400, masalahPerangkat, "PERANGKAT_TIDAK_JELAS");
    return {
      input: {
        email,
        password,
        ttlS: ttlDariRequest(request, url),
        digits: otpDigitsFromHeader(request),
        deviceId,
        deviceName: deviceNameFrom(request, parsed.value)
      }
    };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({ env }, { email, password, ttlS, digits, deviceId, deviceName }, sql) => {
    const user = await findUserByEmail(sql, email);
    if (!user) {
      await burnPasswordTime(password);
      return fail(401, "Email atau password salah.");
    }
    const cocok = await verifyPassword(password, user.password_hash);
    if (!cocok) {
      return fail(401, "Email atau password salah.");
    }
    if (!user.is_verified) {
      const hasil = await kirimAtauPakaiKode(sql, env, email, String(user.user_id), digits);
      if (!hasil.body) {
        return json(
          {
            ok: false,
            code: "TUNGGU_SEBENTAR",
            error: hasil.blocked?.pesan ?? "Kode sebelumnya masih berlaku.",
            butuh_verifikasi: true,
            email,
            tunggu_detik: hasil.blocked?.tungguDetik ?? 0
          },
          429
        );
      }
      return json(
        {
          ok: false,
          code: "BELUM_VERIFIKASI",
          error: "Akun belum diverifikasi. Masukkan kode OTP yang dikirim ke email.",
          butuh_verifikasi: true,
          email,
          user_id: String(user.user_id),
          otp: hasil.body
        },
        403
      );
    }
    const nowS = Math.floor((await readDbNow(sql)).getTime() / 1e3);
    const userId = String(user.user_id);
    const device = await decideDevice(sql, userId, { device_id: deviceId, device_name: deviceName }, nowS);
    if (!device.ok) {
      return json(
        {
          ok: false,
          code: "PERANGKAT_LAIN",
          error: "Akun ini sudah terdaftar di komputer lain.",
          petunjuk: "Minta kode pemulihan ke admin."
        },
        403
      );
    }
    if (device.perluDaftar && device.catatanBaru) {
      const tersimpan = await rememberDevice(sql, userId, device.catatanBaru);
      if (!tersimpan) {
        return fail(409, "Data perangkat gagal disimpan karena ada perubahan bersamaan. Coba lagi.");
      }
    }
    const started = await startSession(sql, env, userId, user.password_hash, ttlS);
    return json({
      ok: true,
      status: "login",
      user: shapeUser(user),
      session: sessionSummary(started, nowS),
      perangkat: device.perangkat ? { device_name: device.perangkat.device_name, sumber: device.sumber } : { device_name: deviceName, sumber: "baru" },
      machine_info_diminta: true,
      petunjuk: "Simpan `session.token_hash` di aplikasi, lalu kirim `machine_info` ke POST /api/auth/machine."
    });
  }, "handle")
};
async function kirimAtauPakaiKode(sql, env, email, userId, digits) {
  const live = await findLiveOtp(sql, userId);
  if (live && live.sisaDetik !== null && live.sisaDetik > 0) {
    return {
      body: {
        otp_dikirim: false,
        masih_berlaku: true,
        berlaku_detik: Math.floor(live.sisaDetik),
        digits: String(live.otp_code).length,
        pesan: "Kode sebelumnya masih berlaku. Cek email, atau kirim ulang setelah jedanya lewat."
      }
    };
  }
  const hasil = await issueAndSendOtp(sql, env, email, userId, digits);
  if (!hasil.ok) {
    return { body: null, blocked: { pesan: hasil.pesan, tungguDetik: hasil.tunggu_detik } };
  }
  return { body: otpResponseBody(hasil) };
}
__name(kirimAtauPakaiKode, "kirimAtauPakaiKode");

// src/routes/auth-verify.ts
var authVerifyRoute = {
  method: "POST",
  path: "/api/auth/verify",
  token: "none",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(async ({ request, url }) => {
    const parsed = await readJsonBody(request);
    if (parsed instanceof Response) return parsed;
    const email = normalizeEmail(stringField(parsed.value, "email"));
    const kode = stringField(parsed.value, "kode") || stringField(parsed.value, "otp");
    if (!email || !kode) return fail(400, "Field `email` dan `kode` wajib diisi.");
    if (!isValidEmail(email)) return fail(400, "Bentuk email tidak sah.");
    if (!/^\d{4,6}$/.test(kode)) return fail(400, "Kode OTP harus 4-6 angka.");
    const deviceId = deviceIdFrom(request, parsed.value);
    const masalahPerangkat = deviceIdProblem(deviceId);
    if (masalahPerangkat) return fail(400, masalahPerangkat, "PERANGKAT_TIDAK_JELAS");
    const requested = ttlDariRequest(request, url);
    return {
      input: {
        email,
        kode,
        ttlS: requested,
        deviceId,
        deviceName: deviceNameFrom(request, parsed.value)
      }
    };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({ env }, { email, kode, ttlS, deviceId, deviceName }, sql) => {
    const user = await findUserByEmail(sql, email);
    if (!user) return fail(401, "Kode verifikasi salah atau sudah tidak berlaku.");
    const userId = String(user.user_id);
    const live = await findLiveOtp(sql, userId);
    if (!live) {
      return fail(409, "Tidak ada kode yang menunggu. Minta kode baru lewat kirim ulang OTP.", "TIDAK_ADA_KODE");
    }
    const percobaanSalah = await countFailedOtpAttempts(sql, userId, live.id);
    if (percobaanSalah >= OTP_MAX_ATTEMPTS) {
      await closeOtp(sql, live.id);
      return fail(429, "Terlalu banyak percobaan salah. Minta kode baru.", "KODE_DIMATIKAN");
    }
    if (String(live.otp_code) !== kode) {
      await recordFailedOtpAttempt(sql, userId);
      const sisa = OTP_MAX_ATTEMPTS - (percobaanSalah + 1);
      if (sisa <= 0) {
        await closeOtp(sql, live.id);
        return fail(429, "Kode dimatikan karena terlalu banyak percobaan salah. Minta kode baru.", "KODE_DIMATIKAN");
      }
      return json(
        {
          ok: false,
          code: "KODE_SALAH",
          error: "Kode verifikasi salah.",
          sisa_percobaan: sisa
        },
        401
      );
    }
    await closeOtp(sql, live.id);
    const nowS = Math.floor((await readDbNow(sql)).getTime() / 1e3);
    const device = await decideDevice(sql, userId, { device_id: deviceId, device_name: deviceName }, nowS);
    if (!device.ok) {
      return json(
        {
          ok: false,
          code: "PERANGKAT_LAIN",
          error: "Akun ini sudah terdaftar di komputer lain.",
          petunjuk: "Beli Akses Baru dong, atau di rodok mas rusdi loh ya."
        },
        403
      );
    }
    await markVerified(sql, userId);
    if (device.perluDaftar && device.catatanBaru) {
      const tersimpan = await rememberDevice(sql, userId, device.catatanBaru);
      if (!tersimpan) {
        return fail(409, "Data perangkat gagal disimpan karena ada perubahan bersamaan. Coba lagi.");
      }
    }
    const started = await startSession(sql, env, userId, user.password_hash, ttlS);
    return json({
      ok: true,
      status: "terverifikasi",
      user: { ...shapeUser(user), is_verified: true },
      session: sessionSummary(started, nowS),
      perangkat: device.perangkat ? { device_name: device.perangkat.device_name, sumber: device.sumber } : { device_name: deviceName, sumber: "baru" },
      machine_info_diminta: true
    });
  }, "handle")
};

// src/routes/auth-resend-otp.ts
var authResendOtpRoute = {
  method: "POST",
  path: "/api/auth/resend-otp",
  token: "none",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(async ({ request }) => {
    const parsed = await readJsonBody(request);
    if (parsed instanceof Response) return parsed;
    const email = normalizeEmail(stringField(parsed.value, "email"));
    if (!email) return fail(400, "Field `email` wajib diisi.");
    if (!isValidEmail(email)) return fail(400, "Bentuk email tidak sah.");
    return { input: { email, digits: otpDigitsFromHeader(request) } };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({ env }, { email, digits }, sql) => {
    const user = await findUserByEmail(sql, email);
    if (!user) {
      return json({
        ok: true,
        terkirim: false,
        mode_email: "tidak-diketahui",
        digits
      });
    }
    const hasil = await issueAndSendOtp(sql, env, email, String(user.user_id), digits);
    if (!hasil.ok) {
      return json(
        {
          ok: false,
          code: "TUNGGU_SEBENTAR",
          error: hasil.pesan,
          tunggu_detik: hasil.tunggu_detik
        },
        429
      );
    }
    return json({ ok: true, ...otpResponseBody(hasil) });
  }, "handle")
};

// src/lib/session-guard.ts
var FAIL_TEXT = {
  TOKEN_TIDAK_ADA: "Header X-Access-Token wajib diisi.",
  TOKEN_TIDAK_SAH: "Sesi tidak sah. Silakan login ulang.",
  SESI_HABIS: "Masa berlaku sesi sudah habis. Silakan login ulang.",
  SESI_TIDAK_DIKENAL: "Sesi sudah tidak berlaku (sudah logout atau diganti perangkat lain). Silakan login ulang.",
  AKUN_TIDAK_ADA: "Akun tidak ditemukan. Silakan login ulang.",
  USER_ID_TIDAK_ADA: "Header X-User-Id tidak ada atau bukan angka.",
  PERANGKAT_TIDAK_JELAS: `Header X-Device-Id wajib diisi dan berisi identitas komputer.`,
  PERANGKAT_TIDAK_COCOK: "Sesi ini milik komputer lain. Masuk dari komputer yang terdaftar, atau pindah lewat kode pemulihan."
};
function fail2(code) {
  return { ok: false, code, error: FAIL_TEXT[code] };
}
__name(fail2, "fail");
function sessionFailStatus(code) {
  return code === "PERANGKAT_TIDAK_JELAS" || code === "USER_ID_TIDAK_ADA" ? 400 : 401;
}
__name(sessionFailStatus, "sessionFailStatus");
function looksLikeTokenHash(value) {
  return /^[0-9a-f]{32}$/.test(value);
}
__name(looksLikeTokenHash, "looksLikeTokenHash");
function preflightSession(request, env) {
  const raw = request.headers.get("x-access-token");
  if (!raw) return { ok: false, status: 401, error: FAIL_TEXT.TOKEN_TIDAK_ADA, code: "TOKEN_TIDAK_ADA" };
  if (raw.startsWith("v1.")) {
    const { secret } = resolveAuthSecret(env);
    const result = readAccessToken(raw, secret);
    if (!result.ok) {
      const code = result.reason === "expired" ? "SESI_HABIS" : "TOKEN_TIDAK_SAH";
      return { ok: false, status: 401, error: FAIL_TEXT[code], code };
    }
    return { ok: true, mode: "token", userId: result.info.userId };
  }
  if (!looksLikeTokenHash(raw)) {
    return { ok: false, status: 401, error: FAIL_TEXT.TOKEN_TIDAK_SAH, code: "TOKEN_TIDAK_SAH" };
  }
  const userId = (request.headers.get("x-user-id") ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(userId)) {
    return { ok: false, status: 400, error: FAIL_TEXT.USER_ID_TIDAK_ADA, code: "USER_ID_TIDAK_ADA" };
  }
  return { ok: true, mode: "sidik-jari", userId };
}
__name(preflightSession, "preflightSession");
async function requireSession(sql, env, request, userIdHeader) {
  const raw = request.headers.get("x-access-token");
  if (!raw) return fail2("TOKEN_TIDAK_ADA");
  const nowS = Math.floor((await readDbNow(sql)).getTime() / 1e3);
  const { secret } = resolveAuthSecret(env);
  const isFullToken = raw.startsWith("v1.");
  let userId = (userIdHeader ?? "").trim();
  if (isFullToken) {
    const result = readAccessToken(raw, secret);
    if (!result.ok) {
      return fail2(result.reason === "expired" ? "SESI_HABIS" : "TOKEN_TIDAK_SAH");
    }
    userId = result.info.userId;
  } else if (!looksLikeTokenHash(raw)) {
    return fail2("TOKEN_TIDAK_SAH");
  }
  if (!userId) return fail2("USER_ID_TIDAK_ADA");
  if (!/^[0-9]{1,20}$/.test(userId)) return fail2("USER_ID_TIDAK_ADA");
  const rows = await sql`
		select user_id, password_hash, machine_info
		from user where user_id = ${userId}::int8 limit 1
	`;
  const row = rows[0];
  if (!row) return fail2("AKUN_TIDAK_ADA");
  const parts = readMachineParts(row.machine_info);
  if (!parts.sesi) return fail2("SESI_TIDAK_DIKENAL");
  if (sessionExpired(parts.sesi, nowS)) return fail2("SESI_HABIS");
  const deviceId = (request.headers.get(DEVICE_ID_HEADER) ?? "").trim();
  if (deviceIdProblem(deviceId)) return fail2("PERANGKAT_TIDAK_JELAS");
  const pemulihan = await readRecoveryDevice(sql, userId);
  const sah = perangkatSah(parts.perangkat, pemulihan);
  if (!sah.perangkat || sah.perangkat.device_id !== deviceId) {
    return fail2("PERANGKAT_TIDAK_COCOK");
  }
  if (isFullToken) {
    const checked = readAccessToken(raw, secret, { passwordHash: row.password_hash });
    if (!checked.ok) return fail2("TOKEN_TIDAK_SAH");
    if (!sessionMatches(parts.sesi, checked.info)) return fail2("SESI_TIDAK_DIKENAL");
  } else {
    const credentialFp = credentialFingerprint(row.password_hash);
    if (!sessionAcceptsFingerprint(parts.sesi, raw, credentialFp, nowS)) {
      return fail2("SESI_TIDAK_DIKENAL");
    }
  }
  return {
    ok: true,
    session: {
      mode: isFullToken ? "token" : "sidik-jari",
      userId: String(row.user_id),
      sesi: parts.sesi,
      sisaDetik: parts.sesi.exp - nowS,
      perangkat: sah.perangkat,
      sumberPerangkat: sah.sumber
    }
  };
}
__name(requireSession, "requireSession");

// src/routes/auth-machine.ts
var authMachineRoute = {
  method: "POST",
  path: "/api/auth/machine",
  token: "none",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(async ({ request, env }) => {
    const pre = preflightSession(request, env);
    if (!pre.ok) return fail(pre.status, pre.error, pre.code);
    const parsed = await readJsonBody(request);
    if (parsed instanceof Response) return parsed;
    const machineInfo = rawField(parsed.value, "machine_info") || rawField(parsed.value, "machineInfo");
    if (!machineInfo.trim()) {
      return fail(400, "Field `machine_info` wajib diisi.");
    }
    if (machineInfo.length > MAX_MACHINE_INFO_LENGTH * 2) {
      return fail(413, `Field \`machine_info\` terlalu besar (maksimum ${MAX_MACHINE_INFO_LENGTH} byte).`);
    }
    return { input: { machineInfo } };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({ request, env }, { machineInfo }, sql) => {
    const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
    if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
    const nilaiMesin = uraiMesin(machineInfo);
    let tersimpan = false;
    for (let attempt = 0; attempt < 3 && !tersimpan; attempt++) {
      const current = await readMachineInfo(sql, check.session.userId);
      const next = withMachineInfo(current, nilaiMesin);
      if (!machineInfoFits(next)) {
        return fail(413, `Keterangan komputer terlalu besar (maksimum ${MAX_MACHINE_INFO_LENGTH} byte).`);
      }
      tersimpan = await saveMachineInfoIf(sql, check.session.userId, current, next);
    }
    if (!tersimpan) {
      return fail(409, "Data komputer gagal disimpan karena ada perubahan bersamaan. Coba lagi.");
    }
    return json({
      ok: true,
      user_id: check.session.userId,
      machine_info_terpasang: true,
      // Sesi ikut dilaporkan supaya FE bisa memastikan catatan sesinya
      // masih utuh setelah penulisan ini.
      sesi_sisa_detik: check.session.sisaDetik,
      mode_sesi: check.session.mode
    });
  }, "handle")
};
function uraiMesin(raw) {
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
__name(uraiMesin, "uraiMesin");

// src/routes/auth-me.ts
var authMeRoute = {
  method: "GET",
  path: "/api/auth/me",
  token: "none",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(({ request, env }) => {
    const pre = preflightSession(request, env);
    if (!pre.ok) return fail(pre.status, pre.error, pre.code);
    return { input: {} };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({ request, env }, _input, sql) => {
    const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
    if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
    const user = await findUserById(sql, check.session.userId);
    if (!user) return fail(401, "Akun tidak ditemukan. Silakan login ulang.", "AKUN_TIDAK_ADA");
    const perangkat = check.session.perangkat;
    const parts = readMachineParts(await readMachineInfo(sql, check.session.userId));
    return json({
      ok: true,
      user: shapeUser(user),
      sesi: {
        mode: check.session.mode,
        exp: check.session.sesi.exp,
        expired_at: new Date(check.session.sesi.exp * 1e3).toISOString(),
        dibuat_pada: new Date(check.session.sesi.iat * 1e3).toISOString(),
        sisa_detik: check.session.sisaDetik
      },
      // Keterangan perangkat yang SAH untuk akun ini. `sumber_perangkat`
      // dipakai layar Pengaturan untuk memberi tahu pengguna bahwa
      // komputer ini terdaftar lewat kode pemulihan, bukan lewat login.
      perangkat: perangkat ? {
        device_id: perangkat.device_id,
        device_name: perangkat.device_name,
        terdaftar_pada: perangkat.terdaftar_pada ? new Date(perangkat.terdaftar_pada * 1e3).toISOString() : null,
        terakhir_masuk: perangkat.terakhir_masuk ? new Date(perangkat.terakhir_masuk * 1e3).toISOString() : null
      } : null,
      sumber_perangkat: check.session.sumberPerangkat,
      // Bagian "mesin" apa adanya; null kalau FE belum pernah mengirimnya.
      machine_info: parts.mesin
    });
  }, "handle")
};

// src/routes/auth-logout.ts
var authLogoutRoute = {
  method: "POST",
  path: "/api/auth/logout",
  token: "none",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(({ request, env }) => {
    const pre = preflightSession(request, env);
    if (!pre.ok) return fail(pre.status, pre.error, pre.code);
    return { input: {} };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({ request, env }, _input, sql) => {
    const check = await requireSession(sql, env, request, request.headers.get("x-user-id"));
    if (!check.ok) return fail(sessionFailStatus(check.code), check.error, check.code);
    let terhapus = false;
    for (let attempt = 0; attempt < 3 && !terhapus; attempt++) {
      const current = await readMachineInfo(sql, check.session.userId);
      terhapus = await saveMachineInfoIf(sql, check.session.userId, current, withoutSession(current));
    }
    if (!terhapus) {
      return fail(409, "Logout gagal karena ada perubahan bersamaan. Coba lagi.");
    }
    return json({ ok: true, status: "logout", user_id: check.session.userId });
  }, "handle")
};

// src/routes/auth-recovery.ts
var authRecoveryRoute = {
  method: "POST",
  path: "/api/auth/recovery",
  token: "none",
  requiresDb: true,
  prepare: /* @__PURE__ */ __name(async ({ request, url }) => {
    const parsed = await readJsonBody(request);
    if (parsed instanceof Response) return parsed;
    const email = normalizeEmail(stringField(parsed.value, "email"));
    const recoveryKey = stringField(parsed.value, "recovery_key") || stringField(parsed.value, "kode") || stringField(parsed.value, "kode_pemulihan");
    if (!email || !recoveryKey) return fail(400, "Field `email` dan `recovery_key` wajib diisi.");
    if (!isValidEmail(email)) return fail(400, "Bentuk email tidak sah.");
    if (!/^\d{1,10}$/.test(recoveryKey)) return fail(400, "Kode pemulihan harus berupa angka.");
    const deviceId = deviceIdFrom(request, parsed.value);
    const masalahPerangkat = deviceInputProblem({ device_id: deviceId, device_name: "" });
    if (masalahPerangkat) return fail(400, masalahPerangkat, "PERANGKAT_TIDAK_JELAS");
    const requested = ttlDariRequest(request, url);
    return {
      input: {
        email,
        recoveryKey,
        ttlS: requested,
        deviceId,
        deviceName: deviceNameFrom(request, parsed.value)
      }
    };
  }, "prepare"),
  handle: /* @__PURE__ */ __name(async ({ env }, { email, recoveryKey, ttlS, deviceId, deviceName }, sql) => {
    const user = await findUserByEmail(sql, email);
    if (!user) {
      return kodeSalah(RECOVERY_MAX_ATTEMPTS - 1);
    }
    const userId = String(user.user_id);
    const gagalSebelumnya = await countFailedRecoveryAttempts(sql, userId, RECOVERY_ATTEMPT_WINDOW_S);
    if (gagalSebelumnya >= RECOVERY_MAX_ATTEMPTS) {
      const tunggu = await recoveryRetryAfterS(sql, userId, RECOVERY_ATTEMPT_WINDOW_S);
      return json(
        {
          ok: false,
          code: "TUNGGU_SEBENTAR",
          error: `Terlalu banyak percobaan kode pemulihan. Coba lagi dalam ${tunggu} detik.`,
          tunggu_detik: tunggu
        },
        429
      );
    }
    const nowS = Math.floor((await readDbNow(sql)).getTime() / 1e3);
    const baris = await findRecoveryRow(sql, userId, recoveryKey);
    if (!baris) {
      await recordFailedRecoveryAttempt(sql, userId);
      return kodeSalah(RECOVERY_MAX_ATTEMPTS - (gagalSebelumnya + 1));
    }
    if (baris.is_used) {
      return json(
        {
          ok: false,
          code: "KODE_PEMULIHAN_TERPAKAI",
          error: "Kode ini sudah pernah dipakai. Minta kode baru ke admin."
        },
        409
      );
    }
    const catatanBaru = {
      device_id: deviceId,
      device_name: deviceName,
      terdaftar_pada: nowS,
      terakhir_masuk: nowS
    };
    const isiLama = baris.machine_info;
    if (isiLama === null) {
      const tersimpan2 = await klaim(sql, baris.id, null, catatanBaru);
      if (!tersimpan2) return gagalBalapan();
      return pulih(sql, env, user, userId, catatanBaru, "pemulihan", ttlS, nowS);
    }
    const perangkatLama = parseRecoveryDevice(isiLama);
    if (!perangkatLama) {
      return fail(
        409,
        "Catatan pemulihan baris ini tidak bisa dibaca. Minta kode baru ke admin.",
        "CATATAN_PEMULIHAN_RUSAK"
      );
    }
    if (perangkatLama.device_id !== deviceId) {
      return json(
        {
          ok: false,
          code: "PERANGKAT_LAIN",
          error: "Akun ini sudah terdaftar di komputer lain lewat pemulihan sebelumnya.",
          petunjuk: "Minta kode pemulihan baru ke admin."
        },
        403
      );
    }
    const tersimpan = await klaim(sql, baris.id, isiLama, catatanBaru);
    if (!tersimpan) return gagalBalapan();
    return pulih(sql, env, user, userId, perangkatLama, "pemulihan", ttlS, nowS);
  }, "handle")
};
function kodeSalah(sisa) {
  return json(
    {
      ok: false,
      code: "KODE_PEMULIHAN_SALAH",
      error: "Kode pemulihan salah.",
      sisa_percobaan: Math.max(0, sisa)
    },
    401
  );
}
__name(kodeSalah, "kodeSalah");
function gagalBalapan() {
  return fail(409, "Data pemulihan berubah bersamaan. Coba lagi.", "PEMULIHAN_BALAPAN");
}
__name(gagalBalapan, "gagalBalapan");
async function klaim(sql, rowId, expectMachineInfo, catatan) {
  try {
    return await claimRecoveryRow(sql, rowId, expectMachineInfo, recoveryMachineInfo(catatan));
  } catch (err) {
    if (isClaimCancelled(err)) return false;
    throw err;
  }
}
__name(klaim, "klaim");
async function pulih(sql, env, user, userId, perangkat, sumber, ttlS, nowS) {
  if (!user) return fail(401, "Akun tidak ditemukan. Silakan login ulang.", "AKUN_TIDAK_ADA");
  const started = await startSession(sql, env, userId, user.password_hash, ttlS);
  if (!user.is_verified) await markVerified(sql, userId);
  return json({
    ok: true,
    status: "pulih",
    user: { ...shapeUser(user), is_verified: true },
    session: sessionSummary(started, nowS),
    perangkat: { device_id: perangkat.device_id, device_name: perangkat.device_name, sumber },
    machine_info_diminta: true,
    petunjuk: "Komputer ini sekarang terdaftar. Komputer lama langsung terputus."
  });
}
__name(pulih, "pulih");

// src/index.ts
var ROUTES = [
  healthRoute(() => routeList()),
  inspectRoute,
  gamesListRoute,
  gamesDetailRoute,
  // --- auth: urutan tidak masalah, semuanya jalur statis -------------------
  authLoginRoute,
  authVerifyRoute,
  authResendOtpRoute,
  authMachineRoute,
  authMeRoute,
  authLogoutRoute,
  authRecoveryRoute
];
function routeList() {
  return ROUTES.map((route) => `${route.method} ${route.path}`);
}
__name(routeList, "routeList");
function matchRoute(route, method, path) {
  if (route.method !== method) return null;
  const pattern = route.pattern ?? new RegExp(`^${route.path}$`);
  const match = pattern.exec(path);
  if (!match) return null;
  return match.slice(1);
}
__name(matchRoute, "matchRoute");
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    let route;
    let params = [];
    for (const candidate of ROUTES) {
      const captured = matchRoute(candidate, request.method, path);
      if (captured) {
        route = candidate;
        params = captured;
        break;
      }
    }
    if (!route) {
      return fail(404, `Rute tidak dikenal: ${request.method} ${path}`);
    }
    const context = { request, env, executionCtx: ctx, url, params };
    if (path.startsWith("/api/auth/") && resolveAuthSecret(env).temporary) {
      console.warn(
        "[auth] AUTH_SECRET belum di-set; token ditandatangani nilai pengembangan. Jalankan: wrangler secret put AUTH_SECRET"
      );
    }
    if (route.token === "write") {
      const status = checkWriteToken(request, env);
      if (status === "not-configured") {
        return fail(503, "WRITE_TOKEN belum di-set di server.");
      }
      if (status === "mismatch") {
        return fail(401, "Token tulis tidak sah.");
      }
    }
    try {
      const input = route.prepare ? await route.prepare(context) : { input: void 0 };
      if (input instanceof Response) return input;
      if (!route.requiresDb) {
        return await route.handle(context, input.input);
      }
      if (!env.DIRECT_URL) {
        return fail(
          500,
          "Secret DIRECT_URL belum di-set. Jalankan: wrangler secret put DIRECT_URL"
        );
      }
      const sql = createDb(env);
      try {
        return await route.handle(context, input.input, sql);
      } finally {
        ctx.waitUntil(sql.end({ timeout: 5 }));
      }
    } catch (err) {
      return json({ ok: false, error: scrub(err) }, 500);
    }
  }
};
export {
  index_default as default,
  routeList
};
//# sourceMappingURL=index.js.map
