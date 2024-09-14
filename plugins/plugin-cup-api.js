/** Plugin adding CUP-like API to this server at regular endpoints, uses data provided by plugin-cup-core. */

import { PerfCounter } from '../src/std';
import { Co, ContentCategories, db, DBTbl, Hooks, RequestError, Server } from '../src/app';

await import('./plugin-cup-core');
const cupIDToIndex = ContentCategories.reduce((p, v, k) => ((p[v.cupID] = k), p), {});
const serveStats = new PerfCounter();
const headersBase = { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'max-age=600, public' };
const headersData = { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'max-age=600, public', 'Content-Encoding': 'deflate' };

Server.zone('/registry', {
  finalize: ($, r, status) => new Response(r || '{"error":404}', { status, headers: r ? headersData : headersBase }),
  perf: serveStats,
});

Hooks.register('core.tpl.index.menu', body => body.push(<Co.Link href="/registry">Content Registry</Co.Link>));
Hooks.register('plugin.admin.stats', fn => fn({ ['CUP API']: serveStats }));

Server.get('/registry', () => Hooks.poll('plugin.cup.data', '~'));
Server.get('/registry/:categoryCupID/:contentID', $ => Hooks.poll('plugin.cup.data', `${$.params.categoryCupID}/${$.params.contentID}`));

function trigger($, categoryCupID, contentID, countColumn) {
  const categoryIndex = cupIDToIndex[categoryCupID];
  if (categoryIndex == null) throw new RequestError(404);
  let entry = db.query(`SELECT flagsDisabled, contentKey, contentData FROM ${DBTbl.Content} WHERE categoryIndex=?1 AND contentID=?2`).get(categoryIndex, contentID);
  if (!entry) {
    let alternative = db.query(`SELECT contentKey FROM ${DBTbl.AlternativeIDs} WHERE categoryIndex=?1 AND contentID=?2`).get(categoryIndex, contentID);
    if (!alternative) throw new RequestError(404);
    entry = db.query(`SELECT contentKey, contentData FROM ${DBTbl.Content} WHERE contentKey=?1`).get(alternative.contentKey);
  }
  if (entry.flagsDisabled !== 0) throw new RequestError(404);
  const contentData = JSON.parse(entry.contentData);
  if (!contentData.updateUrl) throw new RequestError(404);
  if (Hooks.poll('plugin.cup.put', `${$.req.url}/${$.req.headers.get('x-real-ip')}`)){
    db.query(`UPDATE ${DBTbl.Content} SET ${countColumn}=${countColumn}+1 WHERE contentKey=?1`).run(entry.contentKey);
  }
  return Hooks.poll('data.downloadURL.straighten', contentData.updateUrl) || contentData.updateUrl;
}

Server.get('/registry/:categoryCupID/:contentID/get', $ => {
  return new Response(null, {status: 302, headers: {'Location': trigger($, $.params.categoryCupID, $.params.contentID, 'countDownloads')}});
});

Server.post('/registry/:categoryCupID/:contentID/complain', $ => {
  trigger($, $.params.categoryCupID, $.params.contentID, 'countComplains');
  return new Response(null, {status: 204});
});
