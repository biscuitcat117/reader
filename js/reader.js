import { Book, resolvePath } from './epub.js';

const THEMES = {
  white: { bg: '#ffffff', fg: '#1c1c1e', link: '#0a60c2', ui: 'light' },
  sepia: { bg: '#f8f1e3', fg: '#5b4636', link: '#9a5a1c', ui: 'light' },
  gray: { bg: '#4a4a4c', fg: '#dddddd', link: '#9cc7ff', ui: 'dark' },
  night: { bg: '#000000', fg: '#b4b4b4', link: '#7fb2f0', ui: 'dark' },
};

const FONTS = {
  original: null,
  iowan: '"Iowan Old Style", Palatino, Georgia, serif',
  newyork: 'ui-serif, "New York", Georgia, serif',
  georgia: 'Georgia, serif',
  charter: 'Charter, "Bitstream Charter", Georgia, serif',
  sans: '-apple-system, system-ui, "Helvetica Neue", sans-serif',
};

// The page lives in an iframe so the book's CSS can't touch the app. The CSP
// keeps book content from running scripts or loading anything off-device.
const SKELETON = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; media-src blob:; font-src blob: data:; style-src 'unsafe-inline'">
<style id="reader-base"></style></head><body></body></html>`;

const PAD_Y = 60;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const squash = (s) => s.replace(/\s+/g, ' ');

export class Reader {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    const $ = (s) => root.querySelector(s);
    this.frame = $('#page');
    this.titleEl = $('#reader-title');
    this.pagesEl = $('#chapter-pages');
    this.percentEl = $('#book-percent');
    this.scrubber = $('#scrubber');
    this.tocPanel = $('#toc-panel');
    this.aaPanel = $('#aa-panel');
    this.menu = $('#sel-menu');
    this.explainBtn = $('#explain-btn');
    this.hlBtn = $('#hl-btn');
    this.noteBtn = $('#note-btn');
    this.notePanel = $('#note-panel');
    this.noteQuote = $('#note-quote');
    this.noteText = $('#note-text');
    this.tocList = $('#toc-list');
    this.hlList = $('#hl-list');
    this.view = { theme: 'white', font: 'original', size: 100 };
    try { Object.assign(this.view, JSON.parse(localStorage.getItem('reader.view') || '{}')); } catch { /* keep defaults */ }
    if (!THEMES[this.view.theme]) this.view.theme = 'white';
    if (!(this.view.font in FONTS)) this.view.font = 'original';
    this.page = 0;
    this.pages = 1;
    this.lastTouch = 0;

    this.ready = new Promise((resolve) => {
      this.frame.addEventListener('load', resolve, { once: true });
      this.frame.srcdoc = SKELETON;
    }).then(() => this._bindFrame());

    $('#btn-back').addEventListener('click', () => hooks.onClose());
    $('#btn-toc').addEventListener('click', () => this._togglePanel(this.tocPanel));
    $('#btn-aa').addEventListener('click', () => this._togglePanel(this.aaPanel));
    $('#aa-smaller').addEventListener('click', () => this._setView({ size: clamp(this.view.size - 10, 70, 250) }));
    $('#aa-larger').addEventListener('click', () => this._setView({ size: clamp(this.view.size + 10, 70, 250) }));
    $('#aa-font').addEventListener('change', (e) => this._setView({ font: e.target.value }));
    for (const swatch of root.querySelectorAll('[data-theme]')) {
      swatch.addEventListener('click', () => this._setView({ theme: swatch.dataset.theme }));
    }
    this.scrubber.addEventListener('change', () => this._scrubTo(this.scrubber.value / 1000));
    this.tocPanel.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { this._setTab(tab.dataset.tab); return; }
      const item = e.target.closest('[data-toc], [data-hl]');
      if (!item) return;
      this._closePanels();
      if (item.dataset.toc) {
        const entry = this.book.toc[item.dataset.toc];
        this.goTo(entry.path, entry.hash);
      } else {
        const hl = this.meta.highlights.find((h) => h.id === item.dataset.hl);
        if (!hl) return;
        if (hl.index === this.index) this._show(this._pageOf(this._mark(hl.id)) ?? 0, false);
        else this.load(hl.index, { highlight: hl.id });
      }
    });
    // preventDefault on pointerdown keeps the text selection alive while tapping.
    this.menu.addEventListener('pointerdown', (e) => e.preventDefault());
    this.explainBtn.addEventListener('click', () => {
      if (!this.selection) return;
      const { text, before, after } = this.selection;
      this.menu.hidden = true;
      hooks.onExplain({ text, before, after, title: this.book.title, author: this.book.author, chapter: this._chapterLabel() });
    });
    this.hlBtn.addEventListener('click', () => this._toggleHighlight());
    this.noteBtn.addEventListener('click', () => this._openNote());
    $('#note-done').addEventListener('click', () => this._closeNote());

    document.addEventListener('keydown', (e) => this._onKey(e));
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.relayout(), 150);
    });
    this._applyUi();
  }

  get isOpen() { return !!this.book && !this.root.hidden; }

  _bindFrame() {
    const d = this.idoc = this.frame.contentDocument;
    d.addEventListener('click', (e) => this._onClick(e), true);
    d.addEventListener('touchstart', (e) => this._touchStart(e), { passive: true });
    d.addEventListener('touchmove', (e) => this._touchMove(e), { passive: true });
    d.addEventListener('touchend', (e) => this._touchEnd(e), { passive: true });
    d.addEventListener('touchcancel', () => {
      this.touch = null;
      if (this.dismissing) this._endDismiss(false);
    });
    d.addEventListener('keydown', (e) => this._onKey(e));
    d.addEventListener('selectionchange', () => {
      clearTimeout(this.selTimer);
      this.selTimer = setTimeout(() => this._updateExplain(), 200);
    });
  }

  async open(meta, buffer) {
    await this.ready;
    this.close();
    this.book = await Book.open(buffer);
    this.meta = meta;
    meta.highlights ??= [];
    if (!this.book.title) this.book.title = meta.title;
    this.total = this.book.spine.reduce((sum, s) => sum + (s.size || 1), 0);
    this.titleEl.textContent = meta.title;
    this._renderToc();
    this._renderHighlights();
    this._setTab('toc');
    this._applyUi();
    this.root.classList.remove('chrome-hidden');
    const pos = meta.pos || { index: 0, frac: 0 };
    await this.load(clamp(pos.index, 0, this.book.spine.length - 1), { frac: pos.frac });
  }

  close() {
    this._closeNote();
    this._closePanels();
    this._hideExplain();
    this.book?.destroy();
    this.book = null;
    if (this.idoc) {
      this.idoc.body.replaceChildren();
      this.idoc.querySelectorAll('style[data-book]').forEach((el) => el.remove());
    }
  }

  // ---- Chapter loading and pagination -------------------------------------

  // `where` is one of {frac}, {end: true}, {hash} or {highlight}; default is the first page.
  async load(index, where = {}) {
    if (this.loading || !this.book) return;
    this.loading = true;
    const body = this.idoc.body;
    try {
      this._hideExplain();
      body.style.opacity = '0';
      await this.book.renderInto(this.idoc, index);
      this.index = index;
      this._paintHighlights();
      await this._assetsSettled();
      this._layout();
      let page = 0;
      if (where.end) page = this.pages - 1;
      else if (where.hash) page = this._pageOf(this._target(where.hash)) ?? 0;
      else if (where.highlight) page = this._pageOf(this._mark(where.highlight)) ?? 0;
      else if (where.frac) page = Math.floor(where.frac * this.pages + 1e-6);
      this._show(page, false);
    } catch (err) {
      this.hooks.onError(err);
    } finally {
      body.style.opacity = '';
      this.loading = false;
    }
  }

  _assetsSettled() {
    const images = [...this.idoc.images].filter((img) => !img.complete);
    const loaded = images.map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }));
    const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
    return Promise.race([Promise.all([...loaded, this.idoc.fonts?.ready]), timeout]);
  }

  // Lays the chapter out as CSS columns one screen wide; pages are turned by
  // sliding the body sideways. One page is exactly `W` pixels of travel.
  _layout() {
    const W = this.frame.clientWidth;
    const H = this.frame.clientHeight;
    if (!W || !H) return;
    const n = W >= 900 && W > H ? 2 : 1;
    let gap = Math.round(n === 2 ? W * 0.08 : clamp(W * 0.13, 40, 160));
    gap += gap % 2;
    const colW = (W - gap * n) / n;
    const theme = THEMES[this.view.theme];
    const font = FONTS[this.view.font];
    this.W = W;
    this.gap = gap;

    this.idoc.getElementById('reader-base').textContent = `
:where(body){font-family:"Iowan Old Style",Palatino,Georgia,serif;line-height:1.55;-webkit-hyphens:auto;hyphens:auto}
html{height:100%!important;margin:0!important;padding:0!important;overflow:clip!important;font-size:${this.view.size}%!important;background:${theme.bg}!important;-webkit-text-size-adjust:100%}
body{margin:0!important;padding:${PAD_Y}px ${gap / 2}px!important;box-sizing:border-box!important;position:static!important;width:${W}px!important;height:${H}px!important;min-width:0!important;max-width:none!important;column-width:${colW}px!important;column-gap:${gap}px!important;column-fill:auto!important;overflow:visible!important;background:${theme.bg}!important;color:${theme.fg}!important;overflow-wrap:break-word;-webkit-user-select:text;user-select:text;${font ? `font-family:${font}!important;` : ''}}
html[data-anim] body{transition:transform .32s cubic-bezier(.25,.8,.3,1)}
img,svg,video{max-width:100%!important;max-height:${H - 2 * PAD_Y}px!important;object-fit:contain;break-inside:avoid}
p,li,blockquote{orphans:2;widows:2}
::selection{background:rgba(120,170,255,.4)}
${this.view.theme === 'white' ? '' : 'body *{color:inherit!important;background-color:transparent!important;border-color:currentColor!important}'}
body a{color:${theme.link}!important}
mark[data-hl]{background-color:rgba(255,205,0,${theme.ui === 'dark' ? '.32' : '.45'})!important;color:inherit!important}
mark[data-note]{border-bottom:2px solid rgba(235,150,0,.95)!important}
${font ? `body *:not(pre,code,kbd,samp,pre *){font-family:${font}!important}` : ''}`;

    const body = this.idoc.body;
    const range = this.idoc.createRange();
    range.selectNodeContents(body);
    const left = body.getBoundingClientRect().left;
    const extent = Math.max(body.scrollWidth, range.getBoundingClientRect().right - left);
    const columns = Math.max(1, Math.ceil((extent - gap / 2 - 1) / (colW + gap)));
    this.pages = Math.ceil(columns / n);
  }

  // Re-paginates after a size/font/orientation change, keeping the same text
  // at the top of the page.
  relayout() {
    if (!this.isOpen || this.loading) return;
    const anchor = this._anchor();
    const frac = this.page / this.pages;
    this._layout();
    const page = this._pageOfRange(anchor) ?? Math.floor(frac * this.pages + 1e-6);
    this._show(page, false);
  }

  _anchor() {
    const range = this.idoc.caretRangeFromPoint?.(this.gap / 2 + 4, PAD_Y + 4);
    if (!range || !this.idoc.body.contains(range.startContainer)) return null;
    return range;
  }

  _pageOfRange(range) {
    if (!range) return null;
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE && range.startOffset < node.length) {
      const probe = this.idoc.createRange();
      probe.setStart(node, range.startOffset);
      probe.setEnd(node, range.startOffset + 1);
      const rect = probe.getClientRects()[0];
      if (rect) return this._pageAt(rect.left);
    }
    return this._pageOf(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  }

  _pageOf(el) {
    if (!el) return null;
    const rect = el.getClientRects()[0] || el.getBoundingClientRect();
    return this._pageAt(rect.left);
  }

  _pageAt(clientX) {
    const x = clientX - this.idoc.body.getBoundingClientRect().left;
    return clamp(Math.floor(x / this.W), 0, this.pages - 1);
  }

  _target(hash) {
    return this.idoc.getElementById(hash) || this.idoc.querySelector(`[name="${CSS.escape(hash)}"]`);
  }

  _show(page, animate) {
    this.page = clamp(page, 0, this.pages - 1);
    this.idoc.documentElement.toggleAttribute('data-anim', animate);
    this.idoc.body.style.transform = `translate3d(${-this.page * this.W}px,0,0)`;
    this.idoc.getSelection()?.removeAllRanges();
    this._hideExplain();

    const spine = this.book.spine;
    const before = spine.slice(0, this.index).reduce((sum, s) => sum + (s.size || 1), 0);
    const atEnd = this.index === spine.length - 1 && this.page === this.pages - 1;
    const frac = this.page / this.pages;
    const progress = atEnd ? 1 : (before + (spine[this.index].size || 1) * frac) / this.total;
    this.pagesEl.textContent = `${this.page + 1} of ${this.pages}`;
    this.percentEl.textContent = `${Math.round(progress * 100)}%`;
    this.scrubber.value = Math.round(progress * 1000);
    this.hooks.onProgress({ index: this.index, frac, progress });
  }

  // ---- Navigation ----------------------------------------------------------

  next() {
    if (this.loading) return;
    this.root.classList.add('chrome-hidden');
    if (this.page < this.pages - 1) this._show(this.page + 1, true);
    else if (this.index < this.book.spine.length - 1) this.load(this.index + 1);
  }

  prev() {
    if (this.loading) return;
    this.root.classList.add('chrome-hidden');
    if (this.page > 0) this._show(this.page - 1, true);
    else if (this.index > 0) this.load(this.index - 1, { end: true });
  }

  goTo(path, hash) {
    const index = this.book.spine.findIndex((s) => s.path === path);
    if (index < 0) return;
    if (index === this.index) this._show(hash ? this._pageOf(this._target(hash)) ?? 0 : 0, false);
    else this.load(index, { hash });
  }

  _scrubTo(progress) {
    let offset = progress * this.total;
    const spine = this.book.spine;
    let index = 0;
    while (index < spine.length - 1 && offset >= (spine[index].size || 1)) {
      offset -= spine[index].size || 1;
      index++;
    }
    const frac = clamp(offset / (spine[index].size || 1), 0, 0.999);
    if (index === this.index) this._show(Math.floor(frac * this.pages), false);
    else this.load(index, { frac });
  }

  _followLink(href) {
    const target = resolvePath(this.book.spine[this.index].path, href);
    if (target) this.goTo(target.path, target.hash);
    else if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
  }

  // ---- Input ---------------------------------------------------------------

  _hasSelection() {
    const sel = this.idoc.getSelection();
    return !!sel && !sel.isCollapsed;
  }

  _touchStart(e) {
    this.hooks.onActivity();
    if (e.touches.length > 1) { this.touch = null; return; }
    const t = e.touches[0];
    this.touch = {
      x: t.clientX, y: t.clientY, screenX: t.screenX, screenY: t.screenY,
      time: Date.now(), hadSelection: this._hasSelection(),
    };
  }

  // Dragging down shrinks the book under the finger; letting go far enough
  // down closes it. Screen coordinates are used because the page itself is
  // being scaled while the finger moves.
  _touchMove(e) {
    const start = this.touch;
    if (!start || start.horizontal || e.touches.length > 1) return;
    const t = e.touches[0];
    const dx = t.screenX - start.screenX;
    const dy = t.screenY - start.screenY;
    if (!this.dismissing) {
      if (start.hadSelection || this._hasSelection() || this.noteHighlight || this.loading) return;
      if (Math.abs(dx) > 14 && Math.abs(dx) >= Math.abs(dy)) { start.horizontal = true; return; }
      if (dy < 14 || dy < Math.abs(dx) * 1.5) return;
      this.dismissing = true;
      this._closePanels();
      this._hideExplain();
      this.root.classList.add('dismissing');
      this.hooks.onDismissStart();
    }
    const pull = Math.max(0, dy);
    const progress = clamp(pull / (window.innerHeight * 0.6), 0, 1);
    this.dismissPull = pull;
    this.root.style.transition = 'none';
    this.root.style.transform = `translate(${dx * 0.5}px, ${pull * 0.55}px) scale(${1 - progress * 0.35})`;
  }

  _endDismiss(close) {
    this.dismissing = false;
    const root = this.root;
    root.style.transition = 'transform .25s ease, opacity .25s ease';
    root.style.transform = close ? `translateY(${window.innerHeight * 0.3}px) scale(.3)` : '';
    if (close) root.style.opacity = '0';
    setTimeout(() => {
      if (close) this.hooks.onClose();
      else this.hooks.onDismissCancel();
      root.classList.remove('dismissing');
      root.style.transition = root.style.transform = root.style.opacity = '';
    }, 260);
  }

  _touchEnd(e) {
    const start = this.touch;
    this.touch = null;
    if (!start) return;
    this.lastTouch = Date.now();
    if (this.dismissing) { this._endDismiss(this.dismissPull > 110); return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const elapsed = Date.now() - start.time;
    if (start.hadSelection || this._hasSelection()) return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && elapsed < 800) {
      if (dx < 0) this.next(); else this.prev();
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && elapsed < 350) {
      if (e.target.closest?.('a[href]')) return;
      this._tap(t.clientX, e.target);
    }
  }

  _onClick(e) {
    this.hooks.onActivity();
    const link = e.target.closest?.('a');
    const href = link?.getAttribute('href') || link?.getAttribute('xlink:href');
    if (link) {
      e.preventDefault();
      if (href) this._followLink(href);
      return;
    }
    // Touch taps are handled in _touchEnd; this is for mouse and trackpad.
    if (Date.now() - this.lastTouch < 700 || this._hasSelection()) return;
    this._tap(e.clientX, e.target);
  }

  _tap(x, target) {
    if (this.noteHighlight) { this._closeNote(); return; }
    if (!this.tocPanel.hidden || !this.aaPanel.hidden) { this._closePanels(); return; }
    const mark = target?.closest?.('mark[data-hl]');
    if (mark) { this._openHighlight(mark.dataset.hl); return; }
    if (this.activeHighlight) { this._hideExplain(); return; }
    if (x < this.W * 0.22) this.prev();
    else if (x > this.W * 0.78) this.next();
    else this.root.classList.toggle('chrome-hidden');
  }

  _onKey(e) {
    if (!this.isOpen || e.target.closest?.('input, textarea, select, dialog')) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); this.next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); this.prev(); }
  }

  // ---- Selection → Explain -------------------------------------------------

  _hideExplain() {
    this.menu.hidden = true;
    this.selection = null;
    this.activeHighlight = null;
  }

  // Describes the chapter text between two character offsets, plus the text
  // around it for the AI to use as context.
  _context(start, end) {
    const all = this.idoc.body.textContent;
    return {
      start,
      end,
      text: squash(all.slice(start, end)).trim(),
      before: squash(all.slice(Math.max(0, start - 1500), start)),
      after: squash(all.slice(end, end + 800)),
    };
  }

  _updateExplain() {
    const sel = this.idoc.getSelection();
    const selected = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString() : '';
    if (!selected.trim() || !this.book) {
      if (!this.activeHighlight) this._hideExplain();
      return;
    }
    const range = sel.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.right > 0 && r.left < this.W);
    if (!rects.length) { this._hideExplain(); return; }

    const before = this.idoc.createRange();
    before.selectNodeContents(this.idoc.body);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    this.selection = this._context(start, start + range.toString().length);
    this.activeHighlight = null;
    this.hlBtn.textContent = 'Highlight';
    this.noteBtn.textContent = 'Note';
    this._placeMenu(rects);
    if (window.readerNative?.menu) this.menu.hidden = true;
  }

  // Explain/Highlight chosen from the iOS system selection menu.
  nativeAction(kind) {
    if (!this.isOpen) return;
    this._updateExplain();
    if (!this.selection) return;
    ({ explain: this.explainBtn, highlight: this.hlBtn, note: this.noteBtn })[kind]?.click();
  }

  // Sits below the text: iPadOS puts its own Copy/Look Up menu above.
  _placeMenu(rects) {
    const menu = this.menu;
    menu.hidden = false;
    const frame = this.frame.getBoundingClientRect();
    const first = rects[0];
    const last = rects[rects.length - 1];
    const x = frame.left + last.left + last.width / 2 - menu.offsetWidth / 2;
    let y = frame.top + last.bottom + 18;
    if (y + menu.offsetHeight > window.innerHeight - 12) y = frame.top + first.top - menu.offsetHeight - 18;
    menu.style.left = `${clamp(x, 12, window.innerWidth - menu.offsetWidth - 12)}px`;
    menu.style.top = `${Math.max(12, y)}px`;
  }

  // ---- Highlights ----------------------------------------------------------

  _mark(id) {
    return this.idoc.body.querySelector(`mark[data-hl="${id}"]`);
  }

  // Highlights are stored as character offsets into the chapter's text and
  // drawn by wrapping the matching text in <mark> elements.
  _paintHighlights() {
    const body = this.idoc.body;
    for (const mark of body.querySelectorAll('mark[data-hl]')) mark.replaceWith(...mark.childNodes);
    body.normalize();
    for (const hl of this.meta.highlights) {
      if (hl.index !== this.index) continue;
      const walker = this.idoc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const pieces = [];
      let pos = 0;
      for (let node; (node = walker.nextNode());) {
        const from = Math.max(hl.start, pos);
        const to = Math.min(hl.end, pos + node.length);
        if (from < to && /\S/.test(node.data.slice(from - pos, to - pos))) pieces.push([node, from - pos, to - pos]);
        pos += node.length;
        if (pos >= hl.end) break;
      }
      for (const [node, from, to] of pieces) {
        const range = this.idoc.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        const mark = this.idoc.createElement('mark');
        mark.dataset.hl = hl.id;
        if (hl.note) mark.dataset.note = '';
        range.surroundContents(mark);
      }
    }
  }

  _openHighlight(id) {
    const hl = this.meta.highlights.find((h) => h.id === id);
    const marks = [...this.idoc.body.querySelectorAll(`mark[data-hl="${id}"]`)];
    const rects = marks.flatMap((m) => [...m.getClientRects()]).filter((r) => r.right > 0 && r.left < this.W);
    if (!hl || !rects.length) return;
    this.selection = this._context(hl.start, hl.end);
    this.activeHighlight = id;
    this.hlBtn.textContent = 'Remove Highlight';
    this.noteBtn.textContent = hl.note ? 'Edit Note' : 'Add Note';
    this._placeMenu(rects);
  }

  _addHighlight(s) {
    const hl = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      index: this.index, start: s.start, end: s.end, text: s.text,
      chapter: this._chapterLabel(), created: Date.now(),
    };
    this.meta.highlights.push(hl);
    return hl;
  }

  _highlightsChanged() {
    this.idoc.getSelection()?.removeAllRanges();
    this._hideExplain();
    this._paintHighlights();
    this._renderHighlights();
    this.hooks.onSave();
  }

  _toggleHighlight() {
    if (!this.selection) return;
    if (this.activeHighlight) {
      this.meta.highlights = this.meta.highlights.filter((h) => h.id !== this.activeHighlight);
    } else {
      this._addHighlight(this.selection);
    }
    this._highlightsChanged();
  }

  // ---- Notes ---------------------------------------------------------------

  // A note belongs to a highlight; adding one to plain selected text
  // highlights it first.
  _openNote() {
    if (!this.selection) return;
    const hl = this.meta.highlights.find((h) => h.id === this.activeHighlight) || this._addHighlight(this.selection);
    this._highlightsChanged();
    this.noteHighlight = hl;
    this.noteQuote.textContent = hl.text;
    this.noteText.value = hl.note || '';
    this.notePanel.hidden = false;
    this.noteText.focus();
  }

  _closeNote() {
    const hl = this.noteHighlight;
    if (!hl) return;
    this.noteHighlight = null;
    this.notePanel.hidden = true;
    this.noteText.blur();
    const note = this.noteText.value.trim();
    if (note) hl.note = note; else delete hl.note;
    this._paintHighlights();
    this._renderHighlights();
    this.hooks.onSave();
  }

  _renderHighlights() {
    const sorted = [...this.meta.highlights].sort((a, b) => a.index - b.index || a.start - b.start);
    this.hlList.replaceChildren(...sorted.map((hl) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.dataset.hl = hl.id;
      const text = document.createElement('span');
      text.className = 'quote';
      text.textContent = hl.text;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = hl.chapter;
      button.append(text);
      if (hl.note) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = hl.note;
        button.append(note);
      }
      button.append(where);
      li.append(button);
      return li;
    }));
    if (this.tab) this._setTab(this.tab);
  }

  // ---- Panels and appearance -----------------------------------------------

  _chapterLabel() {
    let label = '';
    for (const entry of this.book.toc) {
      if (entry.spineIndex >= 0 && entry.spineIndex <= this.index) label = entry.label;
    }
    return label;
  }

  _renderToc() {
    const list = this.tocList;
    list.replaceChildren();
    this.book.toc.forEach((entry, i) => {
      if (entry.spineIndex < 0) return;
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.dataset.toc = i;
      button.textContent = entry.label || 'Untitled';
      button.style.paddingLeft = `${16 + entry.depth * 18}px`;
      li.append(button);
      list.append(li);
    });
  }

  _setTab(tab) {
    this.tab = tab;
    for (const button of this.tocPanel.querySelectorAll('[data-tab]')) {
      button.setAttribute('aria-pressed', button.dataset.tab === tab);
    }
    this.tocList.hidden = tab !== 'toc';
    this.hlList.hidden = tab !== 'hl';
    const empty = this.tocPanel.querySelector('.empty');
    empty.hidden = (tab === 'toc' ? this.tocList : this.hlList).children.length > 0;
    empty.textContent = tab === 'toc'
      ? 'This book has no table of contents.'
      : 'No highlights yet. Select some text and tap Highlight.';
  }

  _togglePanel(panel) {
    const show = panel.hidden;
    this._closePanels();
    panel.hidden = !show;
    if (show && panel === this.tocPanel) {
      const current = this._chapterLabel();
      for (const button of panel.querySelectorAll('[data-toc]')) {
        const isCurrent = button.textContent === current;
        button.classList.toggle('current', isCurrent);
        if (isCurrent) button.scrollIntoView({ block: 'center' });
      }
    }
  }

  _closePanels() {
    this.tocPanel.hidden = true;
    this.aaPanel.hidden = true;
  }

  _setView(change) {
    Object.assign(this.view, change);
    localStorage.setItem('reader.view', JSON.stringify(this.view));
    this._applyUi();
    this.relayout();
  }

  _applyUi() {
    const theme = THEMES[this.view.theme];
    this.root.dataset.ui = theme.ui;
    this.root.style.setProperty('--page-bg', theme.bg);
    this.root.style.setProperty('--page-fg', theme.fg);
    this.root.querySelector('#aa-font').value = this.view.font;
    this.root.querySelector('#aa-size').textContent = `${this.view.size}%`;
    for (const swatch of this.root.querySelectorAll('[data-theme]')) {
      swatch.setAttribute('aria-pressed', swatch.dataset.theme === this.view.theme);
    }
  }
}
