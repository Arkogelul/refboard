// Canevas infini : vue (déplacement, zoom), affichage des médias, sélection,
// déplacement, redimensionnement, rangement et annulation.

const Board = (() => {
  const stage = document.getElementById('stage');
  const world = document.getElementById('world');
  const selBox = document.getElementById('selBox');
  const rubber = document.getElementById('rubber');

  const MIN_ZOOM = 0.02;
  const MAX_ZOOM = 8;
  const NEW_HEIGHT = 300; // hauteur des médias ajoutés, en unités du canevas

  const view = { x: 0, y: 0, s: 1 }; // écran = canevas × s + (x, y)
  const els = new Map(); // id -> élément DOM
  const shown = new Map(); // id -> { level: 'thumb' | 'full' } (affiché ou en cours de chargement)
  const selected = new Set();
  const audible = new Set(); // vidéos dont le son a été activé
  const playing = new Set(); // cartes YouTube dont le lecteur est lancé
  const undoStack = [];
  const redoStack = [];
  let board = null;
  let spaceDown = false;
  let pointer = null; // dernière position de la souris sur le canevas (coordonnées écran)

  const api = {
    onChange: () => {}, // (contenuModifié) → sauvegarde différée
    onSelection: () => {}, // (nombre) → libellés de la barre d'outils
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const byId = (id) => board.items.find((it) => it.id === id);
  const selItems = () => board.items.filter((it) => selected.has(it.id));
  const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  function bounds(items) {
    if (!items.length) return null;
    const x = Math.min(...items.map((it) => it.x));
    const y = Math.min(...items.map((it) => it.y));
    const r = Math.max(...items.map((it) => it.x + it.w));
    const b = Math.max(...items.map((it) => it.y + it.h));
    return { x, y, w: r - x, h: b - y };
  }

  // ---------- Vue ----------

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    world.style.setProperty('--inv', 1 / view.s);
    const step = 32 * view.s; // trame de points qui suit le canevas
    stage.style.backgroundSize = `${step}px ${step}px`;
    stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
    stage.classList.toggle('no-grid', step < 10);
    document.getElementById('zoomLabel').textContent = `${Math.round(view.s * 100)} %`;
    drawOverlay();
    if (board) {
      board.view = { ...view };
      api.onChange(false);
    }
  }

  function toWorld(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.s, y: (clientY - r.top - view.y) / view.s };
  }

  function zoomAt(factor, sx, sy) {
    const s = clamp(view.s * factor, MIN_ZOOM, MAX_ZOOM);
    const k = s / view.s;
    view.x = sx - (sx - view.x) * k;
    view.y = sy - (sy - view.y) * k;
    view.s = s;
    applyView();
  }

  const zoomBy = (factor) => zoomAt(factor, stage.clientWidth / 2, stage.clientHeight / 2);

  function zoomToRect(rect, pad = 60, maxZoom = 1) {
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!rect) {
      Object.assign(view, { x: W / 2, y: H / 2, s: 1 });
      return applyView();
    }
    view.s = clamp(Math.min((W - 2 * pad) / rect.w, (H - 2 * pad) / rect.h, maxZoom), MIN_ZOOM, MAX_ZOOM);
    view.x = W / 2 - (rect.x + rect.w / 2) * view.s;
    view.y = H / 2 - (rect.y + rect.h / 2) * view.s;
    applyView();
  }

  // Molette : comme dans Miro, la souris zoome, le pavé tactile déplace (deux doigts) et zoome (pincement).
  // On reconnaît une souris à ses crans réguliers ; la décision tient pour tout un même geste.
  let lastWheel = 0;
  let lastWheelMouse = false;
  function isMouseWheel(e) {
    const now = performance.now();
    if (now - lastWheel > 250) {
      lastWheelMouse =
        e.deltaMode !== 0 ||
        (e.deltaX === 0 &&
          ((e.wheelDeltaY && e.wheelDeltaY % 120 === 0) || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 100)));
    }
    lastWheel = now;
    return lastWheelMouse;
  }

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? stage.clientHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      const mouse = isMouseWheel(e);
      if (e.ctrlKey || e.metaKey) return zoomAt(Math.exp(-dy * (mouse ? 0.0018 : 0.01)), sx, sy); // pincement ou Ctrl+molette
      const wheelZooms = settings.wheel === 'zoom' || (settings.wheel === 'auto' && mouse);
      if (wheelZooms && !e.shiftKey) return zoomAt(Math.exp(-dy * 0.0018), sx, sy);
      if (e.shiftKey && !dx) view.x -= dy; // Shift+molette : défilement horizontal
      else {
        view.x -= dx;
        view.y -= dy;
      }
      applyView();
    },
    { passive: false }
  );

  // ---------- Éléments ----------

  const BADGES = { gif: 'GIF', video: 'VIDÉO', youtube: 'YOUTUBE' };

  function makeEl(it) {
    const el = document.createElement('div');
    el.className = 'item';
    el.dataset.id = it.id;
    el.dataset.type = it.type;
    el.innerHTML =
      '<div class="tools">' +
      (it.type === 'video' ? '<button data-act="sound" title="Activer / couper le son">🔇</button>' : '') +
      (it.type === 'youtube' ? '<button data-act="play" title="Lire / arrêter la vidéo">▶</button>' : '') +
      '<button data-act="source" title="Ouvrir la source">↗</button>' +
      '</div>' +
      (it.type === 'image' ? '' : `<div class="badge"><span>${BADGES[it.type]}</span></div>`);
    placeEl(el, it);
    return el;
  }

  function placeEl(el, it) {
    el.style.transform = `translate(${it.x}px, ${it.y}px)`;
    el.style.width = `${it.w}px`;
    el.style.height = `${it.h}px`;
    el.classList.toggle('has-source', !!it.source);
  }

  function removeEl(id) {
    unloadMedia(id);
    els.get(id)?.remove();
    els.delete(id);
  }

  // Met le DOM en accord avec board.items (ajouts, suppressions, positions, ordre d'empilement).
  function sync() {
    const ids = new Set(board.items.map((it) => it.id));
    for (const id of [...els.keys()]) if (!ids.has(id)) removeEl(id);
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    board.items.forEach((it, i) => {
      let el = els.get(it.id);
      if (!el) els.set(it.id, (el = makeEl(it)));
      else placeEl(el, it);
      el.classList.toggle('selected', selected.has(it.id));
      if (world.children[i] !== el) world.insertBefore(el, world.children[i] || null);
    });
    document.getElementById('empty').hidden = board.items.length > 0;
    drawOverlay();
    updateInfo();
  }

  // ---------- Chargement paresseux des médias ----------
  // Seuls les médias proches de l'écran sont chargés. En petit : la vignette ;
  // en grand (ou GIF / vidéo assez visibles pour bouger) : le fichier d'origine.

  let mediaFrame = 0;
  function scheduleMedia() {
    mediaFrame ||= requestAnimationFrame(() => {
      mediaFrame = 0;
      refreshMedia();
    });
  }

  function viewRect(margin) {
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    return {
      x: (-view.x - margin * W) / view.s,
      y: (-view.y - margin * H) / view.s,
      w: (W * (1 + 2 * margin)) / view.s,
      h: (H * (1 + 2 * margin)) / view.s,
    };
  }

  function refreshMedia() {
    if (!board) return;
    const near = viewRect(0.5);
    const far = viewRect(1.5);
    const dpr = devicePixelRatio || 1;
    for (const it of board.items) {
      const px = Math.max(it.w, it.h) * view.s; // taille à l'écran
      els.get(it.id).classList.toggle('tiny', px < 90);
      if (!intersects(near, it)) {
        if (playing.has(it.id)) stop(it.id); // une vidéo YouTube sortie de l'écran s'arrête
        if (shown.has(it.id) && !intersects(far, it)) unloadMedia(it.id);
        continue;
      }
      let want = it.type === 'image' ? (px * dpr > THUMB_SIZE * 1.2 ? 'full' : 'thumb') : px > 150 ? 'full' : 'thumb';
      if (it.type === 'youtube') want = playing.has(it.id) ? 'player' : 'cover';
      if (shown.get(it.id)?.level !== want) loadMedia(it, want);
    }
  }

  async function loadMedia(it, level) {
    const entry = { level };
    shown.set(it.id, entry);
    if (it.type === 'youtube') return showYouTube(it, level, entry);
    // Absent de ce PC (ajouté depuis un autre) : on le récupère sur Google Drive.
    const blob = (await DB.getBlob(level === 'full' ? 'media' : 'thumbs', it.id)) || (await Sync.fetchBlob(it, level));
    if (shown.get(it.id) !== entry || !blob) return;
    if (level === 'full') MediaCache.touch(it.id, blob.size);
    const url = URL.createObjectURL(blob);
    let node;
    if (level === 'full' && it.type === 'video') {
      node = document.createElement('video');
      Object.assign(node, { muted: !audible.has(it.id), loop: true, autoplay: true, playsInline: true, src: url });
      await new Promise((ok) => {
        node.onloadeddata = ok;
        node.onerror = ok;
      });
    } else {
      node = new Image();
      node.draggable = false;
      node.src = url;
      await node.decode().catch(() => {});
    }
    const el = els.get(it.id);
    if (shown.get(it.id) !== entry || !el) return URL.revokeObjectURL(url);
    node.className = 'media';
    const old = el.querySelector('.media');
    if (old) old.replaceWith(node);
    else el.prepend(node);
    if (el._url) URL.revokeObjectURL(el._url);
    el._url = url;
  }

  // Carte YouTube : la vignette publique de la vidéo, ou le lecteur intégré quand on la lance.
  async function showYouTube(it, level, entry) {
    let node;
    if (level === 'player') {
      node = document.createElement('iframe');
      node.src = `https://www.youtube-nocookie.com/embed/${it.youtubeId}?autoplay=1&mute=1&loop=1&playlist=${it.youtubeId}&rel=0&playsinline=1`;
      node.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      node.allowFullscreen = true;
    } else {
      node = new Image();
      node.draggable = false;
      node.referrerPolicy = 'no-referrer';
      node.src = `https://i.ytimg.com/vi/${it.youtubeId}/hqdefault.jpg`;
      await node.decode().catch(() => {});
    }
    const el = els.get(it.id);
    if (shown.get(it.id) !== entry || !el) return;
    node.className = 'media';
    const old = el.querySelector('.media');
    if (old) old.replaceWith(node);
    else el.prepend(node);
    el.classList.toggle('playing', level === 'player');
    const btn = el.querySelector('[data-act="play"]');
    if (btn) btn.textContent = level === 'player' ? '■' : '▶';
  }

  function play(id) {
    playing.add(id);
    scheduleMedia();
  }

  function stop(id) {
    playing.delete(id);
    scheduleMedia();
  }

  function unloadMedia(id) {
    shown.delete(id);
    const el = els.get(id);
    if (!el) return;
    el.querySelector('.media')?.remove();
    el.classList.remove('playing');
    if (el._url) URL.revokeObjectURL(el._url);
    el._url = null;
  }

  // ---------- Sélection et calque de sélection ----------

  function setSelection(ids) {
    selected.clear();
    for (const id of ids) selected.add(id);
    for (const [id, el] of els) el.classList.toggle('selected', selected.has(id));
    drawOverlay();
    updateInfo();
  }

  function drawOverlay() {
    scheduleMedia();
    const b = board && bounds(selItems());
    selBox.hidden = !b;
    if (!b) return;
    selBox.style.left = `${b.x * view.s + view.x}px`;
    selBox.style.top = `${b.y * view.s + view.y}px`;
    selBox.style.width = `${b.w * view.s}px`;
    selBox.style.height = `${b.h * view.s}px`;
  }

  function updateInfo() {
    if (!board) return;
    const n = board.items.length;
    const parts = [`${n} média${n > 1 ? 's' : ''}`];
    if (selected.size) parts.push(`${selected.size} sélectionné${selected.size > 1 ? 's' : ''}`);
    document.getElementById('info').textContent = parts.join(' · ');
    api.onSelection(selected.size);
  }

  // ---------- Souris ----------

  // Suit un glisser jusqu'au relâchement du bouton.
  function drag(e, onMove, onEnd) {
    e.preventDefault();
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      onEnd?.(ev);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  const movedEnough = (e, ev) => Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) >= 3;

  function startPan(e) {
    let last = e;
    stage.classList.add('panning');
    drag(
      e,
      (ev) => {
        view.x += ev.clientX - last.clientX;
        view.y += ev.clientY - last.clientY;
        last = ev;
        applyView();
      },
      () => stage.classList.remove('panning')
    );
  }

  function startMove(e, clickedId) {
    const start = toWorld(e.clientX, e.clientY);
    const orig = selItems().map((it) => ({ it, x: it.x, y: it.y }));
    let moved = false;
    drag(
      e,
      (ev) => {
        if (!moved && !movedEnough(e, ev)) return;
        if (!moved) checkpoint();
        moved = true;
        const p = toWorld(ev.clientX, ev.clientY);
        for (const o of orig) {
          o.it.x = o.x + p.x - start.x;
          o.it.y = o.y + p.y - start.y;
          placeEl(els.get(o.it.id), o.it);
        }
        drawOverlay();
      },
      () => {
        if (moved) changed();
        else if (!e.shiftKey) setSelection([clickedId]); // simple clic dans une sélection : on ne garde que ce média
      }
    );
  }

  function startRubber(e) {
    const base = e.shiftKey ? [...selected] : [];
    const a = toWorld(e.clientX, e.clientY);
    const r = stage.getBoundingClientRect();
    let moved = false;
    drag(
      e,
      (ev) => {
        if (!moved && !movedEnough(e, ev)) return;
        moved = true;
        const b = toWorld(ev.clientX, ev.clientY);
        const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
        Object.assign(rubber.style, {
          left: `${Math.min(e.clientX, ev.clientX) - r.left}px`,
          top: `${Math.min(e.clientY, ev.clientY) - r.top}px`,
          width: `${Math.abs(ev.clientX - e.clientX)}px`,
          height: `${Math.abs(ev.clientY - e.clientY)}px`,
        });
        rubber.hidden = false;
        setSelection([...base, ...board.items.filter((it) => intersects(rect, it)).map((it) => it.id)]);
      },
      () => {
        rubber.hidden = true;
        if (!moved && !e.shiftKey) setSelection([]);
      }
    );
  }

  // Redimensionne la sélection entière depuis un coin, le coin opposé restant fixe.
  function startResize(e, corner) {
    const items = selItems();
    const b = bounds(items);
    const ax = corner.includes('w') ? b.x + b.w : b.x;
    const ay = corner.includes('n') ? b.y + b.h : b.y;
    const orig = items.map((it) => ({ it, x: it.x, y: it.y, w: it.w, h: it.h }));
    let started = false;
    drag(
      e,
      (ev) => {
        const p = toWorld(ev.clientX, ev.clientY);
        const f = Math.max(0.01, (Math.abs(p.x - ax) / b.w + Math.abs(p.y - ay) / b.h) / 2);
        if (!started) checkpoint();
        started = true;
        for (const o of orig) {
          Object.assign(o.it, { x: ax + (o.x - ax) * f, y: ay + (o.y - ay) * f, w: o.w * f, h: o.h * f });
          placeEl(els.get(o.it.id), o.it);
        }
        drawOverlay();
      },
      () => started && changed()
    );
  }

  stage.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault()); // pas de défilement auto au clic molette

  stage.addEventListener('pointerdown', (e) => {
    if (!board || e.target.closest('.tools button')) return;
    if (e.button === 1 || (e.button === 0 && spaceDown)) return startPan(e);
    if (e.button !== 0) return;
    const handle = e.target.closest('.handle');
    if (handle) return startResize(e, handle.dataset.corner);
    const el = e.target.closest('.item');
    if (!el) return startRubber(e);
    const id = el.dataset.id;
    if (e.shiftKey && selected.has(id)) {
      selected.delete(id);
      return setSelection([...selected]);
    }
    if (e.shiftKey) setSelection([...selected, id]);
    else if (!selected.has(id)) setSelection([id]);
    startMove(e, id);
  });

  stage.addEventListener('pointermove', (e) => (pointer = { x: e.clientX, y: e.clientY }));
  stage.addEventListener('pointerleave', () => (pointer = null));

  stage.addEventListener('click', (e) => {
    const btn = e.target.closest('.tools button');
    if (!btn) return;
    const id = btn.closest('.item').dataset.id;
    if (btn.dataset.act === 'source') window.open(byId(id).source, '_blank', 'noopener');
    if (btn.dataset.act === 'sound') {
      if (audible.has(id)) audible.delete(id);
      else audible.add(id);
      const video = els.get(id).querySelector('video');
      if (video) video.muted = !audible.has(id);
      btn.textContent = audible.has(id) ? '🔊' : '🔇';
    }
    if (btn.dataset.act === 'play') (playing.has(id) ? stop : play)(id);
  });

  // Double-clic sur un média : il remplit l'écran.
  stage.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.item');
    if (!el || e.target.closest('.tools')) return;
    const it = byId(el.dataset.id);
    zoomToRect(it, 30, MAX_ZOOM);
    if (it.type === 'youtube') play(it.id);
  });

  // Espace maintenu : déplacement de la vue à la souris.
  const typing = () => document.activeElement?.matches('input, textarea, select');
  addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || typing()) return;
    e.preventDefault();
    spaceDown = true;
    document.body.classList.add('space');
  });
  addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    spaceDown = false;
    document.body.classList.remove('space');
  });
  addEventListener('resize', () => drawOverlay());

  // ---------- Modifications (avec annulation) ----------

  function checkpoint() {
    undoStack.push(JSON.stringify(board.items));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }

  function changed() {
    sync();
    api.onChange(true);
  }

  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(board.items));
    board.items = JSON.parse(from.pop());
    changed();
  }

  let animTimer;
  function animate() {
    world.classList.add('animate');
    clearTimeout(animTimer);
    animTimer = setTimeout(() => world.classList.remove('animate'), 450);
  }

  // Applique une Map id -> {x, y, w, h} renvoyée par Layout.
  function applyPlacement(placed) {
    checkpoint();
    for (const it of board.items) if (placed.has(it.id)) Object.assign(it, placed.get(it.id));
    animate();
    changed();
  }

  // Médias visés par une commande : la sélection, ou toute la planche si rien (ou un seul) n'est sélectionné.
  const targets = (min = 2) => (selected.size >= min ? selItems() : board.items);

  function ordered(items, order) {
    if (order === 'added') return [...items].sort((a, b) => a.added.localeCompare(b.added));
    if (order === 'type') {
      const rank = { video: 0, gif: 1, image: 2 };
      return [...items].sort((a, b) => rank[a.type] - rank[b.type] || a.added.localeCompare(b.added));
    }
    return Layout.readingOrder(items);
  }

  function arrange(opts) {
    const items = targets();
    if (!items.length) return;
    const b = bounds(items);
    const list = ordered(items, opts.order);
    const height = +opts.rowHeight || 300;
    const gap = Math.max(0, +opts.gap || 0);
    const placed =
      opts.mode === 'grid'
        ? Layout.grid(list, { x: b.x, y: b.y, cell: height, gap, cols: +opts.cols || Layout.autoCols(list.length) })
        : Layout.justifiedRows(list, {
            x: b.x, y: b.y, height, gap,
            width: +opts.width || Layout.autoWidth(list, height, gap),
          });
    applyPlacement(placed);
    if (items === board.items) zoomToRect(bounds(board.items));
  }

  // Même hauteur (ou même largeur) pour tous, proportions gardées, coin haut-gauche fixe.
  function uniform(dim, size) {
    const items = targets(1);
    if (!items.length || !(size > 0)) return;
    const placed = new Map();
    for (const it of items) {
      const r = it.w / it.h;
      placed.set(it.id, dim === 'w' ? { w: size, h: size / r } : { w: size * r, h: size });
    }
    applyPlacement(placed);
  }

  // Place les nouveaux médias en lignes, centrées sur le point visé.
  function addItems(items, at) {
    if (!items.length) return;
    for (const it of items) {
      it.h = NEW_HEIGHT;
      it.w = (NEW_HEIGHT * it.nw) / (it.nh || 1);
    }
    const placed = Layout.justifiedRows(items, {
      x: 0, y: 0, height: NEW_HEIGHT, gap: 16,
      width: Layout.autoWidth(items, NEW_HEIGHT, 16),
    });
    for (const it of items) Object.assign(it, placed.get(it.id));
    const b = bounds(items);
    for (const it of items) {
      it.x += at.x - b.w / 2;
      it.y += at.y - b.h / 2;
    }
    checkpoint();
    board.items.push(...items);
    selected.clear();
    for (const it of items) selected.add(it.id);
    changed();
  }

  function deleteSelected() {
    if (!selected.size) return;
    checkpoint();
    board.items = board.items.filter((it) => !selected.has(it.id));
    changed();
  }

  function restack(front) {
    if (!selected.size) return;
    checkpoint();
    const sel = selItems();
    const rest = board.items.filter((it) => !selected.has(it.id));
    board.items = front ? [...rest, ...sel] : [...sel, ...rest];
    changed();
  }

  function setSource(id, url) {
    checkpoint();
    byId(id).source = url;
    changed();
  }

  // Ouvre une planche (et oublie l'historique d'annulation de la précédente).
  function load(b) {
    for (const id of [...els.keys()]) removeEl(id);
    selected.clear();
    undoStack.length = 0;
    redoStack.length = 0;
    board = b;
    sync();
    if (b.view) {
      Object.assign(view, b.view);
      applyView();
    } else zoomToRect(bounds(b.items));
  }

  // Point du canevas où déposer un collage : sous la souris, sinon au centre de l'écran.
  function dropPoint() {
    if (pointer) return toWorld(pointer.x, pointer.y);
    const r = stage.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  return Object.assign(api, {
    load, addItems, deleteSelected, arrange, uniform, setSource, toWorld, dropPoint,
    undo: () => restore(undoStack, redoStack),
    redo: () => restore(redoStack, undoStack),
    bringToFront: () => restack(true),
    sendToBack: () => restack(false),
    selectAll: () => setSelection(board.items.map((it) => it.id)),
    clearSelection: () => setSelection([]),
    select: (id) => !selected.has(id) && setSelection([id]),
    selectedItems: () => selItems(),
    itemOf: (target) => {
      const el = target.closest?.('.item');
      return el ? byId(el.dataset.id) : null;
    },
    // Relance le chargement des médias restés vides (après connexion à Drive).
    refreshMedia: () => {
      for (const [id, el] of els) if (!el.querySelector('.media')) shown.delete(id);
      scheduleMedia();
    },
    zoomBy,
    zoomReset: () => zoomBy(1 / view.s),
    fitAll: () => zoomToRect(bounds(board.items)),
    fitSelection: () => zoomToRect(bounds(selItems()) || bounds(board.items)),
    selectionSize: () => selected.size,
  });
})();
