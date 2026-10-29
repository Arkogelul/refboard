// Stockage local : petits réglages dans localStorage, planches et fichiers dans IndexedDB.

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {}
}

const DB = (() => {
  let opening;

  function open() {
    opening ??= new Promise((ok, ko) => {
      const req = indexedDB.open('refboard', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('boards', { keyPath: 'id' });
        db.createObjectStore('media'); // id du média -> Blob d'origine
        db.createObjectStore('thumbs'); // id du média -> Blob de la vignette
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
    return opening;
  }

  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((ok, ko) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => ok(req?.result);
      tx.onerror = () => ko(tx.error);
      tx.onabort = () => ko(tx.error);
    });
  }

  return {
    allBoards: () => run('boards', 'readonly', (s) => s.getAll()),
    putBoard: (board) => run('boards', 'readwrite', (s) => s.put(board)),
    deleteBoard: (id) => run('boards', 'readwrite', (s) => s.delete(id)),
    getBlob: (store, id) => run(store, 'readonly', (s) => s.get(id)),
    putBlob: (store, id, blob) => run(store, 'readwrite', (s) => s.put(blob, id)),
    deleteBlob: (store, id) => run(store, 'readwrite', (s) => s.delete(id)),
    keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
  };
})();

// Plafond du cache local des originaux : au-delà de 2 Go, on efface ceux vus le moins récemment,
// à condition qu'ils soient déjà sur le Drive (ils se retéléchargent quand on zoome dessus).
// Les vignettes, elles, restent toutes : elles sont petites.
const MediaCache = (() => {
  const LIMIT = 2 * 1024 ** 3;
  const index = readJSON('refboard.cache'); // id du média -> [taille, dernier accès]
  let saveTimer;
  let trimming = false;

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => remember('refboard.cache', index), 1000);
  };

  function touch(id, size) {
    index[id] = [size ?? index[id]?.[0] ?? 0, Date.now()];
    save();
  }

  function forget(id) {
    delete index[id];
    save();
  }

  async function trim(canEvict) {
    let total = Object.values(index).reduce((s, [n]) => s + n, 0);
    if (total <= LIMIT || trimming) return;
    trimming = true;
    try {
      for (const [id, [n]] of Object.entries(index).sort((a, b) => a[1][1] - b[1][1])) {
        if (total <= LIMIT * 0.9) break;
        if (!canEvict(id)) continue;
        await DB.deleteBlob('media', id);
        forget(id);
        total -= n;
      }
    } finally {
      trimming = false;
    }
  }

  const known = (id) => id in index;
  return { touch, forget, trim, known };
})();
