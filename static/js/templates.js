/* Templates tab: sets, drag-reorder, editor with live preview, tone check,
   and the Gemini generation modal with Accept / Regenerate / Edit. */

window.TEMPLATES = (() => {
  const { $, $$, esc, toast, get, post, patch, del, confirmAction, showError,
          modal, debounce } = window.APP;

  const VARS = ['first_name', 'last_name', 'company', 'email', 'our_team'];
  const SAMPLE = { first_name: 'Alex', last_name: 'Rivera', company: 'Northwind',
                   email: 'alex@example.com', our_team: 'the team' };

  let sets = [];
  let activeSetId = null;
  let editing = null;          // template id or null
  let generated = [];          // [{name, subject, body, pass, reasons, accepted}]
  let genBusy = false;

  // ------------------------------------------------------------- rendering
  function fillVars(text) {
    return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, k) => SAMPLE[k] ?? '');
  }

  function mdToHtml(md) {
    return window.WIZARD.mdToHtml(fillVars(md));
  }

  async function load() {
    const [{ sets: list }, { templates }] = await Promise.all([
      get('/api/template-sets'), get('/api/templates'),
    ]);
    sets = list || [];
    renderSets();
    if (!editing && templates.length) {
      editing = templates[0].id;
      await openTemplate(editing);
    } else if (!editing) {
      renderEditor(null);
    }
  }

  function renderSets() {
    const box = $('#sets-list');
    const groups = {};
    sets.forEach((s) => { (groups[s.kind] = groups[s.kind] || []).push(s); });
    box.innerHTML = '';
    if (!sets.length) {
      box.innerHTML = '<p class="muted small">no sets yet — generate one or create one</p>';
      $('#set-detail').textContent = '';
      return;
    }
    ['auto_send', 'auto_reply', 'manual'].forEach((kind) => {
      const list = groups[kind];
      if (!list) return;
      const label = document.createElement('div');
      label.className = 'set-group-label';
      label.textContent = kind.replace('_', ' ');
      box.appendChild(label);
      list.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'set-item' + (s.id === activeSetId ? ' active' : '');
        item.innerHTML = `<span>${esc(s.name)}</span><span class="count">${s.count}</span>`;
        item.addEventListener('click', () => selectSet(s.id));
        box.appendChild(item);
      });
    });
  }

  function selectSet(sid) {
    activeSetId = sid;
    renderSets();
    renderSetDetail();
  }

  function renderSetDetail() {
    const box = $('#set-detail');
    const set = sets.find((s) => s.id === activeSetId);
    if (!set) {
      box.innerHTML = '<span class="muted">select a set</span>';
      return;
    }
    box.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <b style="margin-right:auto">${esc(set.name)} <span class="muted small">#${set.id}</span></b>
        <select id="set-mode">
          <option value="round_robin">round robin</option>
          <option value="random">random</option>
          <option value="weighted">weighted</option>
        </select>
        <button class="btn btn-sm" id="set-add">add template</button>
        <button class="btn btn-sm btn-danger" id="set-delete">delete set</button>
      </div>
      <div id="set-items"></div>
      <p class="muted small" style="margin-top:10px">
        drag rows to reorder · position is the round-robin order · weight is used in weighted mode
      </p>`;
    $('#set-mode').value = set.mode;
    $('#set-mode').addEventListener('change', async () => {
      await patch(`/api/template-sets/${set.id}`, { mode: $('#set-mode').value });
      set.mode = $('#set-mode').value;
      toast(`mode set to ${set.mode}`);
    });
    $('#set-add').addEventListener('click', () => addExistingTemplate(set));
    $('#set-delete').addEventListener('click', () => deleteSet(set));
    renderSetItems(set);
  }

  function renderSetItems(set) {
    const box = $('#set-items');
    const items = set.items || [];
    box.innerHTML = items.length ? '' : '<p class="muted small">this set is empty</p>';
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'tpl-item';
      row.draggable = true;
      row.dataset.itemId = item.item_id;
      row.innerHTML = `
        <span class="pos">${index + 1}</span>
        <span class="name">${esc(item.name)} <span class="muted small">· ${esc(item.kind)}</span>
          ${item.tone_check_passed === 0 ? '<span class="pill pill-red" style="margin-left:6px">tone fail</span>' : ''}
        </span>
        <input class="weight" type="number" min="1" value="${item.weight || 1}" title="weight" data-weight="${item.item_id}">
        <button class="btn btn-sm" data-open="${item.id}">edit</button>
        <button class="btn btn-sm btn-ghost" data-remove="${item.item_id}">remove</button>`;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(item.item_id));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        const dragged = e.dataTransfer.getData('text/plain');
        if (!dragged || dragged === String(item.item_id)) return;
        const order = items.map((i) => i.item_id).filter((id) => String(id) !== dragged);
        const targetIndex = order.indexOf(item.item_id);
        order.splice(targetIndex, 0, Number(dragged));
        await post(`/api/template-sets/${set.id}/reorder`, { item_ids: order });
        await load();
        selectSet(set.id);
      });
      box.appendChild(row);
    });

    $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => openTemplate(Number(b.dataset.open))));
    $$('[data-remove]', box).forEach((b) => b.addEventListener('click', async () => {
      await del(`/api/template-sets/${set.id}/items/${b.dataset.remove}`);
      await load();
      selectSet(set.id);
    }));
    $$('[data-weight]', box).forEach((inp) => inp.addEventListener('change', async () => {
      const weight = Math.max(1, Number(inp.value) || 1);
      inp.value = weight;
      try {
        await patch(`/api/template-sets/${set.id}/items/${inp.dataset.weight}`,
                    { weight });
        const item = items.find((i) => String(i.item_id) === inp.dataset.weight);
        if (item) item.weight = weight;
        toast(`weight set to ${weight}`);
      } catch (err) { showError(err); }
    }));
  }

  async function deleteSet(set) {
    const ok = await confirmAction('delete set',
      `Delete set “${esc(set.name)}”? Templates inside are kept, the set is not.`, 'delete', true);
    if (!ok) return;
    await del(`/api/template-sets/${set.id}`);
    if (activeSetId === set.id) activeSetId = null;
    await load();
    renderSetDetail();
  }

  async function addExistingTemplate(set) {
    const { templates } = await get('/api/templates');
    const options = (templates || []).map((t) =>
      `<option value="${t.id}">#${t.id} ${esc(t.name)} · ${esc(t.kind)}</option>`).join('');
    const m = modal('add template to set', `
      <label>template<select id="add-tpl">${options}</select></label>`,
      [{ label: 'cancel', kind: 'btn-ghost' },
       { label: 'add', kind: 'btn-primary', onClick: async () => {
         const id = Number($('#add-tpl').value);
         if (!id) return true;
         await post(`/api/template-sets/${set.id}/items`, { template_id: id });
         if (activeSetId === null) activeSetId = set.id;
         await load(); selectSet(set.id); toast('template added');
         return false;
       } }]);
    return m;
  }

  // ---------------------------------------------------------------- editor
  function renderEditor(tpl) {
    $('#template-editor-title').textContent = tpl ? `template · ${tpl.name}` : 'new template';
    $('#tpl-name').value = tpl?.name || '';
    $('#tpl-kind').value = tpl?.kind || 'auto_send';
    $('#tpl-subject').value = tpl?.subject_tpl || '';
    $('#tpl-body').value = tpl?.body_md || '';
    $('#tpl-chips').innerHTML = VARS.map((v) => `<span class="chip" data-var="${v}">{{${v}}}</span>`).join('');
    $$('#tpl-chips [data-var]').forEach((c) => c.addEventListener('click', () => {
      const target = document.activeElement === $('#tpl-subject') ? $('#tpl-subject') : $('#tpl-body');
      const token = `{{${c.dataset.var}}}`;
      const s = target.selectionStart ?? target.value.length;
      target.value = target.value.slice(0, s) + token + target.value.slice(s);
      target.focus();
      target.selectionStart = target.selectionEnd = s + token.length;
      updatePreview();
    }));
    $('#tpl-delete').hidden = !tpl;
    $('#tpl-rewrite').hidden = !tpl;
    $('#tpl-guard').hidden = true;
    updatePreview();
  }

  async function openTemplate(tid) {
    try {
      const tpl = await get(`/api/templates/${tid}`);
      editing = tid;
      renderEditor(tpl);
      $('#template-editor-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showError(err);
    }
  }

  function updatePreview() {
    const subject = fillVars($('#tpl-subject').value);
    const body = fillVars($('#tpl-body').value);
    $('#tpl-preview-subject').textContent = subject || 'subject preview';
    $('#tpl-preview-body').innerHTML = mdToHtml(body) || '<p class="muted">body preview</p>';
    const words = body.trim() ? body.trim().split(/\s+/).length : 0;
    $('#tpl-count').textContent = `${words} words · ${body.length} chars` +
      (words > 180 ? ' · over the 180 word cap' : words > 120 ? ' · over the auto-reply cap' : '');
  }

  async function saveTemplate() {
    const payload = {
      name: $('#tpl-name').value.trim() || 'untitled',
      kind: $('#tpl-kind').value,
      subject_tpl: $('#tpl-subject').value,
      body_md: $('#tpl-body').value,
    };
    if (editing) {
      await patch(`/api/templates/${editing}`, payload);
      toast('template saved');
    } else {
      const created = await post('/api/templates', payload);
      editing = created.id;
      toast(`template #${created.id} created`);
    }
    await load();
    if (activeSetId) selectSet(activeSetId);
  }

  async function toneCheck(useLlm) {
    const box = $('#tpl-guard');
    box.hidden = false;
    box.className = 'guard-result';
    box.textContent = useLlm ? 'checking locally and with the model…' : 'checking…';
    try {
      const res = await post('/api/templates/tone-check', {
        text: $('#tpl-body').value,
        subject: $('#tpl-subject').value,
        use_llm: !!useLlm,
      });
      const reasons = res.reasons || (res.local?.reasons || []);
      const pass = res.pass ?? res.local?.pass;
      box.className = `guard-result ${pass ? 'ok' : 'bad'}`;
      const llm = res.llm ? `\nmodel: ${res.llm.pass === null ? 'unavailable' : (res.llm.pass ? 'pass' : 'fail')}` : '';
      box.textContent = (pass ? '✓ passes the content guard' : '✗ fails the content guard') +
        (reasons.length ? '\n· ' + reasons.join('\n· ') : '') + llm;
    } catch (err) {
      box.className = 'guard-result bad';
      box.textContent = `✗ ${err.message}`;
    }
  }

  async function rewriteWithModel() {
    const box = $('#tpl-guard');
    box.hidden = false;
    box.className = 'guard-result';
    box.textContent = 'rewriting…';
    try {
      const res = await post('/api/gemini/rewrite', { text: $('#tpl-body').value });
      $('#tpl-body').value = res.text;
      updatePreview();
      box.className = `guard-result ${res.pass ? 'ok' : 'bad'}`;
      box.textContent = (res.pass ? '✓ rewritten and passing' : 'rewritten, still failing') +
        (res.local_check.reasons?.length ? '\n· ' + res.local_check.reasons.join('\n· ') : '');
    } catch (err) {
      box.className = 'guard-result bad';
      box.textContent = `✗ ${err.message}`;
    }
  }

  // --------------------------------------------------------------- gemini
  async function openGenerate() {
    generated = [];
    $('#gen-results').innerHTML = '';
    $('#gen-status').textContent = '';
    try {
      const { files } = await get('/api/gemini/knowledge');
      $('#gen-knowledge').innerHTML = files.map((f) => `
        <label class="mini-check"><input type="checkbox" data-kf="${esc(f.name)}"
          ${f.exists ? 'checked' : 'disabled'}> ${esc(f.name)}${f.exists ? '' : ' (missing)'}</label>`).join('');
    } catch { /* knowledge list is optional */ }
    $('#gen-modal').hidden = false;
  }

  async function runGenerate() {
    if (genBusy) return;
    genBusy = true;
    const status = $('#gen-status');
    status.textContent = 'asking gemini…';
    const knowledge = $$('#gen-knowledge input:checked').map((c) => c.dataset.kf);
    try {
      const res = await post('/api/gemini/generate', {
        kind: $('#gen-kind').value,
        count: Number($('#gen-count').value) || 3,
        angle: $('#gen-angle').value.trim(),
        knowledge,
      });
      generated = (res.templates || []).map((t) => ({ ...t, accepted: false }));
      renderGenerated();
      status.textContent = `${generated.filter((g) => g.pass).length}/${generated.length} passed the local guard`;
    } catch (err) {
      status.textContent = `✗ ${err.message}`;
    } finally {
      genBusy = false;
    }
  }

  function renderGenerated() {
    const box = $('#gen-results');
    box.innerHTML = '';
    generated.forEach((tpl, index) => {
      const card = document.createElement('div');
      card.className = `gen-card ${tpl.pass ? '' : 'fail'} ${tpl.accepted ? 'accepted' : ''}`;
      card.innerHTML = `
        <div class="gname">${esc(tpl.name)} · ${tpl.words} words</div>
        <div class="gsubject">${esc(tpl.subject || '(no subject)')}</div>
        <div class="gbody">${esc(tpl.body)}</div>
        ${tpl.pass ? '' : `<div class="greasons">${esc((tpl.reasons || []).slice(0, 3).join(' · '))}</div>`}
        <div class="row">
          <button class="btn btn-sm ${tpl.accepted ? 'btn-ghost' : 'btn-primary'}" data-accept="${index}">
            ${tpl.accepted ? 'accepted' : 'accept'}</button>
          <button class="btn btn-sm" data-regen="${index}">regenerate</button>
          <button class="btn btn-sm btn-ghost" data-edit="${index}">edit</button>
        </div>`;
      box.appendChild(card);
    });

    $$('[data-accept]', box).forEach((b) => b.addEventListener('click', async () => {
      const index = Number(b.dataset.accept);
      const tpl = generated[index];
      if (tpl.accepted) return;
      if (!tpl.pass) {
        toast('failed tone check — edit or regenerate before accepting', 'warn');
        return;
      }
      const res = await post('/api/gemini/accept', {
        templates: [tpl], kind: $('#gen-kind').value,
        set_name: `${$('#gen-kind').value} · ${tpl.name}`,
      });
      tpl.accepted = true;
      renderGenerated();
      toast(`accepted into set #${res.set_id}`);
      await load();
    }));

    $$('[data-regen]', box).forEach((b) => b.addEventListener('click', async () => {
      const index = Number(b.dataset.regen);
      const old = generated[index];
      try {
        const res = await post('/api/gemini/generate', {
          kind: $('#gen-kind').value, count: 1,
          angle: $('#gen-angle').value.trim() || old.name,
        });
        if (res.templates?.length) generated[index] = { ...res.templates[0], accepted: false };
        renderGenerated();
      } catch (err) { toast(err.message, 'error'); }
    }));

    $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => {
      const index = Number(b.dataset.edit);
      const tpl = generated[index];
      const m = modal('edit generated template', `
        <label>subject<input id="g-edit-subject" type="text" value="${esc(tpl.subject)}"></label>
        <label>body<textarea id="g-edit-body" rows="10">${esc(tpl.body)}</textarea></label>`,
        [{ label: 'cancel', kind: 'btn-ghost' },
         { label: 'save + check', kind: 'btn-primary', onClick: async () => {
           const subject = $('#g-edit-subject').value;
           const body = $('#g-edit-body').value;
           const check = await post('/api/templates/tone-check', { text: body, subject });
           tpl.subject = subject;
           tpl.body = body;
           tpl.body_html = window.WIZARD.mdToHtml(body);
           tpl.words = body.trim() ? body.trim().split(/\s+/).length : 0;
           tpl.pass = !!check.pass;
           tpl.reasons = check.reasons || [];
           tpl.accepted = false;
           renderGenerated();
           return false;
         } }]);
      return m;
    }));
  }

  async function acceptAll() {
    const good = generated.filter((t) => t.pass && !t.accepted);
    if (!good.length) { toast('nothing passing to accept', 'warn'); return; }
    const res = await post('/api/gemini/accept', {
      templates: good,
      kind: $('#gen-kind').value,
      set_name: `Gemini ${$('#gen-kind').value} ${$('#gen-angle').value || ''}`.trim(),
    });
    good.forEach((t) => { t.accepted = true; });
    renderGenerated();
    toast(`${good.length} templates saved as set #${res.set_id}`);
    await load();
    selectSet(res.set_id);
    $('#gen-modal').hidden = true;
  }

  // ------------------------------------------------------------------ init
  function init() {
    $('#open-generate').addEventListener('click', () => openGenerate().catch(showError));
    $('#gen-close').addEventListener('click', () => { $('#gen-modal').hidden = true; });
    $('#gen-cancel').addEventListener('click', () => { $('#gen-modal').hidden = true; });
    $('#gen-run').addEventListener('click', () => runGenerate().catch(showError));
    $('#gen-accept').addEventListener('click', () => acceptAll().catch(showError));
    $('#gen-modal').addEventListener('click', (e) => {
      if (e.target.id === 'gen-modal') $('#gen-modal').hidden = true;
    });

    $('#new-set').addEventListener('click', async () => {
      const name = prompt('set name');
      if (!name) return;
      const created = await post('/api/template-sets', {
        name, kind: 'auto_send', mode: 'round_robin',
      });
      await load();
      selectSet(created.id);
      toast(`set #${created.id} created`);
    });

    $('#tpl-save').addEventListener('click', () => saveTemplate().catch(showError));
    $('#tpl-delete').addEventListener('click', async () => {
      if (!editing) return;
      const ok = await confirmAction('delete template', 'Delete this template? It is removed from every set.', 'delete', true);
      if (!ok) return;
      await del(`/api/templates/${editing}`);
      editing = null;
      renderEditor(null);
      await load();
    });
    $('#tpl-tone-check').addEventListener('click', () => toneCheck(false).catch(showError));
    $('#tpl-rewrite').addEventListener('click', () => rewriteWithModel().catch(showError));
    $('#tpl-body').addEventListener('input', debounce(updatePreview, 120));
    $('#tpl-subject').addEventListener('input', debounce(updatePreview, 120));
  }

  return { init, load, openGenerate, openTemplate };
})();
