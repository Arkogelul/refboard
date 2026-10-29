importScripts('shared.js');

// Adresses où RefBoard peut être ouvert (la première sert à l'ouvrir s'il ne l'est pas).
const REFBOARD_URL = 'https://arkogelul.github.io/refboard/';
const REFBOARD_TABS = ['https://arkogelul.github.io/refboard/*', 'http://localhost:8791/*'];
const MAX_BYTES = 45 * 1024 * 1024; // au-delà, un message entre onglets devient trop lourd : on garde la vignette

chrome.runtime.onInstalled.addListener(() => {
  reinjectContentScripts();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'media', title: 'Envoyer vers RefBoard', contexts: ['image', 'video'] });
    chrome.contextMenus.create({
      id: 'link', title: 'Envoyer ce post vers RefBoard', contexts: ['link'], targetUrlPatterns: POST_PATTERNS,
    });
    chrome.contextMenus.create({ id: 'page', title: 'Envoyer cette page vers RefBoard', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
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
    if (msg.type === 'refboardTab') return (await findRefBoardTab())?.title || null;
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

async function download(url, kind, referer) {
  const r = await withReferer(url, referer, () => fetch(url));
  if (!r.ok) throw new Error(`Téléchargement impossible (${r.status})`);
  const blob = await r.blob();
  if (blob.size > MAX_BYTES) throw new Error('Fichier trop lourd');
  let type = (blob.type || '').split(';')[0];
  if (!EXT[type]) type = kind === 'video' ? 'video/mp4' : 'image/jpeg';
  return { type, data: await blobToBase64(blob) };
}

async function sendToRefBoard(items, sourceTab) {
  if (!items?.length) throw new Error('Aucun média à envoyer');
  const tab = await refBoardTab();
  const payload = [];
  let thumbsOnly = 0;
  for (const it of items) {
    if (it.kind === 'youtube') {
      payload.push(it);
      continue;
    }
    if (it.kind === 'video') toast(sourceTab, 'Téléchargement de la vidéo…', true);
    try {
      const f = await download(it.url, it.kind, it.referer);
      payload.push({ name: `${it.name}.${EXT[f.type]}`, type: f.type, data: f.data, source: it.source });
    } catch (e) {
      // Vidéo impossible à récupérer : on garde au moins sa vignette et le lien.
      if (!it.thumb) throw e;
      const f = await download(it.thumb, 'image', it.referer);
      payload.push({ name: `${it.name}_vignette.${EXT[f.type]}`, type: f.type, data: f.data, source: it.source });
      thumbsOnly++;
    }
  }
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'refboard:add', items: payload });
  if (!res?.ok) throw new Error(res?.error || "RefBoard n'a pas pu ajouter les médias");

  const { focus = false } = await chrome.storage.local.get('focus');
  if (focus) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  const n = payload.length;
  let msg = `${n} média${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''} vers RefBoard`;
  if (thumbsOnly) msg += ` (vignette et lien seulement pour ${thumbsOnly} vidéo${thumbsOnly > 1 ? 's' : ''})`;
  return msg;
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
