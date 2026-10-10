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

// ---- Reading time ----------------------------------------------------------

// Seconds read per day, keyed by local date. Time counts while a book is open
// and on screen, and pauses after five minutes without a touch or page turn.
const IDLE_MS = 5 * 60 * 1000;
const RING = 2 * Math.PI * 18;
const dayKey = (date = new Date()) => date.toLocaleDateString('en-CA');
const goalMinutes = () => Math.max(1, parseInt(localStorage.getItem('reader.goal'), 10) || 10);

function readingLog() {
  try { return JSON.parse(localStorage.getItem('reader.time') || '{}'); } catch { return {}; }
}

let lastActivity = 0;
let lastTick = Date.now();
const noteActivity = () => { lastActivity = Date.now(); };

setInterval(() => {
  const now = Date.now();
  const elapsed = Math.min(now - lastTick, 10000);
  lastTick = now;
  if (!current || document.hidden || now - lastActivity > IDLE_MS) return;
  const log = readingLog();
  log[dayKey()] = (log[dayKey()] || 0) + elapsed / 1000;
  const days = Object.keys(log).sort();
  for (const old of days.slice(0, -400)) delete log[old];
  localStorage.setItem('reader.time', JSON.stringify(log));
}, 5000);

function renderReadingTime() {
  const log = readingLog();
  const goal = goalMinutes();
  const minutes = Math.floor((log[dayKey()] || 0) / 60);
  const met = (date) => (log[dayKey(date)] || 0) >= goal * 60;

  // Days in a row the goal was met; today only counts once it has been.
  const day = new Date();
  if (!met(day)) day.setDate(day.getDate() - 1);
  let streak = 0;
  while (met(day)) {
    streak++;
    day.setDate(day.getDate() - 1);
  }

  const hours = Math.floor(minutes / 60);
  $('#today-time').textContent = hours ? `${hours} hr ${minutes % 60} min` : `${minutes} min`;
  $('#today-goal').textContent = `of your ${goal} min goal${streak > 1 ? ` · ${streak}-day streak` : ''}`;
  const ring = $('#today-ring');
  ring.style.strokeDasharray = RING;
  ring.style.strokeDashoffset = RING * (1 - Math.min(1, minutes / goal));
}

// ---- Library ---------------------------------------------------------------

async function refreshLibrary() {
  books = await db.listBooks();
  books.sort((a, b) => a.title.localeCompare(b.title));
  coverUrls.forEach((url) => URL.revokeObjectURL(url));
  coverUrls = [];
  grid.replaceChildren(...books.map(bookCard));
  const recent = books.filter((b) => b.opened).sort((a, b) => b.opened - a.opened).slice(0, 4);
  $('#recent-row').replaceChildren(...recent.map(recentCard));
  $('#recent').hidden = recent.length === 0;
  $('#all-heading').hidden = recent.length === 0;
  $('#empty').hidden = books.length > 0;
  renderReadingTime();
}

function coverImage(meta) {
  if (!meta.cover) return null;
  const url = URL.createObjectURL(new Blob([meta.cover.data], { type: meta.cover.type }));
  coverUrls.push(url);
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  return img;
}

function recentCard(meta) {
  const card = document.createElement('button');
  card.className = 'recent-card';
  const cover = document.createElement('div');
  cover.className = 'thumb';
  const img = coverImage(meta);
  if (img) cover.append(img);

  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = meta.title;
  const author = document.createElement('div');
  author.className = 'author';
  author.textContent = meta.author;
  const percent = Math.round((meta.progress || 0) * 100);
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.setProperty('--progress', `${percent}%`);
  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = percent >= 100 ? 'Finished' : `${percent}%`;
  info.append(title, author, bar, status);

  card.append(cover, info);
  card.addEventListener('click', () => openBook(meta.id));
  return card;
}

function bookCard(meta) {
  const card = document.createElement('div');
  card.className = 'book';

  const open = document.createElement('button');
  open.className = 'cover';
  open.setAttribute('aria-label', `Open ${meta.title}`);
  const img = coverImage(meta);
  if (img) {
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
  onActivity: noteActivity,
  // The library shows behind the book while it is being dragged closed.
  onDismissStart: () => {
    flushProgress();
    libraryView.hidden = false;
    refreshLibrary();
  },
  onDismissCancel: () => { libraryView.hidden = true; },
  onProgress: ({ index, frac, progress }) => {
    if (!current) return;
    noteActivity();
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

// A hand-picked spread of current models, from most capable to cheapest.
// Anything else on OpenRouter can be entered under "Other…".
const MODELS = [
  ['anthropic/claude-fable-5.1', 'Claude Fable 5.1'],
  ['anthropic/claude-opus-5.5', 'Claude Opus 5.5'],
  ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'],
  ['openai/gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['x-ai/grok-4.7', 'Grok 4.7'],
  ['google/gemini-3.8-flash', 'Gemini 3.8 Flash'],
  ['mistralai/mistral-large-4-0', 'Mistral Large 4'],
  ['deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
  ['anthropic/claude-haiku-5.5', 'Claude Haiku 5.5'],
  ['openai/gpt-6-luna', 'GPT-6 Luna'],
];

let prices = new Map();
function renderModels() {
  const select = $('#set-model');
  const selected = settings.model.get();
  const listed = MODELS.some(([id]) => id === selected) ? MODELS : [...MODELS, [selected, selected]];
  select.replaceChildren(
    ...listed.map(([id, name]) => new Option(prices.has(id) ? `${name} · ${prices.get(id)}` : name, id)),
    new Option('Other…', ''),
  );
  select.value = selected;
  $('#set-model-custom').hidden = true;
  $('#set-model-custom').value = '';
}

$('#set-model').addEventListener('change', (e) => {
  $('#set-model-custom').hidden = e.target.value !== '';
});

let modelsLoaded = false;
function openSettings() {
  $('#set-key').value = settings.key.get();
  renderModels();
  $('#set-extra').value = settings.extra.get();
  $('#set-goal').value = goalMinutes();
  settingsDialog.showModal();
  if (modelsLoaded) return;
  modelsLoaded = true;
  fetch('https://openrouter.ai/api/v1/models')
    .then((res) => res.json())
    .then(({ data }) => {
      $('#model-list').replaceChildren(...data.map((m) => new Option(m.name, m.id)));
      const dollars = (perToken) => `$${Number((perToken * 1e6).toFixed(2))}`;
      prices = new Map(data.map((m) => [m.id, `${dollars(m.pricing.prompt)} / ${dollars(m.pricing.completion)}`]));
      if (settingsDialog.open && $('#set-model-custom').hidden) {
        const chosen = $('#set-model').value;
        renderModels();
        $('#set-model').value = chosen;
      }
    })
    .catch(() => { modelsLoaded = false; });
}

settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  settings.key.set($('#set-key').value.trim());
  settings.model.set($('#set-model').value || $('#set-model-custom').value.trim() || settings.model.get());
  settings.extra.set($('#set-extra').value.trim());
  localStorage.setItem('reader.goal', parseInt($('#set-goal').value, 10) || 10);
  renderReadingTime();
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

document.addEventListener('pointerdown', noteActivity);
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

// Hooks for the iOS app: books opened from Files, and the Explain/Highlight
// items it adds to the system text-selection menu.
window.readerImport = async (url, name) => {
  if (!readerView.hidden) showLibrary();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('not found');
    await importFiles([new File([await res.blob()], name)]);
  } catch {
    toast(`Couldn’t add “${name}”.`);
  }
};
window.readerAction = (kind) => reader.nativeAction(kind);

await refreshLibrary();
window.webkit?.messageHandlers?.reader?.postMessage({ type: 'ready' });
const last = localStorage.getItem('reader.open');
if (last && books.some((b) => b.id === last)) openBook(last);
