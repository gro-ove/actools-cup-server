/** Main app state. Now packed into a single file to make it easier to add new plugins. */

import { BunJSX, CookieHandler, ExtendedDatabase, fsExt, jsExt, LazyMap, Mediator, NumberEncoder, PerfCounter, PromiseReuser, Router, Timer } from './std';
import { AsyncLocalStorage } from 'node:async_hooks';

// Some consts
export const AppSettings = {
  core: {
    dbFileName: null, // Leave empty for using in-memory DB for testing
    dbVersion: 1,
    httpPort: 8080,
    passwordSalt: 'salt',
    monitorResources: false,
    dataDir: './data',
    resDir: './res',
    cdnCacheDir: './res/cdn',
  },

  // Login and password for the main admin account (will be created if missing)
  // admin: {
  //   userID: 'admin',
  //   password: '1'
  // },

  // Delays in seconds
  periods: {
    undoLifespan: '4h', // Time for which undo data is kept
    seenFor: '30min', // Once seen, keep track of a user for this time
    reportCooldown: '30s', // Download and complain counters won’t increment from the same user until cooldown is reached
  },

  ownContacts: {
    mail: 'missing@example.com'
  },

  plugins: {
    active: [],
    verbose: true
  },
};

fsExt.mkdirPSync(AppSettings.core.dataDir);
fsExt.mkdirPSync(AppSettings.core.cdnCacheDir);

let connectedCache, versionedPostfix;

// Some basic helper functions.
export const Utils = {
  uid(length = 8) { return require('crypto').randomBytes(length * 4).toString('base64').replace(/^\d|\W/g, '').slice(0, length) || this.uid(); },
  inj(v) { return v; },
  idfy(value, lowerCase) { return (lowerCase ? value.toLowerCase() : value).trim().replace(/\s+/g, '-').replace(/[^\w_. #~-]+/g, '').substring(0, 80); },
  titlefy(value) { return value && value.replace(/^./, _ => _.toUpperCase()); },
  plural(x, c) { return c === 1 ? x : x.endsWith('y') ? x.substring(0, x.length - 1) + 'ies' : x + 's' },
  deepAssign(t, s) { return s ? Object.entries(s).reduce((p, [k, v]) => ((p[k] = typeof v === 'object' && typeof p[k] === 'object' && p[k] ? this.deepAssign(p[k], v) : v), p), t) : t; },

  hash64(data, short) {
    const b = Buffer.allocUnsafe(8)
    b.writeBigUInt64BE(typeof data === 'bigint' ? data : Bun.hash(data));
    return (short ? b.slice(0, 4) : b).toString('base64url');
  },

  seconds(seconds, short) {
    return Utils.age(seconds / (24 * 60 * 60), short);
  },

  versioned(url) {
    if (!versionedPostfix) versionedPostfix = `?v=${Utils.uid(3)}`;
    return `${url}${versionedPostfix}`;
  },

  age(days, short) {
    if (short) {
      if (days >= 356) return `${(days / 356).toFixed(1)} y`;
      if (days >= 2) return `${(days).toFixed(0)} d`;
      if (days >= 2 / 24) return `${(days * 24).toFixed(0)} h`;
      if (days >= 2 / (24 * 60)) return `${(days * (24 * 60)).toFixed(0)} min`;
      return `${(days * (24 * 60 * 60)).toFixed(0)} s`;
    }
    const p = (u, v) => v == 1 ? `1 ${u}` : `${v} ${u}s`;
    const d = v => v ? p('day', v) : '';
    if (days >= 356) return `${p('year', days / 365 | 0)} ${Utils.age(days % 356 | 0)}`.trim();
    if (days >= 30) return `${p('month', days / 30 | 0)} ${d(days % 30 | 0)}`.trim();
    if (days >= 7) return `${p('week', days / 7 | 0)} ${d(days % 7 | 0)}`.trim();
    if (days > 2) return p('day', days | 0);
    if (days > 2 / 24) return p('hour', days * 24 | 0);
    if (days > 2 / (24 * 60)) return p('minute', days * (24 * 60) | 0);
    return p('second', days * (24 * 60 * 60) | 0);
  },

  social(id, url, subject) {
    if (!url) {
      return id === 'mail' ? 'E-mail' : Utils.titlefy(id);
    }
    if (typeof id === 'object') {
      return Object.entries(id).reduce((p, [k, v]) => ((p[Utils.social(k, v, subject)] = url.replace('?1', Utils.social(k))), p), {});
    }
    switch (id) {
      case 'mail': return subject ? `mailto:${url}?subject=${encodeURIComponent(subject)}` : `mailto:${url}`;
      case 'steam': return `https://steamcommunity.com/id/${url}`;
      case 'discord': return `https://discordapp.com/users/${url}`;
      case 'telegram': return `https://t.me/${url}`;
    }
    return id && url;
  },

  /** @param {Map} map @param {(key: any, value: any) => boolean} callback */
  filterMap(map, callback) {
    const r = [];
    for (const [k, v] of map.entries()) {
      if (!callback(k, v)) r.push(k);
    }
    for (const k of r) map.delete(k);
  },

  ensureUnique(value, test) {
    let ret = value;
    for (let i = 1; test(ret); ++i) {
      ret = `${value}-${i}`;
    }
    return ret;
  },

  hostFromURL(url) {
    return url?.replace(/^https?:\/\/|\/.+/g, '');
  },

  filterRegExp(string) {
    return string.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  },

  async tryAsync(fn, tries, delayMs) {
    for (let i = 1; i < tries; ++i) {
      if (i > 1) await Bun.sleep(delayMs);
      try {
        return await fn(i === 1 ? '' : ` (attempt ${i}/${tries})`);
      } catch (e) {
        if (e && e.repeat) tries += (typeof e.repeat === 'number' ? e.repeat : 0);
        else throw e;
        console.warn(e);
      }
    }
    return await fn(` (attempt ${tries}/${tries})`);
  },

  /** @return {Promise<boolean>} */
  offline() {
    if (connectedCache == null) {
      connectedCache = new Promise((resolve) => {
        const client = require('http2').connect('https://www.google.com', { timeout: 1e3 });
        client.on('connect', () => {
          resolve(false);
          client.destroy();
          setTimeout(() => connectedCache = null, 5e3);
        }).on('error', () => {
          resolve(true);
          client.destroy();
          setTimeout(() => connectedCache = null, 10e3);
        });
      });
    }
    return connectedCache;
  },

  /** @param {(string|{key: string, data: Buffer})[]} files */
  tar(files) {
    const fs = require('fs');
    const path = require('path');

    function createTarHeader(fileName, fileSize) {
      const pad = (s, l) => s.length >= l ? s.substring(0, l) : s + ' '.repeat(l - s.length);
      const header = Buffer.alloc(512, 0);
      header.write(fileName, 0, 100);
      header.write(pad('777', 8), 100, 8);
      header.write(pad('1', 8), 108, 8);
      header.write(pad('1', 8), 116, 8);
      header.write(pad(fileSize.toString(8), 12), 124, 12);
      header.write(pad((Date.now() / 1000 | 0).toString(8), 12), 136, 12);
      header.write(pad('', 8), 148, 8);
      header[156] = 0;
      header.write([].reduce.call(header, (p, n) => p + n, 0).toString(8), 148, 6, 'ascii');
      return header;
    }

    return Buffer.concat([...files.map(x => typeof x === 'string' ? { key: path.basename(x), data: fs.readFileSync(x) } : x)
      .map(x => [createTarHeader(x.key, x.data.length), x.data, Buffer.alloc((512 - (x.data.length % 512)) % 512, 0)]).flat(), Buffer.alloc(1024, 0)]);
  },
};

// Custom user settings
if (process.env.ACTOOLS_CUP_SERVER_CFG) {
  Utils.deepAssign(AppSettings, (await import(require('path').resolve(process.env.ACTOOLS_CUP_SERVER_CFG.trim()))).default);
}

// Some common lines (TODO: expand further)
export const Locale = {
  hints: {
    profileName: 'Some name that might one day be shown next to listed mods or something',
    profileBio: 'Some profile description to go along with listed mods',
    profileUrl: 'Some URL with extra details about your particular profile',

    countDownloads: 'Approximate number of times download URL was used',
    countComplains: 'Number of times users reported a malfunctioning download URL',

    blocked: 'Might happen if entry receives too many complains',
    hidden: 'Entry is hidden due to some configuration errors',
    processing: 'Entry is being processed and will become available once ready',
    active: 'Uncheck to hide entry from updates and search',
    dataName: 'Optional name',
    dataAuthor: 'Optional author field',
    dataVersion: 'If empty or 0, the entry won’t participate in auto-update system',
    changelog: 'List latest changes here',
    informationUrl: 'Used if user wants to see more details about the content',
    updateUrl: 'Used for downloading the update, can point to services CM can download content from',
    alternativeIds: 'If your content contains multiple folders, list IDs here and the same settings will apply to other IDs',

    flagLimited: 'Check if you want update URL to open in system browser instead of starting the update (useful for paid mods)',
    cleanInstallation: 'If selected, clean update option will be selected by default',
    flagSearcheable: 'Allow users to find your content, add mods to CM Workshop and similar platforms',
    flagOriginal: 'Please check only if model hasn’t been taken from a different videogame or something like that (applies to cars, tracks or showrooms)',
  }
}

// Typical user access permissions (plugin can add more permissions later)
export const Access = {
  EDIT: 1,
  VIEW: 2,
  FLAG_ORIGINAL: 128,
  FLAG_SEARCHEABLE: 256,
  MODERATE: 0x40000000,

  REGULAR: 1 | 2 | 128 | 256,
  DEFAULT: 1 | 2 | 128 | 256,
  ADMIN: -1,
};

// Extra details about permissions
export const AccessPermissions = [
  { id: 'edit', flag: Access.EDIT, title: 'Edit and register new content' },
  { id: 'browse', flag: Access.VIEW },
  { id: 'original flag', flag: Access.FLAG_ORIGINAL, title: 'Mark content AS original (please do not ports with this flag)' },
  { id: 'searchable flag', flag: Access.FLAG_SEARCHEABLE, title: 'Mark content AS appearing in search and other lists' },
  { id: 'moderate', flag: Access.MODERATE, title: 'Create invites, edit others entries and more', hidden: true },
  { id: 'admin', flag: Access.ADMIN, title: 'Full access including CUP settings', hidden: true },
];

// Extra details about permissions
export const AccessPermissionShortenings = {
  [Access.REGULAR]: [{ id: 'regular', title: 'Regular access' }],
  [Access.REGULAR | Access.MODERATE]: [{ id: 'moderator', title: 'CUP management' }],
  [Access.ADMIN]: [{ id: 'admin', title: 'Full unrestricted access' }],
};

// Add a new permission (use carefully)
/** @param {string} key @param {number} flag @param {{ id: string, title: string, hidden: boolean }} params */
export function registerPermission(key, flag, params) {
  if (Math.floor(Math.log2(flag)) !== Math.log2(flag)) throw new Error(`Not a proper flag: ${flag}`);
  if (Object.values(Access).includes(flag) || Access[key]) throw new Error(`Permission conflict: ${key}`);
  Access[key] = flag;
  AccessPermissions.push(Object.assign({}, params, { flag }));
  AccessPermissions.sort((a, b) => (a.flag >>> 0) > (b.flag >>> 0));
  for (const k of Object.keys(AccessPermissionShortenings)) {
    if (k == Access.ADMIN) continue;
    AccessPermissionShortenings[k | flag] = [...AccessPermissionShortenings[k], params];
  }
  if (params.default) {
    Access.DEFAULT |= flag;
  }
  return flag;
}

// Disabled flags (packed into a single column, search should be faster)
export const DisabledFlag = {
  USER: 1,
  BLOCKED: 2,
  HIDDEN: 4,
  PROCESSING: 8,
};

// Supported types of content
export const ContentCategories = [
  { id: 'car', cupID: 'car', maskID: 'c', name: 'car', title: 'Car', portable: true, folder: true },
  { id: 'track', cupID: 'track', maskID: 't', name: 'track', title: 'Track', portable: true, folder: true },
  { id: 'showroom', cupID: 'showroom', maskID: 's', name: 'showroom', title: 'Showroom', portable: true, folder: true },
  { id: 'filter', cupID: 'filter', maskID: 'f', name: 'PP filter', title: 'PP filter', portable: false, folder: false },
  { id: 'python', cupID: 'app', maskID: 'p', name: 'Python app', title: 'Python app', portable: false, folder: true, limited: true },
  { id: 'lua', cupID: 'luaapp', maskID: 'l', name: 'Lua app', title: 'Lua app', portable: false, folder: true, limited: true },
];

// Hooks holder for server logic to allow plugins to alter the behavior
export const Hooks = new Mediator();

// Extra functions to deal with content
export const ContentUtils = {
  parseAllowedFilter(filter) {
    if (!filter) {
      filter = '.'
    } else if (filter[0] !== '`') {
      filter = filter.split(',').map(x => {
        x = x.trim();
        return /^(\w+)\s*:\s*(.+)/.test(x) ? `^${RegExp.$1[0].toLowerCase()}:${Utils.filterRegExp(RegExp.$2)}$` : `^.:${Utils.filterRegExp(x)}$`
      }).filter(Boolean).join('|');
    } else {
      filter = filter.substring(1);
    }
    return new RegExp(filter);
  },

  // Used on data export:
  normalizeURL(url) {
    if (!url) return null;
    url = url.trim();
    const v = ContentUtils.verifyURL(url);
    if (!v) return null;
    return v === 2 ? `http://${url}` : url;
  },

  normalizeAuthorName(names) {
    return names && names.trim().split(',').map(x => x.trim()).filter(Boolean).join(', ');
  },

  // Used post-editing:
  cleanChangelog(value) {
    return value && value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  },

  // Helper functions:
  verifyURL(url) {
    if (/^https?:\/\/.+$/.test(url)) return 1;
    if (/^[a-zA-Z][\w_-]*(?:\.[\w_-]+)+(?:\/.+)?$/.test(url)) return 2;
    return 0;
  },

  verifyValidity(content, contentData) {
    const errs = [];
    if (!contentData.updateUrl) {
      errs.push('Update URL is required');
    } else {
      const err = Hooks.poll('data.downloadURL.verify', contentData.updateUrl, content, contentData);
      if (err) {
        errs.push(err);
      } else if (err === undefined) {
        if (!this.verifyURL(contentData.updateUrl)) {
          errs.push('Update URL is invalid');
        } else if (!content.flagLimited) {
          const host = Utils.hostFromURL(contentData.updateUrl);
          if (/\bpatreon\.com$/.test(host) && !/\.com\/file/.test(contentData.updateUrl)) {
            errs.push('Content Manager can’t download from Patreon directly (set limited flag if the file is available only to subscribers)');
          } else if (/\bboosty\.to$/.test(host)) {
            errs.push('Content Manager can’t download from Boosty directly (set limited flag if the file is available only to subscribers)');
          } else if (/\bdiscordapp\.com$/.test(host)) {
            errs.push('Discord attachment URLs are not reliable and stop working after some time');
          }
        }
      }
    }
    if (contentData.informationUrl && !this.verifyURL(contentData.informationUrl)) {
      errs.push('Information URL is invalid: ' + contentData.informationUrl);
    }
    if (content.dataAuthor && !/^.+$/.test(content.dataAuthor)) {
      errs.push('Author name is invalid');
    }
    if (content.dataVersion && !/^.+$/.test(content.dataVersion)) {
      errs.push('Version is invalid');
    }
    return errs;
  },
}

// Helper to deal with downloadable things and manage plugin-altered download URLs
export class DownloadableSource {
  /** 
   * @param {string} prefix 
   * @param {any} table 
   * @param {(entry: any, processing: boolean, errorMessage: string) => void} updateCallback
   * @param {(entryKey: any) => BunJSX} urlCallback */
  constructor(prefix, table, updateCallback, urlCallback) {
    if (!table.primaryKey) throw new Error(`Primary key column is missing`);
    this.prefix = prefix;
    this.table = table;
    this.updateCallback = updateCallback;
    this.urlCallback = urlCallback;

    Hooks.register('data.downloadURL.referencedURL', ({ key }) => {
      if (!key.startsWith(this.prefix)) return;
      return this.urlCallback(key.substring(this.prefix.length));
    });

    Hooks.register('data.downloadURL.state', ({ key, processing, errorMsg }) => {
      if (!key.startsWith(this.prefix)) return;
      const entry = this.table.get(key.substring(this.prefix.length));
      if (entry) this.updateCallback(entry, processing, errorMsg);
    });
  }

  reportInline(entry, oldValue, newValue) {
    if (!entry[this.table.primaryKey]) throw new Error(`Primary column is missing`);
    return oldValue == null && newValue == null ? { processing: false, errorMsg: null } : Hooks.trigger('data.downloadURL.change', {
      key: `${this.prefix}${entry[this.table.primaryKey]}`,
      userKey: entry.userKey,
      oldValue: oldValue || null,
      newValue: newValue || null,
      processing: false,
      errorMsg: null
    });
  }

  report(entry, oldValue, newValue) {
    const args = this.reportInline(entry, oldValue, newValue);
    if (newValue !== false) this.updateCallback(entry, args.processing, args.errorMsg);
  }
}

// Simple error with code and possible solutions
export class RequestError extends Error {
  constructor(code, message, options) {
    super(message || '');
    this.code = code;
    this.body = message;
    this.options = options;
  }
}

// Setting up JSX templates
BunJSX.configure({
  jsxFactoryName: 'JsxFactory',
  groupTagName: 'G',
  allowEmptyTag: true,
  attributeHandlers: {
    $id: v => { 
      curCtx.get().__pushedID = v; 
    },
    $hook: (v, b) => {
      // BunJSX templates can easily trigger hook events
      const $ = curCtx.get();
      if (typeof v === 'string') {
        Hooks.trigger(v, b, $, {});
      } else {
        for (const k in v) {
          Hooks.trigger(k, b, $, v[k]);
        }
      }
    }
  }
});

// Core stuff to deal with databases
export const db = new ExtendedDatabase(AppSettings.core.dbFileName && `${AppSettings.core.dataDir}/${AppSettings.core.dbFileName}`);
db.rawStorage = db.map('t_storage', db.row.text(), db.row.text());
Utils.deepAssign(AppSettings, db.storage.get('adminSettings'));

/** @template {any} T @param {string} key @param {T} defaults @param {null|(data: T) => T} editable @return {T} */
export function pluginSettings(key, defaults, editable) {
  if (editable) {
    Hooks.register('core.adminSettings', cfg => Utils.deepAssign(cfg, { plugins: { [key]: editable(AppSettings.plugins[key]) } }));
  }
  return AppSettings.plugins[key] = Utils.deepAssign(defaults, AppSettings.plugins[key]);
}

pluginSettings.require = value => {
  if (!value) {
    throw Object.assign(new Error(`Plugin is not configured`), { pluginSkip: true });
  }
};

// Main tables
export const DBTbl = {
  Users: db.table('t_users', {
    userKey: db.row.integer({ primary: true }),
    userID: db.row.text({ unique: true }),
    createdDate: db.row.integer({ default: db.value.now, index: true }),
    lastSeenDate: db.row.integer({ default: db.value.now, index: true }),
    password: db.row.text(),
    accessMask: db.row.integer(),
    allowedFilter: db.row.text({ nullable: true }),
    introduced: db.row.integer({ default: 0 }),
    userData: db.row.text({ default: '{}' }),
  }, {
    order: `ORDER BY ?userID`,
    indices: [],
    upgrade: []
  }).extend(tbl => {
    const pGetUserID = tbl.pget(['userID'], 'userKey');
    const pGetUserKey = tbl.pget(['userKey'], 'userID');
    return {
      /** @type {(userKey: integer) => string?} */
      userID: LazyMap.prototype.get.bind(new LazyMap(userKey => pGetUserID(userKey)?.userID)),
      /** @type {(userID: string) => integer?} */
      userKey: LazyMap.prototype.get.bind(new LazyMap(userID => pGetUserKey(userID)?.userKey)),
      /** @type {(login: string, pass: string) => string} */
      passEncode(login, pass) { return new Bun.CryptoHasher('sha256').update(AppSettings.core.passwordSalt).update(login).update(pass || '').digest('base64') },
      updateLastSeen: tbl.pupdate('userKey', [], { lastSeenDate: db.value.now })
    };
  }),
  Content: db.table('t_content', {
    contentKey: db.row.integer({ primary: true }),
    categoryIndex: db.row.integer(),
    contentID: db.row.text(),
    groupKey: db.row.integer(),
    userKey: db.row.integer({ index: true }),
    createdDate: db.row.integer({ default: db.value.now, index: true }),
    updatedDate: db.row.integer({ default: db.value.now }),
    flagsDisabled: db.row.integer({ default: 0 }),
    dataName: db.row.text({ nullable: true }),
    dataAuthor: db.row.text({ nullable: true }),
    dataVersion: db.row.text({ nullable: true }),
    flagSearcheable: db.row.boolean({ default: false }),
    flagOriginal: db.row.boolean({ default: false }),
    flagLimited: db.row.boolean({ default: false }),
    contentData: db.row.text({ default: '{}' }),
    countDownloads: db.row.integer({ default: 0 }),
    countComplains: db.row.integer({ default: 0 }),
  }, {
    order: `ORDER BY CASE WHEN ?dataName IS NOT NULL THEN ?dataName ELSE ?contentID END COLLATE NOCASE`,
    indices: [
      { columns: ['flagsDisabled', 'dataVersion'] }, // CUP API
      { columns: ['categoryIndex', 'contentID'], unique: true }, // ensuring uniqueness
      { columns: ['userKey', 'groupKey'] }, // listing content
    ],
    upgrade: []
  }).extend(tbl => {
    return {
      encodeContentData(data) {
        return JSON.stringify(data, (k, v) => v === null || k === 'hiddenReasons' && v.length === 0 ? undefined : v);
      },
      /** @type {(categoryIndex: integer, contentID: string, refDetails: object?) => void} */
      verifyID(categoryIndex, contentID, refDetails) {
        let main = db.query(`SELECT userKey, countDownloads FROM t_content WHERE categoryIndex=?1 AND contentID=?2`).get(categoryIndex, contentID);
        if (!main) {
          const alt = db.query(`SELECT contentKey FROM t_alternativeIDs WHERE categoryIndex=?1 AND contentID=?2`).get(categoryIndex, contentID);
          if (!alt) return;
          main = db.query(`SELECT contentID, userKey, countDownloads FROM t_content WHERE contentKey=?1`).get(alt.contentKey);
        }
        if (refDetails) {
          Object.assign(refDetails, main, { userID: this.userID(main.userKey) || `<unknown user #${main.userKey}>` });
        }
        throw new Error(`ID ${categoryIndex}/${contentID} is used`);
      },
    }
  }),
  AlternativeIDs: db.table('t_alternativeIDs', {
    contentKey: db.row.integer({ index: true }),
    categoryIndex: db.row.integer(),
    contentID: db.row.text()
  }, {
    indices: [
      { columns: ['categoryIndex', 'contentID'], unique: true }, // ensuring uniqueness
    ],
  }).extend(tbl => {
    return {
      byContentKey: tbl.pall(['contentID'], 'contentKey')
    }
  }),
  Groups: db.table('t_groups', {
    groupKey: db.row.integer({ primary: true }),
    userKey: db.row.integer({ index: true }),
    groupID: db.row.text(),
    name: db.row.text(),
    createdDate: db.row.integer({ default: db.value.now, index: true }),
  }, {
    order: `ORDER BY ?createdDate, ?groupKey`,
    indices: [
      { columns: ['groupID', 'userKey'], unique: true }, // ensuring uniqueness
    ],
    upgrade: []
  }),
};

// An internal thingy to keep track of current request context within JSX and JSX components

const curCtx = {
  ctxStorage: new AsyncLocalStorage(),
  /** @return {Ctx} */
  get() { return this.ctxStorage.getStore(); },
  set($, fn) { return this.ctxStorage.run($, fn); },
};

// Helper class for endpoints given to them as request context, handles some common HTML templates.
const categoryIDToIndex = ContentCategories.reduce((p, v, k) => ((p[v.id] = k), p), {});

const undoData = new Map();
setInterval(() => Utils.filterMap(undoData, (k, v) => v.date > Date.now()), Timer.ms(AppSettings.periods.undoLifespan) * 0.1);

const recentlySeen = new Map();
setInterval(() => Utils.filterMap(recentlySeen, (k, v) => v > Date.now()), Timer.ms(AppSettings.periods.seenFor) * 0.1);

function conflictContactsMenu(userID, contentID) {
  const data = db.query(`SELECT userData FROM ${DBTbl.Users} WHERE userID=?1`).get(userID);
  if (data) {
    const parsed = JSON.parse(data.userData);
    return <Co.SocialLinks contacts={parsed.contacts} format={`Contact ${userID} via ?1…`} subject={`About ${contentID}`} />;
  }
}

const formatStats = new PerfCounter();
const tblPuts = db.table('p_puts', {
  originKey: db.row.integer({ primary: true }),
  createdDate: db.row.integer({ default: db.value.now, index: true }),
}).extend(tbl => {
  tbl.gc('createdDate', AppSettings.periods.reportCooldown);
  return {
    add: db.bound(`INSERT OR IGNORE INTO ${tbl} (originKey) VALUES (?)`, (s, key) => key && s.run(Number(Bun.hash(key) & 0x7ffffffn)).changes === 1)
  };
});

export class Ctx {
  /** @param {Request} req @param {import('url').Url} url @param {import('bun').Server} server @param {table<string, string>} params */
  constructor(req, url, server, params) {
    this.req = req;
    this.url = url;
    this.server = server;
    this.params = params;
  }

  get requestURL() {
    return this.req.url;
  }

  get requestFullQuery() {
    return this.requestURL.substring(this.realm.length);
  }

  get requestIP() {
    return this.__requestIP || (this.__requestIP = (this.req.headers.get('x-forwarded-for')
      || this.req.headers.get('x-real-ip')
      || this.server.requestIP(this.req)?.address || 'unknown').replace(/^::ffff:/, ''));
  }

  get onlineUserIDs() {
    return [...recentlySeen.keys()];
  }

  get onlineUsersCount() {
    return recentlySeen.size;
  }

  get formatStats() {
    return formatStats;
  }

  get cookies() {
    return this.__cookies || (this.__cookies = new CookieHandler(this.req));
  }

  static #incrementingCounter = Symbol('incrementingCounter');
  get incrementingCounter() {
    return this[Ctx.#incrementingCounter] != null ? this[Ctx.#incrementingCounter]
      : (this[Ctx.#incrementingCounter] = tblPuts.add(`${this.url.pathname}/${this.requestIP}`));
  }

  /** returns something like `https://domainname.com` */
  get realm() {
    return `${this.url.protocol}//${this.url.host}`;
  }

  isUserOnline(userID) {
    return recentlySeen.has(userID);
  }

  requestError(message, ...hints) {
    return new RequestError(400, message, hints.length ? hints : [<Co.Link href="/manage">Go to the main page</Co.Link>]);
  }

  can(level = 1) {
    if (level && typeof level === 'object') return level.userKey == null || level.userKey === this.user.userKey && this.can(Access.EDIT) || this.can(Access.MODERATE);
    if (level === -1) return this.user.accessMask === -1;
    return level != null && (this.user.accessMask & level) === level;
  }

  /** @template {any} T @param {T} level @return {T} */
  writes(level = 1) {
    if (level == null) throw new RequestError(404);
    if (!this.can(level)) throw this.requestError('Permission denied');
    return level;
  }

  canSetPermission(level) {
    return this.can(Access.ADMIN) || AccessPermissions.some(x => x.flag === level && !x.hidden);
  }

  /** @template {any} T @param {T} fields @return {{ [K in keyof T]: boolean|number|string|string[] }} */
  form(fields, ...fallback) {
    const f = Object.assign({}, ...fallback);
    for (const key in fields) {
      if (typeof fields[key] !== 'object') {
        if (fields[key] != null) f[key] = fields[key];
        continue;
      }
      const rules = fields[key];
      let v = this.params[`data-${key}`]?.trim();
      if (typeof rules.type === 'string') {
        if (rules.type === 'TEXT' && this.params[`data-${key}`] != null) { f[key] = v || null; }
        if (rules.type === 'INTEGER' && this.params[`data-${key}`] != null) { f[key] = +(v || 0) | 0; }
        if (rules.type === 'BOOLEAN') { f[key] = this.params[`data-${key}`] === 'on'; }
      } else {
        if (typeof rules.prepare === 'function' && v) v = rules.prepare(v);
        if (rules.maxLength && v && v.length > rules.maxLength) throw this.requestError(`Value exceeds limits: ${key}`);
        if (rules.required && !v
          || v && (rules.test instanceof RegExp && !rules.test.test(v)
            || typeof rules.test === 'function' && !rules.test(v))) throw this.requestError(rules.errorMessage || `Required value: ${key}`);
        if (rules.separator) v = v ? v.split(rules.separator).map(x => x.trim()) : [];
        if (!v && rules.fallback) v = rules.fallback();
        if (v) f[key] = v;
      }
    }
    return f;
  }

  static #allowedFilter = Symbol('allowedFilter');
  verifyID(categoryIndex, contentID) {
    const args = {};
    if (contentID !== Utils.idfy(contentID, true)) {
      throw this.requestError('ID can only contain lowercase latin symbols, digits, “_”, “-“, “.“ or spaces',
        <Co.Link feedback={`I want to use ${ContentCategories[categoryIndex].id}/${contentID} as ID`}>Ask for a change of rules…</Co.Link>);
    }
    try {
      DBTbl.Content.verifyID(categoryIndex, contentID, args);
    } catch (e) {
      throw args.userID !== this.user.userID
        ? this.requestError(<>ID “{ContentCategories[categoryIndex].id}/{contentID}” is already used by <Co.UserLink userID={args.userID} /> and <a href={U`/manage/${ContentCategories[categoryIndex].id}/${contentID}`}>has {args.countDownloads} {Utils.plural('download', args.countDownloads)}</a></>,
          <Co.Link feedback={`I want to register ${ContentCategories[categoryIndex].id}/${contentID}, but it’s currently taken by ${args.userID}`}>Ask moderators to transfer the ID…</Co.Link>,
          conflictContactsMenu(args.userID, contentID))
        : args.contentID ? this.requestError(<>You’re already using “{ContentCategories[categoryIndex].id}/{contentID}” as a secondary for {args.contentID}</>,
          <Co.Link href={U`/manage/${ContentCategories[categoryIndex].id}/${args.contentID}`}>Edit {ContentCategories[categoryIndex].id}/{args.contentID}…</Co.Link>)
          : this.requestError(<>You’ve already registered “{ContentCategories[categoryIndex].id}/{contentID}”</>,
            <Co.Link href={U`/manage/${ContentCategories[categoryIndex].id}/${args.contentID}`}>Edit {ContentCategories[categoryIndex].id}/{args.contentID}…</Co.Link>);
    }
    const allowedFilter = this[Ctx.#allowedFilter] || (this[Ctx.#allowedFilter] = db.query(`SELECT allowedFilter FROM ${DBTbl.Users} WHERE userKey = ?1`).get(this.user.userKey).allowedFilter);
    if (allowedFilter && !ContentUtils.parseAllowedFilter(allowedFilter).test(`${ContentCategories[categoryIndex].maskID}:${contentID}`)) {
      throw this.requestError('Sorry, but currently you don’t have permission to use such ID',
        <Co.Link feedback={`I want to register ${ContentCategories[categoryIndex].id} ${contentID}`}>Request access…</Co.Link>);
    }
    if (!allowedFilter && ContentCategories[categoryIndex].limited) {
      throw this.requestError('Sorry, but currently you don’t have permission to register this type of content',
        <Co.Link feedback={`I want to register ${ContentCategories[categoryIndex].id} ${contentID}`}>Request access…</Co.Link>);
    }
    Hooks.trigger('core.verifyID', { categoryIndex, contentID, $: this });
  }

  authorSuggestions(userKey) {
    userKey = userKey || this.user.userKey;
    const r = db.query(`SELECT dataAuthor, COUNT(*) AS count FROM ${DBTbl.Content} WHERE userKey=?1 GROUP BY dataAuthor ORDER BY count DESC`).all(userKey).map(x => x.dataAuthor);
    if (userKey == this.user.userKey) {
      if (this.userData.dataAuthor && !r.includes(this.userData.dataAuthor)) r.push(this.userData.dataAuthor);
      if (this.userData.profileName && !r.includes(this.userData.profileName)) r.push(this.userData.profileName);
    }
    return r;
  }

  static #id = Symbol('id');
  get id() {
    return this[Ctx.#id] ?? (this[Ctx.#id] = Utils.idfy(this.params.value, true) || 'unnamed');
  }

  get categoryIndex() {
    return categoryIDToIndex[this.params.categoryID];
  }

  get signed() {
    let user = Hooks.poll('core.user.signedCheck', this);
    return user !== undefined ? user : this.req.headers.get('authorization') != null;
  }

  get requiredUserFields() {
    return `userKey, userID, createdDate, lastSeenDate, accessMask, allowedFilter, introduced`
  }

  /** @returns {{userID: string, userKey: integer}} */
  get user() {
    if (!this.__user) {
      let user = Hooks.poll('core.user.auth', this);
      if (user === undefined) {
        const auth = Buffer.from((this.req.headers.get('authorization') || '').split(' ', 2)[1] || '', 'base64').toString('utf-8').split(':');
        user = db.query(`SELECT ${this.requiredUserFields}, password FROM ${DBTbl.Users} WHERE userID=?1`).get(auth[0]);
        if (user && user.password !== DBTbl.Users.passEncode(auth[0], auth[1])) user = null;
      }

      Hooks.trigger('core.user', user, this);
      // if (user) user.introduced = 0;
      if (!user) {
        this.header('WWW-Authenticate', 'Basic realm=manage, charset="UTF-8"');
        throw new RequestError(401, 'Unauthorized', <Co.Page title="Authorization required" center>
          <p>This web-panel allows content creators to register new updates for their mods for Assetto Corsa.</p>
          <p>If you want to access it, please contact us and we’ll create a profile for you. To speed things up, please list prefixes you are using for your folder names if any, or folder names of mods you wish to update.</p>
          <p>
            <Co.InlineMenu>
              <Co.Link href={this.requestURL}>Try again</Co.Link>
              <Co.SocialLinks contacts={AppSettings.ownContacts} format="Contact via ?1…" subject="CUP invite" />
            </Co.InlineMenu>
          </p>
        </Co.Page>);
      } else if (!user.introduced && !this.url.pathname.startsWith('/manage/introduction')) {
        echo`Introducing: _${user.userID}  from _${this.url}`;
        this.header('Location', `/manage/introduction?redirect=${encodeURIComponent(`${this.url.pathname}${this.url.search}`)}`);
        throw new RequestError(302, 'Unintroduced', new BunJSX(''));
      } else {
        this.__user = user;
        if (!user._invisible) {
          recentlySeen.set(user.userID, Timer.timestamp(AppSettings.periods.seenFor));
          if (+db.value.now > user.lastSeenDate + 10) {
            user.lastSeenDate = +db.value.now;
            DBTbl.Users.updateLastSeen(user.userKey);
          }
        }
      }
    }
    return this.__user;
  }

  get userData() {
    if (!this.__userData) {
      this.__userData = JSON.parse(db.query(`SELECT userData FROM ${DBTbl.Users} WHERE userKey = ?1`).get(this.user.userKey).userData);
    }
    return this.__userData;
  }

  get group() {
    if (!this.__group) {
      this.__group = db.query(`SELECT * FROM ${DBTbl.Groups} WHERE userKey=?1 AND groupID=?2`).get(this.user.userKey, this.params.groupID);
      if (this.__group) this.currentGroup = this.__group.groupID;
    }
    return this.__group;
  }

  get groups() {
    if (!this.__groups) {
      this.__groups = db.query(`SELECT g.groupKey, g.groupID, g.name, g.createdDate, COUNT(c.contentID) AS count FROM ${DBTbl.Groups} g LEFT JOIN ${DBTbl.Content} c ON g.groupKey = c.groupKey WHERE g.userKey=?1 GROUP BY g.groupKey ${DBTbl.Groups.order('g')}`).all(this.user.userKey);
    }
    return this.__groups;
  }

  static #extraContent(dst, items) {
    items.forEach(x => dst.add(Array.isArray(x) || typeof x === 'string' || typeof x === 'function'
      ? x : x instanceof BunJSX ? x.content : '' + <G>{x}</G>));
  }

  head(...items) {
    Ctx.#extraContent(this.__head || (this.__head = new Set()), items);
  }

  foot(...items) {
    Ctx.#extraContent(this.__foot || (this.__foot = new Set()), items);
  }

  /** @param {null|'good'|'warn'} type */
  toast(type, ...items) {
    if (!this.__toast) {
      this.__toast = [];
      this.foot(() => <div class="toasts">{this.__toast}</div>, <script>{`document.querySelectorAll('.toast').forEach(fixPage)`}</script>);
    }
    if (Array.isArray(type)) {
      this.__toast.push(...type);
    } else {
      if (items.length === 1) items.push(<Co.Link good onclick="closeToast(this)">OK</Co.Link>);
      this.__toast.push((<div class="toast" data-toast={type}><Co.InlineMenu>{items}</Co.InlineMenu></div>).content);
    }
  }

  header(key, value) {
    (this.__headers || (this.__headers = {}))[key] = value;
  }

  get referer() {
    const r = this.req.headers.get('referer');
    return r && r.replace(/https?:\/\/[^\/]+/, '');
  }

  undo(title, cb) {
    undoData.set(this.user.userKey, {
      title,
      date: Timer.timestamp(AppSettings.periods.undoLifespan),
      url: this.params.location || this.referer || this.url.pathname,
      cb
    });
  }

  processUndo() {
    const e = undoData.get(this.user.userKey);
    if (!e) throw this.requestError('Action to undo is gone, unfortunately you’ll have to revert changes manually');
    undoData.delete(this.user.userKey);
    {
      using _ = db.write().start();
      e.url = e.cb(this) || e.url;
    }
    return e.url;
  }

  clearUndo() {
    return new Response(null, { status: undoData.delete(this.user.userKey) ? 204 : 404 });
  }

  /** @param {Date | number} modifiedDate Date or timestamp in seconds */
  lastModified(modifiedDate) {
    const ts = modifiedDate instanceof Date ? modifiedDate : new Date(modifiedDate * 1e3);
    const ifModifiedSince = this.req.headers.get('if-modified-since');
    if (ifModifiedSince && +new Date(ifModifiedSince) >= +ts - 1e3) {
      throw new Response(null, { status: 304 });
    }

    this.header('Last-Modified', ts.toUTCString());
  }

  constructResponse(body, headers, status) {
    return typeof body === 'string' && body.length > 600 && this.req.headers.get('accept-encoding')?.indexOf('deflate') >= 0
      ? new Response(Bun.deflateSync(body), { status, headers: Object.assign({ 'Content-Encoding': 'deflate' }, headers) })
      : new Response(body, { status, headers });
  }

  /** @template {any} T @param {number | string} periodMs @param {T} pieces @returns {T} */
  liveUpdating(periodMs, ...pieces) {
    if (this.req.headers.has('X-Live-Update')) {
      throw this.constructResponse(pieces.join('\0'), { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' });
    }
    return pieces.map((x, i) => new BunJSX(`<live-updating index=${i} period=${Math.ceil(Timer.seconds(periodMs)) || 60}>${x}</live-updating>`));
  }
}

const marked = jsExt.withRequired('marked3', (marked, markdownData) => marked(markdownData, { silent: true }));
const contentEntryExists = DBTbl.Content.pexists(['categoryIndex', 'contentID']);
const isKnown = new LazyMap(urlPart => {
  const s = urlPart.split('/', 3);
  if (s.length !== 2) return false;
  const c = categoryIDToIndex[s[0]];
  if (c == null) return false;
  return contentEntryExists({ categoryIndex: c, contentID: s[1] });
});

function prepareForm(action, args) {
  if (typeof action === 'function') {
    const $ = curCtx.get();
    const k = `${$.__pushedID || ''}/${action.uniqueKey || Utils.hash64(action, true)}/${$.__directActionIndex = (($.__directActionIndex || 0) + 1)}`;
    if (k === $.params.__directActionID) {
      action($);
      throw Object.assign(new Error(), { directResult: true });
    }
    return [$.requestFullQuery, Object.assign({ __directActionID: k }, $.params, args)];
  }
  if (Array.isArray(action)) {
    if (args && Object.keys(args).length > 0) throw new Error(`With Server.command(), args property will be ignored: ${action[0]}`);
    const $ = curCtx.get();
    return [action[0], { _a: action[1], _c: $.__lambdaCtx || ($.__lambdaCtx = Bun.sha(`${$.user.userKey}:${$.user.accessMask}`, 'base64')) }];
  }
  return [action, args];
}

const tblSentForms = db.table('t_sentforms', {
  key: db.row.integer({ primary: true }),
  createdDate: db.row.integer({ default: db.value.now })
}).extend(tbl => {
  tbl.gc('createdDate', '4 hr');
  return {
    add: key => {
      try {
        tbl.insert({ key });
      } catch {
        throw new RequestError(400, 'Form has already been sent, please refresh the page');
      }
    },
    next: () => Number(require('crypto').randomBytes(8).readBigUInt64LE(0) & ((1n << 53n) - 1n))
  };
});

export const Co = {
  Page(props, body) {
    curCtx.get().currentTitle = (Array.isArray(props.title) ? props.title.join('') : '' + props.title).replace(/<.+?>/g, '');
    if (props.center) {
      return <div class="center">
        <h1 data-page-search={props.search}>{props.title}</h1>
        {body}
      </div>
    }
    return <>
      <h1 data-page-search={props.search}>{props.title}</h1>
      {body}
    </>
  },

  Tags(props) {
    return <div class="tags">{props.tags.filter(Boolean).map(x => <span>{x}</span>)}</div>;
  },

  JSON(props) {
    return <Co.Page title="Development"><pre>{JSON.stringify(props, null, 2)}</pre></Co.Page>;
  },

  Markdown(props, body) {
    return <div style={props.style}>{new BunJSX(marked.ready() ? marked(props.content) : Bun.escapeHTML(props.content))}</div>;
  },

  FormattedMessage(props, body) {
    if (!props.value) return null;
    let msg = props.value;
    if (props['single-line'] && msg.indexOf('\n') !== -1) msg = msg.split('\n', 1)[0].trim() + '…';
    if (props['max-length'] && msg.length > props['max-length']) msg = msg.substring(0, props['max-length']) + '…';
    return msg ? new BunJSX(Hooks.trigger('core.formatMessage', {
      message: Bun.escapeHTML(msg)
        .replace(/\b(car|track|showroom|filter|python|lua|user) ([\w.-]+)\b/g,
          (_, c, i) => isKnown.get(`${c}/${i}`) ? `<a href="/manage/${c}/${i}">${_}</a>` : _)
        .replace(/\[(.+?)\]\((\/.+?)\)/g, (_, title, url) => `<a href="${url}">${title}</a>`)
        .replace(/\bhttps?:\/\/\S+?(?=$| |[.,!?] )/g, _ => `<a href="${_}">${_}</a>`)
    }).message) : null;
  },

  BBCodeMessage(props, body) {
    if (!props.value) return null;
    let msg = props.value;
    if (props['single-line'] && msg.indexOf('\n') !== -1) msg = msg.split('\n', 1)[0].trim() + '…';
    if (props['max-length'] && msg.length > props['max-length']) msg = msg.substring(0, props['max-length']) + '…';
    return msg ? new BunJSX(Hooks.trigger('core.formatMessage', {
      message: Bun.escapeHTML(msg)
        .replace(/\[([bi])\](.*?)\[\/\1\]/g, '<$1>$2</$1>')
    }).message) : null;
  },

  Date(props) {
    try {
      const d = new Date(props.value * 1e3);
      const y = Date.now() - +d;
      // return <span data-timestamp-title={d.toISOString()}>{y < 15e3 ? 'now' : Utils.age(y / (24 * 60 * 60e3), props.short) + (props.short ? '' : ' ago')}</span>;
      return <span data-sort-by={props.value} data-timestamp-title={d.toISOString()}>{y < 5e3 ? 'now' : Utils.age(y / (24 * 60 * 60e3), props.short) + (props.short ? '' : ' ago')}</span>;
    } catch {
      return <span>Invalid date: {props.value || '<none>'}</span>;
    }
  },

  PermissionsList(props) {
    const list = props.short && AccessPermissionShortenings[props.value]
      || AccessPermissions.filter(x => x.title && (x.flag & props.value) == x.flag && (!x.hidden || curCtx.get().can(Access.ADMIN)));
    return new BunJSX(list.map(x => <Co.Value title={x.title}>{x.id}</Co.Value>).join(', ')
      || `<span class="placeholder" data-value-dev="${Bun.escapeHTML(JSON.stringify(props.value))}">&lt;none&gt;</span>`);
  },

  UserLink(props) {
    if (!props.userID && !props.userKey) return <Co.Value placeholder="unknown user" />;
    const userID = props.userID || DBTbl.Users.userID(props.userKey);
    return <a href={U`/manage/user/${userID}`} data-selected={userID === curCtx.get().__user?.userID}
      data-online={!props['hide-online-mark'] && recentlySeen.has(userID)}>{userID}</a>;
  },

  ContentLink(props) {
    if (!props.content || !props.content.categoryIndex || !props.content.contentID) return <Co.Value placeholder="unknown entry" />;
    let title = props.content.dataName && props.content.dataName !== props.content.contentID ? `${props.content.dataName} (${props.content.contentID})` : props.content.contentID;
    if (!props.typeless) title = `${ContentCategories[props.content.categoryIndex].title} ${title}`;
    return <a href={U`/manage/${ContentCategories[props.content.categoryIndex].id}/${props.content.contentID}`}>
      {title}
    </a>;
  },

  Value(props, body) {
    const title = props.title ? Locale.hints[props.title] || props.title : null;
    if (!body.length && props.value) {
      body = [props.value];
    }
    if (!body.length) {
      if (props.placeholder) {
        return <span class={[props.class, 'placeholder']}>{title ? <span title={title}>{`<${props.placeholder}>`}</span> : `<${props.placeholder}>`}</span>
      }
      return null;
    }
    return <span title={title} class={[props.class, props.mono ? 'mono' : undefined]}>{body}</span>;
  },

  List(props, body) {
    return body.map(x => <li>{x}</li>);
  },

  MainForm: {
    /** Set `unique` flag if form is working in POST mode rather than PATCH mode (that is, adds a new entry instead of editing existing one). */
    Start(props) {
      let r = '<form method=POST id=mainForm';
      if (props.autocomplete) r += ' autocomplete=on';
      if (props.action) r += ` action="${Bun.escapeHTML(props.action)}"`;
      if (props.multipart) r += ` enctype="multipart/form-data"`;
      r += '>';
      if (props.unique) r += `<input type=hidden value=${tblSentForms.next()} name=_uniqueFormKey>`; // TODO: unique form key
      return new BunJSX(r);
    },
    End(props, body) {
      if (!body.length) return new BunJSX(`</form>`);
      return new BunJSX(<input class="link good" type="submit" form="mainForm" data-submit-always-enabled={props.active} value={body} /> + `</form>`);
    },
    Submit(props, body) {
      return <form><input class="link good" name={props.name} type="submit" form="mainForm" data-submit-always-enabled={props.active} value={body} /></form>;
    },
  },

  Switch(props, body) {
    const [url, args] = prepareForm(props.action, props.args || {});
    args.state = !props.state;
    return <input data-sort-by={args.state ? 0 : 1} type="checkbox" name="state" checked={args.state ? null : 'on'} onchange={`this.disabled=true;fetch(${JSON.stringify(url)},{method:'POST',body:${JSON.stringify(`_args=${encodeURIComponent(JSON.stringify(args))}`)},headers:{'Content-Type':'application/x-www-form-urlencoded'}}).then(r=>setTimeout(()=>this.disabled=false, 500));`} />;

    //  {argsInput}
    // return new BunJSX(``)
  },

  Link(props, body) {
    const title = props.title ? Locale.hints[props.title] || props.title : null;
    if (props.action) {
      const list = props.args && Object.entries(props.args).filter(([k, v]) => Array.isArray(v))[0];
      const args = props.args && Object.entries(props.args).reduce((p, [k, v]) => (Array.isArray(v) ? null
        : (p[k] = v === 'current' && k === 'location' ? curCtx.get().url.pathname : v), p), {}) || {};

      if (props.action.linkProps) {
        Object.assign(props, props.action.linkProps);
      }

      const [url, argsAdjusted] = prepareForm(props.action, args);
      const argsInput = Object.keys(argsAdjusted).length === 0 ? null : <input type="hidden" name="_args" value={JSON.stringify(argsAdjusted)} />;

      if (list) {
        const k = Utils.uid();
        return <form action={url} method="POST" data-immediate data-live-apply={props['data-live-apply']}>
          <label class="inline" for={k}>{body}</label>
          <select id={k} name={list[0]}>{list[1].map(x => <option value={x.value} selected={!!x.selected}>{x.name}</option>)}</select>
          {argsInput}
        </form>;
      }
      return <form action={url} method="POST" data-form={props.query} data-form-argument={props.default} data-live-apply={props['data-live-apply']}>
        {props.query ? <input type="hidden" name="value" /> : null}
        {argsInput}
        <input type="submit" class={props.good ? `link good` : `link`} value={body} title={title} data-selected={props['data-selected']} />
      </form>;
    }

    let h;
    if (props.feedback) {
      h = Hooks.poll('core.feedbackURL', props.feedback) || `mailto:${AppSettings.ownContacts.mail}?subject=${encodeURIComponent(`CUP: ${props.feedback}`)}`;
    } else {
      h = props.href;
      if (h && props.args) {
        h += `?${Object.entries(props.args).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
      }
    }

    const className = props.danger ? `link` : props.good ? 'good' : props.disabled ? 'disabled' : null;
    if (props.onclick) {
      return <a href={h || '#'} title={title} class={className} onclick={`${props.onclick};return false`}>{body}</a>;
    }

    return h || className ? <a href={h} title={title} class={className} 
      data-selected={typeof props['data-selected'] === 'boolean' || props['data-selected'] ? props['data-selected'] : h === curCtx.get().url.pathname}>{body}</a> : body;
  },

  SocialLinks(props, body) {
    if (!props.contacts) return null;
    return Object.entries(props.contacts).map(([k, v]) => !v ? null :
      <Co.Link href={Utils.social(k, v, props.subject)}>{props.format.replace('?1', Utils.social(k))}</Co.Link>);
  },

  InlineMenu(props, body) {
    return new BunJSX(`<nobr>${body.join('</nobr> <nobr><span class=separator>|</span> ')}</nobr>`);
  },

  Row(props, body) {
    if (props.accessMask != null) {
      return <li>
        <div class="checkboxes">
          <label class="for">{body}<input id="dummy" /></label>
          {AccessPermissions.map(x => (!x.hidden || curCtx.get().can(Access.ADMIN)) ? <nobr><input id={`perm-${x.flag}`} name={`perm-${x.flag}`} type="checkbox" checked={(props.accessMask & x.flag) === x.flag} /><label class="inline2" for={`perm-${x.flag}`}><span title={x.title}>{x.id}</span></label></nobr> : null)}
        </div>
      </li>
    }
    const key = props.key || '';
    const data = props.data || {};
    const inh = Object.assign(
      { id: `data-${key}`, name: `data-${key}`, placeholder: typeof props.default === 'boolean' ? undefined : props.placeholder || '?' },
      props.attributes);
    if (props.readonly) inh.readonly = true;
    if (props.disabled) inh.disabled = true;
    if (props.required) inh.required = true;
    let input;
    if (typeof props.default === 'boolean') {
      if (props['forced-choice']) {
        delete inh.value;
        input = <select $attr={inh} required data-forced-choice>
          <option disabled selected value="" hidden>Select an option…</option>
          <optgroup label="Please select:">
            <option value="on">Yes</option>
            <option value="off">No</option>
          </optgroup>
        </select>;
      } else {
        input = <input $attr={inh} type="checkbox" checked={data[key] == null ? props.default : !!data[key]} />;
      }
    } else if (props.multiline) {
      input = <textarea $attr={inh}>{data[key]}</textarea>;
    } else if (props.options) {
      input = <><input $attr={inh} list={`list-${key}`} value={data[key]} /><datalist id={`list-${key}`}>{props.options.map(x => <option value={x}>{x}</option>)}</datalist></>;
    } else {
      input = <input $attr={inh} value={data[key]} />;
    }
    if (props.raw) throw new Error('unsupported');
    return <G $hook={props['input-hook']}><li class="row" title={props.title || Locale.hints[key]}><label for={`data-${key}`}><span>{body}</span></label>{input}</li></G>;
  },

  Dropdown(props, body) {
    return <span class="dropdown">{Co.Link(props, props.label)}<div class="dropdown-content" data-dropdown-align-right={props['data-dropdown-align-right']}>{body}</div></span>;
  },
};

Hooks.register('core.tpl.userMenu', body => {
  if (!body.some(x => /data-selected/.test(x))) {
    body.filter(x => x.content).forEach(x => x.content = x.content.replace(/<a href="([^"]+)"/g, (_, u) => curCtx.get().url.pathname.startsWith(u) ? `${_} data-selected` : _));
  }
}, Infinity);

// Errors collection
function collectError(error, $) {
  Hooks.trigger('core.error', { error, $ });
}

// HTTP server
const router = new Router();
const redirects = new Map();
const zones = new Map();

/** @param {Ctx} $ */
function postponeToasts($) {
  if (!$.__toast) return;
  $.cookies.set('postponedToasts', $.__toast, { age: '1s' });
}

class Zone {
  constructor(prefix, params) {
    Object.assign(this, { __prefix: prefix }, params);
  }

  finalize($, data) {
    if (!data) return new Response(null, { status: 404 });
    if (data instanceof Error) throw data;
    throw new Error(`Zone “${this.__prefix}” without defined finalize function can’t handle raw responses`);
  }

  options(req, url) {
    if (req.method === 'OPTIONS') {
      if (!router.get('GET', url.pathname, {})) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200, headers: Object.assign({
          'Allow': [...new Set([
            'HEAD', 'OPTIONS', 'GET', ...Object.keys(router.methods).filter(x => router.get(x, url.pathname, {}))
          ])].join(',')
        }, this.headers)
      });
    }
  }

  /** @param {Request} req @param {URL} url @param {import('bun').Server} server */
  handle(req, url, server) {
    if (this.perf) this.perf.start();

    const params = {};
    const $ = new Ctx(req, url, server, params);

    return curCtx.set($, async () => {
      echo`Serving ^${req.method} ^${$.requestURL}…`;

      let data;
      try {
        if (this.prepare) await this.prepare($);
        if (req.method === 'POST' && $.params.__directActionID) {
          try {
            await router.get('GET', url.pathname, {})($);
          } catch (e) {
            data = e;
          }
          data = data instanceof Error ? data.directResult ? '/~' : data : new Error('Direct action malfunction');
        } else {
          const found = router.get(req.method, url.pathname, params)
            || req.method === 'HEAD' && router.get('GET', url.pathname, params);
          if (found) {
            data = await found($);
          } else {
            data = this.options(req, url) || await Hooks.poll('core.serve.missing', { $, url: url.pathname });
          }
        }
      } catch (e) {
        if (e instanceof Response) return e;
        collectError(e, $);
        if (e instanceof RequestError) {
          echo`!  RequestError: =${e.code}`;
          data = e.code === 404 ? null : e;
        } else {
          echo`#  Error: =${e}`;
          data = e
        }
      }

      if (typeof data === 'string' && data.startsWith('/')) {
        echo`  Redirect: ^${data}`;
        if ($.params.location) {
          data = $.params.location;
        } else {
          const r = redirects.get(data);
          if (r) {
            try {
              data = r($);
            } catch (e) {
              echo`!Redirect error (${data}): =${e}`;
            }
          }
        }
        if (data === `${url.pathname}${url.search || ''}` && req.method === 'GET') throw new Error(`Invalid redirect: ${data}`);
        if (data === '/~') data = $.referer;
        postponeToasts($);
        data = new Response(null, { status: 302, headers: { 'Location': data } });
      } else if (data instanceof Response) {
        // $.postponeToasts();
      } else {
        data = this.finalize($, data, data instanceof RequestError ? data.code : data instanceof Error ? 500 : data != null ? data === '' ? 204 : 200 : 404, this.headers);
      }

      for (const key in $.__headers) data.headers.set(key, $.__headers[key]);
      CookieHandler.apply($.__cookies, data);
      if (this.perf) this.perf.consider(url.pathname);
      return data;
    });
  }

  /** @return {Zone} */
  static find(path) {
    if (path[1] === '/') path = path.replace(/^\/+/, '/');
    const k = zones.get(path.charCodeAt(1));
    if (k) {
      for (let i = 0; k && i < k.length; ++i) {
        if (path.startsWith(k[i].__prefix)) return k[i];
      }
    }
    return zones.get(0)[0];
  }
}

export const Server = {
  /** @return {Ctx} */
  get $() { return curCtx.get(); },

  /** @param {($: Ctx) => string} callback */
  get(path, callback) { router.on('GET', path, callback); },
  /** @param {($: Ctx) => string} callback */
  options(path, callback) { router.on('OPTIONS', path, callback); },
  /** @param {($: Ctx) => string} callback */
  post(path, callback) { router.on('POST', path, callback); },
  /** @param {($: Ctx) => string} callback */
  patch(path, callback) { router.on('PATCH', path, callback); },
  /** @param {($: Ctx) => string} callback */
  put(path, callback) { router.on('PUT', path, callback); },
  /** @param {($: Ctx) => string} callback */
  delete(path, callback) { router.on('DELETE', path, callback); },
  /** @param {($: Ctx) => string} callback */
  redirect(path, callback) { redirects.set(path, callback); },

  /** 
   * @param {{
   *  handle: nil|(req: Request, url: URL) => Promise<Response>|Response, 
   *  headers: nil|table,
   *  prepare: nil|($: Ctx) => Promise, 
   *  finalize: nil|($: Ctx, data: any, status: integer, headers: table) => string|ArrayBuffer,
   *  perf: PerfCounter?
   * }} params 
   */
  zone(prefix, params) {
    const zone = new Zone(prefix, params);
    const k = prefix.charCodeAt(1) || 0;
    if (!zones.has(k)) zones.set(k, []);
    zones.get(k).push(zone);
  },

  /** 
   * @template {any[]} T 
   * @param {(this: Ctx, ...args: T) => any} fn 
   * @param {any} props
   * @return {(...args: T) => void} 
   */
  command(fn, linkProps = undefined) {
    const b = Bun.hash(fn);
    return (...args) => {
      let h = b;
      for (let arg of args) h = h * 397n ^ Bun.hash(arg);
      let r = $ => fn.call($, ...args);
      r.uniqueKey = Utils.hash64(h, true);
      if (linkProps) r.linkProps = linkProps;
      return r;
    };
  },
};

/** @param {Request} req @param {Response|Promise<Response>} res */
function fixHeadyRequests(req, res) {
  if (req.method === 'HEAD' || req.method === 'OPTIONS') {
    return (async () => {
      let r = await res;
      let e = new Response(null, { status: r.status, headers: r.headers });
      if (req.method === 'OPTIONS' && !e.headers.has('Allow')) e.headers.set('Allow', 'HEAD,OPTIONS,GET');
      return e;
    })();
  }
  return res;
}

export async function appStart() {
  await Hooks.async('core.starting.async');
  Bun.serve({
    port: AppSettings.core.httpPort,
    fetch(req, server) {
      const url = new URL(req.url);
      return fixHeadyRequests(req, Zone.find(url.pathname).handle(req, url, server));
    },
    error(error) {
      echo`#Serve error: =${error}`;
      collectError(error, null);
      return new Response(process.platform === 'win32' ? error.stack || error : 'Internal error', { status: 500, headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Connection': 'close' } });
    },
  });
  echo`Running server on :^${AppSettings.core.httpPort} port`;
  await Hooks.async('core.started.async');
  if (AppSettings.admin && AppSettings.admin.userID
    && db.query(`SELECT COUNT(*) as count FROM ${DBTbl.Users} WHERE userID=?1`).get(AppSettings.admin.userID).count === 0) {
    const userKey = db.query(`INSERT INTO ${DBTbl.Users} (userID, password, accessMask, introduced) VALUES (?1, ?2, ?3, true);`).run(AppSettings.admin.userID, DBTbl.Users.passEncode(AppSettings.admin.userID, AppSettings.admin.password || ''), Access.ADMIN ? 1 : 0).lastInsertRowid;
    db.query(`INSERT INTO ${DBTbl.Groups} (userKey, groupID, name) VALUES (?1, ?2, ?3)`).run(userKey, 'main', 'Main');
  } else if (db.query(`SELECT COUNT(*) as count FROM ${DBTbl.Users} WHERE accessMask = ?1`).get(Access.ADMIN).count === 0) {
    echo`No admin account detected, use configuration file to set credentials and restart the service.`;
  }
}

function flatify(arr, prepend = '', dst = null) {
  if (!arr) return prepend.toString();
  if (!dst) dst = new BunJSX(prepend.toString());
  if (arr instanceof Set || Array.isArray(arr)) {
    for (const v of arr) flatify(v, '', dst);
  } else {
    dst.content += typeof arr === 'function' ? arr() : arr;
  }
  return dst.content;
}

const headTags = <>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="stylesheet" href={Utils.versioned('/res/style.css')} />
  <link rel="shortcut icon" type="image/x-icon" href="/res/icon.ico" sizes="16x16" />
  <link rel="icon" type="image/x-icon" href="/res/icon.png" sizes="16x16" />
  <link rel="apple-touch-icon-precomposed" href="/res/icon.png" />
</>;

const footTags = <>
  <div class="popup-bg"></div>
  <script src={Utils.versioned('/res/script.js')}></script>
</>

/** @param {Ctx} $ */
export function formatGenericPage($, data) {
  let user = $.__user;
  if (!user && $.signed) {
    try {
      user = $.user;
    } catch (ce) { console.warn(ce) }
  }
  const final = {
    title: $.currentTitle ? `Content Updates Panel v2 – ${$.currentTitle}` : 'Content Updates Panel v2',
    header: user && user.introduced ? `<header><div class=header-right>${<Co.Dropdown href={U`/manage/user/${user.userID}`} label={<G $hook="core.tpl.userMenu.header">👱{` `}{user.userID}</G>} data-dropdown-align-right>
      <G $hook="core.tpl.userMenu">
        <Co.Link href={U`/manage/user/${user.userID}`}>Your profile</Co.Link>
        <Co.Link href="/manage/group">Content groups</Co.Link>
      </G>
      <hr />
      <Co.Link action="/manage/command/logout">Log out</Co.Link>
    </Co.Dropdown>}</div>${<G $hook="core.tpl.header"><Co.InlineMenu>{$.groups.length === 1
      ? <Co.Link href={U`/manage/group/${$.groups[0].groupID}`} data-selected={$.currentGroup != null}>Your content ({$.groups[0].count})</Co.Link>
      : $.groups.map(x => <Co.Link href={U`/manage/group/${x.groupID}`} data-selected={$.currentGroup === x.groupID}>{x.name} ({x.count})</Co.Link>)
    }</Co.InlineMenu></G>}</header>` : '',
    body: data instanceof Error
      ? data instanceof RequestError
        ? data.options instanceof BunJSX
          ? data.options
          : <Co.Page title="Can’t do" center>
            <ul class="form">
              <p>{typeof data.body === 'string' ? data.body + '.' : data.body}</p>
              {data.options ? <><hr /><Co.InlineMenu>{data.options}</Co.InlineMenu></> : null}
            </ul>
          </Co.Page>
        : <Co.Page title="Server error" center>
          <p><pre>{('' + (data.stack || data.message)).replace(/\(\S+[/\\]([\w-]+)\.js\b/g, '($1')}</pre></p>
        </Co.Page>
      : data || <Co.Page title="Not found" center><p>Requested resource does not exist.</p></Co.Page>
  };
  Hooks.trigger('core.tpl.final', final, $, $.__user);
  return `<!DOCTYPE html><html><head><title>${final.title}</title>${flatify($.__head, headTags)}</head><body><noscript>Your browser does not support JavaScript, some features won’t function as intended.</noscript>${final.header}<main>${final.body}</main>${flatify($.__foot, footTags)}</body></html>`;
}

function assignWeak(target, obj) {
  for (const [key, value] of obj) {
    if (key === '_args') assignWeak(target, Object.entries(JSON.parse(value)));
    else if (target[key] === undefined) target[key] = value;
  }
}

export class JSONResponse extends Response {
  static headers = { 'Content-Type': 'application/json; charset=UTF-8' }

  /** @param {null|object|any[]|string|Buffer|ArrayBuffer} data @param {{dynamic: boolean, status: number, headers: object}} props */
  constructor(data, props) {
    const headers = {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': props?.dynamic ? 'no-store' : 'max-age=3600, public'
    };
    let body, status = props?.status;
    if (data === '' || data == null) {
      body = null;
      if (!status) status = 204;
    } else if (data instanceof Buffer || data instanceof ArrayBuffer || data instanceof Uint8Array) {
      body = data;
      headers['Content-Encoding'] = 'deflate';
    } else if (data instanceof Error) {
      body = JSON.stringify({ error: data instanceof RequestError && data.message || data.code || data });
      if (!status) status = 400;
    } else {
      body = typeof data === 'string' ? data : JSON.stringify(data);
    }
    if (props?.headers) Object.assign(headers, props.headers);
    return new Response(body, { status, headers });
  }
}

// Three main zones: root, /api and /manage:
Server.zone('/', null);
Server.zone('/api', {
  headers: JSONResponse.headers,
  finalize($, data, status, headers) {
    // console.log(`API request: ${$.req.method} ${$.requestURL} → ${JSON.stringify(data)}`);
    return new JSONResponse(data, { dynamic: true, status, headers });
  }
});
Server.zone('/manage', {
  perf: formatStats,
  headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
  async prepare($) {
    if ($.req.method[0] === 'P') {
      const h = $.req.headers.get('content-type');
      if (h && (h.startsWith('application/x-www-form-urlencoded') || h.startsWith('multipart/form-data'))) {
        if ($.req.headers.get('content-length') > 4 * 1024 * 1024) throw $.requestError(`Too much information`);
        $.requestIP;
        assignWeak($.params, await $.req.formData());
        if ($.params._uniqueFormKey) tblSentForms.add(+$.params._uniqueFormKey);
      }
    }

    assignWeak($.params, $.url.searchParams);
  },
  /** @param {Ctx} $ */
  finalize($, data, status, headers) {
    if (!data && $.signed) $.user;
    if ($.req.headers.has('X-Live-Update')) return new Response(null, { status: 404 });

    const u = $.__user && undoData.get($.__user.userKey);
    if (u) {
      $.toast(null, u.title,
        <Co.Link action="/manage/command/undo" good>Undo</Co.Link>,
        <Co.Link action="/manage/command/undo-close" data-live-apply="closeToast(this)">Close</Co.Link>);
    }

    const msg = $.cookies.get('postponedToasts');
    if (msg) {
      $.cookies.delete('postponedToasts');
      $.toast(msg);
    }

    return $.constructResponse(formatGenericPage($, data), headers, status);
  },
});

// Funny trick to be able to use CDN URLs seamlessly
export function resolveCDN(resourceURL) {
  const k = U`/cdn/${Bun.hash(resourceURL).toString(36)}${require('path').extname(resourceURL)}`;
  db.storage.set(`cdn:${k}`, resourceURL);
  return k;
};

Server.zone('/cdn', {
  ready: new Map(),
  reuser: new PromiseReuser(),
  async handle(req, url) {
    let data = this.ready.get(url.pathname);
    if (data == null) {
      const u = db.storage.get(`cdn:${url.pathname}`) || '';
      try {
        data = u ? await this.reuser.run(async () => {
          const local = Bun.file(`${AppSettings.core.cdnCacheDir}/${Bun.hash(u).toString(36)}${require('path').extname(u)}`);
          if (await local.exists()) return local.arrayBuffer();
          echo`Resolve CDN: _${u}`;
          const data = Bun.deflateSync(await (await fetch(u)).arrayBuffer());
          await Bun.write(local, data);
          return data;
        }, u) : '';
      } catch (e) {
        console.warn(`CDN resolve failure: ${e}`);
      }
      data = [data, { status: data ? 200 : 404, headers: { 'Content-Type': Bun.file(u).type, 'Cache-Control': 'max-age=604800, public', 'Content-Encoding': 'deflate' } }];
      this.ready.set(url.pathname, data);
    }
    return new Response(data[0], data[1]);
  }
});
