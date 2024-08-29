/** Standard library to be freely reused by other Bun.js servers. */
import { Database } from 'bun:sqlite';

// Some helpers to deal with file system
export const fsExt = {
  mkdirPSync(dir) {
    const fs = require('fs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  }
};

// Something to broadcast events, good for weaking code cohesion 
export class Mediator {
  constructor() {
    this.hooks = new Map();
  }

  /** @param {string} key @param {(...) => any} fn @param {number} [priority=0]  */
  register(key, fn, priority = 0) {
    if (typeof fn !== 'function') throw new Error('Function is required')
    let k = this.hooks.get(key);
    if (!k) {
      this.hooks.set(key, k = []);
    }
    fn._priority = priority;
    k.push(fn);
    k.sort((a, b) => a._priority - b._priority);
  }

  /** @template {T} @param {string} key @param {T} arg @returns {T} */
  trigger(key, arg, ...args) {
    const k = this.hooks.get(key);
    if (k) for (const e of k) e(arg, ...args);
    return arg;
  }

  /** @template {T} @param {string} key @param {T} arg @returns {T} */
  async async(key, arg, ...args) {
    const k = this.hooks.get(key);
    if (k) for (const e of k) await e(arg, ...args);
    return arg;
  }

  /** @param {string} key */
  poll(key, ...args) {
    const k = this.hooks.get(key);
    if (!k) return;
    for (const e of k) {
      const r = e(...args);
      if (r !== undefined) return r;
    }
  }
};

// Thing to help with lazy initialization
/** @template K, V */
export class LazyMap {
  /** @param {(key: K, ...) => V} fnGet @param {(key: K, value: V) => void} [fnSet] */
  constructor(fnGet, fnSet) {
    this.map = new Map();
    this.fn = fnGet;
    this.fnSet = fnSet;
  }

  /** @param {K} key @return {boolean} */
  has(key) {
    let r = this.map.get(key);
    if (r === undefined) this.map.set(key, r = this.fn(key) || null);
    return r != null;
  }

  /** @param {K} key @return {V} */
  get(key, ...args) {
    let r = this.map.get(key);
    if (r === undefined) this.map.set(key, r = this.fn(key, ...args) || null);
    return r;
  }

  /** @param {K} key @param {V} value @return {boolean} */
  set(key, value) {
    if (value == null) return this.delete(key);
    if (!this.fnSet || Bun.deepEquals(this.get(key), value)) return false;
    this.map.set(key, value);
    return this.fnSet(key, value);
  }

  /** @param {K} key @return {boolean} */
  delete(key) {
    if (!this.fnSet || this.get(key) == null) return false;
    this.map.set(key, null);
    return this.fnSet(key, null);
  }

  clear() {
    this.map.clear();
  }
}

export const Timer = {
  interval(interval, callback) {
    return { [Symbol.dispose]: clearInterval.bind(null, setInterval(callback, interval)) };
  }
};

// Thing keeping track of N last entries and returning them in last-to-first order, fast to write but slow to read
export class HistoryTracker {
  constructor(capacity) {
    this.count = 0;
    this.buffer = new Array(capacity);
  }

  add(item) {
    this.buffer[this.count++ % this.buffer.length] = item;
  }

  get entries() {
    let end = this.buffer.slice(0, this.count % this.buffer.length);
    if (this.count >= this.buffer.length) end = [...this.buffer.slice(this.count % this.buffer.length), ...end];
    return end.reverse();
  }
}

// Simple thing for measuring performance
export class PerfCounter {
  constructor() {
    this.started = -1;
    this.count = 0;
    this.totalTimeMs = 0;
    this.maxTimeMs = 0;
  }

  start() {
    this.started = Bun.nanoseconds();
  }

  consider(context) {
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

// Simple alternative to https://sqids.org/
export class Sqid {
  constructor(key) {
    this.key = key || '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  }
  encode(m, e) {
    for (var n = m, s = '', h = Number((Bun.hash(m) + BigInt(e || 0)) % BigInt(this.key.length)); n > 0; n = n / this.key.length | 0) s = this.key[((n % this.key.length) + h) % this.key.length] + s;
    s += this.key[h];
    for (var t = 0, i = 0; i < s.length; ++i) t = ((t * 397) ^ s.charCodeAt(i)) & 0x7fffffff;
    s += this.key[(t + h) % this.key.length];
    return e < 32 && /cunt|fu[ck]k|k[i1]ke|n[i1e]g|rap[ei]|twat/i.test(s) ? this.encode(m, e + 1) : s;
  }
  decode(s, offset = 0) {
    var n = 0, h = this.key.length - this.key.indexOf(s[s.length - 2]);
    for (var t = 0, i = offset; i < s.length - 1; ++i) t = ((t * 397) ^ s.charCodeAt(i)) & 0x7fffffff;
    for (var i = offset; i < s.length - 2; ++i) n = n * this.key.length + (this.key.indexOf(s[i]) + h) % this.key.length;
    return this.key[(t + this.key.length - h) % this.key.length] === s[s.length - 1] ? n : null;
  }
};

// Promises can be reused, so why not serve the same promise to different waiters as long as arguments are the same
export class PromiseReuser {
  constructor() {
    this.w = new Map();
  }

  run(fn, ...args) {
    const k = args.reduce((p, k) => p * 397n ^ Bun.hash(k), 0n);
    let r = this.w.get(k);
    if (!r) this.w.set(k, r = new Promise((r, e) => fn(...args).then(r, e)).finally(() => this.w.delete(k)));
    return r;
  }
}

// Simplest router.
export class Router {
  constructor() {
    this.methods = {};
  }

  /** Usage: `.on('POST', '/url/with/leading/slash/:paramID/:grabTheRestAsEmptyStringParam', callback)` */
  on(group, path, callback) {
    if (path[0] !== '/') throw new Error(`Incorrect path: ${group} ${path}`);
    const e = path.substring(1).split('/').reduce((p, s) => {
      if (!s || s === ':') return Object.assign(p, s && { param: '' });
      const k = s.startsWith(':') ? '' : s;
      return p.children[k] || (p.children[k] = ({ children: {}, param: s.startsWith(':') ? s.substring(1) : null, callback: null }));
    }, this.methods[group] || (this.methods[group] = { children: {}, param: null, callback: null }));
    if (e.callback) throw new Error(`Already registered: ${group} ${path}`);
    e.callback = callback;
  }

  /** Usage: `.on('POST', '/url/with/leading/slash/paramValue/thisWill/Be/Available/As/Empty/String', {})` */
  get(group, path, params) {
    let root = this.methods[group];
    if (!root) return null;
    for (let c = 1, i = 2; i <= path.length; ++i) {
      if (path[i] !== '/' && path[i]) continue;
      if (c === i) {
        ++c;
        continue;
      }
      const u = path.substring(c, i);
      root = root.children[u] || root.children[''];
      if (!root) return null;
      if (root.param != null) {
        if (root.param === '') {
          params[''] = path.substring(i + 1);
          return root.callback;
        }
        params[root.param] = decodeURIComponent(u);
      }
      c = i + 1;
    }
    return root.callback;
  }
}

// Simple helper for quickly setting up a database for an app, with some extensions for local storage storing JSONable data and 
// a thing for easily creating versioning tables.
export class ExtendedDatabase extends Database {
  constructor(filename) {
    super(filename, { strict: true });
    this.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS __sto (key TEXT PRIMARY KEY, value TEXT);`);

    this.row = {
      /** @type {(attrs: {primary: boolean, unique: boolean, index: boolean, nullable: boolean, default: integer}?) => integer} */
      integer: attrs => Object.assign({ type: 'INTEGER' }, attrs),
      /** @type {(attrs: {primary: boolean, unique: boolean, index: boolean, nullable: boolean, default: string}?) => string} */
      text: attrs => Object.assign({ type: 'TEXT' }, attrs),
      /** @type {(attrs: {primary: boolean, unique: boolean, index: boolean, nullable: boolean, default: boolean}?) => boolean} */
      boolean: attrs => Object.assign({ type: 'BOOLEAN' }, attrs),
    };

    this.value = {
      /** @type {integer} */
      now: { valueOf: () => Math.floor(Date.now() / 1e3), sqlite: `(strftime('%s', 'now'))` },
    };

    this.value.__known_tables = new Set();
    this.storage = new LazyMap(k => JSON.parse((this.query(`SELECT value FROM __sto WHERE key=?1`).get(k) || {}).value || 'null'),
      (k, v) => this.query(`INSERT INTO __sto (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2`).run(k, v && JSON.stringify(v)));

    this.exec = ((b, q) => { console.log(q); b.call(this, q); }).bind(null, this.exec);
  }

  /**
   * A thing for basic typed key-value storage. Pass `{}` as `dataRow` to store any JSON-able data. If created with `caching`, values
   * will be cached in a Map.
   * @template {any} TKey
   * @template {any} TValue
   * @param {string} name
   * @param {TKey} keyRow
   * @param {TValue} dataRow
   * @return {{has: (key: TKey) => boolean, get: (key: TKey) => TValue?, set: (key: TKey, value: TValue?) => boolean, delete: (key: TKey) => boolean, clear: () => boolean}}
   */
  map(name, keyRow, dataRow, caching) {
    let s = v => v, d = v => v;
    if (!dataRow.type) {
      s = JSON.stringify;
      d = v => v && JSON.parse(v);
      dataRow = { type: 'TEXT' };
    }
    const t = this.table(name, { key: { primary: true, type: keyRow.type }, value: { type: dataRow.type } });
    if (caching) {
      return new LazyMap(k => d(this.query(`SELECT value FROM ${t} WHERE key=?1`).get(k)?.value),
        (k, v) => (v != null
          ? this.query(`INSERT INTO ${t} (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2 WHERE value IS NOT ?2`).run(k, s(v))
          : this.query(`DELETE FROM ${t} WHERE key=?1`).run(k)).changes !== 0);
    }
    return {
      has: k => this.query(`SELECT EXISTS(SELECT 1 FROM ${t} WHERE key=?1) as v`).get(k).v !== 0,
      get: k => d(this.query(`SELECT value FROM ${t} WHERE key=?1`).get(k)?.value),
      set: (k, v) => (v != null
        ? this.query(`INSERT INTO ${t} (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2 WHERE value IS NOT ?2`).run(k, s(v))
        : this.query(`DELETE FROM ${t} WHERE key=?1`).run(k)).changes !== 0,
      delete: k => this.query(`DELETE FROM ${t} WHERE key=?1`).run(k).changes !== 0,
      clear: () => this.query(`DELETE FROM ${t}`).run(k).changes !== 0,
    }
  }

  /**
   * A constuctor for tables giving a somewhat type-aware result. Main advantage however is simple versioning.
   * @template {any} T
   * @param {string} name
   * @param {T} rows
   * @param {{order: string?, indices: {columns: string[], unique: boolean?}[], upgrade: ((old: T) => T)[]}?} props
   * @return {{name: string, get: (key: any) => T, all: (key: any) => T[], insert: (entry: T) => any, order: (prefix: string?) => string, count: () => integer}}
   */
  table(name, rows, props) {
    if (this.value.__known_tables.has(name)) throw new Error(`Name ${name} has already been used for a table`);
    this.value.__known_tables.add(name);

    // To upgrade a table, simply add a function to update[] taking a row in an old format and returning a row in a new format. Number of
    // upgrade functions defines table version. If table version is 2, but third function is added, only third one will be called.
    const targetVer = props?.upgrade?.length || 0, curVer = +this.query(`SELECT value FROM __sto WHERE key=?1`).get(name)?.value;
    if (curVer !== targetVer) {
      this.transaction(() => {
        let finalize = null;
        if (!Number.isNaN(curVer)) {
          if (curVer > targetVer) throw new Error('Version rollback is not supported');
          console.log(`Table ${name} is upgrading from v${curVer} to v${targetVer}`);
          const old = this.query(`SELECT * FROM ${name}`).all();
          this.exec(`DROP TABLE ${name};`);
          finalize = () => {
            const insert = `INSERT INTO ${name} (${Object.keys(rows)}) VALUES (${Object.keys(rows).map(x => `$${x}`)})`;
            const route = props.upgrade.slice(curVer);
            old.map(x => route.reduce((p, c) => p = c(p), x)).forEach(x => this.query(insert).run(x));
          };
        }
        this.exec(`CREATE TABLE ${name} (${Object.entries(rows).map(
          ([k, v]) => [k, v.type, !v.nullable && `NOT NULL`, v.primary && 'PRIMARY KEY', v.default != null && `DEFAULT ${v.type === 'TEXT' ? JSON.stringify(v.default) : typeof v.default === 'object' && v.default.sqlite || v.default}`, v.unique && `UNIQUE`].filter(Boolean).join(' ')).join(',')});${Object.entries(rows).map(
            ([k, v]) => v.index && `\nCREATE INDEX ${name}_${k} ON ${name}(${k});`).filter(Boolean).join('')}${props && props.indices && props.indices.map(x => `\nCREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${name}_${x.columns.join('_')} ON ${name}(${x.columns});`).join('') || ''}`);
        if (finalize) finalize();
        this.query(`INSERT INTO __sto (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2`).run(name, targetVer);
      })();
    }
    const primaryKey = (Object.entries(rows).filter(v => v[1].primary)[0] || ['rowid'])[0];
    return {
      name: name,
      get: ((q, key) => q.get(key)).bind(null, this.prepare(`SELECT * FROM ${name} WHERE ${primaryKey} = ?1`)),
      all: (q => q.all(key)).bind(null, this.prepare(`SELECT * FROM ${name}`)),
      insert: ((q, entry) => q.run(entry[primaryKey] === undefined ? Object.assign({ [primaryKey]: null }, entry) : entry).lastInsertRowid).bind(null, this.prepare(`INSERT INTO ${name} (${Object.keys(rows)}) VALUES (${Object.keys(rows).map(x => `$${x}`)})`)),
      order: ((q, p = '') => q.join(p ? `${p}.` : '')).bind(null, props?.order?.split('?') || ['']),
      count: () => this.query(`SELECT COUNT(*) AS count FROM ${name}`).get().count,
      toString: () => name,
    }
  }
}

// Something to use JSX on server-side without much overhead (about two times slower comparing to regular string interpolation)
export class BunJSX {
  constructor(content) {
    this.content = content;
  }

  toString() {
    return this.content;
  }

  /** 
   * Put to jsconfig.json: {"compilerOptions":{"jsx":"react","jsxFactory":"JsxFactory"}}
   * @param {{jsxFactoryName: string, groupTagName: string, allowEmptyTag: boolean, attributeHandlers: {}}?} params 
   */
  static configure(params) {
    params = Object.assign({ allowEmptyTag: true, groupTagName: 'G', jsxFactoryName: 'JsxFactory' }, params);
    const html = (v) => typeof v === 'number' ? v : Bun.escapeHTML(v);
    const voidTags = { img: true, input: true, button: true, br: true, hr: true };
    const emptyObj = {};

    function solve(that, arr) {
      for (let i = 0; i < arr.length; ++i) {
        const item = arr[i];
        if (item == null || item === '') continue;
        if (Array.isArray(item)) solve(that, item);
        else that.content += item;
      }
    }

    function fromArray(a, unsafe = false) {
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
      class: v => Bun.escapeHTML(Array.isArray(v) ? v.filter(Boolean).join(' ') : null),
      style: v => Bun.escapeHTML(Object.entries(v).map(([k, v]) => `${k}:${v}`).join(';')),
      '': v => v instanceof BunJSX ? v.content : Array.isArray(v) ? fromArray(v).content : html(JSON.stringify(v))
    };

    const procFn = Object.assign({
      $raw: (v, a) => a.splice(0, Infinity, fromArray(a, true)),
      $attr: (v, a, x) => processAttributes(x, v)
    }, params.attributeHandlers);

    function processAttributes(x, p, a) {
      for (const k in p) {
        const v = p[k];
        if (k.charCodeAt(0) === 36) x = procFn[k](v, a, x) || x;
        else if (v) x += v === true ? ` ${k}` : ` ${k}="${typeof v === 'object' ? (attrFn[k] || attrFn[''])(v) : html(v)}"`;
        else if (v === '') x += ` ${k}`;
        else if (v === 0) x += ` ${k}=0`;
      }
      return x;
    }

    function flatten(r, a, s) {
      for (let i = 0; i < a.length; ++i) {
        const e = a[i];
        if (e == null || e === '') continue;
        if (e instanceof BunJSX) r.push(e);
        else if (Array.isArray(e)) flatten(r, e);
        else r.push(new BunJSX(s ? html(e) : e));
      }
    }

    if (params.allowEmptyTag) global.React = { Fragment: () => { } };
    if (params.groupTagName) global[params.groupTagName] = React.Fragment;
    if (params.jsxFactoryName) global[params.jsxFactoryName] = global.JsxFactory = (t, p, ...a) => {
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
        if (t === G) {
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
