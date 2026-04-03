// content.js — injected into every page and every iframe

const isTopFrame = window === window.top;

// ── Sharing state (top frame) ──────────────────────────────────────────────

let sharerPc             = null;
let drawLoopId           = null;
let pendingStreamResolve = null;

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

async function waitForGathering(pc, timeoutMs) {
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
    new Promise(res => setTimeout(res, timeoutMs))
  ]);
}

// ── Stream capture ─────────────────────────────────────────────────────────

function captureLocalStream(video) {
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  function draw() {
    if (drawLoopId !== null) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      drawLoopId = requestAnimationFrame(draw);
    }
  }
  drawLoopId = requestAnimationFrame(draw);

  const stream = canvas.captureStream(30);

  try {
    const ac  = new AudioContext();
    const src = ac.createMediaElementSource(video);
    const dst = ac.createMediaStreamDestination();
    src.connect(dst);
    src.connect(ac.destination); // preserve local playback
    dst.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  } catch (_) {}

  return stream;
}

async function buildOutboundPc(stream, iceConfig) {
  sharerPc = new RTCPeerConnection(iceConfig);
  stream.getTracks().forEach(t => sharerPc.addTrack(t, stream));

  await sharerPc.setLocalDescription(await sharerPc.createOffer());
  await waitForGathering(sharerPc, 2000);

  // Embed iceServers so the viewer page can use them without manual entry
  return btoa(JSON.stringify({
    ...sharerPc.localDescription.toJSON(),
    iceServers: iceConfig.iceServers
  }));
}

// ── Iframe: postMessage listener ───────────────────────────────────────────

if (!isTopFrame) {
  window.addEventListener('message', async e => {
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

    if (msg.type === 'START_STREAM') {
      const video = findVideo();
      if (!video) return;

      const stream = captureLocalStream(video);
      const loopPc = new RTCPeerConnection({ iceServers: [] });
      stream.getTracks().forEach(t => loopPc.addTrack(t, stream));

      await loopPc.setLocalDescription(await loopPc.createOffer());
      await waitForGathering(loopPc, 500); // host candidates only, very fast

      window.top.postMessage({
        __streamshare: true,
        type: 'STREAM_OFFER',
        offer: loopPc.localDescription.toJSON()
      }, '*');

      window.addEventListener('message', async function answerHandler(ev) {
        if (!ev.data?.__streamshare || ev.data.type !== 'STREAM_ANSWER') return;
        window.removeEventListener('message', answerHandler);
        await loopPc.setRemoteDescription(ev.data.answer);
      });
    }
  });
}

// ── Top frame: iframe stream relay ─────────────────────────────────────────

if (isTopFrame) {
  window.addEventListener('message', async e => {
    if (!e.data?.__streamshare || e.data.type !== 'STREAM_OFFER') return;
    if (!pendingStreamResolve) return;

    const resolve = pendingStreamResolve;
    pendingStreamResolve = null;

    const relayPc = new RTCPeerConnection({ iceServers: [] });
    const tracks  = [];
    relayPc.ontrack = ev => (ev.streams[0]?.getTracks() ?? [ev.track]).forEach(t => tracks.push(t));

    await relayPc.setRemoteDescription(e.data.offer);
    const answer = await relayPc.createAnswer();
    await relayPc.setLocalDescription(answer);

    // Send answer back to all iframes (only the right one will use it)
    document.querySelectorAll('iframe').forEach(fr => {
      try {
        fr.contentWindow.postMessage({
          __streamshare: true,
          type: 'STREAM_ANSWER',
          answer: relayPc.localDescription.toJSON()
        }, '*');
      } catch (_) {}
    });

    // Wait for tracks to arrive
    await new Promise(res => {
      if (tracks.length) return res();
      relayPc.addEventListener('track', () => { if (tracks.length) res(); });
      setTimeout(res, 3000);
    });

    resolve(new MediaStream(tracks));
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

    if (msg.type === 'START_SHARE') {
      (async () => {
        try {
          const video = findVideo();
          let stream;

          if (video) {
            stream = captureLocalStream(video);
          } else {
            // Video is in a cross-origin iframe — relay via loopback RTCPeerConnection
            stream = await new Promise((resolve, reject) => {
              pendingStreamResolve = resolve;
              broadcastToIframes('START_STREAM');
              setTimeout(() => {
                if (pendingStreamResolve === resolve) {
                  pendingStreamResolve = null;
                  reject(new Error('No video found in any frame'));
                }
              }, 5000);
            });
          }

          const offer = await buildOutboundPc(stream, msg.iceConfig);
          sendResponse({ ok: true, offer });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    if (msg.type === 'APPLY_ANSWER') {
      if (!sharerPc) { sendResponse({ ok: false, error: 'No active share' }); return; }
      sharerPc.setRemoteDescription(JSON.parse(atob(msg.answer)))
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === 'STOP_SHARE') {
      if (sharerPc)       { sharerPc.close(); sharerPc = null; }
      if (drawLoopId !== null) { cancelAnimationFrame(drawLoopId); drawLoopId = null; }
      sendResponse({ ok: true });
    }

    if (msg.type === 'GET_SHARE_STATE') {
      const state = sharerPc?.connectionState ?? 'none';
      sendResponse({
        active: !!sharerPc && !['closed', 'failed'].includes(state),
        state
      });
    }

  });
}
