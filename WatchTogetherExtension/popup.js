const btnPreview   = document.getElementById('btn-preview');
const previewWrap  = document.getElementById('preview-wrap');
const previewImg   = document.getElementById('preview-img');
const errorMsg     = document.getElementById('error-msg');

function setError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.toggle('visible', !!msg);
}

btnPreview.addEventListener('click', () => {
  setError('');
  btnPreview.disabled    = true;
  btnPreview.textContent = 'Capturing…';

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_FRAME' }, (resp) => {
      btnPreview.disabled    = false;
      btnPreview.textContent = 'Preview video';

      if (chrome.runtime.lastError) { setError('Could not reach page. Try refreshing.'); return; }
      if (!resp?.ok)                 { setError(resp?.error || 'No video found.');         return; }
      if (resp.dataUrl) {
        previewImg.src = resp.dataUrl;
        previewWrap.style.display = 'block';
      } else {
        setError('Video found but frame blocked (cross-origin canvas taint).');
      }
    });
  });
});
