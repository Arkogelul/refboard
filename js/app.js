// Interface : barre d'outils, planches, réglages, import (glisser-déposer, collage, fichiers),
// raccourcis clavier, menus et sauvegarde automatique.

const $ = (id) => document.getElementById(id);

// ---------- Réglages (mémorisés dans ce navigateur) ----------

const DEFAULTS = {
  mode: 'rows', rowHeight: 300, gap: 16, width: '', cols: '', order: 'position',
  uniformDim: 'h', uniformSize: 300, wheel: 'auto',
};
const settings = { ...DEFAULTS, ...readJSON('refboard.settings') };

// ---------- Messages ----------

let toastTimer;
function toast(message, kind = 'ok', sticky = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => (t.className = ''), kind === 'error' ? 6000 : 2500);
}

// ---------- Sauvegarde automatique ----------

let boards = [];
let current = null;
let saveTimer;

function scheduleSave(contentChanged) {
  clearTimeout(saveTimer);
  if (contentChanged) {
    $('status').textContent = 'Modifications…';
    current.updated = new Date().toISOString();
    Sync.changed();
  }
  saveTimer = setTimeout(saveNow, 600);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!current) return;
  try {
    await DB.putBoard(current);
    $('status').textContent = 'Enregistré';
  } catch (e) {
    $('status').textContent = 'Échec de l’enregistrement';
    toast(`Enregistrement impossible : ${e.message}`, 'error');
  }
}

Board.onChange = scheduleSave;
Board.onSelection = (n) => {
  $('arrangeBtn').textContent = n >= 2 ? 'Ranger la sélection' : 'Tout ranger';
  $('uniformBtn').textContent = n >= 1 ? 'Taille uniforme (sélection)' : 'Taille uniforme';
};
addEventListener('visibilitychange', () => document.hidden && saveNow());
addEventListener('pagehide', saveNow);

// ---------- Planches ----------

function newBoard(name) {
  const now = new Date().toISOString();
  return { id: uid(), name, items: [], view: null, created: now, updated: now };
}

function fillBoardSelect() {
  $('boardSelect').innerHTML = boards
    .map((b) => `<option value="${b.id}">${b.name.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</option>`)
    .join('');
  if (current) $('boardSelect').value = current.id;
}

async function openBoard(id) {
  await saveNow();
  current = boards.find((b) => b.id === id) || boards[0];
  remember('refboard.board', current.id);
  fillBoardSelect();
  document.title = `${current.name} · RefBoard`;
  Board.load(current);
  $('status').textContent = '';
}

async function createBoard() {
  const name = prompt('Nom de la nouvelle planche :', 'Nouvelle planche');
  if (!name?.trim()) return;
  const b = newBoard(name.trim());
  await DB.putBoard(b);
  boards.push(b);
  Sync.changed();
  openBoard(b.id);
}

async function renameBoard() {
  const name = prompt('Nouveau nom de la planche :', current.name);
  if (!name?.trim()) return;
  current.name = name.trim();
  current.updated = new Date().toISOString();
  Sync.changed();
  fillBoardSelect();
  document.title = `${current.name} · RefBoard`;
  saveNow();
}

async function deleteBoard() {
  const n = current.items.length;
  if (!confirm(`Supprimer la planche « ${current.name} »${n ? ` et ses ${n} média(s)` : ''} ?`)) return;
  await DB.deleteBoard(current.id);
  Sync.boardDeleted(current.id);
  boards = boards.filter((b) => b !== current);
  current = null;
  if (!boards.length) {
    boards.push(newBoard('Ma planche'));
    await DB.putBoard(boards[0]);
  }
  openBoard(boards[0].id);
  cleanupOrphans();
}

// Supprime du cache local les fichiers qui ne sont plus utilisés par aucune planche,
// et recense la taille des autres (pour le plafond du cache).
async function cleanupOrphans() {
  const used = new Set(boards.flatMap((b) => b.items.map((it) => it.id)));
  for (const id of await DB.keys('media')) {
    if (used.has(id)) {
      if (!MediaCache.known(id)) MediaCache.touch(id, (await DB.getBlob('media', id))?.size || 0);
      continue;
    }
    await DB.deleteBlob('media', id);
    await DB.deleteBlob('thumbs', id);
    MediaCache.forget(id);
  }
  MediaCache.trim(Sync.isUploaded);
}

// ---------- Import ----------

async function importFiles(files, at) {
  const list = [...files];
  const items = [];
  const errors = [];
  for (const [i, file] of list.entries()) {
    if (list.length > 1) toast(`Import ${i + 1} / ${list.length}…`, 'info', true);
    try {
      items.push(await importMedia(file, { name: file.name }));
    } catch (e) {
      errors.push(e.message);
    }
  }
  Board.addItems(items, at);
  Sync.uploadPending();
  if (errors.length) toast(`${items.length} ajouté(s), ${errors.length} refusé(s) : ${errors[0]}`, 'error');
  else toast(`${items.length} média${items.length > 1 ? 's' : ''} ajouté${items.length > 1 ? 's' : ''}`);
}

// Posts de réseaux sociaux : seule l'extension « Vers RefBoard » sait en extraire les médias.
const POST_RE = /(?:x|twitter)\.com\/[^/]+\/status\/|instagram\.com\/(?:[^/]+\/)?(?:p|reels?|tv)\/|pinterest\.[a-z.]+\/pin\/|^https?:\/\/pin\.it\//;

async function importFromUrl(url, at) {
  const yt = url.match(YT_RE);
  if (yt) {
    Board.addItems([youtubeItem(yt[1], { short: /\/shorts\//.test(url), source: url })], at);
    return toast('Vidéo YouTube ajoutée : double-clic pour la lire');
  }
  if (POST_RE.test(url)) {
    if (!hasExtension())
      return toast("Pour un post X, Instagram ou Pinterest, installe l'extension « Vers RefBoard » (voir extension/INSTALLER.md).", 'error');
    toast('Récupération du post par l’extension…', 'info', true);
    try {
      const { items, note } = await fetchViaExtension([url]);
      const added = await toItems(items);
      Board.addItems(added, at);
      Sync.uploadPending();
      toast(`${added.length} média${added.length > 1 ? 's' : ''} ajouté${added.length > 1 ? 's' : ''}${note ? ` — ${note}` : ''}`);
    } catch (e) {
      toast(e.message, 'error');
    }
    return;
  }
  toast('Téléchargement…', 'info', true);
  try {
    Board.addItems([await importUrl(url)], at);
    Sync.uploadPending();
    toast('Média ajouté');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// URL d'un média glissé depuis une autre page (image ou lien).
function urlFromTransfer(dt) {
  const html = dt.getData('text/html');
  const m = html.match(/<(?:img|video|source)[^>]+src="([^"]+)"/i);
  if (m) return m[1].replace(/&amp;/g, '&');
  const uri = dt.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'));
  const text = uri || dt.getData('text/plain');
  return /^https?:\/\//.test(text?.trim()) ? text.trim() : null;
}

const stage = $('stage');
stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragover');
});
stage.addEventListener('dragleave', (e) => {
  if (!stage.contains(e.relatedTarget)) document.body.classList.remove('dragover');
});
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const at = Board.toWorld(e.clientX, e.clientY);
  if (e.dataTransfer.files.length) return importFiles(e.dataTransfer.files, at);
  const url = urlFromTransfer(e.dataTransfer);
  if (url) importFromUrl(url, at);
});

document.addEventListener('paste', (e) => {
  if (e.target.matches?.('input, textarea')) return;
  const files = [...e.clipboardData.files];
  if (files.length) return importFiles(files, Board.dropPoint());
  const text = e.clipboardData.getData('text/plain').trim();
  if (/^https?:\/\//.test(text)) importFromUrl(text, Board.dropPoint());
});

$('addBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  importFiles(e.target.files, Board.dropPoint());
  e.target.value = '';
};

// ---------- Envois de l'extension et de la mini-app Miro ----------
// L'extension « Vers RefBoard » parle à cette page par window.postMessage (voir extension/refboard-bridge.js).
// La mini-app Miro (miro.html, même origine) ouvre cette page et lui envoie ses images une à une.

let appReady = false;
const hasExtension = () => !!document.documentElement.dataset.refboardExtension;
const pending = new Map(); // demandes en cours à l'extension : id -> { ok, ko }

addEventListener('message', async (e) => {
  const fromBridge = e.source === window;
  const fromMiro = !fromBridge && e.origin === location.origin && !!e.source;
  if ((!fromBridge && !fromMiro) || !e.data?.refboard) return;
  const msg = e.data;
  if (msg.refboard === 'hello' && appReady && fromBridge) window.postMessage({ refboard: 'ready' }, location.origin);
  if (fromBridge && (msg.refboard === 'fetched' || msg.refboard === 'error') && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.refboard === 'fetched') p.ok(msg);
    else p.ko(new Error(msg.message || "L'extension n'a pas pu récupérer ce post"));
  }
  if (msg.refboard === 'add') {
    let ok = true;
    let error;
    try {
      await receive(msg.items, fromMiro);
    } catch (err) {
      ok = false;
      error = err.message;
    }
    e.source.postMessage({ refboard: 'added', id: msg.id, ok, error }, location.origin);
  }
});

// Demande à l'extension de récupérer des posts ; elle renvoie leurs médias (fichiers ou cartes YouTube).
function fetchViaExtension(urls) {
  const id = uid();
  return new Promise((ok, ko) => {
    pending.set(id, { ok, ko });
    window.postMessage({ refboard: 'fetch', id, urls }, location.origin);
  });
}

// Médias reçus → éléments de planche.
async function toItems(list) {
  const items = [];
  for (const it of list) {
    if (it.kind === 'youtube') items.push(youtubeItem(it.id, { short: it.short, source: it.source }));
    else items.push(await importMedia(it.blob, { name: it.name, source: it.source }));
  }
  return items;
}

// Un GIF importé de Miro était souvent une vidéo X / Instagram / Pinterest convertie : on reprend la vidéo d'origine.
async function upgradeGif(it) {
  if (!it.preferOriginal || !POST_RE.test(it.source || '') || !hasExtension()) return [it];
  if ((await mimeOf(it.blob, it.name)) !== 'image/gif') return [it];
  try {
    const { items } = await fetchViaExtension([it.source]);
    return items.length ? items : [it];
  } catch {
    return [it]; // post supprimé ou inaccessible : on garde le GIF
  }
}

// Les envois successifs de Miro se rangent les uns après les autres, en lignes.
let flow = null;
function flowPoint(item, gap = 16) {
  const now = Date.now();
  if (!flow || now - flow.last > 15000) {
    const p = Board.dropPoint();
    flow = { x0: p.x, x: p.x, y: p.y, last: now };
  }
  const w = (300 * item.nw) / (item.nh || 1);
  if (flow.x > flow.x0 && flow.x + w > flow.x0 + 3000) {
    flow.x = flow.x0;
    flow.y += 300 + gap;
  }
  const at = { x: flow.x + w / 2, y: flow.y + 150 };
  flow.x += w + gap;
  flow.last = now;
  return at;
}

async function receive(list, fromMiro) {
  if (fromMiro) list = (await Promise.all(list.map(upgradeGif))).flat();
  const items = await toItems(list);
  if (fromMiro) for (const it of items) Board.addItems([it], flowPoint(it));
  else Board.addItems(items, Board.dropPoint());
  Sync.uploadPending();
  const n = items.length;
  toast(`${n} média${n > 1 ? 's' : ''} reçu${n > 1 ? 's' : ''}${fromMiro ? ' de Miro' : " de l'extension"}`);
}

// ---------- Barre d'outils et réglages ----------

$('boardSelect').onchange = (e) => openBoard(e.target.value);
$('boardNew').onclick = createBoard;
$('boardMenuBtn').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [
    { label: 'Renommer la planche…', run: renameBoard },
    { label: 'Supprimer la planche…', run: deleteBoard, danger: true },
  ]);
};

$('driveBtn').onclick = (e) => Sync.menu(e.currentTarget);
$('arrangeBtn').onclick = () => Board.arrange(settings);
$('uniformBtn').onclick = () => Board.uniform(settings.uniformDim, +settings.uniformSize);

const panel = $('settingsPanel');
function syncPanel() {
  for (const input of panel.querySelectorAll('[name]')) input.value = settings[input.name];
  panel.dataset.mode = settings.mode;
}
panel.addEventListener('input', (e) => {
  const { name, value, type } = e.target;
  settings[name] = type === 'number' && value !== '' ? +value : value;
  panel.dataset.mode = settings.mode;
  remember('refboard.settings', settings);
});
$('settingsBtn').onclick = (e) => {
  if (!panel.hidden) return (panel.hidden = true);
  syncPanel();
  const r = e.currentTarget.getBoundingClientRect();
  panel.style.left = `${Math.min(r.left, innerWidth - 320)}px`;
  panel.hidden = false;
};
$('panelArrange').onclick = () => Board.arrange(settings);
$('panelUniform').onclick = () => Board.uniform(settings.uniformDim, +settings.uniformSize);

$('zoomIn').onclick = () => Board.zoomBy(1.25);
$('zoomOut').onclick = () => Board.zoomBy(0.8);
$('zoomLabel').onclick = () => Board.zoomReset();
$('zoomFit').onclick = () => Board.fitAll();

// Fermeture des menus et du panneau en cliquant ailleurs.
addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#menu')) closeMenu();
  if (!e.target.closest('#settingsPanel, #settingsBtn')) panel.hidden = true;
});

// ---------- Menus ----------

function openMenu(x, y, entries) {
  const menu = $('menu');
  menu.innerHTML = '';
  for (const entry of entries) {
    if (entry === '-') {
      menu.append(document.createElement('hr'));
      continue;
    }
    const b = document.createElement('button');
    b.textContent = entry.label;
    if (entry.danger) b.className = 'danger';
    b.onclick = () => {
      closeMenu();
      entry.run();
    };
    menu.append(b);
  }
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
}

function closeMenu() {
  $('menu').hidden = true;
}

stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const it = Board.itemOf(e.target);
  if (!it) return;
  Board.select(it.id);
  const n = Board.selectionSize();
  const entries = [];
  if (n === 1) {
    if (it.source) {
      entries.push({ label: 'Ouvrir la source', run: () => window.open(it.source, '_blank', 'noopener') });
      entries.push({ label: 'Copier le lien source', run: () => navigator.clipboard.writeText(it.source) });
    }
    entries.push({
      label: it.source ? 'Modifier le lien source…' : 'Ajouter un lien source…',
      run: () => {
        const url = prompt('Lien source :', it.source);
        if (url !== null) Board.setSource(it.id, url.trim());
      },
    });
    if (it.type !== 'youtube') {
      entries.push({ label: 'Ouvrir le fichier (taille réelle, son)', run: () => openFile(it) });
      entries.push({ label: 'Télécharger le fichier', run: () => downloadFile(it) });
    }
    entries.push('-');
  }
  entries.push({ label: 'Mettre au premier plan', run: Board.bringToFront });
  entries.push({ label: "Mettre à l'arrière-plan", run: Board.sendToBack });
  entries.push('-');
  entries.push({ label: n > 1 ? `Supprimer les ${n} médias` : 'Supprimer', run: Board.deleteSelected, danger: true });
  openMenu(e.clientX, e.clientY, entries);
});

// Original d'un média : depuis le cache local, sinon depuis Google Drive.
async function originalOf(it) {
  return (await DB.getBlob('media', it.id)) || (await Sync.fetchBlob(it, 'full'));
}

async function openFile(it) {
  const blob = await originalOf(it);
  if (blob) window.open(URL.createObjectURL(blob), '_blank');
  else toast('Fichier introuvable : connecte-toi à Drive pour le récupérer', 'error');
}

const extOf = (it, blob) => Object.keys(EXT_TYPES).find((e) => EXT_TYPES[e] === (blob?.type || it.mime)) || 'bin';
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'planche';

async function downloadFile(it) {
  const blob = await originalOf(it);
  if (!blob) return toast('Fichier introuvable : connecte-toi à Drive pour le récupérer', 'error');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName(it.name.split(/[\\/]/).pop().replace(/\.[^.]*$/, '')) || it.id}.${extOf(it, blob)}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// Tout exporter : un sous-dossier par planche, avec ses fichiers, liens.txt (sources, vidéos YouTube) et planche.json.
async function exportAll() {
  if (!window.showDirectoryPicker) return toast("L'export demande Chrome ou Edge sur ordinateur", 'error');
  let root;
  try {
    root = await showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return; // fenêtre annulée
  }
  const write = async (dir, name, data) => {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(data);
    await w.close();
  };
  const total = boards.reduce((n, b) => n + b.items.length, 0);
  let done = 0;
  let missing = 0;
  for (const b of boards) {
    const dir = await root.getDirectoryHandle(safeName(b.name), { create: true });
    const links = [];
    for (const [i, it] of b.items.entries()) {
      toast(`Export ${++done} / ${total}…`, 'info', true);
      const num = String(i + 1).padStart(3, '0');
      if (it.type === 'youtube') {
        links.push(`${num}  YouTube  ${it.source}`);
        continue;
      }
      const blob = await originalOf(it);
      if (!blob) {
        missing++;
        continue;
      }
      const file = `${num}.${extOf(it, blob)}`;
      await write(dir, file, blob);
      if (it.source) links.push(`${file}  ${it.source}`);
    }
    await write(dir, 'liens.txt', links.join('\r\n'));
    await write(dir, 'planche.json', JSON.stringify({ ...b, view: undefined }, null, 2));
  }
  toast(missing ? `Export terminé, ${missing} média(s) introuvable(s) (connecte-toi à Drive)` : `Export terminé : ${total} média(s)`, missing ? 'error' : 'ok');
}

// ---------- Raccourcis clavier ----------

addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, textarea, select')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  let done = true;
  if (e.key === 'Delete' || e.key === 'Backspace') Board.deleteSelected();
  else if (e.key === 'Escape') {
    closeMenu();
    panel.hidden = true;
    Board.clearSelection();
  } else if (ctrl && key === 'a') Board.selectAll();
  else if (ctrl && key === 'z' && !e.shiftKey) Board.undo();
  else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) Board.redo();
  else if (ctrl && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) Board.zoomBy(1.25);
  else if (ctrl && (e.key === '-' || e.code === 'NumpadSubtract')) Board.zoomBy(0.8);
  else if (ctrl && (e.code === 'Digit0' || e.code === 'Numpad0')) Board.zoomReset();
  else if (e.shiftKey && e.code === 'Digit1') Board.fitAll();
  else if (e.shiftKey && e.code === 'Digit2') Board.fitSelection();
  else done = false;
  if (done) e.preventDefault();
});

// ---------- Démarrage ----------

(async function init() {
  try {
    boards = (await DB.allBoards()).sort((a, b) => a.created.localeCompare(b.created));
    if (!boards.length) {
      boards.push(newBoard('Ma planche'));
      await DB.putBoard(boards[0]);
    }
    await openBoard(localStorage.getItem('refboard.board'));
    cleanupOrphans();
    Sync.start();
    appReady = true;
    window.postMessage({ refboard: 'ready' }, location.origin);
    // Ouvert par la mini-app Miro : on lui signale qu'on est prêt à recevoir.
    if (window.opener && new URLSearchParams(location.search).get('import') === 'miro')
      window.opener.postMessage({ refboard: 'ready' }, location.origin);
  } catch (e) {
    toast(`Stockage local indisponible : ${e.message}`, 'error', true);
  }
})();
