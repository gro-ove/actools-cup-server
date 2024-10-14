import { Ctx, Hooks, pluginSettings, Server } from '../src/app';
import { Timer } from '../src/std';

const Settings = pluginSettings('robotsTxt', {
  domain: null
});

const getDomain = $ => Settings.domain ? `https://${Settings.domain}` : `${$.url.protocol}//${$.url.hostname}`;
const startedAt = new Date();

class LazyResponse {
  constructor(url, contentType, factory, rebuildPeriod) {
    this.contentType = contentType;
    this.factory = factory;
    this.dirty = true;
    Server.get(url, $ => this.serve($));
    setInterval(() => this.dirty = true, Timer.parse(rebuildPeriod));
  }

  /** @param {Ctx} $ */
  async serve($) {
    if (this.dirty) {
      let updated = await this.factory($);
      if (updated !== this.data) {
        this.data = updated;
        this.deflated = null;
        this.modifiedAt = new Date();
      }
      this.dirty = false;
    }

    $.lastModified(this.modifiedAt);
    if (/\bdeflate\b/.test($.req.headers.get('accept-encoding'))) {
      if (!this.deflated) this.deflated = Bun.deflateSync(this.data);
      return new Response(this.deflated, { headers: { 'Content-Type': this.contentType, 'Content-Encoding': 'deflate' } });
    }
    return new Response(this.data, { headers: { 'Content-Type': this.contentType } });
  }
}

new LazyResponse('/sitemap.xml', 'application/xml; charset=UTF-8', async $ => {
  let r = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
  const fn = (url, date) => {
    if (!(date instanceof Date)) date = new Date(date * 1e3);
    r += `<url><loc>${getDomain($)}${Bun.escapeHTML(url)}</loc><lastmod>${date.toISOString()}</lastmod></url>`;
  };
  fn('/', startedAt);
  await Hooks.async('plugin.robots.sitemap', fn);
  r += '</urlset>';
  return r;
}, '12 hr');

new LazyResponse('/robots.txt', 'text/plain; charset=UTF-8', $ => {
  let r = `User-agent: *\nDisallow: /manage\n`;
  Hooks.trigger('plugin.robots.disallowed', s => r += `Disallow: ${s}\n`);
  r += `Sitemap: ${getDomain($)}/sitemap.xml\n`;
  return r;
}, '1 day');
