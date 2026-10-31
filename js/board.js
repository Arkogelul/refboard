// Canevas infini : vue (déplacement, zoom), affichage des médias, sélection,
// déplacement, redimensionnement, rangement et annulation.

const Board = (() => {
  const stage = document.getElementById('stage');
  const world = document.getElementById('world');
  const selBox = document.getElementById('selBox');
  const rubber = document.getElementById('rubber');
  const dropMark = document.getElementById('dropMark');
  const palette = document.getElementById('framePalette');

  const MIN_ZOOM = 0.02;
  const MAX_ZOOM = 8;
  const NEW_HEIGHT = 300; // hauteur des médias ajoutés, en unités du canevas
  const FRAME_PAD = 24; // marge entre le bord d'un cadre et ses médias
  const FRAME_MIN_W = 300;
  const FRAME_MIN_H = 160;
  const FRAME_GAP = 120; // écart minimal entre cadres rangés (laisse la place aux bords et aux onglets)
  const FRAME_EDGE = 14; // épaisseur du bord attrapable, en pixels à l'écran
  // Palette des cadres : des teintes sourdes mais bien distinctes les unes des autres.
  const FRAME_COLORS = [
    '#505b72', '#8f4650', '#96603f', '#8f7a3a', '#6f7d3a', '#4a7d4f',
    '#3f7f73', '#3f7a8f', '#44639a', '#60509a', '#8a4a8f', '#a0527c',
  ];
  const FRAME_DEFAULT_COLOR = FRAME_COLORS[0];
  // Bords et onglets des cadres : taille fixe à l'écran jusqu'à 100 %, puis ils rétrécissent moins vite que le canevas.
  const frameScale = () => Math.max(0.4, Math.min(1, Math.sqrt(view.s)));

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
  let endRename = null; // valide le renommage de cadre en cours
  let pointer = null; // dernière position de la souris sur le canevas (coordonnées écran)

  const api = {
    onChange: () => {}, // (contenuModifié) → sauvegarde différée
    onSelection: () => {}, // (nombre) → libellés de la barre d'outils
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const byId = (id) => board.items.find((it) => it.id === id);
  const selItems = () => board.items.filter((it) => selected.has(it.id));
  const frameById = (id) => board.frames.find((f) => f.id === id);
  const frameOfItem = (id) => board.frames.find((f) => f.ids.includes(id));
  const selFrames = () => board.frames.filter((f) => selected.has(f.id));
  const selBlocks = () => [...selFrames(), ...selItems()];
  const allBlocks = () => [...board.frames, ...board.items];
  const freeItems = () => {
    const inFrame = new Set(board.frames.flatMap((f) => f.ids));
    return board.items.filter((it) => !inFrame.has(it.id));
  };
  // Cadres contenant au moins un média sélectionné.
  const framesOfSelection = () => [...new Set(selItems().map((it) => frameOfItem(it.id)).filter(Boolean))];
  const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const encloses = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

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
    world.style.setProperty('--frame-inv', frameScale() / view.s);
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
    if (it.ids) return makeFrameEl(it);
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

  // Cadre : un fond transparent qui laisse passer les clics, quatre bords épais et un onglet attrapables.
  function makeFrameEl(f) {
    const el = document.createElement('div');
    el.className = 'frame';
    el.dataset.id = f.id;
    el.innerHTML =
      '<div class="frame-line"></div><div class="frame-ring"></div><div class="frame-corner"></div>' +
      '<div class="frame-edge top"></div><div class="frame-edge right"></div>' +
      '<div class="frame-edge bottom"></div><div class="frame-edge left"></div>' +
      '<div class="frame-tab" title="Double-clic pour renommer"><span></span></div>' +
      '<div class="frame-grip" title="Changer la largeur">' +
      '<svg viewBox="0 0 30 30"><path d="M23 -6 V8 A15 15 0 0 1 8 23 H-6"/></svg></div>';
    el._name = el.querySelector('.frame-tab span');
    placeEl(el, f);
    return el;
  }

  function placeEl(el, it) {
    if (it.ids) {
      el._name.textContent = it.name;
      el.style.setProperty('--frame', it.color || FRAME_DEFAULT_COLOR);
    }
    el.style.transform = `translate(${it.x}px, ${it.y}px)`;
    el.style.width = `${it.w}px`;
    el.style.height = `${it.h}px`;
    if (!it.ids) el.classList.toggle('has-source', !!it.source);
  }

  function removeEl(id) {
    unloadMedia(id);
    els.get(id)?.remove();
    els.delete(id);
  }

  // Met le DOM en accord avec board.items (ajouts, suppressions, positions, ordre d'empilement).
  function sync() {
    const blocks = allBlocks(); // les cadres d'abord : ils restent derrière les médias
    const ids = new Set(blocks.map((it) => it.id));
    for (const id of [...els.keys()]) if (!ids.has(id)) removeEl(id);
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    for (const f of board.frames) f.ids = f.ids.filter((id) => ids.has(id));
    blocks.forEach((it, i) => {
      let el = els.get(it.id);
      if (!el) els.set(it.id, (el = makeEl(it)));
      else placeEl(el, it);
      el.classList.toggle('selected', selected.has(it.id));
      if (world.children[i] !== el) world.insertBefore(el, world.children[i] || null);
    });
    document.getElementById('empty').hidden = blocks.length > 0;
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
    const sel = board ? selBlocks() : [];
    const b = bounds(sel);
    // Un cadre sélectionné a son propre contour : pas de rectangle de sélection autour.
    selBox.hidden = !b || sel.every((it) => it.ids);
    if (selBox.hidden) return;
    // Poignées : seulement pour des médias libres. Un média dans un cadre suit le rangement du cadre.
    selBox.classList.toggle('no-handles', sel.some((it) => it.ids || frameOfItem(it.id)));
    selBox.style.left = `${b.x * view.s + view.x}px`;
    selBox.style.top = `${b.y * view.s + view.y}px`;
    selBox.style.width = `${b.w * view.s}px`;
    selBox.style.height = `${b.h * view.s}px`;
  }

  function updateInfo() {
    if (!board) return;
    const n = board.items.length;
    const parts = [`${n} média${n > 1 ? 's' : ''}`];
    const nf = board.frames.length;
    if (nf) parts.push(`${nf} cadre${nf > 1 ? 's' : ''}`);
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
    const moving = selFrames();
    const children = new Set(moving.flatMap((f) => f.ids));
    const loose = selItems().filter((it) => !children.has(it.id));
    const objs = [...moving, ...board.items.filter((it) => children.has(it.id)), ...loose];
    const orig = objs.map((it) => ({ it, x: it.x, y: it.y }));
    let moved = false;
    drag(
      e,
      (ev) => {
        if (!moved && !movedEnough(e, ev)) return;
        if (!moved) {
          checkpoint();
          for (const it of loose) els.get(it.id).classList.add('dragging');
        }
        moved = true;
        const p = toWorld(ev.clientX, ev.clientY);
        for (const o of orig) {
          o.it.x = o.x + p.x - start.x;
          o.it.y = o.y + p.y - start.y;
          placeEl(els.get(o.it.id), o.it);
        }
        if (!moving.length) showDropTarget(p, loose);
        drawOverlay();
      },
      (ev) => {
        if (moved) {
          showDropTarget(null);
          for (const it of loose) els.get(it.id).classList.remove('dragging');
          const p = toWorld(ev.clientX, ev.clientY);
          dropItems(loose, moving.length ? null : frameAt(p), p);
          changed();
        } else if (!e.shiftKey) setSelection([clickedId]); // simple clic dans une sélection : on ne garde que ce média
      }
    );
  }

  // ---------- Cadres ----------

  function frameAt(p) {
    const edge = (FRAME_EDGE * frameScale()) / view.s;
    return board.frames.findLast(
      (f) => p.x >= f.x - edge && p.x <= f.x + f.w + edge && p.y >= f.y - edge && p.y <= f.y + f.h + edge
    );
  }

  // Range les médias d'un cadre : sa largeur est fixe, sa hauteur suit le contenu.
  function flowFrame(f) {
    const list = f.ids.map(byId).filter(Boolean);
    const { mode, rowHeight: height, gap } = f.layout;
    const x = f.x + FRAME_PAD;
    const y = f.y + FRAME_PAD;
    const width = f.w - 2 * FRAME_PAD;
    const placed =
      mode === 'grid'
        ? Layout.grid(list, { x, y, gap, cell: height, cols: Math.max(1, Math.floor((width + gap) / (height + gap))) })
        : Layout.justifiedRows(list, { x, y, width, height, gap });
    for (const it of list) Object.assign(it, placed.get(it.id));
    const b = bounds(list);
    f.h = b ? b.y + b.h - f.y + FRAME_PAD : FRAME_MIN_H;
  }

  // Rang d'insertion d'après le point visé, en suivant l'ordre de lecture du cadre.
  function insertIndex(f, p, skip = new Set()) {
    const list = f.ids.filter((id) => !skip.has(id)).map(byId);
    const i = list.findIndex((it) => p.y < it.y || (p.y <= it.y + it.h && p.x < it.x + it.w / 2));
    return i < 0 ? list.length : i;
  }

  // Pendant le glisser : le cadre visé s'allume, un trait montre où les médias vont s'insérer.
  function showDropTarget(p, loose = []) {
    const target = p && frameAt(p);
    for (const f of board.frames) els.get(f.id).classList.toggle('drop-target', f === target);
    dropMark.hidden = !target;
    if (!target) return;
    const skip = new Set(loose.map((it) => it.id));
    const list = target.ids.filter((id) => !skip.has(id)).map(byId);
    const i = insertIndex(target, p, skip);
    const prev = list[i - 1];
    const next = list[i];
    const after = prev && (!next || p.y <= prev.y + prev.h);
    const ref = after ? prev : next;
    dropMark.hidden = !ref;
    if (!ref) return;
    const half = target.layout.gap / 2;
    const x = after ? ref.x + ref.w + half : ref.x - half;
    dropMark.style.left = `${x * view.s + view.x - 2}px`;
    dropMark.style.top = `${ref.y * view.s + view.y}px`;
    dropMark.style.height = `${ref.h * view.s}px`;
  }

  // Sort les médias de leurs cadres, les insère dans target s'il y en a un, et réorganise les cadres touchés.
  function dropItems(loose, target, p) {
    const ids = new Set(loose.map((it) => it.id));
    const touched = new Set();
    for (const f of board.frames) {
      if (!f.ids.some((id) => ids.has(id))) continue;
      f.ids = f.ids.filter((id) => !ids.has(id));
      touched.add(f);
    }
    if (target && loose.length) {
      target.ids.splice(insertIndex(target, p), 0, ...Layout.readingOrder(loose).map((it) => it.id));
      touched.add(target);
    }
    if (!touched.size) return;
    touched.forEach(flowFrame);
    animate();
  }

  function createFrame() {
    const list = Layout.readingOrder(selItems());
    const layout = { mode: settings.mode, rowHeight: +settings.rowHeight || 300, gap: Math.max(0, +settings.gap || 0) };
    const b = bounds(list);
    const at = b ? { x: b.x - FRAME_PAD, y: b.y - FRAME_PAD } : dropPoint();
    const f = {
      id: uid(), name: 'Nouveau cadre', ...at,
      w: list.length ? Layout.autoWidth(list, layout.rowHeight, layout.gap) + 2 * FRAME_PAD : 1200,
      h: FRAME_MIN_H, ids: [], layout, added: new Date().toISOString(),
      color: settings.frameColor || FRAME_DEFAULT_COLOR, // un nouveau cadre reprend la dernière couleur choisie
    };
    checkpoint();
    board.frames.push(f);
    dropItems(list, f, { x: Infinity, y: Infinity });
    selected.clear();
    selected.add(f.id);
    changed();
    renameFrame(f.id);
  }

  function renameFrame(id) {
    const f = frameById(id);
    const el = els.get(id);
    const tab = el?.querySelector('.frame-tab');
    if (!tab || tab.querySelector('input')) return;
    const input = document.createElement('input');
    input.value = f.name;
    const dot = document.createElement('button');
    dot.className = 'frame-dot';
    dot.title = 'Couleur du cadre';
    dot.onclick = () => togglePalette(f, dot, input);
    dot.onmousedown = (e) => e.preventDefault(); // garde le champ actif
    tab.replaceChildren(input, dot);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      endRename = null;
      palette.hidden = true;
      const name = input.value.trim();
      if (save && name && name !== f.name) {
        checkpoint();
        f.name = name;
        el._name.textContent = name;
        api.onChange(true);
      }
      tab.replaceChildren(el._name);
    };
    endRename = () => finish(true);
    input.addEventListener('blur', endRename);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
  }

  // Palette de couleurs, ouverte depuis la pastille de l'onglet pendant le renommage.
  function togglePalette(f, dot, input) {
    if (!palette.hidden) return (palette.hidden = true);
    palette.replaceChildren(
      ...FRAME_COLORS.map((color) => {
        const b = document.createElement('button');
        b.style.background = color;
        b.classList.toggle('current', color === (f.color || FRAME_DEFAULT_COLOR));
        b.onclick = () => {
          checkpoint();
          f.color = color;
          settings.frameColor = color;
          remember('refboard.settings', settings);
          placeEl(els.get(f.id), f);
          api.onChange(true);
          palette.hidden = true;
          input.focus();
        };
        return b;
      })
    );
    palette.hidden = false;
    const r = dot.getBoundingClientRect();
    palette.style.left = `${Math.min(r.left, innerWidth - palette.offsetWidth - 8)}px`;
    palette.style.top = `${Math.min(r.bottom + 6, innerHeight - palette.offsetHeight - 8)}px`;
  }

  // Sort les médias sélectionnés de leur cadre : ils se posent à sa droite.
  function ejectSelected() {
    const list = Layout.readingOrder(selItems().filter((it) => frameOfItem(it.id)));
    if (!list.length) return;
    checkpoint();
    const f = frameOfItem(list[0].id);
    let y = f.y;
    for (const it of list) {
      it.x = f.x + f.w + FRAME_GAP;
      it.y = y;
      y += it.h + FRAME_PAD;
    }
    dropItems(list, null);
    changed();
  }

  function startRubber(e) {
    const base = e.shiftKey ? [...selected] : [];
    const a = toWorld(e.clientX, e.clientY);
    const inside = frameAt(a); // parti de l'intérieur d'un cadre : on ne sélectionne que ses médias
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
        const hit = inside
          ? inside.ids.map(byId).filter((it) => intersects(rect, it))
          : [...board.frames.filter((f) => encloses(rect, f)), ...freeItems().filter((it) => intersects(rect, it))];
        setSelection([...base, ...hit.map((it) => it.id)]);
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

  // Un cadre se redimensionne en largeur : ses médias se réorganisent et sa hauteur suit.
  function resizeFrame(e, f) {
    let started = false;
    const el = els.get(f.id);
    el.classList.add('resizing'); // la poignée reste visible jusqu'au relâchement
    document.body.classList.add('resizing-frame');
    drag(
      e,
      (ev) => {
        if (!started) checkpoint();
        started = true;
        const p = toWorld(ev.clientX, ev.clientY);
        f.w = Math.max(FRAME_MIN_W, p.x - f.x);
        flowFrame(f);
        placeEl(els.get(f.id), f);
        for (const id of f.ids) placeEl(els.get(id), byId(id));
        drawOverlay();
      },
      () => {
        el.classList.remove('resizing');
        document.body.classList.remove('resizing-frame');
        if (started) changed();
      }
    );
  }

  stage.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault()); // pas de défilement auto au clic molette

  stage.addEventListener('pointerdown', (e) => {
    if (!board || e.target.closest('.tools button, .frame-tab input, .frame-dot')) return;
    endRename?.();
    if (e.button === 1 || (e.button === 0 && spaceDown)) return startPan(e);
    if (e.button !== 0) return;
    const handle = e.target.closest('.handle');
    if (handle) return startResize(e, handle.dataset.corner);
    if (e.target.closest('.frame-grip')) {
      const id = e.target.closest('.frame').dataset.id;
      setSelection([id]);
      return resizeFrame(e, frameById(id));
    }
    const el = e.target.closest('.item, .frame');
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
    const frameEl = e.target.closest('.frame');
    if (frameEl) {
      if (e.target.closest('.frame-tab')) renameFrame(frameEl.dataset.id);
      else zoomToRect(frameById(frameEl.dataset.id)); // double-clic sur le bord : le cadre remplit l'écran
      return;
    }
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
    undoStack.push(snapshot());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }

  function changed() {
    sync();
    api.onChange(true);
  }

  const snapshot = () => JSON.stringify({ items: board.items, frames: board.frames });

  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot());
    Object.assign(board, JSON.parse(from.pop()));
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

  function ordered(items, order) {
    if (order === 'added') return [...items].sort((a, b) => a.added.localeCompare(b.added));
    if (order === 'type') {
      const rank = { video: 0, gif: 1, image: 2 };
      const of = (it) => rank[it.type] ?? 3;
      return [...items].sort((a, b) => of(a) - of(b) || a.added.localeCompare(b.added));
    }
    return Layout.readingOrder(items);
  }

  // Réorganise l'intérieur de cadres ; layoutOf donne les réglages de chacun.
  function reflowFrames(list, layoutOf, order) {
    checkpoint();
    for (const f of list) {
      f.layout = layoutOf(f);
      if (order) f.ids = ordered(f.ids.map(byId), order).map((it) => it.id);
      flowFrame(f);
    }
    animate();
    changed();
  }

  // Cadres et médias libres rangés comme des blocs : les cadres gardent leur taille et leur contenu suit.
  function arrangeBlocks(blocks, opts, gap) {
    const b = bounds(blocks);
    const space = Math.max(gap, FRAME_GAP, (70 * frameScale()) / view.s); // place pour l'onglet et les bords, qui ne suivent pas tout à fait le zoom
    const placed = Layout.shelves(ordered(blocks, opts.order), {
      x: b.x, y: b.y, gap: space,
      width: +opts.width || Layout.shelfWidth(blocks, space),
      cols: opts.mode === 'grid' ? +opts.cols || 0 : 0,
    });
    checkpoint();
    for (const it of blocks) {
      const p = placed.get(it.id);
      for (const id of it.ids || []) {
        byId(id).x += p.x - it.x;
        byId(id).y += p.y - it.y;
      }
      Object.assign(it, p);
    }
    animate();
    changed();
  }

  function arrange(opts) {
    const height = +opts.rowHeight || 300;
    const gap = Math.max(0, +opts.gap || 0);
    const whole = selected.size < 2 && !selFrames().length;
    const isFree = (it) => it.ids || !frameOfItem(it.id);
    // Un seul cadre, ou seulement des médias de cadres : on range l'intérieur.
    if (!whole && selFrames().length <= 1 && !selItems().some(isFree)) {
      const list = selFrames().length ? selFrames() : framesOfSelection();
      if (list.length) reflowFrames(list, () => ({ mode: opts.mode, rowHeight: height, gap }), opts.order);
      return;
    }
    const blocks = whole ? [...board.frames, ...freeItems()] : selBlocks().filter(isFree);
    if (!blocks.length) return;
    if (blocks.some((it) => it.ids)) arrangeBlocks(blocks, opts, gap);
    else {
      const b = bounds(blocks);
      const list = ordered(blocks, opts.order);
      const placed =
        opts.mode === 'grid'
          ? Layout.grid(list, { x: b.x, y: b.y, cell: height, gap, cols: +opts.cols || Layout.autoCols(list.length) })
          : Layout.justifiedRows(list, {
              x: b.x, y: b.y, height, gap,
              width: +opts.width || Layout.autoWidth(list, height, gap),
            });
      applyPlacement(placed);
    }
    if (whole) zoomToRect(bounds(allBlocks()));
  }

  // Même hauteur (ou même largeur) pour tous, proportions gardées, coin haut-gauche fixe.
  // Dans un cadre, c'est la hauteur des lignes du cadre qui change.
  function uniform(dim, size) {
    if (!(size > 0)) return;
    const list = [...new Set([...selFrames(), ...framesOfSelection()])];
    const items = (selected.size ? selItems() : freeItems()).filter((it) => !frameOfItem(it.id));
    if (!items.length) return list.length && reflowFrames(list, (f) => ({ ...f.layout, rowHeight: size }));
    const placed = new Map();
    for (const it of items) {
      const r = it.w / it.h;
      placed.set(it.id, dim === 'w' ? { w: size, h: size / r } : { w: size * r, h: size });
    }
    applyPlacement(placed);
  }

  // Place les nouveaux médias en lignes, centrées sur le point visé.
  function addItems(items, at, intoFrame = true) {
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
    const target = intoFrame && frameAt(at); // déposés sur un cadre : ils y entrent
    if (target) dropItems(items, target, at);
    selected.clear();
    for (const it of items) selected.add(it.id);
    changed();
  }

  function deleteSelected() {
    if (!selected.size) return;
    checkpoint();
    const touched = framesOfSelection().filter((f) => !selected.has(f.id));
    // Supprimer un cadre garde ses médias : ils redeviennent libres.
    board.frames = board.frames.filter((f) => !selected.has(f.id));
    board.items = board.items.filter((it) => !selected.has(it.id));
    for (const f of touched) {
      f.ids = f.ids.filter((id) => !selected.has(id));
      flowFrame(f);
    }
    changed();
  }

  function restack(front) {
    if (!selected.size) return;
    checkpoint();
    const sel = selItems();
    const rest = board.items.filter((it) => !selected.has(it.id));
    board.items = front ? [...rest, ...sel] : [...sel, ...rest];
    const selF = selFrames();
    const restF = board.frames.filter((f) => !selected.has(f.id));
    board.frames = front ? [...restF, ...selF] : [...selF, ...restF];
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
    board.frames ??= []; // planches créées avant l'arrivée des cadres
    sync();
    if (b.view) {
      Object.assign(view, b.view);
      applyView();
    } else zoomToRect(bounds(allBlocks()));
  }

  // Point du canevas où déposer un collage : sous la souris, sinon au centre de l'écran.
  function dropPoint() {
    if (pointer) return toWorld(pointer.x, pointer.y);
    const r = stage.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  return Object.assign(api, {
    load, addItems, deleteSelected, arrange, uniform, setSource, toWorld, dropPoint, createFrame, renameFrame, ejectSelected,
    undo: () => restore(undoStack, redoStack),
    redo: () => restore(redoStack, undoStack),
    bringToFront: () => restack(true),
    sendToBack: () => restack(false),
    selectAll: () => setSelection([...board.frames, ...freeItems()].map((it) => it.id)),
    clearSelection: () => setSelection([]),
    select: (id) => !selected.has(id) && setSelection([id]),
    selectedItems: () => selItems(),
    inFrame: (id) => !!frameOfItem(id),
    frameOf: (target) => {
      const el = target.closest?.('.frame');
      return el ? frameById(el.dataset.id) : null;
    },
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
    fitAll: () => zoomToRect(bounds(allBlocks())),
    fitSelection: () => zoomToRect(bounds(selBlocks()) || bounds(allBlocks())),
    selectionSize: () => selected.size,
  });
})();
