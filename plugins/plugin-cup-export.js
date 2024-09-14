/** Plugin exporting CUP data to a remote server and listening to requests for incrementing counters from it. */

import { ContentCategories, db, DBTbl, Hooks, pluginSettings, Server } from '../src/app';

const Settings = pluginSettings('cupExport', {
  itemsPerStep: 20,

  /** @type {(id: string, data: Buffer, url: string?) => Promise} */
  uploadEntry: null
}, s => ({
  itemsPerStep: s.itemsPerStep
}));
if (!Settings.uploadEntry) throw new Error(`Plugin is not configured`);

await import('./plugin-cup-core');
const cupIDToIndex = ContentCategories.reduce((p, v, k) => ((p[v.cupID] = k), p), {});

const tblSynced = db.table('p_cupdataSynced', { key: db.row.text({ primary: true }), hash: db.row.integer() });
const tblDirty = db.table('p_cupdataDirty', { key: db.row.text({ primary: true }), url: db.row.text({ nullable: true }) });

Hooks.register('plugin.admin.stats', fn => fn({
  ['CUP export']: {
    ['Synced entries']: db.query(`SELECT COUNT(*) as count FROM ${tblSynced}`).get().count,
    ['Awaiting upload']: db.query(`SELECT COUNT(*) as count FROM ${tblDirty}`).get().count,
  }
}));

function entryHash(data, updateUrl) {
  return (Bun.hash(updateUrl) * 397n) ^ Bun.hash(data);
}

Hooks.register('plugin.cup.update', (file, data, updateUrl) => {
  using _ = db.write().start();
  db.query(`INSERT INTO ${tblSynced} (key, hash) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET hash=?2`).run(file, entryHash(data, updateUrl));
  db.query(`INSERT INTO ${tblDirty} (key, url) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET url=?2`).run(file, updateUrl);
});

Hooks.register('plugin.cup.update.same', (file, data, updateUrl) => {
  using _ = db.write().start();
  const r = db.query(`INSERT INTO ${tblSynced} (key, hash) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET hash=?2 WHERE hash!=?2`).run(file, entryHash(data, updateUrl));
  if (r.changes === 1) {
    console.log(`Sync fix: ${file}`);
    db.query(`INSERT INTO ${tblDirty} (key, url) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET url=?2`).run(file, updateUrl);
  }
});

Hooks.register('plugin.cup.update.gc', existing => {
  using _ = db.write().start();
  const files = db.query(`SELECT key FROM ${tblSynced} WHERE key!="~"`).all().filter(x => !existing.has(x.key)).map(x => x.key);
  for (const file of files) {
    db.query(`DELETE FROM ${tblSynced} WHERE key=?1`).run(file);
    db.query(`INSERT INTO ${tblDirty} (key, url) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET url=?2`).run(file, '~');
  }
});

async function uploadNextEntryAsync() {
  try {
    const candidates = db.query(`SELECT * FROM ${tblDirty} LIMIT ${Settings.itemsPerStep}`).all();
    if (candidates.length > 0) {
      const prepared = candidates.map(x => ({
        key: x.key,
        data: Hooks.poll('plugin.cup.data', x.key),
        url: x.url?.trim() || ''
      })).filter(x => {
        if (x.url === '' || /^https?:\/\/.+$/.test(x.url) || x.url === '~' && x.data == null) {
          return true;
        } else {
          console.log(`Can’t be synced: ${x.key} (invalid URL)`);
          return false;
        }
      });
      if (prepared.length > 0) {
        await Settings.uploadEntry(prepared);
        console.log(`Synced: ${prepared.map(x => x.key).join(', ')}`);
      }
      using _ = db.write().start();
      for (const candidate of candidates) {
        db.query(`DELETE FROM ${tblDirty} WHERE key=?1`).run(candidate.key);
      }
      setTimeout(uploadNextEntryAsync);
      return;
    }
  } catch (e) {
    console.log('Syncing exception', e.stack);
  }
  setTimeout(uploadNextEntryAsync, 5e3);
}

Hooks.register('core.started.async', () => {
  setTimeout(uploadNextEntryAsync, 1e3);
});

Hooks.register('plugin.cup.reset', () => {
  using _ = db.write().start();
  db.query(`DELETE FROM ${tblDirty}`).run();
  db.query(`DELETE FROM ${tblSynced}`).run();
  Settings.uploadEntry([{ key: '~clear', data: null, url: null }]);
});

Server.put('/report/:', $ => {
  if (/^([^\/]+)\/([^\/]+)\/([dc])\/.+$/.test($.params[''])) {
    const category = cupIDToIndex[RegExp.$1], id = RegExp.$2, column = RegExp.$3 === 'd' ? 'countDownloads' : 'countComplains';
    if (Hooks.poll('plugin.cup.put', $.params[''])
      && db.query(`UPDATE ${DBTbl.Content} SET ${column}=CASE WHEN flagsDisabled==0 THEN ${column}+1 ELSE ${column} END WHERE categoryIndex=?1 AND contentID=?2`).run(category, id).changes === 0) {
      const parent = db.query(`SELECT contentKey FROM ${DBTbl.AlternativeIDs} WHERE categoryIndex=?1 AND contentID=?2`).get(category, id);
      if (parent) {
        db.query(`UPDATE ${DBTbl.Content} SET ${column}=CASE WHEN flagsDisabled==0 THEN ${column}+1 ELSE ${column} END WHERE contentKey=?1`).run(parent.contentKey);
      }
    }
  }
  return new Response('', { status: 204 });
});