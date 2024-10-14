import { DBTbl, Hooks, Server } from '../src/app';

const knownURLs = new Map();

Hooks.register('core.started.async', () => {
  for (let e of DBTbl.Content.all(['contentKey', 'contentData'])) {
    const url = JSON.parse(e.contentData).updateUrl;
    if (url) {
      knownURLs.set(url, `c${e.contentKey}`);
    }
  }
});

Hooks.register('data.downloadURL.change', args => {
  if (args.key[0] !== 'c') return;
  if (args.newValue && knownURLs.has(args.newValue) && knownURLs.get(args.newValue) !== args.key) {
    const existing = Hooks.poll('data.downloadURL.referencedURL', { key: knownURLs.get(args.newValue) });
    Server.$.toast(null, <>Update URL has already been used for {existing || `a different entry`}. Using a unique URL would work better.</>);
  }
  if (args.oldValue != args.newValue) {
    if (args.oldValue && knownURLs.get(args.oldValue) === args.key) knownURLs.delete(args.oldValue);
    if (args.newValue && !knownURLs.has(args.newValue)) knownURLs.set(args.newValue, args.key);
  }
});
