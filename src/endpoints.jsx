import {
  Access, AppSettings, Co, ContentCategories, ContentUtils,
  db, DBTbl, DisabledFlag, DownloadableSource, formatGenericPage, Hooks, Locale, RequestError, Server,
  Utils
} from './app';
import { BunJSX, LazyMap, prepareAsset } from './std';

Server.redirect('/manage', $ => U`/manage/group/${db.query(`SELECT groupID FROM ${DBTbl.Groups} WHERE userKey=?1 ${DBTbl.Groups.order()} LIMIT 1`).get($.user.userKey).groupID}`);
Server.get('/manage', $ => {
  $.user;
  return '/manage';
});

// Commands:
Server.post('/manage/command/logout', $ => {
  return Hooks.poll('core.user.logout', $)
    || jsExt.raiseError(new RequestError(401, 'Unauthorized', <script>{new BunJSX(`location.href=${JSON.stringify($.params.location || '/manage')}`)}</script>));
});

Server.post('/manage/command/undo', $ => $.processUndo());
Server.post('/manage/command/undo-close', $ => $.clearUndo());

Server.post('/manage/command/content-move', $ => {
  $.writes();
  return db.query(`UPDATE ${DBTbl.Content} SET groupKey=?1 WHERE userKey=?2 AND contentID=?3 AND categoryIndex=?4`).run($.group.groupKey, $.user.userKey, $.params.contentID, $.categoryIndex).changes ? U`/manage/group/${$.group.groupID}` : null;
});

Server.post('/manage/command/content-toggle', $ => {
  const entry = db.query(`SELECT * FROM ${DBTbl.Content} WHERE categoryIndex=?1 AND contentID=?2`).get($.categoryIndex, $.params.contentID);
  $.writes(entry);
  db.query(`UPDATE ${DBTbl.Content} SET flagsDisabled=?2 WHERE contentKey=?1`).run(entry.contentKey, entry.flagsDisabled.setFlag(DisabledFlag.USER, !+$.params.state));
  Hooks.trigger('core.alteration', { categoryIndex: $.categoryIndex, contentKey: entry.contentKey, invalidateList: true });
  return U`/manage/${$.params.categoryID}/${$.params.contentID}`;
});

Server.post('/manage/command/content-searchable-toggle', $ => {
  const entry = db.query(`SELECT * FROM ${DBTbl.Content} WHERE categoryIndex=?1 AND contentID=?2`).get($.categoryIndex, $.params.contentID);
  $.writes(entry);
  db.query(`UPDATE ${DBTbl.Content} SET flagSearcheable=?2 WHERE contentKey=?1`).run(entry.contentKey, $.params.state);
  Hooks.trigger('core.alteration', { categoryIndex: $.categoryIndex, contentKey: entry.contentKey, invalidateList: true });
  return U`/manage/${$.params.categoryID}/${$.params.contentID}`;
});

Server.post('/manage/command/content-reset-complains', $ => {
  const entry = db.query(`SELECT * FROM ${DBTbl.Content} WHERE categoryIndex=?1 AND contentID=?2`).get($.categoryIndex, $.params.contentID);
  $.writes(entry);
  db.query(`UPDATE ${DBTbl.Content} SET countComplains=0 WHERE contentID=?1 AND categoryIndex=?2`).run(entry.contentID, $.categoryIndex);
  return U`/manage/${$.params.categoryID}/${$.params.contentID}`;
});

Server.post('/manage/command/content-block', $ => {
  $.writes(Access.MODERATE);
  const entry = db.query(`SELECT * FROM ${DBTbl.Content} WHERE categoryIndex=?1 AND contentID=?2`).get($.categoryIndex, $.params.contentID);
  if (!entry) return null;
  const data = JSON.parse(entry.contentData);
  data.blockedReason = $.params.value || null;
  db.query(`UPDATE ${DBTbl.Content} SET flagsDisabled=?2, contentData=?3 WHERE contentKey=?1`).run(entry.contentKey, entry.flagsDisabled.setFlag(DisabledFlag.BLOCKED, $.params.value), JSON.stringify(data));
  Hooks.trigger('core.alteration', { categoryIndex: $.categoryIndex, contentKey: entry.contentKey, invalidateList: true });
  return U`/manage/${$.params.categoryID}/${$.params.contentID}`;
});

Server.post('/manage/command/group-rename', $ => {
  $.writes();
  const id = Utils.ensureUnique($.id, x => db.query(`SELECT groupKey FROM ${DBTbl.Groups} WHERE userKey=?1 AND groupID=?2 AND groupID!=?3`).get($.user.userKey, x, $.params.groupID));
  return db.query(`UPDATE ${DBTbl.Groups} SET name=?3, groupID=?4 WHERE userKey=?1 AND groupID=?2`).run($.user.userKey, $.params.groupID, $.params.value, id).changes ? U`/manage/group/${id}` : null;
});

Server.post('/manage/command/group-delete', $ => {
  $.writes();
  const targetGroup = db.query(`SELECT * FROM ${DBTbl.Groups} WHERE userKey=?1 AND groupID=?2`).get($.user.userKey, $.params.groupID);
  if (!targetGroup) return null;
  const mainGroup = db.query(`SELECT groupKey, groupID FROM ${DBTbl.Groups} WHERE userKey=?1 ${DBTbl.Groups.order()} LIMIT 1`).get($.user.userKey);
  if (mainGroup.groupKey == targetGroup.groupKey) throw $.requestError('Can’t delete the first group');

  using _ = db.write().start();
  const ids = db.query(`SELECT contentKey FROM ${DBTbl.Content} WHERE groupKey=?1`).all(targetGroup.groupKey).map(x => x.contentKey);
  db.query(`UPDATE ${DBTbl.Content} SET groupKey=?1 WHERE groupKey=?2`).run(mainGroup.groupKey, targetGroup.groupKey);
  db.query(`DELETE FROM ${DBTbl.Groups} WHERE groupKey=?1`).run(targetGroup.groupKey);
  $.undo(`Group ${targetGroup.name} removed.`, () => {
    delete targetGroup.groupKey;
    const newKey = DBTbl.Groups.insert(targetGroup);
    for (const e of ids) {
      db.query(`UPDATE ${DBTbl.Content} SET groupKey=?1 WHERE contentKey=?2`).run(newKey, e);
    }
  })
  return `/manage/group`;
});

Server.post('/manage/command/user-change-password', $ => {
  $.writes(Access.ADMIN);
  const user = db.query(`SELECT * FROM ${DBTbl.Users} WHERE userID=?1`).get($.params.userID);
  return db.query(`UPDATE ${DBTbl.Users} SET password=?1 WHERE userKey=?2`).run(DBTbl.Users.passEncode(user.userID, $.params.value), user.userKey).changes ? U`/manage/user/${user.userID}` : null;
});

// Content:
Server.post('/manage/group', $ => {
  $.writes();
  const id = Utils.ensureUnique($.id, x => db.query(`SELECT groupKey FROM ${DBTbl.Groups} WHERE userKey=?1 AND groupID=?2`).get($.user.userKey, x));
  db.query(`INSERT INTO ${DBTbl.Groups} (userKey, groupID, name) VALUES (?1, ?2, ?3)`).run($.user.userKey, id, $.params.value);
  return U`/manage/group/${id}`;
});

const cmdSetAuthorName = Server.command((categoryIndex, contentID) => {
  db.query(`UPDATE ${DBTbl.Content} SET dataAuthor=?3 WHERE contentID=?1 AND categoryIndex=?2`)
    .run(contentID, categoryIndex, Server.$.params.value);
});
const cmdToggleFlagDisabled = Server.command((categoryIndex, contentID) => {
  const contentKey = db.query(`UPDATE ${DBTbl.Content} SET flagsDisabled=((flagsDisabled & ~${DisabledFlag.USER}) | ?3) WHERE contentID=?1 AND categoryIndex=?2 RETURNING contentKey`)
    .get(contentID, categoryIndex, Server.$.params.state ? 0 : DisabledFlag.USER)?.contentKey;
  if (contentKey) Hooks.trigger('core.alteration', { categoryIndex: categoryIndex, contentKey, invalidateList: true });
});
const cmdToggleFlagSearchable = Server.command((categoryIndex, contentID) => {
  const contentKey = db.query(`UPDATE ${DBTbl.Content} SET flagSearcheable=?3 WHERE contentID=?1 AND categoryIndex=?2 RETURNING contentKey`)
    .get(contentID, categoryIndex, Server.$.params.state)?.contentKey;;
  if (contentKey) Hooks.trigger('core.alteration', { categoryIndex: categoryIndex, contentKey, invalidateList: true });
});
const cmdToggleFlagLimited = Server.command((categoryIndex, contentID) => {
  const contentKey = db.query(`UPDATE ${DBTbl.Content} SET flagLimited=?3 WHERE contentID=?1 AND categoryIndex=?2 RETURNING contentKey`)
    .get(contentID, categoryIndex, Server.$.params.state)?.contentKey;
  if (contentKey) Hooks.trigger('core.alteration', { categoryIndex: categoryIndex, contentKey, invalidateList: true });
});
const cmdToggleFlagOriginal = Server.command((categoryIndex, contentID) => {
  const contentKey = db.query(`UPDATE ${DBTbl.Content} SET flagOriginal=?3 WHERE contentID=?1 AND categoryIndex=?2 RETURNING contentKey`)
    .get(contentID, categoryIndex, Server.$.params.state)?.contentKey;
  if (contentKey) Hooks.trigger('core.alteration', { categoryIndex: categoryIndex, contentKey, invalidateList: true });
});
const cmdToggleListStyle = Server.command(userKey => {
  db.storage.set(`user.oldStyle.${userKey}`, db.storage.get(`user.oldStyle.${userKey}`) ? null : true);
});

Server.get('/manage/group/:groupID', $ => {
  if (!$.group) {
    return <Co.Page title="No such group">
      <ul class="form">
        <p>No group with ID <b>{$.params.groupID}</b>.</p>
        <hr />
        <Co.InlineMenu>
          <Co.Link action="/manage/group" args={{ value: $.params.groupID }}>Create group</Co.Link>
        </Co.InlineMenu>
      </ul>
    </Co.Page>
  }
  const items = db.query(`SELECT 
    c.contentKey AS contentKey, 
    c.categoryIndex AS categoryIndex, 
    c.contentID AS contentID, 
    c.createdDate AS createdDate,
    c.updatedDate AS updatedDate, 
    c.countDownloads AS countDownloads, 
    c.countComplains AS countComplains, 
    c.flagsDisabled AS flagsDisabled, 
    c.dataAuthor AS dataAuthor,
    c.dataName AS dataName,
    c.dataVersion AS dataVersion,
    c.flagSearcheable AS flagSearcheable, 
    c.flagLimited AS flagLimited, 
    c.flagOriginal AS flagOriginal, 
    GROUP_CONCAT(a.contentID, ", ") AS alternativeIds 
    FROM ${DBTbl.Content} c 
    LEFT JOIN ${DBTbl.AlternativeIDs} a ON c.contentKey = a.contentKey 
    WHERE c.userKey=?1 AND c.groupKey=?2 
    GROUP BY c.contentID
    ${DBTbl.Content.order('c')}`).all($.user.userKey, $.group.groupKey);

  if (!db.storage.get(`user.oldStyle.${$.user.userKey}`)) {
    return <Co.Page title={$.groups.length > 1 ? `Group/${$.group.name}` : 'Your content'} search>
      {items.length == 0 ? <ul></ul> :
        <table class="advtable">
          <tr>
            <th onclick="reorder(this)" style="width:40px" rowspan="2">Type</th>
            <th onclick="reorder(this, null, true)" data-sort="1" rowspan="2">Entry</th>
            <th onclick="reorder(this)" rowspan="2" style="width:80px">Version</th>
            <th onclick="reorder(this)" rowspan="2">Author</th>
            <th onclick="reorder(this)" rowspan="2" style="width:140px">Created</th>
            <th colspan="2">Stats</th>
            <th colspan="4">Flags</th>
          </tr>
          <tr>
            <th onclick="reorder(this, 5)" title={Locale.hints.countDownloads} style="width:80px;font-size:0.8em">Downloads</th>
            <th onclick="reorder(this, 6)" title={Locale.hints.countComplains} style="width:80px;font-size:0.8em">Complains</th>
            <th onclick="reorder(this, 7)" style="width:68px;font-size:0.8em">Enabled</th>
            <th onclick="reorder(this, 8)" title={Locale.hints.flagSearcheable} style="width:68px;font-size:0.8em">Searchable</th>
            <th onclick="reorder(this, 9)" title={Locale.hints.flagLimited} style="width:68px;font-size:0.8em">Limited</th>
            <th onclick="reorder(this, 10)" title={Locale.hints.flagOriginal} style="width:68px;font-size:0.8em">Scratch-made</th>
          </tr>
          {ContentCategories.map((c, i) => [c, items.filter(x => x.categoryIndex == i)]).filter(e => e[1].length > 0).map(([c, items]) => items.map((x, i) => <>
            <G $id={x.contentKey} />
            <tr class="mainrow" data-search={[x.contentID, x.dataName, x.dataVersion, x.dataAuthor].filter(Boolean).join('\n')}>
              <th data-sortable-cell rowspan={items.length * 2} data-search-attr={`rowspan:2:${items.length * 2}`} class={i === 0 ? null : "search-unhide"}>{c.title}</th>
              <td>
                <Co.Link href={U`/manage/${ContentCategories[x.categoryIndex].id}/${x.contentID}`}>{x.dataName || x.contentID}</Co.Link></td>
              <td>{x.dataVersion}</td>
              <td>
                {x.dataAuthor}
                <Co.Link query={`Author for ${x.contentID}:`} default={x.dataAuthor} action={cmdSetAuthorName(x.categoryIndex, x.contentID)}>✍</Co.Link></td>
              <td><Co.Date value={x.createdDate} /></td>
              <td>{x.countDownloads}</td>
              <td>{x.countComplains}</td>
              <td><Co.Switch state={!(x.flagsDisabled & DisabledFlag.USER)} action={cmdToggleFlagDisabled(x.categoryIndex, x.contentID)} /></td>
              <td><Co.Switch state={x.flagSearcheable} action={cmdToggleFlagSearchable(x.categoryIndex, x.contentID)} /></td>
              <td><Co.Switch state={x.flagLimited} action={cmdToggleFlagLimited(x.categoryIndex, x.contentID)} /></td>
              <td><Co.Switch state={x.flagOriginal} action={cmdToggleFlagOriginal(x.categoryIndex, x.contentID)} /></td>
            </tr>
            <tr class="details">
              <td>
                {x.flagsDisabled & DisabledFlag.BLOCKED ? <Co.Value title="blocked" class="warn">Blocked</Co.Value>
                  : x.flagsDisabled & DisabledFlag.HIDDEN ? <Co.Value title="hidden" class="warn">Hidden</Co.Value>
                    : x.flagsDisabled & DisabledFlag.PROCESSING ? <Co.Value title="processing" class="notice">Processing</Co.Value>
                      : null}
              </td>
              <td colspan="4" style="text-align:left">
                {`ID: ${x.contentID}${x.alternativeIds ? `, also includes: ${x.alternativeIds}` : ''}`}
              </td>
              <td colspan="5">
                <Co.InlineMenu>
                  {$.groups.length > 1 ? <Co.Link action="/manage/command/content-move" args={{ contentID: x.contentID, categoryID: ContentCategories[x.categoryIndex].id, groupID: $.groups.map(x => ({ value: x.groupID, name: x.name, selected: x.groupID === $.group.groupID })), location: 'current' }}>Move to</Co.Link> : null}
                  <Co.Link action={U`/manage/${ContentCategories[x.categoryIndex].id}/${x.contentID}`} args={{ 'delete': true, location: 'current' }} query={`Delete ${x.contentID}?`}>Delete…</Co.Link>
                </Co.InlineMenu>
              </td>
            </tr>
          </>))}
        </table>
      }
      <hr />
      <Co.InlineMenu>
        <Co.Dropdown href="#" label="Add…">{Hooks.trigger('core.menu.add', ContentCategories.filter(x => !x.limited || $.user.allowedFilter === '*').map(n => <Co.Link action={U`/manage/group/${$.params.groupID}`} args={{ categoryID: n.id }} query={`New ${n.name} ID (if there are several, list the first one):`}>Add {n.name}…</Co.Link>))}</Co.Dropdown>
        <Co.Link action="/manage/command/group-rename" args={{ groupID: $.params.groupID }} query="New name:" default={$.group.name}>Rename group…</Co.Link>
        <Co.Link action={cmdToggleListStyle($.user.userKey)}>Switch to list view</Co.Link>
      </Co.InlineMenu>
    </Co.Page>;
  }

  return <Co.Page title={$.groups.length > 1 ? `Group/${$.group.name}` : 'Your content'}>
    <ul class="form">{ContentCategories.map((c, i) => [c, items.filter(x => x.categoryIndex == i)]).filter(e => e[1].length > 0).map(([c, items]) => <>
      <h3>{c.title}s</h3>{items.map(x =>
        <li class="details">
          <Co.Link href={U`/manage/${ContentCategories[x.categoryIndex].id}/${x.contentID}`}>{x.dataName ? `${x.dataName} (${x.contentID})` : x.contentID}</Co.Link>
          <div>
            <Co.InlineMenu>
              {x.dataVersion != null ? <>v{x.dataVersion}</> : null}
              {x.dataAuthor != null ? <>Author: {x.dataAuthor}</> : null}
              {x.countDownloads > 0 ? <Co.Value title="countDownloads">Downloads: {x.countDownloads}</Co.Value> : null}
              {x.countComplains > 0 ? <Co.Value title="countComplains">Complains: {x.countComplains}</Co.Value> : null}
              <>Created: <Co.Date value={x.createdDate} /></>
              {x.updatedDate != x.createdDate ? <>Updated: <Co.Date value={x.updatedDate} /></> : null}
            </Co.InlineMenu>
            <br />
            <Co.InlineMenu>
              {x.flagsDisabled & DisabledFlag.BLOCKED ? <Co.Value title="blocked" class="warn">Blocked</Co.Value>
                : x.flagsDisabled & DisabledFlag.USER ? <>Disabled</>
                  : x.flagsDisabled & DisabledFlag.HIDDEN ? <Co.Value title="hidden" class="warn">Hidden</Co.Value>
                    : x.flagsDisabled & DisabledFlag.PROCESSING ? <Co.Value title="processing" class="notice">Processing</Co.Value>
                      : null}
              {x.flagSearcheable ? <Co.Value title="flagSearcheable">Searchable</Co.Value> : ''}
              {$.groups.length > 1 ? <Co.Link action="/manage/command/content-move" args={{ contentID: x.contentID, categoryID: ContentCategories[x.categoryIndex].id, groupID: $.groups.map(x => ({ value: x.groupID, name: x.name, selected: x.groupID === $.group.groupID })), location: 'current' }}>Group</Co.Link> : null}
              <Co.Link action="/manage/command/content-toggle" args={{ contentID: x.contentID, categoryID: ContentCategories[x.categoryIndex].id, state: x.flagsDisabled & DisabledFlag.USER, location: 'current' }}>{x.flagsDisabled & DisabledFlag.USER ? 'Enable' : 'Disable'}</Co.Link>
              <Co.Link action="/manage/command/content-searchable-toggle" args={{ contentID: x.contentID, categoryID: ContentCategories[x.categoryIndex].id, state: !x.flagSearcheable, location: 'current' }}>{x.flagSearcheable ? 'Remove from search' : 'Add to search'}</Co.Link>
              <Co.Link action={U`/manage/${ContentCategories[x.categoryIndex].id}/${x.contentID}`} args={{ 'delete': true, location: 'current' }} query={`Delete ${x.contentID}?`}>Delete…</Co.Link>
            </Co.InlineMenu>
            {x.alternativeIds ? <><br />Also includes: {x.alternativeIds}</> : null}
          </div>
        </li>)}</>)}
    </ul><ul>
      <hr />
      <Co.InlineMenu>
        <Co.Dropdown href="#" label="Add…">{ContentCategories.filter(x => !x.limited || $.user.allowedFilter === '*').map(n => <Co.Link action={U`/manage/group/${$.params.groupID}`} args={{ categoryID: n.id }} query={`New ${n.name} ID (if there are several, list the first one):`}>Add {n.name}…</Co.Link>)}</Co.Dropdown>
        <Co.Link action="/manage/command/group-rename" args={{ groupID: $.params.groupID }} query="New name:" default={$.group.name}>Rename group…</Co.Link>
        <Co.Link action={cmdToggleListStyle($.user.userKey)}>Switch to table view</Co.Link>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

Server.post('/manage/group/:groupID', $ => {
  $.writes();
  $.verifyID($.categoryIndex, $.id);

  using w = db.write();
  const contentKey = w.query(`INSERT INTO ${DBTbl.Content} (categoryIndex, contentID, groupKey, userKey, dataName) VALUES (?1, ?2, ?3, ?4, ?5)`).run($.categoryIndex, $.id, $.group.groupKey, $.user.userKey, $.params.value.replace(/_+/g, ' ').trim()).lastInsertRowid;

  if ($.userData.dataAuthor) w.query(`UPDATE ${DBTbl.Content} SET dataAuthor=?2 WHERE contentKey=?1`).run(contentKey, $.userData.dataAuthor);
  if ($.userData.flagSearcheable) w.query(`UPDATE ${DBTbl.Content} SET flagSearcheable=true WHERE contentKey=?1`).run(contentKey);
  if ($.userData.flagOriginal) w.query(`UPDATE ${DBTbl.Content} SET flagOriginal=true WHERE contentKey=?1`).run(contentKey);
  if ($.userData.flagLimited) w.query(`UPDATE ${DBTbl.Content} SET flagLimited=true WHERE contentKey=?1`).run(contentKey);
  if ($.userData.cleanInstallation) w.query(`UPDATE ${DBTbl.Content} SET contentData=?2 WHERE contentKey=?1`).run(contentKey, JSON.stringify({ cleanInstallation: true }));

  return U`/manage/${$.params.categoryID}/${$.id}`;
});

Server.get('/manage/:categoryID/:contentID', $ => {
  const entry = db.query(`SELECT * FROM ${DBTbl.Content} WHERE categoryIndex=?1 AND contentID=?2`).get($.categoryIndex, $.params.contentID);
  if (!entry) return null;

  const contentData = JSON.parse(entry.contentData);
  const liveUpdating = $.liveUpdating(entry.flagsDisabled & DisabledFlag.PROCESSING ? '3 s' : '10 s', <>
    {(entry.flagsDisabled & DisabledFlag.BLOCKED)
      ? <li class="warn">Blocked: <Co.Value title={contentData.blockedReason ? `Reason: ${contentData.blockedReason}` : Locale.hints.blocked}>yes</Co.Value></li>
      : null}
    {(entry.flagsDisabled & DisabledFlag.HIDDEN)
      ? <li class="warn">Hidden: <Co.Value title={[contentData.hiddenReasons, contentData.hiddenUpdateUrlReason && `Failed to process uploaded file: ${contentData.hiddenUpdateUrlReason}`].filter(Boolean).join('\n')}>yes</Co.Value></li>
      : null}
    {(entry.flagsDisabled & DisabledFlag.PROCESSING)
      ? <li class="notice">Processing: <Co.Value title="processing">yes</Co.Value></li>
      : null}
  </>, <>
    <li><Co.Value title="countDownloads">Downloads: {entry.countDownloads}</Co.Value></li>
    <li><Co.Value title="countComplains">Complains: {entry.countComplains}</Co.Value></li>
  </>, entry.flagsDisabled === 0 && contentData.updateUrl && !entry.flagLimited
    ? <Co.Link href={U`/registry/${$.params.categoryID}/${entry.contentID}/get`} title="You can use this URL for a quick download on your website or social media to count downloads" onclick={`navigator.clipboard.writeText(this.href);this.textContent="Download URL copied"`}>Copy download URL</Co.Link>
    : <Co.Link disabled title="Download URLs won’t work for disabled, hidden, blocked entries, or entries being processed">Download URL is not available</Co.Link>);

  const alternativeIds = db.query(`SELECT * FROM ${DBTbl.AlternativeIDs} WHERE contentKey=?1`).all(entry.contentKey).map(x => x.contentID);
  if (!$.signed) {
    if (entry.flagsDisabled & DisabledFlag.USER) return null;
    const contentData = JSON.parse(entry.contentData);
    return <Co.Page center title={<>{entry.dataName ? `${entry.dataName} (${entry.contentID})` : entry.contentID}</>}>
      {liveUpdating[0]}
      <li>Author: <Co.UserLink userID={DBTbl.Users.userID(entry.userKey)} /></li>
      <li>Downloads: <Co.Value title="countDownloads">{entry.countDownloads}</Co.Value></li>
      <li>Created: <Co.Date value={entry.createdDate} /></li>
      <li>Updated: <Co.Date value={entry.updatedDate} /></li>
      <li>Version: <Co.Value placeholder="not set">{entry.dataVersion}</Co.Value></li>
      {alternativeIds.length > 0
        ? <li>Also includes <Co.Value>{alternativeIds.join(', ')}</Co.Value></li>
        : null}
      {contentData.informationUrl
        ? <li>More information: <Co.Value><a href={contentData.informationUrl}>{contentData.informationUrl}</a></Co.Value></li>
        : null}
      <Co.Tags tags={[ContentCategories[entry.categoryIndex].id, entry.flagSearcheable && 'searchable', entry.flagOriginal && 'scratch-made' || 'ported']} />
    </Co.Page>
  }

  $.user;

  const group = $.groups.filter(x => x.groupKey === entry.groupKey)[0];
  if (group) $.currentGroup = group.groupID;

  const authorID = entry.userKey !== $.user.userKey && DBTbl.Users.userID(entry.userKey);
  const editable = entry.userKey === $.user.userKey || $.can(Access.MODERATE);
  const extras = {
    active: (entry.flagsDisabled & DisabledFlag.USER) === 0,
    blocked: (entry.flagsDisabled & DisabledFlag.BLOCKED) !== 0,
    alternativeIds: alternativeIds.join('\n')
  };
  return <Co.Page title={<>
    {group && $.groups.length > 1 ? <><a href={U`/manage/group/${group.groupID}`}>{group.name}</a>/</> : null}
    {ContentCategories[entry.categoryIndex].title}: {entry.dataName ? `${entry.dataName} (${entry.contentID})` : entry.contentID}
  </>}>
    {editable ? <Co.MainForm.Start /> : null}
    <ul class="form">
      {liveUpdating[0]}
      {authorID ? <li>Author: <Co.UserLink userID={authorID} /></li> : null}
      <li>Created: <Co.Date value={entry.createdDate} /></li>
      <li>Updated: <Co.Date value={entry.updatedDate} /></li>
      {liveUpdating[1]}
      {editable ? <G $hook={{ 'core.tpl.content.editorRows': { entry, contentData } }}>
        <hr />
        {group && $.groups.length > 1 ? <li><label for="group">Group</label><select id="group" name="data-group">{$.groups.map(x => <option value={x.groupID} selected={x.groupKey === entry.groupKey}>{x.name}</option>)}</select></li> : null}
        <Co.Row key="active" data={extras} default={true}>Active</Co.Row>
        <Co.Row key="alternativeIds" data={extras} multiline>Alternate IDs</Co.Row>
        <Co.Row key="dataName" data={entry} placeholder={entry.contentID}>Name</Co.Row>
        <Co.Row key="dataAuthor" data={entry} placeholder={$.userData.dataAuthor} options={$.authorSuggestions(entry.userKey)}>Author</Co.Row>
        <Co.Row key="dataVersion" data={entry} placeholder="0" attributes={{ 'data-version-input': true }}>Version</Co.Row>
        <Co.Row key="changelog" data={contentData} multiline>Changelog</Co.Row>
        <Co.Row key="informationUrl" data={contentData}>Information URL</Co.Row>
        <Co.Row key="updateUrl" input-hook="core.tpl.content.uploadURL" data={contentData}>Update URL</Co.Row>
        <Co.Row key="flagLimited" data={entry} default={false}>Disable direct downloads</Co.Row>
        <Co.Row key="cleanInstallation" data={contentData} default={false}>Force clean installation</Co.Row>
        {ContentCategories[entry.categoryIndex].portable && $.can(Access.FLAG_ORIGINAL) ? <Co.Row key="flagOriginal" data={entry} default={false}>Scratch-made</Co.Row> : null}
        {$.can(Access.FLAG_SEARCHEABLE) ? <Co.Row key="flagSearcheable" data={entry} default={true}>Allow searching for</Co.Row> : null}
      </G> : null}
    </ul><ul class="form">
      <hr />
      {editable ? <Co.InlineMenu>
        <Co.MainForm.End>Save changes</Co.MainForm.End>
        {liveUpdating[2]}
        <Co.Link action="/manage/command/content-reset-complains" args={{ contentID: entry.contentID, categoryID: $.params.categoryID }} query={`Reset complains counter for ${entry.contentID}?`}>Reset complains counter…</Co.Link>
        <Co.Link action={U`/manage/${$.params.categoryID}/${entry.contentID}`} args={{ 'delete': true }} query={`Delete ${entry.contentID}?`}>Delete entry…</Co.Link>
        {$.can(Access.MODERATE)
          ? <Co.Link action="/manage/command/content-block" args={{ contentID: entry.contentID, categoryID: $.params.categoryID }} query={!extras.blocked && `Block reason for ${entry.contentID}:`}>{extras.blocked ? `Unblock ${ContentCategories[entry.categoryIndex].name}` : `Block ${ContentCategories[entry.categoryIndex].name}…`}</Co.Link> : null}
        {extras.blocked && !$.can(Access.MODERATE)
          ? <Co.Link feedback={`On the subject of ${ContentCategories[entry.categoryIndex].name} ${entry.contentID}`}>Ask to unblock {ContentCategories[entry.categoryIndex].name}…</Co.Link> : null}
      </Co.InlineMenu> : <Co.InlineMenu>
        <Co.Link feedback={`On the subject of ${ContentCategories[entry.categoryIndex].name} ${entry.contentID}`}>Report {ContentCategories[entry.categoryIndex].name}…</Co.Link>
      </Co.InlineMenu>}
    </ul>
  </Co.Page>;
});

const downloadableContent = new DownloadableSource('c', DBTbl.Content, (entry, processing, errorMessage) => {
  const curData = JSON.parse(entry.contentData);
  if (entry.flagsDisabled.hasFlag(DisabledFlag.PROCESSING) != !processing
    && entry.flagsDisabled.hasFlag(DisabledFlag.HIDDEN) != !errorMessage
    && entry.hiddenUpdateUrlReason === errorMessage) return;

  curData.hiddenUpdateUrlReason = errorMessage;
  DBTbl.Content.update(entry.contentKey, {
    flagsDisabled: entry.flagsDisabled.setFlag(DisabledFlag.PROCESSING, processing).setFlag(DisabledFlag.HIDDEN, errorMessage || curData.hiddenReasons),
    contentData: DBTbl.Content.encodeContentData(curData)
  });

  if ((!processing && !errorMessage) != (entry.flagsDisabled === 0)) {
    Hooks.trigger('core.alteration', { categoryIndex: entry.categoryIndex, contentKey: entry.contentKey, invalidateList: true });
  }
}, contentKey => {
  const entry = db.query(`SELECT categoryIndex, contentID, dataName FROM ${DBTbl.Content} WHERE contentKey=?1`).get(contentKey);
  return entry && <Co.Link href={U`/manage/${ContentCategories[entry.categoryIndex].id}/${entry.contentID}`}>{ContentCategories[entry.categoryIndex].name} {entry.dataName || entry.contentID}</Co.Link>;
});

Server.post('/manage/:categoryID/:contentID', $ => {
  const entry = $.writes(db.query(`SELECT * FROM ${DBTbl.Content} WHERE categoryIndex=?1 AND contentID=?2`).get($.categoryIndex, $.params.contentID));
  if (!entry) return null;

  const curData = JSON.parse(entry.contentData);
  Hooks.trigger('core.post.content.editorRows', { $, entry, contentData: curData });

  if ($.params.delete) {
    const curIDs = db.query(`SELECT * FROM ${DBTbl.AlternativeIDs} WHERE contentKey=?1`).all(entry.contentKey).map(x => x.contentID);
    $.undo(`${ContentCategories[entry.categoryIndex].title} ${entry.contentID} removed.`, $ => {
      $.verifyID(entry.categoryIndex, entry.contentID);
      if (DBTbl.Content.exists(entry.contentKey)) delete entry.contentKey;
      entry.contentKey = DBTbl.Content.insert(entry);
      for (const id of curIDs) {
        $.verifyID(entry.categoryIndex, id);
        db.query(`INSERT INTO ${DBTbl.AlternativeIDs} (contentKey, categoryIndex, contentID) VALUES (?1, ?2, ?3)`).run(entry.contentKey, entry.categoryIndex, id);
      }
      Hooks.trigger('core.alteration', { categoryIndex: entry.categoryIndex, contentKey: entry.contentKey, invalidateList: true });
      downloadableContent.report(entry, false, curData.updateUrl);
    });
    {
      using _ = db.write().start();
      db.query(`DELETE FROM ${DBTbl.Content} WHERE contentKey=?1`).run(entry.contentKey);
      db.query(`DELETE FROM ${DBTbl.AlternativeIDs} WHERE contentKey=?1`).run(entry.contentKey);
    }
    Hooks.trigger('core.alteration', { categoryIndex: entry.categoryIndex, contentKey: entry.contentKey, invalidateList: true });
    downloadableContent.report(entry, curData.updateUrl, false);
    return U`/manage/group/${db.query(`SELECT groupID FROM ${DBTbl.Groups} WHERE groupKey=?1`).get(entry.groupKey).groupID}`;
  }

  {
    using _ = db.write().start();
    // $.params['data-updateUrl'] = cleanURL($.params['data-updateUrl'])

    const newData = $.form({
      changelog: db.row.text(),
      informationUrl: db.row.text(),
      updateUrl: db.row.text(),
      cleanInstallation: db.row.boolean(),
    }, curData);

    const newEntry = $.form({
      flagsDisabled: entry.flagsDisabled.setFlag(DisabledFlag.USER, $.params['data-active'] !== 'on'),
      flagSearcheable: $.can(Access.FLAG_SEARCHEABLE) && db.row.boolean(),
      flagOriginal: $.can(Access.FLAG_ORIGINAL) && db.row.boolean(),
      flagLimited: db.row.boolean(),
      dataName: db.row.text(),
      dataAuthor: db.row.text(),
      dataVersion: db.row.text(),
    }, entry);

    newData.hiddenReasons = ContentUtils.verifyValidity(newEntry, newData);
    const downloadableState = downloadableContent.reportInline(entry, curData.updateUrl, newData.updateUrl);
    newData.hiddenUpdateUrlReason = downloadableState.errorMsg;
    newEntry.flagsDisabled = newEntry.flagsDisabled
      .setFlag(DisabledFlag.PROCESSING, downloadableState.processing)
      .setFlag(DisabledFlag.HIDDEN, newData.hiddenReasons.length > 0 || newData.hiddenUpdateUrlReason);

    if (newEntry.flagsDisabled != entry.flagsDisabled) {
      db.query(`UPDATE ${DBTbl.Content} SET flagsDisabled=?2 WHERE contentKey=?1`).run(entry.contentKey, newEntry.flagsDisabled);
    }

    db.query(`UPDATE ${DBTbl.Content} SET contentData=?2, dataName=?3, dataAuthor=?4 WHERE contentKey=?1`).run(entry.contentKey, DBTbl.Content.encodeContentData(newData), newEntry.dataName, newEntry.dataAuthor);
    if (Utils.hostFromURL(curData.updateUrl) !== Utils.hostFromURL(newData.updateUrl)) {
      db.query(`UPDATE ${DBTbl.Content} SET countComplains=0 WHERE contentKey=?1`).run(entry.contentKey);
    }

    if (newEntry.flagSearcheable !== entry.flagSearcheable) {
      db.query(`UPDATE ${DBTbl.Content} SET flagSearcheable=?2 WHERE contentKey=?1`).run(entry.contentKey, newEntry.flagSearcheable);
    }

    if (newEntry.flagOriginal !== entry.flagOriginal) {
      db.query(`UPDATE ${DBTbl.Content} SET flagOriginal=?2 WHERE contentKey=?1`).run(entry.contentKey, newEntry.flagOriginal);
    }

    if (newEntry.flagLimited !== entry.flagLimited) {
      db.query(`UPDATE ${DBTbl.Content} SET flagLimited=?2 WHERE contentKey=?1`).run(entry.contentKey, newEntry.flagLimited);
    }

    if (newEntry.dataVersion !== entry.dataVersion) {
      db.query(`UPDATE ${DBTbl.Content} SET dataVersion=?2, updatedDate=?3 WHERE contentKey=?1`).run(entry.contentKey, newEntry.dataVersion, new Date() / 1e3);
    }

    Hooks.trigger('core.alteration', {
      categoryIndex: entry.categoryIndex,
      contentKey: entry.contentKey,
      invalidateList: newEntry.flagLimited !== entry.flagLimited
        || newEntry.flagOriginal !== entry.flagOriginal
        || newEntry.flagSearcheable !== entry.flagSearcheable
        || newEntry.dataVersion !== entry.dataVersion
        || (newEntry.flagsDisabled === 0) != (entry.flagsDisabled === 0)
    });

    const newGroup = $.params['data-group'] != null ? $.groups.filter(x => x.groupID == $.params['data-group'])[0] : null;
    if (newGroup) {
      db.query(`UPDATE ${DBTbl.Content} SET groupKey=?2 WHERE contentKey=?1`).run(entry.contentKey, newGroup.groupKey);
    }
  }

  if ($.params['data-alternativeIds'] != null) {
    const newIDs = [...new Set($.params['data-alternativeIds'].split(/[\n,]/).map(x => x.trim().toLowerCase()).filter(Boolean))].sort();
    const curIDs = db.query(`SELECT contentID FROM ${DBTbl.AlternativeIDs} WHERE contentKey=?1`).all(entry.contentKey).map(x => x.contentID).sort();
    if (!Bun.deepEquals(newIDs, curIDs)) {
      {
        using _ = db.write().start();
        for (const id of curIDs) {
          if (newIDs.includes(id)) continue;
          db.query(`DELETE FROM ${DBTbl.AlternativeIDs} WHERE categoryIndex=?1 AND contentID=?2`).run(entry.categoryIndex, id);
        }
        for (const id of newIDs) {
          if (curIDs.includes(id)) continue;
          $.verifyID(entry.categoryIndex, id);
          db.query(`INSERT INTO ${DBTbl.AlternativeIDs} (contentKey, categoryIndex, contentID) VALUES (?1, ?2, ?3)`).run(entry.contentKey, entry.categoryIndex, id);
        }
      }
      Hooks.trigger('core.alteration', { categoryIndex: entry.categoryIndex, contentKey: entry.contentKey, invalidateList: true });
    }
  }

  return U`/manage/${$.params.categoryID}/${$.params.contentID}`;
});

Server.get('/manage/group', $ => {
  const groups = db.query(`SELECT g.groupID, g.name, COUNT(c.contentID) AS count FROM ${DBTbl.Groups} g LEFT JOIN ${DBTbl.Content} c ON g.groupKey = c.groupKey WHERE g.userKey=?1 GROUP BY g.groupID ${DBTbl.Groups.order('g')}`).all($.user.userKey);
  return <Co.Page title="Groups">
    <ul class="form">{groups.map((x, i) =>
      <li class="details">
        <a href={U`/manage/group/${x.groupID}`}>{x.name} ({x.count})</a>
        <div>
          <Co.InlineMenu>
            <Co.Link action="/manage/command/group-rename" args={{ groupID: x.groupID, location: 'current' }} query="New name:" default={x.name}>Rename group…</Co.Link>
            {i > 0 ? <Co.Link action="/manage/command/group-delete" args={{ groupID: x.groupID, location: 'current' }} query={`Are you sure to delete group ${x.name}?${x.count > 0 ? ` Items will be moved to ${groups[0].name}.` : ''}`}>Delete group…</Co.Link> : null}
          </Co.InlineMenu>
        </div>
      </li>)}<hr />
      <Co.InlineMenu>
        <Co.Link action="/manage/group" query="New group name:">Add group…</Co.Link>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

// Users:
Server.get('/manage/tool/password', $ => {
  $.user;
  return <Co.Page title="Change password…">
    <Co.MainForm.Start autocomplete />
    <ul class="form" $hook="core.tpl.changePasswordForm">
      <Co.Row key="pass0" attributes={{ type: 'password', autocomplete: 'current-password', required: true }}>Current password</Co.Row>
      <Co.Row key="pass1" attributes={{ type: 'password', autocomplete: 'new-password', required: true }}>New password</Co.Row>
      <Co.Row key="pass2" attributes={{ type: 'password', autocomplete: 'new-password', required: true }}>One more time</Co.Row>
      <hr />
      <Co.InlineMenu>
        <Co.MainForm.End>Save changes</Co.MainForm.End>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

Server.post('/manage/tool/password', $ => {
  if (!$.params['data-pass0'] || !$.params['data-pass1']) throw $.requestError('Please fill out the form');
  if ($.params['data-pass1'] !== $.params['data-pass2']) throw $.requestError('Passwords don’t match');
  const password = db.query(`SELECT password FROM ${DBTbl.Users} WHERE userKey=?1`).get($.user.userKey)?.password;
  if (password !== DBTbl.Users.passEncode($.user.userID, $.params['data-pass0'])) throw $.requestError('Current password is invalid');
  Hooks.trigger('core.user.changingPassword', $);
  return db.query(`UPDATE ${DBTbl.Users} SET password=?1 WHERE userKey=?2`).run(DBTbl.Users.passEncode($.user.userID, $.params['data-pass1']), $.user.userKey).changes ? '/manage' : null;
});

const ProfileSettings = {
  Editor({ user, userData, ctx$, intro }) {
    const $ = ctx$;
    const contacts = userData.contacts || {};
    return <>
      <h3>Profile settings:</h3>
      <Co.Row data={userData} key="profileName" placeholder={user.userID}>Profile name</Co.Row>
      <Co.Row data={userData} key="profileBio">Description</Co.Row>
      <Co.Row data={userData} key="profileUrl">Details URL</Co.Row>
      <h3>Default content settings:</h3>
      <Co.Row data={userData} key="dataAuthor" options={db.query(`SELECT dataAuthor, COUNT(*) AS count FROM ${DBTbl.Content} WHERE userKey=?1 GROUP BY dataAuthor ORDER BY count DESC`).all(user.userKey).map(x => x.dataAuthor)}>Author name</Co.Row>
      <Co.Row data={userData} key="flagLimited" default={false}>Disable direct downloads</Co.Row>
      <Co.Row data={userData} key="cleanInstallation" default={false}>Force clean installation</Co.Row>
      {$.can(Access.FLAG_ORIGINAL) ? <Co.Row data={userData} key="flagOriginal" default={false} forced-choice={intro}>Scratch-made</Co.Row> : null}
      {$.can(Access.FLAG_SEARCHEABLE) ? <Co.Row data={userData} key="flagSearcheable" default={true} forced-choice={intro}>Allow searching for</Co.Row> : null}
      <i $hook="core.tpl.userEditor">These settings are the ones used by default for new content entries. You can always change it for individual entries later.</i>
      <h3><span title="Just in case somebody would want to reach you (keep in mind, your contacts are publicly visible)">Contacts</span>:</h3>
      <Co.Row data={contacts} key="mail" attributes={{ type: 'email' }}>E-mail</Co.Row>
      <Co.Row data={contacts} key="steam">Steam</Co.Row>
      <Co.Row data={contacts} key="discord">Discord</Co.Row>
      <Co.Row data={contacts} key="telegram">Telegram</Co.Row>
    </>;
  },
  Info({ user, userData }) {
    const r = [];
    if (!user.introduced) r.push(<p><Co.Value placeholder="User hasn’t completed introduction yet" /></p>);
    if (userData.profileName) r.push(<h2>{userData.profileName}</h2>);
    if (userData.profileBio) r.push(<li>{userData.profileBio}</li>);
    if (userData.profileUrl) r.push(<li><a href={userData.profileUrl.replace(/^(?!https?:\/\/)/, 'https://')}>{userData.profileUrl}</a></li>);
    for (const k in userData.contacts || {}) {
      r.push(<li>{Utils.social(k)}: <a href={Utils.social(k, userData.contacts[k])}>{userData.contacts[k]}</a></li>);
    }
    if (r.length) r.push(<hr />);
    return r;
  },
  Stats({ user, userData }) {
    const total = db.query(`SELECT COUNT(*) AS count, SUM(countDownloads) AS downloads, SUM(countComplains) AS complains FROM ${DBTbl.Content} WHERE userKey=?1`).get(user.userKey);
    const totalAlts = db.query(`SELECT COUNT(*) AS count FROM ${DBTbl.AlternativeIDs} a JOIN ${DBTbl.Content} c ON a.contentKey = c.contentKey WHERE c.userKey=?1`).get(user.userKey);
    const active = db.query(`SELECT COUNT(*) AS count, SUM(countDownloads) AS downloads, SUM(countComplains) AS complains FROM ${DBTbl.Content} WHERE userKey=?1 AND flagsDisabled=0`).get(user.userKey);
    const activeAlts = db.query(`SELECT COUNT(*) AS count FROM ${DBTbl.AlternativeIDs} a JOIN ${DBTbl.Content} c ON a.contentKey = c.contentKey WHERE c.userKey=?1 AND flagsDisabled=0`).get(user.userKey);
    return <G $hook={{ "core.userStats": { user, userData } }}><h3>Stats:</h3>
      <li>Last seen: <Co.Date value={user.lastSeenDate} /></li>
      <li>Registered: <G $hook={{ "core.userStats.registered": { user, userData } }}><Co.Date value={user.createdDate} /></G></li>
      <li>Downloads: {total.downloads || 0}</li>
      <li>Complains: {total.complains || 0}</li>
      <li>Entries: {total.count}{totalAlts.count === 0 ? null : <> <span title="Number of entries taking alternate IDs into accout">({total.count + totalAlts.count})</span></>}</li>
      {active.count == total.count ? null : <li>Active: {active.count}{activeAlts.count === 0 ? null : <> <span title="Number of active entries taking alternate IDs into accout">({active.count + activeAlts.count})</span></>}</li>}
    </G>;
  },
  Content({ user }) {
    const r = Hooks.poll('core.user.content', user);
    if (r) return r;
    const total = db.query(`SELECT c.contentID AS contentID, c.flagsDisabled AS flagsDisabled, c.categoryIndex AS categoryIndex, c.dataName AS dataName, GROUP_CONCAT(a.contentID, ", ") AS alternativeIds FROM ${DBTbl.Content} c LEFT JOIN ${DBTbl.AlternativeIDs} a ON c.contentKey = a.contentKey WHERE c.userKey=?1 GROUP BY c.contentID ${DBTbl.Content.order('c')}`).all(user.userKey);
    if (total.length === 0) return null;
    return <>
      <hr />{ContentCategories.map((v, i) => [v.title, total.filter(y => y.categoryIndex == i)]).filter(x => x[1].length).map(x => <>
        <h3>{x[0]}s:</h3>{x[1].map(x => <li data-disabled={x.flagsDisabled !== 0}><a href={U`/manage/${ContentCategories[x.categoryIndex].id}/${x.contentID}`}>{x.dataName && x.dataName !== x.contentID ? `${x.dataName} (${x.contentID}${x.flagsDisabled & DisabledFlag.BLOCKED ? ', blocked' : x.flagsDisabled & DisabledFlag.USER ? ', disabled' : ''})` : `${x.contentID}${x.flagsDisabled & DisabledFlag.BLOCKED ? ' (blocked)' : x.flagsDisabled & DisabledFlag.USER ? ' (disabled)' : ''}`}</a>{x.alternativeIds ? <><br /><span class="details">Also includes: {x.alternativeIds}</span></> : null}</li>)}
      </>)}
    </>;
  },
  AccountAccess({ user, ctx$ }) {
    const $ = ctx$;
    if ($.can(Access.MODERATE)) {
      const total = db.query(`SELECT c.contentID AS contentID, c.categoryIndex AS categoryIndex, GROUP_CONCAT(a.contentID, ", ") AS alternativeIds FROM ${DBTbl.Content} c LEFT JOIN ${DBTbl.AlternativeIDs} a ON c.contentKey = a.contentKey WHERE c.userKey=?1 GROUP BY c.contentID ${DBTbl.Content.order('c')}`).all(user.userKey);
      return <>
        <h3>Account access:</h3>
        {user.userKey !== ctx$.user.userKey
          ? <Co.Row accessMask={user.accessMask}>Permissions</Co.Row>
          : <li>Permissions: <Co.PermissionsList value={user.accessMask} /></li>}
        <Co.Row data={user} key="allowedFilter" attributes={{ class: 'mono', 'data-allowed-filter-ids': JSON.stringify(total.map(x => [x.contentID, ...(x.alternativeIds ? x.alternativeIds.split(', ') : [])].map(y => `${ContentCategories[x.categoryIndex].maskID}:${y}`)).flat().filter(Boolean)) }}>ID filter</Co.Row>
      </>;
    }
    return <><h3>Account access:</h3>
      <li>Permissions: <Co.PermissionsList value={user.accessMask} /></li>
      <li>ID filter: <Co.Value placeholder="any" title={user.allowedFilter ? 'To keep things organized, please use IDs matching this filter' : 'You can use any IDs when registering content'} mono>{user.allowedFilter}</Co.Value></li>
    </>;
  },
  save($, userID) {
    using _ = db.write().start();
    const user = db.query(`SELECT * FROM ${DBTbl.Users} WHERE userID=?1`).get(userID);
    $.writes(user);
    if (!user.introduced) {
      db.query(`UPDATE ${DBTbl.Content} SET flagSearcheable=?2, flagOriginal=?3 WHERE userKey=?1`).run(user.userKey, $.params['data-flagSearcheable'] === 'on', $.params['data-flagOriginal'] === 'on');
    }
    if ($.params['data-allowedFilter'] != null && $.can(Access.MODERATE)) {
      const newMask = Object.values(Access).filter(x => $.params[`perm-${x}`] === 'on' && $.canSetPermission(x)).reduce((p, v) => p | v, 0);
      if (newMask != user.accessMask) {
        db.query(`UPDATE ${DBTbl.Users} SET accessMask=?2 WHERE userKey=?1`).run(user.userKey, newMask);
        if (!(newMask & Access.FLAG_SEARCHEABLE) && (user.accessMask & Access.FLAG_SEARCHEABLE)) {
          db.query(`UPDATE ${DBTbl.Content} SET flagSearcheable=false WHERE userKey=?1`).run(user.userKey);
        }
        if (!(newMask & Access.FLAG_ORIGINAL) && (user.accessMask & Access.FLAG_ORIGINAL)) {
          db.query(`UPDATE ${DBTbl.Content} SET flagOriginal=false WHERE userKey=?1`).run(user.userKey);
        }
      }
      if ($.params['data-allowedFilter'] !== user.allowedFilter) {
        db.query(`UPDATE ${DBTbl.Users} SET allowedFilter=?1 WHERE userKey=?2`).run($.params['data-allowedFilter'], user.userKey);
      }
    }
    db.query(`UPDATE ${DBTbl.Users} SET userData=?1, introduced=1 WHERE userKey=?2`).run(JSON.stringify(Object.assign(JSON.parse(user.userData), {
      profileName: $.params['data-profileName'] || null,
      profileBio: $.params['data-profileBio'] || null,
      profileUrl: $.params['data-profileUrl'] || null,
      dataAuthor: $.params['data-dataAuthor'] || null,
      contacts: {
        mail: $.params['data-mail'] || null,
        steam: $.params['data-steam'] || null,
        discord: $.params['data-discord'] || null,
        telegram: $.params['data-telegram'] || null,
      },
      flagLimited: $.params['data-flagLimited'] === 'on',
      cleanInstallation: $.params['data-cleanInstallation'] === 'on',
      flagOriginal: $.params['data-flagOriginal'] === 'on',
      flagSearcheable: $.params['data-flagSearcheable'] === 'on',
    })), user.userKey);
  },
}

Server.get('/manage/introduction', $ => {
  // $.user.introduced = false; // TODO
  if ($.user.introduced) return U`/manage/user/${$.user.userID}`;
  return <Co.Page title={`Hello, ${$.userData.name || $.user.userID}`}>
    <ul class="form">
      <Co.MainForm.Start />
      <p $hook="core.tpl.introduction.message">Just a couple more things before we proceed. You can always change these values later.</p>
      <ProfileSettings.Editor user={$.user} userData={$.userData} ctx$={$} intro={true} />
      <hr />
      <input type="hidden" name="redirect" value={$.params.redirect || ''} />
      <Co.MainForm.End active>Save & continue</Co.MainForm.End>
    </ul>
  </Co.Page>;
});

Server.post('/manage/introduction', $ => {
  ProfileSettings.save($, $.user.userID);
  Hooks.trigger('core.introduction.complete', $);
  return $.params.redirect || '/manage';
});

Server.get('/manage/user/:userID', $ => {
  $.user;
  const user = db.query(`SELECT * FROM ${DBTbl.Users} WHERE userID=?1`).get($.params.userID);
  if (!user) return null;
  const userData = JSON.parse(user.userData);
  if ($.user.userID == $.params.userID && $.can(Access.EDIT) || $.can(Access.MODERATE)) {
    return <Co.Page title={`${$.user.userID == $.params.userID ? 'Your profile' : 'Other’s profile'}, ${userData.name || user.userID}`}>
      <Co.MainForm.Start />
      <ul class="form">
        <ProfileSettings.Stats user={user} userData={userData} />
        <ProfileSettings.Content user={user} userData={userData} />
        <hr />
        <ProfileSettings.AccountAccess user={user} userData={userData} ctx$={$} />
        <hr />
        <ProfileSettings.Editor user={user} userData={userData} ctx$={$} />
        <hr />
        <Co.InlineMenu $hook={{ 'core.tpl.userPage.menu': { user } }}>
          <Co.MainForm.End>Save changes</Co.MainForm.End>
          {!$.can(Access.MODERATE)
            ? <Co.Link href="/manage/tool/password">Change password…</Co.Link>
            : $.can(Access.ADMIN)
              ? <Co.Link action="/manage/command/user-change-password" args={{ userID: user.userID }} query="New password:">Change password…</Co.Link>
              : null}
          {user.allowedFilter && !$.can(Access.MODERATE)
            ? <Co.Link feedback={`I want to change content ID filter`}>Request ID filter change…</Co.Link>
            : null}
          {$.user.userID == $.params.userID ? <Co.Link action="/manage/command/logout">Log out</Co.Link> : null}
        </Co.InlineMenu>
      </ul>
    </Co.Page>;
  }
  return <Co.Page title={<span data-online={$.isUserOnline(user.userID)}>{userData.name || user.userID}</span>}>
    <ul class="form">
      <ProfileSettings.Info user={user} userData={userData} />
      <ProfileSettings.Stats user={user} userData={userData} />
      <ProfileSettings.Content user={user} userData={userData} />
      <hr />
      <Co.InlineMenu>
        <Co.Link feedback={`On the subject of user ${user.userID}`}>Report user…</Co.Link>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

Server.post('/manage/user/:userID', $ => {
  ProfileSettings.save($, $.params.userID);
  return U`/manage/user/${$.params.userID}`;
});

// Index page:
Server.get('/', $ => new Response(formatGenericPage($, <Co.Page title="Hello World!" center>
  <G $hook="core.tpl.index.content">
    <p>CUP is a solution for content creators to auto-update their content or add it to a searchable registry for users to access.</p>
  </G>
  <p>
    <Co.InlineMenu $hook="core.tpl.index.menu">
      <Co.Link href="/manage">CUP</Co.Link>
    </Co.InlineMenu>
  </p>
</Co.Page>), { headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'max-age=3600, public' } }));

// Resources:
{
  const fs = require('fs');
  const resArgs = { headers: { 'Cache-Control': 'max-age=604800, public' } };
  const filesCache = new LazyMap(k => {
    if (k.endsWith('.js') || k.endsWith('.css')) {
      try {
        const data = [('' + fs.readFileSync('res/' + k)).replace(/(?<=^|\n)\/.*@include:(.+)\s*(?=\n)/g, (_, f) => fs.readFileSync(`res/${f.trim()}`))];
        Hooks.poll('core.res.' + k, data, filename => data.unshift(fs.readFileSync(filename)));
        return ((d, h) => new Response(d, h)).bind(null, Bun.deflateSync(prepareAsset(k.endsWith('.css') ? 'css' : 'js', data.join('\n'))),
          { headers: { 'Content-Type': Bun.file('res/' + k).type, 'Cache-Control': 'max-age=604800, public', 'Content-Encoding': 'deflate' } });
      } catch (e) {
        return () => new Response(null, { status: 404, headers: resArgs.headers });
      }
    }
    return () => new Response(Bun.file(k.startsWith('icon.') ? `${AppSettings.core.resDir}/favicon.ico` : `${AppSettings.core.resDir}/${k}`), resArgs);
  });
  if (AppSettings.core.monitorResources) {
    fs.watch(AppSettings.core.resDir, { recursive: true }, () => filesCache.clear());
  }
  Server.zone('/res', { handle: (req, url) => filesCache.get(url.pathname.substring(5))() });
  Server.get('/favicon.ico', $ => filesCache.get('favicon.ico')());
}
