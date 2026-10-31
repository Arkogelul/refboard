// Accès à Google Drive : connexion (Google Identity Services) et appels à l'API Drive v3.
// Les médias vont dans l'espace privé de l'app (drive.appdata) : il compte dans ton stockage Drive,
// mais n'est jamais recopié sur ton PC par Google Drive pour ordinateur.
// drive.file sert seulement à reprendre l'ancien dossier visible « RefBoard ». L'app ne voit rien d'autre de ton Drive.

const Drive = (() => {
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const SCOPES = ['https://www.googleapis.com/auth/drive.appdata', 'https://www.googleapis.com/auth/drive.file'];
  const FOLDER = 'application/vnd.google-apps.folder';
  const SMALL = 5 * 1024 * 1024; // au-delà : envoi « reprenable », adapté aux grosses vidéos

  // Le jeton d'accès dure une heure ; on le garde pour ne pas se reconnecter à chaque rechargement.
  // Quand il expire, l'extension « Vers RefBoard » en redemande un sans aucune fenêtre (voir refresh).
  let auth = readJSON('refboard.auth');
  let tokenClient = null;
  let account = localStorage.getItem('refboard.account') || ''; // adresse du compte : évite le choix du compte
  let refreshing = null;

  class AuthNeeded extends Error {}

  const hasToken = () => !!auth.token && Date.now() < auth.exp - 60_000 && SCOPES.every((s) => auth.scope?.includes(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function gisReady() {
    for (let i = 0; i < 100 && !window.google?.accounts?.oauth2; i++) await sleep(100);
    if (!window.google?.accounts?.oauth2) throw new Error('Impossible de charger la connexion Google (bloqueur de publicité ?)');
  }

  // Ouvre la petite fenêtre Google : doit être appelé suite à un clic.
  async function signIn() {
    if (!CONFIG.googleClientId) throw new Error('Identifiant client Google manquant : renseigne-le dans js/config.js (voir GUIDE-GOOGLE.md)');
    await gisReady();
    return new Promise((ok, ko) => {
      tokenClient ??= google.accounts.oauth2.initTokenClient({ client_id: CONFIG.googleClientId, scope: SCOPES.join(' '), callback: () => {} });
      tokenClient.callback = (r) => {
        if (r.error) return ko(new Error(r.error_description || r.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES))
          return ko(new AuthNeeded('Coche les deux autorisations demandées par Google pour que RefBoard puisse enregistrer tes médias'));
        auth = { token: r.access_token, exp: Date.now() + r.expires_in * 1000, scope: r.scope };
        remember('refboard.auth', auth);
        ok();
      };
      tokenClient.error_callback = (e) =>
        ko(new AuthNeeded(e.type === 'popup_closed' ? 'Connexion annulée' : 'Fenêtre de connexion Google bloquée'));
      tokenClient.requestAccessToken({ prompt: '', login_hint: account || undefined });
    });
  }

  // Demande un nouveau jeton à l'extension, sans fenêtre ni clic. Renvoie true si on en a obtenu un.
  function refresh() {
    refreshing ??= silentToken().finally(() => (refreshing = null));
    return refreshing;
  }

  async function silentToken() {
    // Le script de l'extension peut se charger un peu après la page.
    for (let i = 0; i < 15 && !document.documentElement.dataset.refboardExtension; i++) await sleep(100);
    if (parseFloat(document.documentElement.dataset.refboardExtension) < 2.2 || !document.documentElement.dataset.refboardExtension) return false;
    const id = Math.random().toString(36).slice(2);
    const r = await new Promise((ok) => {
      const timer = setTimeout(() => done(), 15000);
      const done = (res) => {
        clearTimeout(timer);
        removeEventListener('message', listen);
        ok(res);
      };
      const listen = (e) => {
        if (e.source === window && e.data?.refboard === 'token-result' && e.data.id === id) done(e.data);
      };
      addEventListener('message', listen);
      window.postMessage({ refboard: 'token', id, hint: account }, location.origin);
    });
    if (!r?.token || !SCOPES.every((s) => r.scope?.includes(s))) return false;
    auth = { token: r.token, exp: Date.now() + r.expiresIn * 1000, scope: r.scope };
    remember('refboard.auth', auth);
    return true;
  }

  // Mémorise le compte connecté, pour ne plus avoir à le choisir (utile si plusieurs comptes Google sont ouverts).
  async function rememberAccount() {
    const j = await (await request('/about?fields=user(emailAddress)')).json();
    account = j.user?.emailAddress || '';
    if (account) localStorage.setItem('refboard.account', account);
  }

  function signOut() {
    if (auth.token) window.google?.accounts?.oauth2?.revoke(auth.token, () => {});
    auth = {};
    remember('refboard.auth', auth);
    account = '';
    localStorage.removeItem('refboard.account');
  }

  // Appel authentifié, avec nouvelles tentatives si Google est surchargé.
  async function request(url, opts = {}, attempt = 0) {
    if (!hasToken() && !(await refresh())) throw new AuthNeeded('Reconnexion à Google Drive nécessaire');
    const r = await fetch(url.startsWith('http') ? url : API + url, {
      ...opts,
      headers: { ...opts.headers, Authorization: `Bearer ${auth.token}` },
    });
    const insufficient =
      r.status === 403 && /insufficient|scope/i.test(JSON.stringify(await r.clone().json().catch(() => ({}))));
    if (r.status === 401 || insufficient) {
      auth = {};
      remember('refboard.auth', auth);
      if (!opts.retried && (await refresh())) return request(url, { ...opts, retried: true }, attempt);
      throw new AuthNeeded('Session Google expirée');
    }
    const rateLimited =
      r.status === 429 ||
      (r.status === 403 && /rate/i.test((await r.clone().json().catch(() => ({}))).error?.errors?.[0]?.reason || ''));
    if ((rateLimited || r.status >= 500) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return request(url, opts, attempt + 1);
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`Google Drive : ${j.error?.message || `erreur ${r.status}`}`);
    }
    return r;
  }

  const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // space : 'appDataFolder' (espace privé de l'app) ou 'drive' (Mon Drive).
  async function list(q, fields = 'id,name', space = 'appDataFolder') {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces: space });
      if (pageToken) params.set('pageToken', pageToken);
      const j = await (await request(`/files?${params}`)).json();
      out.push(...j.files);
      pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }

  const get = async (id, fields) => (await request(`/files/${id}?fields=${fields}`)).json();
  const download = async (id) => (await request(`/files/${id}?alt=media`)).blob();
  const trash = (id) => request(`/files/${id}`, { ...json({ trashed: true }), method: 'PATCH' });
  const remove = (id) => request(`/files/${id}`, { method: 'DELETE' }); // l'espace privé n'a pas de corbeille

  // Ancien dossier visible « RefBoard » à la racine de Mon Drive (versions précédentes de l'app).
  const legacyFolders = () =>
    list(`name='RefBoard' and mimeType='${FOLDER}' and 'root' in parents and trashed=false`, 'id,name', 'drive');

  // Crée un fichier. Renvoie {id, version}.
  async function upload(blob, meta) {
    meta = { mimeType: blob.type, ...meta };
    if (blob.size > SMALL) {
      const init = await request(`${UPLOAD}/files?uploadType=resumable`, {
        ...json(meta),
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type },
      });
      const session = init.headers.get('Location');
      return (await request(session, { method: 'PUT', body: blob })).json();
    }
    const boundary = `refboard-${Date.now().toString(36)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type}\r\n\r\n`, blob, `\r\n--${boundary}--`,
    ]);
    const r = await request(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    return r.json();
  }

  // Remplace le contenu d'un fichier existant. Renvoie {id, version}.
  async function update(id, blob) {
    const r = await request(`${UPLOAD}/files/${id}?uploadType=media&fields=id,version`, {
      method: 'PATCH', headers: { 'Content-Type': blob.type }, body: blob,
    });
    return r.json();
  }

  return { AuthNeeded, hasToken, signIn, signOut, refresh, rememberAccount, list, get, download, trash, remove, legacyFolders, upload, update };
})();
