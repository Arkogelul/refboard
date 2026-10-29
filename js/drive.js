// Accès à Google Drive : connexion (Google Identity Services) et appels à l'API Drive v3.
// Scope drive.file : l'app ne voit que les fichiers qu'elle a créés elle-même, rien d'autre de ton Drive.

const Drive = (() => {
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER = 'application/vnd.google-apps.folder';
  const SMALL = 5 * 1024 * 1024; // au-delà : envoi « reprenable », adapté aux grosses vidéos

  // Le jeton d'accès dure une heure ; on le garde pour ne pas se reconnecter à chaque rechargement.
  let auth = readJSON('refboard.auth');
  let tokenClient = null;

  class AuthNeeded extends Error {}

  const hasToken = () => !!auth.token && Date.now() < auth.exp - 60_000;
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
      tokenClient ??= google.accounts.oauth2.initTokenClient({ client_id: CONFIG.googleClientId, scope: SCOPE, callback: () => {} });
      tokenClient.callback = (r) => {
        if (r.error) return ko(new Error(r.error_description || r.error));
        auth = { token: r.access_token, exp: Date.now() + r.expires_in * 1000 };
        remember('refboard.auth', auth);
        ok();
      };
      tokenClient.error_callback = (e) =>
        ko(new AuthNeeded(e.type === 'popup_closed' ? 'Connexion annulée' : 'Fenêtre de connexion Google bloquée'));
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  function signOut() {
    if (auth.token) window.google?.accounts?.oauth2?.revoke(auth.token, () => {});
    auth = {};
    remember('refboard.auth', auth);
  }

  // Appel authentifié, avec nouvelles tentatives si Google est surchargé.
  async function request(url, opts = {}, attempt = 0) {
    if (!hasToken()) throw new AuthNeeded('Reconnexion à Google Drive nécessaire');
    const r = await fetch(url.startsWith('http') ? url : API + url, {
      ...opts,
      headers: { ...opts.headers, Authorization: `Bearer ${auth.token}` },
    });
    if (r.status === 401) {
      auth = {};
      remember('refboard.auth', auth);
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

  async function list(q, fields = 'id,name') {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces: 'drive' });
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

  async function findOrCreateFolder(name, parent) {
    const found = await list(`name='${name}' and mimeType='${FOLDER}' and '${parent}' in parents and trashed=false`);
    if (found.length) return found[0].id;
    return (await (await request('/files?fields=id', json({ name, mimeType: FOLDER, parents: [parent] }))).json()).id;
  }

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

  return { AuthNeeded, hasToken, signIn, signOut, list, get, download, trash, findOrCreateFolder, upload, update };
})();
