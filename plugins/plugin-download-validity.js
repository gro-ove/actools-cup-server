const { Hooks, db, DBTbl, DisabledFlag, Utils, ContentUtils, pluginSettings } = require("../src/app");

const hiddenReason = 'Update URL seems to not be working';
const validated = db.map('p_dwnvalid', db.row.text(), db.row.integer());

const Settings = pluginSettings('downloadValidity', {
  checkCooldown: 300,
}, s => ({ checkCooldown: s.checkCooldown }));

async function validateURL(url) {
  try {
    const type = ContentUtils.verifyURL(url);
    if (type === 0) return true;
    if (type === 2) url = `http://` + url;
    console.log(`Validating URL: ${url}`);
    const r = await fetch(url);
    console.log(`  Resulting code: ${r.status}`);
    return r.status < 400 || r.status > 499;
  } catch (e) {
    console.warn(`  Validating error: ${e}`)
    return false;
  }
}

let queue = null;

function foundBroken(refID, updateUrl) {
  const e = db.query(`SELECT contentKey, flagsDisabled, contentData FROM ${DBTbl.Content} WHERE categoryIndex=?1 AND contentID=?2`).get(refID[0], refID[1]);
  if (!e) return;
  const contentData = JSON.parse(e.contentData);
  if (contentData.updateUrl !== updateUrl) return;
  e.flagsDisabled |= DisabledFlag.HIDDEN;
  if (!contentData.hiddenReasons?.includes(hiddenReason)) (contentData.hiddenReasons || (contentData.hiddenReasons = [])).push(hiddenReason);
  db.query(`UPDATE ${DBTbl.Content} SET flagsDisabled=?1, contentData=?2 WHERE contentKey=?3`).run(e.flagsDisabled, JSON.stringify(contentData), e.contentKey);
  Hooks.trigger('core.alteration', { categoryIndex: refID[0], contentKey: e.contentKey, invalidateList: true });
}

async function runValidation(url, refID) {
  if (queue) {
    queue.push([url, refID]);
  } else {
    queue = [[url, refID]];
    const runResults = {};
    for (var i = 0; i < queue.length; ++i) {
      const [nextURL, nextRefID] = queue[i];
      let stat = runResults[nextURL];
      if (stat == null) {
        stat = await validateURL(nextURL);
        runResults[nextURL] = stat;
        validated.set(nextURL, stat ? 1 : 0);
      }
      if (!stat) {
        console.log(`Broken URL detected: ${nextURL} (${nextRefID.join('/')})`);
        foundBroken(nextRefID, nextURL);
      }
      await Bun.sleep(Settings.checkCooldown);
    }
    queue = null;
  }
}

Hooks.register('data.downloadURL.verify', (url, content) => {
  const v = validated.get(url);
  if (v == null) {
    runValidation(url, [content.categoryIndex, content.contentID]);
    return undefined;
  } else {
    return v ? undefined : hiddenReason;
  }
});