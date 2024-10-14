/** Thing to serve some files directly. */

import { Access, Hooks, Server } from '../src/app';
const fs = require('fs');
const misses = new Map();

const hacky = url => /^\/\.(?:env$|git|aws)|\bphp_?info\b|\/(?:connect\.cgi|eval-stdin\.php)$/.test(url);

Hooks.register('core.serve.missing', async ({ url, $ }) => {
  if (url.startsWith('/.well-known/')) {
    const filename = `${__dirname}/../res-root/${url}`;
    if (fs.existsSync(filename)) {
      return new Response(Bun.file(filename));
    }
  }
  misses.set(url, (misses.get(url) || 0) + 1);
  if (hacky(url)) {
    return new Response(require('crypto').randomBytes((Math.random() * 16 + 8) | 0),
      { status: 418, headers: { 'Content-Type': 'water/boiling; charset=UTF-1', 'Set-Cookie': 'IAmADummy=1' } });
  }
  echo`Unknown URL: _${url} (_${$.requestURL})`;
});

Server.get('/manage/missed-urls', $ => {
  $.can(Access.ADMIN);
  return <ul>
    {[...misses.entries()].sort((a, b) => (hacky(a[0]) ? 1e6 : 0) + a[1] < (hacky(b[0]) ? 1e6 : 0) + b[1]).map(([k, v]) => <li data-errored={hacky(k)}>{k}: {v}</li>)}
  </ul>;
});