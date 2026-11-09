/* Lock screen: backend url -> connect (loading bar, pass/fail) -> token -> unlock.
   Two steps because the backend is not always this origin: the desktop exe and
   a Cloudflare tunnel both serve the UI from one place and the API from another. */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const stepUrl = $('#step-url');
  const stepToken = $('#step-token');
  const urlInput = $('#backend-url');
  const urlError = $('#url-error');
  const connectBtn = $('#connect');
  const progress = $('#connect-progress');
  const bar = $('#connect-bar');
  const connectOk = $('#connect-ok');

  const form = $('#login-form');
  const input = $('#token');
  const error = $('#login-error');
  const button = $('#login-submit');

  const STORAGE = 'lo.backend';
  const saved = localStorage.getItem(STORAGE);
  if (saved) urlInput.value = saved;

  // ---- helpers ---------------------------------------------------------
  const shake = (el) => {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  };

  const showUrlError = (text) => {
    urlError.textContent = text;
    urlError.hidden = false;
    shake(urlInput);
  };

  const baseOf = (raw) => {
    let url = (raw || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    return url.replace(/\/+$/, '').replace(/\/api$/, '');
  };

  // Animated 0-100 while the probe runs. Never fakes success: the icon and the
  // step change are driven by the actual response.
  const animate = (done) => {
    progress.hidden = false;
    bar.style.width = '0%';
    const started = performance.now();
    const timer = setInterval(() => {
      const ratio = Math.min(0.9, (performance.now() - started) / 1400);
      bar.style.width = `${Math.round(ratio * 100)}%`;
    }, 50);
    return {
      finish(ok) {
        clearInterval(timer);
        bar.style.width = '100%';
        setTimeout(() => { progress.hidden = true; }, ok ? 300 : 800);
        if (done) done(ok);
      },
    };
  };

  // ---- step 1: connect -------------------------------------------------
  async function connect() {
    const base = baseOf(urlInput.value);
    if (!base) {
      showUrlError('enter the backend url');
      return;
    }
    urlError.hidden = true;
    connectBtn.disabled = true;
    connectBtn.textContent = 'connecting…';
    const prog = animate();

    let ok = false;
    let detail = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${base}/health`, {
        method: 'GET',
        signal: controller.signal,
        mode: 'cors',
        credentials: 'include',
      }).finally(() => clearTimeout(timer));
      ok = res.ok;
      if (ok) {
        const body = await res.json().catch(() => ({}));
        detail = body.version ? `v${body.version}` : '';
      } else {
        detail = `HTTP ${res.status}`;
      }
    } catch (err) {
      ok = false;
      // Say what actually happened: refused, timed out, DNS, or CORS.
      if (err.name === 'AbortError') {
        detail = 'timed out after 8s — is the server still starting?';
      } else if (err instanceof TypeError && /fetch/i.test(err.message)) {
        detail = 'could not reach that address — nothing is listening, or ' +
                 'it is not this backend';
      } else {
        detail = err.message || 'could not reach that address';
      }
    }

    prog.finish(ok);
    connectBtn.disabled = false;
    connectBtn.textContent = 'connect';

    if (!ok) {
      urlError.textContent = `✗ ${detail}`;
      urlError.hidden = false;
      urlInput.classList.add('input-bad');
      connectBtn.classList.remove('btn-danger');
      return;
    }

    urlInput.classList.remove('input-bad');
    connectBtn.classList.remove('btn-danger');
    localStorage.setItem(STORAGE, base);
    connectOk.textContent = detail ? `✓ connected · ${detail}` : '✓ connected';
    stepUrl.hidden = true;
    stepToken.hidden = false;
    input.value = '';
    input.focus();
  }

  // ---- step 2: unlock --------------------------------------------------
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = input.value.trim();
    if (!token) return showError('token required');

    button.disabled = true;
    error.hidden = true;
    const base = baseOf(urlInput.value);
    try {
      const res = await fetch(`${base}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        window.location.replace(base + (data.redirect || '/'));
        return;
      }
      showError(res.status === 429
        ? (data.error || 'too many attempts, wait a minute')
        : (data.error || 'invalid token'));
    } catch (err) {
      showError('network error — is the server still running?');
    } finally {
      button.disabled = false;
    }
  });

  function showError(text) {
    error.textContent = text || 'invalid token';
    error.hidden = false;
    shake(input);
    input.select();
  }

  // ---- navigation ------------------------------------------------------
  connectBtn.addEventListener('click', connect);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); connect(); }
  });
  $('#back-to-url').addEventListener('click', () => {
    stepToken.hidden = true;
    stepUrl.hidden = false;
    connectBtn.classList.remove('btn-danger');
    urlInput.focus();
  });

  urlInput.focus();
})();
