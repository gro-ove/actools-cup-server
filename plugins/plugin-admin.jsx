/** Some advanced moderation tools. */
import { Access, AppSettings, Co, Ctx, db, Hooks, pluginSettings, RequestError, resolveCDN, Server, Utils } from '../src/app';
import { heapStats } from "bun:jsc";
import { PerfCounter } from '../src/std';

const KEY_MAINTENANCE_MODE = 'plugin.admin.maintanence';
const KEY_PAUSE_ERRORS_COLLECTION = 'plugin.admin.pauseErrorsCollection';

const Settings = pluginSettings('admin', {
  errorReportsLimit: 100
}, s => ({
  errorReportsLimit: s.errorReportsLimit
}));

const tblErrors = db.table('t_collected_errors', {
  url: db.row.text({ nullable: true }),
  userID: db.row.text({ nullable: true }),
  data: db.row.text(),
  createdDate: db.row.integer({ default: db.value.now }),
});

Hooks.register('core.error', ({ error, $, extras }) => {
  if (tblErrors.count() > Settings.errorReportsLimit
    || db.storage.get(KEY_PAUSE_ERRORS_COLLECTION) === true
    || error instanceof RequestError) return;
  let data;
  try {
    data = `${error && error.stack || error}
${JSON.stringify($?.req ? { method: $.req.method, headers: Object.fromEntries($.req.headers), params: $.params, extras } : { extras })}`;
  } catch (e) {
    echo`!Error reporting error:=${e}`;
    data = '' + e + '\n(Error reporting error!)';
  }
  tblErrors.insert({
    url: $?.req?.url || extras?.lastRequestURL,
    userID: $?.__user?.userID,
    data,
    createdDate: +db.value.now
  });
});

Hooks.register('core.user', (user, $) => {
  if (db.storage.get(KEY_MAINTENANCE_MODE) === true
    && (!user || user.accessMask !== Access.ADMIN)) {
    throw new RequestError(500, 'Under maintanence', <Co.Page title="Server under maintanence" center>
      <p>Server is under maintanence. Please try again later.</p>
      <p>
        <Co.InlineMenu>
          <Co.Link href={$.requestURL}>Try again</Co.Link>
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

const errCountKey = Symbol('errCount');
function errCount($) {
  if ($[errCountKey] == null) {
    $[errCountKey] = tblErrors.count();
  }
  return $[errCountKey];
}

Hooks.register('core.tpl.userMenu.header', (header, $) => $.user.accessMask === Access.ADMIN && errCount($) && (header.splice(0, 1, `📛`)), 1e3);

Hooks.register('core.tpl.userMenu', (menu, $) => $.user.accessMask === Access.ADMIN ? menu.push(<G $hook="plugin.admin.tpl.userMenu">
  <hr />
  {db.storage.get(KEY_MAINTENANCE_MODE) ? <Co.Link action='/manage/cup/tool/maintanence'>{'Disable maintanence mode'}</Co.Link> : null}
  {errCount($) ? <Co.Link href='/manage/cup/errors'>Errors ({errCount($)})</Co.Link> : null}
  <Co.Dropdown href='/manage/cup' label="CUP">
    <Co.Link href='/manage/cup/report'>Status</Co.Link>
    <Co.Link href='/manage/cup/tool'>Tools</Co.Link>
    <Co.Link href='/manage/cup/settings'>Settings</Co.Link>
  </Co.Dropdown>
</G>) : null, 100);

let counter = (Math.random() * 1e6) | 0;
const cmdIncrementCounter = Server.command(() => ++counter);
const cmdLogCounter = Server.command((counter, userKey) => console.log(counter, userKey));
const cmdResetCounter = Server.command(function () {
  let b = counter;
  this.undo('Counter has been reset.', () => { counter = b });
  counter = 0;
}, { query: 'Are you sure?' });

Server.get('/manage/cup', $ => {
  $.writes(Access.ADMIN);
  const live = $.liveUpdating('1 min', <li>Counter: {counter}</li>);
  const key = Utils.uid();
  return <Co.Page title="CUP">
    <ul class="form">
      <li><Co.Link href='/manage/cup/errors'>Errors ({errCount($)})</Co.Link></li>
      <li><Co.Link href='/manage/cup/report'>Status</Co.Link></li>
      <li><Co.Link href='/manage/cup/tool'>Tools</Co.Link></li>
      <li><Co.Link href='/manage/cup/settings'>Settings</Co.Link></li>
      <hr />
      <h3>Perm. test:</h3>
      <li>User.accessMask: {$.user.accessMask}</li>
      <hr />
      <h3>Undo test:</h3>
      {live[0]}
      <li><Co.Link data-live-apply action={cmdIncrementCounter()}>Increment counter</Co.Link></li>
      <li><Co.Link action={cmdLogCounter(counter, $.user.userKey)}>Log counter</Co.Link></li>
      <li><Co.Link action={cmdResetCounter()}>Reset counter…</Co.Link></li>
      <hr />
      <h3>Action test:</h3>
      <li><Co.Link action={() => $.toast(null, 'Hello world! Value: ' + $.params.got)}>Test</Co.Link></li>
      <li><Co.Link action={$ => $.toast(null, 'Now: ' + key + ', was: ' + $.params.key)} args={{ key }}>Random: {key}</Co.Link></li>
      <li><Co.Link action={() => $.toast(null, 'URL: ' + $.requestURL)}>Get URL</Co.Link></li>
    </ul>
  </Co.Page>;
});

Server.get('/manage/cup/tool', $ => {
  $.writes(Access.ADMIN);
  return <Co.Page title="Tools">
    <ul class="form">
      <h3>Online users:</h3>
      {
        $.onlineUserIDs.map(x => <li><Co.UserLink userID={x} hide-online-mark /></li>)
      }
      <hr />
      <h3>Tools:</h3>
      <Co.List $hook="plugin.admin.tpl.toolsList">
        <Co.Link action='/manage/cup/tool/maintanence'>{db.storage.get(KEY_MAINTENANCE_MODE) ? 'Disable maintanence mode' : 'Enable maintanence mode'}</Co.Link>
        <Co.Link action='/manage/cup/tool/gc'>Run GC</Co.Link>
        <Co.Link action='/manage/cup/tool/dbgc'>Vacuum database and truncate WAL</Co.Link>
        <Co.Link action='/manage/cup/tool/backup'>Backup database</Co.Link>
      </Co.List>
    </ul>
  </Co.Page>;
});

Server.get('/manage/cup/report', $ => {
  $.writes(Access.ADMIN);

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

const cmdDeleteByDate = Server.command(createdDate => db.query(`DELETE FROM ${tblErrors} WHERE createdDate=?1`).run(createdDate));
const cmdDeleteByURL = Server.command(url => db.query(`DELETE FROM ${tblErrors} WHERE url=?1`).run(url));
const cmdDeleteByMessage = Server.command(message => db.query(`DELETE FROM ${tblErrors} WHERE data LIKE ?1`).run(message + '\n%'));
const cmdToggleErrorsCollection = Server.command(() => db.storage.set(KEY_PAUSE_ERRORS_COLLECTION, !db.storage.get(KEY_PAUSE_ERRORS_COLLECTION)));
const cmdClearErrors = Server.command(() => tblErrors.clear());

function errToData(err) {
  const s = err.indexOf('\n{');
  if (s !== -1) {
    try {
      let j = JSON.parse(err.substring(s + 1));
      let a = err.substring(0, s).split('\n');
      return [<div style="margin:1em 0">
        <span class="mono">{a[0]}</span>
        {a.length > 1 ? <>
          <span class="collapsing-float" style="font-size:0.8em;margin-right:1em">Stack ({a.length - 1})</span>
          <pre style="margin:0.6em 20px">{a.slice(1).map(x => x.trim()).join('\n')}</pre>
        </> : null}
        {j.extras && Object.keys(j.extras).length > 0 ? <>
          <span class="collapsing-float" style="font-size:0.8em;margin-right:1em">Extras ({Object.keys(j.extras).length})</span>
          <pre style="margin:0.6em 20px">{JSON.stringify(j.extras, null, 2).replace(/^\{|(?<!:) +(?=")|\}$/g, '').trim()}</pre>
        </> : null}
        {j.params && Object.keys(j.params).length > 0 ? <>
          <span class="collapsing-float" style="font-size:0.8em;margin-right:1em">Params ({Object.keys(j.params).length})</span>
          <pre style="margin:0.6em 20px">{JSON.stringify(j.params, null, 2).replace(/^\{|(?<!:) +(?=")|\}$/g, '').trim()}</pre>
        </> : null}
        {j.headers && Object.keys(j.headers).length > 0 ? <>
          <span class="collapsing-float" style="font-size:0.8em;margin-right:1em">Headers ({Object.keys(j.headers).length})</span>
          <pre style="margin:0.6em 20px">{JSON.stringify(j.headers, null, 2).replace(/^\{|(?<!:) +(?=")|\}$/g, '').trim()}</pre>
        </> : null}
      </div>, j.method];
    } catch (e) {
      console.log(e);
    }
  }
  return [<pre class="details">{err}</pre>, null];
}

Server.get('/manage/cup/errors', $ => {
  $.writes(Access.ADMIN);
  return <Co.Page title="Errors" search>
    <ul class="form">
      <Co.InlineMenu>
        <Co.Link action={cmdToggleErrorsCollection()}>{db.storage.get(KEY_PAUSE_ERRORS_COLLECTION) ? `Enable errors collection` : `Disable errors collection`}</Co.Link>
        <Co.Link action={cmdClearErrors()} query="Are you sure to remove all error reports?" data-live-apply>Clear out everything…</Co.Link>
      </Co.InlineMenu>
      <hr />
    </ul>
    <ul class="form">
      {db.query(`SELECT * FROM ${tblErrors} ORDER BY -createdDate`).all().map(x => {
        const [err, method] = errToData(x.data);
        return <li data-search={x.data}>
          <Co.InlineMenu>
            <Co.Date value={x.createdDate} />
            {method || null}
            {x.url ? <Co.Link href={x.url}>{x.url.replace(/^[^\/]+\/\/[^\/]+\//, '/')}</Co.Link> : null}
            {x.userID ? <Co.UserLink userID={x.userID} /> : null}
            <Co.Link action={cmdDeleteByDate(x.createdDate)}>remove</Co.Link>
            {x.url ? <Co.Link action={cmdDeleteByURL(x.url)}>remove by URL</Co.Link> : null}
            {x.data.indexOf('\n') !== -1 ? <Co.Link action={cmdDeleteByMessage(x.data.split('\n', 1)[0])}>remove by message</Co.Link> : null}
          </Co.InlineMenu>
          {err}
        </li>
      })}
    </ul>
  </Co.Page>;
});

Server.post('/manage/cup/settings', $ => {
  $.can(Access.ADMIN);
  const data = JSON.parse($.params.cfg);
  db.storage.set('adminSettings', data);
  Utils.deepAssign(AppSettings, data);
  return `/manage/cup/tool`;
});

Server.post('/manage/cup/tool/maintanence', $ => {
  $.writes(Access.ADMIN);
  db.storage.set(KEY_MAINTENANCE_MODE, !db.storage.get(KEY_MAINTENANCE_MODE));
  return `/manage/cup/tool`;
});

Server.post('/manage/cup/tool/dbgc', $ => {
  $.writes(Access.ADMIN);
  Bun.gc(true);
  return `/manage/cup/tool`;
});

Server.post('/manage/cup/tool/gc', $ => {
  $.writes(Access.ADMIN);
  db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  return `/manage/cup/tool`;
});

Server.post('/manage/cup/tool/backup', $ => {
  $.writes(Access.ADMIN);
  const data = Bun.gzipSync(Utils.tar([{ key: 'data.db', data: db.serialize() }]));
  return new Response(data, { headers: { 'Content-Disposition': `attachment; filename=cup-bak-${+Date.now() / 1e3 | 0}.tar.gz` } });
});
