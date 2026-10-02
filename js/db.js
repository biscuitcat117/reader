// IndexedDB storage: book metadata in `books`, the EPUB bytes in `files`.
let opening;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('reader', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('books', { keyPath: 'id' });
      req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const listBooks = () => tx('books', 'readonly', (t) => t.objectStore('books').getAll());

export const getFile = (id) => tx('files', 'readonly', (t) => t.objectStore('files').get(id));

export const putBook = (meta) => tx('books', 'readwrite', (t) => t.objectStore('books').put(meta));

export const addBook = (meta, buffer) => tx(['books', 'files'], 'readwrite', (t) => {
  t.objectStore('files').put(buffer, meta.id);
  return t.objectStore('books').put(meta);
});

export const deleteBook = (id) => tx(['books', 'files'], 'readwrite', (t) => {
  t.objectStore('files').delete(id);
  return t.objectStore('books').delete(id);
});
