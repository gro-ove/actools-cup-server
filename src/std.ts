/** A standard library I prepared for myself to use with Bun.js servers. */
import { Database, Statement } from 'bun:sqlite';
import { EventEmitter } from 'node:events';

/** Some useful extensions. */
type EchoFn = (msg: string[], ...args: any[]) => EchoFn;
type PluralFn = (msg: string[], ...args: any[]) => string;

declare global {
  interface Array<T> {
    groupBy(callback: (item: T) => string): { [key: string]: T[] };
    contains(item: T): boolean;
    count(callback: (item: T) => boolean): number;
    unique(): T[];
  }

  interface Number {
    hasFlag(flag: number): boolean;
    setFlag(flag: number, condition: boolean): number;
  }

  interface JSON {
    tryParse<T extends any>(data: string | false | null, fallback: T): T;
  }

  const echo: EchoFn;
  const plural: PluralFn;

  // (?<!U)`/[^`]+/\$\{(?!encodeURIComponent)
  const U: PluralFn;
}

Array.prototype.groupBy = function (c) { return this.reduce((rv, x) => { let k = c(x); (rv[k] = rv[k] || []).push(x); return rv; }, {}); };
Array.prototype.contains = function (v) { for (let i = 0; i < this.length; i++) { if (this[i] === v) return true; } return false; };
Array.prototype.count = function (fn) { let r = 0; for (let i = 0; i < this.length; i++) { if (fn(this[i])) ++r; } return r; }
Array.prototype.unique = function () { return [...new Set(this)]; };
Number.prototype.hasFlag = function (f) { return (this & f) === f; };
Number.prototype.setFlag = function (f, c) { return c ? (this | f) : (this & ~f); };

JSON.tryParse = (x, fallback) => {
  try {
    return x ? JSON.parse(x) : null;
  } catch (e) {
    return fallback;
  }
};

/** A primitive solution for ensuring tasks run one after another and not in parallel. */
export class Busy {
  queue: null | Function[] = null;

  wait(): Promise<any> {
    return new Promise(resolve => {
      if (!this.queue) resolve(this.take());
      else this.queue.push(resolve);
    });
  }

  async run(fn: Function) {
    using _ = await this.wait();
    return await fn();
  }

  taken() {
    return this.queue != null;
  }

  take() {
    if (this.queue) throw new Error('Incorrect state: already taken');
    this.queue = [];
    const lock = {
      [Symbol.dispose]: () => {
        // @ts-ignore
        if (this.queue.length > 0) this.queue.shift()(lock);
        else this.queue = null;
      }
    };
    return lock;
  }
}

/** Some helpers to deal with file system. */
export const fsExt = {
  mkdirPSync(dir: string) {
    const fs = require('fs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  }
};

let __installBusy: Busy | null = null;

/** Some extra niceties to deal with JavaScript. */
export const jsExt = {
  disposable(fn: Function) { return { [Symbol.dispose]: fn }; },
  raiseError(err: string | Error) { throw typeof err === 'string' ? new Error(err) : err; },
  tryCall<T, TErr>(fn: () => T, fnCatch: null | ((err: Error) => TErr) = null, fnFinally: null | Function = null): T | TErr | null { try { return fn(); } catch (e) { return fnCatch && fnCatch(e); } finally { fnFinally && fnFinally(); } },
  async tryCallAsync<T, TErr>(fn: () => T, fnCatch: null | ((err: Error) => TErr) = null, fnFinally: null | Function = null) { try { return await fn(); } catch (e) { return fnCatch && await fnCatch(e); } finally { fnFinally && fnFinally(); } },

  requireAsync(pkg: string) {
    try {
      return Promise.resolve(require(pkg));
    } catch {
      return new Promise(async (res, rej) => {
        if (!__installBusy) __installBusy = new Busy();
        const w = await __installBusy.wait();
        require('child_process').exec(`bun install --no-save ${pkg}`, (e: any) => {
          console.log(`Module ${pkg} ${e ? 'failed to install' : 'installed'}`);
          jsExt.tryCall(() => res(require(pkg)), rej);
          w[Symbol.dispose]();
        });
      });
    }
  },

  /** Install a package in a lazy way and turn into a function using that package (currently, I can’t be bothered to deal with NPM and package.json) */
  withRequired<Ret, A extends unknown[] = []>(pkg: string, handler: (packageRef: any, ...args: A) => Ret): ((...args: A) => Ret) & { ready: () => boolean } {
    let p: any, s = {};
    jsExt.requireAsync(pkg).then(r => p = r, err => p = '' + err);
    return Object.assign((...args: A) => {
      if (!p || typeof p === 'string') throw new Error(p || 'Package is not ready');
      return handler.call(s, p, ...args);
    }, { ready() { return !!(p && typeof p !== 'string'); } });
  }
};

export function prepareAsset(type: 'css' | 'js', data: string) {
  data = ('' + data).trim();
  if (type === 'css') {
    return data.replace(/\s+/g, ' ');
  }
  if (type === 'js') {
    return data.replace(/^\s*(?:\/\/.*|\/\*[\s\S]+?\*\/)/gm, '').replace(/\s*\n\s+/g, '\n');
  }
  return data;
};

/** Something to broadcast events, good for weaking code cohesion. */
export class Mediator {
  hooks: Map<string, (Function & { _priority: number })[]> = new Map();
  register(key: string, fn: Function, priority = 0) {
    if (typeof fn !== 'function') throw new Error('Function is required')
    let k = this.hooks.get(key);
    if (!k) {
      this.hooks.set(key, k = []);
    }
    k.push(Object.assign(fn, { _priority: priority }));
    k.sort((a, b) => a._priority - b._priority);
  }
  trigger<T>(key: string, arg: T, ...args: unknown[]) {
    const k = this.hooks.get(key);
    if (k) for (const e of k) e(arg, ...args);
    return arg;
  }
  async async<T>(key: string, arg: T, ...args: unknown[]) {
    const k = this.hooks.get(key);
    if (k) for (const e of k) await e(arg, ...args);
    return arg;
  }
  poll(key: string, ...args: unknown[]): unknown | undefined {
    const k = this.hooks.get(key);
    if (!k) return;
    for (const e of k) {
      const r = e(...args);
      if (r !== undefined) return r;
    }
  }
};

/** Thing to help with lazy initialization. */
export class LazyMap<K, V, A extends unknown[] = []> {
  map: Map<K, V | null> = new Map();
  fnGet: ((key: K, ...args: A) => V);
  fnSet: ((key: K, value: V | null) => boolean);
  constructor(fnGet: ((key: K, ...args: A) => V), fnSet: ((key: K, value: V | null) => boolean)) {
    this.map = new Map();
    this.fnGet = fnGet;
    this.fnSet = fnSet;
  }
  has(key: K, ...args: A) {
    let r = this.map.get(key);
    if (r === undefined) this.map.set(key, r = this.fnGet(key, ...args) || null);
    return r != null;
  }
  get(key: K, ...args: A) {
    let r = this.map.get(key);
    if (r === undefined) this.map.set(key, r = this.fnGet(key, ...args) || null);
    return r;
  }
  set(key: K, value: V, ...args: A) {
    if (value == null) return this.delete(key, ...args);
    if (!this.fnSet || Bun.deepEquals(this.get(key, ...args), value)) return false;
    this.map.set(key, value);
    return this.fnSet(key, value);
  }
  delete(key: K, ...args: A) {
    if (!this.fnSet || this.get(key, ...args) == null) return false;
    this.map.set(key, null);
    return this.fnSet(key, null);
  }
  clear() {
    this.map.clear();
  }
}

/** Turns interval in form of `1 hour 15 minutes 7 seconds` into milliseconds, supports units from seconds to weeks. */
function parseTimer(interval: string | string[] | number) {
  if (typeof interval === 'string') {
    for (var r = 0, c: any, x = /(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e\d+)?)\s*([a-zA-Z])?/g; c = x.exec(interval);) {
      r += +c[1] * [1e3, 60, 60, 24, 7].slice(0, 'smhdw'.indexOf(c[2].toLowerCase()) + 1).reduce((p, c) => p *= c, 1);
    }
    return r;
  }
  if (Array.isArray(interval)) {
    return interval.reduce((p, c) => p + parseTimer(c), 0);
  }
  return (+interval | 0) || 1e3;
}

let serviceDelay = 0;

export const Timer = Object.assign(parseTimer, {
  parse: parseTimer,
  ms: parseTimer,
  seconds: (interval: string | number) => parseTimer(interval) / 1e3,
  date: (shift: string | number) => new Date(Date.now() + parseTimer(shift)),
  timestamp: (shift: string | number) => Date.now() + parseTimer(shift),
  timeout: (delay: string | number, callback: Function) => ({ [Symbol.dispose]: clearTimeout.bind(null, setTimeout(callback, parseTimer(delay))) }),
  interval: (interval: string | number, callback: Function) => ({ [Symbol.dispose]: clearInterval.bind(null, setInterval(callback, parseTimer(interval))) }),
  service: (interval: string | number, callback: () => Promise<any>, errorHandler: (err: Error | any) => void) => {
    let parsed = parseTimer(interval), timeout: Timer | false;
    async function cb() {
      if (timeout === false) return;
      timeout = null;
      let ret = jsExt.tryCallAsync(callback, errorHandler);
      if (timeout == null) timeout = setTimeout(cb, (typeof ret === 'number' || typeof ret === 'string' ? parseTimer(ret) : 0) || parsed);
    }
    timeout = setTimeout(cb, serviceDelay += 1e3);
    return {
      poke: (delay: string | number) => {
        if (timeout === false) return;
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(cb, parseTimer(delay));
      },
      [Symbol.dispose]: () => {
        if (timeout) clearTimeout(timeout);
        timeout = false;
      }
    };
  },
});

/** Thing keeping track of N last entries and returning them in last-to-first order, fast to write but slow to read. */
export class HistoryTracker<T> {
  count = 0;
  buffer: T[];
  constructor(capacity: number) {
    this.count = 0;
    this.buffer = new Array(capacity);
  }
  add(item: T) {
    this.buffer[this.count++ % this.buffer.length] = item;
  }
  get entries() {
    let end = this.buffer.slice(0, this.count % this.buffer.length);
    if (this.count >= this.buffer.length) end = [...this.buffer.slice(this.count % this.buffer.length), ...end];
    return end.reverse();
  }
}

/** Simple thing for measuring performance. */
export class PerfCounter {
  started = -1;
  count = 0;
  totalTimeMs = 0;
  maxTimeMs = 0;
  history: HistoryTracker<{ [0]: number, [1]: string }> | null = null;
  start() {
    this.started = Bun.nanoseconds();
  }
  consider(context: string) {
    if (this.started < 0) {
      return 0;
    }
    const timeMs = (Bun.nanoseconds() - this.started) / 1e6;
    this.started = -1;
    if (context) {
      (this.history || (this.history = new HistoryTracker(8))).add([timeMs, context]);
    }
    ++this.count;
    this.totalTimeMs += timeMs;
    this.maxTimeMs = Math.max(this.maxTimeMs * 0.99, timeMs);
    return timeMs;
  }
  get avgTimeMs() {
    return this.totalTimeMs / Math.max(1, this.count);
  }
}

/** Another simple thing for limiting POST requests and such. */
export class RateLimiter {
  #limit: number;
  #cooldown: number;
  #entries: Map<string, { count: number }> = new Map();

  constructor(limit: number, cooldown: number | string | string[]) {
    this.#limit = Math.max(limit, 1);
    this.#cooldown = Timer.parse(cooldown);
  }

  check(context: string) {
    let entry = this.#entries.get(context);
    if (!entry) {
      entry = { count: 0 };
      this.#entries.set(context, entry);
    } else if (entry.count >= this.#limit) {
      return false;
    }
    ++entry.count;
    setTimeout(() => {
      if (--entry.count === 0) {
        this.#entries.delete(context);
      }
    }, this.#cooldown);
    return true;
  }
}

/** Simple alternative to https://sqids.org/. */
export class Sqid {
  key: string;
  constructor(key: string | null) {
    this.key = key || '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  }
  encode(m: number, e: number = 0): string {
    for (var n = m, s = '', h = Number((BigInt(Bun.hash('' + m)) + BigInt(e || 0)) % BigInt(this.key.length)); n > 0; n = n / this.key.length | 0) s = this.key[((n % this.key.length) + h) % this.key.length] + s;
    s += this.key[h];
    for (var t = 0, i = 0; i < s.length; ++i) t = ((t * 397) ^ s.charCodeAt(i)) & 0x7fffffff;
    s += this.key[(t + h) % this.key.length];
    return e < 32 && Sqid.nasty(s) ? this.encode(m, e + 1) : s;
  }
  decode(s: string, offset = 0) {
    var n = 0, h = this.key.length - this.key.indexOf(s[s.length - 2]);
    for (var t = 0, i = offset; i < s.length - 1; ++i) t = ((t * 397) ^ s.charCodeAt(i)) & 0x7fffffff;
    for (var i = offset; i < s.length - 2; ++i) n = n * this.key.length + (this.key.indexOf(s[i]) + h) % this.key.length;
    return this.key[(t + this.key.length - h) % this.key.length] === s[s.length - 1] ? n : null;
  }
  static nasty(s: string) {
    return /1488|cunt|fag|fu[ck]k|k[i1]ke|n[i1e]g|rap[ei]|twat/i.test(s)
  }
};

/** Something to use number encoding with more than 36 characters per digit. */
export class NumberEncoder {
  key: string;
  constructor(key: string | null) {
    this.key = key || '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  }
  encode(n: number): string {
    for (var s = ''; n > 0; n = n / this.key.length | 0) s = this.key[n % this.key.length] + s;
    return s;
  }
  decode(s: string, offset = 0, len = Infinity): number {
    len = Math.min(s.length, len);
    for (var n = 0, i = offset; i < len; ++i) n = n * this.key.length + this.key.indexOf(s[i]);
    return n;
  }
};

/** Promises can be reused, so why not serve the same promise to different waiters as long as arguments are the same. */
export class PromiseReuser {
  w = new Map();
  run<T extends unknown[], TResult>(fn: (...args: T) => Promise<TResult>, ...args: T): Promise<TResult> {
    const k = args.reduce((p: bigint, k) => p * BigInt(397) ^ BigInt(Bun.hash('' + k)), BigInt(0));
    let r = this.w.get(k);
    if (!r) this.w.set(k, r = new Promise((r, e) => fn(...args).then(r, e)).finally(() => this.w.delete(k)));
    return r;
  }
}

/** Simplest router. */
export class Router {
  methods = {};

  /** Usage: `.on('POST', '/url/with/leading/slash/:paramID/:' (grab the rest as empty param), callback)` */
  on(group: string, path: string, callback: Function) {
    if (path[0] !== '/') throw new Error(`Incorrect path: ${group} ${path}`);
    const e = path.substring(1).split('/').reduce((p, s) => {
      if (group === 'HEAD') console.log(s);
      if (!s || s === ':') return Object.assign(p, s && { param: '' });
      const k = s.startsWith(':') ? '' : s;
      return p.children[k] || (p.children[k] = ({ children: {}, param: s.startsWith(':') ? s.substring(1) : null, callback: null }));
    }, this.methods[group] || (this.methods[group] = { children: {}, param: null, callback: null }));
    if (e.callback) throw new Error(`Already registered: ${group} ${path}`);
    e.callback = callback;
  }

  /** Usage: `.on('POST', '/url/with/leading/slash/paramValue/thisWill/Be/Available/As/Empty/String', {})` */
  get(group: string, path: string, params: Object) {
    let root = this.methods[group];
    if (!root) {
      return null;
    }
    if (root.param === '') {
      params[''] = Router.#normalize(path);
      return root.callback;
    }
    for (let c = 1, i = 1; i <= path.length; ++i) {
      if (path[i] !== '/' && path[i]) continue;
      if (c === i) {
        ++c;
        continue;
      }
      const u = path.substring(c, i);
      root = u ? root.children[u] || root.children[''] : root;
      if (!root) return null;
      if (root.param != null) {
        if (root.param === '') {
          params[''] = Router.#normalize(path.substring(i + 1));
          return root.callback;
        }
        params[root.param] = decodeURIComponent(u);
      }
      c = i + 1;
    }
    return root.callback;
  }

  static #normalize(path: string) {
    return path.replace(/^\/+|(?<=\/)\/+|\/+$/g, '');
  }
}

/** Some messy definitions for TypeScript magic to let me have typed database tables. */
type DatabaseRowType = string | number | boolean;

class DatabaseDefaultValue<T extends DatabaseRowType> {
  sqlite: string;
  callback: () => T;

  constructor(sqlite: string, callback: () => T) {
    this.sqlite = sqlite;
    this.callback = callback;
  }

  valueOf() { return this.callback(); }
  toString() { return this.callback(); }
}

type DatabaseRowAttrs<T extends DatabaseRowType> = { primary: boolean, unique: boolean, index: boolean, nullable: boolean, default: T | DatabaseDefaultValue<T> };

class DatabaseRow<T extends DatabaseRowType> {
  type: string;
  primary: boolean;
  unique: boolean;
  index: boolean;
  nullable: boolean;
  default: T | DatabaseDefaultValue<T>;

  constructor(type: string, attrs: DatabaseRowAttrs<T> | null) {
    this.type = type;
    Object.assign(this, attrs);
  }
}

type DatabaseRowDataType<T> = T extends DatabaseRow<infer U> ? U : never;
type DatabaseTableItem<T> = { [K in keyof T]: DatabaseRowDataType<T[K]> };
type DatabaseTablePartialItem<T> = Partial<DatabaseTableItem<T>>;
type DatabaseItemFiltered<T, K extends keyof T> = { [P in K]: DatabaseRowDataType<T[P]>; };
type DatabaseTableFilter<T> = null | string | number | DatabaseTableItem<T>;
type DatabaseTableFieldRef<T> = T | { raw: string } | { field: T, operator: string };

/** 
 * Simple helper for quickly setting up a database for an app, with some extensions for local storage storing JSONable data and 
 * a thing for easily creating versioning tables. 
 */
export class ExtendedDatabase extends Database {
  storage: LazyMap<string, string | number | boolean | object>;
  #cache: any = { knownTables: new Set() };

  row = {
    integer: (attrs: { primary: boolean, unique: boolean, index: boolean, nullable: boolean, default: number } | null = null) =>
      new DatabaseRow<number>('INTEGER', attrs),
    text: (attrs: { primary: boolean, unique: boolean, index: boolean, nullable: boolean, default: string } | null = null) =>
      new DatabaseRow<string>('TEXT', attrs),
    boolean: (attrs: { primary: boolean, unique: boolean, index: boolean, nullable: boolean, default: boolean } | null = null) =>
      new DatabaseRow<boolean>('BOOLEAN', attrs),
  };

  value = {
    now: { valueOf: () => Math.floor(Date.now() / 1e3), sqlite: `(strftime('%s', 'now'))` },
  };

  constructor(filename: string | null, params: null | { debug: boolean }) {
    super(filename || ':memory:', { strict: true });
    this.exec(`PRAGMA journal_mode = WAL;
PRAGMA synchronous = normal;
PRAGMA temp_store = memory;
PRAGMA mmap_size = 3000000000;
PRAGMA page_size = 8192;
CREATE TABLE IF NOT EXISTS __sto (key TEXT PRIMARY KEY, value TEXT);`);

    this.storage = new LazyMap(k => JSON.parse(this.#queryRaw(`SELECT value FROM __sto WHERE key=?1`).get(k)?.value || 'null'),
      (k, v) => (v == null
        ? this.query(`DELETE FROM __sto WHERE key=?1`).run(k)
        : this.query(`INSERT INTO __sto (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2 WHERE value IS NOT ?2`).run(k, v && JSON.stringify(v))).changes !== 0);

    if (params && params.debug) {
      this.query = ((b: Function, q: string) => { console.log(`DB.query: ${filename}, ${q}`); return b.call(this, q); }).bind(null, this.query);
      this.prepare = ((b: Function, q: string) => { console.log(`DB.prepare: ${filename}, ${q}`); return b.call(this, q); }).bind(null, this.prepare);
      this.exec = ((b: Function, q: string) => { console.log(`DB.exec: ${filename}, ${q}`); return b.call(this, q); }).bind(null, this.exec);
    }

    this.#cache.queryTransation = this.prepare('BEGIN TRANSACTION');
    this.#cache.queryCommit = this.prepare('COMMIT');
  }

  #queryRaw(query: string): any { return this.query(query); }

  /**
   * A thing for basic typed key-value storage. Pass `{}` as `dataRow` to store any JSON-able data. If created with `caching`, values
   * will be cached in a Map.
   */
  map<TKey extends DatabaseRowType, TValue extends DatabaseRowType>(name: string, keyRow: DatabaseRow<TKey>, dataRow: DatabaseRow<TValue>, caching: boolean) {
    let s = (v: any) => v, d = (v: any) => v;
    if (!dataRow.type) {
      s = JSON.stringify;
      d = v => v && JSON.parse(v);
      // @ts-ignore
      dataRow = { type: 'TEXT' };
    }
    // @ts-ignore
    const t = this.table(name, { key: { primary: true, type: keyRow.type }, value: { type: dataRow.type } });
    if (caching) {
      return new LazyMap(k => d(this.#queryRaw(`SELECT value FROM ${t} WHERE key=?1`).get(k)?.value),
        (k, v) => (v != null
          ? this.#queryRaw(`INSERT INTO ${t} (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2 WHERE value IS NOT ?2`).run(k, s(v))
          : this.#queryRaw(`DELETE FROM ${t} WHERE key=?1`).run(k)).changes !== 0);
    }
    return {
      has: (k: TKey) => this.#queryRaw(`SELECT EXISTS(SELECT 1 FROM ${t} WHERE key=?1) as v`).get(k).v !== 0,
      get: (k: TKey): TValue => d(this.#queryRaw(`SELECT value FROM ${t} WHERE key=?1`).get(k)?.value),
      set: (k: TKey, v: TValue) => (v != null
        ? this.query(`INSERT INTO ${t} (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2 WHERE value IS NOT ?2`).run(k, s(v))
        : this.query(`DELETE FROM ${t} WHERE key=?1`).run(k)).changes !== 0,
      delete: (k: TKey) => this.query(`DELETE FROM ${t} WHERE key=?1`).run(k).changes !== 0,
      clear: () => this.query(`DELETE FROM ${t}`).run().changes !== 0,
    }
  }

  escape(v: any): string {
    return v == null ? 'NULL'
      : typeof v === 'object' ? v.sqlite !== undefined ? v.sqlite : JSON.stringify(v)
        : typeof (v) === 'string' ? v.indexOf('"') === -1 ? `"${v}"` : `'${v}'` : '' + v;
  }

  static #TransactionWriter = class {
    db: ExtendedDatabase;
    constructor(db: ExtendedDatabase) { this.db = db; }
    start() {
      if (!this.db.#cache.transaction) {
        this.db.#cache.transaction = this;
        this.db.#cache.queryTransation.run();
      }
      return this;
    }
    query(q: string) {
      this.start();
      return this.db.query(q);
    }
    [Symbol.dispose]() {
      if (this.db.#cache.transaction !== this) {
        return;
      }
      this.db.#cache.transaction = null;
      this.db.#cache.queryCommit.run();
    }
  }

  write() {
    return new ExtendedDatabase.#TransactionWriter(this);
  }

  writing<R, A extends unknown[]>(fn: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      using _ = this.write().start();
      return fn(...args);
    };
  }

  bound<R, A extends unknown[]>(query: string, fn: (stmt: Statement, ...args: A) => R): (...args: A) => R {
    return fn.bind(null, this.prepare(query));
  }

  static #Table = class <T extends Record<string, DatabaseRow<any>>> extends EventEmitter {
    db: ExtendedDatabase;
    name: string;
    primaryKey: string;
    orderBase: string[];
    #updated = false;

    constructor(db: ExtendedDatabase, name: string, rows: T, props: ({ order: string | null, indices: { columns: string[], unique: boolean | null }[], upgrade: ((old: T) => T)[] | null, version: number | null, temporary: boolean | null } | null) = null) {
      super();
      this.db = db;
      this.name = name;

      const targetVer = (props?.upgrade?.length || 0) + (props?.version || 0) * 8192;
      const curVer = props?.temporary ? Number.NaN : +db.#queryRaw(`SELECT value FROM __sto WHERE key=?1`).get(name)?.value;
      if (curVer !== targetVer) {
        if (props?.temporary) {
          db.exec(`DROP TABLE IF EXISTS ${name};`);
        }
        db.transaction(() => {
          let finalize: Function | null = null;
          if (!Number.isNaN(curVer)) {
            console.log(`Table ${name} is upgrading from v${curVer} to v${targetVer}`);
            if ((targetVer / 8192 | 0) === (curVer / 8192 | 0) && props?.upgrade != null) {
              if (curVer > targetVer) throw new Error('Version rollback is not supported');
              finalize = ((oldEntries: any[], route: Function[]) => {
                const insert = db.prepare(`INSERT INTO ${name} (${Object.keys(rows)}) VALUES (${Object.keys(rows).map(x => `$${x}`)})`);
                oldEntries.map(x => route.reduce((p, c) => p = c(p), x)).forEach(x => x && insert.run(x));
              }).bind(null, db.#queryRaw(`SELECT * FROM ${name}`).all(), props.upgrade.slice(curVer % 8192));
            }
            db.exec(`DROP TABLE ${name};`);
          }
          db.exec(`CREATE TABLE ${name} (${Object.entries(rows).map(
            ([k, v]) => [k, v.type, !v.nullable && `NOT NULL`, v.primary && 'PRIMARY KEY', v.default != null && `DEFAULT ${db.escape(v.default)}`, v.unique && `UNIQUE`].filter(Boolean).join(' ')).join(',')});${Object.entries(rows).map(
              ([k, v]) => v.index && `\nCREATE INDEX ${name}_${k} ON ${name}(${k});`).filter(Boolean).join('')}${props && props.indices && props.indices.map(x => `\nCREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${name}_${x.columns.join('_')} ON ${name}(${x.columns});`).join('') || ''}`);
          if (finalize) finalize();
          db.query(`INSERT INTO __sto (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2`).run(name, targetVer);
        })();
      }

      this.primaryKey = (Object.entries(rows).filter(v => v[1].primary)[0] || ['rowid'])[0];
      this.orderBase = props?.order?.split('?') || [''];
    }

    toString() { return this.name }

    get<K extends keyof T>(key: DatabaseTableFilter<T>, rows: null | K[] = null): DatabaseItemFiltered<T, K> | null {
      if (typeof key === 'object' && key && key[this.primaryKey]) return this.get(key[this.primaryKey]);
      return this.db.#queryRaw(`SELECT ${rows?.join(',') || '*'} FROM ${this.name}${this.#buildFilter(key)}`).get(key);
    }

    pget<K extends keyof T, R extends keyof T>(rows: null | R[], filter: DatabaseTableFieldRef<K>): (value: DatabaseRowDataType<T[K]>) => DatabaseItemFiltered<T, R> | null;
    pget<K extends keyof T, R extends keyof T>(rows: null | R[], filter: DatabaseTableFieldRef<K>[]): (filter: DatabaseItemFiltered<T, K>) => DatabaseItemFiltered<T, R> | null;
    pget<K extends keyof T, R extends keyof T>(rows: null | R[] = null, filter: DatabaseTableFieldRef<K> | DatabaseTableFieldRef<K>[]): (filter: any) => DatabaseItemFiltered<T, R> | null {
      return new Function('f', `return this.get(${this.#prepareAccess(filter)})`)
        .bind(this.db.prepare(`SELECT ${rows?.join(',') || '*'} FROM ${this.name}${this.#prepareFilter(filter)}`));
    }

    all<R extends keyof T>(rows: null | R[] = null, filter: DatabaseTableFilter<T>): DatabaseItemFiltered<T, R>[] {
      return this.db.#queryRaw(`SELECT ${rows?.join(',') || '*'} FROM ${this.name}${this.#buildFilter(filter)}`).all(filter);
    }

    pall<K extends keyof T, R extends keyof T>(rows: null | R[], filter: DatabaseTableFieldRef<K>): (value: DatabaseRowDataType<T[K]>) => DatabaseItemFiltered<T, R>[];
    pall<K extends keyof T, R extends keyof T>(rows: null | R[], filter: DatabaseTableFieldRef<K>[]): (filter: DatabaseItemFiltered<T, K>) => DatabaseItemFiltered<T, R>[];
    pall<K extends keyof T, R extends keyof T>(rows: null | R[] = null, filter: DatabaseTableFieldRef<K> | DatabaseTableFieldRef<K>[]): (filter: any) => DatabaseItemFiltered<T, R>[] {
      return new Function('f', `return this.all(${this.#prepareAccess(filter)})`)
        .bind(this.db.prepare(`SELECT ${rows?.join(',') || '*'} FROM ${this.name}${this.#prepareFilter(filter)}`));
    }

    exists(filter: DatabaseTableFilter<T>): boolean {
      return this.db.#queryRaw(`SELECT EXISTS(SELECT 1 FROM ${this.name}${this.#buildFilter(filter)}) as v`).get(filter).v !== 0;
    }

    pexists<K extends keyof T>(filter: DatabaseTableFieldRef<K>): (value: DatabaseRowDataType<T[K]>) => boolean;
    pexists<K extends keyof T>(filter: DatabaseTableFieldRef<K>[]): (filter: DatabaseItemFiltered<T, K>) => boolean;
    pexists<K extends keyof T>(filter: DatabaseTableFieldRef<K> | DatabaseTableFieldRef<K>[]): (filter: any) => boolean {
      return new Function('f', `return this.get(${this.#prepareAccess(filter)}).v !== 0`)
        .bind(this.db.prepare(`SELECT EXISTS(SELECT 1 FROM ${this.name}${this.#prepareFilter(filter)}) as v`));
    }

    count(filter: DatabaseTableFilter<T>): number {
      return this.db.#queryRaw(`SELECT COUNT(*) AS c FROM ${this.name}${this.#buildFilter(filter)}`).get(filter).c;
    }

    pcount<K extends keyof T>(filter: DatabaseTableFieldRef<K>): (value: DatabaseRowDataType<T[K]>) => number;
    pcount<K extends keyof T>(filter: DatabaseTableFieldRef<K>[]): (filter: DatabaseItemFiltered<T, K>) => number;
    pcount<K extends keyof T>(filter: DatabaseTableFieldRef<K> | DatabaseTableFieldRef<K>[]): (filter: any) => number {
      return new Function('f', `return this.get(${this.#prepareAccess(filter)}).c`)
        .bind(this.db.prepare(`SELECT COUNT(*) AS c FROM ${this.name}${this.#prepareFilter(filter)}`));
    }

    #ran<K extends { changes: number, lastInsertRowid: number | bigint }>(response: K): K {
      if (response.changes > 0 && !this.#updated) {
        this.#updated = true;
        process.nextTick(() => {
          this.emit('update');
          this.#updated = false;
        });
      }
      return response;
    }

    editQuery(query: string, ...args: any[]): { changes: number, lastInsertRowid: number | bigint } {
      return this.#ran(this.db.#queryRaw(query).run(...args));
    }

    editPrepare(query: string) {
      let s = this.db.prepare(query);
      return { run: (...args: any) => this.#ran(s.run(...args)) };
    }

    clear(): number {
      return this.editQuery(`DELETE FROM ${this.name}`).changes;
    }

    delete(filter: DatabaseTableFilter<T>): number {
      if (!filter) throw new Error(`Filter is required`);
      return this.editQuery(`DELETE FROM ${this.name}${this.#buildFilter(filter)}`, filter).changes;
    }

    pdelete<K extends keyof T>(filter: DatabaseTableFieldRef<K>): (value: DatabaseRowDataType<T[K]>) => number;
    pdelete<K extends keyof T>(filter: DatabaseTableFieldRef<K>[]): (filter: DatabaseItemFiltered<T, K>) => number;
    pdelete<K extends keyof T>(filter: DatabaseTableFieldRef<K> | DatabaseTableFieldRef<K>[]): (filter: any) => number {
      if (!filter) throw new Error(`Filter is required`);
      return new Function('f', `return this.run(${this.#prepareAccess(filter)}).changes`)
        .bind(this.editPrepare(`DELETE FROM ${this.name}${this.#prepareFilter(filter)}`));
    }

    update(filter: DatabaseTableFilter<T>, changes: Partial<{ [K in keyof T]: DatabaseRowDataType<T[K]> | { mask: number, value: number } }>): number {
      let p = typeof filter === 'object' ? Object.assign({}, filter) : Object.assign({ [this.primaryKey]: filter });
      let u = this.#buildFilter(p);
      return this.editQuery(`UPDATE ${this.name} SET ${Object.entries(changes).map(([k, v]) => {
        if (v && typeof v === 'object' && v.mask) {
          p[`__u_${k}`] = v.value === true ? v.mask : v.value || 0;
          return `${k}=((${k} & ~${v.mask}) | $__u_${k})`;
        }
        p[`__u_${k}`] = v;
        return `${k}=$__u_${k}`;
      })}${u}`, p).changes;
    }

    pupdate<K extends keyof T, C extends keyof T>(filter: K, changes: C): (filter: DatabaseRowDataType<T[K]>, changes: DatabaseRowDataType<T[C]>) => number;
    pupdate<K extends keyof T, C extends keyof T>(filter: K[], changes: C): (filter: DatabaseItemFiltered<T, K>, changes: DatabaseRowDataType<T[C]>) => number;
    pupdate<K extends keyof T, C extends keyof T>(filter: K, changes: C[]): (filter: DatabaseRowDataType<T[K]>, changes: DatabaseItemFiltered<T, C>) => number;
    pupdate<K extends keyof T, C extends keyof T>(filter: K[], changes: C[]): (filter: DatabaseItemFiltered<T, K>, changes: DatabaseItemFiltered<T, C>) => number;
    pupdate<K extends keyof T, C extends keyof T>(filter: K, changes: C, consts: DatabaseTablePartialItem<T>): (filter: DatabaseRowDataType<T[K]>, changes: DatabaseRowDataType<T[C]>) => number;
    pupdate<K extends keyof T, C extends keyof T>(filter: K[], changes: C, consts: DatabaseTablePartialItem<T>): (filter: DatabaseItemFiltered<T, K>, changes: DatabaseRowDataType<T[C]>) => number;
    pupdate<K extends keyof T, C extends keyof T>(filter: K, changes: C[], consts: DatabaseTablePartialItem<T>): (filter: DatabaseRowDataType<T[K]>, changes: DatabaseItemFiltered<T, C>) => number;
    pupdate<K extends keyof T, C extends keyof T>(filter: K[], changes: C[], consts: DatabaseTablePartialItem<T>): (filter: DatabaseItemFiltered<T, K>, changes: DatabaseItemFiltered<T, C>) => number;
    pupdate<K extends keyof T, C extends keyof T>(filter: K | K[], changes: C | C[], consts: DatabaseTablePartialItem<T> | undefined = undefined): (filter: any, changes: any) => number {
      const b = Array.isArray(changes) ? changes : changes ? [changes] : [];
      const p = this.editPrepare(`UPDATE ${this.name} SET ${[
        b.map((x, i) => `${x.toString()}=?${i + 1}`),
        consts ? Object.entries(consts).map(([k, v]) => `${k}=${v && v.sqlite || v}`) : []
      ].flat(1)}${this.#prepareFilter(filter, b.length)}`);
      return new Function('v', 'f', 'c', `return this.run(${[Array.isArray(changes) ? changes.map(x => `v(c[${JSON.stringify(x)}])`) : 'v(c)', this.#prepareAccess(filter)].flat(1)}).changes`).bind(p, this.#extractValue);
    }

    insert(entry: DatabaseTablePartialItem<T> | DatabaseTablePartialItem<T>[]): number {
      if (Array.isArray(entry)) {
        using _ = this.db.write().start();
        let ret = 0;
        for (const e of entry) ret = this.insert(e);
        return ret;
      }
      // @ts-ignore
      const is = [], ks = [], vs = [];
      for (const [k, v] of Object.entries(entry)) {
        is.push(k);
        ks.push(`?${vs.length + 1}`);
        vs.push(this.#extractValue(v));
      }
      return Number(this.editQuery(`INSERT INTO ${this.name} (${is}) VALUES (${ks})`, ...vs).lastInsertRowid);
    }

    pinsert<K extends keyof T>(rows: K[], consts: DatabaseTablePartialItem<T> | undefined = undefined): (value: DatabaseItemFiltered<T, K> | DatabaseItemFiltered<T, K>[]) => number {
      return new Function('d', 'v', 'f', `
        if (!Array.isArray(f)) return this.run(${rows.map(x => `v(f[${JSON.stringify(x)}])`)}).lastInsertRowid;
        if (!f.length) return null;
        const _ = d.write().start();
        try { let u = 0; for (const e of f) u = this.run(${rows.map(x => `v(e[${JSON.stringify(x)}])`)}).lastInsertRowid; return u; } finally { _[Symbol.dispose](); }`).bind(this.editPrepare(`INSERT INTO ${this.name} (${[rows, consts ? Object.keys(consts) : []].flat(1)}) VALUES (${[rows.map((_, i) => `?${i + 1}`), consts ? Object.values(consts).map(x => x && x.sqlite || x) : []].flat(1)})`), this.db, this.#extractValue);
    }

    #extractValue(v: DatabaseRowType | { callback: () => DatabaseRowType }) {
      return v && typeof v === 'object' && typeof v.callback === 'function' ? v.callback() : v;
    }

    gc<K extends keyof T>(column: K, maxAge: number | string) {
      const q = this.pdelete({ raw: `${column.toString()} < (${this.db.value.now.sqlite} - ${Timer.seconds(maxAge)})` });
      setInterval(q, Timer.parse(maxAge) * 0.2);
    }

    order(p = ''): string {
      return this.orderBase.join(p ? `${p}.` : '');
    }

    extend<T>(fn: (tbl: this) => T): this & T {
      return Object.assign(this, fn.call(this, this));
    }

    #buildFilter(filter: DatabaseTableFilter<T>) {
      if (filter != null && typeof filter !== 'object') return ` WHERE ${this.primaryKey}=?1`;
      let r = '';
      if (typeof filter === 'object') {
        for (const key in filter) {
          if (filter[key] == null) r += r ? ` AND ${key} IS NULL` : ` WHERE ${key} IS NULL`;
          else r += r ? ` AND ${key}=$${key}` : ` WHERE ${key}=$${key}`;
        }
      }
      return r;
    }

    #prepareAccess(filter: any | any[], offset = 0) {
      return Array.isArray(filter) ? filter.map(x => {
        if (typeof x === 'object') x = x.field;
        if (!x) return null;
        return /^\w+$/.test(x) ? `f.${x}` : `f[${JSON.stringify(x)}]`;
      }).filter(Boolean) : 'f';
    }

    #prepareFilter(filter: any | any[], offset = 0) {
      const a = Array.isArray(filter) ? filter : filter ? [filter] : [];
      let c = 1 + offset;
      return a.length > 0 ? ` WHERE ${a.map(x => typeof x === 'object' && x.raw ||
        `${typeof x === 'object' ? x.field : x.toString()} ${typeof x === 'object' && x.operator || '='} ?${c++}`).join(' AND ')}` : '';
    }
  };

  // TODO: REMOVE
  bits(...args: any[]) {
    let m = 0, r = { assign: '', value: 0, callback() { return this.value; } };
    for (var i = 0; i < args.length; i += 2) {
      m |= args[i];
      r.value += args[i + 1];
    }
    r.assign = `K=((K&~${m})|V)`;
    return r;
  }

  /**
   * A constuctor for tables giving a somewhat type-aware result. Main advantage however is simple versioning.
   * 
   * To upgrade a table, simply add a function to update[] taking a row in an old format and returning a row in a new format. Number of
   * upgrade functions defines table version. If table version is 2, but third function is added, only third one will be called.
   */
  table<T extends Record<string, DatabaseRow<any>>>(name: string, rows: T, props: (null | { order: string | null, indices: { columns: string[], unique: boolean | null }[], upgrade: ((old: T) => T)[] | null, version: number | null, temporary: boolean | null }) = null) {
    if (this.#cache.knownTables.has(name)) throw new Error(`Table ${name} is already created`);
    this.#cache.knownTables.add(name);
    return new ExtendedDatabase.#Table(this, name, rows, props);
  }

  gc() {
    this.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }
}

type CookieParams = { age: number | string, path: string, domain: string, httpOnly: boolean, secure: boolean };

/** 
 * A fun addition to save and load pretty much any value as a cookie, includes a basic integrity verification as well.
 * As long as you don’t want to read cookies on the client-side.
 */
export class CookieHandler {
  static defaults: CookieParams | null = null;
  static #encoder = new NumberEncoder('!#$%&\'()*+-./:<=>?@[]^_`{|}~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  req: Request;
  cookies: string[] = [];

  constructor(req: Request) {
    this.req = req;
  }

  static decode(cookie: string, start: number = 0, end: number = Infinity) {
    end = cookie ? (end < 0 || end > cookie.length ? cookie.length : end) : -Infinity;
    if (end - start <= 2) return null;
    const f = CookieHandler.#encoder.decode(cookie, start, start + 2);
    let r = cookie.substring(start + 2, end);
    if (Number(BigInt(Bun.hash(r)) & 0x1f98n) !== (f & 0x1f98)) return null;
    if (f & 6) r = (f & 2 ? Buffer.from(Bun.inflateSync(f & 4 ? Buffer.from(r, 'base64url') : r)) : Buffer.from(r, 'base64url')).toString('utf8');
    return (f & 1) ? JSON.parse(r) : r;
  }

  static encode(value: any) {
    let f = 0;
    if (typeof value !== 'string') { if (value == null) return ''; f |= 1; value = JSON.stringify(value); }
    if (value.length > 30) { const c = Bun.deflateSync(value); if (c.length < value.length) { f |= 2; value = c; } }
    if ((f & 2) || /[^\w!#$%&'()*+./:<=>?@[\]^_`{|}~-]/.test(value)) { f |= 4; value = Buffer.from(value).toString('base64url'); }
    return `${CookieHandler.#encoder.encode(Number(BigInt(Bun.hash(value)) & 0x1f98n) | f).padStart(2, CookieHandler.#encoder.key[0])}${value}`;
  }

  get(key: string): null | any {
    const cookie = this.req.headers.get('cookie');
    for (var i = 0, u: number; cookie && (u = cookie.indexOf(key, i)) !== -1; i = u + 1) {
      const u = cookie.indexOf(key, i);
      if (u === -1) return null;
      if (cookie[u + key.length] === '=' && (u === 0 || cookie[u - 1] === ' ' || cookie[u - 1] === ';')) {
        const s = u + key.length + 1;
        return CookieHandler.decode(cookie, s, cookie.indexOf(';', s));
      }
    }
    return null;
  }

  set(key: string, value: null | any, params: CookieParams | null = null) {
    if (CookieHandler.defaults) params = Object.assign({}, CookieHandler.defaults, params);
    this.cookies.push([
      `${key}=${CookieHandler.encode(value)}; Path=${params?.path || '/'}`,
      value == null ? `Max-Age=0` : params?.age && `Max-Age=${Timer.seconds(params.age).toFixed(0)}`,
      params?.domain && `Domain=${params?.domain}`,
      params?.httpOnly && `HttpOnly`,
      params?.secure && `Secure`,
    ].filter(Boolean).join(';'));
  }

  delete(key: string, params: CookieParams | null = null) {
    this.set(key, null, params);
    this.cookies.push(`${key}=; Max-Age=0; Path=/`);
  }

  static apply(handler: CookieHandler, response: Response) {
    if (!handler) return;
    for (const value of handler.cookies) response.headers.append('Set-Cookie', value);
  }
}

/** Something to use JSX on server-side without much overhead (about two times slower comparing to regular string interpolation). */
export class BunJSX {
  content: string;

  constructor(content: string) {
    this.content = content;
  }

  toString() {
    return this.content;
  }

  /** 
   * Put to jsconfig.json or tsconfig.json: {"compilerOptions":{"jsx":"react","jsxFactory":"JsxFactory"}}
   */
  static configure(params: null | { jsxFactoryName: string, reactName: string, groupTagName: string, allowEmptyTag: boolean, attributeHandlers: {} } = null) {
    params = Object.assign({ allowEmptyTag: true, groupTagName: 'G', jsxFactoryName: 'JsxFactory', reactName: 'React' }, params);
    const html = (v: string | number | boolean | object) => typeof v === 'number' ? '' + v : Bun.escapeHTML(v);
    const voidTags = { img: true, input: true, button: true, br: true, hr: true, meta: true };
    const emptyObj = {};
    type Solvable = string | BunJSX | Solvable[];

    function solve(that: BunJSX, arr: Solvable[]) {
      for (let i = 0; i < arr.length; ++i) {
        const item = arr[i];
        if (item == null || item === '') continue;
        if (Array.isArray(item)) solve(that, item);
        else that.content += item;
      }
    }

    function fromArray(a: Solvable[], unsafe = false) {
      if (unsafe) {
        let ret = new BunJSX('');
        solve(ret, a);
        return ret;
      } else {
        let ret = new BunJSX(a[0] instanceof BunJSX ? a[0].content : typeof a[0] === 'string' ? Bun.escapeHTML(a[0]) : '');
        for (let i = a[0] instanceof BunJSX || typeof a[0] === 'string' ? 1 : 0; i < a.length; ++i) {
          const e = a[i];
          if (e == null || e === '') continue;
          if (e instanceof BunJSX) ret.content += e.content;
          else if (Array.isArray(e)) solve(ret, e);
          else ret.content += html(e);
        }
        return ret;
      }
    }

    const attrFn = {
      class: (v: string[]) => Array.isArray(v) ? Bun.escapeHTML(v.filter(Boolean).join(' ')) : null,
      style: (v: Object) => Bun.escapeHTML(Object.entries(v).map(([k, v]) => `${k}:${v}`).join(';')),
      '': (v: unknown) => v instanceof BunJSX ? v.content : Array.isArray(v) ? fromArray(v).content : html(JSON.stringify(v))
    };

    let processAttributes;

    const procFn = Object.assign({
      $raw: (v, a) => a.splice(0, Infinity, fromArray(a, true)),
      $attr: (v, a, x) => processAttributes(x, v)
    }, params.attributeHandlers);

    processAttributes = (x: string, p: Object, a: Solvable[]) => {
      for (const k in p) {
        const v = p[k];
        if (k.charCodeAt(0) === 36) x = procFn[k](v, a, x) || x;
        else if (v) x += v === true ? ` ${k}` : ` ${k}="${typeof v === 'object' ? (attrFn[k] || attrFn[''])(v) : html(v)}"`;
        else if (v === '') x += ` ${k}`;
        else if (v === 0) x += ` ${k}=0`;
      }
      return x;
    }

    function flatten(r: BunJSX[], a: Solvable[], s: undefined | boolean = undefined) {
      for (let i = 0; i < a.length; ++i) {
        const e = a[i];
        if (e == null || e === '') continue;
        if (e instanceof BunJSX) r.push(e);
        else if (Array.isArray(e)) flatten(r, e);
        else r.push(new BunJSX(s ? html(e) : e));
      }
    }

    const fragment = () => { };
    if (params.allowEmptyTag) global[params.reactName] = { Fragment: fragment };
    if (params.groupTagName) global[params.groupTagName] = fragment;
    if (params.jsxFactoryName) global[params.jsxFactoryName] = global.JsxFactory = (t: string | Function, p: Object, ...a: Solvable[]) => {
      if (typeof t === 'string') {
        const x = p ? processAttributes(t, p, a) : t;
        switch (a.length) {
          case 0: return new BunJSX(voidTags[t] ? `<${x}>` : `<${x}></${t}>`);
          case 1:
            const a0 = a[0];
            if (typeof a0 !== 'object') return new BunJSX(a0 !== undefined ? `<${x}>${t === 'script' || t === 'style' ? a0 : html(a0)}</${t}>` : `<${x}></${t}>`);
            if (a0 instanceof BunJSX) return new BunJSX(`<${x}>${a0.content}</${t}>`);
          default:
            const r = new BunJSX(`<${x}>`);
            for (let i = 0; i < a.length; ++i) {
              const e = a[i];
              if (e == null || e === '') continue;
              if (e instanceof BunJSX) r.content += e.content;
              else if (Array.isArray(e)) solve(r, e);
              else r.content += html(e);
            }
            r.content += `</${t}>`;
            return r;
        }
      }
      if (typeof t === 'function') {
        for (const k in p) {
          if (k.charCodeAt(0) === 36) {
            if (!procFn[k]) throw new Error(`Unknown procFn: ${k}`);
            procFn[k](p[k], a);
            delete p[k];
          }
        }
        if (t === fragment) {
          return fromArray(a);
        }
        const r = [];
        flatten(r, a, true);
        return t(p || emptyObj, r);
      }
      throw new Error('Unknown tag');
    };
  }
}


const styles = {
  '!': '\x1b[31m\x1b[1m\x1b[4m',
  '+': '\x1b[32m\x1b[1m',
  '^': '\x1b[1m\x1b[4m',
  '*': '\x1b[36m\x1b[1m',
  '_': '\x1b[4m',
  '#': '\x1b[41m',
  '.': '\x1b[90m',
  reset: '\x1b[0m',
};

{
  const argv = process.argv || [], env = process.env;
  const isColorSupported = !('NO_COLOR' in env || argv.includes('--no-color')) && ('FORCE_COLOR' in env ||
    argv.includes('--color') || process.platform === 'win32' || (require != null && require('tty').isatty(1) && env.TERM !== 'dumb') || 'CI' in env);
  if (!isColorSupported) for (var n in styles) styles[n] = '';
}

/** 
 * A replacement for `console.log()` for colored output. Use as a formatter:
 * ```
 * echo `^My fancy message: ${someValue}`;
 * ```
 * 
 * Tags can be added at the start or in front of interpolated values:
 * ```
 * echo `When adding *${myID}, error occured: !${errorMessage}`;
 * ```
 * 
 * Known tags:
 * - `!`: warning, something bad;
 * - `#`: failure, something horrible;
 * - `+`: something good;
 * - `^`: something important;
 * - `*`: generic ID;
 * - `.`: something not that important;
 * - `_`: just an underscore.
 * 
 * Add `=` in front of interpolated value to output it using `console.log()` formatting instead.
 */
export function echo(msg: string, ...opts: any[]) {
  if (!Array.isArray(msg)) return console.log(msg);
  let y = styles[msg[0][0]];
  let s = y || '';
  let args = [];
  for (let i = 0; i < msg.length - 1; ++i) {
    let m = i === 0 && (y != null || msg[0][0] === ' ') ? msg[0].substring(1) : msg[i];
    if (m.endsWith('=')) {
      s += m.substring(0, m.length - 1);
      if (s.endsWith('\n') || opts[i] instanceof Error) {
        console.log(...args, s.replace(/[\n\s]+$/, '') + (y ? styles.reset : ''));
        args = [opts[i]];
      } else {
        args.push(s.replace(/ $/, '') + (y != null ? styles.reset : ''));
        args.push(opts[i]);
      }
      s = y || '';
    } else {
      let o = styles[m[m.length - 1]];
      s += o != null ? m.substring(0, m.length - 1) : m;
      if (o) s += o !== styles._ && o !== styles['*'] && y ? styles.reset + o : o;
      s += opts[i];
      if (o) s += styles.reset + (y || '');
    }
  }
  s += msg.length === 1 && y ? msg[msg.length - 1].substring(1) : msg[msg.length - 1];
  if (y) s += styles.reset;
  console.log(...args, s);
  return echo;
}

export function plural(msg: string[], ...opts: any[]) {
  let r = '';
  for (let i = 0; i < msg.length; ++i) {
    if (i > 0) r += opts[i - 1];
    r += msg[i].replace(/{(?:(\d+):)?([^}]+)}/g, (_, j, v) => plural.pluralize(opts[j || i - 1], v));
  }
  return r;
}

/** Usage: plural`${1} {cat}, ${5} {dog}, ${0} {entry}, ${6} {3:rush} ${4} {child(ren)} ${4} {human/people}` (if ID is not specified, previous number will be used) */
plural.pluralize = (n: number, s: string) => {
  const l = s[s.length - 1];
  if (l === ')') return /^(.+)\((.+)\)$/.test(s) ? n == 1 ? RegExp.$1 : RegExp.$1 + RegExp.$2 : s;
  let i = s.indexOf('/');
  if (i !== -1) return n == 1 ? s.substring(0, i) : s.substring(i + 1);
  if (n == 1) return s;
  if (l === 'y') return s.substring(0, s.length - 1) + 'ies';
  if (l === 's' || l === 'x' || l === 'h' && (s[s.length - 2] === 'c' || s[s.length - 2] === 's' )) return s + 'es';
  return s + 's';
}

export function U(msg: string[], ...opts: any[]) {
  let r = '';
  for (let i = 0; i < msg.length; ++i) {
    if (i > 0) r += encodeURIComponent(opts[i - 1]);
    r += msg[i];
  }
  return r;
}

// @ts-ignore
global.echo = echo;
// @ts-ignore
global.plural = plural;
// @ts-ignore
global.U = U;
