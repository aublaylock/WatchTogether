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

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Restore state from background on popup open ────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_STATE' }, state => {
  if (state?.screen === 'handshake') {
    $('offer-out').value = state.offer || '';
    showScreen('handshake');
  } else if (state?.screen === 'connected') {
    showScreen('connected');
  } else if (state?.screen === 'viewer-handshake') {
    $('viewer-answer-out').value = state.answer || '';
    if (state.syncUrl) showUrlHint(state.syncUrl, state.syncTime);
    showScreen('viewer-handshake');
  } else if (state?.screen === 'watching') {
    showScreen('watching');
  }
  // else: default idle screen is already shown
});

// ── Sharer: start sharing ──────────────────────────────────────────────────

$('btn-start').addEventListener('click', () => {
  const btn = $('btn-start');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  setError('');

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage(
      { type: 'START_SHARE', tabId: tab.id, tabUrl: tab.url, iceConfig: getIceConfig() },
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

// ── Sharer: copy offer code ────────────────────────────────────────────────

$('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('offer-out').value).then(() => {
    $('btn-copy').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy').textContent = 'Copy code'; }, 1500);
  });
});

// ── Sharer: apply answer ───────────────────────────────────────────────────

$('btn-apply').addEventListener('click', () => {
  const answer = $('answer-in').value.trim();
  if (!answer) { setError('Paste the answer code first.'); return; }

  const btn = $('btn-apply');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  setError('');

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage({ type: 'APPLY_ANSWER', answer, sharerTabId: tab.id }, resp => {
      btn.disabled = false;
      btn.textContent = 'Connect';

      if (chrome.runtime.lastError || !resp?.ok) {
        setError(chrome.runtime.lastError?.message || resp?.error || 'Failed to apply answer.');
        return;
      }
      showScreen('connected');
    });
  });
});

// ── Sharer: stop sharing ───────────────────────────────────────────────────

$('btn-stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SHARE' }, () => showScreen('idle'));
});

// ── Viewer: open join screen ───────────────────────────────────────────────

$('btn-join').addEventListener('click', () => showScreen('viewer-join'));
$('btn-back').addEventListener('click', () => showScreen('idle'));

// ── Viewer: show URL hint after pasting offer ──────────────────────────────

function showUrlHint(url, time) {
  const hint = $('viewer-url-hint');
  hint.innerHTML = `Navigate to: <strong>${url}</strong><br>Timestamp: <strong>${formatTime(time || 0)}</strong>`;
  hint.classList.add('visible');
}

$('viewer-offer-in').addEventListener('input', () => {
  $('viewer-url-hint').classList.remove('visible');
});

// ── Viewer: generate answer ────────────────────────────────────────────────

$('btn-gen-answer').addEventListener('click', () => {
  const offer = $('viewer-offer-in').value.trim();
  if (!offer) { setError('Paste the offer code first.'); return; }

  const btn = $('btn-gen-answer');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  setError('');

  chrome.runtime.sendMessage({ type: 'JOIN_SESSION', offer }, resp => {
    btn.disabled = false;
    btn.textContent = 'Generate Answer';

    if (chrome.runtime.lastError || !resp?.ok) {
      setError(chrome.runtime.lastError?.message || resp?.error || 'Failed to generate answer.');
      return;
    }

    $('viewer-answer-out').value = resp.answer;
    if (resp.syncUrl) showUrlHint(resp.syncUrl, resp.syncTime);
    showScreen('viewer-handshake');
  });
});

// ── Viewer: copy answer code ───────────────────────────────────────────────

$('btn-copy-answer').addEventListener('click', () => {
  navigator.clipboard.writeText($('viewer-answer-out').value).then(() => {
    $('btn-copy-answer').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-answer').textContent = 'Copy code'; }, 1500);
  });
});

// ── Viewer: start watching ────────────────────────────────────────────────

$('btn-start-watching').addEventListener('click', () => {
  const btn = $('btn-start-watching');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  setError('');

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage({ type: 'START_WATCHING', tabId: tab.id }, resp => {
      btn.disabled = false;
      btn.textContent = 'Start Watching';

      if (chrome.runtime.lastError || !resp?.ok) {
        setError(chrome.runtime.lastError?.message || resp?.error || 'Failed to start watching.');
        return;
      }
      showScreen('watching');
    });
  });
});

// ── Viewer: stop watching ─────────────────────────────────────────────────

$('btn-stop-watch').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_WATCH' }, () => showScreen('idle'));
});
