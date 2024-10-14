/** Plugin adding CUP-like API to this server at regular endpoints, uses data provided by plugin-cup-core. */

import { PerfCounter } from '../src/std';
import { Co, Ctx, Hooks, JSONResponse, RequestError, Server } from '../src/app';

const CUPUtils = (await import('./plugin-cup-core')).CUPUtils;
const serveStats = new PerfCounter();

Server.zone('/registry', {
  finalize: ($, r, status) => new JSONResponse(r || '{"error":404}', { status }),
  perf: serveStats,
});

Hooks.register('core.tpl.index.menu', body => body.push(<Co.Link href="/registry">Content Registry</Co.Link>));
Hooks.register('plugin.admin.stats', fn => fn({ ['CUP API']: serveStats }));
Hooks.register('plugin.robots.disallowed', s => s('/registry'));

Server.get('/registry/:', $ => {
  if (/^(\w+)\/([^\/]+)\/get$/.test($.params[''])) {
    return new Response(null, { status: 302, headers: trigger($, RegExp.$1, RegExp.$2, 'countDownloads') });
  }
  return CUPUtils.getData($.params[''] === 'list' ? '' : decodeURIComponent($.params['']));
});

/** @param {Ctx} $ */
function trigger($, categoryCupID, contentID, countColumn) {
  const m = CUPUtils.getMetadata(`${categoryCupID}/${contentID}`);
  if (!m) throw new RequestError(404);
  if ($.incrementingCounter) {
    CUPUtils.incrementCounter(m.contentKey, countColumn);
  }
  return Hooks.trigger('plugin.cup.downloadHeaders', { 'Location': m.url });
}

Server.post('/registry/:categoryCupID/:contentID/complain', $ => {
  trigger($, $.params.categoryCupID, $.params.contentID, 'countComplains');
  return new Response(null, { status: 204 });
});
