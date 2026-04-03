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

// Strip non-relay candidates so encoded codes are shorter
function relayOnlySdp(desc) {
  const sdp = desc.sdp.split('\n').filter(line =>
    !line.startsWith('a=candidate:') || line.includes('typ relay')
  ).join('\n');
  return { ...desc, sdp };
}

let sharerPc     = null;
let loopPc       = null;   // background side of the loopback to the capture tab
let captureTabId = null;   // which tab is currently providing the stream
let state        = { screen: 'idle', offer: null };

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

async function stopCapture(tabId) {
  if (!tabId) return;
  await new Promise(res => chrome.tabs.sendMessage(tabId, { type: 'STOP_CAPTURE' }, () => {
    void chrome.runtime.lastError; // suppress "no receiver" errors
    res();
  }));
}

async function getStreamFromTab(tabId) {
  if (loopPc) { loopPc.close(); loopPc = null; }

  // Ask content.js to capture video and return a loopback offer
  const resp = await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_STREAM' }, r => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r);
    });
  });
  if (!resp?.ok) throw new Error(resp?.error || 'Stream capture failed');

  // Build our side of the loopback
  loopPc = new RTCPeerConnection({ iceServers: [] });

  const streamReady = new Promise((resolve, reject) => {
    const tracks = [];
    loopPc.ontrack = ev => { tracks.push(ev.track); };
    loopPc.oniceconnectionstatechange = () => {
      if (loopPc.iceConnectionState === 'connected')
        setTimeout(() => resolve(new MediaStream(tracks)), 100);
      else if (loopPc.iceConnectionState === 'failed')
        reject(new Error('Loopback ICE failed'));
    };
    setTimeout(() => reject(new Error('Loopback connection timeout')), 6000);
  });

  await loopPc.setRemoteDescription(resp.offer);
  const answer = await loopPc.createAnswer();
  await loopPc.setLocalDescription(answer);
  await waitForGathering(loopPc, 500);

  // Deliver the answer back to content.js so ICE can complete
  chrome.tabs.sendMessage(tabId, { type: 'STREAM_ANSWER', answer: loopPc.localDescription.toJSON() });

  return streamReady;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'GET_STATE') {
    sendResponse(state);
    return;
  }

  if (msg.type === 'START_SHARE') {
    (async () => {
      try {
        const stream = await getStreamFromTab(msg.tabId);
        captureTabId = msg.tabId;

        sharerPc = new RTCPeerConnection(msg.iceConfig);
        stream.getTracks().forEach(t => sharerPc.addTrack(t, stream));

        await sharerPc.setLocalDescription(await sharerPc.createOffer());
        await waitForGathering(sharerPc, 2000);

        const offer = await compress(JSON.stringify(relayOnlySdp({
          ...sharerPc.localDescription.toJSON(),
          iceServers: msg.iceConfig.iceServers,
        })));
        state = { screen: 'handshake', offer };
        sendResponse({ ok: true, offer });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'APPLY_ANSWER') {
    if (!sharerPc) { sendResponse({ ok: false, error: 'No active share' }); return; }
    (async () => {
      try {
        const desc = JSON.parse(await decompress(msg.answer));
        await sharerPc.setRemoteDescription(desc);
        state.screen = 'connected';
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'RECAPTURE') {
    if (!sharerPc) { sendResponse({ ok: false, error: 'No active share' }); return; }
    (async () => {
      try {
        if (captureTabId && captureTabId !== msg.tabId) {
          await stopCapture(captureTabId);
        }
        const stream = await getStreamFromTab(msg.tabId);
        captureTabId = msg.tabId;

        for (const sender of sharerPc.getSenders()) {
          if (!sender.track) continue;
          const newTrack = stream.getTracks().find(t => t.kind === sender.track.kind);
          if (newTrack) await sender.replaceTrack(newTrack);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'STOP_SHARE') {
    (async () => {
      await stopCapture(captureTabId);
      if (loopPc)   { loopPc.close();   loopPc = null; }
      if (sharerPc) { sharerPc.close(); sharerPc = null; }
      captureTabId = null;
      state = { screen: 'idle', offer: null };
      sendResponse({ ok: true });
    })();
    return true;
  }

});
