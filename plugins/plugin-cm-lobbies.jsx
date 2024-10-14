import { Access, Co, ContentUtils, db, Hooks, JSONResponse, registerPermission, Server } from '../src/app';

const permLobbies = registerPermission('CM_LOBBIES', 2048, { id: 'CM lobbies', title: 'Register new CM lobby servers', hidden: true });

let cache = null;
const tblLobbies = db.table('p_cm_lobbies', {
  lobbyKey: db.row.integer({ primary: true }),
  url: db.row.text({ unique: true }),
  enabled: db.row.boolean({ default: true, index: true }),
  development: db.row.boolean({ default: false, index: true }),
  title: db.row.text({ unique: true }),
  description: db.row.text({ nullable: true }),
  flags: db.row.text({ nullable: true }),
  userKey: db.row.integer({ index: true }),
  createdDate: db.row.integer({ default: db.value.now }),
}, {
  version: 2,
  upgrade: [
    row => Object.assign({ flags: null }, row)
  ]
}).extend(tbl => {
  return {
    list: tbl.pall(['url', 'title', 'description', 'flags'], { raw: 'enabled IS TRUE AND development IS FALSE' }),
    devList: tbl.pall(['url', 'title', 'description', 'flags'], { raw: 'enabled IS TRUE' }),
  };
}).on('update', () => {
  cache = null;
});

Hooks.register('core.tpl.userMenu', (menu, $) => {
  if ($.can(permLobbies)) {
    menu.push(<Co.Link href="/manage/lobby">CM online lobbies</Co.Link>);
  }
}, 0.5);

Server.get('/plugins/lobbies', () => new JSONResponse(cache ?? (cache = Bun.deflateSync(JSON.stringify(tblLobbies.list())))));
Server.get('/plugins/lobbies-dev', () => new JSONResponse(tblLobbies.devList()));

const cmdToggleLobby = Server.command((lobbyKey, enabled) => tblLobbies.update({ lobbyKey }, { enabled }));
const cmdToggleDevLobby = Server.command((lobbyKey, development) => tblLobbies.update({ lobbyKey }, { development }));
Server.get('/manage/lobby', $ => {
  $.writes(permLobbies);
  return <Co.Page title="Lobbies">
    <ul class="form">
      {tblLobbies.all(null, $.can(Access.ADMIN) ? null : { userKey: $.user.userKey }).map(x => <li class="details">
        <a href={U`/manage/lobby/${x.lobbyKey}`}>{x.title}</a>
        <div>
          <Co.InlineMenu>
            {$.can(Access.ADMIN) ? <>User: <Co.UserLink userKey={x.userKey} /></> : null}
            <Co.Link action={cmdToggleLobby(x.lobbyKey, !x.enabled)}>{x.enabled ? 'Disable' : 'Enable'}</Co.Link>
            <Co.Link action={cmdToggleDevLobby(x.lobbyKey, !x.development)}>{x.development ? 'Switch to production mode' : 'Switch to development mode'}</Co.Link>
            <>URL: <a href={x.url}>{x.url}</a></>
            <>Created: <Co.Date value={x.createdDate} /></>
            {x.flags ? <>Flags: <span class="mono">{x.flags}</span></> : null}
          </Co.InlineMenu>
          <br />
          Description: <Co.Value placeholder="none"><Co.BBCodeMessage single-line value={x.description} /></Co.Value>
        </div>
      </li>)}
    </ul><ul>
      <hr />
      <Co.InlineMenu>
        <a href="/manage/lobby/new">Add new…</a>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

Hooks.register('core.menu.add', list => {
  if (!Server.$.can(permLobbies)) return;
  list.push(<a 
    href="/manage/lobby/new" 
    title="As different types of entities, lobbies are managed in a separate section of the website">Add CM online lobby</a>);
}, 200);

Server.get('/manage/lobby/:lobbyKey', $ => {
  $.writes(permLobbies);
  const entry = $.params.lobbyKey === 'new' ? { enabled: true } : $.writes(tblLobbies.get($.params.lobbyKey));
  return <Co.Page title={<>
    <a href="/manage/lobby">Lobbies</a>/{entry.title || 'Create new…'}
  </>}>
    <ul class="form">
      <Co.MainForm.Start unique={!entry.lobbyKey} />
      <Co.Row data={entry} key="enabled" default={true}>Enabled</Co.Row>
      <Co.Row data={entry} key="development" default={false} title="Add --dev-lobbies flag to CM to see these servers">Development</Co.Row>
      <Co.Row data={entry} key="title" required>Title</Co.Row>
      <Co.Row data={entry} key="description" title="Emojis and BB-codes can be used here">Description</Co.Row>
      <Co.Row data={entry} key="flags" title="Comma-separated, for internal and future use">Flags</Co.Row>
      <Co.Row data={entry} key="url" required>URL</Co.Row>
      <p>Note: CM caches list of lobbies for 12 hours. Clear <b>Cache.data</b> or use <span class="mono">--dev-lobbies</span> flag to force refresh list on each restart.</p>
      <hr />
      <Co.InlineMenu>
        <Co.MainForm.End>Save changes</Co.MainForm.End>
        {entry.lobbyKey ? <Co.Link action args={{ 'delete': true }} query={`Delete ${entry.title}?`}>Delete…</Co.Link> : null}
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

Server.post('/manage/lobby/:lobbyKey', async $ => {
  $.writes(permLobbies);
  const entry = $.params.lobbyKey === 'new' ? {} : $.writes(tblLobbies.get($.params.lobbyKey));

  if ($.params.delete && entry.lobbyKey) {
    tblLobbies.delete($.params.lobbyKey);
    $.undo(`Lobby ${entry.title} removed.`, () => {
      if (tblLobbies.get(entry.lobbyKey)) delete entry.lobbyKey;
      return U`/manage/lobby/${tblLobbies.insert(entry)}`;
    });
    return U`/manage/lobby`;
  }

  const input = $.form({
    enabled: db.row.boolean(),
    development: db.row.boolean(),
    title: { required: true },
    description: { maxLength: 2048 },
    url: { prepare: ContentUtils.normalizeURL, required: true, errorMessage: 'Valid URL is required' },
    flags: { separator: ',' },
    userKey: entry.userKey || $.user.userKey
  });

  if (input.url !== entry.url && !input.flags.includes('skip-check')) {
    const data = await fetch(input.url);
    if (data.status !== 200) throw $.requestError('Endpoint is not responding with valid data');
  }

  input.flags = input.flags.join(', ');
  if (entry.lobbyKey) {
    tblLobbies.update({ lobbyKey: entry.lobbyKey }, input);
  } else {
    entry.lobbyKey = tblLobbies.insert(input);
  }
  return U`/manage/lobby/${entry.lobbyKey}`;
});

if (process.platform === 'win32') {
  Server.get('/test/lobby-0', $ => {
    return new Response(`[{"ip":"146.4.115.244","port":4200,"cport":8381,"tport":4200,"name":"weird ass name 1 ✅ ℹ8381","clients":0,"maxclients":24,"track":"monza-monza_euroracers_2023","cars":["rss_formula_hybrid_2023"],"timeofday":0,"session":1,"sessiontypes":["1"],"durations":["300"],"timeleft":6621,"country":["Germany","DE"],"pass":false,"pickup":true,"timestamp":47344,"lastupdate":0,"timed":true,"extra":false,"l":false,"inverted":false,"pit":true}`);
  });

  Server.get('/test/lobby-1', $ => {
    return new Response(`[{"ip":"246.4.115.244","port":4200,"cport":8381,"tport":4200,"name":"weird ass name 2 ✅ ℹ8381","clients":0,"maxclients":24,"track":"monza-monza_euroracers_2023","cars":["rss_formula_hybrid_2023"],"timeofday":0,"session":1,"sessiontypes":["1"],"durations":["300"],"timeleft":6621,"country":["Germany","DE"],"pass":false,"pickup":true,"timestamp":47344,"lastupdate":0,"timed":true,"extra":false,"l":false,"inverted":false,"pit":true}`);
  });
}