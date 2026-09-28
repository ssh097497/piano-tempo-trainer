const DB_NAME = 'piano-tempo-trainer';
const STORE_NAME = 'last-file';
const FILE_KEY = 'last-opened';
const LEGACY_STORE_NAME = 'file-handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      // Drop the old FileSystemFileHandle-based store from a prior version
      // of this feature -- handles from it are unusable now that we cache
      // file contents directly instead, so there's nothing to migrate.
      if (db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        db.deleteObjectStore(LEGACY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Caches the uploaded file's own bytes in IndexedDB, rather than a
// FileSystemFileHandle (the File System Access API this used before).
// That handle-based approach only reliably worked on desktop Chrome/Edge --
// on real mobile Chromium browsers it intercepted every tap on the upload
// drop-zone and opened a far more restrictive native picker. Storing the
// actual content works identically on every platform and browser, and
// needs no permission re-grant on reload.
async function saveLastFile(file) {
  const data = await file.arrayBuffer();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ name: file.name, type: file.type, data }, FILE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadLastFile() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(FILE_KEY);
    request.onsuccess = () => {
      const record = request.result;
      resolve(record ? new File([record.data], record.name, { type: record.type }) : null);
    };
    request.onerror = () => reject(request.error);
  });
}
