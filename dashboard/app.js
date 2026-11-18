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
  document.getElementById('modelStrip').innerHTML =
    `<span class="formula">Implied value = TVL &times; <span class="fx">category multiple</span> &times; ` +
    `<span class="fx">growth</span> &times; <span class="fx">maturity</span> &times; <span class="fx">breadth</span></span>` +
    ` &nbsp;The multiple is the median market-cap/TVL of the category's traded protocols, shrunk toward the market-wide median of ` +
    `<b>${D.global_multiple.toFixed(3)}&times;</b> when a category has few peers. Growth reads the 7-day TVL change, maturity the years run with no token, breadth the chain count. ` +
    `Protocols whose token already trades are never on this board.`;
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
    `<div class="total"><span>Implied value</span><b>${money(r.implied_value_usd)}</b></div>` +
    `<p class="note">Implied value is what a token would be worth if this record stayed as it is — the radar's own claim, not a forecast of a launch.</p>` +
    `</div>` +
    `<div class="card"><h3>Farm plan</h3><ol class="steps">` +
    r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('') +
    `</ol><p class="note">Costs and times are approximate, in US dollars, at the snapshot date. Protocols are risky: never farm with funds you cannot afford to lose.</p></div>` +
    `</div>`;
  document.getElementById('backLink').addEventListener('click', () => {
    state.p = null;
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
  document.getElementById('boardView').hidden = detail !== undefined;
  document.getElementById('detailView').hidden = detail === undefined;
  if (detail !== undefined) {
    renderDetail(detail);
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
