importScripts('shared.js');

// Adresses où RefBoard peut être ouvert (la première sert à l'ouvrir s'il ne l'est pas).
const REFBOARD_URL = 'https://arkogelul.github.io/refboard/';
const REFBOARD_TABS = ['https://arkogelul.github.io/refboard/*', 'http://localhost:8791/*'];
const MAX_BYTES = 45 * 1024 * 1024; // au-delà, un message entre onglets devient trop lourd : on garde la vignette
const GOOGLE_CLIENT_ID = '673906783098-hi1r99h34cnrlfrf4d7si4mirjtv8eg9.apps.googleusercontent.com'; // le même que js/config.js
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';

chrome.runtime.onInstalled.addListener(() => {
  reinjectContentScripts();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'media', title: 'Envoyer vers RefBoard', contexts: ['image', 'video'] });
    chrome.contextMenus.create({
      id: 'link', title: 'Envoyer ce post vers RefBoard', contexts: ['link'], targetUrlPatterns: POST_PATTERNS,
    });
    chrome.contextMenus.create({ id: 'page', title: 'Envoyer cette page vers RefBoard', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'links', title: 'Envoyer une liste de liens…', contexts: ['action'] });
  });
});

// Clic sur l'icône de l'extension : on revient sur l'onglet RefBoard, ou on l'ouvre s'il n'y en a pas.
chrome.action.onClicked.addListener(async () => {
  const tab = await findRefBoardTab();
  if (!tab) return chrome.tabs.create({ url: REFBOARD_URL });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'links') return chrome.windows.create({ url: 'popup.html', type: 'popup', width: 370, height: 430 });
  try {
    let items;
    if (info.menuItemId === 'media' && !info.srcUrl.startsWith('blob:')) {
      // Si l'image est un lien vers un fichier image (souvent la version originale, ex. pixiv), on prend celui-là.
      const src = info.linkUrl && IMAGE_FILE_RE.test(info.linkUrl) ? info.linkUrl : info.srcUrl;
      items = [{
        url: upgradePinimg(upgradeTwimg(src)), kind: info.mediaType === 'video' ? 'video' : 'image',
        name: 'media', referer: info.pageUrl, source: info.pageUrl,
      }];
    } else {
      // Vidéo en streaming (blob:), post d'un réseau social, ou page entière : on passe par le post.
      items = await resolvePost(info.linkUrl || info.pageUrl);
    }
    toast(tab, await sendToRefBoard(items, tab), true);
  } catch (e) {
    toast(tab, e.message, false);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'sendPost') return sendToRefBoard(await resolvePost(msg.url), sender.tab);
    if (msg.type === 'sendMedia') return sendToRefBoard(msg.items, sender.tab);
    if (msg.type === 'sendPosts') {
      // Depuis la fenêtre de l'extension, ou un lien collé dans RefBoard.
      const all = [];
      const errors = [];
      for (const url of msg.urls) {
        try {
          all.push(...(await resolvePost(url)));
        } catch (e) {
          errors.push(`${url} : ${e.message}`);
        }
      }
      if (!all.length) throw new Error(errors[0] || 'Aucun média trouvé');
      const result = await sendToRefBoard(all);
      return errors.length ? `${result} — ${errors.length} lien(s) en échec` : result;
    }
    if (msg.type === 'googleToken') {
      const fromRefBoard = sender.origin === new URL(REFBOARD_URL).origin || sender.origin === 'http://localhost:8791';
      if (!fromRefBoard) throw new Error('Réservé à RefBoard');
      return googleToken(msg.hint);
    }
    if (msg.type === 'refboardTab') return (await findRefBoardTab())?.title || null;
    if (msg.type === 'download') {
      // Demandé par la page RefBoard elle-même : on lui rend les fichiers au lieu de les envoyer à un onglet.
      const all = [];
      for (const url of msg.urls) all.push(...(await resolvePost(url)));
      return prepare(all);
    }
  })().then(
    (result) => reply({ ok: true, result }),
    (e) => reply({ ok: false, error: e.message })
  );
  return true;
});

// Après installation ou mise à jour, on remet les scripts dans les onglets déjà ouverts (sans F5).
async function reinjectContentScripts() {
  for (const cs of chrome.runtime.getManifest().content_scripts) {
    for (const tab of await chrome.tabs.query({ url: cs.matches })) {
      const target = { tabId: tab.id };
      if (cs.css) chrome.scripting.insertCSS({ target, files: cs.css }).catch(() => {});
      chrome.scripting.executeScript({ target, files: cs.js }).catch(() => {});
    }
  }
}

function toast(tab, message, ok) {
  if (!tab?.id) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showToast, args: [message, ok] }).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nouveau jeton Google sans aucune fenêtre, tant que le navigateur est connecté au compte et que RefBoard est autorisé.
async function googleToken(hint) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, response_type: 'token', scope: GOOGLE_SCOPES, prompt: 'none',
    redirect_uri: chrome.identity.getRedirectURL(),
  });
  if (hint) params.set('login_hint', hint);
  const url = await chrome.identity.launchWebAuthFlow({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10000,
  });
  const r = new URLSearchParams(new URL(url).hash.slice(1));
  if (!r.get('access_token')) throw new Error(r.get('error') || 'Pas de jeton Google');
  return { token: r.get('access_token'), expiresIn: +r.get('expires_in'), scope: r.get('scope') };
}

async function findRefBoardTab() {
  const tabs = await chrome.tabs.query({ url: REFBOARD_TABS });
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

// Onglet RefBoard prêt à recevoir : on l'ouvre en arrière-plan s'il ne l'est pas, puis on attend qu'il réponde.
// Un onglet ouvert avant une mise à jour de RefBoard ne sait pas répondre : on le recharge une fois.
async function refBoardTab() {
  const tab = (await findRefBoardTab()) || (await chrome.tabs.create({ url: REFBOARD_URL, active: false }));
  for (let i = 0; i < 60; i++) {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'refboard:ping' }).catch(() => null);
    if (r?.ready) return tab;
    if (i === 6) await chrome.tabs.reload(tab.id);
    await sleep(500);
  }
  throw new Error("RefBoard ne répond pas : recharge son onglet et réessaie");
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };

// Une page de protection (Cloudflare…) peut répondre en HTML à la place du fichier.
const isFile = (r) => r.ok && !(r.headers.get('content-type') || '').startsWith('text/html');

async function download(url, kind, referer, tab) {
  let f = null;
  let status = 0;
  // D'abord sans cookies, puis avec ceux du navigateur (sites qui exigent une session ou une vérification déjà passée).
  for (const credentials of ['same-origin', 'include']) {
    const r = await withReferer(url, referer, () => fetch(url, { credentials })).catch(() => null);
    if (r && isFile(r)) {
      const blob = await r.blob();
      if (blob.size > MAX_BYTES) throw new Error('Fichier trop lourd');
      f = { type: (blob.type || '').split(';')[0], data: await blobToBase64(blob) };
      break;
    }
    status = r?.status || status;
  }
  // En dernier recours, depuis l'onglet où le média est affiché : c'est là que le site reconnaît le navigateur.
  if (!f && tab?.id) f = await fetchFromTab(url, tab).catch(() => null);
  if (!f) {
    const why = status ? ` (${status})` : '';
    throw new Error(`Téléchargement impossible${why} : ouvre le média dans son propre onglet et réessaie, ou enregistre-le et glisse-le dans RefBoard`);
  }
  if (!EXT[f.type]) f.type = kind === 'video' ? 'video/mp4' : 'image/jpeg';
  return f;
}

async function fetchFromTab(url, tab) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fetchInPage, args: [url, MAX_BYTES] });
  return result;
}

// Exécutée dans l'onglet : ne peut rien utiliser de ce fichier.
async function fetchInPage(url, maxBytes) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok || (r.headers.get('content-type') || '').startsWith('text/html')) return null;
  const blob = await r.blob();
  if (blob.size > maxBytes) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { type: (blob.type || '').split(';')[0], data: btoa(s) };
}

async function sendToRefBoard(items, sourceTab) {
  if (!items?.length) throw new Error('Aucun média à envoyer');
  const tab = await refBoardTab();
  const { items: payload, note } = await prepare(items, sourceTab);
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'refboard:add', items: payload });
  if (!res?.ok) throw new Error(res?.error || "RefBoard n'a pas pu ajouter les médias");

  const { focus = false } = await chrome.storage.local.get('focus');
  if (focus) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  const n = payload.length;
  return `${n} média${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''} vers RefBoard${note ? ` (${note})` : ''}`;
}

// Télécharge les médias (en base64, pour traverser les messages de l'extension).
// Une vidéo impossible à récupérer est remplacée par sa vignette, avec le lien.
async function prepare(items, sourceTab) {
  if (!items?.length) throw new Error('Aucun média trouvé');
  const payload = [];
  let thumbsOnly = 0;
  for (const it of items) {
    if (it.kind === 'youtube') {
      payload.push(it);
      continue;
    }
    if (it.kind === 'video') toast(sourceTab, 'Téléchargement de la vidéo…', true);
    try {
      const f = await download(it.url, it.kind, it.referer, sourceTab);
      payload.push({ name: `${it.name}.${EXT[f.type]}`, type: f.type, data: f.data, source: it.source });
    } catch (e) {
      // Vidéo impossible à récupérer : on garde au moins sa vignette et le lien.
      if (!it.thumb) throw e;
      const f = await download(it.thumb, 'image', it.referer, sourceTab);
      payload.push({ name: `${it.name}_vignette.${EXT[f.type]}`, type: f.type, data: f.data, source: it.source });
      thumbsOnly++;
    }
  }
  const note = thumbsOnly ? `vignette et lien seulement pour ${thumbsOnly} vidéo${thumbsOnly > 1 ? 's' : ''}` : '';
  return { items: payload, note };
}

const IMAGE_FILE_RE = /\.(jpe?g|png|gif|webp)(\?|$)/i;

// Certains sites (pixiv…) refusent leurs images sans le Referer de leur page : on l'ajoute le temps du téléchargement.
// tabIds: [-1] = seulement les requêtes de l'extension, pas celles des onglets.
async function withReferer(url, referer, run) {
  if (!referer?.startsWith('http')) return run();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
      condition: { requestDomains: [new URL(url).hostname], tabIds: [-1] },
    }],
  });
  try {
    return await run();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
  }
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
