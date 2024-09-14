/** Adds overview pages for all the content and users. */

// throw new Error('test');

import { Access, Co, ContentCategories, db, DBTbl, DisabledFlag, Hooks, Server } from "../src/app";

Hooks.register('core.tpl.userMenu', (menu, $) => $.can(Access.VIEW) && menu.push(<>
  <hr />
  <Co.Link href='/manage/overview'>Overview</Co.Link>
  <Co.Link href='/manage/user'>Users ({$.onlineUsersCount} online)</Co.Link>
</>), 1);

function stateLabel(x) {
  return x.flagsDisabled & DisabledFlag.BLOCKED ? 'blocked'
    : x.flagsDisabled & DisabledFlag.USER ? 'disabled'
      : x.flagsDisabled & DisabledFlag.HIDDEN ? 'hidden'
        : x.flagsDisabled & DisabledFlag.PROCESSING ? 'processing'
          : 'active';
}

Hooks.register('core.user.content', user => {
  const e = db.query(`SELECT 
    c.categoryIndex AS categoryIndex,
    c.contentID AS contentID,
    c.dataName AS dataName,
    c.dataVersion AS dataVersion,
    c.countDownloads AS countDownloads,
    c.countComplains AS countComplains,
    c.flagsDisabled AS flagsDisabled,
    c.flagSearcheable AS flagSearcheable,
    c.flagOriginal AS flagOriginal,
    GROUP_CONCAT(a.contentID, ", ") AS alternativeIds
  FROM ${DBTbl.Content} c 
  LEFT JOIN ${DBTbl.AlternativeIDs} a ON c.contentKey = a.contentKey
  LEFT JOIN ${DBTbl.Users} u ON c.userKey = u.userKey
  WHERE c.userKey = ?1
  GROUP BY c.contentKey ${DBTbl.Content.order('c')}`).all(user.userKey);
  if (!e.length) return null;
  return <G $hook={{ 'plugin.overview.user.content': { user } }}>
    <h3>Content:</h3>
    <table>
      <tr>
        <th onclick="reorder(this)">ID</th>
        <th onclick="reorder(this)">Type</th>
        <th onclick="reorder(this)">Status</th>
        <th onclick="reorder(this)">Flags</th>
        <th onclick="reorder(this)">Version</th>
        <th onclick="reorder(this)">Downloads</th>
        <th onclick="reorder(this)">Complains</th>
      </tr>
      {e.map(x => <><tr data-search={x.alternativeIds ? x.contentID + ', ' + x.alternativeIds : x.contentID} data-disabled={(x.flagsDisabled & DisabledFlag.USER) !== 0} data-errored={(x.flagsDisabled & (DisabledFlag.USER | DisabledFlag.HIDDEN)) === DisabledFlag.HIDDEN}>
        <td><a href={`/manage/${ContentCategories[x.categoryIndex].id}/${x.contentID}`}>{x.dataName ? `${x.dataName} (${x.contentID})` : x.contentID}</a></td>
        <td>{ContentCategories[x.categoryIndex].title}</td>
        <td>{stateLabel(x)}</td>
        <td><Co.Value placeholder="none">{[x.flagSearcheable && 'searcheable', x.flagOriginal && 'original'].filter(Boolean).join(', ')}</Co.Value></td>
        <td>{x.dataVersion}</td>
        <td>{x.countDownloads}</td>
        <td>{x.countComplains}</td>
      </tr>{x.alternativeIds ? <tr class="details"><td colspan="7">Also includes: {x.alternativeIds}</td></tr> : null}</>)}
    </table>
  </G>;
}, 1);

Server.get('/manage/overview', $ => {
  $.writes(Access.VIEW);
  const stats = db.query(`SELECT COUNT(*) AS count, SUM(countDownloads) AS downloads FROM ${DBTbl.Content}`).get();
  return <Co.Page title="Overview" search>
    <table>
      <tr>
        <th onclick="reorder(this)">ID</th>
        <th onclick="reorder(this)">Type</th>
        <th onclick="reorder(this)">Status</th>
        <th onclick="reorder(this)">Flags</th>
        <th onclick="reorder(this)">Version</th>
        <th onclick="reorder(this)">Downloads</th>
        <th onclick="reorder(this)">Complains</th>
        <th onclick="reorder(this)">Author</th>
      </tr>
      {db.query(`SELECT 
        c.categoryIndex AS categoryIndex,
        c.contentID AS contentID,
        c.dataName AS dataName,
        c.dataVersion AS dataVersion,
        c.countDownloads AS countDownloads,
        c.countComplains AS countComplains,
        c.flagsDisabled AS flagsDisabled,
        c.flagSearcheable AS flagSearcheable,
        c.flagOriginal AS flagOriginal,
        u.userID AS userID,
        GROUP_CONCAT(a.contentID, ", ") AS alternativeIds
      FROM ${DBTbl.Content} c 
      LEFT JOIN ${DBTbl.AlternativeIDs} a ON c.contentKey = a.contentKey
      LEFT JOIN ${DBTbl.Users} u ON c.userKey = u.userKey
      GROUP BY c.contentKey ${DBTbl.Content.order('c')}`).all().map(x => <><tr data-search={x.alternativeIds ? x.contentID + ', ' + x.alternativeIds : x.contentID} data-disabled={(x.flagsDisabled & DisabledFlag.USER) !== 0} data-errored={(x.flagsDisabled & (DisabledFlag.USER | DisabledFlag.HIDDEN)) === DisabledFlag.HIDDEN}>
        <td><a href={`/manage/${ContentCategories[x.categoryIndex].id}/${x.contentID}`}>{x.dataName ? `${x.dataName} (${x.contentID})` : x.contentID}</a></td>
        <td>{ContentCategories[x.categoryIndex].title}</td>
        <td>{stateLabel(x)}</td>
        <td><Co.Value placeholder="none">{[x.flagSearcheable && 'searcheable', x.flagOriginal && 'original'].filter(Boolean).join(', ')}</Co.Value></td>
        <td>{x.dataVersion}</td>
        <td>{x.countDownloads}</td>
        <td>{x.countComplains}</td>
        <td><Co.UserURL userID={x.userID} /></td>
      </tr>{x.alternativeIds ? <tr class="details"><td colspan="5">Also includes: {x.alternativeIds}</td></tr> : null}</>)}
    </table>
    <hr />
    <ul class="form" $hook={{ 'plugin.overview.stats': { stats } }}>
      <li>Total entries: {stats.count}</li>
      <li>Total downloads: {stats.downloads}</li>
    </ul>
  </Co.Page>;
});

Server.get('/manage/user', $ => {
  $.writes(Access.VIEW);
  const entries = db.query(`SELECT 
    u.userKey AS userKey,
    u.userID AS userID,
    u.accessMask AS accessMask,
    u.allowedFilter AS allowedFilter,
    u.createdDate AS createdDate,
    u.lastSeenDate AS lastSeenDate,
    SUM(IIF(c.flagsDisabled = 0, 1, 0)) AS countActive,
    SUM(c.countDownloads) AS countDownloads,
    SUM(c.countComplains) AS countComplains,
    COUNT(c.contentID) AS count,
    COUNT(a.contentID) AS altCount
  FROM ${DBTbl.Users} u 
  LEFT JOIN ${DBTbl.Content} c ON u.userKey = c.userKey 
  LEFT JOIN ${DBTbl.AlternativeIDs} a ON c.contentKey = a.contentKey 
  GROUP BY u.userKey ${DBTbl.Users.order('u')}`).all();
  const extras = Hooks.trigger('plugin.overview.users.table', {}, entries);
  return <Co.Page title="Users" search>
    <table>
      <tr>
        <th onclick="reorder(this)">User</th>
        <th onclick="reorder(this)">Entries</th>
        <th onclick="reorder(this)">IDs</th>
        <th onclick="reorder(this)">Inactive</th>
        <th onclick="reorder(this)">Downloads</th>
        <th onclick="reorder(this)">Complains</th>
        <th onclick="reorder(this)">Registered</th>
        <th onclick="reorder(this)">Last seen</th>
        {Object.keys(extras).map(x => <th onclick="reorder(this)">{x}</th>)}
        {$.can(Access.MODERATE) ? <>
          <th onclick="reorder(this)">Access</th>
          <th onclick="reorder(this)">Filter</th>
        </> : null}
      </tr>
      {entries.map((x, i) => <tr data-search={x.userID}>
        <td><Co.UserURL userID={x.userID} /></td>
        <td>{x.count}</td>
        <td>{x.count + x.altCount}</td>
        <td>{x.count - x.countActive}</td>
        <td>{x.countDownloads || 0}</td>
        <td>{x.countComplains || 0}</td>
        <td><Co.Date short value={x.createdDate} /></td>
        <td><Co.Date short value={x.lastSeenDate} /></td>
        {Object.values(extras).map(e => <td>{e(x, i)}</td>)}
        {$.can(Access.MODERATE) ? <>
          <td><Co.PermissionsList value={x.accessMask} short /></td>
          <td><Co.Value placeholder="any" mono>{x.allowedFilter}</Co.Value></td>
        </> : null}
      </tr>)}
    </table>
    <hr />
    <ul class="form">
      <Co.InlineMenu $hook='plugin.overview.users.menu'>
        <a href={`/manage/user/${$.user.userID}`}>Own profile…</a>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});