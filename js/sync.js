// Synchronisation avec Google Drive, dans l'espace privé de l'app (jamais recopié sur ton PC) :
//   board.json (toutes les planches), media-<id>.<ext> (originaux), thumb-<id>.webp (vignettes).
// IndexedDB reste le cache local : on n'envoie que ce qui est nouveau, on ne télécharge que ce qui est affiché.

const Sync = (() => {
  const SPACE = 'appDataFolder';
  const KEEP_ORPHANS = 30 * 86_400_000; // un média retiré des planches reste 30 jours sur le Drive (filet de sécurité)

  let state = 'off'; // off | connecting | on | auth | error
  let detail = ''; // texte du bouton pendant un envoi
  let boardFile = null; // id de board.json dans l'espace privé
  // version de board.json déjà fusionnée, planches supprimées, fichiers orphelins (id -> date où on l'a remarqué)
  const meta = { remoteVersion: null, deleted: [], orphans: {}, ...readJSON('refboard.sync') };
  const uploaded = readJSON('refboard.uploaded'); // id du média -> [fileId, thumbId], survit aux annulations
  let dirty = false; // des changements locaux restent à envoyer
  let pushTimer;
  let pushing = null;
  let pushAgain = false;

  const saveMeta = () => remember('refboard.sync', meta);
  const isOn = () => state === 'on';
  const allItems = () => boards.flatMap((b) => b.items);

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
        on: 'Planches enregistrées sur Google Drive (espace privé de RefBoard)',
        auth: 'La session Google a expiré : clique pour te reconnecter',
        error: 'Clique pour réessayer',
      }[s] || '';
  }

  function fail(e) {
    if (e instanceof Drive.AuthNeeded) {
      setState('auth');
      reconnectOnClick();
      if (e.message.startsWith('Coche')) toast(e.message, 'error');
    } else {
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
      if (!Drive.hasToken()) await Drive.signIn(); // la fenêtre Google doit suivre un clic : on la tente d'abord
      const found = (await Drive.list(`name='board.json' and trashed=false`, 'id'))[0]?.id || null;
      if (found !== boardFile) meta.remoteVersion = null;
      boardFile = found;
      remember('refboard.drive', '1');
      Drive.rememberAccount().catch((e) => console.warn('Compte Google non mémorisé', e));
      setState('on');
      await pull(true);
      await migrateLegacy();
      dirty = true; // envoie aussi les planches qui n'existaient qu'ici
      await push();
      Board.refreshMedia();
      uploadPending();
      cleanupDrive().catch((e) => console.warn('Nettoyage du Drive interrompu', e));
    } catch (e) {
      fail(e);
    }
  }

  // Au démarrage : reconnexion silencieuse (jeton encore valable, ou nouveau jeton via l'extension), sinon au premier clic.
  async function start() {
    setState('off');
    if (localStorage.getItem('refboard.drive') !== '1') return;
    if (!Drive.hasToken()) {
      setState('connecting');
      if (!(await Drive.refresh())) {
        setState('auth');
        return reconnectOnClick();
      }
      state = 'off'; // connect refuse de démarrer pendant « connecting »
    }
    connect(false);
  }

  // Sans extension, Google exige un clic pour rouvrir sa fenêtre : on se sert du prochain clic dans la page.
  let waitingClick = false;
  function reconnectOnClick() {
    if (waitingClick) return;
    waitingClick = true;
    addEventListener(
      'pointerdown',
      () => {
        waitingClick = false;
        if (state === 'auth') connect(true);
      },
      { once: true, capture: true }
    );
  }

  function signOut() {
    Drive.signOut();
    localStorage.removeItem('refboard.drive');
    setState('off');
    toast('Déconnecté de Google Drive. Les planches restent disponibles sur ce PC.');
  }

  // Versions précédentes : un dossier visible « RefBoard » dans Mon Drive (recopié sur le PC).
  // On reprend ses planches, on renvoie ses médias dans l'espace privé, puis on le met à la corbeille.
  async function migrateLegacy() {
    const legacy = await Drive.legacyFolders();
    if (!legacy.length) return;
    setState('on', 'Déplacement vers l’espace privé…');
    const inSpace = new Set((await Drive.list('trashed=false', 'id')).map((f) => f.id));
    for (const folder of legacy) {
      const json = (await Drive.list(`name='board.json' and '${folder.id}' in parents and trashed=false`, 'id', 'drive'))[0];
      if (json) merge(JSON.parse(await (await Drive.download(json.id)).text()));
    }
    // Médias encore rangés dans l'ancien dossier : on s'assure d'en avoir une copie ici, puis on les renverra.
    for (const b of boards) {
      for (const it of b.items) {
        if (!it.fileId || inSpace.has(it.fileId)) continue;
        if (!(await DB.getBlob('media', it.id))) {
          const blob = await Drive.download(it.fileId);
          await DB.putBlob('media', it.id, new Blob([blob], { type: it.mime || blob.type }));
          MediaCache.touch(it.id, blob.size);
        }
        if (it.thumbId && !(await DB.getBlob('thumbs', it.id))) await DB.putBlob('thumbs', it.id, await Drive.download(it.thumbId));
        it.fileId = null;
        it.thumbId = null;
        delete uploaded[it.id];
        b.updated = new Date().toISOString();
        DB.putBoard(b);
      }
    }
    remember('refboard.uploaded', uploaded);
    await uploadPending();
    const left = allItems().filter((it) => it.type !== 'youtube' && !it.fileId);
    if (left.length) throw new Error(`Déplacement incomplet : ${left.length} média(s) pas encore envoyé(s). Réessaie avec « Synchroniser maintenant ».`);
    dirty = true;
    await push();
    for (const folder of legacy) await Drive.trash(folder.id); // récupérable 30 jours dans la corbeille du Drive
    toast('Médias déplacés dans l’espace privé de RefBoard : ils ne prennent plus de place sur ton PC');
  }

  // ---------- Planches : récupération, fusion, envoi ----------

  // Récupère board.json s'il a changé depuis la dernière fois. Renvoie true si quelque chose a été fusionné.
  async function pull(force) {
    if (!boardFile) return false;
    const { version } = await Drive.get(boardFile, 'version');
    if (!force && version === meta.remoteVersion) return false;
    const remote = JSON.parse(await (await Drive.download(boardFile)).text());
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
        const f = boardFile
          ? await Drive.update(boardFile, blob)
          : await Drive.upload(blob, { name: 'board.json', parents: [SPACE] });
        boardFile = f.id;
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
  let uploading = null;

  function uploadPending() {
    if (!isOn()) return Promise.resolve();
    uploading ??= (async () => {
      try {
        for (;;) {
          fillIds();
          const todo = allItems().filter((it) => it.type !== 'youtube' && !it.fileId && !skipped.has(it.id)); // YouTube : rien à envoyer
          if (!todo.length) break;
          const it = todo[0];
          setState('on', `Envoi vers Drive… (${todo.length})`);
          const blob = await DB.getBlob('media', it.id);
          if (!blob) {
            skipped.add(it.id);
            continue;
          }
          const ext = Object.keys(EXT_TYPES).find((e) => EXT_TYPES[e] === blob.type) || 'bin';
          const file = await Drive.upload(blob, { name: `media-${it.id}.${ext}`, parents: [SPACE] });
          const thumb = await DB.getBlob('thumbs', it.id);
          const t = thumb ? await Drive.upload(thumb, { name: `thumb-${it.id}.webp`, parents: [SPACE] }) : null;
          uploaded[it.id] = [file.id, t?.id || null];
          remember('refboard.uploaded', uploaded);
          fillIds();
          changed();
        }
        setState('on');
        MediaCache.trim(isUploaded);
      } catch (e) {
        fail(e);
      } finally {
        uploading = null;
      }
    })();
    return uploading;
  }

  // Un original déjà sur le Drive peut quitter le cache local : on le retéléchargera au besoin.
  function isUploaded(id) {
    return !!uploaded[id] || allItems().some((it) => it.id === id && it.fileId);
  }

  // Téléchargement d'un média absent de ce PC (ajouté ailleurs, ou sorti du cache), 4 à la fois au plus.
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
          if (level === 'full') {
            MediaCache.touch(it.id, blob.size);
            MediaCache.trim(isUploaded);
          }
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

  // Efface de l'espace privé les fichiers qui ne servent plus à aucune planche depuis 30 jours.
  // (L'espace privé n'a pas de corbeille : ce délai sert de filet de sécurité.)
  async function cleanupDrive() {
    const used = new Set(allItems().flatMap((it) => [it.fileId, it.thumbId]));
    for (const ids of Object.values(uploaded)) ids.forEach((id) => used.add(id));
    if (boardFile) used.add(boardFile);
    const now = Date.now();
    const files = await Drive.list('trashed=false', 'id');
    const unused = new Set(files.map((f) => f.id).filter((id) => !used.has(id)));
    for (const id of Object.keys(meta.orphans)) if (!unused.has(id)) delete meta.orphans[id];
    for (const id of unused) {
      meta.orphans[id] ??= new Date(now).toISOString();
      if (now - Date.parse(meta.orphans[id]) > KEEP_ORPHANS) {
        await Drive.remove(id);
        delete meta.orphans[id];
      }
    }
    saveMeta();
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
          await uploadPending();
          if (isOn()) toast('Synchronisé avec Google Drive');
        },
      },
      { label: 'Tout exporter dans un dossier…', run: exportAll },
      { label: 'Voir l’espace utilisé sur Drive', run: () => window.open('https://drive.google.com/drive/settings', '_blank') },
      '-',
      { label: 'Se déconnecter de Google Drive', run: signOut, danger: true },
    ]);
  }

  return { start, connect, changed, boardDeleted, uploadPending, fetchBlob, menu, isOn, isUploaded };
})();
