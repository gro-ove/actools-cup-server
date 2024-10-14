/** Plugin exporting CUP data to a remote server and listening to requests for incrementing counters from it. */

import { db, Hooks, pluginSettings, Server } from '../src/app';
import { Timer } from '../src/std';

const Settings = pluginSettings('cupExport', {
  itemsPerStep: 20,

  /** @type {(id: string, data: Buffer, url: string?) => Promise} */
  uploadEntry: null
}, s => ({
  itemsPerStep: s.itemsPerStep
}));
pluginSettings.require(Settings.uploadEntry);

const CUPUtils = (await import('./plugin-cup-core')).CUPUtils;

const tblSynced = db.table('p_cupdataSynced', { key: db.row.text({ primary: true }), hash: db.row.integer() }, { version: 1 });
const tblDirty = db.table('p_cupdataDirty', { key: db.row.text({ primary: true }) }, { version: 1 });

Hooks.register('plugin.admin.stats', fn => fn({
  ['CUP export']: {
    ['Synced entries']: db.query(`SELECT COUNT(*) as count FROM ${tblSynced}`).get().count,
    ['Awaiting upload']: db.query(`SELECT COUNT(*) as count FROM ${tblDirty}`).get().count,
  }
}));

function entryHash(data, updateUrl) {
  return Number((Bun.hash(updateUrl) * 397n) ^ Bun.hash(data));
}

async function uploadNextEntryAsync() {
  let upload = [], ret = null;
  {
    using w = db.write();
    for (const dirty of db.query(`SELECT * FROM ${tblDirty} LIMIT ${Settings.itemsPerStep * 2}`).all()) {
      ret = '1 s';
      const e = CUPUtils.getEntry(dirty.key);
      const newHash = e ? entryHash(e.value, e.url) : null;
      const curHash = db.query(`SELECT hash FROM ${tblSynced} WHERE key=?1`).get(dirty.key)?.hash;
      if (curHash == newHash) {
        w.query(`DELETE FROM ${tblDirty} WHERE key=?1`).run(dirty.key);
      } else if (upload.push({ key: dirty.key, data: e?.value, url: e?.url, hash: newHash }) === Settings.itemsPerStep) {
        break;
      }
    }
  }
  if (upload.length > 0) {
    await Settings.uploadEntry(upload);
    using w = db.write();
    for (const uploaded of upload) {
      w.query(`DELETE FROM ${tblDirty} WHERE key=?1`).run(uploaded.key);
      if (uploaded.hash != null) {
        w.query(`INSERT INTO ${tblSynced} (key, hash) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET hash=?2`).run(uploaded.key, uploaded.hash);
      } else {
        w.query(`DELETE FROM ${tblSynced} WHERE key=?1`).run(uploaded.key);
      }
    }
  }
  return ret;
}

const service = Timer.service('15 s', uploadNextEntryAsync, err => echo`Syncing exception: =${err}`);

Hooks.register('plugin.cup.update', ({ key }) => {
  db.query(`INSERT OR IGNORE INTO ${tblDirty} (key) VALUES (?1)`).run(key);
  service.poke();
});

Hooks.register('plugin.cup.reset', () => {
  using _ = db.write().start();
  tblDirty.clear();
  tblSynced.clear();
  Settings.uploadEntry([{ key: '~clear', data: null, url: null }]);
});

Server.put('/report/:', $ => {
  if (/^([^\/]+\/[^\/]+)\/([dc])\/.+$/.test($.params[''])) {
    const column = RegExp.$2 === 'd' ? 'countDownloads' : 'countComplains';
    const metadata = CUPUtils.getMetadata(RegExp.$1);
    if (metadata && $.incrementingCounter) {
      CUPUtils.incrementCounter(metadata.contentKey, column);
    }
  }
  return new Response('', { status: 204 });
});