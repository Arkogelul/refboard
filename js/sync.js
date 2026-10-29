// Synchronisation avec Google Drive.
// Sur le Drive : un dossier « RefBoard » avec board.json (toutes les planches), media/ (originaux) et thumbs/ (vignettes).
// IndexedDB reste le cache local : on n'envoie que ce qui est nouveau, on ne télécharge que ce qui est affiché.

const Sync = (() => {
  let state = 'off'; // off | connecting | on | auth | error
  let detail = ''; // texte du bouton pendant un envoi
  let folders = readJSON('refboard.folders'); // { root, media, thumbs, board }
  const meta = { remoteVersion: null, deleted: [], ...readJSON('refboard.sync') }; // version de board.json déjà fusionnée, planches supprimées
  const uploaded = readJSON('refboard.uploaded'); // id du média -> [fileId, thumbId], survit aux annulations
  let dirty = false; // des changements locaux restent à envoyer
  let pushTimer;
  let pushing = null;
  let pushAgain = false;

  const saveMeta = () => remember('refboard.sync', meta);
  const isOn = () => state === 'on';

  // ---------- État et bouton ----------

  function setState(s, text = '') {
    state = s;
    detail = text;
    const b = $('driveBtn');
    b.dataset.state = s;
    b.textContent =
      { off: 'Se connecter à Drive', connecting: 'Connexion…', on: detail || 'Drive ✓', auth: 'Reconnecter Drive', error: 'Drive : erreur' }[s];
    b.title =
      {
        off: 'Enregistrer les planches et les médias sur ton Google Drive',
        on: 'Planches enregistrées sur Google Drive',
        auth: 'La session Google a expiré : clique pour te reconnecter',
        error: 'Clique pour réessayer',
      }[s] || '';
  }

  function fail(e) {
    if (e instanceof Drive.AuthNeeded) setState('auth');
    else {
      setState('error');
      toast(e.message, 'error');
      console.error(e);
    }
  }

  // ---------- Connexion ----------

  async function connect(interactive) {
    if (state === 'connecting') return;
    setState('connecting');
    try {
      if (interactive || !Drive.hasToken()) await Drive.signIn();
      await setupFolders();
      remember('refboard.drive', '1');
      setState('on');
      await pull(true);
      dirty = true; // envoie aussi les planches qui n'existaient qu'ici
      await push();
      Board.refreshMedia();
      uploadPending();
      cleanupDrive().catch((e) => console.warn('Nettoyage du Drive interrompu', e));
    } catch (e) {
      fail(e);
    }
  }

  // Au démarrage : reconnexion silencieuse si le jeton est encore valable, sinon au premier clic.
  function start() {
    setState('off');
    if (localStorage.getItem('refboard.drive') !== '1') return;
    if (Drive.hasToken()) return connect(false);
    setState('auth');
    addEventListener('pointerdown', () => state === 'auth' && connect(true), { once: true, capture: true });
  }

  function signOut() {
    Drive.signOut();
    localStorage.removeItem('refboard.drive');
    setState('off');
    toast('Déconnecté de Google Drive. Les planches restent disponibles sur ce PC.');
  }

  async function setupFolders() {
    if (folders.root) {
      const alive = await Drive.get(folders.root, 'id,trashed').then(
        (f) => !f.trashed,
        (e) => {
          if (e instanceof Drive.AuthNeeded) throw e;
          return false;
        }
      );
      if (alive) return;
    }
    const root = await Drive.findOrCreateFolder('RefBoard', 'root');
    folders = {
      root,
      media: await Drive.findOrCreateFolder('media', root),
      thumbs: await Drive.findOrCreateFolder('thumbs', root),
      board: (await Drive.list(`name='board.json' and '${root}' in parents and trashed=false`))[0]?.id || null,
    };
    remember('refboard.folders', folders);
    meta.remoteVersion = null;
    saveMeta();
  }

  // ---------- Planches : récupération, fusion, envoi ----------

  // Récupère board.json s'il a changé depuis la dernière fois. Renvoie true si quelque chose a été fusionné.
  async function pull(force) {
    if (!folders.board) return false;
    const { version } = await Drive.get(folders.board, 'version');
    if (!force && version === meta.remoteVersion) return false;
    const remote = JSON.parse(await (await Drive.download(folders.board)).text());
    merge(remote);
    meta.remoteVersion = version;
    saveMeta();
    return true;
  }

  // Fusion planche par planche : la plus récemment modifiée gagne. Le cadrage reste propre à chaque PC.
  function merge(remote) {
    const gone = new Set([...meta.deleted, ...(remote.deletedBoards || [])]);
    meta.deleted = [...gone];
    let reopen = false;
    // PC neuf : la planche vide créée au démarrage s'efface devant celles du Drive.
    const lone = boards.length === 1 && !boards[0].items.length ? boards[0] : null;
    if (lone && remote.boards?.some((r) => r.id !== lone.id && !gone.has(r.id))) {
      DB.deleteBoard(lone.id);
      boards = [];
      if (current === lone) current = null;
      reopen = true;
    }
    for (const r of remote.boards || []) {
      if (gone.has(r.id)) continue;
      const local = boards.find((b) => b.id === r.id);
      if (!local) {
        const b = { ...r, view: null };
        boards.push(b);
        DB.putBoard(b);
      } else if ((r.updated || '') > (local.updated || '')) {
        Object.assign(local, r, { view: local.view });
        DB.putBoard(local);
        if (local === current) reopen = true;
      }
    }
    for (const b of boards.filter((b) => gone.has(b.id))) {
      DB.deleteBoard(b.id);
      if (b === current) {
        current = null;
        reopen = true;
      }
    }
    boards = boards.filter((b) => !gone.has(b.id));
    fillIds();
    if (!boards.length) {
      boards.push(newBoard('Ma planche'));
      DB.putBoard(boards[0]);
    }
    if (reopen) openBoard(current?.id || localStorage.getItem('refboard.board') || boards[0].id);
    else fillBoardSelect();
  }

  // Recopie les identifiants Drive des médias déjà envoyés (une annulation peut les avoir effacés).
  function fillIds() {
    for (const b of boards) {
      let changed = false;
      for (const it of b.items) {
        const ids = uploaded[it.id];
        if (ids && it.fileId !== ids[0]) {
          [it.fileId, it.thumbId] = ids;
          changed = true;
        }
      }
      if (changed) {
        b.updated = new Date().toISOString(); // pour que les autres PC reçoivent ces identifiants
        DB.putBoard(b);
        dirty = true;
      }
    }
  }

  function changed() {
    dirty = true;
    if (!isOn()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 2000);
  }

  async function push() {
    clearTimeout(pushTimer);
    if (!isOn()) return;
    if (pushing) {
      pushAgain = true;
      return pushing;
    }
    pushing = (async () => {
      try {
        await pull(false); // un autre PC a peut-être modifié board.json entre-temps
        fillIds();
        if (!dirty) return;
        dirty = false;
        const data = {
          app: 'RefBoard',
          version: 1,
          saved: new Date().toISOString(),
          deletedBoards: meta.deleted,
          boards: boards.map(({ view, ...b }) => b),
        };
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const f = folders.board
          ? await Drive.update(folders.board, blob)
          : await Drive.upload(blob, { name: 'board.json', parents: [folders.root] });
        folders.board = f.id;
        remember('refboard.folders', folders);
        meta.remoteVersion = f.version;
        saveMeta();
        if (!detail) setState('on');
      } catch (e) {
        dirty = true;
        fail(e);
      } finally {
        pushing = null;
        if (pushAgain) {
          pushAgain = false;
          changed();
        }
      }
    })();
    return pushing;
  }

  function boardDeleted(id) {
    meta.deleted.push(id);
    saveMeta();
    changed();
  }

  // ---------- Médias ----------

  const skipped = new Set(); // médias ajoutés sur un autre PC et pas encore envoyés par lui
  let uploading = false;

  async function uploadPending() {
    if (uploading || !isOn()) return;
    uploading = true;
    try {
      for (;;) {
        fillIds();
        const todo = boards.flatMap((b) => b.items).filter((it) => !it.fileId && !skipped.has(it.id));
        if (!todo.length) break;
        const it = todo[0];
        setState('on', `Envoi vers Drive… (${todo.length})`);
        const blob = await DB.getBlob('media', it.id);
        if (!blob) {
          skipped.add(it.id);
          continue;
        }
        const ext = Object.keys(EXT_TYPES).find((e) => EXT_TYPES[e] === blob.type) || 'bin';
        const file = await Drive.upload(blob, { name: `${it.id}.${ext}`, parents: [folders.media] });
        const thumb = await DB.getBlob('thumbs', it.id);
        const t = thumb ? await Drive.upload(thumb, { name: `${it.id}.webp`, parents: [folders.thumbs] }) : null;
        uploaded[it.id] = [file.id, t?.id || null];
        remember('refboard.uploaded', uploaded);
        fillIds();
        changed();
      }
      setState('on');
    } catch (e) {
      fail(e);
    } finally {
      uploading = false;
    }
  }

  // Téléchargement d'un média absent de ce PC (ajouté depuis un autre), 4 à la fois au plus.
  const inflight = new Map();
  const waiting = [];
  let active = 0;

  function fetchBlob(it, level) {
    const id = level === 'full' ? it.fileId : it.thumbId || it.fileId;
    if (!id || !isOn()) return Promise.resolve(null);
    const key = `${level}:${it.id}`;
    if (!inflight.has(key)) {
      const p = new Promise((ok) => waiting.push(ok))
        .then(() => Drive.download(id))
        .then(async (blob) => {
          if (level === 'full') blob = new Blob([blob], { type: it.mime || blob.type });
          await DB.putBlob(level === 'full' ? 'media' : 'thumbs', it.id, blob);
          return blob;
        })
        .catch((e) => {
          if (e instanceof Drive.AuthNeeded) fail(e);
          else console.warn('Téléchargement impossible', it.id, e);
          return null;
        })
        .finally(() => {
          active--;
          inflight.delete(key);
          next();
        });
      inflight.set(key, p);
      next();
    }
    return inflight.get(key);
  }

  function next() {
    while (active < 4 && waiting.length) {
      active++;
      waiting.shift()();
    }
  }

  // Met à la corbeille du Drive (récupérable 30 jours) les fichiers qui ne servent plus à aucune planche.
  // Seulement ceux de plus d'un jour : un autre PC peut être en train d'envoyer un média sans avoir encore mis à jour board.json.
  async function cleanupDrive() {
    const used = new Set(boards.flatMap((b) => b.items.flatMap((it) => [it.fileId, it.thumbId])));
    for (const ids of Object.values(uploaded)) ids.forEach((id) => used.add(id));
    if (!used.size) return;
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    for (const folder of [folders.media, folders.thumbs]) {
      const files = await Drive.list(`'${folder}' in parents and trashed=false and createdTime < '${dayAgo}'`, 'id');
      for (const f of files) if (!used.has(f.id)) await Drive.trash(f.id);
    }
  }

  // Au retour sur l'onglet : récupère les changements faits depuis un autre PC.
  addEventListener('focus', async () => {
    if (!isOn()) return;
    try {
      if (await pull(false)) Board.refreshMedia();
      uploadPending();
    } catch (e) {
      fail(e);
    }
  });

  function menu(anchor) {
    if (!isOn()) return connect(true);
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [
      {
        label: 'Synchroniser maintenant',
        run: async () => {
          dirty = true;
          await push();
          uploadPending();
          if (isOn()) toast('Synchronisé avec Google Drive');
        },
      },
      { label: 'Ouvrir le dossier sur Google Drive', run: () => window.open(`https://drive.google.com/drive/folders/${folders.root}`, '_blank') },
      '-',
      { label: 'Se déconnecter de Google Drive', run: signOut, danger: true },
    ]);
  }

  return { start, connect, changed, boardDeleted, uploadPending, fetchBlob, menu, isOn };
})();
