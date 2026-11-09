/* local-ops dashboard: tabs, websocket, fetch wrappers, every panel's runtime.
   Vanilla ES2020, no build step. Load order: app.js, campaign-wizard.js,
   templates.js, cf.js — each later file calls back into window.APP. */

const APP = (() => {
  // ------------------------------------------------------------------ utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtNum = (n) => Number(n ?? 0).toLocaleString('en-US');

  const fmtAge = (iso) => {
    if (!iso) return '—';
    const then = Date.parse(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
    if (Number.isNaN(then)) return iso;
    const s = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };

  const fmtUptime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };

  let toastTimer = null;
  const toast = (msg, kind = '') => {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  };

  const modal = (title, bodyHtml, buttons) => {
    const wrap = $('#generic-modal');
    $('#generic-title').textContent = title;
    $('#generic-body').innerHTML = bodyHtml;
    const foot = $('#generic-foot');
    foot.innerHTML = '';
    (buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = `btn ${b.kind || ''}`;
      btn.textContent = b.label;
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          const keep = await b.onClick();
          if (keep) return;
        }
        wrap.hidden = true;
      });
      foot.appendChild(btn);
    });
    wrap.hidden = false;
    return { close: () => { wrap.hidden = true; } };
  };

  const confirmAction = (title, message, confirmLabel = 'confirm', danger = false) => {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      modal(title, `<p>${message}</p>`, [
        { label: 'cancel', kind: 'btn-ghost', onClick: () => done(false) },
        { label: confirmLabel, kind: danger ? 'btn-danger' : 'btn-primary', onClick: () => done(true) },
      ]);
      $('#generic-close').onclick = () => { $('#generic-modal').hidden = true; done(false); };
    });
  };

  // ---------------------------------------------------------------- fetch
  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', ...options };
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    if (res.status === 401) {
      window.location.replace('/');
      throw new Error('session expired');
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const detail = data.detail || data.error || `${res.status} ${res.statusText}`;
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return data;
  }

  const get = (p) => api(p);
  const post = (p, body) => api(p, { method: 'POST', body: body || {} });
  const patch = (p, body) => api(p, { method: 'PATCH', body: body || {} });
  const del = (p) => api(p, { method: 'DELETE' });

  // ----------------------------------------------------------------- state
  const state = {
    tab: 'dashboard',
    settings: {},
    campaigns: [],
    groups: [],
    profiles: [],
    sets: [],
    health: null,
    stats: null,
    watchdog: [],
    logTab: null,
    leads: { offset: 0, limit: 100, total: 0, selected: new Set(), rows: [] },
    editingProfile: null,
    editingTemplate: null,
    editingRule: null,
    editingSet: null,
  };

  const on = (el, event, handler) => { if (el) el.addEventListener(event, handler); };

  // --------------------------------------------------------------- tabs
  function initTabs() {
    $$('#tabs .tab').forEach((tab) => {
      on(tab, 'click', () => showTab(tab.dataset.tab));
    });
  }

  function showTab(name) {
    state.tab = name;
    $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    const loaders = {
      dashboard: refreshDashboard,
      campaigns: loadCampaigns,
      templates: () => window.TEMPLATES?.load(),
      leads: () => loadLeads(),
      profiles: loadProfiles,
      autoreply: loadAutoReply,
      telegram: loadTelegram,
      cloudflare: () => window.CF?.load(),
      settings: loadSettings,
    };
    if (loaders[name]) Promise.resolve(loaders[name]()).catch(showError);
  }

  function showError(err) {
    console.error(err);
    toast(err.message || String(err), 'error');
  }

  // ------------------------------------------------------------ websocket
  let socket = null;
  let retry = 1000;

  function connectSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    const pill = $('#status-ws');

    const dot = $('#status-socket');
    socket.addEventListener('open', () => {
      retry = 1000;
      pill.textContent = 'connected';
      pill.className = 'pill pill-grey';
      if (dot) dot.classList.add('on');
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'hello') {
        const stream = $('#event-stream');
        stream.innerHTML = '';
        (msg.history || []).forEach((h) => pushEvent(h, false));
        return;
      }
      if (msg.type === 'ping') return;
      if (msg.type === 'event') {
        pushEvent({ ts: msg.ts, source: msg.source, message: msg.message,
                    level: msg.level, lane: msg.lane });
      } else if (msg.type === 'ashley') {
        pushEvent({ ts: msg.ts, source: 'ashley', message: msg.message,
                    level: 'warning', lane: 'ashley_reasoning' });
      } else if (msg.type === 'send') {
        pushEvent({ ts: msg.ts, source: `send #${msg.campaign_id}`,
                    message: `${msg.event} → ${msg.to || ''} ${msg.error || ''}`.trim(),
                    level: msg.event === 'failed' ? 'error' : 'info' });
      } else if (msg.type === 'alert') {
        pushEvent({ source: 'alert', message: msg.message, level: msg.level });
        toast(msg.message, msg.level === 'error' ? 'error' : 'warn');
      } else if (msg.type === 'campaign') {
        pushEvent({ source: 'campaign', message: `#${msg.campaign_id} ${msg.event} ${msg.reason || ''}`.trim() });
        if (state.tab === 'campaigns') loadCampaigns().catch(() => {});
      } else if (msg.type === 'watchdog') {
        state.watchdog = msg.workers || [];
        renderWatchdog();
      } else if (msg.type === 'settings') {
        if (state.tab === 'settings') loadSettings().catch(() => {});
        if (state.tab === 'telegram') loadTelegram().catch(() => {});
        if (state.tab === 'dashboard') refreshDashboard().catch(() => {});
      }
    });

    socket.addEventListener('close', () => {
      pill.textContent = 'offline';
      pill.className = 'pill pill-red';
      if (dot) dot.classList.remove('on');
      setTimeout(connectSocket, retry);
      retry = Math.min(retry * 1.8, 15000);
    });

    socket.addEventListener('error', () => socket.close());
  }

  // Lanes get a badge so Ashley's reasoning is distinguishable from machine logs.
  const LANES = {
    ai_chat: { label: 'ashley', cls: 'lane-chat' },
    ashley_reasoning: { label: 'thinking', cls: 'lane-think' },
    self_upgrade: { label: 'upgrade', cls: 'lane-upgrade' },
  };

  function pushEvent(evt, scroll = true) {
    const stream = $('#event-stream');
    if (!stream) return;
    const line = document.createElement('div');
    line.className = `stream-line ${evt.level || 'info'}`;
    const ts = evt.ts ? new Date(evt.ts.includes('T') ? evt.ts : evt.ts.replace(' ', 'T') + 'Z')
      .toLocaleTimeString('en-GB') : new Date().toLocaleTimeString('en-GB');
    const lane = evt.lane && LANES[evt.lane]
      ? `<span class="lane ${LANES[evt.lane].cls}">${LANES[evt.lane].label}</span>`
      : '';
    line.innerHTML = `<span class="ts">${esc(ts)}</span>` +
      `<span class="src" title="${esc(evt.source || '')}">${esc(evt.source || '')}</span>` + lane +
      `<span class="msg">${esc(evt.message || '')}</span>`;
    if (evt.lane) line.classList.add('laned');
    stream.appendChild(line);
    while (stream.children.length > 300) stream.removeChild(stream.firstChild);
    if (scroll && $('#stream-autoscroll').checked) stream.scrollTop = stream.scrollHeight;
  }

  // ------------------------------------------------------------ dashboard
  async function refreshDashboard() {
    const data = await get('/api/dashboard');
    state.health = data.kpi;
    $('#kpi-running').textContent = fmtNum(data.kpi.campaigns_running);
    $('#kpi-sent').textContent = fmtNum(data.kpi.sent_today);
    $('#kpi-dry').textContent = fmtNum(data.kpi.dry_run_today);
    // A bare "0 sent" while dry-run is on reads like a fault. Say what it means.
    const dryOn = !!data.kpi.dry_run;
    const note = $('#kpi-sent-note');
    $('#kpi-sent-label').textContent = dryOn ? 'delivered today' : 'sent today';
    if (dryOn && data.kpi.dry_run_today > 0) {
      note.textContent = `${data.kpi.dry_run_today} simulated, nothing delivered`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
    $('#kpi-queue').textContent = fmtNum(data.kpi.queue_depth);
    $('#kpi-errors').textContent = fmtNum(data.kpi.errors_24h);
    $('#kpi-errors').classList.toggle('bad', data.kpi.errors_24h > 0);
    $('#kpi-contacts').textContent = fmtNum(data.kpi.contacts);
    setDryPill(data.kpi.dry_run);
    setHaltPill(data.kpi.global_halt);
    renderDeliverability(data.deliverability);
    renderWatchdogFrom((data.watchdog || []).map((w) => ({
      ...w,
      campaign_name: (data.campaigns || []).find((c) => c.id === w.campaign_id)?.name,
    })));
    renderDashCampaigns(data.campaigns || []);
    renderWarmup(data.warmup || {});
  }

  function setDryPill(isDry) {
    const pill = $('#status-dryrun');
    pill.textContent = isDry ? 'DRY' : 'LIVE';
    pill.className = isDry ? 'pill pill-amber' : 'pill pill-red';
  }

  function setHaltPill(halted) {
    $('#status-halt').hidden = !halted;
  }

  async function pollHealth() {
    try {
      const h = await get('/api/health');
      const pill = $('#status-uplink');
      pill.textContent = `up ${fmtUptime(h.uptime_s)}`;
      pill.className = 'pill pill-grey';
      setDryPill(h.dry_run);
      setHaltPill(h.global_halt);
      if (state.tab === 'dashboard') {
        $('#kpi-running').textContent = fmtNum(h.campaigns_running);
        $('#kpi-queue').textContent = fmtNum(h.queue_depth);
        $('#kpi-sent').textContent = fmtNum(h.sent_today);
      }
    } catch {
      const pill = $('#status-uplink');
      pill.textContent = 'down';
      pill.className = 'pill pill-red';
    }
  }

  function renderDeliverability(d) {
    const banner = $('#deliverability-banner');
    if (!d) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    if (d.unchecked) {
      banner.className = 'banner banner-grey';
      banner.innerHTML = `SPF/DKIM/DMARC not checked for <b>${esc(d.domain)}</b>. ` +
        `<a href="#" data-goto="settings">run the doctor</a>`;
    } else if (d.ok) {
      banner.className = 'banner banner-green';
      banner.textContent = `Authentication complete for ${d.domain} — SPF ✓ DKIM ✓ DMARC ✓`;
    } else {
      const miss = [['spf', 'SPF'], ['dkim', 'DKIM'], ['dmarc', 'DMARC']]
        .filter(([k]) => !d[k]).map(([, label]) => label);
      banner.className = 'banner banner-red';
      banner.innerHTML = `Authentication incomplete for <b>${esc(d.domain)}</b> ` +
        `(missing ${esc(miss.join(', '))}) — deliverability at risk. ` +
        `<a href="#" data-goto="settings">open settings</a>`;
    }
    const link = banner.querySelector('a[data-goto]');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); showTab('settings'); });
  }

  function renderWatchdogFrom(rows) {
    state.watchdog = rows;
    renderWatchdog();
  }

  function renderWatchdog() {
    const box = $('#watchdog-panel');
    if (!box) return;
    // One row per campaign, newest heartbeat wins. Older builds could leave a
    // legacy 'send' row alongside the per-campaign one.
    const byCampaign = new Map();
    (state.watchdog || []).forEach((w) => {
      const key = w.campaign_id ?? w.worker_id;
      const prev = byCampaign.get(key);
      if (!prev || String(w.heartbeat_at || '') > String(prev.heartbeat_at || '')) {
        byCampaign.set(key, w);
      }
    });
    const rows = Array.from(byCampaign.values());
    if (!rows.length) {
      box.innerHTML = '<p class="muted small">no workers reporting</p>';
      return;
    }
    box.innerHTML = rows.map((w) => {
      const status = (w.status || 'unknown');
      const cls = status === 'failed' ? 'pill pill-red'
        : status === 'stale' || status === 'restarting' ? 'pill pill-amber'
        : status === 'no_heartbeat' ? 'pill pill-grey' : 'pill pill-green';
      const hb = w.heartbeat_at
        ? `${fmtAge(w.heartbeat_at)} ago`
        : 'never reported';
      const absurd = w.heartbeat_at && /^\d{5,}/.test(fmtAge(w.heartbeat_at));
      return `
      <div class="list-row">
        <span class="grow">#${w.campaign_id ?? '—'}${
          w.campaign_name ? ' ' + esc(w.campaign_name) : ''}</span>
        <span class="${cls}">${esc(status.replace('_', ' '))}</span>
        <span class="muted small" ${absurd ? 'title="heartbeat predates the current build; it will clear on the next tick"' : ''}>` +
        `hb ${absurd ? 'stale row' : esc(hb)}</span>
        <span class="muted small">restarts ${w.restarts ?? 0}</span>
      </div>`;
    }).join('');
  }

  function renderDashCampaigns(rows) {
    const box = $('#dash-campaigns');
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = '<p class="muted small">nothing scheduled or running</p>';
      return;
    }
    box.innerHTML = rows.map((c) => `
      <div class="list-row">
        <span class="grow">#${c.id} ${esc(c.name)}</span>
        <span class="status status-${esc(c.status)}">${esc(c.status)}</span>
        <span class="muted small">${c.dry_run ? 'dry' : 'live'}</span>
      </div>`).join('');
  }

  function renderWarmup(w) {
    const box = $('#warmup-panel');
    if (!box) return;
    box.textContent = w.enabled
      ? `day ${w.day + 1} · effective cap ${fmtNum(w.effective_cap)}`
      : 'disabled — sending against the global daily cap only';
  }

  // ------------------------------------------------------------ campaigns
  async function loadCampaigns() {
    const [{ campaigns }, sets] = await Promise.all([get('/api/campaigns'), get('/api/template-sets')]);
    state.campaigns = campaigns;
    state.sets = sets.sets || [];
    const tbody = $('#campaign-table tbody');
    tbody.innerHTML = campaigns.length ? '' : '<tr><td colspan="9" class="muted">no campaigns yet</td></tr>';
    campaigns.forEach((c) => {
      const pct = c.percent || 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${c.id}</td>
        <td>${esc(c.name)}</td>
        <td><span class="status status-${esc(c.status)}">${esc(c.status)}</span></td>
        <td>
          <div class="muted small">${c.sent || 0}/${c.total || 0} (${pct}%)</div>
          <div class="progress-line"><span style="width:${pct}%"></span></div>
        </td>
        <td>${c.interval_min_sec}–${c.interval_max_sec}s</td>
        <td>${c.daily_cap}/d · ${c.total_cap}</td>
        <td>${esc(c.window_start)}–${esc(c.window_end)}<br><span class="muted small">${esc(c.timezone)}</span></td>
        <td>${c.template_set_id
          ? `<span class="mono small">set #${c.template_set_id}</span>`
          : '<span class="muted small">inline</span>'}<br>${c.dry_run
          ? '<span class="pill pill-amber">dry run</span>'
          : '<span class="pill pill-red">live</span>'}</td>
        <td class="actions"></td>`;
      const actions = tr.querySelector('.actions');
      const add = (label, kind, fn) => {
        const b = document.createElement('button');
        b.className = `btn btn-sm ${kind}`;
        b.textContent = label;
        b.type = 'button';
        b.addEventListener('click', async () => {
          try { await fn(); } catch (err) { showError(err); }
        });
        actions.appendChild(b);
      };
      if (c.status !== 'paused' && c.status !== 'done' && c.status !== 'failed') {
        add('pause', '', () => post(`/api/campaigns/${c.id}/pause`).then(loadCampaigns));
      }
      if (c.status === 'paused' || c.status === 'failed') {
        add(c.status === 'failed' ? 'revive' : 'resume', 'btn-primary',
          () => post(`/api/campaigns/${c.id}/resume`).then(loadCampaigns));
      }
      if (c.status === 'draft') add('launch', 'btn-primary', () => post(`/api/campaigns/${c.id}/launch`).then(loadCampaigns));
      add('stop', '', () => post(`/api/campaigns/${c.id}/stop`).then(loadCampaigns));
      add('clone', '', () => post(`/api/campaigns/${c.id}/clone`).then(loadCampaigns));
      add('log', '', () => openCampaignLog(c.id, c.name));
      add('delete', 'btn-danger', async () => {
        const ok = await confirmAction('delete campaign', `Delete campaign #${c.id} “${esc(c.name)}” and its recipients?`, 'delete', true);
        if (!ok) return;
        await del(`/api/campaigns/${c.id}`);
        loadCampaigns();
      });
      tbody.appendChild(tr);
    });
  }

  async function openCampaignLog(cid, name) {
    const { log } = await get(`/api/campaigns/${cid}/log?limit=200`);
    $('#campaign-log-card').hidden = false;
    $('#campaign-log-title').textContent = `log · #${cid} ${name}`;
    const tbody = $('#campaign-log tbody');
    tbody.innerHTML = log.length ? '' : '<tr><td class="muted">no log rows</td></tr>';
    log.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="mono">${esc(row.ts)}</td>` +
        `<td><span class="status">${esc(row.status || '')}</span></td>` +
        `<td>${esc(row.direction || '')}</td>` +
        `<td>${esc(row.to_addr || '')}</td>` +
        `<td class="muted">${esc((row.subject || '').slice(0, 60))}</td>` +
        `<td class="muted">${esc((row.error || '').slice(0, 80))}</td>`;
      tbody.appendChild(tr);
    });
    $('#campaign-log-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function refreshLookups() {
    const [profiles, groups, sets] = await Promise.all([
      get('/api/profiles'), get('/api/leads/groups'), get('/api/template-sets'),
    ]);
    state.profiles = profiles.profiles || [];
    state.groups = groups.groups || [];
    state.sets = sets.sets || [];
    return { profiles: state.profiles, groups: state.groups, sets: state.sets };
  }

  // ---------------------------------------------------------------- leads
  async function loadLeads() {
    const [groups, stats] = await Promise.all([get('/api/leads/groups'), get('/api/leads/stats')]);
    state.groups = groups.groups || [];
    state.stats = stats;
    renderGroups();
    fillGroupSelects();
    await loadContacts();
  }

  function renderGroups() {
    const box = $('#groups-list');
    if (!box) return;
    box.innerHTML = (state.groups || []).map((g) => `
      <div class="list-row">
        <span class="grow">${esc(g.name)}</span>
        <span class="muted small">${g.count} total · ${g.active} active</span>
        <button class="btn btn-sm btn-ghost" data-rename="${g.id}">rename</button>
        <button class="btn btn-sm btn-danger" data-del-group="${g.id}">delete</button>
      </div>`).join('') || '<p class="muted small">no groups yet — import a file or create one</p>';
    $$('[data-rename]', box).forEach((b) => b.addEventListener('click', () => renameGroup(Number(b.dataset.rename))));
    $$('[data-del-group]', box).forEach((b) => b.addEventListener('click', () => deleteGroup(Number(b.dataset.delGroup))));
  }

  function fillGroupSelects() {
    const opts = (state.groups || []).map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');
    ['#lead-group-filter', '#bulk-move-group', '#import-group', '#mc-group'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      const keep = sel === '#lead-group-filter' ? el.value : el.value;
      el.innerHTML = (sel === '#lead-group-filter' ? '<option value="">all groups</option>' : '') +
        (sel === '#bulk-move-group' ? '<option value="">move to…</option>' : '') +
        (sel === '#mc-group' ? '<option value="">choose a group</option>' : '') + opts;
      el.value = keep;
    });
    window.WIZARD?.refreshOptions?.();
  }

  async function loadContacts() {
    const params = new URLSearchParams({
      limit: state.leads.limit, offset: state.leads.offset,
    });
    const q = $('#lead-search').value.trim();
    const groupId = $('#lead-group-filter').value;
    const status = $('#lead-status-filter').value;
    if (q) params.set('q', q);
    if (groupId) params.set('group_id', groupId);
    if (status) params.set('status', status);
    const data = await get(`/api/leads?${params}`);
    state.leads.total = data.total;
    state.leads.rows = data.rows || [];
    const tbody = $('#contacts-table tbody');
    tbody.innerHTML = state.leads.rows.length ? '' : '<tr><td colspan="7" class="muted">no contacts</td></tr>';
    state.leads.rows.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" data-cid="${c.id}" ${state.leads.selected.has(c.id) ? 'checked' : ''}></td>
        <td class="mono">${esc(c.email)}</td>
        <td>${esc([c.first_name, c.last_name].filter(Boolean).join(' '))}</td>
        <td>${esc(c.group_name || '—')}</td>
        <td><span class="status">${esc(c.status)}</span></td>
        <td class="muted small">${c.last_sent ? fmtAge(c.last_sent) + ' ago' : '—'}</td>
        <td>${c.replies || 0}</td>`;
      tr.querySelector('input').addEventListener('change', (e) => {
        const id = Number(e.target.dataset.cid);
        if (e.target.checked) state.leads.selected.add(id); else state.leads.selected.delete(id);
        renderBulkbar();
      });
      tbody.appendChild(tr);
    });
    $('#leads-page').textContent = `${state.leads.offset + 1}–${Math.min(state.leads.offset + state.leads.limit, data.total)} of ${data.total}`;
    $('#leads-prev').disabled = state.leads.offset === 0;
    $('#leads-next').disabled = state.leads.offset + state.leads.limit >= data.total;
    renderBulkbar();
  }

  function renderBulkbar() {
    const n = state.leads.selected.size;
    $('#lead-bulkbar').hidden = n === 0;
    $('#lead-selected').textContent = `${n} selected`;
  }

  async function renameGroup(gid) {
    const group = state.groups.find((g) => g.id === gid);
    if (!group) return;
    const name = prompt('group name', group.name);
    if (!name || name === group.name) return;
    await patch(`/api/leads/groups/${gid}`, { name });
    loadLeads().catch(showError);
  }

  async function deleteGroup(gid) {
    const group = state.groups.find((g) => g.id === gid);
    const ok = await confirmAction('delete group',
      `Delete “${esc(group?.name || gid)}” and every contact inside it?`, 'delete', true);
    if (!ok) return;
    await del(`/api/leads/groups/${gid}`);
    loadLeads().catch(showError);
  }

  let importState = null;

  async function handleFile(file) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const preview = await api('/api/leads/upload', { method: 'POST', body: form });
    importState = preview;
    $('#import-preview').hidden = false;
    $('#import-stats').innerHTML = [
      ['file', preview.filename],
      ['rows', preview.rows],
      ['valid', preview.valid],
      ['invalid', preview.invalid],
      ['dupes in file', preview.duplicates_within_file],
      ['email column', preview.email_column],
    ].map(([k, v]) => `<div><span class="muted small">${k}</span><div class="v">${esc(v)}</div></div>`).join('');
    $('#import-sample').textContent = JSON.stringify(preview.sample || [], null, 2);

    // rules.md rule 12: warn at import time, not at launch time.
    const headers = (preview.headers || []).map((h) => String(h).toLowerCase());
    const hasSource = headers.includes('source');
    $('#import-source-warn').hidden = hasSource;
    importState.hasSource = hasSource;

    fillGroupSelects();
    toast(hasSource
      ? `${preview.valid} rows ready to import`
      : `${preview.valid} rows ready — no source column, pick one below`,
      hasSource ? '' : 'warn');
  }

  async function runImport() {
    if (!importState) return;
    const groupId = $('#import-group').value;
    const groupName = $('#import-group-name').value.trim();
    if (!groupId && !groupName) {
      toast('pick a group or type a new group name', 'warn');
      return;
    }
    const payload = {
      path: importState.path,
      filename: importState.filename,
      group_id: groupId ? Number(groupId) : null,
      group_name: groupName || null,
      dedupe: $('#import-dedupe').checked,
    };
    // Stamp the chosen source onto every row that has none, so the group can
    // actually launch. Existing labels are never overwritten.
    if (importState && importState.hasSource === false) {
      payload.default_source = $('#import-source').value || 'imported_list';
    }
    const result = await post('/api/leads/import', payload);
    toast(`imported ${result.added}, skipped ${result.skipped}, invalid ${result.invalid}`);
    $('#import-preview').hidden = true;
    $('#import-source-warn').hidden = true;
    $('#import-group-name').value = '';
    importState = null;
    loadLeads().catch(showError);
    loadSourceReport().catch(() => {});
  }

  function initLeads() {
    const zone = $('#dropzone');
    const input = $('#file-input');
    on(zone, 'click', () => input.click());
    on(input, 'change', (e) => handleFile(e.target.files[0]).catch(showError));
    ['dragenter', 'dragover'].forEach((evt) => on(zone, evt, (e) => {
      e.preventDefault(); zone.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach((evt) => on(zone, evt, (e) => {
      e.preventDefault(); zone.classList.remove('drag');
    }));
    on(zone, 'drop', (e) => handleFile(e.dataTransfer.files[0]).catch(showError));
    on($('#import-run'), 'click', () => runImport().catch(showError));
    on($('#import-invalid'), 'click', async () => {
      if (!importState) return;
      const rep = await post('/api/leads/invalid-report', { path: importState.path, filename: importState.filename });
      const blob = new Blob([JSON.stringify(importState.invalid_sample, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'invalid-rows.json';
      a.click();
      toast(`invalid rows saved to ${rep.path}`);
    });
    on($('#new-group'), 'click', async () => {
      const name = prompt('new group name');
      if (!name) return;
      await post('/api/leads/groups', { name });
      loadLeads().catch(showError);
    });

    // ---- manual contact add (Gate 8) ---------------------------------
    on($('#mc-add'), 'click', async () => {
      const box = $('#mc-result');
      box.hidden = false;
      box.className = 'guard-result';
      const payload = {
        email: $('#mc-email').value.trim(),
        first_name: $('#mc-first').value.trim(),
        last_name: $('#mc-last').value.trim(),
        company: $('#mc-company').value.trim(),
        position: $('#mc-position').value.trim(),
        group_id: Number($('#mc-group').value) || null,
        source: $('#mc-source').value,
      };
      if (!payload.email) {
        box.className = 'guard-result bad';
        box.textContent = '✗ an email address is required';
        return;
      }
      try {
        const res = await post('/api/leads/contact', payload);
        box.className = 'guard-result ok';
        box.textContent = `✓ added ${res.email}`;
        ['#mc-email', '#mc-first', '#mc-last', '#mc-company', '#mc-position']
          .forEach((sel) => { $(sel).value = ''; });
        await loadLeads();
        loadSourceReport().catch(() => {});
      } catch (err) {
        box.className = 'guard-result bad';
        box.textContent = `✗ ${err.message}`;
      }
    });
    on($('#lead-search'), 'input', debounce(() => { state.leads.offset = 0; loadContacts().catch(showError); }, 320));
    on($('#lead-group-filter'), 'change', () => { state.leads.offset = 0; loadContacts().catch(showError); });
    on($('#lead-status-filter'), 'change', () => { state.leads.offset = 0; loadContacts().catch(showError); });
    on($('#leads-prev'), 'click', () => {
      state.leads.offset = Math.max(0, state.leads.offset - state.leads.limit);
      loadContacts().catch(showError);
    });
    on($('#leads-next'), 'click', () => {
      state.leads.offset += state.leads.limit;
      loadContacts().catch(showError);
    });
    on($('#contacts-all'), 'change', (e) => {
      state.leads.selected.clear();
      if (e.target.checked) state.leads.rows.forEach((c) => state.leads.selected.add(c.id));
      $$('#contacts-table tbody input[type=checkbox]').forEach((cb) => { cb.checked = e.target.checked; });
      renderBulkbar();
    });
    $$('[data-bulk]').forEach((btn) => btn.addEventListener('click', async () => {
      const action = btn.dataset.bulk;
      const ids = Array.from(state.leads.selected);
      if (!ids.length) return;
      if (action === 'delete') {
        const ok = await confirmAction('delete contacts', `Delete ${ids.length} contacts? This cannot be undone.`, 'delete', true);
        if (!ok) return;
      }
      const payload = { ids, action };
      if (action === 'move') {
        const gid = $('#bulk-move-group').value;
        if (!gid) { toast('choose a target group', 'warn'); return; }
        payload.group_id = Number(gid);
      }
      await post('/api/leads/bulk', payload);
      state.leads.selected.clear();
      loadLeads().catch(showError);
    }));
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ------------------------------------------------------------- profiles
  async function loadProfiles() {
    const { profiles } = await get('/api/profiles');
    state.profiles = profiles || [];
    const list = $('#profiles-list');
    list.innerHTML = state.profiles.length ? '' : '<p class="muted small">no send profiles yet</p>';
    state.profiles.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'list-row' + (state.editingProfile === p.id ? ' active' : '');
      row.innerHTML = `<span class="grow">${esc(p.name)} ${p.is_default ? '<span class="pill pill-green">default</span>' : ''}</span>
        <span class="muted small mono">${esc(p.from_email)}</span>
        <span class="muted small">${p.sent_today}/${p.daily_limit} today</span>`;
      row.addEventListener('click', () => editProfile(p));
      list.appendChild(row);
    });
  }

  function editProfile(profile) {
    state.editingProfile = profile ? profile.id : null;
    $('#profile-editor-title').textContent = profile ? `profile · ${profile.name}` : 'new profile';
    $('#p-name').value = profile?.name || '';
    $('#p-host').value = profile?.host || 'smtp.gmail.com';
    $('#p-port').value = profile?.port || 587;
    $('#p-username').value = profile?.username || '';
    $('#p-password').value = '';
    $('#p-from-name').value = profile?.from_name || '';
    $('#p-from-email').value = profile?.from_email || '';
    $('#p-reply-to').value = profile?.reply_to || '';
    $('#p-transport').value = profile?.use_ssl ? 'ssl' : (profile?.use_tls ? 'tls' : 'plain');
    $('#p-daily').value = profile?.daily_limit || 300;
    $('#p-default').checked = !!profile?.is_default;
    $$('#profiles-list .list-row').forEach((r, i) => r.classList.toggle('active', state.profiles[i]?.id === state.editingProfile));
    $('#test-result').hidden = true;
  }

  function profilePayload() {
    const transport = $('#p-transport').value;
    const payload = {
      name: $('#p-name').value.trim(),
      host: $('#p-host').value.trim(),
      port: Number($('#p-port').value) || 587,
      username: $('#p-username').value.trim(),
      from_name: $('#p-from-name').value.trim(),
      from_email: $('#p-from-email').value.trim(),
      reply_to: $('#p-reply-to').value.trim(),
      use_tls: transport === 'tls' ? 1 : 0,
      use_ssl: transport === 'ssl' ? 1 : 0,
      daily_limit: Number($('#p-daily').value) || 300,
      is_default: $('#p-default').checked ? 1 : 0,
    };
    const pw = $('#p-password').value;
    if (pw) payload.app_password = pw;
    return payload;
  }

  function initProfiles() {
    on($('#new-profile'), 'click', () => {
      state.editingProfile = null;
      editProfile(null);
    });
    on($('#profile-save'), 'click', async () => {
      const payload = profilePayload();
      if (!payload.name || !payload.host || !payload.from_email) {
        toast('name, host and from email are required', 'warn');
        return;
      }
      if (state.editingProfile) await patch(`/api/profiles/${state.editingProfile}`, payload);
      else await post('/api/profiles', payload);
      toast('profile saved');
      await loadProfiles();
      const saved = state.profiles.find((p) => p.id === state.editingProfile) || state.profiles[state.profiles.length - 1];
      if (saved) editProfile(saved);
    });
    on($('#profile-delete'), 'click', async () => {
      if (!state.editingProfile) return;
      const ok = await confirmAction('delete profile', 'Delete this send profile?', 'delete', true);
      if (!ok) return;
      await del(`/api/profiles/${state.editingProfile}`);
      state.editingProfile = null;
      editProfile(null);
      loadProfiles().catch(showError);
    });
    on($('#test-send'), 'click', async () => {
      const to = $('#test-to').value.trim();
      if (!to) { toast('type a recipient', 'warn'); return; }
      const box = $('#test-result');
      box.hidden = false;
      box.className = 'guard-result';
      box.textContent = 'sending…';
      try {
        const res = await post('/api/profiles/test', {
          to, profile_id: state.editingProfile,
          subject: 'local-ops test message',
          body: 'This is a test message from local-ops. If you are reading this, the send path works.',
        });
        if (res.ok) {
          box.className = 'guard-result ok';
          box.textContent = res.dry_run
            ? `dry run ✓ logged, SMTP not contacted (message id ${res.message_id})`
            : `sent ✓ to ${to} in ${res.elapsed_ms}ms`;
        } else {
          box.className = 'guard-result bad';
          box.textContent = `✗ ${res.error || 'failed'}\n` + (res.transcript || []).join('\n');
        }
      } catch (err) {
        box.className = 'guard-result bad';
        box.textContent = `✗ ${err.message}`;
      }
    });
  }

  // ------------------------------------------------------------ auto-reply
  async function loadAutoReply() {
    const [{ profiles }, { rules }, { log }] = await Promise.all([
      get('/api/imap'), get('/api/autoreply/rules'), get('/api/autoreply/log'),
    ]);
    const profile = (profiles || [])[0];
    if (profile) {
      $('#i-name').value = profile.name || '';
      $('#i-host').value = profile.host || '';
      $('#i-port').value = profile.port || 993;
      $('#i-username').value = profile.username || '';
      $('#i-password').value = '';
      $('#i-folder').value = profile.folder || 'INBOX';
      $('#i-interval').value = profile.poll_interval_value || 6;
      $('#i-unit').value = profile.poll_interval_unit || 'hours';
      $('#i-enabled').checked = !!profile.enabled;
      $('#imap-last-checked').textContent = profile.last_checked_at
        ? `last checked ${fmtAge(profile.last_checked_at)} ago` : 'never checked';
      $('#imap-save').dataset.id = profile.id;
    } else {
      $('#imap-save').dataset.id = '';
    }

    const tbody = $('#rules-table tbody');
    tbody.innerHTML = (rules || []).length ? '' : '<tr><td colspan="8" class="muted">no rules</td></tr>';
    (rules || []).forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(r.name)}</td>
        <td class="muted">${esc(r.match_type)} “${esc(r.pattern)}”</td>
        <td>${esc(r.set_name || '—')}</td>
        <td>${r.delay_value} ${esc(r.delay_unit)}</td>
        <td>${r.max_per_contact_per_day}</td>
        <td class="muted small">${r.last_fired_at ? fmtAge(r.last_fired_at) + ' ago' : 'never'}</td>
        <td>${r.enabled ? '✓' : '—'}</td>
        <td class="actions"></td>`;
      const actions = tr.querySelector('.actions');
      const edit = document.createElement('button');
      edit.className = 'btn btn-sm';
      edit.textContent = 'edit';
      edit.addEventListener('click', () => openRuleModal(r));
      const rm = document.createElement('button');
      rm.className = 'btn btn-sm btn-danger';
      rm.textContent = 'delete';
      rm.addEventListener('click', async () => {
        const ok = await confirmAction('delete rule', `Delete rule “${esc(r.name)}”?`, 'delete', true);
        if (!ok) return;
        await del(`/api/autoreply/rules/${r.id}`);
        loadAutoReply().catch(showError);
      });
      actions.append(edit, rm);
      tbody.appendChild(tr);
    });

    const logBody = $('#autoreply-log-table tbody');
    logBody.innerHTML = (log || []).length ? '' : '<tr><td colspan="6" class="muted">nothing sent yet</td></tr>';
    (log || []).forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="mono">${esc(row.created_at || row.due_at)}</td>
        <td class="mono">${esc(row.contact_email)}</td>
        <td>${esc(row.rule_name || '—')}</td>
        <td>${esc(row.template_name || '—')}</td>
        <td><span class="status">${esc(row.state)}</span></td>
        <td class="muted">${esc((row.error || '').slice(0, 90))}</td>`;
      logBody.appendChild(tr);
    });
  }

  function initAutoReply() {
    on($('#imap-save'), 'click', async () => {
      const id = $('#imap-save').dataset.id;
      const payload = {
        name: $('#i-name').value.trim(),
        host: $('#i-host').value.trim(),
        port: Number($('#i-port').value) || 993,
        username: $('#i-username').value.trim(),
        folder: $('#i-folder').value.trim() || 'INBOX',
        poll_interval_value: Number($('#i-interval').value) || 6,
        poll_interval_unit: $('#i-unit').value,
        enabled: $('#i-enabled').checked ? 1 : 0,
      };
      if ($('#i-password').value) payload.app_password = $('#i-password').value;
      if (id) await patch(`/api/imap/${id}`, payload);
      else await post('/api/imap', payload);
      toast('imap profile saved');
      loadAutoReply().catch(showError);
    });
    on($('#imap-check-now'), 'click', async () => {
      const id = $('#imap-save').dataset.id;
      if (!id) { toast('save the profile first', 'warn'); return; }
      const res = await post(`/api/imap/${id}/check`);
      toast(`polled: fetched ${res.fetched}, queued ${res.queued}${res.errors?.length ? ' — ' + res.errors[0] : ''}`);
      loadAutoReply().catch(showError);
    });
    on($('#new-rule'), 'click', () => openRuleModal(null));
    on($('#drain-queue'), 'click', async () => {
      const res = await post('/api/autoreply/drain');
      toast(`queue drained: sent ${res.sent}, failed ${res.failed}, due ${res.due}`);
      loadAutoReply().catch(showError);
    });
    initRuleModal();
  }

  function openRuleModal(rule) {
    state.editingRule = rule ? rule.id : null;
    $('#rule-modal-title').textContent = rule ? `rule · ${rule.name}` : 'new rule';
    $('#r-name').value = rule?.name || '';
    $('#r-type').value = rule?.match_type || 'subject_contains';
    $('#r-pattern').value = rule?.pattern || '';
    $('#r-delay').value = rule?.delay_value ?? 30;
    $('#r-unit').value = rule?.delay_unit || 'minutes';
    $('#r-max').value = rule?.max_per_contact_per_day ?? 1;
    $('#r-enabled').checked = rule ? !!rule.enabled : true;
    $('#r-set').innerHTML = (state.sets || []).map((s) => `<option value="${s.id}">#${s.id} ${esc(s.name)}</option>`).join('');
    if (rule?.template_set_id) $('#r-set').value = rule.template_set_id;
    $('#r-test-result').textContent = '';
    $('#rule-modal').hidden = false;
  }

  function initRuleModal() {
    on($('#rule-close'), 'click', () => { $('#rule-modal').hidden = true; });
    on($('#rule-cancel'), 'click', () => { $('#rule-modal').hidden = true; });
    on($('#r-test'), 'click', async () => {
      const res = await post('/api/autoreply/test', {
        rule: { match_type: $('#r-type').value, pattern: $('#r-pattern').value },
        sample: {
          from: $('#r-sample-from').value,
          subject: $('#r-sample-subject').value,
          body: $('#r-sample-body').value,
        },
      });
      $('#r-test-result').textContent = res.matched ? '✓ matches' : '✗ no match';
      $('#r-test-result').style.color = res.matched ? 'var(--emerald)' : 'var(--red)';
    });
    on($('#rule-save'), 'click', async () => {
      const payload = {
        name: $('#r-name').value.trim() || 'rule',
        match_type: $('#r-type').value,
        pattern: $('#r-pattern').value,
        template_set_id: Number($('#r-set').value) || null,
        delay_value: Number($('#r-delay').value) || 0,
        delay_unit: $('#r-unit').value,
        max_per_contact_per_day: Number($('#r-max').value) || 1,
        enabled: $('#r-enabled').checked ? 1 : 0,
      };
      if (state.editingRule) await patch(`/api/autoreply/rules/${state.editingRule}`, payload);
      else await post('/api/autoreply/rules', payload);
      $('#rule-modal').hidden = true;
      toast('rule saved');
      loadAutoReply().catch(showError);
    });
  }

  // -------------------------------------------------------------- telegram
  async function loadAiChat() {
    const s = await get('/api/settings');
    const ai = s.ai_chat || {};
    $('#ai-chat-enabled').checked = String(s.settings.AI_CHAT_ENABLED) === 'true';
    $('#ai-timeout').value = s.settings.AI_CHAT_TIMEOUT_SEC || 45;
    $('#ai-gemini-key').value = '';
    $('#ai-gemini-key').placeholder = s.secrets_configured.GEMINI_API_KEY
      ? '•••••••• (saved, leave blank to keep)' : 'paste your Gemini API key';
    const state = $('#ai-chat-state');
    state.textContent = ai.ready ? 'ready' : (ai.key_present ? 'off' : 'no key');
    state.className = ai.ready ? 'pill pill-green' : 'pill pill-amber';
    await loadProposals();
  }

  async function loadProposals() {
    const { proposals } = await get('/api/proposals');
    const pending = (proposals || []).filter((p) => p.status === 'pending');
    const pill = $('#proposal-count');
    pill.textContent = `${pending.length} pending`;
    pill.className = pending.length ? 'pill pill-amber' : 'pill pill-grey';
    const box = $('#proposals-list');
    if (!pending.length) {
      box.innerHTML = '<p class="muted small">no pending proposals</p>';
      return;
    }
    box.innerHTML = pending.map((p) => `
      <div class="list-row">
        <span class="grow">#${p.id} <b>${esc(p.file)}</b> — ${esc(p.summary)}</span>
        <span class="pill ${p.risk === 'medium' ? 'pill-amber' : 'pill-grey'}">${esc(p.risk)}</span>
        <button class="btn btn-sm" data-approve="${p.id}">approve</button>
        <button class="btn btn-sm btn-danger" data-reject="${p.id}">reject</button>
      </div>`).join('');
    $$('[data-approve]', box).forEach((b) => b.addEventListener('click', async () => {
      const ok = await confirmAction('apply proposal',
        'This writes the diff to the target file and keeps a backup. ' +
        'Python files are re-parsed before the write is kept. Continue?',
        'apply', true);
      if (!ok) return;
      try {
        const res = await post(`/api/proposals/${b.dataset.approve}/approve`, {});
        toast(`applied to ${res.file} · ${res.lines} line(s) · ${res.restart_hint}`);
        await loadProposals();
      } catch (err) { showError(err); }
    }));
    $$('[data-reject]', box).forEach((b) => b.addEventListener('click', async () => {
      const reason = prompt('reason (optional, logged)') || '';
      try {
        await post(`/api/proposals/${b.dataset.reject}/reject`, { reason });
        toast('proposal rejected');
        await loadProposals();
      } catch (err) { showError(err); }
    }));
  }

  async function loadTelegram() {
    loadAiChat().catch(() => {});
    const [cfg, { log }] = await Promise.all([get('/api/telegram'), get('/api/telegram/log')]);
    $('#tg-token').value = '';
    $('#tg-token').placeholder = cfg.has_token ? '•••••••• (saved, leave blank to keep)' : '123456:ABC...';
    $('#tg-chat').value = cfg.chat_id || '';
    $('#tg-allowed').value = cfg.allowed_user_ids || '';
    $('#tg-enabled').checked = !!cfg.enabled;
    const tbody = $('#tg-log tbody');
    tbody.innerHTML = (log || []).length ? '' : '<tr><td colspan="4" class="muted">no commands logged</td></tr>';
    (log || []).forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="mono">${esc(row.ts)}</td><td class="mono">${esc(row.user_id)}</td>
        <td class="mono">${esc(row.command)}</td><td class="muted">${esc((row.result || '').slice(0, 120))}</td>`;
      tbody.appendChild(tr);
    });
  }

  function initTelegram() {
    on($('#tg-save'), 'click', async () => {
      const payload = {
        chat_id: $('#tg-chat').value.trim(),
        allowed_user_ids: $('#tg-allowed').value.trim(),
        enabled: $('#tg-enabled').checked ? 1 : 0,
      };
      const token = $('#tg-token').value.trim();
      if (token) payload.bot_token = token;
      await post('/api/telegram', payload);
      toast('telegram config saved');
      loadTelegram().catch(showError);
    });
    on($('#tg-test'), 'click', async () => {
      const box = $('#tg-result');
      box.hidden = false;
      box.className = 'guard-result';
      box.textContent = 'asking telegram…';
      try {
        const res = await post('/api/telegram/test', { bot_token: $('#tg-token').value.trim() || undefined });
        box.className = `guard-result ${res.ok ? 'ok' : 'bad'}`;
        box.textContent = res.ok ? `✓ connected as @${res.username}` : `✗ ${res.error}`;
      } catch (err) { box.className = 'guard-result bad'; box.textContent = `✗ ${err.message}`; }
    });
    on($('#tg-send-test'), 'click', async () => {
      const box = $('#tg-result');
      box.hidden = false;
      box.textContent = 'sending…';
      try {
        const res = await post('/api/telegram/send-test', {});
        box.className = `guard-result ${res.ok ? 'ok' : 'bad'}`;
        box.textContent = res.ok ? '✓ test message delivered' : `✗ ${res.error}`;
      } catch (err) { box.className = 'guard-result bad'; box.textContent = `✗ ${err.message}`; }
    });

    // ---- agent ashley ------------------------------------------------
    on($('#ai-save'), 'click', async () => {
      const payload = {
        AI_CHAT_ENABLED: $('#ai-chat-enabled').checked ? 'true' : 'false',
        AI_CHAT_TIMEOUT_SEC: $('#ai-timeout').value || '45',
      };
      const key = $('#ai-gemini-key').value.trim();
      if (key) payload.GEMINI_API_KEY = key;
      const res = await post('/api/settings', payload);
      const ai = res.ai_chat || {};
      toast(ai.ready ? 'AI chat ready' : 'saved — add a Gemini key to enable chat',
            ai.ready ? '' : 'warn');
      await loadAiChat();
    });

    on($('#ai-test'), 'click', async () => {
      const box = $('#ai-result');
      box.hidden = false;
      box.className = 'guard-result';
      box.textContent = 'asking…';
      try {
        const res = await post('/api/ashley/ask',
          { question: 'Give me a one-line status of the operation right now.' });
        if (res.ok) {
          box.className = 'guard-result ok';
          box.textContent = res.answer;
        } else {
          box.className = 'guard-result bad';
          box.textContent = `✗ ${res.error}`;
        }
      } catch (err) {
        box.className = 'guard-result bad';
        box.textContent = `✗ ${err.message}`;
      }
    });

    on($('#proposal-check'), 'click', async () => {
      toast('reviewing recent failures…');
      try {
        const res = await post('/api/upgrade/check', {});
        if (!res.ok) { toast(res.error || 'check failed', 'error'); return; }
        toast(res.created?.length
          ? `${res.created.length} proposal(s) await your approval`
          : 'nothing worth proposing right now');
        await loadProposals();
      } catch (err) { showError(err); }
    });
  }

  // -------------------------------------------------------------- settings
  async function loadSettings() {
    const data = await get('/api/settings');
    state.settings = data.settings;
    const s = data.settings;
    $('#s-gemini-key').value = '';
    $('#s-gemini-key').placeholder = data.secrets_configured.GEMINI_API_KEY
      ? '•••••••• (saved, leave blank to keep)' : 'paste your Gemini API key';
    $('#s-gemini-model').value = s.GEMINI_MODEL || 'gemini-2.5-flash';
    $('#s-gemini-rpm').value = s.GEMINI_RPM || 15;
    $('#s-dryrun').checked = String(s.DRY_RUN) === 'true';
    $('#s-daily-cap').value = s.GLOBAL_DAILY_CAP || 300;
    $('#s-pacing-floor').value = s.PACING_FLOOR_SEC || 30;
    $('#s-warmup').checked = String(s.WARMUP_ENABLED) === 'true';
    $('#s-warmup-ramp').value = s.WARMUP_RAMP || '';
    $('#s-warmup-status').textContent = `day ${data.warmup.day + 1} · effective cap ${data.warmup.cap}`;
    $('#s-operator-name').value = s.OPERATOR_NAME || '';
    $('#s-require-source').checked = String(s.REQUIRE_SOURCE_FIELD) === 'true';
    loadSourceReport().catch(() => {});
    $('#s-domain').value = s.FROM_DOMAIN || '';
    $('#s-dkim').value = s.DKIM_SELECTOR || 'google';
    $('#s-wd-interval').value = s.WATCHDOG_INTERVAL_SEC || 15;
    $('#s-hb-interval').value = s.HEARTBEAT_INTERVAL_SEC || 5;
    $('#s-stale').value = s.STALE_THRESHOLD_SEC || 45;
    $('#s-max-restarts').value = s.MAX_RESTARTS || 5;
    $('#s-imap-value').value = s.IMAP_POLL_VALUE || 6;
    $('#s-imap-unit').value = s.IMAP_POLL_UNIT || 'hours';
    $('#s-cf-interval').value = s.CF_REPORT_INTERVAL_SEC || 60;
    $('#s-shell').value = s.SHELL_ALLOWLIST || '';
  }

  async function loadSourceReport() {
    const rep = await get('/api/campaigns/source-report');
    const box = $('#s-unlabelled');
    if (!rep.total_unlabelled) {
      box.innerHTML = '<span style="color:var(--emerald)">every active contact has a source label</span>';
      return;
    }
    const groups = (rep.groups || [])
      .map((g) => `${esc(g.name)} (${g.unlabelled})`).join(', ');
    box.innerHTML = `<span style="color:var(--amber)">${rep.total_unlabelled} active ` +
      `contact(s) have no source and will block a launch:</span> ${groups}`;
  }

  function initSettings() {
    on($('#s-require-source'), 'change', () => loadSourceReport().catch(() => {}));
    on($('#s-save'), 'click', async () => {
      const payload = {
        GEMINI_MODEL: $('#s-gemini-model').value.trim(),
        GEMINI_RPM: $('#s-gemini-rpm').value,
        DRY_RUN: $('#s-dryrun').checked ? 'true' : 'false',
        GLOBAL_DAILY_CAP: $('#s-daily-cap').value,
        PACING_FLOOR_SEC: $('#s-pacing-floor').value,
        WARMUP_ENABLED: $('#s-warmup').checked ? 'true' : 'false',
        WARMUP_RAMP: $('#s-warmup-ramp').value.trim(),
        FROM_DOMAIN: $('#s-domain').value.trim(),
        DKIM_SELECTOR: $('#s-dkim').value.trim() || 'google',
        WATCHDOG_INTERVAL_SEC: $('#s-wd-interval').value,
        HEARTBEAT_INTERVAL_SEC: $('#s-hb-interval').value,
        STALE_THRESHOLD_SEC: $('#s-stale').value,
        MAX_RESTARTS: $('#s-max-restarts').value,
        OPERATOR_NAME: $('#s-operator-name').value.trim() || 'Kut Milz',
        REQUIRE_SOURCE_FIELD: $('#s-require-source').checked ? 'true' : 'false',
        IMAP_POLL_VALUE: $('#s-imap-value').value,
        IMAP_POLL_UNIT: $('#s-imap-unit').value,
        CF_REPORT_INTERVAL_SEC: $('#s-cf-interval').value,
        SHELL_ALLOWLIST: $('#s-shell').value.trim(),
      };
      const key = $('#s-gemini-key').value.trim();
      if (key) payload.GEMINI_API_KEY = key;
      const res = await post('/api/settings', payload);
      $('#s-save-result').textContent = `saved ${res.written.length} keys`;
      toast('settings saved');
      setDryPill(String(payload.DRY_RUN) === 'true');
      loadSettings().catch(showError);
    });

    on($('#s-dryrun'), 'change', async (e) => {
      if (!e.target.checked) {
        const ok = await confirmAction('go live?',
          'Turning off dry run means real email will be sent by any running campaign. Continue?',
          'go live', true);
        if (!ok) { e.target.checked = true; return; }
      }
      await post('/api/settings/dry-run', { enabled: e.target.checked });
      setDryPill(e.target.checked);
      loadSettings().catch(showError);
    });

    on($('#s-gemini-test'), 'click', async () => {
      $('#s-gemini-result').textContent = 'testing…';
      try {
        const res = await post('/api/gemini/test');
        $('#s-gemini-result').textContent = res.ok ? '✓ key works' : `✗ ${res.error}`;
        $('#s-gemini-result').style.color = res.ok ? 'var(--emerald)' : 'var(--red)';
      } catch (err) { $('#s-gemini-result').textContent = `✗ ${err.message}`; }
    });

    on($('#s-doctor'), 'click', async () => {
      const box = $('#doctor-results');
      box.hidden = false;
      box.innerHTML = '<p class="muted small">resolving DNS…</p>';
      try {
        const res = await post('/api/settings/deliverability', {
          domain: $('#s-domain').value.trim(),
          selector: $('#s-dkim').value.trim() || 'google',
        });
        const row = (label, item) => `
          <div class="doctor-row">
            <b>${label}</b>
            <span style="color:${item.ok ? 'var(--emerald)' : 'var(--red)'}">${item.ok ? '✓' : '✗'}</span>
            <span class="rec">${esc(item.record || item.name || 'not found')}</span>
          </div>`;
        box.innerHTML = row('SPF', res.spf) + row('DKIM', res.dkim) + row('DMARC', res.dmarc) +
          `<p class="muted small">checked ${esc(res.domain)} · selector ${esc(res.dkim.selector)}</p>`;
      } catch (err) {
        box.innerHTML = `<p class="bad" style="color:var(--red)">${esc(err.message)}</p>`;
      }
    });

    on($('#s-rotate'), 'click', async () => {
      const ok = await confirmAction('regenerate token',
        'This invalidates every session, including yours. You will be logged out immediately. Continue?',
        'regenerate', true);
      if (!ok) return;
      const res = await post('/api/settings/rotate-token');
      const box = $('#rotate-result');
      box.hidden = false;
      $('#rotate-token').value = res.token;
      toast('token rotated — copy it now, you will be logged out in 30s', 'warn');
      setTimeout(() => window.location.replace('/'), 30000);
    });

    on($('#rotate-copy'), 'click', async () => {
      const input = $('#rotate-token');
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      toast('token copied');
    });

    on($('#s-wipe'), 'click', async () => {
      const first = await confirmAction('wipe database',
        'Type WIPE in the next box to confirm. Every campaign, contact, template and log row is deleted. Settings are kept.', 'continue', true);
      if (!first) return;
      const value = prompt('type WIPE to confirm');
      if (value !== 'WIPE') { toast('wiped cancelled', 'warn'); return; }
      const res = await post('/api/settings/wipe', { confirm: 'WIPE' });
      toast(`wiped ${res.cleared.length} tables`);
      setTimeout(() => window.location.reload(), 800);
    });
  }

  // ------------------------------------------------------------------ boot
  async function logout() {
    try { await post('/auth/logout'); } catch { /* ignore */ }
    window.location.replace('/');
  }

  function init() {
    initTabs();
    initLeads();
    initProfiles();
    initAutoReply();
    initTelegram();
    initSettings();
    window.WIZARD?.init?.();
    window.TEMPLATES?.init?.();
    window.CF?.init?.();

    on($('#logout'), 'click', logout);
    on($('#new-campaign'), 'click', () => window.WIZARD?.open?.());
    on($('#campaign-log-close'), 'click', () => { $('#campaign-log-card').hidden = true; });
    on($('#stream-clear'), 'click', async () => {
      $('#event-stream').innerHTML = '';
      try { await post('/api/events/clear'); } catch { /* ignore */ }
    });
    on($('#open-generate'), 'click', () => window.TEMPLATES?.openGenerate?.());

    connectSocket();
    refreshDashboard().catch(showError);
    pollHealth();
    setInterval(pollHealth, 20000);
    setInterval(() => { if (state.tab === 'dashboard') refreshDashboard().catch(() => {}); }, 30000);
  }

  return {
    $, $$, esc, fmtNum, fmtAge, fmtUptime, api, get, post, patch, del,
    toast, modal, confirmAction, showTab, showError,
    loadCampaigns, loadLeads, loadProfiles, loadAutoReply, loadTelegram, loadSettings,
    refreshDashboard, refreshLookups, openRuleModal, debounce, loadSourceReport,
    state, init,
  };
})();

window.APP = APP;
document.addEventListener('DOMContentLoaded', () => APP.init());
