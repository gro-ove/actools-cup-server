/** Some advanced moderation tools. */
import { Access, AppSettings, Co, db, Hooks, RequestError, resolveCDN, Server, Utils } from '../src/app';
import { heapStats } from "bun:jsc";
import { PerfCounter } from '../src/std';

const KEY_MAINTENANCE_MODE = 'plugin.admin.maintanence';

const tblErrors = db.table('t_collected_errors', {
  url: db.row.text({ nullable: true }),
  userID: db.row.text({ nullable: true }),
  data: db.row.text(),
  createdDate: db.row.integer({ default: db.value.now }),
});

Hooks.register('core.error', ({ error, $ }) => {
  if (tblErrors.count() > 100 || error instanceof RequestError) return;
  tblErrors.insert({
    url: $?.req?.url,
    userID: $?.__user?.userID, 
    data: `${error && error.stack || error}\n
Method: ${$?.req?.method || '?'}
Headers: ${$?.req?.headers && JSON.stringify([...$.req.headers.keys()].reduce((p, x) => ((p[x] = $.req.headers.get(x)), p), {}), null, 2)}`, 
    createdDate: Date.now() / 1e3
  });
});

Hooks.register('core.user', (user, $) => {
  if (db.storage.get(KEY_MAINTENANCE_MODE) === true
    && (!user || !(user.accessMask & Access.MODERATE))) {
    throw new RequestError(500, 'Under maintanence', <Co.Page title="Server under maintanence" center>
      <p>Server is under maintanence. Please try again later.</p>
      <p>
        <Co.InlineMenu>
          <Co.Link href={$.req.url}>Try again</Co.Link>
          <Co.SocialLinks contacts={AppSettings.ownContacts} format="Contact via ?1…" subject="CUP maintanence" />
        </Co.InlineMenu>
      </p>
    </Co.Page>);
  }
}, 100);

Hooks.register('core.tpl.final', (final, $) => {
  if ($.__user && $.__user.accessMask === Access.ADMIN && db.storage.get(KEY_MAINTENANCE_MODE)) {
    final.header = <div class="warning">
      Server under maintanence and not accessible by regular users. <Co.Link action="/manage/cup/tool/maintanence">Disable</Co.Link>.
    </div> + final.header;
  }
}, 100);

function errCount($) {
  if ($.__errCount == null) {
    $.__errCount = tblErrors.count();
  }
  return $.__errCount;
}

Hooks.register('core.tpl.userMenu.header', (header, $) => $.user.accessMask === Access.ADMIN && errCount($) && (header.splice(0, Infinity, <>📛 {header[1]}</>)), 1e3);

Hooks.register('core.tpl.userMenu', (menu, $) => $.user.accessMask === Access.ADMIN ? menu.push(<>
  <hr />
  {db.storage.get(KEY_MAINTENANCE_MODE) ? <Co.Link action='/manage/cup/tool/maintanence'>{'Disable maintanence mode'}</Co.Link> : null}
  {errCount($) ? <Co.Link href='/manage/cup/errors'>Errors ({errCount($)})</Co.Link> : null}
  <Co.Dropdown href='/manage/cup' label="CUP">
    <Co.Link href='/manage/cup/report'>Status</Co.Link>
    <Co.Link href='/manage/cup/tool'>Tools</Co.Link>
    <Co.Link href='/manage/cup/settings'>Settings</Co.Link>
  </Co.Dropdown>
</>) : null, 100);

Server.get('/manage/cup/tool', $ => {
  $.writes(Access.MODERATE);
  return <Co.Page title="Tools">
    <ul class="form">
      <h3>Online users:</h3>
      {
        $.onlineUserIDs.map(x => <li><Co.UserURL userID={x} hide-online-mark /></li>)
      }
      <hr />
      <h3>Tools:</h3>
      <Co.List>
        <Co.Link action='/manage/cup/tool/maintanence'>{db.storage.get(KEY_MAINTENANCE_MODE) ? 'Disable maintanence mode' : 'Enable maintanence mode'}</Co.Link>
        <Co.Link action='/manage/cup/tool/gc'>Run GC</Co.Link>
        <Co.Link action='/manage/cup/tool/dbgc'>Vacuum database and truncate WAL</Co.Link>
        <Co.Link action='/manage/cup/tool/backup'>Backup database</Co.Link>
      </Co.List>
    </ul>
  </Co.Page>;
});

Server.get('/manage/cup/report', $ => {
  $.writes(Access.MODERATE);

  function perfReport(perf, entryFmt) {
    if (!perf.history) {
      return {
        ['Average time']: `${perf.avgTimeMs.toFixed(2)} ms`,
        ['Maximum time']: `${perf.maxTimeMs.toFixed(2)} ms`,
      };
    } else {
      return {
        ['Average time']: `${perf.avgTimeMs.toFixed(2)} ms`,
        ['Maximum time']: `${perf.maxTimeMs.toFixed(2)} ms`,
        ['Last entries']: <ul class="details">{Array.from(perf.history.entries, x => <li>{entryFmt ? entryFmt(x[1]) : x[1]}: {x[0].toFixed(2)} ms</li>)}</ul>,
      };
    }
  }

  function collectStats() {
    const os = require('os');
    const averageLoad = os.loadavg();
    const heap = heapStats();
    const ret = {
      Process: {
        Heap: `${(heap.heapSize / 1e6).toFixed(1)} MB, ${heap.objectCount} objects`,
        ['Average load']: `${averageLoad[0]} (last minute)`
      },
      ['Server performance']: perfReport($.formatStats, x => <a href={x}>{x}</a>),
    };
    Hooks.trigger('plugin.admin.stats', data => {
      for (var n in data) {
        ret[n] = Object.assign(ret[n] || {}, data[n] instanceof PerfCounter ? perfReport(data[n]) : data[n]);
      }
    });
    return ret;
  }

  function statValue(t) {
    if (t && typeof t === 'object' && Object(t) === t) {
      if (t.content) return t;
      if (t instanceof PerfCounter) t = perfReport(t);
      return <ul class="details">{Object.entries(t).map(([k, v]) => <li>{k}: {v}</li>)}</ul>;
    }
    return '' + t;
  }

  return <Co.Page title="Status report">
    <ul class="form">
      {Object.entries(collectStats()).map(([k, v]) => <><h3>{k}</h3>{Array.isArray(v) ? <Co.List>{v}</Co.List> : Object.entries(v).map(([k, t]) => <li>{k}: {statValue(t)}</li>)}</>)}
    </ul>
  </Co.Page>;
});

Server.get('/manage/cup/settings', $ => {
  $.writes(Access.ADMIN);

  $.head(<>
    <link rel="stylesheet" href={resolveCDN('https://cdnjs.cloudflare.com/ajax/libs/prism/1.23.0/themes/prism-tomorrow.css')} />
    <script src={resolveCDN('https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js')}></script>
    <script src={resolveCDN('https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js')}></script>
    <link rel="stylesheet" href={resolveCDN('https://cdn.jsdelivr.net/gh/WebCoder49/code-input@2.3/code-input.min.css')} />
    <script src={resolveCDN('https://cdn.jsdelivr.net/gh/WebCoder49/code-input@2.3/code-input.min.js')}></script>
    <script>codeInput.registerTemplate("demo", codeInput.templates.prism(Prism, []));</script>
  </>);
  return <Co.Page title="Settings">
    <ul class="form">
      <Co.MainForm.Start />
      <code-input name="cfg" language="JSON" template="demo" value={JSON.stringify(Hooks.trigger('core.adminSettings', { ownContacts: AppSettings.ownContacts, periods: AppSettings.periods }), null, 4)} style={{ height: 'calc(100vh - 180px)', width: 'calc(100vw - 280px)' }}></code-input>
      <Co.InlineMenu>
        <Co.MainForm.End>Save settings</Co.MainForm.End>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

Server.post('/manage/command/plugin-admin-remove-error', $ => {
  console.log($.params);
  if ($.params.url) db.query(`DELETE FROM ${tblErrors} WHERE url=?1`).run($.params.url);
  else db.query(`DELETE FROM ${tblErrors} WHERE createdDate=?1`).run($.params.createdDate);
  return '/manage/cup/errors';
});

Server.get('/manage/cup/errors', $ => {
  $.writes(Access.ADMIN);
  const list = $.liveUpdating(30, <ul class="form">
    {db.query(`SELECT * FROM ${tblErrors} ORDER BY -createdDate`).all().map(x => <li data-search={x.data}>
      <Co.InlineMenu>
        <Co.Date value={x.createdDate} />
        {x.url ? <Co.Link href={x.url}>{x.url.replace(/^[^\/]+\/\/[^\/]+\//, '/')}</Co.Link> : null}
        {x.userID ? <Co.UserURL userID={x.userID} /> : null}
        <Co.Link action="/manage/command/plugin-admin-remove-error" args={{ createdDate: x.createdDate }} data-live-apply>remove</Co.Link>
        {x.url ? <Co.Link action="/manage/command/plugin-admin-remove-error" args={{ url: x.url }} data-live-apply>remove by URL</Co.Link> : null}
      </Co.InlineMenu>
      <pre class="details">{x.data}</pre>
    </li>)}
  </ul>);
  return <Co.Page title="Errors" search>{list[0]}</Co.Page>;
});

Server.post('/manage/cup/settings', $ => {
  $.can(Access.ADMIN);
  const data = JSON.parse($.params.cfg);
  db.storage.set('adminSettings', data);
  Utils.deepAssign(AppSettings, data);
  return `/manage/cup/tool`;
});

Server.post('/manage/cup/tool/maintanence', $ => {
  $.writes(Access.MODERATE);
  db.storage.set(KEY_MAINTENANCE_MODE, !db.storage.get(KEY_MAINTENANCE_MODE));
  return `/manage/cup/tool`;
});

Server.post('/manage/cup/tool/dbgc', $ => {
  $.writes(Access.MODERATE);
  Bun.gc(true);
  return `/manage/cup/tool`;
});

Server.post('/manage/cup/tool/gc', $ => {
  $.writes(Access.MODERATE);
  db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  return `/manage/cup/tool`;
});

Server.post('/manage/cup/tool/backup', $ => {
  $.writes(Access.MODERATE);
  const data = Bun.gzipSync(Utils.tar([{ key: 'data.db', data: db.serialize() }]));
  return new Response(data, { headers: { 'Content-Disposition': `attachment; filename=cup-bak-${+Date.now() / 1e3 | 0}.tar.gz` } });
});
