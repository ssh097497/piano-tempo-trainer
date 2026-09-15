const DB_NAME = 'piano-tempo-trainer';
const STORE_NAME = 'file-handles';
const HANDLE_KEY = 'last-opened';

function isFileSystemAccessSupported() {
  // Scoped to desktop Chrome/Edge, per the original design: mobile Chromium
  // browsers (Samsung Internet, Chrome for Android) also expose
  // `showOpenFilePicker`, but their underlying native picker for it is a
  // much more restrictive document picker than a plain <input type="file">
  // gets -- on at least one real device it showed no files as selectable at
  // all. Excluding coarse-pointer (touch) devices keeps this feature to the
  // desktop environment it was actually built and verified for.
  return 'showOpenFilePicker' in window && !window.matchMedia('(pointer: coarse)').matches;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFileHandle(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadFileHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function clearFileHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
