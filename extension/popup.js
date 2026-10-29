const $ = (id) => document.getElementById(id);

chrome.runtime.sendMessage({ type: 'refboardTab' }, (res) => {
  const board = $('board');
  if (res?.result) board.textContent = `Planche : ${res.result.replace(/\s*·\s*RefBoard\s*$/, '')}`;
  else {
    board.textContent = "RefBoard n'est pas ouvert : il s'ouvrira en arrière-plan à l'envoi";
    board.className = 'none';
  }
});

chrome.storage.local.get('focus', ({ focus = false }) => ($('focus').checked = focus));
$('focus').addEventListener('change', (e) => chrome.storage.local.set({ focus: e.target.checked }));

$('send').addEventListener('click', async () => {
  const urls = $('urls').value.split(/\s+/).filter(Boolean);
  if (!urls.length) return;
  $('send').disabled = true;
  $('status').className = '';
  $('status').textContent = 'Envoi en cours…';
  const res = await chrome.runtime.sendMessage({ type: 'sendPosts', urls });
  $('status').className = res.ok ? '' : 'err';
  $('status').textContent = res.ok ? `✓ ${res.result}` : res.error;
  $('send').disabled = false;
});
