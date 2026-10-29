// Import d'un fichier : type, dimensions, vignette, puis enregistrement local.

const MEDIA_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'image/gif': 'gif', 'video/mp4': 'video', 'video/webm': 'video',
};
const EXT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm',
};
const THUMB_SIZE = 480; // plus grand côté des vignettes, en pixels

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function mimeOf(blob, name = '') {
  const type = (blob.type || '').split(';')[0];
  if (MEDIA_TYPES[type]) return type;
  const ext = name.split(/[?#]/)[0].split('.').pop().toLowerCase();
  return EXT_TYPES[ext] || null;
}

// Renvoie un nouvel élément de planche (pas encore placé).
async function importMedia(blob, { name = '', source = '' } = {}) {
  const mime = mimeOf(blob, name);
  if (!mime) throw new Error(`Format non pris en charge : ${name || blob.type || 'inconnu'}`);
  if (blob.type !== mime) blob = new Blob([blob], { type: mime });
  const type = MEDIA_TYPES[mime];
  const { thumb, nw, nh } = type === 'video' ? await videoThumb(blob) : await imageThumb(blob);
  const id = uid();
  await DB.putBlob('media', id, blob);
  await DB.putBlob('thumbs', id, thumb);
  return {
    id, type, mime, nw, nh, x: 0, y: 0, w: nw, h: nh,
    source, name, added: new Date().toISOString(),
    fileId: null, // identifiant du fichier sur Google Drive (étape suivante)
  };
}

// Carte YouTube : pas de fichier, juste l'identifiant de la vidéo (vignette et lecteur viennent de YouTube).
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

function youtubeItem(youtubeId, { short = false, source = '' } = {}) {
  return {
    id: uid(), type: 'youtube', youtubeId, nw: short ? 9 : 16, nh: short ? 16 : 9, x: 0, y: 0, w: 16, h: 9,
    source: source || `https://www.youtube.com/watch?v=${youtubeId}`, name: '', added: new Date().toISOString(), fileId: null,
  };
}

// Télécharge un média depuis une URL (glisser-déposer depuis une autre page, collage d'un lien).
async function importUrl(url) {
  let r;
  try {
    r = await fetch(url);
  } catch {
    throw new Error("Le site bloque la récupération directe. Enregistre le fichier puis glisse-le ici, ou passe par l'extension.");
  }
  if (!r.ok) throw new Error(`Téléchargement impossible (${r.status})`);
  return importMedia(await r.blob(), { name: url, source: url });
}

async function imageThumb(blob) {
  const bmp = await createImageBitmap(blob).catch(() => {
    throw new Error('Image illisible');
  });
  const res = { nw: bmp.width, nh: bmp.height, thumb: await drawThumb(bmp, bmp.width, bmp.height) };
  bmp.close();
  return res;
}

function videoThumb(blob) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    const fail = () => {
      URL.revokeObjectURL(url);
      ko(new Error('Vidéo illisible'));
    };
    const timer = setTimeout(fail, 15000);
    v.muted = true;
    v.preload = 'auto';
    v.onerror = fail;
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(0.5, (v.duration || 0) / 3); // évite une première image souvent noire
    };
    v.onseeked = async () => {
      clearTimeout(timer);
      try {
        ok({ nw: v.videoWidth, nh: v.videoHeight, thumb: await drawThumb(v, v.videoWidth, v.videoHeight) });
      } catch (e) {
        ko(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    v.src = url;
  });
}

function drawThumb(source, w, h) {
  const k = Math.min(1, THUMB_SIZE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((ok) => canvas.toBlob(ok, 'image/webp', 0.82));
}
