// @include:libs/sha1.min.js

const domain = window.B2Upload && window.B2Upload.domain || '';
const baseHeaders = window.B2Upload && { 'X-B2-Token': window.B2Upload.token } || {};

async function processMessages() {
  return new Promise(setTimeout);
}

function isArchiveHeader(v) {
  return v === 0x504b0304 || v === 0x504B0506 /* zip */
    || v === 0x52457E5E || v === 0x52617221 /* rar */
    || v === 0x377ABCAF /* 7z */;
}

function isZip(data) {
  const dataView = new DataView(data);
  return dataView.byteLength > 4 && isArchiveHeader(dataView.getUint32(0));
}

function loadFileChecksum(file, progressListener) {
  return new Promise((resolve, reject) => {
    var reader = new FileReader();
    reader.onerror = reject;
    reader.onload = async function () {
      if (!isZip(this.result)) {
        reject('Please use ZIP, RAR or 7-Zip archive to ensure reliable content scanning and installation');
        return;
      }
      // this.result.
      const hash = sha1.create();
      for (let i = 0, t = Date.now(); i < this.result.byteLength; i += 64 * 1024) {
        hash.update(this.result.slice(i, i + 64 * 1024));
        if (Date.now() - t > 16) {
          if (progressListener) progressListener(i / this.result.byteLength);
          await processMessages();
          t = Date.now();
        }
      }
      resolve(hash.hex());
    };
    reader.readAsArrayBuffer(file);
  });
}

let counter = 0;
// setInterval(() => { console.log(++counter); }, 100);

let dragCount = 0;
['dragenter', 'dragleave', 'drop'].forEach(x => document.addEventListener(x, e => {
  if (e.type === 'drop' && e.target.getAttribute('type') !== 'file') e.preventDefault();
  document.body.classList[(dragCount = e.type === 'drop' ? 0 : dragCount + (e.type === 'dragenter' ? 1 : -1)) > 0 ? 'add' : 'remove']('drag-highlight');
}));
document.addEventListener('dragover', e => e.preventDefault());

function progressDialog(title) {
  const dialog = document.body.appendChild(document.createElement('div'));
  dialog.classList.add('modal-popup');
  dialog.innerHTML = `<div><h1></h1><p><span></span><br><progress></progress></p><button disabled>Cancel</button></div>`;
  dialog.querySelector('h1').textContent = title;
  return {
    report(args) {
      if (args.progress != null) dialog.querySelector('progress').value = args.progress;
      else dialog.querySelector('progress').removeAttribute('value');
      dialog.querySelector('p span').textContent = args.message || '';
      return this;
    },
    cancellable(fn) {
      dialog.querySelector('button')[fn ? 'removeAttribute' : 'setAttribute']('disabled', true);
      dialog.querySelector('button').onclick = () => { fn(); dialog.remove(); };
      return this;
    },
    error(message) {
      console.log(message);
      dialog.querySelector('button').textContent = 'Close';
      message = ('' + message).trim();
      if (!/[\.!?]$/.test(message)) message += '.';
      this.report({ message, progress: 1 }).cancellable(() => { });
    },
    done() {
      dialog.remove();
    },
  };
}
progressDialog.any = () => document.querySelector('modal-popup') != null;

function formatSize(size, digits = 1) {
  const f = (n, d) => n.toFixed(n < 20 ? d : n < 200 && d === 2 ? 1 : 0);
  if (size < 0.9 * 1024) return `${size} B`;
  if (size < 0.9 * 1024 * 1024) return `${f(size / 1024, digits)} KB`;
  if (size < 0.9 * 1024 * 1024 * 1024) return `${f(size / (1024 * 1024), digits)} MB`;
  return `${f(size / (1024 * 1024 * 1024), digits)} GB`;
}

function formatSizeRange(size, digits = 1) {
  const f = (n, d) => n.toFixed(n < 20 ? d : n < 200 && d === 2 ? 1 : 0);
  if (size[1] < 0.9 * 1024) return `${size[0]}/${size[1]} B`;
  if (size[1] < 0.9 * 1024 * 1024) return `${f(size[0] / 1024, digits)}/${f(size[1] / 1024, digits)} KB`;
  if (size[1] < 0.9 * 1024 * 1024 * 1024) return `${f(size[0] / (1024 * 1024), digits)}/${f(size[1] / (1024 * 1024), digits)} MB`;
  return `${f(size[0] / (1024 * 1024 * 1024), digits)}/${f(size[1] / (1024 * 1024 * 1024), digits)} GB`;
}

function formatTime(seconds) {
  const days = seconds / (24 * 60 * 60);
  if (days >= 356) return `${(days / 356).toFixed(1)} y`;
  if (days >= 2) return `${(days).toFixed(0)} d`;
  if (days >= 2 / 24) return `${(days * 24).toFixed(0)} h`;
  if (days >= 2 / (24 * 60)) return `${(days * (24 * 60)).toFixed(0)} min`;
  return `${(days * (24 * 60 * 60)).toFixed(0)} s`;
}

let cooldown = 0;
async function updateB2Status(target) {
  const url = target.value;
  const attr = target.getAttribute('data-b2-done');
  if (attr === url) return;
  if (attr) target.removeAttribute('data-b2-done');
  if (/^cup:\/\/b2\/(.+)/.test(url)) {
    target.parentNode.previousSibling.classList.toggle('b2-anim', false);
    const key = RegExp.$1;
    const res = await fetch(`${domain}/api/plugin-b2/file/${encodeURIComponent(url)}`, { headers: baseHeaders });
    if (res.status === 404) {
      setInputResult(target, '❌ Unknown URL');
      target.setAttribute('data-b2-done', url);
    } else if (res.status !== 200) {
      setInputResult(target, '❌ Failed to check the state');
    } else {
      const state = await res.json();
      if (state.name) {
        const n = `<a href="/manage/file/b2/${key}">${escapeHTML(state.name)}</a>`;
        if (state.status === 'ready') {
          target.setAttribute('data-b2-done', url);
          setInputResult(target, `🆗 ${n} (${formatSize(state.size, 0)})`, null, true);
        } else if (state.status === 'limbo') {
          setInputResult(target, `🔜 ${n} (${formatSize(state.size, 0)}), ready for processing`);
        } else {
          setInputResult(target, `🔝 ${n} (${formatSize(state.size, 0)}), ${state.status}`);
        }
      } else {
        setInputResult(target, '❌ Failed to verify file state');
      }
    }
  } else {
    target.parentNode.previousSibling.classList.toggle('b2-anim', true);
    setInputResult(target, null);
  }
}

let unfocusedSkip = 0;
async function updateAllB2Status(force) {
  try {
    if (document.hasFocus() || --unfocusedSkip < 0 || force === true) {
      unfocusedSkip = 100;
      for (const e of document.querySelectorAll('[data-b2-target]')) {
        await updateB2Status(e);
      }
    }
    setTimeout(updateAllB2Status, 1e3);
  } catch (e) {
    setTimeout(updateAllB2Status, 5e3);
  }
}
updateAllB2Status(true);

async function tryAsync(fn, tries, delayMs) {
  for (let i = 1; i < tries; ++i) {
    if (i > 1) await Bun.sleep(delayMs);
    try {
      return await fn(` (attempt ${i}/${tries})`);
    } catch (e) {
      if (e instanceof RequestError) throw e;
      console.warn(e);
    }
  }
  return await fn(` (attempt ${tries}/${tries})`);
}

function uploadChunk(args) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.responseType = 'json';
    if (args.progressListener) xhr.upload.addEventListener('progress', ev => {
      if (ev.lengthComputable) args.progressListener({ loaded: ev.loaded, total: ev.total });
    });
    xhr.addEventListener('loadend', () => {
      if (xhr.readyState === 4 && (xhr.status === 200 || xhr.status === 204)) resolve(xhr.status === 200 ? xhr.response : null);
      else reject(xhr.readyState !== 4 ? `XHR state: ${xhr.readyState}` : xhr.response && typeof xhr.response.error === 'string' && xhr.response.error || `Server response: ${xhr.status}`);
    });
    xhr.addEventListener('error', () => reject('Failed to upload the file'));
    xhr.open('POST', args.url, true);
    if (args.headers) Object.entries(args.headers).forEach(([k, v]) => xhr.setRequestHeader(k, encodeURI(v)));
    xhr.send(args.data);
    if (args.cancellableListener) args.cancellableListener(() => xhr.abort());
  });
}

function progressCompute(totalSize, prefix) {
  const start = Date.now();
  let range = [0, 1];
  return {
    subrange: (piece, total) => {
      range[0] = totalSize * piece / total;
    },
    get: loaded => {
      loaded += range[0];
      const speed = loaded / ((Date.now() - start) / 1e3);
      const timeLeft = (totalSize - loaded) / speed;
      return {
        message: `${prefix || ''}${formatSizeRange([loaded, totalSize])}, ${formatSize(speed, 2)}/s, ETA: ${formatTime(timeLeft)}`,
        progress: loaded / totalSize
      };
    }
  };
}

document.querySelectorAll('[data-b2-file]').forEach(input => {
  const settings = JSON.parse(input.getAttribute('data-b2-file'));
  const target = document.querySelector(`[data-b2-target=${JSON.stringify(settings.target)}]`);
  input.parentNode.style.display = null;

  target.addEventListener('change', () => updateB2Status(target));

  let waiting;
  target.addEventListener('keyup', () => waiting = waiting || setTimeout(() => waiting = updateB2Status(target), null, 500));
  target.addEventListener('paste', () => waiting = waiting || setTimeout(() => waiting = updateB2Status(target), null, 500));

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file || progressDialog.any()) return;

    const pr = progressDialog(`Uploading a file ${file.name}…`, () => { throw new Error(); }).report({ message: 'Computing the checksum…', progress: 0 });
    try {
      if (file.size / (1024 * 1024 * 1024) > settings.sizeCapGB) {
        throw new Error(`File should not exceed ${settings.sizeCapGB} GB`);
      }

      if (settings.verifyCallback) {
        await window[settings.verifyCallback](file);
      }

      const checksum = await loadFileChecksum(file, progress => pr.report({ message: 'Computing checksum…', progress: progress }));
      console.log('Checksum: ' + checksum);

      pr.report({ message: 'Uploading…' });
      const progress = progressCompute(file.size, 'Uploading: ');

      let ret;
      if (file.size > settings.chunkSizeUpload) {
        const headers = Object.assign(
          { 'X-File-Name': file.name.replace(/[^a-z0-9!~_.-]/ig, '') || 'unnamed.bin', 'X-File-Checksum': checksum, 'X-File-Size': file.size },
          baseHeaders);
        ret = await (await fetch(`${domain}/api/plugin-b2/large-file`, { method: 'POST', headers: headers })).json();
        for (let i = 0, a = 5; !ret.url && i < 10000; ++i) {
          if (!ret.total || !Array.isArray(ret.next) || ret.next.length === 0 || !ret.chunk) throw new Error(`Malformed response: ${JSON.stringify(ret)}`);
          const nextIndex = ret.next[0];
          console.log(`Piece: ${i}, ${nextIndex} out of ${ret.total}, chunks left: [${ret.next.join(', ')}]`);
          progress.subrange(nextIndex, ret.total);
          try {
            ret = await uploadChunk({
              url: '/api/plugin-b2/large-file',
              data: file.slice(nextIndex * ret.chunk, (nextIndex + 1) * ret.chunk),
              headers: Object.assign({ 'X-Chunk-Index': nextIndex }, headers),
              progressListener: ev => pr.report(ev.loaded === ev.total && nextIndex + 1 === ret.total
                ? { message: `Waiting for server to process the data…` } : progress.get(ev.loaded)),
              cancellableListener: fn => pr.cancellable(fn)
            });
          } catch (e) {
            if (--a > 0) {
              ret = await (await fetch(`${domain}/api/plugin-b2/large-file`, { method: 'POST', headers: headers })).json();
            } else {
              throw e;
            }
          }
        }
      } else {
        ret = await uploadChunk({
          url: `${domain}/api/plugin-b2/file`,
          headers: Object.assign({ 'X-File-Name': file.name.replace(/[^a-z0-9!~_.-]/ig, '') || 'unnamed.bin', 'X-File-Checksum': checksum }, baseHeaders),
          data: file,
          progressListener: ev => pr.report(ev.loaded === ev.total
            ? { message: `Waiting for server to process the data…` } : progress.get(ev.loaded)),
          cancellableListener: fn => pr.cancellable(fn)
        });
      }

      if (!ret.url) throw new Error(`Malformed response: ${JSON.stringify(ret)}`);

      target.value = ret.url;
      if (target.onchange) target.onchange();
      updateB2Status(target);

      pr.done();
    } catch (e) {
      console.warn(e);
      pr.error(e.message || e);
    } finally {
      input.value = null;
    }
  });
});