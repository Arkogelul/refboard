// Pont entre l'extension et la page RefBoard (messages window.postMessage dans le même onglet) :
// - l'extension → la page : médias à ajouter ;
// - la page → l'extension : liens de posts collés dans RefBoard, à récupérer.

(() => {
  let ready = false;
  const post = (msg) => window.postMessage(msg, location.origin);
  document.documentElement.dataset.refboardExtension = chrome.runtime.getManifest().version;

  function toBlob(base64, type) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  const toPageItem = (it) => (it.data ? { blob: toBlob(it.data, it.type), name: it.name, source: it.source } : it);

  addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.refboard || !chrome.runtime?.id) return;
    if (e.data.refboard === 'ready') ready = true;
    if (e.data.refboard === 'fetch') {
      // La page demande des posts : l'extension les récupère et lui rend les fichiers.
      const id = e.data.id;
      chrome.runtime
        .sendMessage({ type: 'download', urls: e.data.urls })
        .then((res) => {
          if (!res?.ok) return post({ refboard: 'error', id, message: res?.error });
          post({ refboard: 'fetched', id, items: res.result.items.map(toPageItem), note: res.result.note });
        })
        .catch((err) => post({ refboard: 'error', id, message: err.message }));
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'refboard:ping') return reply({ ready });
    if (msg.type !== 'refboard:add') return;
    const id = Math.random().toString(36).slice(2);
    const items = msg.items.map(toPageItem);
    const done = (e) => {
      if (e.source !== window || e.data?.refboard !== 'added' || e.data.id !== id) return;
      removeEventListener('message', done);
      reply({ ok: e.data.ok, error: e.data.error });
    };
    addEventListener('message', done);
    post({ refboard: 'add', id, items });
    return true; // réponse asynchrone
  });

  post({ refboard: 'hello' }); // si la page est déjà prête, elle répond « ready »
})();
