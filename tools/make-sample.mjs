// Builds sample/guide.epub, the short guide offered when the library is empty.
// Run with: node tools/make-sample.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'sample', 'guide.epub');

const chapters = [
  {
    id: 'welcome',
    title: 'Welcome',
    body: `
<p>This is a short guide to Reader, and also a small book you can practise on. It takes about two minutes to read.</p>
<p>Reader opens EPUB books that you add from the Files app. Your books, your place in each one, and your settings are kept on this iPad. Nothing is uploaded anywhere, with one exception that is described in the last chapter: when you ask for an explanation, the passage you highlighted is sent to the AI model you have chosen.</p>
<p>To add a book, go back to the Library and tap <b>Add Book</b>. Books bought from Apple Books or Kindle are usually locked to those apps and cannot be opened here; books from Project Gutenberg, Standard Ebooks, and most independent publishers work well.</p>
<p class="aside">Tip: once Reader is on your Home Screen it opens full screen and keeps working without an internet connection. Only explanations need to be online.</p>`,
  },
  {
    id: 'reading',
    title: 'Turning Pages',
    body: `
<p>Tap the right edge of the page, or swipe left, to go forward. Tap the left edge, or swipe right, to go back. With a keyboard attached, the arrow keys and the space bar do the same.</p>
<p>Tap the middle of the page to show or hide the controls. At the top you will find the way back to the Library, the table of contents, and the <b>AA</b> button. At the bottom is a slider that moves you through the whole book.</p>
<h2 id="appearance">Making it comfortable</h2>
<p>The <b>AA</b> button changes how the page looks. You can make the text larger or smaller, switch between white, sepia, gray and night pages, and choose a typeface. <i>Original</i> keeps whatever the publisher chose.</p>
<p>Turn your iPad sideways and Reader shows two pages next to each other, like an open book. Turn it upright for a single, wider page. Whatever you change, Reader keeps the same sentence at the top of the page so that you do not lose your place.</p>
<p>When you close a book, Reader remembers the page. The Library shows how far through each book you are.</p>`,
  },
  {
    id: 'explain',
    title: 'Asking for an Explanation',
    body: `
<p>Touch and hold a word, then drag the handles to cover the passage you want. Two buttons appear just below your selection. Tap <b>Explain</b>, and a panel opens with an explanation written for that passage, in the context of the page around it.</p>
<p>Here is something to try it on:</p>
<blockquote>
<p>It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, it was the spring of hope, it was the winter of despair.</p>
</blockquote>
<p>Select a single word, such as <i>incredulity</i>, to get its meaning as it is used here. Select the whole sentence to have the idea behind it explained. You can then type a follow-up question at the bottom of the panel, for example “why does he repeat himself so much?”</p>
<p>Tap <b>Highlight</b> instead to mark the passage in yellow. Your highlights are listed next to the table of contents, and tapping one in the text lets you explain it again or remove it.</p>
<h2 id="setup">Setting it up</h2>
<p>Explanations come from a model on OpenRouter, so Reader needs an OpenRouter API key. In the Library, tap <b>Settings</b>, paste your key, and choose a model. The key is stored only on this iPad.</p>
<p>The same screen has a box for extra instructions. Anything you write there is added to every request, so you can ask for simpler language, a different language, or more detail.</p>`,
  },
];

const css = `
body { font-family: Georgia, serif; line-height: 1.6; }
h1 { font-size: 1.7em; font-weight: normal; text-align: center; margin: 2em 0 1.5em; }
h2 { font-size: 1.15em; margin: 1.8em 0 .6em; }
p { margin: 0; text-indent: 1.4em; text-align: justify; }
h1 + p, h2 + p, blockquote p { text-indent: 0; }
blockquote { margin: 1.2em 1.5em; font-style: italic; }
.aside { margin-top: 1.4em; padding: .8em 1em; text-indent: 0; text-align: left; border-left: 3px solid #d98a3d; background: #fbf3ea; font-size: .92em; }
`;

const cover = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f29a40"/><stop offset="1" stop-color="#d9652b"/></linearGradient></defs>
<rect width="600" height="900" fill="url(#g)"/>
<rect x="40" y="40" width="520" height="820" fill="none" stroke="#fff6e8" stroke-width="3" opacity=".7"/>
<text x="300" y="380" text-anchor="middle" font-family="Georgia, serif" font-size="74" fill="#fffaf2">A Guide</text>
<text x="300" y="470" text-anchor="middle" font-family="Georgia, serif" font-size="74" fill="#fffaf2">to Reader</text>
<text x="300" y="770" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="#fffaf2" opacity=".85">Two minutes, three chapters</text>
</svg>`;

const page = (c) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>${c.title}</title><link rel="stylesheet" href="style.css"/></head>
<body>
<h1>${c.title}</h1>${c.body}
</body>
</html>`;

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">reader-guide</dc:identifier>
<dc:title>A Guide to Reader</dc:title>
<dc:creator>Reader</dc:creator>
<dc:language>en</dc:language>
<meta property="dcterms:modified">2026-10-02T00:00:00Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
${chapters.map((c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine>
${chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n')}
</spine>
</package>`;

const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc"><ol>
${chapters.map((c) => `<li><a href="${c.id}.xhtml">${c.title}</a></li>`).join('\n')}
</ol></nav>
</body>
</html>`;

const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const dir = mkdtempSync(join(tmpdir(), 'guide-'));
mkdirSync(join(dir, 'META-INF'));
mkdirSync(join(dir, 'OEBPS'));
writeFileSync(join(dir, 'mimetype'), 'application/epub+zip');
writeFileSync(join(dir, 'META-INF', 'container.xml'), container);
writeFileSync(join(dir, 'OEBPS', 'content.opf'), opf);
writeFileSync(join(dir, 'OEBPS', 'nav.xhtml'), nav);
writeFileSync(join(dir, 'OEBPS', 'style.css'), css);
writeFileSync(join(dir, 'OEBPS', 'cover.svg'), cover);
for (const c of chapters) writeFileSync(join(dir, 'OEBPS', `${c.id}.xhtml`), page(c));

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-X0q', out, 'mimetype'], { cwd: dir });
execFileSync('zip', ['-Xr9q', out, 'META-INF', 'OEBPS'], { cwd: dir });
rmSync(dir, { recursive: true });
