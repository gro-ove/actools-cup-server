/** Adds some sort of direct messages system for users to contact moderators and vise versa. */

import { Access, Co, db, DBTbl, Hooks, Server, Utils } from "../src/app";
import { Sqid } from "../src/std";

const tblRequests = db.table('p_requests', {
  requestKey: db.row.integer({ primary: true }),
  userKey: db.row.integer({ index: true }),
  message: db.row.text(),
  unseenByModerator: db.row.integer({ index: true }),
  unseenByUser: db.row.integer({ index: true }),
  createdDate: db.row.integer({ default: db.value.now, index: true }),
  initialUserKey: db.row.integer(),
  updatedDate: db.row.integer({ default: db.value.now, index: true })
}, {
  order: 'ORDER BY CASE WHEN ?unseenByModerator IS 0 THEN 1 ELSE 0 END, -?updatedDate, -?requestKey',
  indices: [
    { columns: ['unseenByUser', 'userKey'] },
  ]
});

const tblReplies = db.table('p_requestReplies', {
  replyKey: db.row.integer({ primary: true }),
  userKey: db.row.integer(),
  requestKey: db.row.integer({ index: true }),
  message: db.row.text(),
  createdDate: db.row.integer({ default: db.value.now, index: true }),
});

const rID = new Sqid();

Hooks.register('core.feedbackURL', subject => `/manage/request/new?template=${encodeURIComponent(subject)}`);
Hooks.register('core.res.script.js', data => data.push(`
// Request link might have number of unread messages in it to be copied to the title:
document.querySelectorAll('header a[href="/manage/request"]').forEach(v => /\\((?!0)\\d+\\)/.test(v.textContent) && (document.title = \`\${RegExp["$&"]} \${document.title}\`));
`));

function unreadCount($) {
  if ($.___unread == null) {
    $.___unread = $.can(Access.MODERATE)
      ? db.query(`SELECT SUM(unseenByModerator) AS count FROM ${tblRequests} WHERE unseenByModerator!=0`).get().count || 0
      : db.query(`SELECT SUM(unseenByUser) AS count FROM ${tblRequests} WHERE unseenByUser!=0 AND userKey=?1`).get($.user.userKey).count || 0;
  }
  return $.___unread;
}

Hooks.register('core.tpl.userMenu.header', (header, $) => unreadCount($) && (header.splice(0, Infinity, <>📩 {header[1]}</>)));
Hooks.register('core.tpl.userMenu', (menu, $) => menu.push(<Co.Link href="/manage/request">Requests ({unreadCount($)})</Co.Link>), -1);

Server.get('/manage/request/new', $ => {
  if ($.can(Access.MODERATE) === !$.params.userID) throw $.requestError('Not available');
  return <Co.Page title={`New request${$.can(Access.MODERATE) ? ` to ${$.params.userID}` : ''}`}>
    <Co.MainForm.Start />
    <ul class="form">
      <li class="row">
        <label for="message">Message</label>
        <textarea placeholder="Type a message here…" id="message" name="message" required>{$.params.template}</textarea>
      </li>
      <hr />
      <Co.MainForm.End>Send a request</Co.MainForm.End>
    </ul>
  </Co.Page>
});

Server.post('/manage/request/new', $ => {
  if ($.can(Access.MODERATE) === !$.params.userID) throw $.requestError('Not available');
  const requestKey = ($.params.userID
    ? db.query(`INSERT INTO ${tblRequests} (userKey, initialUserKey, message, unseenByModerator, unseenByUser) VALUES (?1, ?2, ?3, ?4, ?5)`).run(DBTbl.Users.userKey($.params.userID), $.user.userKey, $.params.message, 0, 1)
    : db.query(`INSERT INTO ${tblRequests} (userKey, initialUserKey, message, unseenByModerator, unseenByUser) VALUES (?1, ?2, ?3, ?4, ?5)`).run($.user.userKey, $.user.userKey, $.params.message, 1, 0)).lastInsertRowid;
  return `/manage/request/${rID.encode(requestKey)}`;
});

Server.get('/manage/request', $ => {
  const data = $.can(Access.MODERATE)
    ? db.query(`SELECT u.userID AS userID, r.requestKey AS requestKey, r.updatedDate AS updatedDate, r.unseenByModerator AS unseen, r.message AS message, COUNT(s.replyKey) AS repliesCount FROM ${tblRequests} r LEFT JOIN ${DBTbl.Users} u ON u.userKey=r.userKey LEFT JOIN ${tblReplies} s ON s.requestKey=r.requestKey GROUP BY r.requestKey ${tblRequests.order('r')}`).all()
    : db.query(`SELECT u.userID AS userID, r.requestKey AS requestKey, r.updatedDate AS updatedDate, r.unseenByUser AS unseen, r.message AS message, COUNT(s.replyKey) AS repliesCount FROM ${tblRequests} r LEFT JOIN ${DBTbl.Users} u ON u.userKey=r.userKey LEFT JOIN ${tblReplies} s ON s.requestKey=r.requestKey WHERE r.userKey=?1 GROUP BY r.requestKey ${tblRequests.order('r')}`).all($.user.userKey);
  return <Co.Page title="Requests">
    <ul class="form">{data.map(x =>
      <li data-disabled={!x.unseen}>
        <Co.UserURL userID={x.userID} />: <Co.Value placeholder="empty"><Co.FormattedMessage value={x.message} max-length={80} single-line /></Co.Value>
        <br /><span class="details"><Co.InlineMenu>
          <Co.Link href={`/manage/request/${rID.encode(x.requestKey)}`}>{`${x.repliesCount + 1} ${Utils.plural('message', x.repliesCount + 1)}${x.unseen ? ` (${x.unseen} new)` : ''}`}</Co.Link>
          <Co.Date value={x.updatedDate} />
        </Co.InlineMenu>
        </span>
      </li>)}
    </ul>
    {$.can(Access.MODERATE) ? null : <ul>
      <hr />
      <Co.InlineMenu>
        <Co.Link href="/manage/request/new">New request…</Co.Link>
      </Co.InlineMenu>
    </ul>}
  </Co.Page>;
});

Server.get('/manage/request/:requestID', $ => {
  const rKey = rID.decode($.params.requestID);
  const request = db.query(`SELECT * FROM ${tblRequests} WHERE requestKey=?1`).get(rKey);
  if (!request) return null;
  if (request.userKey !== $.user.userKey) {
    if (!$.can(Access.MODERATE)) {
      return null;
    }
    if (request.unseenByModerator > 0) {
      db.query(`UPDATE ${tblRequests} SET unseenByModerator=0 WHERE requestKey=?1`).run(rKey);
    }
  } else if (request.unseenByUser > 0) {
    db.query(`UPDATE ${tblRequests} SET unseenByUser=0 WHERE requestKey=?1`).run(rKey);
  }

  const replies = db.query(`SELECT * FROM ${tblReplies} WHERE requestKey=?1 ORDER BY createdDate`).all(rKey);
  const usersMap = {};

  function getUser(key) {
    return usersMap[key] || (usersMap[key] = db.query(`SELECT * FROM ${DBTbl.Users} WHERE userKey=?1`).get(key));
  }

  const unreadCounter = request.userKey === $.user.userKey ? request.unseenByUser : request.unseenByModerator;
  function msg(msg, i) {
    const user = getUser(msg.initialUserKey || msg.userKey);
    return <li data-msg-unread={replies.length - i <= unreadCounter}>
      <Co.InlineMenu>
        <Co.Link href={`/manage/user/${user.userID}`}>{user.userID}</Co.Link>
        <Co.Date value={msg.createdDate} />
      </Co.InlineMenu>
      <blockquote><Co.FormattedMessage value={msg.message} /></blockquote>
    </li>;
  }

  const user = getUser(request.userKey);
  return <Co.Page title={<>Request{request.userKey !== $.user.userKey ? <> from <Co.UserURL userID={user.userID} /></> : ''}</>}>
    <ul class="form">{msg(request, -1)}{replies.map(msg)}<hr />
      <Co.MainForm.Start />
      <li class="row">
        <label for="reply">Reply</label>
        <textarea placeholder="Type a reply here…" required id="reply" name="reply" />
      </li>
      <hr />
      <Co.InlineMenu>
        <Co.MainForm.End>Send a reply</Co.MainForm.End>
        <Co.Link href="javascript:location.reload()">Refresh</Co.Link>
        {$.can(Access.MODERATE) || Object.keys(usersMap).length === 1 && request.unseenByModerator !== 0
          ? <Co.Link action="/manage/command/request-delete" args={{ requestID: rID.encode(request.requestKey) }} query={`Are you sure to completely delete a request from ${user.userID}?`}>Delete request…</Co.Link>
          : null}
      </Co.InlineMenu></ul>
  </Co.Page>
});

Server.post('/manage/request/:requestID', $ => {
  const rKey = rID.decode($.params.requestID);
  if (!$.params.reply.trim()) $.requestError('Message is empty', <Co.Link href={`/manage/request/${rID.encode(rKey)}`}>Go back</Co.Link>);
  const request = db.query(`SELECT * FROM ${tblRequests} WHERE requestKey=?1`).get(rKey);
  if (!request) return null;
  if (request.userKey !== $.user.userKey) {
    $.writes(Access.MODERATE);
    db.query(`UPDATE ${tblRequests} SET unseenByUser=unseenByUser+1, updatedDate=?2 WHERE requestKey=?1`).run(rKey, +db.value.now);
  } else {
    db.query(`UPDATE ${tblRequests} SET unseenByModerator=unseenByModerator+1, updatedDate=?2 WHERE requestKey=?1`).run(rKey, +db.value.now);
  }
  db.query(`INSERT INTO ${tblReplies} (userKey, message, requestKey) VALUES (?1, ?2, ?3)`).all($.user.userKey, $.params.reply.trim(), rKey);
  return `/manage/request/${rID.encode(rKey)}`;
});

Server.post('/manage/command/request-delete', $ => {
  const rKey = rID.decode($.params.requestID);
  const request = db.query(`SELECT * FROM ${tblRequests} WHERE requestKey=?1`).get(rKey);
  const replies = db.query(`SELECT * FROM ${tblReplies} WHERE requestKey=?1`).all(rKey);
  if (!$.can(Access.MODERATE)) {
    if (request.userKey !== $.user.userKey) return null;
    if (request.unseenByModerator === 0 || replies.some(x => x.userKey !== $.user.userKey)) $.writes(Access.MODERATE);
  }
  if (!request) return null;
  $.undo($.can(Access.MODERATE) ? `Request with ${DBTbl.Users.userID(request.userKey)} erased` : `Request erased`, () => {
    delete request.requestKey;
    const restoredKey = tblRequests.insert(request);
    for (let e of replies) {
      e.requestKey = restoredKey;
      tblReplies.insert(e);
    }
    return `/manage/request/${rID.encode(restoredKey)}`;
  });
  db.transaction(() => {
    db.query(`DELETE FROM ${tblRequests} WHERE requestKey=?1`).run(rKey);
    db.query(`DELETE FROM ${tblReplies} WHERE requestKey=?1`).run(rKey);
  })();
  return `/manage/request`;
});