// Code partagé : chargé dans le service worker (importScripts) et dans les scripts des réseaux sociaux.
// Chaque « résolveur » transforme le lien d'un post en liste de médias :
//   { url, kind: 'image' | 'video', name, source, thumb? }  ou  { kind: 'youtube', id, short, source }

const X_POST_RE = /(?:x|twitter)\.com\/[^/?#]+\/status\/(\d+)/;
const IG_POST_RE = /instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;
const PIN_RE = /pinterest\.[a-z.]+\/pin\/(?:[^/?#]*--)?(\d+)/;
const PIN_SHORT_RE = /^https?:\/\/pin\.it\//;
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;
const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// ---------- X ----------

// Médias d'un post X via les API publiques fxtwitter / vxtwitter (X n'expose pas les .mp4 dans la page).
async function resolveX(id) {
  for (const api of [`https://api.fxtwitter.com/status/${id}`, `https://api.vxtwitter.com/status/${id}`]) {
    try {
      const r = await fetch(api);
      if (!r.ok) continue;
      const j = await r.json();
      const list = j.tweet?.media?.all || j.media_extended || [];
      const out = list.map((m, i) => {
        const isVideo = m.type === 'video' || m.type === 'gif';
        return {
          url: isVideo ? bestVariant(m) : upgradeTwimg(m.url),
          kind: isVideo ? 'video' : 'image',
          thumb: isVideo ? m.thumbnail_url : undefined,
          name: `x_${id}_${i + 1}`,
          source: `https://x.com/i/status/${id}`,
        };
      });
      if (out.length) return out;
    } catch (e) {}
  }
  throw new Error('Aucun média trouvé dans ce post X');
}

// Le MP4 de meilleure qualité parmi les versions proposées.
function bestVariant(m) {
  const mp4 = (m.variants || m.formats || []).filter((v) => /mp4/.test(v.content_type || v.container || v.url));
  mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4[0]?.url || m.url;
}

// Version pleine résolution d'une image X, en gardant ?format=jpg (sans lui, X répond 404).
function upgradeTwimg(url) {
  if (!url.includes('pbs.twimg.com/media/')) return url;
  const u = new URL(url);
  u.searchParams.set('name', 'orig');
  return u.toString();
}

// ---------- Instagram ----------

function igShortcodeToId(code) {
  let id = 0n;
  for (const c of code.slice(0, 11)) id = id * 64n + BigInt(IG_ALPHABET.indexOf(c));
  return id.toString();
}

// Médias d'un post Instagram (nécessite d'être connecté à Instagram dans Chrome).
async function resolveInstagram(code) {
  const r = await fetch(`https://www.instagram.com/api/v1/media/${igShortcodeToId(code)}/info/`, {
    credentials: 'include',
    headers: { 'X-IG-App-ID': '936619743392459' },
  });
  if (!r.ok) throw new Error(`Instagram a répondu ${r.status} — es-tu connecté à Instagram ?`);
  const item = (await r.json()).items?.[0];
  if (!item) throw new Error('Post Instagram introuvable');
  const source = `https://www.instagram.com/p/${code}/`;
  return (item.carousel_media || [item])
    .map((n, i) => {
      const video = n.video_versions?.[0]?.url;
      const image = n.image_versions2?.candidates?.[0]?.url;
      const name = `instagram_${code}_${i + 1}`;
      return video ? { url: video, kind: 'video', thumb: image, name, source } : { url: image, kind: 'image', name, source };
    })
    .filter((m) => m.url);
}

// ---------- Pinterest ----------

// Médias d'une épingle, via l'API interne du site Pinterest (avec ta session).
// Depuis une page Pinterest, on interroge le même domaine qu'elle (fr.pinterest.com…), sinon www.
async function resolvePinterest(id) {
  const base = /(^|\.)pinterest\./.test(location.hostname) ? location.origin : 'https://www.pinterest.com';
  const data = JSON.stringify({ options: { id, field_set_key: 'detailed' }, context: {} });
  const r = await fetch(
    `${base}/resource/PinResource/get/?source_url=${encodeURIComponent(`/pin/${id}/`)}&data=${encodeURIComponent(data)}`,
    { credentials: 'include', headers: { 'X-Pinterest-PWS-Handler': 'www/pin/[id].js', Accept: 'application/json' } }
  );
  if (!r.ok) throw new Error(`Pinterest a répondu ${r.status}`);
  const pin = (await r.json()).resource_response?.data;
  if (!pin) throw new Error('Épingle introuvable');
  const source = `https://www.pinterest.com/pin/${id}/`;
  const image = pin.images?.orig?.url;
  const out = [];
  const add = (m) => out.push({ ...m, name: `pinterest_${id}_${out.length + 1}`, source });

  const video = pinVideo(pin.videos);
  if (video) add({ url: video, kind: 'video', thumb: image });
  for (const page of video ? [] : pin.story_pin_data?.pages || []) {
    for (const block of page.blocks || []) {
      const v = pinVideo(block.video);
      const img = block.image?.images?.originals?.url || block.image?.images?.['736x']?.url;
      if (v) add({ url: v, kind: 'video', thumb: img || image });
      else if (img) add({ url: img, kind: 'image' });
    }
  }
  if (!out.length) for (const slot of pin.carousel_data?.carousel_slots || []) {
    const img = slot.images?.orig?.url || slot.images?.['736x']?.url;
    if (img) add({ url: img, kind: 'image' });
  }
  if (!out.length && image) add({ url: image, kind: 'image' });
  if (!out.length) throw new Error('Aucun média trouvé dans cette épingle');
  return out;
}

// Le MP4 d'une vidéo Pinterest. Les vidéos en streaming (.m3u8) ont un MP4 720p « jumeau ».
function pinVideo(videos) {
  const list = Object.values(videos?.video_list || {});
  const mp4 = list.filter((v) => /\.mp4/.test(v.url)).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  if (mp4) return mp4.url;
  const hls = list.find((v) => /\/hls\/.*\.m3u8/.test(v.url));
  return hls ? hls.url.replace('/hls/', '/720p/').replace('.m3u8', '.mp4') : null;
}

// Image Pinterest en taille d'origine (les miniatures du fil sont en /236x/, /474x/…).
function upgradePinimg(url) {
  return url.includes('i.pinimg.com/') ? url.replace(/i\.pinimg\.com\/\d+x\d*\//, 'i.pinimg.com/originals/') : url;
}

// ---------- YouTube ----------

// YouTube ne se télécharge pas : RefBoard en fait une carte (vignette + lecteur intégré).
function resolveYouTube(url) {
  const id = url.match(YT_RE)[1];
  const short = /\/shorts\//.test(url);
  const source = short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
  return [{ kind: 'youtube', id, short, source }];
}

// ---------- Aiguillage ----------

const POST_PATTERNS = [
  'https://x.com/*/status/*',
  'https://twitter.com/*/status/*',
  'https://www.instagram.com/*p/*',
  'https://www.instagram.com/*reel/*',
  'https://*.pinterest.com/pin/*',
  'https://*.pinterest.fr/pin/*',
  'https://pin.it/*',
  'https://www.youtube.com/watch*',
  'https://www.youtube.com/shorts/*',
  'https://youtu.be/*',
];

async function resolvePost(url) {
  if (PIN_SHORT_RE.test(url)) url = (await fetch(url)).url; // lien court pin.it → vraie adresse
  let m;
  if ((m = url.match(X_POST_RE))) return resolveX(m[1]);
  if ((m = url.match(IG_POST_RE))) return resolveInstagram(m[1]);
  if ((m = url.match(PIN_RE))) return resolvePinterest(m[1]).catch(() => resolvePage(url));
  if (YT_RE.test(url)) return resolveYouTube(url);
  return resolvePage(url);
}

// N'importe quelle autre page : l'image d'aperçu (og:image), avec le lien de la page.
async function resolvePage(url) {
  const html = await (await fetch(url)).text();
  const meta = (p) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)`, 'i'))?.[1] ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))?.[1];
  const video = meta('og:video:secure_url') || meta('og:video');
  const image = meta('og:image') || meta('twitter:image');
  const decode = (s) => s && new URL(s.replace(/&amp;/g, '&'), url).toString();
  if (video && /\.(mp4|webm)(\?|$)/i.test(video)) return [{ url: decode(video), kind: 'video', thumb: decode(image), name: 'video', source: url }];
  if (image) return [{ url: decode(image), kind: 'image', name: 'image', source: url }];
  throw new Error("Aucune image trouvée sur cette page");
}

// ---------- Interface dans les pages ----------

// Petit message en bas de l'écran (utilisable via chrome.scripting.executeScript).
function showToast(message, ok) {
  const t = document.createElement('div');
  t.textContent = message;
  t.style.cssText =
    'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;' +
    'padding:10px 16px;border-radius:10px;font:600 14px system-ui,sans-serif;color:#fff;max-width:80vw;' +
    `box-shadow:0 4px 16px rgba(0,0,0,.25);background:${ok ? '#4c6ef5' : '#d93025'}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// Identifiant de cette copie du script : après une mise à jour, la nouvelle copie remplace les icônes de l'ancienne.
const REFBOARD_INSTANCE = Math.random().toString(36).slice(2);

const SEND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 16V8M8.5 11.5 12 8l3.5 3.5"/></svg>';

// Bouton « envoyer vers RefBoard ». run() renvoie { ok, result | error } ;
// l'icône clignote pendant l'envoi puis devient verte (ou rouge) un instant.
function createSendButton(extraClass, run) {
  const btn = document.createElement('button');
  btn.className = `refboard-btn ${extraClass}`;
  btn.innerHTML = SEND_ICON;
  btn.title = 'Envoyer vers RefBoard';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    let res;
    try {
      // Après une mise à jour de l'extension, l'ancienne copie présente dans la page est déconnectée.
      if (!chrome.runtime?.id) throw new Error("L'extension a été mise à jour : recharge la page (F5)");
      res = await run();
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    btn.classList.remove('busy');
    btn.classList.add(res.ok ? 'done' : 'failed');
    setTimeout(() => btn.classList.remove('done', 'failed'), 3000);
    showToast(res.ok ? res.result : res.error, res.ok);
  });
  return btn;
}

// Bouton flottant en haut à droite, présent seulement sur la page d'un post.
function floatingButton(getUrl) {
  let btn = document.getElementById('refboard-page-btn');
  if (btn && btn.dataset.instance !== REFBOARD_INSTANCE) {
    btn.remove();
    btn = null;
  }
  const url = getUrl();
  if (!url) return btn?.remove();
  if (btn) return;
  btn = createSendButton('refboard-page', () => chrome.runtime.sendMessage({ type: 'sendPost', url: getUrl() }));
  btn.id = 'refboard-page-btn';
  btn.dataset.instance = REFBOARD_INSTANCE;
  document.body.appendChild(btn);
}
