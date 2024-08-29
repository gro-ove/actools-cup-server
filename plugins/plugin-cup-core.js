/** Core plugin for public CUP API: stores data in CUP format in its own database, keeps track of recent counter increments. */

import { LazyMap, PerfCounter } from '../src/std';
import { ContentCategories, ContentUtils, db, DBTbl, DisabledFlag, Hooks, pluginSettings } from '../src/app';

const Settings = pluginSettings('cup', {
  dataRefresh: 3, // Check for changes and refresh publicly available data 
  reportCooldown: 30, // Download and complain counters won’t increment from the same user until cooldown is reached
}, s => ({ dataRefresh: s.dataRefresh, reportCooldown: s.reportCooldown }));

/**
 * Rules:
 * + Entries with no version set do not show up in the list
 * + Entries without updateUrl do not show up in the list unless limited
 * × Limited entries show up in the list only with informationUrl provided
 * + Disabled or blocked entries do not show up in the main list
 * + Flags `false`, empty lists or strings do not show up in the output
 */

const tplPuts = db.table('p_puts', {
  originKey: db.row.integer({ primary: true }),
  createdDate: db.row.integer({ default: db.value.now, index: true }),
});

const tblCupData = db.table('p_cupdata', {
  key: db.row.text({ primary: true }),
  value: db.row.text(),
});

const rebuildStats = new PerfCounter();

Hooks.register('plugin.admin.stats', fn => fn({
  ['CUP syncing']: rebuildStats
}));

Hooks.register('plugin.cup.put', key => key && db.query(`INSERT OR IGNORE INTO ${tplPuts} (originKey) VALUES (?)`).run(Number(Bun.hash(key))).changes === 1 ? key : null);
Hooks.register('plugin.cup.data', key => db.query(`SELECT value FROM p_cupdata WHERE key=?1`).get(key)?.value);

function dbUpdate(file, data, updateUrl) {
  const r = db.query(`INSERT INTO ${tblCupData} (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2 WHERE value!=?2`).run(file, Bun.deflateSync(JSON.stringify(data)));
  if (r.changes === 1) {
    // console.log(`Updated: ${file}`, data);
    Hooks.trigger('plugin.cup.update', file, data, updateUrl);
  } else {
    Hooks.trigger('plugin.cup.update.same', file, data, updateUrl);
  }
}

const invalidated = ContentCategories.map(() => new Map());
let listInvalidated = false;

Hooks.register('core.alteration', ({categoryIndex, contentKey, invalidateList}) => {
  // console.log(`Altered: ${categoryIndex}/${contentKey}${invalidateList ? ' (with list)' : ''}`);
  if (typeof contentKey !== 'number') throw new Error('Invalid alteration');
  invalidated[categoryIndex].set(contentKey, true);
  if (invalidateList) listInvalidated = true;
});

function rebuildList(existing) {
  const ret = {car: {}, track: {}};
  for (const e of db.query(`SELECT c.contentID AS contentID, c.categoryIndex AS categoryIndex, c.dataVersion AS dataVersion, c.flagLimited AS flagLimited, GROUP_CONCAT(a.contentID, "/") AS alternativeIds FROM ${DBTbl.Content} c LEFT JOIN ${DBTbl.AlternativeIDs} a ON a.contentKey=c.contentKey WHERE c.flagsDisabled=0 AND dataVersion IS NOT NULL GROUP BY c.contentKey ORDER BY c.contentID`).all()) {
    const c = ContentCategories[e.categoryIndex].cupID;
    const dst = ret[c] || (ret[c] = {});
    const v = e.flagLimited ? { version: e.dataVersion, limited: true } : e.dataVersion;
    dst[e.contentID] = v;
    existing.set(`${c}/${e.contentID}`, true);
    if (e.alternativeIds) {
      for (let a of e.alternativeIds.split('/')) {
        dst[a] = v;
        existing.set(`${c}/${a}`, true);
      }
    }
  }
  return ret;
}

function sync(first) {
  let count = first || listInvalidated ? 1 : 0;
  rebuildStats.start();

  db.transaction(() => {
    if (first || listInvalidated) {
      listInvalidated = false;
      const existing = new Map();
      dbUpdate('~', rebuildList(existing));

      const files = db.query(`SELECT key FROM ${tblCupData} WHERE key!="~"`).all().filter(x => !existing.has(x.key)).map(x => x.key);
      for (const file of files) {
        console.log(`No longer in CUP DB: ${file}`);
        db.query(`DELETE FROM ${tblCupData} WHERE key=?1`).run(file);
      }

      Hooks.trigger('plugin.cup.update.gc', existing);
    } 

    const defaultAuthorName = new LazyMap(userKey => JSON.parse(db.query(`SELECT userData FROM ${DBTbl.Users} WHERE userKey=?1`).get(userKey).userData).dataAuthor);  
    for (let categoryIndex = 0; categoryIndex < ContentCategories.length; ++categoryIndex) {
      for (const contentKey of first ? db.query(`SELECT contentKey FROM ${DBTbl.Content} WHERE categoryIndex=?1`).all(categoryIndex).map(x => x.contentKey) : invalidated[categoryIndex].keys()) {
        ++count;
        const entry = db.query(`SELECT userKey, dataName, dataAuthor, dataVersion, flagsDisabled, flagLimited, contentID, contentData FROM ${DBTbl.Content} WHERE contentKey=?1`).get(contentKey);
        if (entry == null || entry.flagsDisabled || !entry.dataVersion) {
          continue;
        }
        const altIDs = db.query(`SELECT contentID FROM ${DBTbl.AlternativeIDs} WHERE contentKey=?1`).all(contentKey).map(x => x.contentID);
        if (altIDs.some(x => !x)) {
          throw new Error(`Empty alternative ID: ${entry.contentID}, ${altIDs}`);
        }
        const contentData = JSON.parse(entry.contentData);
        const updateUrl = Hooks.poll('data.downloadURL.straighten', contentData.updateUrl) || ContentUtils.normalizeURL(contentData.updateUrl);
        const baseData = {
          name: entry.dataName || undefined,
          alternativeIds: altIDs.length > 0 ? altIDs : undefined,
          changelog: contentData.changelog || undefined,
          author: ContentUtils.normalizeAuthorName(entry.dataAuthor) || defaultAuthorName.get(entry.userKey) || undefined,
          informationUrl: ContentUtils.normalizeURL(contentData.informationUrl) || undefined,
          // _updateUrl: updateUrl,
          version: entry.dataVersion || undefined,
          active: !(entry.flagsDisabled & DisabledFlag.USER) || undefined,
          limited: (entry.flagLimited != 0) || undefined,
          cleanInstallation: contentData.cleanInstallation || undefined,
        };
        dbUpdate(`${ContentCategories[categoryIndex].cupID}/${entry.contentID}`, baseData, updateUrl);
        for (let a of altIDs) {
          baseData.alternativeIds = [entry.contentID, ...altIDs.filter(x => x !== a)];
          dbUpdate(`${ContentCategories[categoryIndex].cupID}/${a}`, baseData, updateUrl);
        }
      }
      invalidated[categoryIndex].clear();
    }
  })();
   
  if (count) {
    rebuildStats.consider(`${count} entries`);
  }
}

Hooks.register('core.started.async', () => {
  setTimeout(() => sync(true));
  setInterval(() => sync(false), Settings.dataRefresh * 1e3);
  setInterval(() => db.query(`DELETE FROM ${tplPuts} WHERE createdDate < ?1`).run(+new Date() / 1e3 - Settings.reportCooldown), Settings.reportCooldown * 250);
}, 1e9);

