// Ajoute une icône « RefBoard » sur chaque post du fil (visible au survol), et une icône flottante sur la page d'un post ou d'un reel.
// La récupération des médias se fait ici (même origine qu'Instagram, donc avec ta session).

const igCode = (url) => url.match(IG_POST_RE)?.[1];

function makeButton(getCode, extraClass) {
  return createSendButton(extraClass, async () =>
    chrome.runtime.sendMessage({ type: 'sendMedia', items: await resolveInstagram(getCode()) })
  );
}

function addButtons() {
  if (!chrome.runtime?.id) return observer.disconnect(); // copie périmée après une mise à jour

  // Posts du fil
  for (const article of document.querySelectorAll('article')) {
    if (article.dataset.refboard === REFBOARD_INSTANCE) continue;
    const link = [...article.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')].find((a) => igCode(a.href));
    if (!link) continue;
    article.querySelectorAll('.refboard-btn').forEach((b) => b.remove());
    article.dataset.refboard = REFBOARD_INSTANCE;
    if (getComputedStyle(article).position === 'static') article.style.position = 'relative';
    article.appendChild(makeButton(() => igCode(link.href), 'refboard-in-card'));
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

const observer = new MutationObserver(addButtons);
observer.observe(document.body, { childList: true, subtree: true });
addButtons();
