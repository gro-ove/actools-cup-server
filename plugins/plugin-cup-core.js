/** Core plugin for public CUP API: stores data in CUP format in its own database, keeps track of recent counter increments. */

import { LazyMap, PerfCounter, Timer } from '../src/std';
import { Access, Co, ContentCategories, ContentUtils, db, DBTbl, DisabledFlag, Hooks, pluginSettings, Server } from '../src/app';

const Settings = pluginSettings('cup', {
  dataRefresh: '5s', // Check for changes and refresh publicly available data 
}, s => ({ dataRefresh: s.dataRefresh }));

/**
 * Rules:
 * + Entries with no version set do not show up in the list
 * + Entries without updateUrl do not show up in the list unless limited
 * × Limited entries show up in the list only with informationUrl provided
 * + Disabled or blocked entries do not show up in the main list
 * + Flags `false`, empty lists or strings do not show up in the output
 */

const tblCupData = db.table('p_cupdata', {
  key: db.row.text({ primary: true }),
  value: db.row.text(),
  url: db.row.text({ nullable: true }),
  contentKey: db.row.integer({ index: true }),
}, { version: 3 }).extend(tbl => {
  const pInsert = db.bound(`INSERT INTO ${tbl} (key, value, url, contentKey) VALUES (?1, ?2, ?3, ?4) 
    ON CONFLICT(key) DO UPDATE SET value=?2, url=?3, contentKey=?4 WHERE value!=?2 OR url!=?3 OR contentKey!=?4`,
    (s, key, data, url, contentKey) => s.run(key, data, url, contentKey).changes !== 0);
  return {
    getData: db.bound(`SELECT value FROM ${tbl} WHERE key=?1`, (s, key) => s.get(key)?.value),
    getMetadata: tbl.pget(['contentKey', 'url'], 'key'),
    getEntry: tbl.pget(['value', 'url'], 'key'),
    setEntry(contentKey, key, dataObject, updateURL) {
      key = key?.toLowerCase();
      const deflated = Bun.deflateSync(JSON.stringify(dataObject));
      if (pInsert(key, deflated, updateURL, contentKey)) {
        Hooks.trigger('plugin.cup.update', { key, data: deflated, updateURL });
      }
    },
    dropEntry(key) {
      key = key?.toLowerCase();
      if (tbl.delete(key) !== 0){
        Hooks.trigger('plugin.cup.update', { key });
      }
    }
  }
});

export const CUPUtils = {
  /** @param {'countDownloads'|'countComplains'} countColumn */
  incrementCounter(contentKey, countColumn) {
    db.query(`UPDATE ${DBTbl.Content} SET ${countColumn}=${countColumn}+1 WHERE contentKey=?1`).run(contentKey);
  },

  getMetadata: key => tblCupData.getMetadata(key?.toLowerCase()),
  getData: key => tblCupData.getData(key?.toLowerCase()),
  getEntry: key => tblCupData.getEntry(key?.toLowerCase()),
};

Hooks.register('plugin.admin.tpl.toolsList', body => {
  body.push(<Co.Link action='/manage/cup/tool/cup-reset'>Reset CUP syncing</Co.Link>);
});

Server.post('/manage/cup/tool/cup-reset', $ => {
  $.writes(Access.ADMIN);
  Hooks.trigger('plugin.cup.reset');
  return `/manage/cup/tool`;
});

const rebuildStats = new PerfCounter();
Hooks.register('plugin.admin.stats', fn => fn({ ['CUP syncing']: rebuildStats }));

const invalidated = ContentCategories.map(() => new Set());
let listInvalidated = false;

Hooks.register('core.alteration', ({ categoryIndex, contentKey, invalidateList }) => {
  if (typeof contentKey !== 'number') throw new Error('Invalid alteration');
  invalidated[categoryIndex].add(contentKey);
  if (invalidateList) listInvalidated = true;
});

function rebuildList(present) {
  const searchAllIndex = { 'base': {}, 'limited': {} };
  const searchOriginalIndex = { 'base': {}, 'limited': {} };
  const updateIndex = { car: {}, track: {} };
  for (const e of db.query(`SELECT contentKey, contentID, categoryIndex, dataVersion, flagLimited, flagSearcheable, flagOriginal FROM ${DBTbl.Content} WHERE flagsDisabled=0`).all()) {
    const IDs = [e.contentID, ...DBTbl.AlternativeIDs.byContentKey(e.contentKey).map(x => x.contentID)];
    const cupID = ContentCategories[e.categoryIndex].cupID;
    if (e.dataVersion) {
      const updateEntry = e.flagLimited ? { version: e.dataVersion, limited: true } : e.dataVersion;
      const updateDst = updateIndex[cupID] || (updateIndex[cupID] = {});
      for (let a of IDs) {
        updateDst[a] = updateEntry;
      }
    }
    if (e.flagSearcheable && (e.categoryIndex === 0 || e.categoryIndex === 1)) {
      const searchCategory = e.flagLimited ? searchAllIndex.limited : searchAllIndex.base;
      (searchCategory[cupID] || (searchCategory[cupID] = [])).push(...IDs);
      if (e.flagOriginal) {
        const searchCategory = e.flagLimited ? searchOriginalIndex.limited : searchOriginalIndex.base;
        (searchCategory[cupID] || (searchCategory[cupID] = [])).push(...IDs);
      }
    }
    if (e.dataVersion || e.flagSearcheable) {
      for (let a of IDs) {
        present.add(`${cupID}/${a}`);
      }
    }
  }
  tblCupData.setEntry(0, '', updateIndex);
  tblCupData.setEntry(0, 'index/all', searchAllIndex);
  tblCupData.setEntry(0, 'index/original', searchOriginalIndex);
}

function sync(first) {
  let count = 0;
  rebuildStats.start();

  {
    using _ = db.write().start();
    let present;
    if (first || listInvalidated) {
      ++count;
      listInvalidated = false;

      present = new Set();
      rebuildList(present);

      for (const file of db.query(`SELECT key FROM ${tblCupData} WHERE contentKey!=0`).all()) {
        if (!present.has(file.key)) {
          echo`No longer in CUP DB: _${file.key}`;
          tblCupData.dropEntry(file.key);
        }
      }
    }

    const defaultAuthorName = new LazyMap(userKey => JSON.parse(db.query(`SELECT userData FROM ${DBTbl.Users} WHERE userKey=?1`).get(userKey).userData).dataAuthor);
    for (let categoryIndex = 0; categoryIndex < ContentCategories.length; ++categoryIndex) {
      for (const contentKey of first
        ? db.query(`SELECT contentKey FROM ${DBTbl.Content} WHERE categoryIndex=?1`).all(categoryIndex).map(x => x.contentKey)
        : invalidated[categoryIndex].values()) {
        ++count;
        const entry = db.query(`SELECT userKey, dataName, dataAuthor, dataVersion, flagsDisabled, flagLimited, flagSearcheable, contentID, contentData FROM ${DBTbl.Content} WHERE contentKey=?1`).get(contentKey);
        if (entry == null || entry.flagsDisabled || !entry.dataVersion && !entry.flagSearcheable) {
          continue;
        }

        const cupID = ContentCategories[categoryIndex].cupID;
        if (present && !present.has(`${cupID}/${entry.contentID}`)) {
          echo`# Data corruption: _${cupID}/_${entry.contentID}`;
        }

        const altIDs = DBTbl.AlternativeIDs.byContentKey(contentKey).map(x => x.contentID);
        if (altIDs.some(x => !x)) {
          throw new Error(`Empty alternative ID: ${entry.contentID}, ${altIDs}`);
        }
        const contentData = JSON.parse(entry.contentData);
        const directUrl = Hooks.poll('data.downloadURL.straighten', contentData.updateUrl);
        const updateUrl = directUrl != null && entry.flagLimited
          ? ContentUtils.normalizeURL(contentData.informationUrl)
          : (directUrl || ContentUtils.normalizeURL(contentData.updateUrl));
        if (!updateUrl) {
          echo`^Skipping *${cupID}/*${entry.contentID}, update URL is not set`;
          continue;
        }
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
        tblCupData.setEntry(contentKey, `${cupID}/${entry.contentID}`, baseData, updateUrl);
        for (let a of altIDs) {
          baseData.alternativeIds = [entry.contentID, ...altIDs.filter(x => x !== a)];
          tblCupData.setEntry(contentKey, `${cupID}/${a}`, baseData, updateUrl);
        }
      }
      invalidated[categoryIndex].clear();
    }
  }

  if (count) {
    rebuildStats.consider(`${count} entries`);
  }
}

Hooks.register('core.started.async', () => {
  setTimeout(() => sync(true));
  setInterval(() => sync(false), Timer.ms(Settings.dataRefresh));
}, 1e9);

Hooks.register('plugin.cup.reset', () => {
  using _ = db.write().start();
  tblCupData.clear();
  setTimeout(() => sync(true));
});

