/* Cloudflare tab: connect with an animated progress bar, reveal the secret
   field, validate, then show the report panel. Marks are ✓ / ✗ / spinner. */

window.CF = (() => {
  const { $, esc, toast, get, post, showError } = window.APP;

  let cfg = null;
  let timer = null;

  function mark(el, state) {
    if (!el) return;
    el.className = `mark ${state || ''}`;
    el.textContent = state === 'ok' ? '✓' : state === 'bad' ? '✗' : '';
  }

  function animateProgress(done, ms = 1500) {
    const wrap = $('#cf-progress');
    const bar = $('#cf-progress-bar');
    wrap.hidden = false;
    bar.style.width = '0%';
    const started = performance.now();
    clearInterval(timer);
    timer = setInterval(() => {
      const elapsed = performance.now() - started;
      const ratio = Math.min(0.92, elapsed / ms);
      bar.style.width = `${Math.round(ratio * 100)}%`;
      if (elapsed >= ms && !done()) {
        bar.style.width = '96%';
      }
    }, 60);
    return {
      finish(ok) {
        clearInterval(timer);
        bar.style.width = '100%';
        setTimeout(() => { wrap.hidden = true; }, ok ? 380 : 900);
      },
    };
  }

  async function load() {
    cfg = await get('/api/cf');
    $('#cf-url').value = cfg.worker_url || '';
    $('#cf-secret').value = '';
    $('#cf-secret').placeholder = cfg.has_secret
      ? '•••••••• (saved, leave blank to keep)' : 'CF_SHARED_SECRET from wrangler';
    $('#cf-supervisor-id').textContent = cfg.supervisor_id || '—';
    $('#cf-last-report').textContent = cfg.last_report_at || '—';
    $('#cf-last-ok').textContent = cfg.last_report_ok === null || cfg.last_report_ok === undefined
      ? '—' : (cfg.last_report_ok ? 'yes ✓' : 'no ✗');
    $('#cf-enabled').textContent = cfg.enabled ? 'yes' : 'no';
    $('#cf-expose').checked = !!cfg.expose_proxy;
    $('#cf-state').textContent = cfg.enabled ? 'connected' : 'disconnected';

    const connected = !!cfg.worker_url;
    $('#cf-stage-secret').hidden = !connected;
    $('#cf-stage-status').hidden = !cfg.enabled;
    if (connected) mark($('#cf-connect-mark'), 'ok');
    if (cfg.enabled) mark($('#cf-validate-mark'), 'ok');

    if (cfg.current_report) {
      $('#cf-report-json').textContent = JSON.stringify(cfg.current_report, null, 2);
    }
  }

  async function connect() {
    const url = $('#cf-url').value.trim();
    if (!url) { toast('paste the worker url first', 'warn'); return; }
    const msg = $('#cf-connect-msg');
    msg.textContent = 'handshaking with /health…';
    mark($('#cf-connect-mark'), 'busy');
    const progress = animateProgress(() => false, 1500);
    try {
      const [res] = await Promise.all([
        post('/api/cf/connect', { worker_url: url }),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
      progress.finish(!!res.ok);
      if (res.ok) {
        mark($('#cf-connect-mark'), 'ok');
        msg.textContent = `worker answered in ${res.elapsed_ms}ms — enter the shared secret`;
        $('#cf-stage-secret').hidden = false;
        $('#cf-secret').focus();
        $('#cf-state').textContent = 'handshake ok';
      } else {
        mark($('#cf-connect-mark'), 'bad');
        msg.innerHTML = `✗ ${esc(res.error || 'connection failed')} ` +
          '<button class="btn btn-sm" id="cf-retry" type="button">retry</button>';
        const retry = $('#cf-retry');
        if (retry) retry.addEventListener('click', () => connect());
      }
    } catch (err) {
      progress.finish(false);
      mark($('#cf-connect-mark'), 'bad');
      msg.textContent = `✗ ${err.message}`;
    }
  }

  async function validate() {
    const url = $('#cf-url').value.trim();
    const secret = $('#cf-secret').value.trim();
    if (!url) { toast('worker url missing', 'warn'); return; }
    const msg = $('#cf-validate-msg');
    msg.textContent = 'validating secret…';
    mark($('#cf-validate-mark'), 'busy');
    try {
      let res;
      if (secret) {
        res = await post('/api/cf/validate', { worker_url: url, shared_secret: secret });
      } else {
        // No secret typed: the server already holds one, so just save + report.
        await post('/api/cf', { worker_url: url, enabled: 1 });
        res = { ok: true, body: { ok: true }, reused: true };
      }
      if (res.ok) {
        mark($('#cf-validate-mark'), 'ok');
        msg.textContent = res.reused
          ? '✓ using the stored secret, reports enabled'
          : '✓ validated, secret encrypted and saved, reports enabled';
        $('#cf-stage-status').hidden = false;
        await load();
      } else {
        mark($('#cf-validate-mark'), 'bad');
        msg.textContent = `✗ ${res.error || res.body?.error || 'invalid secret'}`;
      }
    } catch (err) {
      mark($('#cf-validate-mark'), 'bad');
      msg.textContent = `✗ ${err.message}`;
    }
  }

  async function sendReport() {
    const res = await post('/api/cf/report');
    if (res.ok) {
      toast('report delivered');
      await load();
    } else {
      toast(res.error || 'report failed', 'error');
    }
  }

  async function toggleExpose(e) {
    await post('/api/cf/expose', { expose_proxy: e.target.checked ? 1 : 0 });
    toast(e.target.checked ? 'dashboard proxy enabled' : 'dashboard proxy disabled');
  }

  function init() {
    $('#cf-connect').addEventListener('click', () => connect().catch(showError));
    $('#cf-validate').addEventListener('click', () => validate().catch(showError));
    $('#cf-report-now').addEventListener('click', () => sendReport().catch(showError));
    $('#cf-expose').addEventListener('change', (e) => toggleExpose(e).catch(showError));
    $('#cf-view-report').addEventListener('click', async () => {
      const pre = $('#cf-report-json');
      if (!pre.textContent) {
        const data = await get('/api/cf');
        pre.textContent = JSON.stringify(data.current_report || {}, null, 2);
      }
      pre.hidden = !pre.hidden;
    });
  }

  return { init, load };
})();
