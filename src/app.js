// ComplaintGraph — dashboard front-end. Vanilla JS, no dependencies.
// Reads the baked static JSON in ./data/ and renders everything with inline SVG.

const DATA = './data';
const cache = new Map();
const state = { index: null, compareMode: false, selected: null, compareSel: [null, null] };

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const fmt = (n) => Number(n).toLocaleString('en-US');
const pct = (n) => `${Math.round(n * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Risk band → color. Higher score = more reason to look closer.
function bandColor(band) {
  return { Low: 'var(--green)', Moderate: 'var(--gold)', Elevated: 'var(--amber)', High: 'var(--red)' }[band] || 'var(--t2)';
}
function bandBg(band) {
  return {
    Low: 'rgba(0,229,160,.10)', Moderate: 'rgba(245,197,24,.12)',
    Elevated: 'rgba(255,180,84,.12)', High: 'rgba(255,107,107,.12)',
  }[band] || 'var(--s2)';
}

async function fetchJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const json = await res.json();
  cache.set(url, json);
  return json;
}
const loadCompany = (slug) => fetchJSON(`${DATA}/companies/${slug}.json`);

// ---------------------------------------------------------------------------
// SVG charts
// ---------------------------------------------------------------------------

// Donut gauge for the 0–100 signal score.
function gauge(score, band) {
  const r = 58, c = 70, circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, score / 100));
  const color = bandColor(band);
  return `
  <div class="gauge">
    <svg viewBox="0 0 140 140" aria-label="Signal score ${score} of 100">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--s3)" stroke-width="11"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="${circ}"
        stroke-dashoffset="${circ * (1 - frac)}" transform="rotate(-90 ${c} ${c})"/>
    </svg>
    <div class="num"><b style="color:${color}">${score}</b><span>/ 100</span></div>
  </div>`;
}

// Area + line trend chart from monthly [{month,count}].
function trendChart(monthly, color = 'var(--green)') {
  const w = 100, h = 34, pad = 2;
  const max = Math.max(1, ...monthly.map((m) => m.count));
  const n = monthly.length;
  const x = (i) => pad + (i / (n - 1)) * (w - pad * 2);
  const y = (v) => h - pad - (v / max) * (h - pad * 2);
  const pts = monthly.map((m, i) => `${x(i).toFixed(2)},${y(m.count).toFixed(2)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(n - 1).toFixed(2)},${h} L${x(0).toFixed(2)},${h} Z`;
  const last = monthly[n - 1];
  const first = monthly[0];
  return `
  <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:120px">
    <defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#tg)"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="bar-top" style="margin-top:8px;color:var(--t3);font-family:var(--mono);font-size:11px">
    <span>${first.month}</span><span>${last.month}</span>
  </div>`;
}

// Horizontal bar list from [{name,count}].
function barList(items, total, color) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return `<div class="bar-row">${items.map((i) => {
    const p = total ? Math.round((i.count / total) * 100) : 0;
    return `<div class="bar">
      <div class="bar-top"><span class="bl">${esc(i.name)}</span><span class="bv">${fmt(i.count)} · ${p}%</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(i.count / max) * 100}%${color ? `;background:${color}` : ''}"></div></div>
    </div>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Regulatory footprint — additive public-record cross-reference panel.
// Renders FDIC / SEC EDGAR / GLEIF facts with source links, or a graceful
// "no public regulatory match" message. Public records only — never a verdict.
// ---------------------------------------------------------------------------
function fmtAssets(thousands) {
  if (thousands == null || !Number.isFinite(Number(thousands))) return '—';
  const dollars = Number(thousands) * 1000;
  if (dollars >= 1e12) return `$${(dollars / 1e12).toFixed(2)}T`;
  if (dollars >= 1e9) return `$${(dollars / 1e9).toFixed(1)}B`;
  if (dollars >= 1e6) return `$${(dollars / 1e6).toFixed(1)}M`;
  return `$${fmt(dollars)}`;
}

function regFactRow(label, value) {
  return `<div class="reg-fact"><span class="rl">${esc(label)}</span><span class="rv">${value}</span></div>`;
}

function regCardFDIC(f) {
  if (!f) return '';
  return `
    <div class="reg-src">
      <div class="reg-src-head">
        <span class="reg-tag">FDIC BankFind</span>
        <a href="https://banks.data.fdic.gov/bankfind-suite/bankfind?name=${encodeURIComponent(f.name || '')}" target="_blank" rel="noopener">view ↗</a>
      </div>
      ${regFactRow('Insured institution', esc(f.name || '—'))}
      ${regFactRow('FDIC certificate', `#${esc(String(f.cert))}`)}
      ${regFactRow('Location', esc([f.city, f.state].filter(Boolean).join(', ') || '—'))}
      ${regFactRow('Total assets', fmtAssets(f.asset_thousands))}
      ${regFactRow('Status', f.active ? 'Active' : 'Inactive')}
      ${f.established ? regFactRow('Established', esc(f.established)) : ''}
    </div>`;
}

function regCardSEC(s) {
  if (!s) return '';
  const filings = (s.recent_filings || []).slice(0, 5).map((fl) =>
    `<li><span class="reg-form">${esc(fl.form || '—')}</span><span class="reg-fdate">${esc(fl.date || '')}</span></li>`,
  ).join('');
  const cikNum = String(s.cik || '').replace(/^0+/, '') || s.cik;
  return `
    <div class="reg-src">
      <div class="reg-src-head">
        <span class="reg-tag">SEC EDGAR</span>
        <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(s.cik || '')}&type=&dateb=&owner=include&count=40" target="_blank" rel="noopener">view ↗</a>
      </div>
      ${regFactRow('Filer', esc(s.entity_name || '—'))}
      ${regFactRow('CIK', esc(cikNum))}
      ${filings ? `<div class="reg-filings"><div class="reg-fl-h">Recent filings</div><ul>${filings}</ul></div>` : ''}
    </div>`;
}

function regCardLEI(l) {
  if (!l) return '';
  return `
    <div class="reg-src">
      <div class="reg-src-head">
        <span class="reg-tag">GLEIF LEI</span>
        <a href="https://search.gleif.org/#/record/${encodeURIComponent(l.lei || '')}" target="_blank" rel="noopener">view ↗</a>
      </div>
      ${regFactRow('Legal entity name', esc(l.legal_name || '—'))}
      ${regFactRow('LEI', `<span class="reg-mono">${esc(l.lei || '—')}</span>`)}
      ${l.jurisdiction ? regFactRow('Jurisdiction', esc(l.jurisdiction)) : ''}
      ${l.status ? regFactRow('Entity status', esc(l.status)) : ''}
      ${l.registration_status ? regFactRow('Registration', esc(l.registration_status)) : ''}
    </div>`;
}

function regulatoryPanel(c) {
  const reg = c.regulatory;
  const isSample = !reg || reg.data_source === 'sample';
  const tagClass = isSample ? 'reg-badge sample' : 'reg-badge';
  const tagText = isSample ? 'SAMPLE public records' : 'Public records';
  const hasMatch = reg && (reg.fdic || reg.sec || reg.lei);

  const body = hasMatch
    ? `<div class="reg-grid">${regCardFDIC(reg.fdic)}${regCardSEC(reg.sec)}${regCardLEI(reg.lei)}</div>`
    : `<div class="reg-empty">No public regulatory match found in FDIC BankFind, SEC EDGAR, or GLEIF for this entity.
        Many non-bank companies (e.g. credit bureaus and privately-held firms) have no FDIC charter or US SEC filer record.</div>`;

  return `
    <div class="card full reg-card">
      <div class="reg-head">
        <h3>Regulatory footprint</h3>
        <span class="${tagClass}">${tagText}</span>
      </div>
      <p class="reg-note">Open public-record cross-reference from independent government / registry sources, shown for context.
        These are identity and registration facts only — <strong>not</strong> findings of wrongdoing and not part of the complaint signal.</p>
      ${body}
      ${reg && reg.note ? `<div class="reg-prov">${esc(reg.note)}</div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Leaderboard + chips
// ---------------------------------------------------------------------------
function renderBadge() {
  const badge = $('#sourceBadge');
  const idx = state.index;
  if (idx.data_source === 'sample') {
    badge.className = 'badge sample';
    badge.textContent = `Sample data · ${idx.companies.length} companies`;
    badge.title = idx.note || '';
  } else {
    badge.className = 'badge';
    badge.textContent = `Live CFPB snapshot · ${idx.generated}`;
    badge.title = idx.note || '';
  }
}

function renderLeaderboard() {
  const board = $('#leaderboard');
  board.innerHTML = '';
  const q = $('#search').value.trim().toLowerCase();
  const rows = state.index.companies.filter(
    (c) => !q || c.display_name.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
  );
  if (!rows.length) {
    board.appendChild(el('div', 'empty', 'No matching companies.'));
    return;
  }
  rows.forEach((c, i) => {
    const row = el('button', 'lb-row');
    row.innerHTML = `
      <span class="lb-rank">${String(i + 1).padStart(2, '0')}</span>
      <span class="lb-name">${esc(c.display_name)}<small>${esc(c.name)}</small></span>
      <span class="lb-vol">${fmt(c.total_complaints)}<small>complaints</small></span>
      <span class="score-pill" style="color:${bandColor(c.signal_band)};background:${bandBg(c.signal_band)}">
        ${c.signal_score}<small>${c.signal_band}</small></span>`;
    row.addEventListener('click', () => selectCompany(c.slug));
    board.appendChild(row);
  });
}

function renderChips() {
  const wrap = $('#companyChips');
  wrap.innerHTML = '';
  state.index.companies.forEach((c) => {
    const chip = el('button', 'chip');
    chip.dataset.slug = c.slug;
    chip.innerHTML = `<span class="dot" style="background:${bandColor(c.signal_band)}"></span>${esc(c.display_name)}`;
    chip.addEventListener('click', () => {
      if (state.compareMode) toggleCompare(c.slug);
      else selectCompany(c.slug);
    });
    wrap.appendChild(chip);
  });
}
function syncChips() {
  document.querySelectorAll('.chip').forEach((chip) => {
    const s = chip.dataset.slug;
    const active = state.compareMode ? state.compareSel.includes(s) : state.selected === s;
    chip.classList.toggle('active', active);
  });
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
async function selectCompany(slug) {
  state.selected = slug;
  syncChips();
  const c = await loadCompany(slug);
  const d = $('#detail');
  d.hidden = false;
  $('#compare').hidden = true;

  const sig = c.signal;
  const color = bandColor(sig.band);
  const topIssue = c.top_issues[0];

  d.innerHTML = `
    <button class="back" id="backBtn">← back to leaderboard</button>
    <div class="dhead">
      <div>
        <h2>${esc(c.display_name)}</h2>
        <div class="cfpb-name">CFPB: ${esc(c.name)} · window ${c.window.min} → ${c.window.max}</div>
      </div>
    </div>

    <div class="summary">${esc(c.summary)}</div>

    <div class="grid">
      <div class="card">
        <h3>Risk signal</h3>
        <div class="gauge-wrap">
          ${gauge(sig.score, sig.band)}
          <div>
            <span class="band-tag" style="color:${color};background:${bandBg(sig.band)}">${sig.band} signal</span>
            <p class="gauge-note">A transparent 0–100 score blending five public-data sub-signals (below).
            Higher means more reason to look closer — <strong>not</strong> a verdict.</p>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>At a glance</h3>
        <div class="kpi-row">
          <div class="kpi"><div class="v">${fmt(c.total_complaints)}</div><div class="l">Complaints</div></div>
          <div class="kpi"><div class="v">${pct(c.timely_response_rate)}</div><div class="l">Timely response</div></div>
        </div>
        <div class="kpi-row" style="margin-bottom:0">
          <div class="kpi"><div class="v">${fmt(c.narrative_count)}</div><div class="l">With narrative</div></div>
          <div class="kpi"><div class="v">${topIssue ? Math.round((topIssue.count / c.total_complaints) * 100) : 0}%</div><div class="l">Top issue share</div></div>
        </div>
      </div>

      <div class="card full">
        <h3>Complaint volume by month</h3>
        ${trendChart(c.monthly, color)}
      </div>

      <div class="card">
        <h3>Top issues</h3>
        ${barList(c.top_issues.slice(0, 6), c.total_complaints)}
      </div>
      <div class="card">
        <h3>Top products</h3>
        ${barList(c.top_products.slice(0, 6), c.total_complaints)}
      </div>

      <div class="card">
        <h3>How the company responded</h3>
        ${barList(c.company_responses.slice(0, 6), c.total_complaints, 'var(--blue)')}
      </div>
      <div class="card">
        <h3>Where complaints came from</h3>
        ${barList(c.top_states.slice(0, 8), c.total_complaints, 'var(--purple)')}
      </div>

      <div class="card full">
        <h3>How the risk signal is calculated</h3>
        ${sig.components.map((cmp) => `
          <div class="sig-comp">
            <div class="sc-top">
              <span class="sc-label">${esc(cmp.label)} <span class="sc-weight">× ${cmp.weight}</span></span>
              <span class="sc-val">${cmp.value}/100</span>
            </div>
            <div class="meter"><div style="width:${cmp.value}%;background:${color}"></div></div>
            <div class="sc-ev">${esc(cmp.evidence)}</div>
          </div>`).join('')}
      </div>

      ${regulatoryPanel(c)}

      ${c.sample_narratives.length ? `
      <div class="card full">
        <h3>Consumer narratives (public, consent-given)</h3>
        ${c.sample_narratives.map((n) => `
          <div class="narr">
            <div class="nmeta"><b>${esc(n.issue)}</b><span>${esc(n.product)}</span><span>${esc(n.state || '—')}</span><span>${esc(n.date)}</span></div>
            <p>“${esc(n.text)}”</p>
          </div>`).join('')}
      </div>` : ''}
    </div>`;

  $('#backBtn').addEventListener('click', () => {
    d.hidden = true;
    state.selected = null;
    syncChips();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Compare view
// ---------------------------------------------------------------------------
function toggleCompare(slug) {
  const sel = state.compareSel;
  const i = sel.indexOf(slug);
  if (i >= 0) sel[i] = null;
  else if (!sel[0]) sel[0] = slug;
  else if (!sel[1]) sel[1] = slug;
  else sel[1] = slug; // replace second
  syncChips();
  renderCompare();
}

async function renderCompare() {
  const box = $('#compare');
  box.hidden = false;
  $('#detail').hidden = true;
  const [a, b] = state.compareSel;
  if (!a || !b) {
    box.innerHTML = `<div class="empty">Pick two companies above to compare them side by side.</div>`;
    return;
  }
  const [ca, cb] = await Promise.all([loadCompany(a), loadCompany(b)]);
  const col = (c) => {
    const color = bandColor(c.signal.band);
    return `
    <div class="card">
      <h3>${esc(c.display_name)}</h3>
      <div class="gauge-wrap" style="margin-bottom:14px">
        ${gauge(c.signal.score, c.signal.band)}
        <span class="band-tag" style="color:${color};background:${bandBg(c.signal.band)}">${c.signal.band}</span>
      </div>
      <div class="kpi-row"><div class="kpi"><div class="v">${fmt(c.total_complaints)}</div><div class="l">Complaints</div></div>
        <div class="kpi"><div class="v">${pct(c.timely_response_rate)}</div><div class="l">Timely</div></div></div>
      ${trendChart(c.monthly, color)}
      <h3 style="margin-top:18px">Top issues</h3>
      ${barList(c.top_issues.slice(0, 4), c.total_complaints)}
    </div>`;
  };
  box.innerHTML = `<div class="cmp-grid">${col(ca)}${col(cb)}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    state.index = await fetchJSON(`${DATA}/index.json`);
  } catch (err) {
    $('#leaderboard').innerHTML = `<div class="empty">Could not load data (${esc(err.message)}).<br>
      Serve this folder over HTTP — e.g. <code>npx serve complaintgraph/src</code> — rather than opening the file directly.</div>`;
    return;
  }
  renderBadge();
  renderChips();
  renderLeaderboard();

  $('#search').addEventListener('input', renderLeaderboard);
  $('#compareToggle').addEventListener('change', (e) => {
    state.compareMode = e.target.checked;
    $('#boardLabel').textContent = state.compareMode ? 'Pick two to compare' : 'Risk leaderboard';
    state.compareSel = [null, null];
    state.selected = null;
    syncChips();
    if (state.compareMode) {
      $('#detail').hidden = true;
      renderCompare();
    } else {
      $('#compare').hidden = true;
    }
  });
}

boot();
