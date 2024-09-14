function fixPage(root) {
  // Filling in timestamps using local timezone:
  root.querySelectorAll('[data-timestamp]').forEach(v => v.innerText = new Date(v.getAttribute('data-timestamp')).toLocaleString());
  root.querySelectorAll('[data-timestamp-title]').forEach(v => v.setAttribute('title', new Date(v.getAttribute('data-timestamp-title')).toLocaleString()));

  // Prompts or warnings for certain forms:
  root.querySelectorAll('form[data-form]').forEach(v => v.onsubmit = () => !!(v.querySelector('[name=value]').value = (v.getAttribute('data-form').endsWith(':') ? prompt : confirm)(v.getAttribute('data-form'), v.getAttribute('data-form-argument') || '')));

  // Some forms will be submit the moment selection has been made:
  root.querySelectorAll('[data-immediate]').forEach(v => v.querySelectorAll('input, select').forEach(x => x.addEventListener('change', () => v.submit())));

  // Some forms don’t have to reload the entire page:
    console.log(root.querySelectorAll('[data-live-apply]'));
  root.querySelectorAll('[data-live-apply]').forEach(v => {
    v.addEventListener('submit', async e => {
      e.preventDefault();
      let formData = new URLSearchParams();
      v.querySelectorAll("input").forEach(input => formData.set(input.name, input.value));
      await fetch(v.action, { method: 'POST', body: formData, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (window.updateLiveImpl) updateLiveImpl();
      if (v.getAttribute('data-live-apply')) new Function(v.getAttribute('data-live-apply')).call(v);
    });
  });

  root.querySelectorAll('[data-password-toggle]').forEach(v => v.insertAdjacentHTML('beforebegin', '<span class="password-toggle" onclick="return togglePasswordType(this)">👀</span>'))
}

function togglePasswordType(e) {
  const i = e.closest('li').querySelector('input');
  i.type = i.type === 'password' ? null : 'password';
  e.textContent = i.type === 'password' ? '👀' : '👓';
}

// Immediate on-page filtering:
document.querySelectorAll('[data-page-search]').forEach(i => {
  i.insertAdjacentHTML('beforeend', `<input placeholder=Search class=page-search>`);
  ['change', 'keyup', 'paste'].forEach(x => i.querySelector('.page-search').addEventListener(x, e => {
    const q = new RegExp('\\b' + e.target.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
    document.querySelectorAll('[data-search]').forEach(e => e.setAttribute('data-filtered', q.test(e.getAttribute('data-search'))));
  }));
});

// A simple thing for reordering columns in tables:
function reorder(w) {
  const a = w.getAttribute('data-sort') != 1;
  const j = [].map.call(w.closest('tr').querySelectorAll('th'), (t, i) => (t.removeAttribute('data-sort'), t == w && i)).filter(x => x !== false)[0];
  w.setAttribute('data-sort', +a);
  const body = w.closest('table').querySelector('tbody');
  let r = '', e = [];
  body.querySelectorAll('tr').forEach(v => {
    const tds = v.querySelectorAll('td');
    if (tds.length === 0) r += v.outerHTML;
    else if (tds.length === 1) e[e.length - 1][0] += v.outerHTML;
    else e.push([v.outerHTML, tds[j].textContent]);
  });
  body.innerHTML = r + e.sort((u, v) => u[1].localeCompare(v[1], undefined, { numeric: true, sensitivity: 'base' }) * (a ? 1 : -1)).map(x => x[0]).join('');
  localStorage.order = `${location.pathname}\n${j}\n${+a}`;
}

{
  let e = /^(.+)\n(\d+)\n(\d+)$/.test(localStorage.order) && location.pathname === RegExp.$1 && document.querySelector(`th:nth-child(${1 + +RegExp.$2})`);
  if (e) {
    e.setAttribute('data-sort', 1 - RegExp.$3);
    e.click();
  }
}

// A simple shortcut for form inputs to verify inputs and nicely show warnings:
[
  ['data-allowed-filter-ids', v => ((ids, i) => {
    try {
      const r = new RegExp(i || '.?');
      const m = ids.filter(x => !r.test(x));
      return m.length ? `❌ ${m.join(', ')}` : i ? `✔ Tests are passing` : null;
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
    .bind(null, (f => v.parentNode.setAttribute(`data-input-result`, f(v.value) || ''))
      .bind(null, out(v.getAttribute(attr) || v.value))))));

// Mark edited fields as such, warn before leaving:
if ([].map.call(document.querySelectorAll('form:not([data-immediate]):not([autocomplete]) label[for]'), v => [v, document.querySelector('#' + v.getAttribute('for'))]).filter(x => x[1]).map(x => [x[0], x[1], x[1][x[1].type === 'checkbox' ? 'checked' : 'value']]).map(x => ['onchange', 'onkeyup', 'onpaste'].map(y => x[1][y] = () => x[0].setAttribute('data-changed', x[1][x[1].type === 'checkbox' ? 'checked' : 'value'] != x[2]))).length) {
  let unsaved = true;
  addEventListener('beforeunload', e => { if (unsaved && document.querySelectorAll('[data-changed=true]').length > 0) e.preventDefault(); });
  [].map.call(document.querySelectorAll('input.good'), v => v.onclick = () => { unsaved = false; });
}

// Thing for undo command to work:
function resetUndo() {
  document.cookie = `UndoToken=""; Path=/`;
  document.querySelector('.undo').remove();
  return false;
}

// Dropdown lists:
window.addEventListener('click', e => {
  if (e.target.tagName === 'A' && e.target.parentNode && e.target.parentNode.classList && e.target.parentNode.classList.contains('dropdown')) {
    e.target.parentNode.classList.toggle('dropdown-active');
    e.preventDefault();
  }
  document.querySelectorAll('.dropdown-active').forEach(x => x.contains(e.target) || x.classList.remove('dropdown-active'));
});

const liveUpdates = document.querySelectorAll('[data-live-update]');
if (liveUpdates.length > 0) {
  const period = ((liveUpdates[0].getAttribute('data-live-update') | 0) || 60) * 1e3;
  async function updateLiveImpl() {
    const data = (await (await fetch(location, { headers: { 'X-Live-Update': 1 } })).text()).split('\0');
    if (data.length !== liveUpdates.length) throw new Error(`${data.length} != ${liveUpdates.length}`);
    liveUpdates.forEach((v, i) => {
      if (v.innerHTML !== data[i]) {
        v.innerHTML = data[i];
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