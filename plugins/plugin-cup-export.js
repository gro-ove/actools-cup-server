/** Plugin exporting CUP data to a remote server and listening to requests for incrementing counters from it. */

import { ContentCategories, db, DBTbl, Hooks, pluginSettings, Server, Utils } from '../src/app';

const Settings = pluginSettings('cupExport', { 
  /** @type {(id: string, data: Buffer, url: string?) => Promise} */
  uploadEntry: null 
});
if (!Settings.uploadEntry) throw new Error(`Plugin is not configured`);

await import('./plugin-cup-core');
const cupIDToIndex = ContentCategories.reduce((p, v, k) => ((p[v.cupID] = k), p), {});

const tplSynced = db.table('p_cupdataSynced', { key: db.row.text({ primary: true }), hash: db.row.integer() });
const tplDirty = db.table('p_cupdataDirty', { key: db.row.text({ primary: true }), url: db.row.text({nullable: true}) });

Hooks.register('plugin.admin.stats', fn => fn({
  ['CUP export']: {
    ['Synced entries']: db.query(`SELECT COUNT(*) as count FROM ${tplSynced}`).get().count,
    ['Awaiting upload']: db.query(`SELECT COUNT(*) as count FROM ${tplDirty}`).get().count,
  }
}));

function entryHash(data, updateUrl) {
  return (Bun.hash(updateUrl) * 397n) ^ Bun.hash(data);
}

Hooks.register('plugin.cup.update', (file, data, updateUrl) => {
  db.query(`INSERT INTO ${tplSynced} (key, hash) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET hash=?2`).run(file, entryHash(data, updateUrl));
  db.query(`INSERT INTO ${tplDirty} (key, url) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET url=?2`).run(file, updateUrl);
}); 

Hooks.register('plugin.cup.update.same', (file, data, updateUrl) => {
  const r = db.query(`INSERT INTO ${tplSynced} (key, hash) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET hash=?2 WHERE hash!=?2`).run(file, entryHash(data, updateUrl));
  if (r.changes === 1) {
    console.log(`Sync fix: ${file}`);
    db.query(`INSERT INTO ${tplDirty} (key, url) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET url=?2`).run(file, updateUrl);
  }
});

Hooks.register('plugin.cup.update.gc', existing => {
  const files = db.query(`SELECT key FROM ${tplSynced} WHERE key!="~"`).all().filter(x => !existing.has(x.key)).map(x => x.key);
  for (const file of files) {
    db.query(`DELETE FROM ${tplSynced} WHERE key=?1`).run(file);
    db.query(`INSERT INTO ${tplDirty} (key, url) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET url=?2`).run(file, '~');
  }
});

async function uploadNextEntryAsync() { 
  try {
    const candidate = db.query(`DELETE FROM ${tplDirty} WHERE rowid = (SELECT rowid FROM ${tplDirty} LIMIT 1) RETURNING *`).get();
    if (candidate) {
      const data = Hooks.poll('plugin.cup.data', candidate.key);
      const url = candidate.url?.trim() || '';
      if (url === '' || /^https?:\/\/.+$/.test(url) || url === '~' && data == null) {
        await Settings.uploadEntry(candidate.key, data, data ? url : null);
        console.log(`Synced: ${candidate.key}`, new TextDecoder().decode(Bun.inflateSync(data)));
      } else {
        console.log(`Can’t be synced: ${candidate.key} (invalid URL)`);
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

Server.put('/report/:', $ => {
  if (/^([^\/]+)\/([^\/]+)\/([dc])\/.+$/.test($.params[''])){
    const category = cupIDToIndex[RegExp.$1], id = RegExp.$2, column = RegExp.$3 === 'd' ? 'countDownloads' : 'countComplains';
    if (Hooks.poll('plugin.cup.put', $.params[''])
      && db.query(`UPDATE ${DBTbl.Content} SET ${column}=CASE WHEN flagsDisabled==0 THEN ${column}+1 ELSE ${column} END WHERE categoryIndex=?1 AND contentID=?2`).run(category, id).changes === 0) {
      const parent = db.query(`SELECT contentKey FROM ${DBTbl.AlternativeIDs} WHERE categoryIndex=?1 AND contentID=?2`).get(category, id);
      if (parent) {
        db.query(`UPDATE ${DBTbl.Content} SET ${column}=CASE WHEN flagsDisabled==0 THEN ${column}+1 ELSE ${column} END WHERE contentKey=?1`).run(parent.contentKey);
      }
    }
  }
  return new Response('', {status: 204});
});