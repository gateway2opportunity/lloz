/* Campaign wizard: three steps, each one persists the draft before advancing.
   Step 1 who & from · Step 2 what · Step 3 when & limits -> LAUNCH. */

window.WIZARD = (() => {
  const { $, $$, esc, toast, get, post, patch, refreshLookups, showError } = window.APP;

  const VARS = ['first_name', 'last_name', 'company', 'email', 'our_team'];
  let step = 1;
  let draftId = null;
  let lookups = { profiles: [], groups: [], sets: [], templates: [] };

  const SAMPLE = { first_name: 'Alex', last_name: 'Rivera', company: 'Northwind',
                   email: 'alex@example.com', our_team: 'the team' };

  function renderVars(text) {
    return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, key) => SAMPLE[key] ?? '');
  }

  function mdToHtml(md) {
    if (!md) return '';
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return md.replace(/\r\n/g, '\n').split(/\n{2,}/)
      .map((para) => '<p>' + para.split('\n').map(inline).join('<br>') + '</p>').join('');
  }

  function open() {
    draftId = null;
    step = 1;
    resetFields();
    refreshOptions()
      .then(() => { $('#wizard').hidden = false; renderStep(); })
      .catch(showError);
  }

  function close() {
    $('#wizard').hidden = true;
    draftId = null;
  }

  function resetFields() {
    $('#w-name').value = '';
    $('#w-subject').value = '';
    $('#w-body').value = '';
    $('#w-min').value = 45; $('#w-min-val').textContent = '45';
    $('#w-max').value = 180; $('#w-max-val').textContent = '180';
    $('#w-daily').value = 200;
    $('#w-total').value = 500;
    $('#w-start').value = '09:00';
    $('#w-end').value = '18:00';
    $('#w-tz').value = 'UTC';
    $('#w-dryrun').checked = true;
    $('#w-strict').checked = false;
    $('#w-risk').checked = false;
    $('#w-set').value = '';
    $('#w-template').value = '';
    $('#w-preview-subject').textContent = 'preview subject';
    $('#w-preview-body').innerHTML = '';
    renderVarChips();
    renderRiskHint();
  }

  async function refreshOptions() {
    lookups = await refreshLookups();
    try {
      const { templates } = await get('/api/templates?kind=auto_send');
      lookups.templates = templates || [];
    } catch { lookups.templates = []; }

    $('#w-profile').innerHTML = '<option value="">— pick a send profile —</option>' +
      lookups.profiles.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.from_email)}</option>`).join('');
    const def = lookups.profiles.find((p) => p.is_default);
    if (def) $('#w-profile').value = def.id;

    $('#w-group').innerHTML = '<option value="">— pick a group —</option>' +
      lookups.groups.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.active} active)</option>`).join('');

    $('#w-set').innerHTML = '<option value="">— no set —</option>' +
      lookups.sets.filter((s) => s.kind === 'auto_send' || s.kind === 'manual' || !s.kind)
        .map((s) => `<option value="${s.id}">#${s.id} ${esc(s.name)} · ${s.mode} · ${s.count}</option>`).join('');

    $('#w-template').innerHTML = '<option value="">— none —</option>' +
      lookups.templates.map((t) => `<option value="${t.id}">#${t.id} ${esc(t.name)}</option>`).join('');
  }

  function renderVarChips() {
    const box = $('#w-chips');
    box.innerHTML = VARS.map((v) => `<span class="chip" data-var="${v}">{{${v}}}</span>`).join('');
    $$('[data-var]', box).forEach((chip) => chip.addEventListener('click', () => insertVar(chip.dataset.var)));
  }

  function insertVar(name) {
    const active = document.activeElement;
    const target = (active === $('#w-subject') || active === $('#w-body')) ? active : $('#w-body');
    const token = `{{${name}}}`;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = target.value.slice(0, start) + token + target.value.slice(end);
    target.focus();
    target.selectionStart = target.selectionEnd = start + token.length;
    updatePreview();
  }

  function renderRiskHint() {
    const min = Number($('#w-min').value);
    const risky = min < 30;
    $('#w-risk-wrap').style.color = risky ? 'var(--amber)' : '';
    $('#w-risk').disabled = !risky;
    if (!risky) $('#w-risk').checked = false;
  }

  function renderStep() {
    $$('#wizard .wizard-step').forEach((el) => { el.hidden = Number(el.dataset.step) !== step; });
    $$('#wizard-stepper li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('active', n === step);
      li.classList.toggle('done', n < step);
    });
    $('#wizard-back').disabled = step === 1;
    $('#wizard-next').textContent = step === 3 ? 'launch' : 'next';
    $('#wizard-save').hidden = step === 3;
    if (step === 2) updatePreview();
    if (step === 3) renderReview();
  }

  function updatePreview() {
    $('#w-preview-subject').textContent = renderVars($('#w-subject').value) || 'preview subject';
    $('#w-preview-body').innerHTML = mdToHtml(renderVars($('#w-body').value)) || '<p class="muted">body preview</p>';
  }

  function collect(which) {
    const base = {
      name: $('#w-name').value.trim() || 'untitled campaign',
      send_profile_id: Number($('#w-profile').value) || null,
      group_id: Number($('#w-group').value) || null,
    };
    if (which === 1) return base;
    const setVal = Number($('#w-set').value) || null;
    const tplVal = Number($('#w-template').value) || null;
    const what = {
      template_set_id: setVal,
      subject_tpl: $('#w-subject').value,
      body_tpl: $('#w-body').value,
    };
    if (!setVal && tplVal) {
      const tpl = lookups.templates.find((t) => t.id === tplVal);
      what.subject_tpl = what.subject_tpl || tpl?.subject_tpl || '';
      what.body_tpl = what.body_tpl || tpl?.body_md || '';
    }
    if (which === 2) return what;
    return {
      ...what,
      interval_min_sec: Number($('#w-min').value),
      interval_max_sec: Number($('#w-max').value),
      daily_cap: Number($('#w-daily').value),
      total_cap: Number($('#w-total').value),
      window_start: $('#w-start').value || '09:00',
      window_end: $('#w-end').value || '18:00',
      timezone: $('#w-tz').value.trim() || 'UTC',
      dry_run: $('#w-dryrun').checked ? 1 : 0,
      strict_mode: $('#w-strict').checked ? 1 : 0,
      risk_ack: $('#w-risk').checked ? 1 : 0,
    };
  }

  async function persist(which) {
    const payload = collect(which);
    if (draftId) {
      await patch(`/api/campaigns/${draftId}`, payload);
    } else {
      const created = await post('/api/campaigns', payload);
      draftId = created.id;
    }
    return payload;
  }

  function validate(which) {
    if (which === 1) {
      if (!$('#w-name').value.trim()) return 'give the campaign a name';
      if (!$('#w-profile').value) return 'pick a send profile';
      if (!$('#w-group').value) return 'pick a contact group';
      return null;
    }
    if (which === 2) {
      if (!$('#w-set').value && !$('#w-template').value && !$('#w-body').value.trim()) {
        return 'pick a template set, a single template, or write a body';
      }
      if (Number($('#w-min').value) < 30 && !$('#w-risk').checked) {
        return 'intervals under 30s need the pacing risk checkbox (step 3)';
      }
      return null;
    }
    const min = Number($('#w-min').value);
    const max = Number($('#w-max').value);
    if (max < min) return 'interval max must be at least interval min';
    if (min < 30 && !$('#w-risk').checked) return 'tick the pacing risk box or raise the floor to 30s';
    const daily = Number($('#w-daily').value);
    const total = Number($('#w-total').value);
    if (!daily || !total) return 'caps must be positive';
    if (total < daily) return 'total cap should be at least the daily cap';
    return null;
  }

  function renderReview() {
    const group = lookups.groups.find((g) => g.id === Number($('#w-group').value));
    const profile = lookups.profiles.find((p) => p.id === Number($('#w-profile').value));
    const set = lookups.sets.find((s) => s.id === Number($('#w-set').value));
    const tpl = lookups.templates.find((t) => t.id === Number($('#w-template').value));
    const min = Number($('#w-min').value), max = Number($('#w-max').value);
    const body = $('#w-body').value.trim();
    const words = body ? body.trim().split(/\s+/).length : 0;
    $('#w-review').innerHTML = `
      <div><b>name</b> ${esc($('#w-name').value)}</div>
      <div><b>from</b> ${esc(profile ? `${profile.name} <${profile.from_email}>` : '—')}</div>
      <div><b>to</b> ${esc(group ? `${group.name} (${group.active} active)` : '—')}</div>
      <div><b>content</b> ${esc(set ? `set #${set.id} ${set.name} (${set.mode}, ${set.count} variants)` : tpl ? `template #${tpl.id} ${tpl.name}` : 'inline body')}</div>
      <div><b>body</b> ${words} words</div>
      <div><b>pacing</b> ${min}–${max}s between sends</div>
      <div><b>caps</b> ${$('#w-daily').value}/day · ${$('#w-total').value} total</div>
      <div><b>window</b> ${esc($('#w-start').value)}–${esc($('#w-end').value)} ${esc($('#w-tz').value)}</div>
      <div><b>mode</b> ${$('#w-dryrun').checked ? 'DRY RUN (nothing is sent)' : '<span style="color:var(--red)">LIVE — real email</span>'}</div>
      <div><b>guard</b> ${$('#w-strict').checked ? 'strict (block failing copy)' : 'warn only'}</div>`;
  }

  async function next() {
    const problem = validate(step);
    if (problem) { toast(problem, 'warn'); return; }
    await persist(step);
    if (step < 3) {
      step += 1;
      renderStep();
      return;
    }
    const res = await post(`/api/campaigns/${draftId}/launch`);
    toast(`campaign #${draftId} scheduled`);
    close();
    window.APP.loadCampaigns().catch(showError);
    return res;
  }

  async function saveDraft() {
    const problem = validate(step);
    if (problem && step !== 3) { toast(problem, 'warn'); return; }
    await persist(Math.min(step, 3));
    toast(`draft #${draftId} saved`);
    window.APP.loadCampaigns().catch(showError);
  }

  async function back() {
    if (draftId) {
      try { await persist(step); } catch { /* keep going, it is a draft */ }
    }
    step = Math.max(1, step - 1);
    renderStep();
  }

  function init() {
    $('#wizard-close').addEventListener('click', close);
    $('#wizard-next').addEventListener('click', () => next().catch(showError));
    $('#wizard-back').addEventListener('click', () => back().catch(showError));
    $('#wizard-save').addEventListener('click', () => saveDraft().catch(showError));
    $('#wizard').addEventListener('click', (e) => {
      if (e.target.id === 'wizard') close();
    });

    const bind = (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        if (id === 'w-min') { $('#w-min-val').textContent = el.value; renderRiskHint(); }
        if (id === 'w-max') $('#w-max-val').textContent = el.value;
        updatePreview();
        if (step === 3) renderReview();
      });
      el.addEventListener('change', () => {
        updatePreview();
        if (step === 3) renderReview();
      });
    };
    ['w-subject', 'w-body', 'w-min', 'w-max', 'w-daily', 'w-total',
     'w-start', 'w-end', 'w-tz', 'w-dryrun', 'w-strict', 'w-risk',
     'w-set', 'w-template', 'w-group', 'w-profile', 'w-name'].forEach(bind);

    $('#w-set').addEventListener('change', () => {
      if ($('#w-set').value) $('#w-template').value = '';
    });
    $('#w-template').addEventListener('change', () => { if ($('#w-template').value) $('#w-set').value = ''; });
    renderVarChips();
  }

  return { init, open, close, refreshOptions, mdToHtml, renderVars };
})();
