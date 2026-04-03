// content.js — injected into every page and every iframe

const isTopFrame = window === window.top;

// ── Per-tab state ──────────────────────────────────────────────────────────

let drawLoopId         = null;
let contentLoopPc      = null;   // loopback PC to background
let pendingStreamResolve = null; // used for iframe→top relay
let iframeRelayPc      = null;   // top-frame side of iframe→top relay (kept alive)
let iframeLoopPc       = null;   // iframe side of loopback to top frame (kept alive)

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
  if (drawLoopId !== null) { cancelAnimationFrame(drawLoopId); drawLoopId = null; }

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
    src.connect(ac.destination); // preserve local audio
    dst.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  } catch (_) {}

  return stream;
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

    if (msg.type === 'STREAM_ANSWER') {
      // Forward down to nested iframes so deeply nested video frames get it
      document.querySelectorAll('iframe').forEach(iframe => {
        try { iframe.contentWindow.postMessage(msg, '*'); } catch (_) {}
      });
    }

    if (msg.type === 'START_STREAM') {
      const video = findVideo();
      if (!video) {
        broadcastToIframes('START_STREAM'); // recurse into nested iframes
        return;
      }

      const stream = captureLocalStream(video);
      if (iframeLoopPc) { iframeLoopPc.close(); iframeLoopPc = null; }
      iframeLoopPc = new RTCPeerConnection({ iceServers: [] });
      stream.getTracks().forEach(t => iframeLoopPc.addTrack(t, stream));

      await iframeLoopPc.setLocalDescription(await iframeLoopPc.createOffer());
      await waitForGathering(iframeLoopPc, 500);

      window.top.postMessage({
        __streamshare: true,
        type: 'STREAM_OFFER',
        offer: iframeLoopPc.localDescription.toJSON()
      }, '*');

      window.addEventListener('message', async function answerHandler(ev) {
        if (!ev.data?.__streamshare || ev.data.type !== 'STREAM_ANSWER') return;
        window.removeEventListener('message', answerHandler);
        await iframeLoopPc.setRemoteDescription(ev.data.answer);
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

    if (iframeRelayPc) { iframeRelayPc.close(); iframeRelayPc = null; }
    iframeRelayPc = new RTCPeerConnection({ iceServers: [] });
    const tracks  = [];
    iframeRelayPc.ontrack = ev => (ev.streams[0]?.getTracks() ?? [ev.track]).forEach(t => tracks.push(t));

    await iframeRelayPc.setRemoteDescription(e.data.offer);
    await iframeRelayPc.setLocalDescription(await iframeRelayPc.createAnswer());
    await waitForGathering(iframeRelayPc, 500);

    document.querySelectorAll('iframe').forEach(fr => {
      try {
        fr.contentWindow.postMessage({
          __streamshare: true,
          type: 'STREAM_ANSWER',
          answer: iframeRelayPc.localDescription.toJSON()
        }, '*');
      } catch (_) {}
    });

    await new Promise(res => {
      if (tracks.length) return res();
      iframeRelayPc.addEventListener('track', () => { if (tracks.length) res(); });
      setTimeout(res, 3000);
    });

    resolve(new MediaStream(tracks));
  });
}

// ── Top frame: extension message listener ──────────────────────────────────

if (isTopFrame) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // ── Frame preview (popup) ───────────────────────────────────────────────
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

    // ── Capture stream and deliver to background via loopback PC ────────────
    if (msg.type === 'GET_STREAM') {
      (async () => {
        try {
          let stream;
          const video = findVideo();

          if (video) {
            stream = captureLocalStream(video);
          } else {
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

          if (contentLoopPc) { contentLoopPc.close(); contentLoopPc = null; }
          contentLoopPc = new RTCPeerConnection({ iceServers: [] });
          stream.getTracks().forEach(t => contentLoopPc.addTrack(t, stream));
          await contentLoopPc.setLocalDescription(await contentLoopPc.createOffer());
          await waitForGathering(contentLoopPc, 500);

          sendResponse({ ok: true, offer: contentLoopPc.localDescription.toJSON() });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Background delivers loopback answer ─────────────────────────────────
    if (msg.type === 'STREAM_ANSWER') {
      if (contentLoopPc) {
        contentLoopPc.setRemoteDescription(msg.answer).catch(() => {});
      }
      sendResponse({ ok: true });
    }

    // ── Stop capture (switching to a different tab) ──────────────────────────
    if (msg.type === 'STOP_CAPTURE') {
      if (drawLoopId !== null) { cancelAnimationFrame(drawLoopId); drawLoopId = null; }
      if (contentLoopPc)  { contentLoopPc.close();  contentLoopPc = null; }
      if (iframeRelayPc)  { iframeRelayPc.close();  iframeRelayPc = null; }
      sendResponse({ ok: true });
    }

  });
}
