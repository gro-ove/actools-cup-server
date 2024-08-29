/** Adds invites to simplify registration for new users. */

import { Access, AppSettings, Co, db, DBTbl, Hooks, Server, Utils } from "../src/app";

Hooks.register('core.tpl.userMenu', (menu, $) => $.can(Access.MODERATE) && menu.push(<>
  <hr />
  <Co.Link href="/manage/invite">Issued invites</Co.Link>
  <Co.Link href="/manage/tool/invite">Invite a user…</Co.Link>
</>), 90);

Hooks.register('plugin.overview.users.menu', (menu, $) => {
  if ($.can(Access.MODERATE)) menu.push(<a href="/manage/tool/invite">Add user…</a>);
}, 0);

Hooks.register('core.userStats.registered', (menu, { userData }, $) => $.can(Access.MODERATE) && userData.inviteMark && menu.push(<> (invite mark: <Co.Link href={userData.inviteKey ? `/manage/invite/${userData.inviteKey.toString(36)}` : null}>{userData.inviteMark}</Co.Link>)</>));

const tblInvites = db.table('p_invites', {
  inviteKey: db.row.integer({ primary: true }),
  createdDate: db.row.integer({ default: db.value.now, index: true }),
  invitedUserID: db.row.text({ nullable: true }),
  inviteData: db.row.text(),
  claimedUserKey: db.row.integer({ nullable: true, unique: true }),
});

Server.get('/manage/tool/invite', $ => {
  $.writes(Access.MODERATE);
  return <Co.Page title="Invite user…">
    <Co.MainForm.Start />
    <ul class="form">
      <Co.Row key="inviteMark" required>Invite mark</Co.Row>
      <Co.Row key="userID" placeholder="Optional">Username</Co.Row>
      <h3>Account access:</h3>
      <Co.Row accessMask={Access.REGULAR}>Permissions</Co.Row>
      <Co.Row key="allowedFilter" attributes={{ class: 'mono' }}>ID filter</Co.Row>
      <hr />
      <Co.InlineMenu>
        <Co.MainForm.End>Create an invite</Co.MainForm.End>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

Server.post('/manage/tool/invite', $ => {
  $.writes(Access.MODERATE);
  const id = Math.random() * 0x7fffffff | 0;
  const invitedUserID = $.params['data-userID'] || null;
  if (invitedUserID && (invitedUserID !== Utils.idfy(invitedUserID))) {
    throw $.requestError(`Incorrect user ID`);
  }
  if (invitedUserID) {
    const invite = db.query(`SELECT * FROM ${tblInvites} WHERE invitedUserID=?1`).get(invitedUserID);
    if (invite) {
      throw $.requestError(<>ID is already used by a different <a href={`/manage/invite/${invite.inviteKey.toString(36)}`}>invite</a>{invite.claimedUserKey ? <> claimed by <Co.UserURL userKey={invite.claimedUserKey} /></> : null}</>);
    }
    if (db.query(`SELECT * FROM ${DBTbl.Users} WHERE userID=?1`).get(invitedUserID)) {
      throw $.requestError(<>ID is already used by <Co.UserURL userID={invitedUserID} /></>);
    }
  }
  const inviteData = {
    inviteMark: $.params['data-inviteMark'] || null,
    allowedFilter: $.params['data-allowedFilter'] || null,
    accessMask: Object.values(Access).filter(x => $.params[`perm-${x}`] === 'on').reduce((p, v) => p | v, 0)
  };
  const inserted = db.query(`INSERT INTO ${tblInvites} (inviteKey, invitedUserID, inviteData) VALUES (?1, ?2, ?3)`).run(id, invitedUserID, JSON.stringify(inviteData)).lastInsertRowid;
  return `/manage/invite/${inserted.toString(36)}`;
});

Server.get('/manage/invite', $ => {
  $.writes(Access.MODERATE);
  return <Co.Page title="Invites">
    <ul class="form">
      {db.query(`SELECT * FROM ${tblInvites} ORDER BY CASE WHEN claimedUserKey IS NULL THEN 0 ELSE 1 END, -createdDate`).all().map(x =>
        <li data-disabled={!!x.claimedUserKey}>
          <a href={`/manage/invite/${x.inviteKey.toString(36)}`}>Invite <span class="mono">#{x.inviteKey.toString(36)}</span></a> (
          <Co.Date value={x.createdDate} />
          {x.invitedUserID ? <>, for {x.invitedUserID}</> : null}
          {x.claimedUserKey ? <>, claimed by <Co.UserURL userKey={x.claimedUserKey} /></> : null})
        </li>)}
    </ul><ul>
      <hr />
      <Co.InlineMenu>
        <Co.Link href="/manage/tool/invite">Invite a user…</Co.Link>
      </Co.InlineMenu>
    </ul>
  </Co.Page>
});

Server.get('/manage/invite/:inviteKey', $ => {
  if ($.signed) $.user;

  const data = tblInvites.get(parseInt($.params.inviteKey, 36));
  if (!data) return $.requestError('No invite with such ID found');

  let body;
  if ($.signed) {
    const inviteData = JSON.parse(data.inviteData);
    body = <>
      <p>{data.claimedUserKey != null
        ? <>Invite claimed by <Co.UserURL userKey={data.claimedUserKey} /> <Co.Date value={db.query(`SELECT createdDate FROM ${DBTbl.Users} WHERE userKey=?1`).get(data.claimedUserKey).createdDate} />.</>
        : <>Unclaimed invite{data.invitedUserID ? ` for ${data.invitedUserID} ` : null}.</>}</p>
      <li>Created: <Co.Date value={data.createdDate} /></li>
      <h3>Account access:</h3>
      <li>Permissions: <Co.PermissionsList value={inviteData.accessMask} short /></li>
      <li>ID filter: <Co.Value placeholder="any" mono>{inviteData.allowedFilter}</Co.Value></li>
      {
        $.can(Access.MODERATE) ? <>
          <hr />
          <Co.InlineMenu>
            <Co.Link href="/manage/tool/invite">Invite a user…</Co.Link>
            <Co.Link action="/manage/command/invite-delete" args={{ inviteKey: data.inviteKey }} query="Are you sure to completely delete an invite?">Delete invite…</Co.Link>
          </Co.InlineMenu>
        </> : null
      }
    </>;
  } else if (data.claimedUserKey != null) {
    body = <>
      <p>Invite has already been claimed by {DBTbl.Users.userID(data.claimedUserKey)}.</p>
      <hr />
      <Co.InlineMenu>
        <Co.SocialLinks contacts={AppSettings.ownContacts} format="Ask for a new invite via ?1…" subject="CUP invite" />
      </Co.InlineMenu>
    </>;
  } else {
    body = <>
      <Co.MainForm.Start autocomplete />
      <p>You got an invite to a new CUP moderation tool. Please fill out the form to proceed:</p>
      <Co.Row data={{ userID: data.invitedUserID }} key="userID" readonly={data.invitedUserID != null} required={data.invitedUserID == null} hint={data.invitedUserID ? `This invite is created especially for ${data.invitedUserID}` : 'Used as an account login, can’t be changed later'}>Username</Co.Row>
      <Co.Row key="password" $attr={{type: 'password', autocomplete: 'new-password'}} required hint="Password can be changed later">Password</Co.Row>
      <hr />
      <Co.InlineMenu>
        <Co.MainForm.End>Sign up</Co.MainForm.End>
        <Co.Link href="/manage">I already have an account, sign in instead…</Co.Link>
      </Co.InlineMenu>
    </>;
  }
  return <Co.Page title="Invite to a CUP v2">
    <ul class="form">{body}</ul>
  </Co.Page>;
});

Server.post('/manage/invite/:inviteKey', $ => {
  const data = tblInvites.get(parseInt($.params.inviteKey, 36));
  if (!data) {
    throw $.requestError('No invite with such ID found');
  }
  if ($.signed) {
    if ($.user.userKey === data.claimedUserKey) return '/manage';
    throw $.requestError('You already are signed in', <Co.Link action="/manage/command/logout" args={{ location: 'current' }}>Log out and try again</Co.Link>);
  }
  if (data.claimedUserKey) {
    throw $.requestError(<>Invite has already been claimed by <Co.UserURL userKey={data.claimedUserKey} /></>);
  }

  const inviteData = JSON.parse(data.inviteData);
  const userID = data.invitedUserID || $.params['data-userID'];
  if (userID !== Utils.idfy(userID)) {
    throw $.requestError(`Incorrect user ID`);
  }

  db.transaction(() => {
    const userKey = db.query(`INSERT INTO ${DBTbl.Users} (userID, password, accessMask, allowedFilter, userData) VALUES (?1, ?2, ?3, ?4, ?5)`).run(userID, DBTbl.Users.passEncode(userID, $.params['data-password']), inviteData.accessMask, inviteData.allowedFilter, JSON.stringify({ inviteMark: inviteData.inviteMark, inviteKey: data.inviteKey })).lastInsertRowid;
    db.query(`INSERT INTO ${DBTbl.Groups} (userKey, groupID, name) VALUES (?1, ?2, ?3)`).run(userKey, 'main', 'Main');
    db.query(`UPDATE ${tblInvites} SET claimedUserKey=?2 WHERE inviteKey=?1`).run(data.inviteKey, userKey);
  })();
  return `/manage/introduction`;
});

Server.post('/manage/command/invite-delete', $ => {
  $.writes(Access.MODERATE);
  const data = tblInvites.get($.params.inviteKey);
  if (!data) return null;
  $.undo(`Invite #${data.inviteKey.toString(36)} erased`, () => {
    const restoredKey = tblInvites.insert(data);
    if (data.claimedUserKey) {
      const user = DBTbl.Users.get(data.claimedUserKey);
      const userData = JSON.parse(user.userData);
      userData.inviteKey = restoredKey;
      db.query(`UPDATE ${DBTbl.Users} SET userData=?2 WHERE userKey=?1`).run(data.claimedUserKey, JSON.stringify(userData));
    }
    return `/manage/invite/${restoredKey.toString(36)}`;
  });
  db.transaction(() => {
    if (data.claimedUserKey) {
      const user = DBTbl.Users.get(data.claimedUserKey);
      const userData = JSON.parse(user.userData);
      delete userData.inviteKey;
      db.query(`UPDATE ${DBTbl.Users} SET userData=?2 WHERE userKey=?1`).run(data.claimedUserKey, JSON.stringify(userData));
    }
    db.query(`DELETE FROM ${tblInvites} WHERE inviteKey=?1`).run($.params.inviteKey);
  })();
  return `/manage/invite`;
});
