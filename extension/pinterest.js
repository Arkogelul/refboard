// Ajoute une icône « RefBoard » sur chaque épingle de la grille (visible au survol), et une icône flottante sur la page d'une épingle.
// La récupération se fait ici (même domaine que Pinterest, donc avec ta session).

const pinId = (url) => url.match(PIN_RE)?.[1];

function makeButton(getId, extraClass) {
  return createSendButton(extraClass, async () =>
    chrome.runtime.sendMessage({ type: 'sendMedia', items: await resolvePinterest(getId()) })
  );
}

function addButtons() {
  if (!chrome.runtime?.id) return observer.disconnect(); // copie périmée après une mise à jour

  // Épingles de la grille
  for (const card of document.querySelectorAll('[data-grid-item]')) {
    if (card.dataset.refboard === REFBOARD_INSTANCE) continue;
    const link = [...card.querySelectorAll('a[href*="/pin/"]')].find((a) => pinId(a.href));
    if (!link) continue;
    card.querySelectorAll('.refboard-btn').forEach((b) => b.remove());
    card.dataset.refboard = REFBOARD_INSTANCE;
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    card.appendChild(makeButton(() => pinId(link.href), 'refboard-in-card'));
  }

  // Page d'une épingle
  let floating = document.getElementById('refboard-page-btn');
  if (floating && floating.dataset.instance !== REFBOARD_INSTANCE) {
    floating.remove();
    floating = null;
  }
  if (pinId(location.href)) {
    if (!floating) {
      floating = makeButton(() => pinId(location.href), 'refboard-page');
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
