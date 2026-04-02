// content.js — injected into every page and every iframe

const isTopFrame = window === window.top;

// ── Video finder ───────────────────────────────────────────────────────────

function collectVideos(root) {
  const videos = Array.from(root.querySelectorAll('video'));
  root.querySelectorAll('*').forEach(el => {
    if (el.shadowRoot) videos.push(...collectVideos(el.shadowRoot));
  });
  return videos;
}

function findVideo() {
  const videos = collectVideos(document);
  if (!videos.length) return null;
  return videos.sort((a, b) => {
    const score = el =>
      (!el.paused ? 8 : 0) +
      (!el.muted  ? 4 : 0) +
      (el.readyState >= 2 ? 2 : 0) +
      (el.videoWidth * el.videoHeight > 0 ? 1 : 0);
    return score(b) - score(a);
  })[0];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function broadcastToIframes(msgType) {
  document.querySelectorAll('iframe').forEach(iframe => {
    try { iframe.contentWindow.postMessage({ __streamshare: true, type: msgType }, '*'); }
    catch (_) {}
  });
}

// ── Iframe: postMessage listener ───────────────────────────────────────────

if (!isTopFrame) {
  window.addEventListener('message', e => {
    const msg = e.data;
    if (!msg || !msg.__streamshare) return;

    if (msg.type === 'CAPTURE_FRAME') {
      const video = findVideo();
      if (video) {
        const canvas = document.createElement('canvas');
        canvas.width  = video.videoWidth  || 320;
        canvas.height = video.videoHeight || 180;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        let dataUrl = null;
        try { dataUrl = canvas.toDataURL('image/jpeg', 0.7); } catch (_) {}
        window.top.postMessage({ __streamshare: true, type: 'FRAME_RESULT', dataUrl }, '*');
      } else {
        broadcastToIframes('CAPTURE_FRAME');
      }
    }
  });
}

// ── Top frame: extension message listener ──────────────────────────────────

if (isTopFrame) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === 'CAPTURE_FRAME') {
      const video = findVideo();
      if (video) {
        const canvas = document.createElement('canvas');
        canvas.width  = video.videoWidth  || 320;
        canvas.height = video.videoHeight || 180;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        let dataUrl = null;
        try { dataUrl = canvas.toDataURL('image/jpeg', 0.7); } catch (_) {}
        sendResponse({ ok: true, dataUrl });
        return;
      }

      let resolved = false;
      function frameHandler(e) {
        const m = e.data;
        if (!m || !m.__streamshare || m.type !== 'FRAME_RESULT' || resolved) return;
        resolved = true;
        window.removeEventListener('message', frameHandler);
        clearTimeout(frameTimeout);
        sendResponse({ ok: true, dataUrl: m.dataUrl });
      }
      window.addEventListener('message', frameHandler);
      const frameTimeout = setTimeout(() => {
        window.removeEventListener('message', frameHandler);
        if (!resolved) sendResponse({ ok: false, error: 'No frame received from any frame' });
      }, 3000);
      broadcastToIframes('CAPTURE_FRAME');
      return true;
    }

  });
}
