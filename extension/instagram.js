// Ajoute une icône « RefBoard » sur l'image de chaque post du fil (visible au survol), et une icône flottante sur la page d'un post ou d'un reel.
// La récupération des médias se fait ici (même origine qu'Instagram, donc avec ta session).

const igCode = (url) => url.match(IG_POST_RE)?.[1];

// Code du post d'un article du fil (lien de la date, du post ou du reel).
function articleCode(article) {
  for (const a of article.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]')) {
    const code = igCode(a.href);
    if (code) return code;
  }
}

// Le cadre de l'image ou de la vidéo d'un post : le plus grand bloc qui a encore la hauteur du média.
function mediaBox(article) {
  const media = [...article.querySelectorAll('img, video')].find((m) => m.getBoundingClientRect().width >= 200);
  if (!media) return null;
  const h = media.getBoundingClientRect().height;
  if (h < 100) return null; // pas encore chargé : on réessaiera
  let box = media.parentElement;
  while (box.parentElement && box.parentElement !== article && Math.abs(box.parentElement.getBoundingClientRect().height - h) < 4) {
    box = box.parentElement;
  }
  return box;
}

function makeButton(getCode, extraClass) {
  return createSendButton(extraClass, async () =>
    chrome.runtime.sendMessage({ type: 'sendMedia', items: await resolveInstagram(getCode()) })
  );
}

function addButtons() {
  if (!chrome.runtime?.id) return observer.disconnect(); // copie périmée après une mise à jour

  // Posts du fil
  for (const article of document.querySelectorAll('article')) {
    if (article.querySelector(`.refboard-btn[data-instance="${REFBOARD_INSTANCE}"]`)) continue;
    if (!articleCode(article)) continue;
    const box = mediaBox(article);
    if (!box) continue;
    article.querySelectorAll('.refboard-btn').forEach((b) => b.remove());
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const btn = makeButton(() => articleCode(article), 'refboard-in-card');
    btn.dataset.instance = REFBOARD_INSTANCE;
    box.appendChild(btn);
  }

  // Page d'un post / reel (y compris la fenêtre qui s'ouvre par-dessus le fil)
  let floating = document.getElementById('refboard-page-btn');
  if (floating && floating.dataset.instance !== REFBOARD_INSTANCE) {
    floating.remove();
    floating = null;
  }
  if (igCode(location.href)) {
    if (!floating) {
      floating = makeButton(() => igCode(location.href), 'refboard-page');
      floating.id = 'refboard-page-btn';
      floating.dataset.instance = REFBOARD_INSTANCE;
      document.body.appendChild(floating);
    }
  } else {
    floating?.remove();
  }
}

// Clic droit sur un post du fil : Instagram couvre ses images d'un calque, Chrome ne voit donc que « la page ».
// On retient le post sous la souris pour que le menu « Envoyer cette page » envoie ce post-là.
let clickedPost = null;
document.addEventListener('contextmenu', (e) => {
  const article = e.target.closest?.('article');
  const code = article && articleCode(article);
  clickedPost = code ? `https://www.instagram.com/p/${code}/` : null;
}, true);
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'clickedPost') reply(clickedPost);
});

const observer = new MutationObserver(addButtons);
observer.observe(document.body, { childList: true, subtree: true });
addButtons();
