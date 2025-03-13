function fixPage(root) {
  // Filling in timestamps using local timezone:
  root.querySelectorAll('[data-timestamp]').forEach(v => v.innerText = new Date(v.getAttribute('data-timestamp')).toLocaleString());
  root.querySelectorAll('[data-timestamp-title]').forEach(v => v.setAttribute('title', new Date(v.getAttribute('data-timestamp-title')).toLocaleString()));

  // Prompts or warnings for certain forms:
  root.querySelectorAll('form[data-form]').forEach(v => v.onsubmit = () => !!(v.querySelector('[name=value]').value = (v.getAttribute('data-form').endsWith(':') ? prompt : confirm)(v.getAttribute('data-form'), v.getAttribute('data-form-argument') || '')));

  // Some forms will be submit the moment selection has been made:
  root.querySelectorAll('[data-immediate]').forEach(v => v.querySelectorAll('input, select').forEach(x => x.addEventListener('change', () => v.submit())));

  // Some forms don’t have to reload the entire page:
  root.querySelectorAll('[data-live-apply]').forEach(v => {
    v.addEventListener('submit', async e => {
      e.preventDefault();
      let formData = new URLSearchParams();
      v.querySelectorAll('input').forEach(input => formData.set(input.name, input.value));
      await fetch(v.action, { method: 'POST', body: formData, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (window.updateLiveImpl) updateLiveImpl();
      if (v.getAttribute('data-live-apply')) new Function(v.getAttribute('data-live-apply')).call(v);
    });
  });

  // Inputs with data-password-toggle attribute can show password
  root.querySelectorAll('[data-password-toggle]').forEach(v => v.insertAdjacentHTML('beforebegin', '<span class="password-toggle" onclick="return togglePasswordType(this)">👀</span>'));

  // Pressing Ctrl+Enter in textarea inputs submits the form
  root.querySelectorAll('textarea').forEach(v => v.addEventListener('keydown', e => {
    if (e.which === 13 && !e.repeat && e.ctrlKey) {
      e.preventDefault();
      const link = e.target.form.querySelector('input[type=submit].good');
      if (link) link.click();
    }
  }));
}

function togglePasswordType(e) {
  const i = e.closest('li').querySelector('input');
  i.type = i.type === 'password' ? null : 'password';
  e.textContent = i.type === 'password' ? '👀' : '👓';
}

let cv = 0;
function toggleCustomView(mask, active) {
  cv = (cv & ~mask) | (active ? mask : 0);
  document.querySelectorAll('[data-search-attr]').forEach(e => e.getAttribute('data-search-attr').split(';')
    .forEach(y => /^(.+)?:(.+)?:(.+)$/.test(y) && e.setAttribute(RegExp.$1, cv ? RegExp.$2 : RegExp.$3)));
  document.body[cv ? 'setAttribute' : 'removeAttribute']('data-search-active', 1);
}

// Immediate on-page filtering:
document.querySelectorAll('[data-page-search]').forEach(i => {
  i.insertAdjacentHTML('beforeend', `<input placeholder=Search class=page-search>`);
  ['change', 'keyup', 'paste'].forEach(x => i.querySelector('.page-search').addEventListener(x, u => {
    const q = new RegExp('\\b' + u.target.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i');
    document.querySelectorAll('[data-search]').forEach(e => e.setAttribute('data-filtered', q.test(e.getAttribute('data-search'))));
    toggleCustomView(1, u.target.value);
  }));
});

// A simple thing for reordering columns in tables:
function reorder(w, j0, d0) {
  const a = w.getAttribute('data-sort') != 1;
  let j = [].map.call(w.closest('tr').querySelectorAll('th'), (t, i) => (t.removeAttribute('data-sort'), t == w && i)).filter(x => x !== false)[0];
  if (j0 != null) j = j0;
  w.setAttribute('data-sort', +a);
  const body = w.closest('table').querySelector('tbody');
  let r = '', e = [];
  body.querySelectorAll('tr').forEach(v => {
    const tds = v.querySelectorAll('td, [data-sortable-cell]');
    console.log(tds, j);
    if (tds.length === 0) r += v.outerHTML;
    else if (tds.length === 1 || v.matches('tr.details')) e[e.length - 1][0] += v.outerHTML;
    else e.push([v.outerHTML, tds[j].getAttribute('data-sort-by') || tds[j].childNodes[0]?.getAttribute && tds[j].childNodes[0]?.getAttribute('data-sort-by') || tds[j].textContent]);
  });
  body.innerHTML = r + e.sort((u, v) => u[1].localeCompare(v[1], undefined, { numeric: true, sensitivity: 'base' }) * (a ? 1 : -1)).map(x => x[0]).join('');
  localStorage.order = d0 && a ? null : `${location.pathname}\n${j}\n${+a}`;
  toggleCustomView(2, !d0 || !a);
}

{
  let e = /^(.+)\n(\d+)\n(\d+)$/.test(localStorage.order) && location.pathname === RegExp.$1 && document.querySelector(`th:nth-child(${1 + +RegExp.$2})`);
  if (e) {
    e.setAttribute('data-sort', 1 - RegExp.$3);
    e.click();
  }
}

function escapeRegExp(string) {
  return string.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
}

function escapeHTML(str) {
  return str && str.replace(/[\u00A0-\u9999<>\&]/gim, function (i) {
    return '&#' + i.charCodeAt(0) + ';';
  });
}

function filterToRegex(filter) {
  if (!filter) {
    filter = '.'
  } else if (filter[0] !== '`') {
    filter = filter.split(',').map(x => {
      x = x.trim();
      return /^(\w+)\s*:\s*(.+)/.test(x) ? `^${RegExp.$1[0].toLowerCase()}:${escapeRegExp(RegExp.$2)}$` : `^.:${escapeRegExp(x)}$`
    }).filter(Boolean).join('|');
  } else {
    filter = filter.substring(1);
  }
  return new RegExp(filter);
}

function setInputResult(input, value, title, clickable) {
  let r = input.parentNode.querySelector('.input-result');
  if (!r) {
    if (!value) return;
    r = document.createElement('div');
    r.classList.add('input-result');
    input.parentNode.appendChild(r);
    input.parentNode.style.position = 'relative';
  }
  if (!value) { r.remove(); return; }
  if (title) r.setAttribute('title', title);
  else r.removeAttribute('title');
  r.innerHTML = value;
  r.classList.toggle('notclickable', !clickable);
  r.classList.toggle('good', value[0] === '✔');
  r.classList.toggle('link', value[0] === '❌');
}

// A simple shortcut for form inputs to verify inputs and nicely show warnings:
[
  ['data-allowed-filter-ids', v => ((ids, i) => {
    try {
      if (i === '*') return `✔ Anything is allowed`;
      const r = filterToRegex(i);
      const m = ids.filter(x => !r.test(x));
      return m.length ? `❌ ${m.join(', ')}` : i ? `✔ Tests are passing` : `✔ Anything but apps is allowed`;
    } catch (e) {
      return `❌ Invalid expression: ${e.message}`;
    }
  }).bind(null, JSON.parse(v))],
  ['data-version-input', v => ((o, i) => {
    function semver(a, b) {
      if (a.startsWith(b + '-')) return -1;
      if (b.startsWith(a + '-')) return 1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'case', caseFirst: 'upper' })
    }
    return o === i ? null : semver(o, i) < 0 ? '✔ Version is newer' : '❌ Version is older';
  }).bind(null, v)]
].map(([attr, out]) => document.querySelectorAll(`[${attr}]`).forEach(v => [null, 'change', 'paste', 'keyup'].forEach(
  ((f, c) => c ? v.addEventListener(c, f) : f())
    .bind(null, (f => setInputResult(v, escapeHTML(f(v.value))))
      .bind(null, out(v.getAttribute(attr) || v.value))))));

// Mark edited fields as such, warn before leaving:
function editableProp(type) { return type === 'checkbox' ? 'checked' : type === 'file' ? 'files' : 'value'; }
if ([].map.call(document.querySelectorAll('form:not([data-immediate]):not([autocomplete]) label[for]'), v => [v, document.querySelector('#' + v.getAttribute('for'))]).filter(x => x[1]).map(x => [x[0], x[1], x[1][editableProp(x[1].type)]]).map(x => ['onchange', 'onkeyup', 'onpaste'].map(y => x[1][y] = () => { 
  const c = x[1][editableProp(x[1].type)] != x[2];
  x[0].setAttribute('data-changed', c);
  document.body.classList.toggle('any-edited', c || document.querySelectorAll('[data-changed=true]').length > 0);
})).length) {
  let unsaved = true;
  addEventListener('beforeunload', e => { if (unsaved && document.querySelectorAll('[data-changed=true]').length > 0) e.preventDefault(); });
  const i = document.querySelector('form:not([data-immediate]):not([autocomplete]) input.good');
  if (i) {
    i.addEventListener('click', () => { unsaved = false; });
    i.classList.add('disabled-unless-edited');
  }
}

// Thing for closing toasts:
function closeToast(e) {
  e.closest('.toast').remove();
  return false;
}

// Dropdown lists:
window.addEventListener('click', e => {
  if (e.target.classList && e.target.classList.contains('collapsing-float')) {
    e.target.classList.toggle('collapsing-active');
    e.preventDefault();
  }
  if (e.target.tagName === 'A' && e.target.parentNode && e.target.parentNode.classList && e.target.parentNode.classList.contains('dropdown')) {
    e.target.parentNode.classList.toggle('dropdown-active');
    e.preventDefault();
  }
  document.querySelectorAll('.dropdown-active').forEach(x => x.contains(e.target) || x.classList.remove('dropdown-active'));
});

const liveUpdates = document.querySelectorAll('live-updating');
if (liveUpdates.length > 0) {
  const period = liveUpdates[0].getAttribute('period') * 1e3;
  async function updateLiveImpl() {
    const data = (await (await fetch(location, { headers: { 'X-Live-Update': 1 } })).text()).split('\0');
    liveUpdates.forEach((v, i) => {
      const x = data[v.getAttribute('index') | 0];
      if (x != null && v.innerHTML !== x) {
        v.innerHTML = x;
        fixPage(v);
      }
    });
  }
  let unfocusedSkip = 0;
  function updateLiveCallback() {
    try {
      if (document.hasFocus() || --unfocusedSkip < 0) {
        unfocusedSkip = 100;
        updateLiveImpl();
      }
      setTimeout(updateLiveCallback, period);
    } catch (e) {
      console.warn(e);
      setTimeout(updateLiveCallback, period * 5);
    }
  };
  setTimeout(updateLiveCallback, period);
  window.updateLiveImpl = updateLiveImpl;
}

fixPage(document);
