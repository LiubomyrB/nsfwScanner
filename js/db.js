// IndexedDB wrapper for the Video Moderator app.
// Stores:
//  - "videos"   keyPath "fileName": { fileName, fileSize, lastModified, duration,
//                                     samples: [{time, probability}], segmentsAtScan,
//                                     txtContent, fileHandle, lastCurrentTime, lastPaused,
//                                     scannedAt, updatedAt }
//  - "settings" keyPath "id": { id:"app", sensitivity, blurAdvance, rememberState }
//  - "meta"     keyPath "id": { id:"app", lastOpenedFileName }
(function (global) {
  const DB_NAME = "videoModeratorDB";
  const DB_VERSION = 1;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("videos")) {
          db.createObjectStore("videos", { keyPath: "fileName" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function withStore(storeName, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      Promise.resolve(fn(store))
        .then((r) => { result = r; })
        .catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const VMDB = {
    async get(storeName, key) {
      return withStore(storeName, "readonly", (store) => reqToPromise(store.get(key)));
    },
    async put(storeName, value) {
      return withStore(storeName, "readwrite", (store) => reqToPromise(store.put(value)));
    },
    async delete(storeName, key) {
      return withStore(storeName, "readwrite", (store) => reqToPromise(store.delete(key)));
    },
    async getAll(storeName) {
      return withStore(storeName, "readonly", (store) => reqToPromise(store.getAll()));
    },
  };

  global.VMDB = VMDB;
})(window);
