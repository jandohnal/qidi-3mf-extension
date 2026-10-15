// Hands files from the popup to the offscreen document. Extension messaging
// only carries JSON, but IndexedDB is shared by all pages of the extension.

const DB = 'qidi-3mf';
const STORE = 'uploads';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const putUpload = (key, blob) => run('readwrite', (s) => s.put(blob, key));
export const getUpload = (key) => run('readonly', (s) => s.get(key));
export const deleteUpload = (key) => run('readwrite', (s) => s.delete(key));
