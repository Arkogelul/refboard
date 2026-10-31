// Rangement automatique. Fonctions pures : elles reçoivent des médias {id, x, y, w, h}
// et renvoient une Map id -> {x, y, w, h}, sans rien modifier.

const Layout = (() => {
  const ratio = (it) => it.w / it.h;

  // Ordre de lecture : on regroupe les médias en lignes (un média dont le centre tombe
  // dans la ligne en cours en fait partie), puis de gauche à droite dans chaque ligne.
  function readingOrder(items) {
    const rows = [];
    for (const it of [...items].sort((a, b) => a.y - b.y)) {
      const row = rows.at(-1);
      if (row && it.y + it.h / 2 < row.bottom) row.items.push(it);
      else rows.push({ items: [it], bottom: it.y + it.h });
    }
    return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
  }

  // Lignes justifiées (façon Google Photos) : chaque ligne remplit toute la largeur,
  // sa hauteur s'ajuste autour de la hauteur cible. La dernière ligne n'est pas étirée.
  function justifiedRows(items, { x, y, width, height, gap }) {
    const out = new Map();
    let row = [];
    let sum = 0; // somme des proportions (largeur / hauteur) de la ligne en cours
    let top = y;
    const rowHeight = (n, s) => (width - gap * (n - 1)) / s;
    const flush = (h) => {
      let left = x;
      for (const it of row) {
        const w = h * ratio(it);
        out.set(it.id, { x: left, y: top, w, h });
        left += w + gap;
      }
      top += h + gap;
      row = [];
      sum = 0;
    };

    for (const it of items) {
      const r = ratio(it);
      const hWith = rowHeight(row.length + 1, sum + r);
      if (hWith > height) {
        row.push(it); // la ligne n'est pas encore pleine
        sum += r;
        continue;
      }
      // Avec ce média, la ligne est pleine : on la ferme avant ou après lui,
      // selon ce qui donne la hauteur la plus proche de la cible.
      if (row.length && rowHeight(row.length, sum) - height < height - hWith) flush(rowHeight(row.length, sum));
      row.push(it);
      sum += r;
      const h = rowHeight(row.length, sum);
      if (h <= height) flush(h);
    }
    if (row.length) flush(Math.min(height, rowHeight(row.length, sum)));
    return out;
  }

  // Grille : chaque média tient dans une case carrée, centré, en gardant ses proportions.
  function grid(items, { x, y, cols, cell, gap }) {
    const out = new Map();
    items.forEach((it, i) => {
      const r = ratio(it);
      const w = r >= 1 ? cell : cell * r;
      const h = r >= 1 ? cell / r : cell;
      const cx = x + (i % cols) * (cell + gap);
      const cy = y + Math.floor(i / cols) * (cell + gap);
      out.set(it.id, { x: cx + (cell - w) / 2, y: cy + (cell - h) / 2, w, h });
    });
    return out;
  }

  // Blocs de taille fixe (cadres et médias libres), posés en lignes sans être redimensionnés.
  // cols > 0 : un nombre fixe de blocs par ligne ; sinon on passe à la ligne au-delà de width.
  function shelves(items, { x, y, width, gap, cols = 0 }) {
    const out = new Map();
    let left = x;
    let top = y;
    let rowH = 0;
    let n = 0;
    for (const it of items) {
      if (n && (cols ? n >= cols : left + it.w > x + width)) {
        left = x;
        top += rowH + gap;
        rowH = 0;
        n = 0;
      }
      out.set(it.id, { x: left, y: top });
      left += it.w + gap;
      rowH = Math.max(rowH, it.h);
      n++;
    }
    return out;
  }

  // Largeur automatique pour shelves : vise aussi un ensemble au format 16:9.
  function shelfWidth(items, gap) {
    const area = items.reduce((s, it) => s + (it.w + gap) * (it.h + gap), 0);
    return Math.max(Math.max(...items.map((it) => it.w)), Math.sqrt((16 / 9) * area));
  }

  // Largeur automatique : vise un ensemble au format 16:9.
  function autoWidth(items, height, gap) {
    const linear = items.reduce((s, it) => s + ratio(it) * height + gap, 0);
    const widest = Math.max(...items.map((it) => ratio(it) * height));
    return Math.max(widest, Math.sqrt((16 / 9) * linear * (height + gap)));
  }

  const autoCols = (n) => Math.max(1, Math.round(Math.sqrt((n * 16) / 9)));

  return { readingOrder, justifiedRows, grid, shelves, shelfWidth, autoWidth, autoCols };
})();
