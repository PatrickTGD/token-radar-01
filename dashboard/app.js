/* Launch Radar page: renders window.LAUNCH_RADAR (written beside this page by main.ts).
   No fetch, no network: sorting, filtering and the detail view all run on the data in memory.
   The view state lives in the URL hash (#p=<slug> for a detail, #cat=..&chain=..&q=..&watch=1
   for a filtered board), so any view can be linked, screenshotted and returned to. */
'use strict';

const D = window.LAUNCH_RADAR;
const rows = D.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** $2,757,585,593 — the full figure, for the detail view. */
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

/** $2.76B / $320.2M / $45.1K — the compact figure, for the board. */
function compact(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n;
}

const pct = (v) => (v === null ? null : (v > 0 ? '+' : '') + v.toFixed(2) + '%');

/* ---------------------------------------------------------------- state */

function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  return {
    p: h.get('p') || null,
    model: h.get('model') === '1',
    q: h.get('q') || '',
    cat: h.get('cat') || '',
    chain: h.get('chain') || '',
    watch: h.get('watch') === '1',
    sort: h.get('sort') || 'rank',
    dir: h.get('dir') === 'asc' || h.get('dir') === 'desc' ? h.get('dir') : 'asc',
  };
}

function writeHash(st) {
  const h = new URLSearchParams();
  if (st.p) h.set('p', st.p);
  if (st.model) h.set('model', '1');
  if (st.q) h.set('q', st.q);
  if (st.cat) h.set('cat', st.cat);
  if (st.chain) h.set('chain', st.chain);
  if (st.watch) h.set('watch', '1');
  if (st.sort !== 'rank') h.set('sort', st.sort);
  if (st.dir !== 'asc') h.set('dir', st.dir);
  const s = h.toString();
  history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
}

let state = readHash();

/* ---------------------------------------------------------------- masthead + model */

function renderMast() {
  const totalTvl = rows.reduce((n, r) => n + r.tvl_usd, 0);
  const top = rows[0];
  document.getElementById('mastStats').innerHTML = [
    [String(rows.length), 'protocols ranked'],
    [String(D.watchlist_size), 'on the watchlist'],
    [compact(totalTvl), 'TVL covered'],
    [top ? compact(top.implied_value_usd) : '—', 'top implied value'],
    [D.as_of, 'snapshot date'],
  ]
    .map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`)
    .join('');
  const v = D.validation;
  document.getElementById('modelStrip').innerHTML =
    `<span class="formula">Implied value = blend of <span class="fx">peer multiples</span> and a <span class="fx">fitted size curve</span>, &times; ` +
    `<span class="fx">growth</span> &times; <span class="fx">maturity</span> &times; <span class="fx">breadth</span></span>` +
    ` &nbsp;Two unrelated pricings of every protocol, averaged in log space; the spread between them is the value range on each detail page. ` +
    `Backtested by leave-one-out on the ${v.comps} traded protocols: median error <b>${v.ensemble.median_ape_pct}%</b>, ` +
    `<b>${v.ensemble.within_2x_pct}%</b> priced within 2&times; of the real market cap. ` +
    `<a id="modelLink">How the model works, and its full backtest &rarr;</a>`;
  document.getElementById('modelLink').addEventListener('click', () => {
    state.p = null;
    state.model = true;
    writeHash(state);
    render();
  });
}

/* ---------------------------------------------------------------- board */

const SORTS = {
  rank: (r) => r.rank,
  name: (r) => r.name.toLowerCase(),
  category: (r) => (r.category || '').toLowerCase(),
  tvl: (r) => r.tvl_usd,
  change: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
  implied: (r) => r.implied_value_usd,
  multiple: (r) => r.implied_multiple,
};

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  const list = rows.filter((r) => {
    if (state.watch && !r.watchlist) return false;
    if (state.cat && (r.category || '') !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (q && !r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
    return true;
  });
  const key = SORTS[state.sort] || SORTS.rank;
  const sign = state.dir === 'desc' ? -1 : 1;
  list.sort((a, b) => {
    const va = key(a);
    const vb = key(b);
    const cmp = typeof va === 'string' ? (va < vb ? -1 : va > vb ? 1 : 0) : va - vb;
    return cmp * sign || a.rank - b.rank;
  });
  return list;
}

function rowHtml(r) {
  const ch = pct(r.change_7d);
  const chCls = r.change_7d === null ? 'flat' : r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : 'flat';
  const chains = r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ` +${r.chains.length - 3}` : '');
  return (
    `<tr data-slug="${esc(r.slug)}">` +
    `<td class="num rank">${r.rank}</td>` +
    `<td><span class="pname">${esc(r.name)}</span><span class="pslug">${esc(r.slug)}</span></td>` +
    `<td>${esc(r.category || 'Uncategorised')}</td>` +
    `<td class="chains">${esc(chains)}</td>` +
    `<td class="num">${compact(r.tvl_usd)}</td>` +
    `<td class="num ${chCls}">${ch === null ? '—' : ch}</td>` +
    `<td class="num implied">${compact(r.implied_value_usd)}</td>` +
    `<td class="num mult">${r.implied_multiple.toFixed(2)}&times;</td>` +
    `<td>${r.watchlist ? '<span class="badge">Watchlist</span>' : '<span class="badge off">Below floor</span>'}</td>` +
    `</tr>`
  );
}

function renderBoard() {
  const list = visibleRows();
  const body = document.getElementById('boardBody');
  body.innerHTML = list.length ? list.map(rowHtml).join('') : `<tr><td colspan="9" class="empty">No protocol matches these filters.</td></tr>`;
  document.getElementById('count').textContent = `Showing ${list.length} of ${rows.length} protocols`;
  document.querySelectorAll('#boardTable thead th').forEach((th) => {
    const k = th.getAttribute('data-sort');
    if (!k) return;
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.innerHTML = esc(base) + (state.sort === k ? ` <span class="dir">${state.dir === 'asc' ? '▲' : '▼'}</span>` : '');
  });
  body.querySelectorAll('tr[data-slug]').forEach((tr) => {
    tr.addEventListener('click', () => {
      state.p = tr.getAttribute('data-slug');
      state.model = false;
      writeHash(state);
      render();
    });
  });
}

/* ---------------------------------------------------------------- detail */

function factorRow(label, value, note, widthPct) {
  return (
    `<div class="factor"><div class="frow"><span>${esc(label)}</span><b>${esc(value)}</b></div>` +
    `<div class="bar"><i style="width:${Math.max(3, Math.min(100, widthPct))}%"></i></div>` +
    (note ? `<div class="note" style="margin-top:4px">${esc(note)}</div>` : '') +
    `</div>`
  );
}

function renderDetail(r) {
  const m = r.model;
  const ch = pct(r.change_7d);
  const age = m.age_years === null ? 'not recorded' : m.age_years.toFixed(2) + ' years';
  const el = document.getElementById('detailView');
  el.innerHTML =
    `<a class="back" id="backLink">&larr; Back to the board</a>` +
    `<div class="detail-head"><h2>${esc(r.name)}</h2><span class="slug">${esc(r.slug)} &middot; rank #${r.rank} of ${rows.length}</span></div>` +
    `<div class="tags">` +
    `<span class="tag">${esc(r.category || 'Uncategorised')}</span>` +
    r.chains.map((c) => `<span class="tag">${esc(c)}</span>`).join('') +
    (r.watchlist ? `<span class="tag">On the house watchlist</span>` : `<span class="tag">Below the $50M watchlist floor — found by the radar</span>`) +
    `</div>` +
    `<div class="grid">` +
    `<div class="card"><h3>The protocol's record</h3>` +
    `<div class="kv"><span>Total value locked</span><b>${money(r.tvl_usd)}</b></div>` +
    `<div class="kv"><span>TVL change, 7 days</span><b>${ch === null ? 'not reported' : ch}</b></div>` +
    `<div class="kv"><span>Tracked since</span><b>${esc(r.listed_at || 'not recorded')}</b></div>` +
    `<div class="kv"><span>Age at snapshot</span><b>${esc(age)}</b></div>` +
    `<div class="kv"><span>Chains</span><b>${r.chains.length}</b></div>` +
    `<div class="kv"><span>Token</span><b>none recorded</b></div>` +
    `</div>` +
    `<div class="card"><h3>How the model prices it</h3>` +
    factorRow('TVL (the base)', money(r.tvl_usd), '', 100) +
    factorRow(
      `Category multiple — ${r.category || 'uncategorised'}`,
      m.category_multiple.toFixed(3) + '×',
      m.category_comps >= 3
        ? `Median of ${m.category_comps} traded peers in this category, shrunk toward the market median of ${D.global_multiple.toFixed(3)}×.`
        : m.category_comps > 0
          ? `Only ${m.category_comps} traded peer${m.category_comps === 1 ? '' : 's'} in this category — too few to price from, so the market-wide median of ${D.global_multiple.toFixed(3)}× is used.`
          : `No traded peers in this category, so the market-wide median of ${D.global_multiple.toFixed(3)}× is used.`,
      (m.category_multiple / 2) * 100,
    ) +
    factorRow('Growth adjustment', m.growth_factor.toFixed(3) + '×', `From the 7-day TVL change of ${ch === null ? '0% (not reported)' : ch}, weighted at half strength and clamped.`, ((m.growth_factor - 0.7) / 0.8) * 100) +
    factorRow('Maturity adjustment', m.maturity_factor.toFixed(3) + '×', `${age} run with no token, at +6% a year up to six years.`, ((m.maturity_factor - 1) / 0.36) * 100) +
    factorRow('Breadth adjustment', m.breadth_factor.toFixed(3) + '×', `Live on ${r.chains.length} chain${r.chains.length === 1 ? '' : 's'}, at +2% per extra chain up to five.`, ((m.breadth_factor - 1) / 0.1) * 100) +
    `<div class="kv"><span>Peer-multiple price, before adjustments</span><b>${money(m.comp_value_usd)}</b></div>` +
    factorRow(
      `Size-curve multiple — fitted, not peered`,
      m.curve_multiple.toFixed(3) + '×',
      `The fitted curve log(market cap) = ${D.validation.curve_intercept.toFixed(2)} + ${D.validation.curve_slope.toFixed(2)} &times; log(TVL)` +
        (m.curve_category_comps >= 8 ? `, with this category's own intercept from its ${m.curve_category_comps} traded peers.` : `, on the market-wide line (this category has ${m.curve_category_comps} traded peers, too few for its own intercept).`),
      (m.curve_multiple / 2) * 100,
    ) +
    `<div class="kv"><span>Size-curve price, before adjustments</span><b>${money(m.curve_value_usd)}</b></div>` +
    `<div class="total"><span>Implied value</span><b>${money(r.implied_value_usd)}</b></div>` +
    `<div class="kv"><span>Range across the two methods</span><b>${money(m.value_low_usd)} – ${money(m.value_high_usd)}</b></div>` +
    `<p class="note">The blended value is the geometric mean of the two prices, moved by the three adjustments. The range is the two prices themselves, adjusted the same way: narrow where the methods agree, wide where they fight. Implied value is what a token would be worth if this record stayed as it is — the radar's own claim, not a forecast of a launch.</p>` +
    `</div>` +
    `<div class="card"><h3>Farm plan</h3>` +
    `<div class="kv"><span>Plan cost — fees, gas, interest</span><b>about $${r.plan.fee_usd}</b></div>` +
    `<div class="kv"><span>Capital the plan puts to work</span><b>$${r.plan.capital_usd}</b></div>` +
    `<div class="kv"><span>Your time</span><b>${r.plan.minutes} minutes over ${r.plan.weeks} weeks</b></div>` +
    `<ol class="steps">` +
    r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('') +
    `</ol><p class="note">Costs and times are approximate, in US dollars, at the snapshot date. Protocols are risky: never farm with funds you cannot afford to lose.</p></div>` +
    `</div>`;
  document.getElementById('backLink').addEventListener('click', () => {
    state.p = null;
    writeHash(state);
    render();
  });
}

/* ---------------------------------------------------------------- model view */

/** The fitted-versus-actual scatter as one inline SVG: log-log, one point per traded protocol. */
function scatterSvg() {
  const pts = D.validation.scatter;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of pts) {
    lo = Math.min(lo, x, y);
    hi = Math.max(hi, x, y);
  }
  lo = Math.floor(lo);
  hi = Math.ceil(hi);
  const W = 560;
  const H = 420;
  const pad = 44;
  const sx = (v) => pad + ((v - lo) / (hi - lo)) * (W - pad - 12);
  const sy = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad - 12);
  let g = '';
  for (let v = lo; v <= hi; v++) {
    const label = v >= 9 ? `$${Math.round(10 ** (v - 9))}B` : v >= 6 ? `$${Math.round(10 ** (v - 6))}M` : `$${Math.round(10 ** (v - 3))}K`;
    g += `<line x1="${sx(v)}" y1="${sy(lo)}" x2="${sx(v)}" y2="${sy(hi)}" class="grid"/>` +
      `<line x1="${sx(lo)}" y1="${sy(v)}" x2="${sx(hi)}" y2="${sy(v)}" class="grid"/>` +
      `<text x="${sx(v)}" y="${H - pad + 18}" class="ax">${label}</text>` +
      `<text x="${pad - 8}" y="${sy(v) + 4}" class="ax" text-anchor="end">${label}</text>`;
  }
  const dots = pts.map(([x, y]) => `<circle cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="3"/>`).join('');
  return (
    `<svg viewBox="0 0 ${W} ${H}" class="scatter" role="img" aria-label="Fitted versus actual market caps of the traded protocols">` +
    g +
    `<line x1="${sx(lo)}" y1="${sy(lo)}" x2="${sx(hi)}" y2="${sy(hi)}" class="diag"/>` +
    `<g class="dots">${dots}</g>` +
    `<text x="${(W + pad) / 2}" y="${H - 6}" class="ax" text-anchor="middle">Actual market cap (log scale)</text>` +
    `<text x="14" y="${(H - pad) / 2}" class="ax" text-anchor="middle" transform="rotate(-90 14 ${(H - pad) / 2})">Model's fitted value (log scale)</text>` +
    `</svg>`
  );
}

function statRow(label, s, bold) {
  return `<tr${bold ? ' class="ens"' : ''}><td>${esc(label)}</td><td class="num">${s.median_ape_pct}%</td><td class="num">${s.within_2x_pct}%</td><td class="num">${s.median_ratio.toFixed(3)}</td></tr>`;
}

function renderModel() {
  const v = D.validation;
  const el = document.getElementById('modelView');
  el.innerHTML =
    `<a class="back" id="modelBack">&larr; Back to the board</a>` +
    `<div class="detail-head"><h2>How the model works</h2><span class="slug">and how it scored on the only ground truth there is</span></div>` +
    `<div class="grid model-grid">` +
    `<div class="card"><h3>Two pricings, blended</h3>` +
    `<p class="mtext">A protocol that records no token has no price, so the radar prices it twice, from the ${v.comps} protocols in the snapshot whose tokens do trade.</p>` +
    `<p class="mtext"><b>Peer multiples.</b> In each category, take the median market-cap/TVL of the traded protocols (ratios winsorised to 0.01–10&times; first, so one micro-cap cannot set a category's price). A category with few peers is shrunk toward the market-wide median of ${D.global_multiple.toFixed(3)}&times;; one with none uses it outright. Price = TVL &times; the multiple.</p>` +
    `<p class="mtext"><b>The size curve.</b> Fit one line through every traded protocol: log(market cap) = ${v.curve_intercept.toFixed(3)} + ${v.curve_slope.toFixed(3)} &times; log(TVL). A slope under 1 says big protocols carry less market cap per TVL dollar than small ones. A category with at least 8 traded peers gets its own intercept on that line, shrunk toward the market's. Price = the curve's value at the protocol's TVL.</p>` +
    `<p class="mtext"><b>The blend.</b> The board's value is the geometric mean of the two prices — equal weight in log space — then three nudges from the protocol's own record: growth (its 7-day TVL change, half weight, clamped), maturity (+6% per year run with no token, up to six years), breadth (+2% per extra chain, up to five). The two prices, adjusted the same way, are printed on every detail page as the value range.</p>` +
    `<p class="mtext">Nothing here is a list of names: the same code prices every protocol, and a protocol whose token already trades is never on the board.</p>` +
    `</div>` +
    `<div class="card"><h3>The backtest: leave-one-out</h3>` +
    `<p class="mtext">Each of the ${v.comps} traded protocols was priced by the full model fitted <i>without it</i> — its category's median, the curve, the blend, its own record's nudges — and the price set against the market cap it actually carries. Median error is the median absolute miss; within 2&times; is the share priced between half and double the truth.</p>` +
    `<table class="stats"><thead><tr><th>Method</th><th class="num">Median error</th><th class="num">Within 2&times;</th><th class="num">Median ratio</th></tr></thead><tbody>` +
    statRow('Peer multiples alone', v.comps_only, false) +
    statRow('Size curve alone', v.curve_only, false) +
    statRow('The ensemble (this board)', v.ensemble, true) +
    `</tbody></table>` +
    `<p class="mtext">The curve alone is the most accurate single method here; the multiples alone run high (median ratio ${v.comps_only.median_ratio.toFixed(2)}). The ensemble is kept anyway, on purpose: the two methods fail on different protocols, the blend hedges both, and their disagreement is information the board shows as a range instead of hiding. Errors near 90% are what pricing an unlaunched token honestly looks like — TVL explains a protocol's scale, not its whole worth.</p>` +
    `</div>` +
    `<div class="card"><h3>Fitted versus actual</h3>` +
    scatterSvg() +
    `<p class="note">One point per traded protocol: its real market cap across, the full model's fitted value up, both on log scales. The dashed line is a perfect fit. Points above it are protocols the model prices rich; below it, cheap. This chart is the full fit on its own training set — the honest out-of-sample figures are the leave-one-out table.</p>` +
    `</div>` +
    `<div class="card"><h3>Category pricing lines</h3>` +
    `<table class="stats"><thead><tr><th>Category</th><th class="num">Traded peers</th><th class="num">Multiple used</th><th>Curve</th></tr></thead><tbody>` +
    D.categories.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.comps}</td><td class="num">${c.multiple.toFixed(3)}&times;</td><td>${c.curve_intercept ? 'own intercept' : 'market line'}</td></tr>`).join('') +
    `</tbody></table>` +
    `<p class="note">The multiple a category's pre-token protocols are priced at, and whether the size curve gives the category its own intercept (8 or more traded peers) or prices it on the market-wide line.</p>` +
    `</div>` +
    `</div>`;
  document.getElementById('modelBack').addEventListener('click', () => {
    state.model = false;
    writeHash(state);
    render();
  });
}

/* ---------------------------------------------------------------- render + wiring */

/** Keep the controls showing the state the hash describes (a view can arrive by link, not only by clicks). */
function syncControls() {
  document.getElementById('q').value = state.q;
  document.getElementById('cat').value = state.cat;
  document.getElementById('chain').value = state.chain;
  document.getElementById('watchOnly').checked = state.watch;
}

function render() {
  syncControls();
  const detail = state.p ? bySlug.get(state.p) : undefined;
  const showModel = detail === undefined && state.model;
  document.getElementById('boardView').hidden = detail !== undefined || showModel;
  document.getElementById('detailView').hidden = detail === undefined;
  document.getElementById('modelView').hidden = !showModel;
  if (detail !== undefined) {
    renderDetail(detail);
    window.scrollTo(0, 0);
  } else if (showModel) {
    renderModel();
    window.scrollTo(0, 0);
  } else {
    renderBoard();
  }
}

function fillSelect(id, values, allLabel) {
  const sel = document.getElementById(id);
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
}

function init() {
  renderMast();
  const cats = [...new Set(rows.map((r) => r.category).filter((c) => c !== null))].sort();
  const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
  fillSelect('cat', cats, 'All categories');
  fillSelect('chain', chains, 'All chains');
  const q = document.getElementById('q');
  const cat = document.getElementById('cat');
  const chain = document.getElementById('chain');
  const watch = document.getElementById('watchOnly');
  q.value = state.q;
  cat.value = state.cat;
  chain.value = state.chain;
  watch.checked = state.watch;
  q.addEventListener('input', () => { state.q = q.value; writeHash(state); renderBoard(); });
  cat.addEventListener('change', () => { state.cat = cat.value; writeHash(state); renderBoard(); });
  chain.addEventListener('change', () => { state.chain = chain.value; writeHash(state); renderBoard(); });
  watch.addEventListener('change', () => { state.watch = watch.checked; writeHash(state); renderBoard(); });
  document.querySelectorAll('#boardTable thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.getAttribute('data-sort');
      if (state.sort === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort = k; state.dir = k === 'name' || k === 'category' ? 'asc' : 'desc'; }
      writeHash(state);
      renderBoard();
    });
  });
  window.addEventListener('hashchange', () => { state = readHash(); render(); });
  render();
}

init();
