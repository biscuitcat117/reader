import * as db from './db.js';
import { Book } from './epub.js';
import { Reader } from './reader.js';
import { AIPanel, settings } from './ai.js';

const $ = (s) => document.querySelector(s);
const libraryView = $('#library');
const readerView = $('#reader');
const grid = $('#book-grid');
const fileInput = $('#file-input');
const settingsDialog = $('#settings');

let books = [];
let current = null;
let coverUrls = [];

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---- Library ---------------------------------------------------------------

async function refreshLibrary() {
  books = await db.listBooks();
  books.sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  coverUrls.forEach((url) => URL.revokeObjectURL(url));
  coverUrls = [];
  grid.replaceChildren(...books.map(bookCard));
  $('#empty').hidden = books.length > 0;
}

function bookCard(meta) {
  const card = document.createElement('div');
  card.className = 'book';

  const open = document.createElement('button');
  open.className = 'cover';
  open.setAttribute('aria-label', `Open ${meta.title}`);
  if (meta.cover) {
    const url = URL.createObjectURL(new Blob([meta.cover.data], { type: meta.cover.type }));
    coverUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    open.append(img);
  } else {
    open.classList.add('plain');
    open.textContent = meta.title;
  }
  open.addEventListener('click', () => openBook(meta.id));

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = meta.title;
  const author = document.createElement('div');
  author.className = 'author';
  author.textContent = meta.author;

  const foot = document.createElement('div');
  foot.className = 'foot';
  const status = document.createElement('span');
  status.textContent = meta.opened ? `${Math.round((meta.progress || 0) * 100)}%` : 'New';
  const remove = document.createElement('button');
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    if (!confirm(`Remove “${meta.title}” from your library?`)) return;
    await db.deleteBook(meta.id);
    refreshLibrary();
  });
  foot.append(status, remove);

  card.append(open, title, author, foot);
  return card;
}

async function importFile(file) {
  const buffer = await file.arrayBuffer();
  const book = await Book.open(buffer);
  try {
    const title = book.title || file.name.replace(/\.epub$/i, '');
    if (books.some((b) => b.title === title && b.bytes === buffer.byteLength)) return false;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const meta = {
      id, title, author: book.author, cover: await book.cover(), bytes: buffer.byteLength,
      added: Date.now(), opened: 0, progress: 0, pos: null,
    };
    await db.addBook(meta, buffer);
    books.push(meta);
    return true;
  } finally {
    book.destroy();
  }
}

async function importFiles(files) {
  for (const file of files) {
    try {
      if (!await importFile(file)) toast(`“${file.name}” is already in your library.`);
    } catch (err) {
      toast(`Couldn’t add “${file.name}”: ${err.message}`);
    }
  }
  await refreshLibrary();
  navigator.storage?.persist?.();
}

// ---- Reader ----------------------------------------------------------------

let saveTimer;
function flushProgress() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (current) db.putBook(current).catch(() => {});
}

const ai = new AIPanel($('#ai-panel'), { openSettings });

const reader = new Reader(readerView, {
  onClose: showLibrary,
  onExplain: (ctx) => ai.open(ctx),
  onError: (err) => toast(err.message),
  onSave: () => flushProgress(),
  onProgress: ({ index, frac, progress }) => {
    if (!current) return;
    current.pos = { index, frac };
    current.progress = progress;
    saveTimer ??= setTimeout(flushProgress, 500);
  },
});

async function openBook(id) {
  const meta = books.find((b) => b.id === id);
  if (!meta) return;
  try {
    const buffer = await db.getFile(id);
    if (!buffer) throw new Error('The book file is missing.');
    libraryView.hidden = true;
    readerView.hidden = false;
    current = meta;
    await reader.open(meta, buffer);
    meta.opened = Date.now();
    flushProgress();
    localStorage.setItem('reader.open', id);
  } catch (err) {
    toast(`Couldn’t open “${meta.title}”: ${err.message}`);
    showLibrary();
  }
}

function showLibrary() {
  flushProgress();
  ai.close();
  reader.close();
  current = null;
  localStorage.removeItem('reader.open');
  readerView.hidden = true;
  libraryView.hidden = false;
  refreshLibrary();
}

// ---- Settings --------------------------------------------------------------

let modelsLoaded = false;
function openSettings() {
  $('#set-key').value = settings.key.get();
  $('#set-model').value = settings.model.get();
  $('#set-extra').value = settings.extra.get();
  settingsDialog.showModal();
  if (modelsLoaded) return;
  modelsLoaded = true;
  fetch('https://openrouter.ai/api/v1/models')
    .then((res) => res.json())
    .then(({ data }) => {
      $('#model-list').replaceChildren(...data.map((m) => new Option(m.name, m.id)));
    })
    .catch(() => { modelsLoaded = false; });
}

settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  settings.key.set($('#set-key').value.trim());
  settings.model.set($('#set-model').value.trim());
  settings.extra.set($('#set-extra').value.trim());
  ai.retry();
});

// ---- Wiring ----------------------------------------------------------------

$('#btn-settings').addEventListener('click', openSettings);
$('#btn-add').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  importFiles([...fileInput.files]);
  fileInput.value = '';
});
$('#btn-sample').addEventListener('click', async () => {
  try {
    const res = await fetch('sample/guide.epub');
    if (!res.ok) throw new Error('not found');
    await importFiles([new File([await res.blob()], 'guide.epub')]);
  } catch {
    toast('Couldn’t load the sample book.');
  }
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.epub$/i.test(f.name));
  if (files.length && !readerView.hidden) showLibrary();
  if (files.length) importFiles(files);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushProgress();
});

// Keeps the Explain panel above the on-screen keyboard.
const viewport = window.visualViewport;
if (viewport) {
  const update = () => {
    const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--keyboard', `${covered}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
}

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if ('serviceWorker' in navigator && !isLocal) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

await refreshLibrary();
const last = localStorage.getItem('reader.open');
if (last && books.some((b) => b.id === last)) openBook(last);
