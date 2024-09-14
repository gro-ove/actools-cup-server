/** Replaces basic HTTP authentification with a nice modern one. */
import { Hooks, DBTbl, RequestError, Server, db, pluginSettings, Co, Utils, Ctx, Access, AppSettings } from '../src/app';
import { Sqid, Timer } from '../src/std';

const Settings = pluginSettings('auth', {
  sessionTokenKey: null,
  sessionMaxAge: `30 days`
}, s => ({
  sessionMaxAge: s.sessionMaxAge
}));

const tblSessions = Object.assign(db.table('p_auth', {
  sessionKey: db.row.integer({ primary: true }),
  sessionCode: db.row.text(),
  userKey: db.row.integer({ index: true }),
  createdDate: db.row.integer({ default: db.value.now }),
  lastUsedDate: db.row.integer({ default: db.value.now }),
  sessionData: db.row.text({ default: '{"previousIPs":[]}' }),
  lastIP: db.row.text(),
  lastBrowser: db.row.text(),
}, { version: 1 }), {
  keySqid: new Sqid(Settings.sessionTokenKey),
  encode(code, key) {
    key = this.keySqid.encode(key, Math.random() * 15 | 0);
    return `${this.keySqid.key[key.length]}${code}${key}`;
  },
  decode(encoded) {
    const len = encoded ? this.keySqid.key.indexOf(encoded[0]) : -1;
    const key = len !== -1 && this.keySqid.decode(encoded.substring(encoded.length - len));
    return key ? { code: encoded.substring(1, encoded.length - len), key } : null;
  },
  delete(sessionKey) {
    db.query(`DELETE FROM ${this} WHERE sessionKey=?1`).run(sessionKey);
  },
  gc() {
    db.query(`DELETE FROM ${this} WHERE lastUsedDate < ?1`).run(+db.value.now - Timer.seconds(Settings.sessionMaxAge));
  },
});

function gcCallback() {
  tblSessions.gc();
  setTimeout(gcCallback, Timer.ms(Settings.sessionMaxAge) / 10);
}
setTimeout(gcCallback, 10e3);

Hooks.register('core.tpl.userPage.menu', (menu, { user }, $) => {
  if (user.userKey !== $.user.userKey && !$.can(Access.ADMIN)) return;
  menu.splice(1, 0, <Co.Link href={user.userKey !== $.user.userKey ? `/manage/sessions?userID=${user.userID}` : `/manage/sessions`}>View active sessions</Co.Link>);
}, 10);

Hooks.register('plugin.admin.stats', fn => fn({
  ['Sessions']: {
    'Active': db.query(`SELECT COUNT(*) AS count FROM ${tblSessions}`).get().count
  }
}));

function getBrowserID($) {
  return `${$.req.headers.get('user-agent') || '?'} (${$.req.headers.get('accept-language') || '?'})`;
}

function removeCurrentSession($) {
  const read = tblSessions.decode($.cookies.get('CupManageAuth'));
  if (read) {
    tblSessions.delete(read.key);
  }
}

function removeOtherSessions($) {
  const read = tblSessions.decode($.cookies.get('CupManageAuth'));
  if (read) {
    db.query(`DELETE FROM ${tblSessions} WHERE sessionKey IS NOT ?1 AND userKey=?2`).run(sessionKey, $.user.userKey);
  }
}

Hooks.register('core.user.signedCheck', /** @param {Ctx} $ */ $ => {
  const read = tblSessions.decode($.cookies.get('CupManageAuth'));
  const session = read && db.query(`SELECT userKey, sessionCode, lastUsedDate, lastIP, lastBrowser FROM ${tblSessions} WHERE sessionKey=?1`).get(read.key);
  return session != null && session.sessionCode === read.code;
});

Hooks.register('core.user.auth', /** @param {Ctx} $ */ $ => {
  const read = tblSessions.decode($.cookies.get('CupManageAuth'));
  const session = read && db.query(`SELECT userKey, sessionCode, lastUsedDate, lastIP, lastBrowser FROM ${tblSessions} WHERE sessionKey=?1`).get(read.key);
  if (!session || session.sessionCode !== read.code) return null;

  const ageS = +db.value.now - session.lastUsedDate;
  using t = db.write();
  if (ageS > 60) {
    if (ageS > Timer.seconds(Settings.sessionMaxAge)) {
      tblSessions.delete(read.key);
      return null;
    } else {
      t.query(`UPDATE ${tblSessions} SET lastUsedDate=?2 WHERE sessionKey=?1`).run(read.key, +db.value.now);
    }
  }

  const ip = $.requestIP;
  const browser = getBrowserID($);
  if (ip !== session.lastIP) {
    if (browser !== session.lastBrowser) {
      tblSessions.delete(read.key);
      return null;
    }

    const sessionData = JSON.parse(db.query(`SELECT sessionData FROM ${tblSessions} WHERE sessionKey=?1`).get(read.key).sessionData);
    sessionData.previousIPs.push(session.lastIP);
    t.query(`UPDATE ${tblSessions} SET sessionData=?2, lastIP=?3 WHERE sessionKey=?1`).run(read.key, JSON.stringify(sessionData), ip);
  } else if (browser !== session.lastBrowser) {
    t.query(`UPDATE ${tblSessions} SET lastBrowser=?2 WHERE sessionKey=?1`).run(read.key, browser);
  }

  const user = db.query(`SELECT ${$.requiredUserFields} FROM ${DBTbl.Users} WHERE userKey=?1`).get(session.userKey);
  if (user && +db.value.now > user.lastSeenDate + 10) {
    user.lastSeenDate = +db.value.now;
    t.query(`UPDATE ${DBTbl.Users} SET lastSeenDate=?2 WHERE userKey=?1`).run(user.userKey, +db.value.now);
  }
  return user || null;
});

Hooks.register('core.user', /** @param {Ctx} $ */(user, $) => {
  if (user) return;
  $.cookies.set('CupManageRedirect', $.url.pathname, { age: '10 min', httpOnly: true });
  $.header('Location', '/manage/sign');
  if ($.url.pathname === '/manage/sign') throw new Error('Shouldn’t have happened here');
  throw new RequestError(302, 'Unauthorized');
}, Infinity);

Hooks.register('core.user.logout', $ => {
  removeCurrentSession($);
  $.cookies.delete('CupManageAuth');
  return '/manage/sign';
});

Hooks.register('core.user.changingPassword', $ => {
  removeOtherSessions($);
});

Hooks.register('core.tpl.changePasswordForm', body => body.splice(0, 0, <p>Changing password will invalidate all other sessions.</p>));

function SignForm(props) {
  return <Co.Page title="Sign in" center>
    <Co.MainForm.Start autocomplete action="/manage/sign" />
    {props.redirect ? <input type="hidden" value={props.redirect} name="redirect" /> : null}
    <ul class="form">
      {props.error ? <p>{props.error}</p> : props.signed ? <p>You are already logged in, but you can use this form to change the account.</p> : null}
      <Co.Row key="username" data={{ username: props.username }} attributes={{ autocomplete: 'username', required: true }}>Username</Co.Row>
      <Co.Row key="password" attributes={{ type: 'password', autocomplete: 'current-password', required: true, 'data-password-toggle': true }}>Password</Co.Row>
      <hr />
      <Co.InlineMenu>
        <Co.MainForm.End>{props.signed ? 'Switch account' : `Sign in`}</Co.MainForm.End>
        {props.signed ? <Co.Link action="/manage/command/logout">Log out</Co.Link> : null}
        {props.signed ? null : <Co.Dropdown label="Request an invite…" href="#"><Co.SocialLinks contacts={AppSettings.ownContacts} format="Contact via ?1…" subject="CUP invite" /></Co.Dropdown>}
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
}

Server.get('/manage/cookie-test', $ => {
  $.cookies.set('test0', new Date().toLocaleString());
  $.cookies.set('test1', Date.now());
  $.cookies.set('test2', $.user);
  $.cookies.set('test3', ['repeat'.repeat(10)]);
  $.cookies.set('test4', 'short');
  return <pre>{JSON.stringify([
    $.cookies.get('test0'),
    $.cookies.get('test1'),
    $.cookies.get('test2'),
    $.cookies.get('test3'),
    $.cookies.get('test4'),
  ], null, 2)}</pre>;
});

Server.get('/manage/sign', $ => {
  return <SignForm
    redirect={$.cookies.get('CupManageRedirect') === '/manage/sign' ? '/manage' : $.cookies.get('CupManageRedirect')}
    signed={$.signed} />;
});

function signIn($, username, password) {
  const user = db.query(`SELECT ${$.requiredUserFields}, password FROM ${DBTbl.Users} WHERE userID=?1`).get(username);
  if (!user || user.password !== DBTbl.Users.passEncode(username, password)) {
    return false;
  }

  using t = db.write();
  const code = Utils.uid(16);
  const key = t.query(`INSERT INTO ${tblSessions} (sessionCode, userKey, lastIP, lastBrowser) VALUES (?1, ?2, ?3, ?4)`).run(code, user.userKey, $.requestIP, getBrowserID($)).lastInsertRowid;

  t.query(`WITH latest_sessions AS ( SELECT sessionKey FROM ${tblSessions} WHERE userKey = ?1 ORDER BY createdDate DESC LIMIT 10 )
    DELETE FROM ${tblSessions} WHERE userKey = ?1 AND sessionKey NOT IN latest_sessions`).run(user.userKey);

  const encoded = tblSessions.encode(code, key);
  $.cookies.set('CupManageAuth', encoded, { age: Settings.sessionMaxAge, httpOnly: true, secure: true });
  $.__user = user;
  return true;
}

let signInAttempts = 0;

Server.post('/manage/sign', $ => {
  removeCurrentSession($);

  if (signInAttempts > 10) throw $.requestError('Too many sign in attempts at once, please try again later');
  ++signInAttempts;
  setTimeout(() => --signInAttempts, 60e3);

  const username = $.params['data-username'] || '';
  const password = $.params['data-password'] || '';
  const redirect = $.params['redirect'];
  if (!signIn($, username, password)) {
    return <SignForm username={username} redirect={redirect} error={
      <div>
        {password ? 'Wrong password, please try again' : 'Password is required'}. <Co.Dropdown label="Forgot password?" href="#"><Co.SocialLinks contacts={AppSettings.ownContacts} format="Contact via ?1…" subject="Forgot CUP password" /></Co.Dropdown>
      </div>
    } />;
  }

  return redirect && redirect.startsWith('/') ? redirect : `/manage`;
});

Hooks.register('plugin.invites.claimed', ({ $, userID, password }) => {
  signIn($, userID, password);
});

Hooks.register('plugin.invites.signInLink', (body, { userID }) => {
  console.log(userID);
  body.splice(0, Infinity, <Co.Link action={`/manage/sign`} args={{ 'data-username': userID }}>Try to sign in</Co.Link>);
});

Server.post('/manage/command/session-close', $ => {
  const session = tblSessions.get(parseInt($.params.sessionKey, 36));
  if (!session || !$.can(Access.ADMIN) && session.userKey !== $.user.userKey) return null;
  tblSessions.delete(session.sessionKey);
  return '/manage/sessions';
});

Server.post('/manage/command/session-purge', $ => {
  if (!$.can(Access.ADMIN) && $.params.userID !== $.user.userID) return null;
  const read = tblSessions.decode($.cookies.get('CupManageAuth'));
  if (!read) return null;
  db.query(`DELETE FROM ${tblSessions} WHERE userKey=?1 AND sessionKey IS NOT ?2`).run(DBTbl.Users.userKey($.params.userID), read.key);
  return '/manage/sessions';
});

Server.get('/manage/sessions', $ => {
  const read = tblSessions.decode($.cookies.get('CupManageAuth'));
  const userKey = $.can(Access.ADMIN) && $.params.userID ? DBTbl.Users.userKey($.params.userID) : $.user.userKey;
  const liveUpdating = $.liveUpdating('3hr', <ul class="form">
    {db.query(`SELECT * FROM ${tblSessions} WHERE userKey=?1 ORDER BY -lastUsedDate`).all(userKey).map(x => {
      const data = JSON.parse(x.sessionData);
      return <li class="details">
        <Co.InlineMenu>
          <span data-selected={x.sessionKey === read.key}>Latest activity: <Co.Date value={x.lastUsedDate} /></span>
          <span>Signed from: {data.previousIPs[0] || x.lastIP}</span>
        </Co.InlineMenu>
        <div><Co.InlineMenu>
          <span>Signed: <Co.Date value={x.createdDate} /></span>
          <span>Last IP: {x.lastIP}</span>
          {x.sessionKey === read.key ? null
            : <Co.Link action="/manage/command/session-close" args={{ sessionKey: x.sessionKey.toString(36) }} data-live-apply>Close session</Co.Link>}
        </Co.InlineMenu><br />Last browser: {x.lastBrowser}</div>
      </li>;
    })}
  </ul>);

  return <Co.Page title="Sessions">
    {liveUpdating[0]}
    <ul>
      <hr />
      <Co.InlineMenu>
        <Co.Link action="/manage/command/session-purge" args={{ userID: DBTbl.Users.userID(userKey) }}>Close other sessions</Co.Link>
        <Co.Link action="/manage/command/logout">Log out</Co.Link>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});