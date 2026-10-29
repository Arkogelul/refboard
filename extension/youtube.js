// Ajoute une icône flottante « RefBoard » sur la page d'une vidéo ou d'un Short YouTube.
// RefBoard en fait une carte : vignette, lecteur intégré au double-clic et lien vers YouTube.

function addButton() {
  if (!chrome.runtime?.id) return observer.disconnect(); // copie périmée après une mise à jour
  floatingButton(() => (YT_RE.test(location.href) ? location.href : null));
}

const observer = new MutationObserver(addButton);
observer.observe(document.body, { childList: true, subtree: true });
addButton();
