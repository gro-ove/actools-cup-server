/** Main app state. Now packed into a single file to make it easier to add new plugins. */

import { BunJSX, ExtendedDatabase, LazyMap, Mediator, PerfCounter, PromiseReuser, Router } from './std';

// Some consts
export const AppSettings = {
  core: {
    dbFileName: ':memory:',
    dbVersion: 1,
    httpPort: 8080,
    passwordSalt: 'salt',
    monitorResources: false,
    cdnCacheDir: './res/cdn',
  },

  // Login and password for the main admin account (will be created if missing)
  // admin: {
  //   userID: 'admin',
  //   password: '1'
  // },

  // Delays in seconds
  periods: {
    undoLifespan: 4 * 60 * 60, // Time for which undo data is kept
    seenFor: 30, // Once seen, keep track of a user for this time
  },

  ownContacts: {
    mail: 'missing@example.com'
  },

  plugins: {
    active: []
  },
};

// Some basic helper functions.
export const Utils = {
  uid() { return require('crypto').randomBytes(16).toString('base64').replace(/^\d|\W/g, '').slice(0, 8) || 'wtf'; },
  inj(v) { return v; },
  idfy(value) { return value.toLowerCase().replace(/[^\w_. -]+/g, '').substring(0, 80); },
  titlefy(value) { return value && value.replace(/^./, _ => _.toUpperCase()); },
  plural(x, c) { return c === 1 ? x : x.endsWith('y') ? x.substring(0, x.length - 1) + 'ies' : x + 's' },
  deepAssign(t, s) { return s ? Object.entries(s).reduce((p, [k, v]) => ((p[k] = typeof v === 'object' && typeof p[k] === 'object' ? this.deepAssign(p[k], v) : v), p), t) : t; },

  age(days, short) {
    if (short) {
      if (days >= 356) return `${(days / 356).toFixed(1)} y`;
      if (days >= 1) return `${(days).toFixed(0)} d`;
      if (days >= 1 / 24) return `${(days * 24).toFixed(0)} h`;
      if (days >= 1 / (24 * 60)) return `${(days * (24 * 60)).toFixed(0)} min`;
      return `${(days * (24 * 60 * 60)).toFixed(0)} s`;
    }
    const p = (u, v) => v == 1 ? `1 ${u}` : `${v} ${u}s`;
    const d = v => v ? p('day', v) : '';
    if (days >= 356) return `${p('year', days / 365 | 0)} ${Utils.age(days % 356 | 0)}`.trim();
    if (days >= 30) return `${p('month', days / 30 | 0)} ${d(days % 30 | 0)}`.trim();
    if (days >= 7) return `${p('week', days / 7 | 0)} ${d(days % 7 | 0)}`.trim();
    if (days > 1) return p('day', days | 0);
    if (days > 1 / 24) return p('hour', days * 24 | 0);
    if (days > 1 / (24 * 60)) return p('minute', days * (24 * 60) | 0);
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

  bitFlag(flags, flag, condition) {
    return condition ? flags | flag : flags & ~flag;
  },

  async tryAsync(fn, tries, delayMs) {
    for (let i = 1; i < tries; ++i) {
      if (i > 1) await Bun.sleep(delayMs);
      try {
        return await fn(i === 1 ? '' : ` (attempt ${i}/${tries})`);
      } catch (e) {
        if (e instanceof RequestError) throw e;
        if (e && e.message === 'Try again' && tries < 6) ++tries;
        console.warn(e);
      }
    }
    return await fn(` (attempt ${tries}/${tries})`);
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
    processing: 'Entry is being processed now and will become available once ready',
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
    flagSearcheable: 'Allow users to find it if it’s not installed',
    flagOriginal: 'Please check only if model hasn’t been taken from a different videogame or something like that (applies to cars, tracks or showrooms)',
  }
}

// Typical user access permissions (plugin can add more permissions later)
export const Access = {
  EDIT: 1,
  VIEW: 2,
  BACKBLAZE: 64,
  FLAG_ORIGINAL: 128,
  FLAG_SEARCHEABLE: 256,
  MODERATE: 0x40000000,

  REGULAR: 1 | 2 | 128 | 256,
  ADMIN: -1,
};

// Extra details about permissions
export const AccessPermissions = [
  { id: 'edit', flag: Access.EDIT, hint: 'Edit and register new content' },
  { id: 'browse', flag: Access.VIEW },
  { id: 'original flag', flag: Access.FLAG_ORIGINAL, hint: 'Mark content AS original (please do not ports with this flag)' },
  { id: 'searcheable flag', flag: Access.FLAG_SEARCHEABLE, hint: 'Mark content AS appearing in search and other lists' },
  { id: 'direct uploads', flag: Access.BACKBLAZE, hint: 'Upload archives directly to CUP backend' },
  { id: 'moderate', flag: Access.MODERATE, hint: 'Do anything you want, really' },
];

// Extra details about permissions
export const AccessPermissionShortenings = {
  [Access.REGULAR]: [{ id: 'regular', hint: 'Regular access' }],
  [Access.ADMIN]: [{ id: 'admin', hint: 'Full unrestricted access' }],
};

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
  { id: 'python', cupID: 'app', maskID: 'p', name: 'Python app', title: 'Python app', portable: false, folder: true },
  { id: 'lua', cupID: 'lua', maskID: 'l', name: 'Lua app', title: 'Lua app', portable: false, folder: true },
];

// Hooks holder for server logic to allow plugins to alter the behavior
export const Hooks = new Mediator();

// Extra functions to deal with content
export const ContentUtils = {
  // Used on data export:
  normalizeURL(url) {
    if (!url) return null;
    url = url.trim();
    const v = this.verifyURL(url);
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
      const err = Hooks.poll('data.downloadURL.verify', contentData.updateUrl, content);
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
            errs.push('Content Manager can’t download from Patreon directly (set limited flag if the file is available only to subscribers)');
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
    $hook: (v, b) => {
      // BunJSX templates can easily trigger hook events
      if (typeof v === 'string') {
        Hooks.trigger(v, b, cur$);
      } else {
        for (const k in v) {
          Hooks.trigger(k, b, v[k], cur$);
        }
      }
    }
  }
});

// Core stuff to deal with databases
export const db = new ExtendedDatabase(AppSettings.core.dbFileName);
Utils.deepAssign(AppSettings, db.storage.get('adminSettings'));

/** @template {any} T @param {string} key @param {T} defaults @param {null|(data: T) => T} editable @return {T} */
export function pluginSettings(key, defaults, editable) {
  if (editable) {
    Hooks.register('core.adminSettings', cfg => Utils.deepAssign(cfg, { plugins: { [key]: editable(AppSettings.plugins[key]) } }));
  }
  return AppSettings.plugins[key] = Utils.deepAssign(defaults, AppSettings.plugins[key]);
}

// Main tables
export const DBTbl = {
  Users: Object.assign(db.table('t_users', {
    userKey: db.row.integer({ primary: true }),
    userID: db.row.text({ unique: true }),
    createdDate: db.row.integer({ default: db.value.now, index: true }),
    lastSeenDate: db.row.integer({ default: db.value.now, index: true }),
    password: db.row.text(),
    accessMask: db.row.integer(),
    allowedFilter: db.row.text({ nullable: true }),
    introduced: db.row.boolean({ default: false }),
    userData: db.row.text({ default: '{}' }),
  }, {
    order: `ORDER BY ?userID`,
    indices: [],
    upgrade: []
  }), {
    /** @type {(userKey: integer) => string?} */
    userID: LazyMap.prototype.get.bind(new LazyMap(userKey => db.query(`SELECT userID FROM t_users WHERE userKey=?1`).get(userKey)?.userID)),
    /** @type {(userID: string) => integer?} */
    userKey: LazyMap.prototype.get.bind(new LazyMap(userID => db.query(`SELECT userKey FROM t_users WHERE userID=?1`).get(userID)?.userKey)),
    /** @type {(login: string, pass: string) => string} */
    passEncode(login, pass) { return new Bun.CryptoHasher('sha256').update(AppSettings.core.passwordSalt).update(login).update(pass || '').digest('base64') },
  }),
  Content: Object.assign(db.table('t_content', {
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
  }), {
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
        Object.assign(refDetails, main, { userID: this.userID(main.userKey) });
      }
      throw new Error(`ID ${categoryIndex}/${contentID} is used`);
    },
  }),
  AlternativeIDs: db.table('t_alternativeIDs', {
    contentKey: db.row.integer({ index: true }),
    categoryIndex: db.row.integer(),
    contentID: db.row.text()
  }, {
    indices: [
      { columns: ['categoryIndex', 'contentID'], unique: true }, // ensuring uniqueness
    ],
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

// Changing of state for download URLs can affect content
Hooks.register('data.downloadURL.referencedURL', ({ key }) => {
  if (!/^c(\d+)$/.test(key)) return;
  const entry = db.query(`SELECT categoryIndex, contentID, dataName FROM ${DBTbl.Content} WHERE contentKey=?1`).get(+RegExp.$1 | 0);
  return entry && <Co.Link href={`/manage/${ContentCategories[entry.categoryIndex].id}/${entry.contentID}`}>{entry.dataName}</Co.Link>;
});

Hooks.register('data.downloadURL.state', ({ key, processing, errorMsg }) => {
  if (!/^c(\d+)$/.test(key)) return;
  const entry = db.query(`SELECT categoryIndex, contentKey, flagsDisabled, contentData FROM ${DBTbl.Content} WHERE contentKey=?1`).get(+RegExp.$1 | 0);
  if (!entry) return;
  const contentData = JSON.parse(entry.contentData);
  const newFlags = Utils.bitFlag(entry.flagsDisabled, DisabledFlag.PROCESSING, processing) | (errorMsg ? DisabledFlag.HIDDEN : 0);
  console.log(`  File state changed: ${newFlags} (${processing}, ${errorMsg})`);
  if (newFlags != entry.flagsDisabled || contentData.hiddenUpdateUrlReason != errorMsg) {
    contentData.hiddenUpdateUrlReason = errorMsg;
    db.query(`UPDATE ${DBTbl.Content} SET flagsDisabled=?2, contentData=?3 WHERE contentKey=?1`).run(entry.contentKey, newFlags, DBTbl.Content.encodeContentData(contentData));
    if ((newFlags !== 0) != (entry.flagsDisabled !== 0)) {
      Hooks.trigger('core.alteration', { categoryIndex: entry.categoryIndex, contentKey: entry.contentKey, invalidateList: true });
    }
  }
});

// An internal thingy to keep track of current request context within JSX and JSX components
let cur$;

// Helper class for endpoints given to them as request context, handles some common HTML templates.
const categoryIDToIndex = ContentCategories.reduce((p, v, k) => ((p[v.id] = k), p), {});

const undoData = new Map();
setInterval(() => Utils.filterMap(undoData, (k, v) => v.date > Date.now()), AppSettings.periods.undoLifespan * 100);

const recentlySeen = new Map();
setInterval(() => Utils.filterMap(recentlySeen, (k, v) => v > Date.now()), AppSettings.periods.seenFor * 100);

function conflictContactsMenu(userID, contentID) {
  const data = db.query(`SELECT userData FROM ${DBTbl.Users} WHERE userID=?1`).get(userID);
  if (data) {
    const parsed = JSON.parse(data.userData);
    return <Co.SocialLinks contacts={parsed.contacts} format={`Contact ${userID} via ?1…`} subject={`About ${contentID}`} />;
  }
}

const formatStats = new PerfCounter();

export class Ctx {
  /** @param {Request} req @param {import('url').Url} url @param {table<string, string>} params */
  constructor(req, url, params) {
    this.req = req;
    this.url = url;
    this.params = params;
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

  isUserOnline(userID) {
    return recentlySeen.has(userID);
  }

  requestError(message, ...hints) {
    return new RequestError(400, message, hints.length ? hints : [<Co.Link href="/manage">Go to the main page</Co.Link>]);
  }

  can(level = 1) {
    if (level && typeof level === 'object') return level.userKey === this.user.userKey && this.can(Access.EDIT) || this.can(Access.MODERATE);
    return level != null && (this.user.accessMask & level) !== 0;
  }

  writes(level = 1) {
    if (level == null) throw new RequestError(404);
    if (!this.can(level)) throw this.requestError('Permission denied');
  }

  /** @template {any} T @param {T} fields @return {T} */
  form(fields, ...fallback) {
    const f = Object.assign({}, fields, ...fallback);
    for (const key in fields) {
      if (typeof fields[key] !== 'object') {
        if (fields[key] != null) f[key] = fields[key];
        continue;
      }
      if (fields[key].type === 'TEXT' && this.params[`data-${key}`] != null) { f[key] = this.params[`data-${key}`] || null; }
      if (fields[key].type === 'INTEGER' && this.params[`data-${key}`] != null) { f[key] = +(this.params[`data-${key}`] || 0) | 0; }
      if (fields[key].type === 'BOOLEAN') { f[key] = this.params[`data-${key}`] === 'on'; }
    }
    return f;
  }

  verifyID(categoryIndex, contentID) {
    const args = {};
    if (contentID !== Utils.idfy(contentID)) {
      throw this.requestError('ID can only contain latin symbols, digits, “_”, “-“, “.“ or spaces',
        <Co.Link feedback={`I want to use ${ContentCategories[categoryIndex].id}/${contentID} as ID`}>Ask for a change of rules…</Co.Link>);
    }
    try {
      DBTbl.Content.verifyID(categoryIndex, contentID, args);
    } catch (e) {
      throw args.userID !== this.user.userID
        ? this.requestError(<>ID “{ContentCategories[categoryIndex].id}/{contentID}” is already used by <Co.UserURL userID={args.userID} /> and <a href={`/manage/${ContentCategories[categoryIndex].id}/${contentID}`}>has {args.countDownloads} {Utils.plural('download', args.countDownloads)}</a></>,
          <Co.Link feedback={`I want to register ${ContentCategories[categoryIndex].id}/${contentID}, but it’s currently taken by ${args.userID}`}>Request transfer…</Co.Link>,
          conflictContactsMenu(args.userID, contentID))
        : args.contentID ? this.requestError(<>You’re already using “{ContentCategories[categoryIndex].id}/{contentID}” as a secondary for {args.contentID}</>,
          <Co.Link href={`/manage/${ContentCategories[categoryIndex].id}/${args.contentID}`}>Edit {ContentCategories[categoryIndex].id}/{args.contentID}…</Co.Link>)
          : this.requestError(<>You’ve already registered “{ContentCategories[categoryIndex].id}/{contentID}”</>,
            <Co.Link href={`/manage/${ContentCategories[categoryIndex].id}/${args.contentID}`}>Edit {ContentCategories[categoryIndex].id}/{args.contentID}…</Co.Link>);
    }
    const allowedFilter = this.__allowedFilter || (this.__allowedFilter = db.query(`SELECT allowedFilter FROM ${DBTbl.Users} WHERE userKey = ?1`).get(this.user.userKey).allowedFilter);
    if (allowedFilter && !new RegExp(allowedFilter).test(`${ContentCategories[categoryIndex].maskID}:${contentID}`)) {
      throw this.requestError('Sorry, but currently you don’t have permission to use such ID',
        <Co.Link feedback={`I want to register ${ContentCategories[categoryIndex].id}/${contentID}`}>Request access…</Co.Link>);
    }
  }

  get id() {
    return this.__id ?? (this.__id = Utils.idfy(this.params.value) || 'unnamed');
  }

  get categoryIndex() {
    return categoryIDToIndex[this.params.categoryID];
  }

  get signed() {
    return this.req.headers.get('authorization') != null;
  }

  /** @returns {{userID: string, userKey: integer}} */
  get user() {
    if (!this.__user) {
      const auth = Buffer.from((this.req.headers.get('authorization') || '').split(' ', 2)[1] || '', 'base64').toString('utf-8').split(':');
      const user = db.query(`SELECT userKey, userID, createdDate, lastSeenDate, password, accessMask, allowedFilter, introduced FROM ${DBTbl.Users} WHERE userID=?1`).get(auth[0]);
      Hooks.trigger('core.user', user, this);
      if (!user || user.password !== DBTbl.Users.passEncode(auth[0], auth[1])) {
        this.header('WWW-Authenticate', 'Basic realm=manage, charset="UTF-8"');
        throw new RequestError(401, 'Unauthorized', <Co.Page title="Please authorize" center>
          <p>This web-panel allows content creators to register new updates for their mods for Assetto Corsa.</p>
          <p>If you want to access it, please contact us and we’ll create a profile for you. To speed things up, please list prefixes you are using for your folder names if any, or folder names of mods you wish to update.</p>
          <p>
            <Co.InlineMenu>
              <Co.Link href={this.req.url}>Try again</Co.Link>
              <Co.SocialLinks contacts={AppSettings.ownContacts} format="Contact via ?1…" subject="CUP invite" />
            </Co.InlineMenu>
          </p>
        </Co.Page>);
      } else if (!user.introduced && !this.url.pathname.startsWith('/manage/introduction')) {
        console.log(`Introducing: ${user.userID}`, this.url);
        this.header('Location', `/manage/introduction?redirect=${encodeURIComponent(`${this.url.pathname}${this.url.search}`)}`);
        throw new RequestError(302, 'Unintroduced', new BunJSX(''));
      } else {
        this.__user = user;
        recentlySeen.set(user.userID, Date.now() + AppSettings.periods.seenFor * 1e3);
        if (Date.now() > user.lastSeenDate * 1e3 + 10e3) {
          user.lastSeenDate = Date.now() / 1e3;
          db.query(`UPDATE ${DBTbl.Users} SET lastSeenDate=?2 WHERE userKey=?1`).run(user.userKey, +db.value.now);
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

  head(...items) {
    items.forEach(x => (this.__head || (this.__head = new Set())).add('' + <G>{x}</G>));
  }

  foot(...items) {
    items.forEach(x => (this.__foot || (this.__foot = new Set())).add('' + <G>{x}</G>));
  }

  header(key, value) {
    (this.__headers || (this.__headers = {}))[key] = value;
  }

  undo(title, cb) {
    const k = Utils.uid();
    undoData.set(k, { date: Date.now() + AppSettings.periods.undoLifespan * 1e3, url: this.params.location || this.req.headers.get('referrer') || this.url.pathname, cb });
    this.header('Set-Cookie', `UndoToken=${JSON.stringify(`${k}/${title}`)};  Max-Age:0; Path=/`);
  }

  processUndo(id) {
    const e = undoData.get(id);
    this.header('Set-Cookie', 'UndoToken=; Max-Age:0; Path=/');
    if (!e) throw this.requestError('Action to undo is gone, unfortunately you’ll have to revert changes manually');
    undoData.delete(id);
    db.transaction(() => e.url = e.cb(this) || e.url)();
    return e.url;
  }

  constructResponse(body, headers, status) {
    return typeof body === 'string' && body.length > 600 && this.req.headers.get('accept-encoding')?.indexOf('deflate') >= 0
      ? new Response(Bun.deflateSync(body), { status, headers: Object.assign({ 'Content-Encoding': 'deflate' }, headers) })
      : new Response(body, { status, headers });
  }

  /** @template {any} T @param {number} period @param {T} pieces @returns {T} */
  liveUpdating(period, ...pieces) {
    if (this.req.headers.get('X-Live-Update')) {
      throw this.constructResponse(pieces.join('\0'), { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' });
    }
    return pieces.map((x, i) => <div data-live-update={period}>{x}</div>);
  }
}

export const Co = {
  Page(props, body) {
    cur$.currentTitle = ('' + props.title).replace(/<.+?>/g, '');
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

  FormattedMessage(props, body) {
    if (!props.value) return null;
    let msg = props.value;
    if (props['single-line']) msg = msg.split('\n', 2)[0].trim() + '…';
    if (props['max-length'] && msg.length > props['max-length']) msg = msg.substring(0, props['max-length']) + '…';
    return msg ? new BunJSX(Bun.escapeHTML(msg)
      .replace(/\b(car|track|showroom|filter|python|lua|user) ([\w.-]+)\b/g, (_, c, i) => `<a href="/manage/${c}/${i}">${_}</a>`)
      .replace(/\bhttps?:\/\/\S+?(?=$| |[.,!?] )/g, _ => `<a href="${_}">${_}</a>`)) : null;
  },

  Date(props) {
    const d = new Date(props.value * 1e3);
    const y = Date.now() - +d;
    return <span data-timestamp-title={d.toISOString()}>{y < 15e3 ? 'now' : Utils.age(y / (24 * 60 * 60e3), props.short) + (props.short ? '' : ' ago')}</span>;
  },

  PermissionsList(props) {
    const list = props.short && AccessPermissionShortenings[props.value] || AccessPermissions.filter(x => x.hint && (x.flag & props.value) == x.flag);
    return new BunJSX(list.map(x => <Co.Value title={x.hint}>{x.id}</Co.Value>).join(', ')
      || `<span class="placeholder">&lt;none&gt;</span>`);
  },

  UserURL(props) {
    const id = props.userID || DBTbl.Users.userID(props.userKey);
    return <a href={`/manage/user/${id}`} data-selected={id === cur$.__user?.userID} data-online={!props['hide-online-mark'] && recentlySeen.has(id)}>{id}</a>;
  },

  Value(props, body) {
    const title = props.title ? Locale.hints[props.title] || props.title : null;
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
    Start(props) {
      return new BunJSX(props.autocomplete ? '<form method=POST autocomplete=on>' : '<form method=POST>');
    },
    End(props, body) {
      return new BunJSX(<input class="link good" type="submit" value={body} /> + `</form>`);
    },
  },

  Link(props, body) {
    const title = props.title ? Locale.hints[props.title] || props.title : null;
    if (props.action) {
      let url = props.action;
      const list = props.args && Object.entries(props.args).filter(([k, v]) => Array.isArray(v))[0];
      const args = props.args && Object.entries(props.args).map(([k, v]) => Array.isArray(v) ? null : <input type="hidden" name={k} value={v === 'current' && k === 'location' ? cur$.url.pathname : v === true ? '1' : v} />);
      if (list) {
        const k = Utils.uid();
        return <form action={url} method="POST" data-immediate data-live-apply={props['data-live-apply']}>
          <label class="inline" for={k}>{body}</label>
          <select id={k} name={list[0]}>{list[1].map(x => <option value={x.value} selected={!!x.selected}>{x.name}</option>)}</select>
          {args}
        </form>;
      }
      return <form action={url} method="POST" data-form={props.query} data-form-argument={props.default} data-live-apply={props['data-live-apply']}>
        {props.query ? <input type="hidden" name="value" /> : null}
        {args}
        <input type="submit" class="link" value={body} title={title} data-selected={props['data-selected']} />
      </form>;
    }

    const h = props.feedback
      ? Hooks.poll('core.feedbackURL', props.feedback) || `mailto:${AppSettings.ownContacts.mail}?subject=${encodeURIComponent(`CUP: ${props.feedback}`)}`
      : props.href;
    return h ? <a href={h} title={title} data-selected={h === cur$.url.pathname || props['data-selected']}>{body}</a> : body;
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
    if (props.accessMask) {
      return <li>
        <div class="checkboxes">
          <label class="for">{body}<input id="dummy" /></label>
          {AccessPermissions.map(x => <nobr><input id={`perm-${x.flag}`} name={`perm-${x.flag}`} type="checkbox" checked={(props.accessMask & x.flag) !== 0} /><label class="inline2" for={`perm-${x.flag}`}><span title={x.hint}>{x.id}</span></label></nobr>)}
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
      input = <input $attr={inh} type="checkbox" checked={data[key] == null ? props.default : !!data[key]} />;
    } else if (props.multiline) {
      input = <textarea $attr={inh}>{data[key]}</textarea>;
    } else if (props.options) {
      input = <><input $attr={inh} list={`list-${key}`} value={data[key]} /><datalist id={`list-${key}`}>{props.options.map(x => <option value={x}>{x}</option>)}</datalist></>;
    } else {
      input = <input $attr={inh} value={data[key]} />;
    }
    if (props.raw) throw new Error('unsupported');
    return <G $hook={props['input-hook']}><li class="row" title={props.hint || Locale.hints[key]}><label for={`data-${key}`}><span>{body}</span></label>{input}</li></G>;
  },

  Dropdown(props, body) {
    return <span class="dropdown">{Co.Link(props, props.label)}<div class="dropdown-content" data-dropdown-align-right={props['data-dropdown-align-right']}>{body}</div></span>;
  },
};

Hooks.register('core.tpl.userMenu', body => {
  if (!body.some(x => /data-selected/.test(x))) {
    body.filter(x => x.content).forEach(x => x.content = x.content.replace(/<a href="([^"]+)"/g, (_, u) => cur$.url.pathname.startsWith(u) ? `${_} data-selected` : _));
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

class Zone {
  constructor(prefix, params) {
    Object.assign(this, { __prefix: prefix }, params);
  }

  finalize($, data) {
    if (!data) return new Response(null, { status: 404 });
    throw new Error(`Zone “${this.__prefix}” without defined finalize function can’t handle raw responses`);
  }

  /** @param {Request} req @param {URL} url */
  async handle(req, url) {
    if (this.perf) this.perf.start();

    const params = {};
    const $ = new Ctx(req, url, params);
    if (this.prepare) await this.prepare($);

    cur$ = $;
    process.nextTick(() => cur$ = null);
    console.log(`Serving ${req.method} ${req.url}…`);

    let data;
    try {
      const found = router.get(req.method, url.pathname, params);
      if (found) {
        data = await found($);
      }
    } catch (e) {
      if (e instanceof Response) {
        return e;
      } else {
        collectError(e, $);
        if (e instanceof RequestError) {
        console.log(`  RequestError: ${e.code}`);
          data = e.code === 404 ? null : e;
        } else {
          console.warn(`  Error: ${e.stack || e}`);
          data = e
        }
      }
    }

    if (typeof data === 'string' && data.startsWith('/')) {
      console.log(`  Redirect: ${data}`);
      if ($.params.location) {
        data = $.params.location;
      } else {
        const r = redirects.get(data);
        if (r) data = r($);
      }
      if (data === url.pathname && req.method === 'GET') throw new Error(`Invalid redirect: ${data}`);
      data = new Response(null, { status: 302, headers: Object.assign({ 'Location': data }, $.__headers) });
    } else if (!(data instanceof Response)) {
      data = this.finalize($, data, data instanceof RequestError ? data.code : data instanceof Error ? 500 : data != null ? data === '' ? 204 : 200 : 404, this.headers ? $.__headers ? Object.assign($.__headers, this.headers) : this.headers : $.__headers);
    }

    if (this.perf) this.perf.consider(url.pathname);
    return data;
  }

  /** @return {Zone} */
  static find(path) {
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
  /** @param {($: Ctx) => string} callback */
  get(path, callback) { router.on('GET', path, callback); },
  /** @param {($: Ctx) => string} callback */
  post(path, callback) { router.on('POST', path, callback); },
  /** @param {($: Ctx) => string} callback */
  patch(path, callback) { router.on('PATCH', path, callback); },
  /** @param {($: Ctx) => string} callback */
  put(path, callback) { router.on('PUT', path, callback); },
  /** @param {($: Ctx) => string} callback */
  del(path, callback) { router.on('DELETE', path, callback); },
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
   * */
  zone(prefix, params) {
    const zone = new Zone(prefix, params);
    const k = prefix.charCodeAt(1) || 0;
    if (!zones.has(k)) zones.set(k, []);
    zones.get(k).push(zone);
  }
};

export async function appStart() {
  await Hooks.async('core.starting.async');
  Bun.serve({
    port: AppSettings.core.httpPort,
    async fetch(req) {
      const url = new URL(req.url);
      return Zone.find(url.pathname).handle(req, url);
    },
    error(error) {
      console.warn(error);
      collectError(error, null);
      return new Response(error, { status: 500, headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Connection': 'close' } });
    },
  });
  console.log(`Running server on :${AppSettings.core.httpPort} port`);
  await Hooks.async('core.started.async');
  if (AppSettings.admin && AppSettings.admin.userID
    && db.query(`SELECT COUNT(*) as count FROM ${DBTbl.Users} WHERE userID=?1`).get(AppSettings.admin.userID).count === 0) {
    const userKey = db.query(`INSERT INTO ${DBTbl.Users} (userID, password, accessMask, introduced) VALUES (?1, ?2, ?3, true);`).run(AppSettings.admin.userID, DBTbl.Users.passEncode(AppSettings.admin.userID, AppSettings.admin.password || ''), Access.ADMIN).lastInsertRowid;
    db.query(`INSERT INTO ${DBTbl.Groups} (userKey, groupID, name) VALUES (?1, ?2, ?3)`).run(userKey, 'main', 'Main');
  } else if (db.query(`SELECT COUNT(*) as count FROM ${DBTbl.Users} WHERE accessMask = ?1`).get(Access.ADMIN).count === 0) {
    console.warn(`No admin account detected, use configuration file to set credentials and restart the service.`);
  }
}

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
    header: user && user.introduced ? `<header><div class=header-right>${<Co.Dropdown href={`/manage/user/${user.userID}`} label={<G $hook="core.tpl.userMenu.header">👱 {user.userID}</G>} data-dropdown-align-right>
      <G $hook="core.tpl.userMenu">
        <Co.Link href={`/manage/user/${user.userID}`}>Your profile</Co.Link>
        <Co.Link href="/manage/group">Content groups</Co.Link>
      </G>
      <hr />
      <Co.Link action="/manage/command/logout">Log out</Co.Link>
    </Co.Dropdown>}</div>${<G $hook="core.tpl.header"><Co.InlineMenu>{$.groups.length === 1
      ? <Co.Link href={`/manage/group/${$.groups[0].groupID}`} data-selected={$.currentGroup != null}>Your content ({$.groups[0].count})</Co.Link>
      : $.groups.map(x => <Co.Link href={`/manage/group/${x.groupID}`} data-selected={$.currentGroup === x.groupID}>{x.name} ({x.count})</Co.Link>)
    }</Co.InlineMenu></G>}</header>` : '',
    body: data instanceof Error
      ? data instanceof RequestError
        ? data.options instanceof BunJSX
          ? data.options
          : <Co.Page title="Request error" center>
            <ul class="form">
              <h3>Couldn’t process the request:</h3>
              <li>{data.body}.</li>
              {data.options ? <><hr /><Co.InlineMenu>{data.options}</Co.InlineMenu></> : null}
            </ul>
          </Co.Page>
        : <Co.Page title="Server error" center>
          <p><pre>{('' + (data.stack || data.message)).replace(/\(\S+[/\\]([\w-]+)\.js\b/g, '($1')}</pre></p>
        </Co.Page>
      : data || <Co.Page title="Not found" center><p>Requested resource does not exist.</p></Co.Page>
  };
  Hooks.trigger('core.tpl.final', final, $, $.__user);
  return `<!DOCTYPE html><html><head><title>${final.title}</title><link rel="stylesheet" href="/res/style.css"/><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="shortcut icon" type="image/x-icon" href="/res/icon.ico" sizes="16x16"/><link rel="icon" type="image/x-icon" href="/res/icon.png" sizes="16x16"/><link rel="apple-touch-icon-precomposed" href="/res/icon.png"/>${$.__head ? [...$.__head.values()].join('') : ''}</head><body><noscript>Your browser does not support JavaScript, some features won’t function as intended.</noscript>${final.header}<main>${final.body}</main><div class=popup-bg></div><script src="/res/script.js"></script>${$.__foot ? [...$.__foot.values()].join('') : ''}</body></html>`;
}

// Three main zones: root, /api and /manage:
Server.zone('/', null);
Server.zone('/api', {
  headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
  finalize($, data, status, headers) {
    console.log(`API request: ${$.req.method} ${$.req.url} → ${JSON.stringify(data)}`);
    return new Response(JSON.stringify(data instanceof Error ? { error: data instanceof RequestError && data.message || data.code || data } : data), { status, headers });
  }
});
Server.zone('/manage', {
  perf: formatStats,
  headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
  async prepare($) {
    if ($.req.method[0] === 'P' && $.req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
      for (const [key, value] of await $.req.formData()) {
        if (!$.params[key]) $.params[key] = value;
      }
    }

    for (const [key, value] of $.url.searchParams) {
      if (!$.params[key]) $.params[key] = value;
    }

    const C = $.req.headers.get('cookie');
    if (C && /\bUndoToken="([^\/]+)\/([^"]+)"/.test(C) && !undoData.has(RegExp.$1)) {
      $.header('Set-Cookie', 'UndoToken=; Max-Age:0; Path=/');
    }
  },
  finalize($, data, status, headers) {
    if (!data && $.signed) $.user;
    return $.constructResponse(formatGenericPage($, data), headers, status);
  },
});

// Funny trick to be able to use CDN URLs seamlessly
export function resolveCDN(url) {
  const k = `/cdn/${Bun.hash(url).toString(36)}${require('path').extname(url)}`;
  db.storage.set(`cdn:${k}`, url);
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
          console.log(`Resolve CDN: ${u}`);
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
