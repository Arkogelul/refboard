// Ajoute une petite icône « RefBoard » dans la barre d'actions des posts X qui contiennent une image ou une vidéo.

function addButtons() {
  if (!chrome.runtime?.id) return observer.disconnect(); // copie périmée après une mise à jour
  for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
    if (article.dataset.refboard === REFBOARD_INSTANCE) continue;
    const hasMedia = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], video');
    const link = article.querySelector('a[href*="/status/"] time')?.closest('a');
    const bar = article.querySelector('[role="group"]');
    if (!hasMedia || !link || !bar) continue;
    article.querySelectorAll('.refboard-btn').forEach((b) => b.remove());
    article.dataset.refboard = REFBOARD_INSTANCE;
    bar.appendChild(createSendButton('refboard-x', () => chrome.runtime.sendMessage({ type: 'sendPost', url: link.href })));
  }
}

const observer = new MutationObserver(addButtons);
observer.observe(document.body, { childList: true, subtree: true });
addButtons();
