import { Co, Utils, Access, DBTbl, db, Hooks, Server, pluginSettings, RequestError, Ctx, AppSettings } from "../src/app";
import { fsExt, HistoryTracker, PerfCounter, Sqid, Timer } from "../src/std";

const fs = require('fs');
const crypto = require('crypto');

const Settings = pluginSettings('b2', {
  api: { applicationKeyId: '', applicationKey: '', bucketName: '' },
  bucketPrefix: 'c',
  caps: {
    fileSizeGB: 5,
    totalB2SizeGB: 1000,
    totalUploadSizeGB: 100,
    userB2SizeGB: 100,
    userUploadSizeGB: 10,
    totalB2Count: 10000,
    totalUploadCount: 1000,
    userB2Count: 1000,
    userUploadCount: 100,
  },
  parallelLimits: {
    b2: 1,
    totalUpload: 5,
    userUpload: 2,
  },
  lostAgeHrs: 12,
  chunkSizeUpload: 10 * 1024 * 1024,
  uploadDir: '/tmp',

  /** @type {(fileBaseName: string, uploadKey: string) => string} */
  buildDownloadURL: null // Files are uploaded with names in format `${Settings.bucketPrefix}/${fileBaseName}.${uploadKey}`
}, s => ({
  caps: s.caps,
  parallelLimits: s.parallelLimits,
  lostAgeHrs: s.lostAgeHrs,
  chunkSizeUpload: s.chunkSizeUpload,
}));
if (!Settings.api.applicationKeyId || !Settings.buildDownloadURL) throw new Error(`Plugin is not configured`);

const toGB = size => size / (1024 * 1024 * 1024);
const fromGB = size => size * (1024 * 1024 * 1024);

const perfGCLost = new PerfCounter();
const perfGCEmergency = new PerfCounter();
const perfGCTemporary = new PerfCounter();
const perfGCReferenceless = new PerfCounter();
const perfGCLargeFiles = new PerfCounter();
const perfGCRemoteB2 = new PerfCounter();
const perfGCRemoteB2LargeFiles = new PerfCounter();

class TransferCounter {
  constructor() {
    this.history = new HistoryTracker(16);
    this.active = [];
    this.totalMb = 0.1;
    this.totalS = 0.1;
  }

  start(context, size, left) {
    const that = this;
    const time = Bun.nanoseconds();
    const sizeMb = size / (1024 * 1024);
    const leftMb = left ? left / (1024 * 1024) : 0;
    const ret = {
      [Symbol.dispose]: () => {
        const i = this.active.indexOf(ret);
        return i !== -1 ? this.active.splice(i, 1) : null;
      },
      get approxETA() {
        const v = Math.max(1, (sizeMb + leftMb) / that.avgSpeedMbps - (Bun.nanoseconds() - time) / 1e9);
        return v < 1 || v > 1e9 ? '?' : v > 3600 ? `${(v / 3600).toFixed(1)} hrs` : v > 60 ? `${(v / 60).toFixed(1)} min` : `${v.toFixed(1)} s`;
      },
      complete() {
        if (!this[Symbol.dispose]()) return;
        const totalTimeS = (Bun.nanoseconds() - time) / 1e9;
        that.totalS += totalTimeS;
        that.totalMb += sizeMb;
        that.history.add(`${context}: ${sizeMb.toFixed(1)} MB, ${(sizeMb / totalTimeS).toFixed(2)} MB/s`);
      },
      toString() {
        return `${context}: ${sizeMb.toFixed(1)} MB, uploading for ${((Bun.nanoseconds() - time) / 1e9).toFixed(1)} s, ETA: ${this.approxETA}`;
      }
    };
    this.active.push(ret);
    return ret;
  }

  get avgSpeedMbps() {
    return this.totalMb / Math.max(0.01, this.totalS);
  }

  report() {
    return <>
      <ul class="details">
        <li>Average speed: {this.avgSpeedMbps.toFixed(2)} MB/s</li>
        <li>Total amount: {this.totalMb.toFixed(2)} MB</li>
        <li>Active uploads: {this.active.length}<ul>{this.active.map(x => <li>{x}</li>)}</ul></li>
        <li>Finished uploads: {this.history.count}<ul>{this.history.entries.map(x => <li>{x}</li>)}</ul></li>
      </ul>
    </>;
  }
}

const transferUploadCUP = new TransferCounter();
const transferUploadB2 = new TransferCounter();

const B2URL = {
  sid: new Sqid(Settings.urlKey),
  encode(id) { return `cup://b2/${this.sid.encode(id)}`; },
  decode(url) { return url?.startsWith('cup://b2/') ? this.sid.decode(url, 9) : null; },
};

function computeSHA1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

async function computeFileSHA1(...filename) {
  const hash = crypto.createHash('sha1').setEncoding('hex');
  for (const f of filename) {
    await new Promise((r, e) => fs.createReadStream(f).on('end', r).on('error', e).on('data', c => hash.update(c)));
  }
  hash.end();
  return hash.read();
}

async function mergeFiles(computeSHA1, destination, ...filename) {
  const hash = computeSHA1 && crypto.createHash('sha1').setEncoding('hex') || null;
  if (hash && await fs.promises.exists(destination)) {
    await new Promise((r, e) => fs.createReadStream(destination).on('end', r).on('error', e).on('data', c => hash.update(c)));
  }
  return new Promise((resolve, reject) => {
    const s = fs.createWriteStream(destination, { flags: 'a' });
    s.on('finish', hash ? () => {
      hash.end();
      resolve(hash.read());
    } : resolve);
    s.on('error', reject);
    (async () => {
      for (const f of filename) {
        const a = fs.createReadStream(f);
        await new Promise((r, e) => a.on('end', r).on('error', e).on('data', c => {
          if (hash) hash.update(c);
          if (!s.write(c)) {
            a.pause();
            s.once('drain', () => a.resume());
          }
        }));
      }
      s.end();
    })();
  });
}

fsExt.mkdirPSync(Settings.uploadDir);

const tblFiles = Object.assign(db.table('p_b2_files', {
  fileKey: db.row.integer({ primary: true }),
  fileSHA1: db.row.text({ unique: true }),
  backblazeData: db.row.text({ nullable: true }),
  createdDate: db.row.integer({ default: db.value.now, index: true }),
  fileSize: db.row.integer(),
  fileName: db.row.text(),
}), {
  /** @returns {true|false|null} */
  state(fileKey) {
    if (!fileKey) return null;
    const e = db.query(`SELECT backblazeData FROM ${this} WHERE fileKey=?1`).get(fileKey);
    return e ? e.backblazeData != null : null;
  },
});

const tblFileLinks = Object.assign(db.table('p_b2_fileLinks', {
  fileKey: db.row.integer({ index: true }),
  userKey: db.row.integer({ index: true }),
  referenceKey: db.row.text({ index: true }),
  referencedDate: db.row.integer({ default: db.value.now, index: true }),
}, {
  indices: [
    { columns: ['fileKey', 'userKey'] },
    { columns: ['fileKey', 'userKey', 'referenceKey'], unique: true },
  ]
}), {
  /** Returns number of non-temporary references. @returns {integer} */
  real(fileKey) {
    return db.query(`SELECT COUNT(*) AS count FROM ${this} WHERE fileKey=?1 AND referenceKey IS NOT 'temporary'`).get(fileKey).count;
  },
  refs(fileKey) {
    return db.query(`SELECT referenceKey FROM ${this} WHERE fileKey=?1 AND referenceKey IS NOT 'temporary'`).all(fileKey).map(x => x.referenceKey);
  },
  has(fileKey, userKey, referenceKey = null) {
    if (!fileKey) return false;
    return db.query(`SELECT referenceKey FROM ${this} WHERE fileKey=?1 AND userKey=?2 AND referenceKey=?3`).get(fileKey, userKey, referenceKey || 'temporary') != null;
  },
  ref(fileKey, userKey, referenceKey = null) {
    if (!fileKey) return;
    db.query(`INSERT INTO ${this} (fileKey, userKey, referenceKey) VALUES (?1, ?2, ?3)
      ON CONFLICT(fileKey, userKey, referenceKey) DO UPDATE SET referencedDate=?4`).run(fileKey, userKey, referenceKey || 'temporary', Math.floor(Date.now() / 1e3));
    if (referenceKey) {
      console.log(`New non-empty reference ${referenceKey} has been added, triggering upload…`);
      db.query(`DELETE FROM ${this} WHERE fileKey=?1 AND referenceKey='temporary'`).run(fileKey);
      B2Queue.ensureFileIsUploaded(fileKey);
    }
  },
  unref(fileKey, userKey, referenceKey = null) {
    if (!fileKey) return;
    if (userKey === null) {
      if (referenceKey !== null) throw new Error(`Only temporary references can be removed all at once`);
      db.query(`DELETE FROM ${this} WHERE fileKey=?1 AND referenceKey='temporary'`).run(fileKey);
    } else if (db.query(`DELETE FROM ${this} WHERE fileKey=?1 AND userKey=?2 AND referenceKey=?3`).run(fileKey, userKey, referenceKey || 'temporary').changes === 1 && referenceKey) {
      this.ref(fileKey, userKey);
    }
  },
  /** @return {{totalUploadSizeB: integer, totalB2SizeB: integer, totalUploadCount: integer, totalB2Count: integer, userUploadSizeB: integer, userB2SizeB: integer, userUploadCount: integer, userB2Count: integer}} */
  size(userKey) {
    return db.query(`SELECT 
      SUM(IIF(f.backblazeData IS NULL, f.fileSize, 0)) as totalUploadSizeB,
      SUM(IIF(f.backblazeData IS NOT NULL, f.fileSize, 0)) as totalB2SizeB,
      SUM(IIF(f.backblazeData IS NULL, 1, 0)) as totalUploadCount,
      SUM(IIF(f.backblazeData IS NOT NULL, 1, 0)) as totalB2Count,
      SUM(IIF(f.backblazeData IS NULL AND l.userKey=?1, f.fileSize, 0)) as userUploadSizeB,
      SUM(IIF(f.backblazeData IS NOT NULL AND l.userKey=?1, f.fileSize, 0)) as userB2SizeB,
      SUM(IIF(f.backblazeData IS NULL AND l.userKey=?1, 1, 0)) as userUploadCount,
      SUM(IIF(f.backblazeData IS NOT NULL AND l.userKey=?1, 1, 0)) as userB2Count
    FROM ${tblFiles} f
    LEFT JOIN ( SELECT DISTINCT fileKey, userKey FROM ${this} ) l ON f.fileKey = l.fileKey`).get(userKey);
  },
});

if (0) setTimeout(async () => {
  const i0 = tblFiles.insert({ fileSHA1: '1', backblazeData: 'null', createdDate: 123, fileSize: 100, fileName: '100 bytes' });
  const i1 = tblFiles.insert({ fileSHA1: '2', backblazeData: 'null', createdDate: 123, fileSize: 200, fileName: '200 bytes' });
  const i2 = tblFiles.insert({ fileSHA1: '3', backblazeData: 'null', createdDate: 123, fileSize: 30, fileName: '30 bytes' });
  const i3 = tblFiles.insert({ fileSHA1: '4', backblazeData: 'null', createdDate: 103, fileSize: 103, fileName: '30 bytes' });
  const i4 = tblFiles.insert({ fileSHA1: '5', backblazeData: 'null', createdDate: 103, fileSize: 103, fileName: '30 bytes' });
  tblFileLinks.insert({ fileKey: i0, userKey: 1, referenceKey: 'k', referencedDate: 1 });
  tblFileLinks.insert({ fileKey: i1, userKey: 2, referenceKey: 'k', referencedDate: 2 });
  // tblFileLinks.insert({fileKey: i0, userKey: 3, referenceKey: 'u3k', referencedDate: 3});
  tblFileLinks.insert({ fileKey: i1, userKey: 3, referenceKey: 'u3k', referencedDate: 3 });
  tblFileLinks.insert({ fileKey: i2, userKey: 3, referenceKey: 'u3k', referencedDate: 3 });
  tblFileLinks.insert({ fileKey: i2, userKey: 3, referenceKey: 'temporary', referencedDate: 15 });
  tblFileLinks.insert({ fileKey: i3, userKey: 3, referenceKey: 'temporary', referencedDate: 3 });
  tblFileLinks.insert({ fileKey: i4, userKey: 3, referenceKey: 'temporary', referencedDate: 3 });

  console.log(db.query(`SELECT 
    userKey,
    SUM(fileSize) AS totalFileSize
FROM (
    SELECT 
        l.userKey,
        f.fileSize
    FROM ${tblFileLinks} l
    JOIN ${tblFiles} f ON l.fileKey = f.fileKey
    WHERE l.referenceKey IS NOT 'temporary'
    GROUP BY l.userKey, l.fileKey
) AS uniqueFiles
GROUP BY userKey`).all(10));

  // const stat = await fetch('https://drive.google.com/uc?export=download&id=0B8YhXYiEI4WXOWhhajNNb1NsdXc');
  const stat = await fetch('https://cdn.discordapp.com/attachments/1071062868667150386/1077071636286689280/lm_chevrolet_corsa_ss.zip');
  console.log(stat);
}, 500);

Hooks.register('core.tpl.userMenu', (menu, $) => menu.push(<Co.Link href="/manage/file">{$.can(Access.MODERATE) ? 'Files' : 'Your files'}</Co.Link>), -0.5);

function getRefURL(key) {
  if (key === 'temporary') return 'temporary';
  return Hooks.poll('data.downloadURL.referencedURL', { key }) || `?${key}`;
}

Hooks.register('plugin.overview.stats', body => {
  const space = tblFileLinks.size(-1);
  body.push(<>
    <li>Total B2 storage: {(space.totalB2SizeB / (1024 * 1024)).toFixed(1)} MB ({space.totalB2Count} files)</li>
    <li>Total temporary storage: {(space.totalUploadSizeB / (1024 * 1024)).toFixed(1)} MB ({space.totalUploadCount} files)</li>
  </>);
});

Hooks.register('core.userStats', (body, { user }, $) => {
  if (!$.can(Access.MODERATE)) return;
  const space = tblFileLinks.size(user.userKey);
  body.push(<>
    <li>B2 storage: {(space.userB2SizeB / (1024 * 1024)).toFixed(1)} MB ({space.userB2Count} files)</li>
    <li>Temporary storage: {(space.userUploadSizeB / (1024 * 1024)).toFixed(1)} MB ({space.userUploadCount} files)</li>
  </>);
});

const tblB2CleanUp = Object.assign(db.table('p_b2_cleanup', {
  backblazeID: db.row.text({ primary: true }),
  backblazeName: db.row.text(),
}), {
  add(backblazeID, backblazeName) {
    db.query(`INSERT OR IGNORE INTO ${this} (backblazeID, backblazeName) VALUES (?1, ?2)`).run(backblazeID, backblazeName);
  },
  /** @return {{backblazeID: string, backblazeName: string}} */
  next() {
    return db.query(`SELECT backblazeID, backblazeName FROM ${this} LIMIT 1`).get();
  },
  done(backblazeID) {
    db.query(`DELETE FROM ${this} WHERE backblazeID=?1`).run(backblazeID);
  },
});

const tblCalls = Object.assign(db.table('p_b2_calls', {
  callKey: db.row.integer({ index: true }),
  createdDate: db.row.integer({ default: db.value.now, index: true }),
}), {
  register(call, limitPerHour) {
    const count = db.query(`SELECT COUNT(*) AS count FROM ${this} WHERE callKey=?1`).get(call).count;
    if (count > limitPerHour) throw new RequestError(429, `B2 overload with call “${call}”`);
    db.query(`INSERT INTO ${this} (callKey) VALUES (?1)`).run(call);
  }
});
setInterval(() => db.query(`DELETE FROM ${tblCalls} WHERE createdDate < ?1`).run(+new Date() / 1e3 - 3600), 60e3);

function updateContentState(fileKey, processing, errorMsg) {
  console.log(`B2: file ${fileKey} state changed (processing: ${processing}, error: ${errorMsg})`);
  for (const key of tblFileLinks.refs(fileKey)) {
    console.log(`  Referenced by ${fileKey}: ${key}`);
    Hooks.trigger('data.downloadURL.state', { key, processing, errorMsg });
  }
}

import { B2 } from './libs/b2';

Hooks.register('data.downloadURL.verify', url => {
  const key = B2URL.decode(url);
  return !key ? undefined : tblFiles.state(key) == null ? `Uknown file, please reupload` : null;
});

Hooks.register('data.downloadURL.straighten', url => {
  const key = B2URL.decode(url);
  const data = key && db.query(`SELECT backblazeData FROM ${tblFiles} WHERE fileKey=?1`).get(key)?.backblazeData;
  if (!data) return undefined;
  const parsed = JSON.parse(data);
  return Settings.buildDownloadURL(parsed.fileBaseName, parsed.uploadKey);
});

Hooks.register('data.downloadURL.change', args => {
  const keyPrevious = B2URL.decode(args.oldValue);
  let keyUpdated = B2URL.decode(args.newValue);
  const stateUpdated = tblFiles.state(keyUpdated);
  if (stateUpdated == null) keyUpdated = null;
  console.log(`B2URL download URL change: ${keyPrevious}→${keyUpdated}`);
  if (keyPrevious !== keyUpdated || keyUpdated && !tblFileLinks.has(keyUpdated, args.$.user.userKey, args.key)) {
    tblFileLinks.unref(keyPrevious, args.$.user.userKey, args.key);
    if (keyUpdated && !args.$.can(Access.BACKBLAZE)) {
      args.errorMsg = 'Direct URLs are not available at the moment';
      return;
    } else {
      tblFileLinks.ref(keyUpdated, args.$.user.userKey, args.key);
    }
  }
  if (stateUpdated === false) {
    args.processing = true;
    console.log(`Referenced file is not ready, triggering upload…`);
    B2Queue.ensureFileIsUploaded(keyUpdated);
  }
});

Hooks.register('core.tpl.content.uploadURL', (body, $) => {
  if (!$.can(Access.BACKBLAZE)) return;
  const uid = Utils.uid();
  $.foot(<>
    <script src="/res/script-plugin-b2.js" />
    <link rel="stylesheet" href="/res/style-plugin-b2.css" />
  </>);
  body[0].content = body[0].content.replace(/<input /, `<input data-b2-target=${JSON.stringify(uid)} `);
  body.splice(0, 0, <div style={{ display: "none" }} class="b2-file">
    <input data-b2-file={{ sizeCapGB: Settings.caps.fileSizeGB, chunkSizeUpload: Settings.chunkSizeUpload, target: uid }} type="file" />
  </div>);
});

const B2Provider = {
  /** @return {Promise<{instance: B2}>} */
  async grab(preferUnused) {
    const wrap = b2 => ({
      instance: b2,
      [Symbol.dispose]: () => {
        if (!b2 || !b2.ready) return;
        this.b2s.push(b2);
      }
    });

    /** @type {B2} */
    let b2;
    if (!this.b2s) {
      this.b2s = [];
      const stored = db.storage.get('plugin.b2');
      b2 = new B2(stored?.auth);
      if (stored?.bucketId) b2.setContext('bucketId', stored.bucketId);
    } else {
      if (preferUnused) {
        for (var i = 0; i < 10; ++i) {
          const popped = this.b2s.pop();
          if (popped) return wrap(popped);
          await Bun.sleep(5e3);
        }
      }

      b2 = this.b2s.pop() || new B2();
    }
    if (!b2.ready) {
      console.log(`Preparing a new B2 client…`);
      await Utils.tryAsync(async () => {
        tblCalls.register('authorize', 60);
        const auth = await b2.authorize(Settings.api);
        const ret = await b2.getBucket(Settings.api);
        db.storage.set('plugin.b2', { bucketId: ret.buckets[0].bucketId, auth });
        b2.setContext('bucketId', ret.buckets[0].bucketId);
        if (auth.recommendedPartSize != null) {
          console.log(`B2 upload chunk size: ${(auth.recommendedPartSize / (1024 * 1024)).toFixed(1)} MB`);
          db.storage.set('plugin.b2.recommendedPartSize', auth.recommendedPartSize);
        }
      }, 3, 1e3);
    }
    return wrap(b2);
  },
  get partSize() {
    return (db.storage.get('plugin.b2.recommendedPartSize') | 0) || 100 * 1024 * 1024;
  }
};

class HoldNotifier {
  constructor() {
    this.active = new Set();
  }

  hold(key) {
    if (this.active.has(key)) throw new Error(`State corruption`);
    this.active.add(key);
    return { [Symbol.dispose]: () => this.active.delete(key) };
  }

  held(key) {
    return this.active.has(key);
  }
}

const heldUploadChecksums = new HoldNotifier();
const heldLargeUploadIDs = new HoldNotifier();

const B2Queue = {
  uploading: new Map(),
  waiting: new Set(),

  report() {
    return {
      uploading: { ...this.uploading },
      waiting: [...this.waiting]
    };
  },

  status(fileKey) {
    if (this.waiting.has(fileKey)) return 'waiting';
    return this.uploading.get(fileKey)?.status;
  },

  async ensureFileIsUploaded(fileKey) {
    console.log(`Ensure file is uploaded: ${fileKey}`);
    if (this.uploading.has(fileKey) || this.waiting.has(fileKey)) return;

    const entry = tblFiles.get(fileKey);
    if (entry == null || entry.backblazeData) return;

    if (this.uploading.size >= Settings.parallelLimits.b2) {
      console.log(`Too many files uploading at once, postponing ${entry.fileName}`);
      this.waiting.add(fileKey);
      return;
    }

    console.log(`Starting to upload to Backblaze B2: ${fileKey} (${entry.fileName}, ${entry.fileSize} bytes)`);
    const uploading = { status: 'initializing' };
    this.uploading.set(fileKey, uploading);

    try {
      const userKey = db.query(`SELECT userKey FROM ${tblFileLinks} WHERE fileKey=?1`).get(fileKey)?.userKey;
      if (!userKey) throw new Error('No associated users');

      const tmpFile = Bun.file(`${Settings.uploadDir}/${entry.fileSHA1}`);
      using _hold = heldUploadChecksums.hold(entry.fileSHA1);
      if (!await tmpFile.exists()) throw new Error('Temporary data is missing, please reupload the file');
      if (tmpFile.size != entry.fileSize) throw new Error('File is damaged, size mismatch');

      console.log(`  File ${entry.fileName} is found and ready`);
      updateContentState(fileKey, true, null);

      uploading.status = 'connecting';
      using b2 = await B2Provider.grab();
      console.log(`  B2 provider for ${entry.fileName} is ready`);

      const uploadKey = B2URL.sid.encode(fileKey);
      const fileBaseName = `${DBTbl.Users.userID(userKey)}/${entry.fileName}`;

      let backblazeReply;
      if (entry.fileSize < B2Provider.partSize * 2) {
        backblazeReply = await Utils.tryAsync(async postfix => {
          console.log(`  New attempt${postfix}`);
          tblCalls.register('upload', 300 /* one upload every 12 seconds */);

          uploading.status = 'preparing to upload' + postfix;
          console.log(`  Getting upload URL${postfix}`);
          const url = await b2.instance.getUploadUrl();
          console.log(`  Upload URL for ${entry.fileName} is ready: ${url.uploadUrl}`);

          uploading.status = 'uploading' + postfix;
          using track = transferUploadB2.start(fileBaseName, entry.fileSize);
          using _timer = Timer.interval(500, () => uploading.status = `uploading${postfix}, ETA: ${track.approxETA}`);
          const ret = await b2.instance.uploadFile({
            uploadUrl: url.uploadUrl,
            uploadAuthToken: url.authorizationToken,
            fileName: `${Settings.bucketPrefix}/${fileBaseName}.${uploadKey}`,
            data: await tmpFile.arrayBuffer(),
            info: { file: fileKey, user: userKey },
          });
          track.complete();
          return ret;
        }, 2, 1e3);
      } else {
        const pieces = Math.max(2, Math.round(entry.fileSize / B2Provider.partSize));
        const pieceSize = Math.ceil(entry.fileSize / pieces);
        backblazeReply = await Utils.tryAsync(async postfix => {
          console.log(`  New large file attempt: ${pieces} pieces, ${(pieceSize / (1024 * 1024)).toFixed(1)} MB per piece${postfix}`);
          tblCalls.register('upload', 300 /* one upload every 12 seconds */);

          uploading.status = 'preparing to upload' + postfix;
          let fileId;
          {
            using _held = heldLargeUploadIDs.hold('');
            fileId = (await b2.instance.startLargeFile({ fileName: `${Settings.bucketPrefix}/${fileBaseName}.${uploadKey}` })).fileId;
          }
          using _held = heldLargeUploadIDs.hold(fileId);
          console.log(`  File ID: ${fileId}`);

          const partSha1Array = [];
          for (let i = 0; i < pieces; ++i) {
            await Utils.tryAsync(async postfix => {
              console.log(`  Uploading piece: ${i + 1}/${pieces}, new attempt${postfix}`);
              if (i === 0) uploading.status = `piece ${i + 1}/${pieces}${postfix}`;
              const chunk = await tmpFile.slice(i * pieceSize, (i + 1) * pieceSize).arrayBuffer();
              partSha1Array.push(computeSHA1(chunk));
              console.log(`    ${chunk.byteLength} bytes, SHA1: ${partSha1Array[partSha1Array.length - 1]})`);

              console.log(`  Getting upload URL ${i + 1}/${pieces}${postfix}`);
              const url = await b2.instance.getUploadPartUrl({ fileId });
              console.log(`  Upload URL for ${entry.fileName} (${i + 1}/${pieces}) is ready: ${url.uploadUrl}`);

              using track = transferUploadB2.start(fileBaseName, chunk.byteLength, Math.max(0, entry.fileSize - (i + 1) * pieceSize));
              using _timer = Timer.interval(500, () => uploading.status = `piece ${i + 1}/${pieces}${postfix}, ETA: ${track.approxETA}, speed: ${transferUploadB2.avgSpeedMbps.toFixed(1)} MB/s`);
              await b2.instance.uploadPart({
                partNumber: i + 1,
                uploadUrl: url.uploadUrl,
                uploadAuthToken: url.authorizationToken,
                data: chunk,
                sha1: partSha1Array[partSha1Array.length - 1]
              });
              track.complete();
            }, 2, 1e3);
          }

          uploading.status = 'finalizing upload' + postfix;
          return await b2.instance.finishLargeFile({ fileId, partSha1Array });
        }, 2, 1e3);
      }

      console.log(`  File ${entry.fileName} has been uploaded (file ID: ${backblazeReply.fileId})`);

      uploading.status = 'ready';
      db.transaction(() => {
        db.query(`UPDATE ${tblFiles} SET backblazeData=?2 WHERE fileKey=?1`).run(fileKey, JSON.stringify({
          fileBaseName, uploadKey, backblazeID: backblazeReply.fileId, backblazeName: backblazeReply.fileName
        }));
        tblFileLinks.unref(fileKey)
        updateContentState(fileKey, false, null);
      })();

      tryDelete(`${Settings.uploadDir}/${entry.fileSHA1}`);
    } catch (err) {
      console.log(`Failed to upload a file ${entry.fileName}: ${err.stack}`);
      db.transaction(() => {
        updateContentState(fileKey, false, '' + (err.message || err));
      })();
    }

    this.uploading.delete(fileKey);
    for (const waitingFileKey of this.waiting) {
      this.waiting.delete(waitingFileKey);
      return this.ensureFileIsUploaded(waitingFileKey);
    }
  }
};

function tryDelete(...filename) {
  return Promise.all(filename.map(x => {
    if (x.endsWith('*')) {
      return (async () => await tryDelete(...await Array.fromAsync(new Bun.Glob(x).scan())))();
    }
    return new Promise((resolve, reject) => {
      fs.unlink(x, err => {
        if (err && (!err.code || err.code !== 'ENOENT')) console.warn(`Failed to remove unnecessary file ${x}: ${err}`);
        resolve();
      });
    })
  }));
}

const tblLargeFiles = Object.assign(db.table('p_b2_largeFilesUpload', {
  fileChecksum: db.row.text({ primary: true }),
  chunkSize: db.row.integer(),
  chunks: db.row.text(),
  referencedDate: db.row.integer({ default: db.value.now }),
}), {
  has(checksum) {
    return db.query(`SELECT fileChecksum FROM ${this} WHERE fileChecksum=?1`).get(checksum) != null;
  },
  /** @param {FileCtx} f$ @return {{chunkSize: integer, chunks: string[]}} */
  get(f$) {
    const r = db.query(`UPDATE ${this} SET referencedDate=?2 WHERE fileChecksum=?1 RETURNING *`).get(f$.checksum, +db.value.now);
    if (r) return { chunkSize: r.chunkSize, chunks: JSON.parse(r.chunks) };
    tblCalls.register('largeFile', 120 /* one new large file every 30 seconds */);
    const chunksTotal = Math.max(2, Math.round(f$.size / Settings.chunkSizeUpload));
    const chunkSize = Math.ceil(f$.size / chunksTotal);
    const created = { chunkSize, chunks: new Array(chunksTotal).fill('') };
    console.log(`New large file entry: ${f$.name}, ${chunksTotal} chunks, each chunk is ${chunkSize} bytes`);
    db.query(`INSERT INTO ${this} (fileChecksum, chunkSize, chunks) VALUES (?1, ?2, ?3)`).run(f$.checksum, chunkSize, JSON.stringify(created.chunks));
    return created;
  },
  update(f$, chunks) {
    db.query(`UPDATE ${this} SET referencedDate=?2, chunks=?3 WHERE fileChecksum=?1`).get(f$.checksum, +db.value.now, JSON.stringify(chunks));
  },
  remove(checksum) {
    return db.query(`DELETE FROM ${this} WHERE fileChecksum=?1`).run(checksum).changes !== 0;
  },
});

if (AppSettings.core.dbFileName === ':memory:') {
  await tryDelete(`${Settings.uploadDir}/*`);
}

// console.log((await Bun.file('bun.lockb').slice(0, 1024).arrayBuffer()).byteLength)
// await Bun.sleep(1e9);

const B2GC = {
  async purge(file, tag) {
    if (Array.isArray(file)) return Promise.all(file.map(x => this.purge(x, tag)));
    if (file && typeof file === 'object' && file.fileSHA1) return this.purge(file.fileSHA1, tag);
    try {
      const fileInfo = db.query(`SELECT fileKey, backblazeData FROM ${tblFiles} WHERE fileSHA1=?1`).get(file);
      if (fileInfo) {
        db.transaction(() => {
          db.query(`DELETE FROM ${tblFiles} WHERE fileKey=?1`).run(fileInfo.fileKey);
          db.query(`DELETE FROM ${tblFileLinks} WHERE fileKey=?1`).run(fileInfo.fileKey);
          if (fileInfo.backblazeData) {
            const data = JSON.stringify(fileInfo.backblazeData);
            tblB2CleanUp.add(data.backblazeID, data.backblazeName);
          }
        })();
      }
      await tryDelete(`${Settings.uploadDir}/${file}*`);
      console.log(`File ${file} (${tag}) deleted`);
    } catch (e) {
      console.warn(`Error when deleting ${file} (${tag}): ${e.stack || e}`);
    }
  },

  // Not enough space to store a temporary upload, let’s see if we can nuke some other temporary files
  async forceUserCleanUp(userKey, fileSHA1, requiredSpaceB, requiredCount) {
    perfGCEmergency.start();
    try {
      // Select all file entries that are not referenced by non-temporary links or other users, not uploaded to B2 and do not match uploaded file, ordered from oldest referenced to newest
      const temporaryUserFiles = db.query(`SELECT l.fileKey, f.fileSize, f.fileSHA1
        FROM ${tblFileLinks} l
        JOIN ${tblFiles} f ON l.fileKey = f.fileKey
        WHERE l.userKey = ?1 AND f.backblazeData IS NULL AND f.fileSHA1 != ?2
        AND l.fileKey NOT IN (
          SELECT fileKey
          FROM ${tblFileLinks}
          WHERE userKey != ?1 OR referenceKey IS NOT 'temporary'
        )
        ORDER BY l.referencedDate`).all(userKey, fileSHA1);
      let collected = 0;
      console.log(`Emergency GC (required to remove ${requiredSpaceB} bytes, ${requiredCount} files):`, temporaryUserFiles);
      for (var i = 0; i < temporaryUserFiles.length; ++i) {
        collected += temporaryUserFiles[i].fileSize;
        if (collected >= requiredSpaceB && i + 1 >= requiredCount) {
          console.log(`Emergency GC: freeing ${collected} bytes, ${i + 1} files`);
          await this.purge(temporaryUserFiles.slice(0, i + 1), 'emergency GC');
          return true;
        }
      }
      return false;
    } finally {
      perfGCEmergency.consider(`Needed ${Math.max(0, requiredSpaceB)} bytes and ${Math.max(0, requiredCount)} slots`);
    }
  },

  // Main GC step 
  async stepMain() {
    // Removing temporary links older than configured number of hours
    perfGCTemporary.start();
    const refsRemoved = db.query(`DELETE FROM ${tblFileLinks} WHERE referenceKey IS 'temporary' AND referencedDate < ?1`)
      .run(+db.value.now - Settings.lostAgeHrs * 60 * 60).changes;
    perfGCTemporary.consider(`${refsRemoved} rows`);

    // Removing files without references
    perfGCReferenceless.start();
    const toCollect = db.query(`SELECT fileSHA1 FROM ${tblFiles}
      WHERE fileKey NOT IN ( SELECT DISTINCT fileKey FROM ${tblFileLinks} )`).all();
    await this.purge(toCollect);
    perfGCReferenceless.consider(`${toCollect.length} files`);

    // Removing large files that weren’t touched for awhile
    perfGCLargeFiles.start();
    const largeFilesRemoved = db.query(`DELETE FROM ${tblLargeFiles} WHERE referencedDate < ?1`)
      .run(+db.value.now - Settings.lostAgeHrs * 60 * 60).changes;
    perfGCLargeFiles.consider(`${largeFilesRemoved} rows`);

    setTimeout(() => this.stepMain(), 30 * 60e3);
  },

  // Just in case there are some random files in B2 temporary dir that are not in the database
  async stepLost() {
    perfGCLost.start();
    let count = 0;
    try {
      for (const file of await fs.promises.readdir(Settings.uploadDir)) {
        ++count;
        const sha1 = /^[a-f0-9]{40}\b/.test(file) ? RegExp['$&'] : null;
        if (!sha1) {
          console.warn(`Unexpected item in the bagging area: ${file}`);
          continue;
        }
        const ageMs = new Date() - (await fs.promises.stat(`${Settings.uploadDir}/${file}`)).mtime;
        if (ageMs > 3.6e6
          && db.query(`SELECT COUNT(*) AS count FROM ${tblFiles} WHERE fileSHA1=?1`).get(file).count === 0
          && !tblLargeFiles.has(sha1)
          && !heldUploadChecksums.held(sha1)) {
          this.purge(file, 'lost');
        }
        await Bun.sleep(1e3);
      }
    } catch (e) {
      console.warn(`Error when cleaning lost files: ${e.stack || e}`);
    }
    perfGCLost.consider(`${count} files tested`);
    setTimeout(() => this.stepLost(), 5 * 60 * 60e3);
  },

  // Iterate over files in the B2 bucket, collect file IDs of files not referenced in our DBs
  async stepRemoteB2() {
    if (!heldLargeUploadIDs.held('')) {
      perfGCRemoteB2LargeFiles.start();
      try {
        using b2 = await B2Provider.grab(true);
        const data = await b2.instance.listUnfinishedLargeFiles({ namePrefix: Settings.bucketPrefix });
        for (const entry of data.files) {
          if (!heldLargeUploadIDs.held(entry.fileId)) {
            console.log(`Unfinished B2 file: ${entry.fileName}`);
            await b2.instance.cancelLargeFile(entry);
            await Bun.sleep(1e3);
          }
        }
        perfGCRemoteB2LargeFiles.consider();
      } catch (e) {
        console.warn(e);
      }
    }

    perfGCRemoteB2.start();
    try {
      const filesPerStep = 100;
      let stepsLeft = Settings.caps.totalB2Count / filesPerStep + 10;
      let seenSHAs = new Set();
      let repeats = 0;
      async function step(startFileName) {
        if (--stepsLeft < 0) throw new Error('Sanity exit');

        const data = await (async () => {
          using b2 = await B2Provider.grab(true);
          return await b2.instance.listFileNames({ prefix: Settings.bucketPrefix, maxFileCount: filesPerStep, startFileName });
        })();

        if (Array.isArray(data.files)) {
          for (const entry of data.files) {
            if (!seenSHAs.has(entry.contentSha1)) {
              seenSHAs.add(entry.contentSha1);
              if (db.query(`SELECT COUNT(*) AS count FROM ${tblFiles} WHERE fileSHA1=?1`).get(entry.contentSha1).count === 0) {
                console.log(`B2 file not present in DB: ${entry.fileName}`);
                tblB2CleanUp.add(entry.fileId, entry.fileName);
              } else {
                console.log(`B2 file present in DB: ${entry.fileName}`);
              }
            } else if (++repeats) {
              throw new Error(`Too many repeats: ${entry.contentSha1}`);
            }
          }
        }
        if (data.nextFileName) {
          await Bun.sleep(5e3);

          // Using async/await should prevent stack overflow
          await step(data.nextFileName);
        }
      }
      await step();
      perfGCRemoteB2.consider(`${seenSHAs.size} files checked`);
    } catch (e) {
      console.warn(e);
    }
    setTimeout(() => this.stepRemoteB2(), 3 * 60 * 60e3);
  },

  async stepB2FilePop() {
    const entry = tblB2CleanUp.next();
    if (entry) {
      using b2 = await B2Provider.grab(true);
      try {
        await b2.instance.deleteFileVersion({ fileId: entry.backblazeID, fileName: entry.backblazeName });
        tblB2CleanUp.done(entry.backblazeID);
        console.log(`Removed ${entry.backblazeName} (${entry.backblazeID}) from B2 storage`);
      } catch (e) {
        console.warn(`Failed to delete file ${entry.backblazeName} (${entry.backblazeID}) from B2 storage: ${e}`);
      }
    }
    setTimeout(() => this.stepB2FilePop(), entry ? 1e3 : 60e3);
  },
};

setTimeout(() => B2GC.stepLost(), 5e3);
setTimeout(() => B2GC.stepMain(), 5 * 60e3);
B2Provider.grab().then(async r => {
  r[Symbol.dispose]();
  setTimeout(() => B2GC.stepRemoteB2(), 1e3);
  setTimeout(() => B2GC.stepB2FilePop(), 15e3);
});

if (process.argv.includes('--test')) {
  Server.get('/manage/tool/upload-b2', $ => {
    $.writes(Access.BACKBLAZE);
    return <Co.Page title="B2 Test">
      <p>Links: <pre>{JSON.stringify(
        db.query(`SELECT * FROM ${tblFileLinks} WHERE userKey=?1`).all($.user.userKey)
      )}</pre></p>
      <p>Stats: <pre>{JSON.stringify(
        db.query(`SELECT COUNT(*) as count, SUM(f.fileSize) as totalSize FROM ${tblFileLinks} l LEFT JOIN ${tblFiles} f ON f.fileKey=l.fileKey WHERE l.userKey=?1 GROUP BY l.fileKey`).get($.user.userKey)
      )}</pre></p>
      <form method="POST">
        <input type="file" name="input_file" value="FILE" />
        <button onclick="uploadB2File(this);return false">Upload file</button>
        <hr />
        <output value="Select file and start upload…" />
        <meter max={1} min={0} value={0} />
      </form>
    </Co.Page>
  });

  Server.post('/api/plugin-b2/command/test-upload', async $ => {
    const data = await $.req.arrayBuffer();
    require('fs').writeFileSync('D:/test.dds', data);
    return { 'done': data.byteLength, url: `dummy://${data.byteLength}b` };
  });
}

let totalCurrentlyUploading = 0;
const currentlyUploadingPerUser = new Map();
const currentlyUploadingChecksums = new Set();

class FileCtx {
  /** @param {Ctx} $ */
  constructor($, checksum) {
    $.writes(Access.BACKBLAZE);
    this.$ = $;

    this.checksum = '' + checksum;
    if (!/^[\da-f]{40}$/.test(this.checksum)) throw new RequestError(400, 'Malformed request');

    if (totalCurrentlyUploading >= Settings.parallelLimits.totalUpload
      || currentlyUploadingChecksums.has(this.checksum)
      || (currentlyUploadingPerUser.get(this.$.user.userKey) || 0) >= Settings.parallelLimits.userUpload) {
      throw new RequestError(409, 'Too many files uploading at once, try again later');
    }
    currentlyUploadingPerUser.set(this.$.user.userKey, (currentlyUploadingPerUser.get(this.$.user.userKey) || 0) + 1);
    currentlyUploadingChecksums.add(this.checksum);
    ++totalCurrentlyUploading;
  }

  [Symbol.dispose]() {
    currentlyUploadingPerUser.set(this.$.user.userKey, (currentlyUploadingPerUser.get(this.$.user.userKey) || 0) - 1);
    currentlyUploadingChecksums.delete(this.checksum);
    --totalCurrentlyUploading;
  }

  async init(name, size) {
    const existingFile = db.query(`SELECT fileName, fileSize, fileKey, backblazeData FROM ${tblFiles} WHERE fileSHA1=?1`).get(this.checksum);
    if (existingFile) {
      this.fileKey = existingFile.fileKey;
      if (this.size != null && +this.size !== existingFile.fileSize) throw new RequestError(400, 'Unexpected file size value');
      this.name = existingFile.fileName;
      this.size = existingFile.fileSize;
    } else {
      this.name = name?.replace(/[^a-z0-9!~_.-]/ig, '').substring(0, 64);
      this.size = size | 0;
      if (!this.name || !this.size) {
        throw new RequestError(400, 'Malformed request');
      }

      await this.verifyFileSize(this.size);
      this.fileKey = db.query(`INSERT INTO ${tblFiles} (fileSHA1, fileName, fileSize) VALUES (?1, ?2, ?3)`)
        .run(this.checksum, this.name, this.size).lastInsertRowid;
    }

    this.nameMain = `${Settings.uploadDir}/${this.checksum}`;
    this.needsUploading = (!existingFile || !existingFile.backblazeData) && !await fs.promises.exists(this.nameMain);

    console.log(`Posting ${existingFile ? 'existing' : 'new'} file (${this.$.url.pathname}): ${this.name} (${this.checksum}), ${this.size} bytes, needs uploading: ${this.needsUploading}`);
    tblFileLinks.ref(this.fileKey, this.$.user.userKey);
  }

  async verifyFileSize(size) {
    const fileSizeGB = toGB(size);
    if (size < 10 || fileSizeGB > Settings.caps.fileSizeGB) {
      throw new RequestError(406, size < 10 ? 'Empty files are not allowed' : 'File size exceeds expected boundaries');
    }

    {
      let space = tblFileLinks.size(this.$.user.userKey);
      if (toGB(space.totalUploadSizeB) + fileSizeGB > Settings.caps.totalUploadSizeGB
        || space.totalUploadCount + 1 > Settings.caps.totalUploadCount) {
        throw new RequestError(409, 'Too many pending files, try again later');
      }

      if (toGB(space.userUploadSizeB) + fileSizeGB > Settings.caps.userUploadSizeGB
        || space.userUploadCount + 1 > Settings.caps.userUploadCount) {
        if (await B2GC.forceUserCleanUp(this.$.user.userKey, fileChecksum,
          space.userUploadSizeB + fromGB(fileSizeGB) - fromGB(Settings.caps.userUploadSizeGB),
          space.userUploadCount + 1 - Settings.caps.userUploadCount)) {
          space = tblFileLinks.size(this.$.user.userKey);
        }
        if (toGB(space.userUploadSizeB) + fileSizeGB > Settings.caps.userUploadSizeGB
          || space.userUploadCount + 1 > Settings.caps.userUploadCount) {
          throw new RequestError(409, 'Too many pending files for your account, try again later');
        }
      }

      if (toGB(space.totalB2SizeB) + fileSizeGB > Settings.caps.totalB2SizeGB
        || space.totalB2Count + 1 > Settings.caps.totalB2Count) {
        throw new RequestError(409, 'Too many uploaded files, try again later');
      }

      if (toGB(space.userB2SizeB) + fileSizeGB > Settings.caps.userB2SizeGB
        || space.userB2Count + 1 > Settings.caps.userB2Count) {
        throw new RequestError(409, 'Too many uploaded files for your account, try again later');
      }
    }
  }

  async promoteFileUpload(nameTmp, checksumVerified) {
    if (checksumVerified || await computeFileSHA1(nameTmp) === this.checksum) {
      await tryDelete(this.nameMain);
      await fs.promises.rename(nameTmp, this.nameMain);
    } else {
      tryDelete(nameTmp);
      throw new RequestError(400, 'Checksums mismatch');
    }
    console.log(`  Loaded and verified file: ${this.nameMain} (exists: ${fs.existsSync(this.nameMain)})`);
    console.log(`  File size: ${fs.statSync(this.nameMain).size} bytes`);
  }

  uploadPiece(postfix) {
    const destination = `${this.nameMain}-${postfix != null ? postfix : Utils.uid()}.tmp`;
    return {
      destination,
      [Symbol.dispose]: () => tryDelete(destination)
    };
  }
}

Server.post('/api/plugin-b2/file', async $ => {
  using f$ = new FileCtx($, $.req.headers.get('x-file-checksum'))
  await f$.init($.req.headers.get('x-file-name'), $.req.headers.get('content-length'));
  if (f$.needsUploading) {
    using piece = f$.uploadPiece();
    console.log(`  Storing file as ${piece.destination}…`);
    {
      using track = transferUploadCUP.start(f$.name, f$.size);
      await Bun.write(Bun.file(piece.destination), $.req);
      track.complete();
    }
    await f$.promoteFileUpload(piece.destination);
  }
  return { url: B2URL.encode(f$.fileKey) };
});

Server.del('/api/plugin-b2/large-file', async $ => {
  using f$ = new FileCtx($, $.req.headers.get('x-file-checksum'));
  if (tblLargeFiles.remove(f$.checksum)) {
    const existingFile = db.query(`SELECT * FROM ${tblFiles} WHERE fileSHA1=?1`).get(this.checksum);
    if (existingFile != null) {
      B2GC.purge(existingFile);
    }
  }
});

Server.post('/api/plugin-b2/large-file', async $ => {
  // For sending a chunk, only checksum is needed, but sending all three means upload can restart if it has been broken for some reason
  using f$ = new FileCtx($, $.req.headers.get('x-file-checksum'));
  await f$.init($.req.headers.get('x-file-name'), $.req.headers.get('x-file-size'));
  if (!f$.needsUploading) return { url: B2URL.encode(f$.fileKey) };

  let args = tblLargeFiles.get(f$);
  if ($.req.headers.has('x-chunk-index')) {
    const pieceIndex = $.req.headers.get('x-chunk-index') | 0;
    const sentSize = $.req.headers.get('content-length') | 0;
    if (pieceIndex < 0 || pieceIndex >= args.chunks.length) throw new RequestError(400, 'Incorrect chunk index');
    if (!args.chunks[pieceIndex]) {
      const expectedSize = pieceIndex === args.chunks.length - 1 ? f$.size - (args.chunks.length - 1) * args.chunkSize : args.chunkSize;
      if (expectedSize !== sentSize) throw new RequestError(406, `Wrong chunk size (expected ${expectedSize}, got ${sentSize})`);

      using piece = f$.uploadPiece(pieceIndex);
      console.log(`  Storing chunk ${pieceIndex + 1}/${args.chunks.length} of file ${f$.name} as ${piece.destination}…`);
      {
        using track = transferUploadCUP.start(`${f$.name} (${pieceIndex + 1}/${args.chunks.length})`, f$.size);
        await Bun.write(Bun.file(piece.destination), $.req);
        track.complete();
      }
      const moved = piece.destination.replace(/\.tmp$/, '') + '.chunk';
      await fs.promises.rename(piece.destination, moved);
      console.log(`  Chunk ${pieceIndex + 1}/${args.chunks.length} is moving to ${moved}…`);
      args.chunks[pieceIndex] = moved;
      tblLargeFiles.update(f$, args.chunks);
      if (args.chunks.every(Boolean)) {
        using _cleanUp = {
          [Symbol.dispose]: () => {
            tryDelete(...args.chunks);
            tblLargeFiles.remove(f$.checksum);
          }
        };
        const finalChecksum = await mergeFiles(true, args.chunks[0], ...args.chunks.slice(1));
        if (finalChecksum === f$.checksum) {
          console.log(`  Multi-part finished and verified: ${finalChecksum}`);
          await f$.promoteFileUpload(args.chunks[0], true);
        } else {
          console.log(`  Multi-part checksum mismatch: ${finalChecksum}≠${f$.checksum}`);
          throw new RequestError(400, 'Checksums mismatch');
        }
        return { url: B2URL.encode(f$.fileKey) };
      }
    }
  }

  return { total: args.chunks.length, next: args.chunks.map((x, i) => !x && i).filter(x => x !== false)[0], chunk: args.chunkSize };
});

Server.get('/api/plugin-b2/file/:url', $ => {
  const file = tblFiles.get(B2URL.decode($.params.url));
  return file && {
    status: file.backblazeData ? 'ready' : B2Queue.status(file.fileKey) || 'limbo',
    size: file.fileSize,
    name: file.fileName,
    created: file.createdDate
  };
});

Server.get('/download/b2/:key', $ => {
  const key = B2URL.sid.decode($.params.key);
  const data = key && db.query(`SELECT backblazeData FROM ${tblFiles} WHERE fileKey=?1`).get(key)?.backblazeData;
  if (!data) return null;
  const parsed = JSON.parse(data);
  return new Response(null, { status: 302, headers: { 'Location': Settings.buildDownloadURL(parsed.fileBaseName, parsed.uploadKey) } });
});

function fileStatus(x) {
  if (x.backblazeData) return 'Ready';
  return `Processing: ${B2Queue.status(x.fileKey) || 'limbo'}`;
}

Hooks.register('plugin.overview.user.content', (body, { user }, $) => {
  if (!$.can(Access.MODERATE)) return;
  const files = db.query(`SELECT * FROM ${tblFiles} WHERE fileKey IN (SELECT fileKey FROM ${tblFileLinks} WHERE userKey=?1)`).all(user.userKey);
  const refs = db.query(`SELECT * FROM ${tblFileLinks} WHERE userKey=?1`).all(user.userKey);
  body.push(<>
    <h3>Files</h3>
    <table>
      <tr>
        <th onclick="reorder(this)">Name</th>
        <th onclick="reorder(this)">Size (MB)</th>
        <th onclick="reorder(this)">Uploaded</th>
        <th onclick="reorder(this)">Status</th>
        <th onclick="reorder(this)">Referenced by…</th>
      </tr>
      {files.map(x => <tr data-search={x.fileName} data-disabled={!x.backblazeData}>
        <td>{x.fileName}</td>
        <td>{(x.fileSize / (1024 * 1024)).toFixed(1)}</td>
        <td><Co.Date short value={x.createdDate} /></td>
        <td>{fileStatus(x)}</td>
        <td><Co.Value placeholder="none">{[[...new Set(refs.map(y => y.fileKey == x.fileKey && getRefURL(y.referenceKey)).filter(Boolean))].sort().map(x => <>{x}</>).join(', ')]}</Co.Value></td>
      </tr>)}
    </table>
  </>);
});

Server.post('/manage/command/file-purge-temporary', async $ => {
  const entry = tblFiles.get($.params.fileKey);
  if (!entry) return null;
  if (entry.backblazeData) throw new RequestError(400, `Can’t purge finalized file`);
  if (B2Queue.status(entry.fileKey)) throw new RequestError(400, `Can’t purge uploading file`);
  const importantLinks = db.query(`SELECT fileKey FROM ${tblFileLinks} WHERE fileKey=?1 AND ( userKey != ?2 OR referenceKey IS NOT 'temporary' )`).get(entry.fileKey, $.user.userKey);
  if (importantLinks) throw new RequestError(400, `Can’t purge non-temporary file`);
  B2GC.purge(entry);
  return '/manage/file';
});

Server.get('/manage/file', $ => {
  const files = $.can(Access.MODERATE)
    ? db.query(`SELECT * FROM ${tblFiles} WHERE fileKey IN (SELECT fileKey FROM ${tblFileLinks})`).all()
    : db.query(`SELECT * FROM ${tblFiles} WHERE fileKey IN (SELECT fileKey FROM ${tblFileLinks} WHERE userKey=?1)`).all($.user.userKey);
  const refs = $.can(Access.MODERATE)
    ? db.query(`SELECT * FROM ${tblFileLinks}`).all()
    : db.query(`SELECT * FROM ${tblFileLinks} WHERE userKey=?1`).all($.user.userKey);
  const space = tblFileLinks.size($.user.userKey);
  const importantLinks = db.query(`SELECT fileKey FROM ${tblFileLinks} WHERE userKey != ?1 OR referenceKey IS NOT 'temporary'`).all($.user.userKey);

  return <Co.Page title="Files" search>
    <table>
      <tr>
        <th onclick="reorder(this)">Name</th>
        <th onclick="reorder(this)">Size (MB)</th>
        <th onclick="reorder(this)">Uploaded</th>
        <th onclick="reorder(this)">Status</th>
        <th onclick="reorder(this)">Referenced by…</th>
      </tr>
      {files.map(x => <tr data-search={x.fileName} data-disabled={!x.backblazeData}>
        <td>{x.fileName}</td>
        <td>{(x.fileSize / (1024 * 1024)).toFixed(1)}</td>
        <td><Co.Date short value={x.createdDate} /></td>
        <td>{fileStatus(x)}</td>
        <td>{x.backblazeData == null && !importantLinks.some(y => y.fileKey) && !B2Queue.status(x.fileKey)
          ? <Co.Link action="/manage/command/file-purge-temporary" args={{ fileKey: x.fileKey }} title="This file is only referenced by you and is in a temporary state, click to purge it completely">temporary (purge)</Co.Link>
          : <Co.Value placeholder="none">{[[...new Set(refs.map(y => y.fileKey == x.fileKey && getRefURL(y.referenceKey)).filter(Boolean))].sort().map(x => <>{x}</>).join(', ')]}</Co.Value>}</td>
      </tr>)}
    </table>
    <hr />
    <ul class="form">
      {$.can(Access.MODERATE) ? <>
        <li>Total B2 storage: {(space.totalB2SizeB / (1024 * 1024)).toFixed(1)} MB ({space.totalB2Count} files)</li>
        <li>Total temporary storage: {(space.totalUploadSizeB / (1024 * 1024)).toFixed(1)} MB ({space.totalUploadCount} files)</li>
      </> : null}
      <li>Your B2 storage: {(space.userB2SizeB / (1024 * 1024)).toFixed(1)} MB ({space.userB2Count} files)</li>
      <li>Your temporary storage: {(space.userUploadSizeB / (1024 * 1024)).toFixed(1)} MB ({space.userUploadCount} files)</li>
    </ul>
  </Co.Page>;
});

Hooks.register('plugin.overview.users.table', (o, users) => {
  const m = new Map();
  for (const r of db.query(`SELECT userKey, SUM(fileSize) AS totalFileSize FROM (
    SELECT l.userKey, f.fileSize FROM ${tblFileLinks} l
    JOIN ${tblFiles} f ON l.fileKey = f.fileKey WHERE l.referenceKey IS NOT 'temporary' GROUP BY l.userKey, l.fileKey
  ) AS uniqueFiles GROUP BY userKey`).all()) {
    m.set(r.userKey, r.totalFileSize);
  }
  o['Direct'] = u => <Co.Value placeholder="none">{m.has(u.userKey) ? `${(m.get(u.userKey) / (1024 * 1024)).toFixed(1)} MB` : null}</Co.Value>;
});

Hooks.register('plugin.admin.stats', fn => {
  const space = tblFileLinks.size(-1);
  fn({
    ['B2']: {
      ['Active uploads']: <Co.Value title={[...currentlyUploadingPerUser.entries()].map(([k, v]) => `${k}: ${v}`).join('\n') || 'No uploads'}>{totalCurrentlyUploading}</Co.Value>,
      ['Active B2 uploads']: B2Queue.uploading.size,
      ['Enqueued B2 uploads']: B2Queue.waiting.size,
      ['Space']: {
        ['B2']: `${toGB(space.totalB2SizeB || 0).toFixed(2)} GB (${space.totalB2Count || 0} files)`,
        ['Uploading']: `${toGB(space.totalUploadSizeB || 0).toFixed(2)} GB (${space.totalUploadCount || 0} files)`,
      },
      ['Upload (CUP)']: transferUploadCUP.report(),
      ['Upload (B2)']: transferUploadB2.report(),
      ['GC (lost)']: perfGCLost,
      ['GC (emergency)']: perfGCEmergency,
      ['GC (temporary)']: perfGCTemporary,
      ['GC (referenceless)']: perfGCReferenceless,
      ['GC (large files)']: perfGCLargeFiles,
      ['GC (remote)']: perfGCRemoteB2,
      ['GC (remote large files)']: perfGCRemoteB2LargeFiles,
    }
  })
}, 1e9);

setTimeout(async () => {
  for (const entry of db.query(`SELECT fileKey, fileSHA1, fileName FROM ${tblFiles} WHERE backblazeData IS NULL`).all()) {
    console.log(entry.fileName, tblFileLinks.real(entry.fileKey));
    if (tblFileLinks.real(entry.fileKey) > 0
      && await fs.promises.exists(`${Settings.uploadDir}/${entry.fileSHA1}`)
      && await computeFileSHA1(`${Settings.uploadDir}/${entry.fileSHA1}`) === entry.fileSHA1) {
      console.log(`Fixing file in limbo state: ${entry.fileName}`);
      B2Queue.ensureFileIsUploaded(entry.fileKey);
    }
  }
}, 1e3);
