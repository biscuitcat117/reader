import { Zip } from './zip.js';

const MIME = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', css: 'text/css',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4',
};

const ORIGIN = 'http://epub.invalid';

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// Resolves an href found in `from` (a path inside the EPUB) to another path
// inside the EPUB. Returns null for links that point outside the book.
export function resolvePath(from, href) {
  let u;
  try {
    u = new URL(href, `${ORIGIN}/${from.split('/').map(encodeURIComponent).join('/')}`);
  } catch {
    return null;
  }
  if (u.origin !== ORIGIN) return null;
  return { path: safeDecode(u.pathname.slice(1)), hash: safeDecode(u.hash.slice(1)) };
}

// Namespace-agnostic element lookups (EPUB XML mixes dc:, opf:, ncx: prefixes).
const matches = (el, name) => el.localName === name || el.localName.endsWith(`:${name}`);
const byName = (root, name) => [...root.getElementsByTagName('*')].filter((el) => matches(el, name));
const kids = (el, name) => [...el.children].filter((c) => matches(c, name));
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function parseXML(src, type = 'application/xml') {
  let doc = new DOMParser().parseFromString(src, type);
  if (doc.getElementsByTagName('parsererror').length) {
    doc = new DOMParser().parseFromString(src, 'text/html');
  }
  return doc;
}

async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(re)) {
    parts.push(str.slice(last, m.index), fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return (await Promise.all(parts)).join('');
}

export class Book {
  static async open(buffer) {
    const book = new Book();
    await book._init(buffer);
    return book;
  }

  async _init(buffer) {
    this.zip = new Zip(buffer);
    this.urls = new Map();

    const container = parseXML(await this.zip.text('META-INF/container.xml'));
    const opfPath = byName(container, 'rootfile')[0]?.getAttribute('full-path');
    if (!opfPath) throw new Error('This EPUB is missing its package file.');
    const opf = parseXML(await this.zip.text(opfPath));

    this.title = clean(byName(opf, 'title')[0]?.textContent);
    this.author = byName(opf, 'creator').map((el) => clean(el.textContent)).filter(Boolean).join(', ');
    this.lang = clean(byName(opf, 'language')[0]?.textContent);

    this.manifest = new Map();
    for (const item of byName(opf, 'item')) {
      const target = resolvePath(opfPath, item.getAttribute('href') || '');
      if (!target) continue;
      this.manifest.set(item.getAttribute('id'), {
        path: target.path,
        type: item.getAttribute('media-type') || '',
        props: item.getAttribute('properties') || '',
      });
    }

    this.spine = [];
    for (const ref of byName(opf, 'itemref')) {
      const item = this.manifest.get(ref.getAttribute('idref'));
      if (item && this.zip.find(item.path)) {
        this.spine.push({ path: item.path, size: this.zip.size(item.path) });
      }
    }
    if (!this.spine.length) throw new Error('This book has no readable chapters.');

    this.coverPath = this._findCover(opf);
    this.toc = await this._loadToc(opf).catch(() => []);
    for (const entry of this.toc) {
      entry.spineIndex = this.spine.findIndex((s) => s.path === entry.path);
    }
  }

  _findCover(opf) {
    const items = [...this.manifest.values()];
    const isImage = (i) => i && i.type.startsWith('image/');
    const byProp = items.find((i) => /\bcover-image\b/.test(i.props));
    if (isImage(byProp)) return byProp.path;
    const meta = byName(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
    const byMeta = meta && this.manifest.get(meta.getAttribute('content'));
    if (isImage(byMeta)) return byMeta.path;
    for (const [id, item] of this.manifest) {
      if (isImage(item) && /cover/i.test(`${id} ${item.path}`)) return item.path;
    }
    return null;
  }

  async _loadToc(opf) {
    const items = [...this.manifest.values()];
    const nav = items.find((i) => /\bnav\b/.test(i.props));
    if (nav && this.zip.find(nav.path)) {
      const doc = parseXML(await this.zip.text(nav.path), 'application/xhtml+xml');
      const navs = byName(doc, 'nav');
      const el = navs.find((n) => (n.getAttribute('epub:type') || '').includes('toc')) || navs[0];
      const list = el && kids(el, 'ol')[0];
      if (list) {
        const out = [];
        const walk = (ol, depth) => {
          for (const li of kids(ol, 'li')) {
            const a = kids(li, 'a')[0] || kids(li, 'span')[0];
            if (a) {
              const href = a.getAttribute('href');
              const target = href ? resolvePath(nav.path, href) : null;
              out.push({ label: clean(a.textContent), path: target?.path, hash: target?.hash, depth });
            }
            const sub = kids(li, 'ol')[0];
            if (sub) walk(sub, depth + 1);
          }
        };
        walk(list, 0);
        if (out.length) return out;
      }
    }

    const spineEl = byName(opf, 'spine')[0];
    const ncx = this.manifest.get(spineEl?.getAttribute('toc'))
      || items.find((i) => i.type === 'application/x-dtbncx+xml');
    if (!ncx || !this.zip.find(ncx.path)) return [];
    const doc = parseXML(await this.zip.text(ncx.path));
    const map = byName(doc, 'navMap')[0];
    const out = [];
    const walk = (parent, depth) => {
      for (const point of kids(parent, 'navPoint')) {
        const label = clean(byName(kids(point, 'navLabel')[0] || point, 'text')[0]?.textContent);
        const src = kids(point, 'content')[0]?.getAttribute('src');
        const target = src ? resolvePath(ncx.path, src) : null;
        out.push({ label, path: target?.path, hash: target?.hash, depth });
        walk(point, depth + 1);
      }
    };
    if (map) walk(map, 0);
    return out;
  }

  _type(path) {
    for (const item of this.manifest.values()) {
      if (item.path === path && item.type) return item.type;
    }
    return MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
  }

  async cover() {
    if (!this.coverPath || !this.zip.find(this.coverPath)) return null;
    const bytes = await this.zip.bytes(this.coverPath);
    return { data: bytes.slice().buffer, type: this._type(this.coverPath) };
  }

  async blobURL(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    let url = null;
    if (this.zip.find(path)) {
      const bytes = await this.zip.bytes(path);
      url = URL.createObjectURL(new Blob([bytes], { type: this._type(path) }));
    }
    this.urls.set(path, url);
    return url;
  }

  async _css(path, seen = new Set()) {
    if (seen.has(path) || !this.zip.find(path)) return '';
    seen.add(path);
    return this._rewriteCss(await this.zip.text(path), path, seen);
  }

  // Inlines @imports and points url(...) references at blobs from the EPUB.
  async _rewriteCss(css, path, seen = new Set()) {
    css = await replaceAsync(
      css,
      /@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/g,
      (m, href) => {
        const target = resolvePath(path, href);
        return target ? this._css(target.path, seen) : '';
      },
    );
    return replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/g, async (m, q, href) => {
      if (/^(data:|blob:|#)/.test(href)) return m;
      const target = resolvePath(path, href);
      const url = target && await this.blobURL(target.path);
      return url ? `url("${url}")` : 'url()';
    });
  }

  // Renders spine item `index` into the reader iframe's document. Scripts and
  // anything else active are stripped; images and CSS are served from blobs.
  async renderInto(idoc, index) {
    const path = this.spine[index].path;
    const doc = parseXML(await this.zip.text(path), 'application/xhtml+xml');
    const body = byName(doc, 'body')[0];
    if (!body) throw new Error('This chapter could not be read.');

    doc.querySelectorAll('script, iframe, object, embed, base, meta, form').forEach((el) => el.remove());
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }

    const styles = [];
    for (const el of doc.querySelectorAll('link, style')) {
      if (el.localName === 'style') {
        styles.push(await this._rewriteCss(el.textContent, path));
      } else if (/stylesheet/i.test(el.getAttribute('rel') || '') && el.getAttribute('href')) {
        const target = resolvePath(path, el.getAttribute('href'));
        if (target) styles.push(await this._css(target.path).catch(() => ''));
      }
      el.remove();
    }

    for (const el of doc.querySelectorAll('img, image, source, video, audio')) {
      for (const name of ['src', 'href', 'xlink:href', 'poster']) {
        const value = el.getAttribute(name);
        if (!value || /^(data:|blob:)/.test(value)) continue;
        const target = resolvePath(path, value);
        const url = target && await this.blobURL(target.path);
        if (url) el.setAttribute(name, url);
        else el.removeAttribute(name);
      }
      el.removeAttribute('srcset');
    }

    idoc.querySelectorAll('style[data-book]').forEach((el) => el.remove());
    const anchor = idoc.getElementById('reader-base');
    for (const css of styles) {
      const style = idoc.createElement('style');
      style.dataset.book = '';
      style.textContent = css;
      idoc.head.insertBefore(style, anchor);
    }

    const root = byName(doc, 'html')[0];
    const html = idoc.documentElement;
    html.lang = root?.getAttribute('lang') || root?.getAttribute('xml:lang') || this.lang || '';
    html.dir = root?.getAttribute('dir') || '';
    html.className = root?.getAttribute('class') || '';
    idoc.body.className = body.getAttribute('class') || '';
    idoc.body.id = body.getAttribute('id') || '';
    idoc.body.replaceChildren(...[...body.childNodes].map((n) => idoc.importNode(n, true)));
  }

  destroy() {
    for (const url of this.urls.values()) if (url) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
