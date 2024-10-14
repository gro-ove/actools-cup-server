/**
 * Forked from https://www.npmjs.com/package/backblaze-b2 and adapted for Bun.js.
 */

/** @param {{method: string?, url: string, headers: {}, data: ArrayBuffer?, progress: null|(v: number) => void}} params */
async function request(params) {
  // console.log(`B2 request: ${params.method || 'GET'} ${params.url}, headers: ${JSON.stringify(params.headers)}, data: ${params.data && params.data.byteLength != null ? `${params.data.byteLength} bytes` : JSON.stringify(params.data || null)}`);
  let req;
  try {
    req = await fetch(params.url, {
      method: params.method || 'GET',
      headers: params.headers,
      body: params.data instanceof ArrayBuffer || params.data instanceof Buffer || typeof params.data === 'string' ? params.data : JSON.stringify(params.data)
    });
  } catch (e) {
    throw Object.assign(e, { repeat: params.uploadErrorHandling ? 1 : true });
  }
  // console.log(`  B2 request status: ${req.status}`);
  if (req.status < 200 || req.status >= 400) {
    let repeat = true;
    if (params.uploadErrorHandling) {
      if (req.status === 503 || req.status === 429 /* Too Many Requests */) {
        await Bun.sleep(((req.headers.get('Retry-After') | 0) || 5) * 1e3);
      }
      if (req.status === 401 || req.status === 408 || req.status >= 500) {
        repeat = 1;
      }
    } else if (req.status === 400 || req.status === 401) {
      repeat = undefined;
    }
    let errorMsg = `B2 error ${req.status}`;
    let fetchResponse;
    try {
      const body = await req.text();
      try {
        fetchResponse = JSON.parse(body);
        errorMsg = `${errorMsg} (${JSON.stringify(fetchResponse)})`;
      } catch {
        fetchResponse = body;
        errorMsg = `${errorMsg} (${body})`;
      }
    } catch { }
    throw Object.assign(new Error(errorMsg), { repeat, fetchStatus: req.status, fetchResponse });
  }
  return await req.json();
}

const conf = {
  API_AUTHORIZE__URL: 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account',
  API_VERSION_URL: '/b2api/v3',
  MAX_INFO_HEADERS: 10
};

function endpoints(b2) {
  const apiUrl = `${b2._auth.apiUrl}${conf.API_VERSION_URL}`;
  return {
    createBucketUrl: `${apiUrl}/b2_create_bucket`,
    deleteBucketUrl: `${apiUrl}/b2_delete_bucket`,
    listBucketUrl: `${apiUrl}/b2_list_buckets`,
    updateBucketUrl: `${apiUrl}/b2_update_bucket`,
    getBucketUploadUrl: `${apiUrl}/b2_get_upload_url`,
    listFilesUrl: `${apiUrl}/b2_list_file_names`,
    listFileVersionsUrl: `${apiUrl}/b2_list_file_versions`,
    listPartsUrl: `${apiUrl}/b2_list_parts`,
    hideFileUrl: `${apiUrl}/b2_hide_file`,
    fileInfoUrl: `${apiUrl}/b2_get_file_info`,
    copyFileUrl: `${apiUrl}/b2_copy_file`,
    downloadAuthorizationUrl: `${apiUrl}/b2_get_download_authorization`,
    downloadFileByNameUrl: (bucketName, fileName) => `${b2._auth.downloadUrl}/file/${bucketName}/${fileName}`,
    downloadFileByIdUrl: (fileId) => `${b2._auth.downloadUrl}${conf.API_VERSION_URL}/b2_download_file_by_id?fileId=${fileId}`,
    deleteFileVersionUrl: `${apiUrl}/b2_delete_file_version`,
    startLargeFileUrl: `${apiUrl}/b2_start_large_file`,
    getUploadPartUrl: `${apiUrl}/b2_get_upload_part_url`,
    finishLargeFileUrl: `${apiUrl}/b2_finish_large_file`,
    cancelLargeFileUrl: `${apiUrl}/b2_cancel_large_file`,
    listUnfinishedLargeFiles: `${apiUrl}/b2_list_unfinished_large_files`,
    createKeyUrl: `${apiUrl}/b2_create_key`,
    deleteKeyUrl: `${apiUrl}/b2_delete_key`,
    listKeysUrl: `${apiUrl}/b2_list_keys`,
  };
}

const utils = {
  getAuthHeaderObject: args => ({ Authorization: 'Basic ' + Buffer.from(args.applicationKeyId + ':' + args.applicationKey).toString('base64') }),
  getAuthHeaderObjectWithToken: b2 => ({ Authorization: b2._auth.authorizationToken }),
  getUrlEncodedFileName: fileName => fileName.split('/').map(encodeURIComponent).join('/'),
  sha1: data => require('crypto').createHash('sha1').update(data).digest('hex'),
};

function post(b2, url, data) {
  return request({
    url: url,
    method: 'POST',
    headers: utils.getAuthHeaderObjectWithToken(b2),
    data: data
  });
}

const actions = {
  auth: {
    authorize: async function (b2, args) {
      const ret = await request({ url: conf.API_AUTHORIZE__URL, headers: utils.getAuthHeaderObject(args) });
      b2._auth = Object.assign({ timeout: Date.now() + 12 * 60 * 60e3 }, ret);
      return b2._auth;
    }
  },
  key: {
    CAPABILITIES: {
      LIST_KEYS: 'listKeys',
      WRITE_KEYS: 'writeKeys',
      DELETE_KEYS: 'deleteKeys',
      LIST_BUCKETS: 'listBuckets',
      WRITE_BUCKETS: 'writeBuckets',
      DELETE_BUCKETS: 'deleteBuckets',
      LIST_FILES: 'listFiles',
      READ_FILES: 'readFiles',
      SHARE_FILES: 'shareFiles',
      WRITE_FILES: 'writeFiles',
      DELETE_FILES: 'deleteFiles',
    },
    create: (b2, args) => post(b2, endpoints(b2).createKeyUrl, {
      accountId: b2._auth.accountId,
      capabilities: args.capabilities,
      keyName: args.keyName,
      validDurationInSeconds: args.validDurationInSeconds,
      bucketId: args.bucketId,
      namePrefix: args.namePrefix,
    }),
    delete: (b2, args) => post(b2, endpoints(b2).deleteKeyUrl, {
      applicationKeyId: args.applicationKeyId,
    }),
    list: (b2, args) => post(b2, endpoints(b2).listKeysUrl, {
      accountId: b2._auth.accountId,
      maxKeyCount: args?.maxKeyCount,
      startApplicationKeyId: args?.startApplicationKeyId,
    }),
  },
  bucket: {
    TYPES: {
      ALL_PUBLIC: 'allPublic',
      ALL_PRIVATE: 'allPrivate'
    },
    create: (b2, args) => post(b2, endpoints(b2).createBucketUrl, {
      accountId: b2._auth.accountId,
      bucketName: args.bucketName,
      bucketType: args.bucketType
    }),
    delete: (b2, args) => post(b2, endpoints(b2).deleteBucketUrl, {
      accountId: b2._auth.accountId,
      bucketId: args.bucketId
    }),
    list: (b2, args) => post(b2, endpoints(b2).listBucketUrl, {
      accountId: b2.accountId
    }),
    get: (b2, args) => post(b2, endpoints(b2).listBucketUrl, {
      accountId: b2._auth.accountId,
      bucketName: args.bucketName || undefined,
      bucketId: args.bucketId || undefined
    }),
    update: (b2, args) => post(b2, endpoints(b2).updateBucketUrl, {
      accountId: b2._auth.accountId,
      bucketId: args.bucketId,
      bucketType: args.bucketType
    }),
    getUploadUrl: (b2, args) => post(b2, endpoints(b2).getBucketUploadUrl, {
      bucketId: args.bucketId
    }),
  },
  file: {
    uploadFile: (b2, args) => request({
      url: args.uploadUrl,
      method: 'POST',
      headers: Object.assign({
        Authorization: args.uploadAuthToken,
        'Content-Type': 'b2/x-auto',
        'Content-Length': args.contentLength || args.data.byteLength,
        'X-Bz-File-Name': utils.getUrlEncodedFileName(args.fileName),
        'X-Bz-Content-Sha1': args.sha1 || utils.sha1(args.data)
      }, args.info && Object.entries(args.info).reduce((p, [k, v]) => {
        if (!/^[a-z0-9-_]+$/i.test(k)) throw new Error('Info header key contains invalid characters: ' + k);
        p['X-Bz-Info-' + k] = encodeURIComponent(v);
        return p;
      }, {})),
      data: args.data,
      progress: args.progress,
      uploadErrorHandling: true,
    }),

    uploadPart: (b2, args) => request({
      url: args.uploadUrl,
      method: 'POST',
      headers: {
        Authorization: args.uploadAuthToken,
        'Content-Length': args.data.byteLength,
        'X-Bz-Part-Number': args.partNumber,
        'X-Bz-Content-Sha1': args.sha1 || utils.sha1(args.data)
      },
      data: args.data,
      progress: args.progress,
      uploadErrorHandling: true,
    }),

    startLargeFile: (b2, args) => post(b2, endpoints(b2).startLargeFileUrl, {
      bucketId: args.bucketId,
      fileName: args.fileName,
      fileInfo: args.info,
      contentType: args.contentType || 'b2/x-auto'
    }),

    getUploadPartUrl: (b2, args) => post(b2, endpoints(b2).getUploadPartUrl, {
      fileId: args.fileId
    }),

    finishLargeFile: (b2, args) => post(b2, endpoints(b2).finishLargeFileUrl, {
      fileId: args.fileId,
      partSha1Array: args.partSha1Array
    }),

    cancelLargeFile: (b2, args) => post(b2, endpoints(b2).cancelLargeFileUrl, {
      fileId: args.fileId
    }),

    listUnfinishedLargeFiles: (b2, args) => post(b2, endpoints(b2).listUnfinishedLargeFiles, {
      bucketId: args.bucketId,
      namePrefix: args.namePrefix || '',
      startFileId: args.startFileId || undefined,
      maxFileCount: args.maxFileCount || 100,
    }),

    listFileNames: (b2, args) => post(b2, endpoints(b2).listFilesUrl, {
      bucketId: args.bucketId,
      startFileName: args.startFileName || '',
      maxFileCount: args.maxFileCount || 100,
      prefix: args.prefix || '',
      delimiter: args.delimiter || null
    }),

    listFileVersions: (b2, args) => post(b2, endpoints(b2).listFileVersionsUrl, {
      bucketId: args.bucketId,
      startFileName: args.startFileName || '',
      startFileId: args.startFileId,
      maxFileCount: args.maxFileCount || 100
    }),

    listParts: (b2, args) => post(b2, endpoints(b2).listPartsUrl, {
      fileId: args.fileId,
      startPartNumber: args.startPartNumber || 0,
      maxPartCount: args.maxPartCount || 100
    }),

    hideFile: (b2, args) => post(b2, endpoints(b2).hideFileUrl, {
      bucketId: args.bucketId,
      fileName: args.fileName
    }),

    getFileInfo: (b2, args) => post(b2, endpoints(b2).fileInfoUrl, {
      fileId: args.fileId
    }),

    copyFile: (b2, args) => post(b2, endpoints(b2).copyFileUrl, {
      sourceFileId: args.fileId,
      fileName: args.fileName,
      destinationBucketId: args.destinationBucketId, // optional, if not set, same bucket
      range: args.range, // optional, if not set, the entire file
      metadataDirective: args.info ? 'REPLACE' : 'COPY',
      fileInfo: args.info,
      contentType: args.contentType || 'application/octet-stream',
    }),

    getDownloadAuthorization: (b2, args) => post(b2, endpoints(b2).downloadAuthorizationUrl, {
      bucketId: args.bucketId,
      fileNamePrefix: args.fileNamePrefix,
      validDurationInSeconds: args.validDurationInSeconds,
      b2ContentDisposition: args.b2ContentDisposition
    }),

    deleteFileVersion: (b2, args) => post(b2, endpoints(b2).deleteFileVersionUrl, {
      fileId: args.fileId,
      fileName: args.fileName
    }),

    // TODO: Do not parse JSON, add download progress, method: GET
    downloadFileByName: (b2, args) => post(b2, endpoints(b2).downloadFileByNameUrl(args.bucketName, utils.getUrlEncodedFileName(args.fileName)), {}),
    downloadFileById: (b2, args) => post(b2, endpoints(b2).downloadFileByIdUrl(args.fileId), {}),
  }
};

export class B2 {
  constructor(auth) { this._auth = auth; }
  get ready() { return this._auth && Date.now() < this._auth.timeout; }

  getContext(key) { return this._ctx && this._ctx[key]; }
  setContext(key, value) { (this._ctx || (this._ctx = {}))[key] = value; }

  get BUCKET_TYPES() { return actions.bucket.TYPES; }
  get KEY_CAPABILITIES() { return actions.key.CAPABILITIES; }

  authorize(args) { return actions.auth.authorize(this, Object.assign({}, this._ctx, args)); }
  createBucket(args) { return actions.bucket.create(this, Object.assign({}, this._ctx, args)); }
  deleteBucket(args) { return actions.bucket.delete(this, Object.assign({}, this._ctx, args)); }
  listBuckets(args) { return actions.bucket.list(this, Object.assign({}, this._ctx, args)); }
  getBucket(args) { return actions.bucket.get(this, Object.assign({}, this._ctx, args)); }
  updateBucket(args) { return actions.bucket.update(this, Object.assign({}, this._ctx, args)); }
  getUploadUrl(args) { return actions.bucket.getUploadUrl(this, Object.assign({}, this._ctx, args)); }
  uploadFile(args) { return actions.file.uploadFile(this, Object.assign({}, this._ctx, args)); }
  listUnfinishedLargeFiles(args) { return actions.file.listUnfinishedLargeFiles(this, Object.assign({}, this._ctx, args)); }
  listFileNames(args) { return actions.file.listFileNames(this, Object.assign({}, this._ctx, args)); }
  listFileVersions(args) { return actions.file.listFileVersions(this, Object.assign({}, this._ctx, args)); }
  hideFile(args) { return actions.file.hideFile(this, Object.assign({}, this._ctx, args)); }
  getFileInfo(args) { return actions.file.getFileInfo(this, Object.assign({}, this._ctx, args)); }
  getDownloadAuthorization(args) { return actions.file.getDownloadAuthorization(this, Object.assign({}, this._ctx, args)); }
  downloadFileByName(args) { return actions.file.downloadFileByName(this, Object.assign({}, this._ctx, args)); }
  downloadFileById(args) { return actions.file.downloadFileById(this, Object.assign({}, this._ctx, args)); }
  deleteFileVersion(args) { return actions.file.deleteFileVersion(this, Object.assign({}, this._ctx, args)); }
  cancelLargeFile(args) { return actions.file.cancelLargeFile(this, Object.assign({}, this._ctx, args)); }
  finishLargeFile(args) { return actions.file.finishLargeFile(this, Object.assign({}, this._ctx, args)); }
  copyFile(args) { return actions.file.copyFile(this, Object.assign({}, this._ctx, args)); }
  listParts(args) { return actions.file.listParts(this, Object.assign({}, this._ctx, args)); }
  startLargeFile(args) { return actions.file.startLargeFile(this, Object.assign({}, this._ctx, args)); }
  getUploadPartUrl(args) { return actions.file.getUploadPartUrl(this, Object.assign({}, this._ctx, args)); }
  uploadPart(args) { return actions.file.uploadPart(this, Object.assign({}, this._ctx, args)); }
  createKey(args) { return actions.key.create(this, Object.assign({}, this._ctx, args)); }
  deleteKey(args) { return actions.key.delete(this, Object.assign({}, this._ctx, args)); }
  listKeys(args) { return actions.key.list(this, Object.assign({}, this._ctx, args)); }
}
