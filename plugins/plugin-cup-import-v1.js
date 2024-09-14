/** Basic thing to quickly import data from CUP v1. */

import { Access, ContentUtils, db, DBTbl, DisabledFlag, Hooks, pluginSettings, Utils } from '../src/app';

const { inj, titlefy } = Utils;
const Settings = pluginSettings('importV1', {
  verbose: false
});

function categoryFromV1(v1) {
  return v1.startsWith('car__') ? 0 : v1.startsWith('track__') ? 1 : v1.startsWith('app__') ? 4 : null;
}

async function importV1(importDir) {
  const fs = require('fs');
  const path = require('path');
  const tryRead = (filename, fallback) => { try { return '' + fs.readFileSync(filename); } catch (e) { return fallback; } };
  for (const [username, params] of Object.entries(JSON.parse(await Bun.file(`${importDir}/users.json`).text()))) {
    const ustats = fs.statSync(`${importDir}/users.json`);
    const userKey = db.query(`INSERT INTO ${DBTbl.Users} (userID, password, accessMask, introduced, createdDate, lastSeenDate) VALUES (?1, ?2, ?3, ?4, ?5, ?5);`).run(username, DBTbl.Users.passEncode(username, params.password), params.access.users === 'full' ? Access.ADMIN : Access.REGULAR, params.access.users === 'full' ? 1 : 0, ustats.mtime / 1e3).lastInsertRowid;

    let groupDate = Date.now() / 1e3 | 0;
    const mainGroupKey = db.query(`INSERT INTO ${DBTbl.Groups} (userKey, groupID, name, createdDate) VALUES (?1, ?2, ?3, ?4)`).run(userKey, 'main', 'Main', groupDate++).lastInsertRowid;
    try {
      // if (username !== 'x4fab') continue;

      if (Settings.verbose) console.log(`Importing ${username} (${userKey})…`);
      const items = fs.readdirSync(`${importDir}/user_${username}/content`).map(x => ({ id: x, content: fs.readdirSync(`${importDir}/user_${username}/content/${x}`, '*.json').map(y => ({ id: path.basename(y, '.json').split('__', 2)[1], categoryIndex: categoryFromV1(y), filename: `${importDir}/user_${username}/content/${x}/${y}` })).filter(y => y.categoryIndex != null) }));

      const ids = items.map(x => x.content.map(y => y.id)).flat();
      const prefixes = ids.map(x => /^([a-z]{2,4}_)/.test(x) ? RegExp.$1 : null).filter(x => x);
      if (ids.length > 1 && ids.length == prefixes.length && prefixes.every(x => x == prefixes[0])) {
        if (Settings.verbose) console.log(`\tClean prefix: ${prefixes[0]}`);
        db.query(`UPDATE ${DBTbl.Users} SET allowedFilter=?1 WHERE userKey=?2`).run(`^.:${prefixes[0]}.+`, userKey);
      } else {
      //   const requestKey = db.query(`INSERT INTO p_requests (userKey, initialUserKey, message, unseenByModerator, unseenByUser) VALUES (?1, ?2, ?3, ?4, ?5)`).run(userKey, userKey, `Messy IDs for a mask: ${ids.join(', ') || '<nothing>'}\nTest1: car peugeot_504, https://google.com`, 1, 0).lastInsertRowid;
      //   for (var i = (Math.random() * 10 | 0) - 3; i > 0; --i){
      //     var changes = db.query(`INSERT INTO p_requestReplies (userKey, requestKey, message) VALUES (?1, ?2, ?3)`).run(userKey, requestKey, `Reply: ${i}`).changes;
      //     db.query(`UPDATE p_requests SET unseenByModerator=unseenByModerator+1 WHERE requestKey=?1`).run(requestKey);
      //   }
      }

      // TODO
      // db.query(`UPDATE ${DBTbl.Users} SET allowedFilter=?1 WHERE userKey=?2`).run(`^ks_.+`, userKey);
      // db.query(`UPDATE ${DBTbl.Users} SET userData=?1 WHERE userKey=?2`).run(`{"contacts":{"mail":"ma@il.ne","discord":"dis.cord"}}`, userKey);

      for (const c of items) {
        const groupKey = c.id === 'main' ? mainGroupKey
          : db.query(`INSERT INTO ${DBTbl.Groups} (userKey, groupID, name, createdDate) VALUES (?1, ?2, ?3, ?4)`).run(userKey, c.id, inj(titlefy(c.id)), groupDate++).lastInsertRowid;
        for (const file of c.content) {
          const stats = fs.statSync(file.filename);
          const data = JSON.parse(await Bun.file(file.filename).text());
          DBTbl.Content.verifyID(file.categoryIndex, file.id);
          const contentData = {
            changelog: inj(ContentUtils.cleanChangelog(data.changelog)) || undefined,
            informationUrl: inj(data.informationUrl && data.informationUrl.trim()) || undefined,
            updateUrl: inj(data.updateUrl && data.updateUrl.trim()) || undefined,
            cleanInstallation: !!data.cleanInstallation,
          };
          if (!contentData.updateUrl && data.limited) {
            contentData.updateUrl = contentData.informationUrl;
          }
          const content = {
            categoryIndex: file.categoryIndex,
            contentID: file.id,
            groupKey, userKey,
            createdDate: stats.mtime / 1e3,
            updatedDate: stats.mtime / 1e3,
            flagsDisabled: (data.active ? 0 : DisabledFlag.USER) | (data.blocked ? DisabledFlag.BLOCKED : 0),
            dataName: data.name === file.id ? null : inj(data.name && data.name.trim() || null),
            dataAuthor: inj(data.author && data.author.replace(/\r/g, '').trim().replace(/[ \t]*\n[ \t]*/g, ', ').trim() || null),
            dataVersion: inj(data.version && data.version.trim() || null),
            flagSearcheable: false,
            flagOriginal: false,
            flagLimited: data.limited,
            countDownloads: +tryRead(`${importDir}/content_counters/${path.basename(file.filename, '.json')}.id`, 0) | 0,
            countComplains: tryRead(`${importDir}/content_complaints/${path.basename(file.filename, '.json')}.list`, '').split('\n').filter(Boolean).length,
          };
          contentData.hiddenReasons = ContentUtils.verifyValidity(content, contentData);
          if (contentData.hiddenReasons.length !== 0) {
            content.flagsDisabled |= DisabledFlag.HIDDEN;
          }
          content.contentData = DBTbl.Content.encodeContentData(contentData);
          const contentKey = DBTbl.Content.insert(content);
          for (const id of (data.alternativeIds || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean)) {
            if (id === file.id) continue;
            DBTbl.Content.verifyID(file.categoryIndex, id);
            db.query(`INSERT INTO ${DBTbl.AlternativeIDs} (contentKey, categoryIndex, contentID) VALUES (?1, ?2, ?3)`).run(contentKey, file.categoryIndex, id);
          }
          Hooks.trigger('core.alteration', {categoryIndex: file.categoryIndex, contentKey, invalidateList: true});
        }
      }
    } catch (e) {
      if (Settings.verbose) console.warn(`  Failed to import categories: ${e.stack} (user: ${username})`);
    }
  }
}

Hooks.register('core.started.async', async () => {
  for (const dir of process.argv.map(x => x.split('--import=')[1]).filter(x => x)) {
    try { 
      await importV1(dir);
    } catch (e) {
      console.warn(`Import failed: ${e.stack}`);
    }
  }
});
