// background.js — holds WebRTC state across popup opens and tab switches

// ── Codec helpers ──────────────────────────────────────────────────────────

async function compress(str) {
  const bytes = new TextEncoder().encode(str);
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  let bin = '';
  for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
  return btoa(bin);
}

async function decompress(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

// Strip non-relay candidates so encoded codes are shorter (only if relay candidates exist)
function relayOnlySdp(desc) {
  const lines = desc.sdp.split('\n');
  const relayCandidates = lines.filter(l => l.startsWith('a=candidate:') && l.includes('typ relay'));
  if (!relayCandidates.length) return desc;
  const sdp = lines.filter(l => !l.startsWith('a=candidate:') || l.includes('typ relay')).join('\n');
  return { ...desc, sdp };
}

let sharerPc    = null;
let dataChannel = null;   // sharer: created channel; viewer: received channel
let viewerTabId = null;   // viewer side: tab whose video to control
let syncMode    = null;   // 'sharer' | 'viewer'
let state       = { screen: 'idle' };

async function waitForGathering(pc, ms) {
  await Promise.race([
    new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.addEventListener('icegatheringstatechange', function h() {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', h);
          res();
        }
      });
    }),
    new Promise(res => setTimeout(res, ms))
  ]);
}

function getVideoInfoFromTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_INFO' }, r => {
      void chrome.runtime.lastError;
      resolve(r || { currentTime: 0, paused: true });
    });
  });
}

function setupViewerChannel() {
  dataChannel.onmessage = e => {
    let event;
    try { event = JSON.parse(e.data); } catch (_) { return; }
    if (!viewerTabId) return;
    chrome.tabs.sendMessage(viewerTabId, { type: 'APPLY_SYNC', event }, () => {
      void chrome.runtime.lastError;
    });
  };
}

function resetState() {
  if (dataChannel)  { dataChannel.close();  dataChannel = null; }
  if (sharerPc)     { sharerPc.close();     sharerPc = null; }
  viewerTabId = null;
  syncMode    = null;
  state       = { screen: 'idle' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'GET_STATE') {
    sendResponse(state);
    return;
  }

  // ── Sharer: start sharing ──────────────────────────────────────────────────
  if (msg.type === 'START_SHARE') {
    (async () => {
      try {
        const videoInfo = await getVideoInfoFromTab(msg.tabId);

        sharerPc = new RTCPeerConnection(msg.iceConfig);
        dataChannel = sharerPc.createDataChannel('sync');
        syncMode = 'sharer';

        await sharerPc.setLocalDescription(await sharerPc.createOffer());
        await waitForGathering(sharerPc, 2000);

        const offer = await compress(JSON.stringify({
          ...relayOnlySdp(sharerPc.localDescription.toJSON()),
          iceServers: msg.iceConfig.iceServers,
          syncUrl:    msg.tabUrl,
          syncTime:   videoInfo.currentTime,
          syncPaused: videoInfo.paused,
        }));

        state = { screen: 'handshake', offer };
        sendResponse({ ok: true, offer });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ── Sharer: apply viewer's answer ─────────────────────────────────────────
  if (msg.type === 'APPLY_ANSWER') {
    if (!sharerPc) { sendResponse({ ok: false, error: 'No active share' }); return; }
    (async () => {
      try {
        const desc = JSON.parse(await decompress(msg.answer));
        await sharerPc.setRemoteDescription(desc);

        // When DataChannel opens, send the current video state as init event
        dataChannel.onopen = async () => {
          const info = await getVideoInfoFromTab(msg.sharerTabId);
          dataChannel.send(JSON.stringify({ type: 'init', currentTime: info.currentTime, paused: info.paused }));
          // Also start listening for sync events from content.js
          chrome.tabs.sendMessage(msg.sharerTabId, { type: 'START_SYNC' }, () => { void chrome.runtime.lastError; });
        };

        state.screen = 'connected';
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── Viewer: generate answer from offer ────────────────────────────────────
  if (msg.type === 'JOIN_SESSION') {
    (async () => {
      try {
        const parsed = JSON.parse(await decompress(msg.offer));

        sharerPc = new RTCPeerConnection({ iceServers: parsed.iceServers || [] });
        syncMode = 'viewer';

        sharerPc.ondatachannel = e => {
          dataChannel = e.channel;
          setupViewerChannel();
        };

        await sharerPc.setRemoteDescription({ type: parsed.type, sdp: parsed.sdp });
        await sharerPc.setLocalDescription(await sharerPc.createAnswer());
        await waitForGathering(sharerPc, 2000);

        const answer = await compress(JSON.stringify(sharerPc.localDescription.toJSON()));

        state = {
          screen:     'viewer-handshake',
          answer,
          syncUrl:    parsed.syncUrl,
          syncTime:   parsed.syncTime,
          syncPaused: parsed.syncPaused,
        };
        sendResponse({ ok: true, answer, syncUrl: parsed.syncUrl, syncTime: parsed.syncTime });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ── Viewer: designate which tab to control ────────────────────────────────
  if (msg.type === 'START_WATCHING') {
    viewerTabId = msg.tabId;
    state.screen = 'watching';
    sendResponse({ ok: true });
    return;
  }

  // ── Sharer: forward sync event from content.js to DataChannel ─────────────
  if (msg.type === 'SYNC_EVENT') {
    if (syncMode === 'sharer' && dataChannel?.readyState === 'open') {
      dataChannel.send(JSON.stringify(msg.event));
    }
    sendResponse({ ok: true });
    return;
  }

  // ── Stop (both modes) ─────────────────────────────────────────────────────
  if (msg.type === 'STOP_SHARE' || msg.type === 'STOP_WATCH') {
    resetState();
    sendResponse({ ok: true });
    return;
  }

});
