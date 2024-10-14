import { Hooks, db, DBTbl, DisabledFlag, ContentUtils, pluginSettings, Utils } from '../src/app';
import { Timer } from '../src/std';

const hiddenReason = 'Update URL seems to not be working';
const validated = db.map('p_dwnvalid', db.row.text(), db.row.integer());

const Settings = pluginSettings('downloadValidity', {
  checkCooldown: 300,
  verbose: false
}, s => ({ checkCooldown: s.checkCooldown }));

async function validateURL(url) {
  try {
    const type = ContentUtils.verifyURL(url);
    if (type === 0) return true;
    if (type === 2) url = `http://` + url;
    if (Settings.verbose) echo`Validating URL: _${url}`;
    const r = await fetch(url);
    if (Settings.verbose) echo`  Resulting code: _${r.status}`;
    return r.status < 400 || r.status > 499;
  } catch (e) {
    if (Settings.verbose) echo`  Validating error: =${e}`;
  }
  if (await Utils.offline()) {
    echo`!  Service is offline? 😳`;
    do {
      await Bun.sleep(10e3);
    } while (await Utils.offline());
    return await validateURL(url);
  }
  return false;
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
    db.storage.set('validationQueue', queue);
  } else {
    queue = [[url, refID]];
    const runResults = {};
    for (var i = 0; i < queue.length; ++i) {
      db.storage.set('validationQueue', queue.slice(i));
      const [nextURL, nextRefID] = queue[i];
      let stat = runResults[nextURL];
      if (stat == null) {
        stat = await validateURL(nextURL);
        runResults[nextURL] = stat;
        validated.set(nextURL, stat ? 1 : 0);
      }
      if (!stat) {
        echo`Broken URL detected: _${nextURL} (${nextRefID.join('/')})`;
        foundBroken(nextRefID, nextURL);
      }
      await Bun.sleep(Timer.ms(Settings.checkCooldown));
    }
    queue = null;
    db.storage.set('validationQueue', []);
  }
}

db.storage.get('validationQueue')?.forEach(([url, refID]) => runValidation(url, refID));

Hooks.register('data.downloadURL.verify', (url, content) => {
  const v = validated.get(url);
  if (v == null) {
    runValidation(url, [content.categoryIndex, content.contentID]);
    return undefined;
  } else {
    return v ? undefined : hiddenReason;
  }
});