const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const $ = id => document.getElementById(id);

// ── Persist TURN credentials ───────────────────────────────────────────────

$('turn-url').value  = localStorage.getItem('ss-turn-url')  || '';
$('turn-user').value = localStorage.getItem('ss-turn-user') || '';
$('turn-pass').value = localStorage.getItem('ss-turn-pass') || '';

['turn-url', 'turn-user', 'turn-pass'].forEach(id => {
  $(id).addEventListener('input', () => localStorage.setItem('ss-' + id, $(id).value.trim()));
});

function getIceConfig() {
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

// ── Restore state from background on popup open ────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_STATE' }, state => {
  if (state?.screen === 'handshake') {
    $('offer-out').value = state.offer || '';
    showScreen('handshake');
  } else if (state?.screen === 'connected') {
    showScreen('connected');
  }
  // else: default idle screen is already shown
});

// ── Preview video ──────────────────────────────────────────────────────────

$('btn-preview').addEventListener('click', () => {
  const btn = $('btn-preview');
  btn.disabled = true;
  btn.textContent = 'Capturing…';
  $('preview-wrap').style.display = 'none';
  setError('');

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_FRAME' }, resp => {
      btn.disabled = false;
      btn.textContent = 'Preview video';

      if (chrome.runtime.lastError) { setError('Could not reach page. Try refreshing.'); return; }
      if (!resp?.ok)                 { setError(resp?.error || 'No video found.');        return; }
      if (resp.dataUrl) {
        $('preview-img').src = resp.dataUrl;
        $('preview-wrap').style.display = 'block';
      } else {
        setError('Video found but frame blocked (cross-origin canvas taint).');
      }
    });
  });
});

// ── Start sharing ──────────────────────────────────────────────────────────

$('btn-start').addEventListener('click', () => {
  const btn = $('btn-start');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  setError('');

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage(
      { type: 'START_SHARE', tabId: tab.id, iceConfig: getIceConfig() },
      resp => {
        btn.disabled = false;
        btn.textContent = 'Start Sharing';

        if (chrome.runtime.lastError) { setError('Background error: ' + chrome.runtime.lastError.message); return; }
        if (!resp?.ok) { setError(resp?.error || 'Failed to start sharing.'); return; }

        $('offer-out').value = resp.offer;
        showScreen('handshake');
      }
    );
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

  chrome.runtime.sendMessage({ type: 'APPLY_ANSWER', answer }, resp => {
    btn.disabled = false;
    btn.textContent = 'Connect';

    if (chrome.runtime.lastError || !resp?.ok) {
      setError(chrome.runtime.lastError?.message || resp?.error || 'Failed to apply answer.');
      return;
    }
    showScreen('connected');
  });
});

// ── Recapture ──────────────────────────────────────────────────────────────

$('btn-recapture').addEventListener('click', () => {
  const btn = $('btn-recapture');
  btn.disabled = true;
  btn.textContent = 'Capturing…';
  setError('');

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage({ type: 'RECAPTURE', tabId: tab.id }, resp => {
      btn.disabled = false;
      btn.textContent = 'Recapture video';

      if (chrome.runtime.lastError || !resp?.ok) {
        setError(chrome.runtime.lastError?.message || resp?.error || 'Recapture failed.');
      }
    });
  });
});

// ── Stop sharing ───────────────────────────────────────────────────────────

$('btn-stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SHARE' }, () => {
    showScreen('idle');
  });
});
