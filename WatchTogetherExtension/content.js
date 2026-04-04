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

function broadcastToIframes(msg) {
  document.querySelectorAll('iframe').forEach(iframe => {
    try { iframe.contentWindow.postMessage({ __streamshare: true, ...msg }, '*'); }
    catch (_) {}
  });
}

// ── Sync listeners (sharer side) ───────────────────────────────────────────

let syncListeners = null;

function attachSyncListeners(video) {
  if (syncListeners) detachSyncListeners();
  console.log('[SS content] attachSyncListeners on video, src:', video.currentSrc?.slice(0, 80), 'frame:', location.href.slice(0, 80));
  const onPlay   = () => {
    console.log('[SS content] video play, currentTime:', video.currentTime);
    chrome.runtime.sendMessage({ type: 'SYNC_EVENT', event: { type: 'play',  currentTime: video.currentTime } }, () => { void chrome.runtime.lastError; });
  };
  const onPause  = () => {
    console.log('[SS content] video pause, currentTime:', video.currentTime);
    chrome.runtime.sendMessage({ type: 'SYNC_EVENT', event: { type: 'pause', currentTime: video.currentTime } }, () => { void chrome.runtime.lastError; });
  };
  const onSeeked = () => {
    console.log('[SS content] video seeked, currentTime:', video.currentTime);
    chrome.runtime.sendMessage({ type: 'SYNC_EVENT', event: { type: 'seek',  currentTime: video.currentTime } }, () => { void chrome.runtime.lastError; });
  };
  video.addEventListener('play',   onPlay);
  video.addEventListener('pause',  onPause);
  video.addEventListener('seeked', onSeeked);
  syncListeners = { video, onPlay, onPause, onSeeked };
}

function detachSyncListeners() {
  if (!syncListeners) return;
  const { video, onPlay, onPause, onSeeked } = syncListeners;
  video.removeEventListener('play',   onPlay);
  video.removeEventListener('pause',  onPause);
  video.removeEventListener('seeked', onSeeked);
  syncListeners = null;
}

// ── Apply sync event (viewer side) ────────────────────────────────────────

function applySyncEvent(video, event) {
  console.log('[SS content] applySyncEvent:', event, 'frame:', location.href.slice(0, 80));
  if (event.type === 'seek' || event.type === 'play' || event.type === 'pause' || event.type === 'init') {
    video.currentTime = event.currentTime;
  }
  if (event.type === 'play')  video.play().catch(e => console.warn('[SS content] play() rejected:', e));
  if (event.type === 'pause') video.pause();
  if (event.type === 'init') {
    if (!event.paused) video.play().catch(e => console.warn('[SS content] init play() rejected:', e));
    else video.pause();
  }
}

// ── Iframe: postMessage listener ───────────────────────────────────────────

if (!isTopFrame) {
  window.addEventListener('message', e => {
    const msg = e.data;
    if (!msg || !msg.__streamshare) return;

    if (msg.type === 'GET_VIDEO_INFO') {
      const video = findVideo();
      if (video) {
        window.top.postMessage({ __streamshare: true, type: 'VIDEO_INFO_RESULT', currentTime: video.currentTime, paused: video.paused }, '*');
      } else {
        broadcastToIframes({ type: 'GET_VIDEO_INFO' });
      }
    }

    if (msg.type === 'START_SYNC') {
      const video = findVideo();
      console.log('[SS content iframe] START_SYNC received, video found:', !!video, 'frame:', location.href.slice(0, 80));
      if (video) {
        attachSyncListeners(video);
      } else {
        broadcastToIframes({ type: 'START_SYNC' });
      }
    }

    if (msg.type === 'STOP_SYNC') {
      detachSyncListeners();
    }

    if (msg.type === 'APPLY_SYNC') {
      const video = findVideo();
      if (video) {
        applySyncEvent(video, msg.event);
      } else {
        broadcastToIframes({ type: 'APPLY_SYNC', event: msg.event });
      }
    }
  });
}

// ── Top frame: extension message listener ──────────────────────────────────

if (isTopFrame) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // ── Get current video state (URL reported via tab, time/paused from video) ──
    if (msg.type === 'GET_VIDEO_INFO') {
      const video = findVideo();
      if (video) {
        sendResponse({ currentTime: video.currentTime, paused: video.paused });
        return;
      }
      // Try iframes
      let resolved = false;
      function infoHandler(e) {
        const m = e.data;
        if (!m || !m.__streamshare || m.type !== 'VIDEO_INFO_RESULT' || resolved) return;
        resolved = true;
        window.removeEventListener('message', infoHandler);
        clearTimeout(infoTimeout);
        sendResponse({ currentTime: m.currentTime, paused: m.paused });
      }
      window.addEventListener('message', infoHandler);
      const infoTimeout = setTimeout(() => {
        window.removeEventListener('message', infoHandler);
        if (!resolved) sendResponse({ currentTime: 0, paused: true });
      }, 3000);
      broadcastToIframes({ type: 'GET_VIDEO_INFO' });
      return true;
    }

    // ── Start sync listeners on the video (sharer side) ────────────────────
    if (msg.type === 'START_SYNC') {
      const video = findVideo();
      console.log('[SS content] START_SYNC received, video found:', !!video, 'frame:', location.href.slice(0, 80));
      if (video) {
        attachSyncListeners(video);
      } else {
        console.log('[SS content] No video in top frame — broadcasting to iframes');
        broadcastToIframes({ type: 'START_SYNC' });
      }
      sendResponse({ ok: true });
      return;
    }

    // ── Remove sync listeners (sharer side) ────────────────────────────────
    if (msg.type === 'STOP_SYNC') {
      detachSyncListeners();
      broadcastToIframes({ type: 'STOP_SYNC' });
      sendResponse({ ok: true });
      return;
    }

    // ── Apply a sync event to the video (viewer side) ──────────────────────
    if (msg.type === 'APPLY_SYNC') {
      const video = findVideo();
      console.log('[SS content] APPLY_SYNC received:', msg.event, '| video found:', !!video);
      if (video) {
        applySyncEvent(video, msg.event);
      } else {
        console.log('[SS content] No video in top frame — broadcasting to iframes');
        broadcastToIframes({ type: 'APPLY_SYNC', event: msg.event });
      }
      sendResponse({ ok: true });
      return;
    }

  });
}
