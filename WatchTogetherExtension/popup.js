const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

// ── Persist credentials across popup opens ─────────────────────────────────

const $ = id => document.getElementById(id);

$('turn-url').value  = localStorage.getItem('ss-turn-url')  || '';
$('turn-user').value = localStorage.getItem('ss-turn-user') || '';
$('turn-pass').value = localStorage.getItem('ss-turn-pass') || '';

function saveCredentials() {
  localStorage.setItem('ss-turn-url',  $('turn-url').value.trim());
  localStorage.setItem('ss-turn-user', $('turn-user').value.trim());
  localStorage.setItem('ss-turn-pass', $('turn-pass').value.trim());
}

function getIceConfig() {
  saveCredentials();
  const url  = $('turn-url').value.trim();
  const user = $('turn-user').value.trim();
  const pass = $('turn-pass').value.trim();
  const servers = [{ urls: STUN }];
  if (url && user && pass) servers.push({ urls: url, username: user, credential: pass });
  return { iceServers: servers };
}

// ── Screen management ──────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('[data-screen]').forEach(el => {
    el.style.display = el.dataset.screen === name ? '' : 'none';
  });
  setError('');
}

function setError(msg) {
  $('error-msg').textContent = msg;
  $('error-msg').classList.toggle('visible', !!msg);
}

// ── Restore state on popup open ────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.tabs.sendMessage(tab.id, { type: 'GET_SHARE_STATE' }, resp => {
    if (chrome.runtime.lastError || !resp) return; // page not injectable
    if (resp.active) {
      const savedOffer = localStorage.getItem('ss-offer');
      if (savedOffer) {
        $('offer-out').value = savedOffer;
        showScreen('handshake');
      } else {
        showScreen('connected');
      }
    }
  });
});

// ── Start sharing ──────────────────────────────────────────────────────────

$('btn-start').addEventListener('click', () => {
  const btn = $('btn-start');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  setError('');

  const iceConfig = getIceConfig();

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: 'START_SHARE', iceConfig }, resp => {
      btn.disabled = false;
      btn.textContent = 'Start Sharing';

      if (chrome.runtime.lastError) {
        setError('Could not reach page. Try refreshing.');
        return;
      }
      if (!resp?.ok) {
        setError(resp?.error || 'Failed to start sharing.');
        return;
      }

      localStorage.setItem('ss-offer', resp.offer);
      $('offer-out').value = resp.offer;
      showScreen('handshake');
    });
  });
});

// ── Copy offer code ────────────────────────────────────────────────────────

$('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('offer-out').value).then(() => {
    $('btn-copy').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy').textContent = 'Copy code'; }, 1500);
  });
});

// ── Apply answer ───────────────────────────────────────────────────────────

$('btn-apply').addEventListener('click', () => {
  const answer = $('answer-in').value.trim();
  if (!answer) { setError('Paste the answer code first.'); return; }

  const btn = $('btn-apply');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  setError('');

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: 'APPLY_ANSWER', answer }, resp => {
      btn.disabled = false;
      btn.textContent = 'Connect';

      if (chrome.runtime.lastError || !resp?.ok) {
        setError(chrome.runtime.lastError?.message || resp?.error || 'Failed to apply answer.');
        return;
      }

      localStorage.removeItem('ss-offer');
      showScreen('connected');
    });
  });
});

// ── Stop sharing ───────────────────────────────────────────────────────────

$('btn-stop').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP_SHARE' }, () => {
      localStorage.removeItem('ss-offer');
      showScreen('idle');
    });
  });
});
