// @include:libs/sha1.min.js

async function processMessages() {
  return new Promise(setTimeout);
}

function isZip(data) {
  const dataView = new DataView(data);
  return dataView.byteLength > 4 && dataView.getUint32(0) === 0x504b0304;
}

function loadFileChecksum(file, progressListener) {
  return new Promise((resolve, reject) => {
    var reader = new FileReader();
    reader.onerror = reject;
    reader.onload = async function () {
      if (!isZip(this.result)) {
        reject('Please use ZIP archive to ensure reliable content scanning and installation');
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
      this.report({ message, progress: 1 }).cancellable(() => { });
    },
    done() {
      dialog.remove();
    },
  };
}
progressDialog.any = () => document.querySelector('modal-popup') != null;

let cooldown = 0;
async function updateB2Status(target) {
  const url = target.value;
  const attr = target.getAttribute('data-b2-done');
  if (attr === url) return;
  if (attr) target.removeAttribute('data-b2-done');
  if (/^cup:\/\/b2\/.+/.test(url)) {
    const res = await fetch(`/api/plugin-b2/file/${encodeURIComponent(url)}`);
    if (res.status === 404) {
      target.parentNode.setAttribute('data-input-result', '❌ Unknown URL');
      target.setAttribute('data-b2-done', url);
    } else if (res.status !== 200) {
      target.parentNode.setAttribute('data-input-result', '❌ Failed to check the state');
    } else {
      const state = await res.json();
      if (state.name) {
        if (state.status === 'ready') {
          target.setAttribute('data-b2-done', url);
          target.parentNode.setAttribute('data-input-result', `🆗 ${state.name} (${(state.size / (1024 * 1024)).toFixed(0)} MB)`);
        } else if (state.status === 'limbo') {
          target.parentNode.setAttribute('data-input-result', `🔜 ${state.name} (${(state.size / (1024 * 1024)).toFixed(0)} MB), ready for processing`);
        } else {
          target.parentNode.setAttribute('data-input-result', `🔝 ${state.name} (${(state.size / (1024 * 1024)).toFixed(0)} MB), ${state.status}`);
        }
      } else {
        target.parentNode.setAttribute('data-input-result', '❌ Failed to verify file state');
      }
    }
  } else {
    target.parentNode.removeAttribute('data-input-result');
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
        message: `${prefix || ''}${(loaded / (1024 * 1024)).toFixed(1)}/${(totalSize / (1024 * 1024)).toFixed(1)} MB, ${(speed / (1024 * 1024)).toFixed(2)} MB/s, ETA: ${timeLeft.toFixed(0)} s`,
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

      const checksum = await loadFileChecksum(file, progress => pr.report({ message: 'Computing checksum…', progress: progress }));
      console.log('Checksum: ' + checksum);

      pr.report({ message: 'Uploading…' });
      const progress = progressCompute(file.size, 'Uploading: ');

      let ret;
      if (file.size > settings.chunkSizeUpload) {
        const headers = { 'X-File-Name': file.name.replace(/[^a-z0-9!~_.-]/ig, '') || 'unnamed.bin', 'X-File-Checksum': checksum, 'X-File-Size': file.size };
        ret = await (await fetch('/api/plugin-b2/large-file', { method: 'POST', headers: headers })).json();
        for (let i = 0, a = 5; !ret.url && i < 10000; ++i) {
          if (!ret.total || typeof ret.next !== 'number' || !ret.chunk) throw new Error(`Malformed response: ${JSON.stringify(ret)}`);
          console.log(`Piece: ${i}, ${ret.next} out of ${ret.total}`);
          progress.subrange(ret.next, ret.total);
          try {
            ret = await uploadChunk({
              url: '/api/plugin-b2/large-file',
              data: file.slice(ret.next * ret.chunk, (ret.next + 1) * ret.chunk),
              headers: Object.assign({ 'X-Chunk-Index': ret.next }, headers),
              progressListener: ev => pr.report(ev.loaded === ev.total && ret.next + 1 === ret.total
                ? { message: `Waiting for server to process the data…` } : progress.get(ev.loaded)),
              cancellableListener: fn => pr.cancellable(fn)
            });
          } catch (e) {
            if (--a > 0) {
              ret = await (await fetch('/api/plugin-b2/large-file', { method: 'POST', headers: headers })).json();
            } else {
              throw e;
            }
          }
        }
      } else {
        ret = await uploadChunk({
          url: '/api/plugin-b2/file',
          headers: { 'X-File-Name': file.name.replace(/[^a-z0-9!~_.-]/ig, '') || 'unnamed.bin', 'X-File-Checksum': checksum },
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