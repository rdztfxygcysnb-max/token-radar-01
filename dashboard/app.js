// Token Radar (radar-2): reads window.RADAR beside dashboard/, renders the ranked board,
// a per-protocol detail view with the full factor breakdown, and the live-token calibration view.
// No network: every figure shown comes from data.js. The page recomputes each row's implied value
// from the snapshot figures (impliedOf) and checks it against the number board.json carries.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var M = DATA.model || {};
  var state = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- formatting ---------- */
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function fmtMult(n) { return (Math.round(n * 1e4) / 1e4).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0'); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ---------- the model, recomputed in the page ---------- */
  // implied = round(tvl x baseMultiple x growthMult x maturityMult x chainMult)
  //   growthMult   = 1 + clamp(change_7d, growth_floor, growth_cap) / 100 x growth_weight
  //   maturityMult = maturity_floor + min(max(age,0), maturity_days) / maturity_days x maturity_range
  //   chainMult    = 1 + min(max(chains-1, 0) x chain_per_extra, chain_cap)
  // age unknown uses unknown_age_days; change_7d unreported counts as 0.
  function growthOf(r) {
    var g = clamp(r.change_7d === null || r.change_7d === undefined ? 0 : r.change_7d, M.growth_floor, M.growth_cap);
    return { pct: g, mult: 1 + (g / 100) * M.growth_weight };
  }
  function maturityOf(r) {
    var age = r.age_days === null || r.age_days === undefined ? M.unknown_age_days : r.age_days;
    return { age: age, mult: M.maturity_floor + (Math.min(Math.max(age, 0), M.maturity_days) / M.maturity_days) * M.maturity_range };
  }
  function chainOf(r) {
    var extra = Math.max(((r.chains || []).length - 1), 0);
    return { extra: extra, mult: 1 + Math.min(extra * M.chain_per_extra, M.chain_cap) };
  }
  function impliedOf(r) {
    var g = growthOf(r).mult, m = maturityOf(r).mult, c = chainOf(r).mult;
    return Math.max(1, Math.round(r.tvl_usd * r.base_multiple * g * m * c));
  }
  function calFor(category) {
    var list = DATA.calibration || [];
    for (var i = 0; i < list.length; i++) if (list[i].category === category) return list[i];
    return null;
  }

  /* ---------- farm plan: same derivation main.ts writes to board.json ---------- */
  // Category, chains, TVL tier and age decide the action, the capital, the hold and every cost
  // and time. No protocol name is special-cased. Seven steps, each with a cost and a time.
  function chainName(p) { return p.chains && p.chains.length ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  // [keywords, main action, second distinct action] per category family.
  var ACTIONS = [
    [['lend', 'cdp', 'collateral'], 'Supply $C of USDC to @@N@@ on @@CH@@ and keep the position open', 'Borrow $B of USDC against the deposit, then repay it the same week'],
    [['dex', 'amm', 'swap'], 'Provide $C of liquidity to the main @@N@@ pool on @@CH@@ and keep the position open', 'Swap $B of USDC for the pool asset through @@N@@ and back'],
    [['yield', 'leveraged farm', 'farm', 'vault'], 'Deposit $C of USDC into the @@N@@ vault on @@CH@@ and keep the shares', 'Harvest or compound the vault rewards once, then re-deposit'],
    [['bridge', 'cross chain'], 'Bridge $C of USDC to @@CH@@ through @@N@@ and use the bridged funds in its app', 'Bridge $B back through @@N@@ a week later so the round trip is on record'],
    [['staking', 'restak', 'liquid staking'], 'Stake $C of the chain staking asset through @@N@@ on @@CH@@ and keep the receipt', 'Restake or delegate the receipt token once more through @@N@@'],
    [['perpetual', 'derivative', 'options'], 'Deposit $C of USDC as margin on @@N@@ and open one small hedged position', 'Close the hedge, then open a second small position in the opposite direction'],
    [['prediction'], 'Fund $C and place one market position on @@N@@', 'Settle the first position, then place a second on a different market'],
    [['curator', 'allocator', 'risk'], 'Deposit $C into a @@N@@ vault on @@CH@@ and keep the shares', 'Vote on one allocation proposal in @@N@@ governance'],
    [['stable'], 'Mint or deposit $C of the stable asset through @@N@@ on @@CH@@', 'Redeem $B of the stable asset, then mint it again to show both directions'],
    [['rwa'], 'Mint $C of the yield asset on @@CH@@ through @@N@@ and hold it', 'Claim one round of yield from the @@N@@ position and re-deposit it'],
    [['insurance'], 'Buy $C of cover from @@N@@ on @@CH@@ and keep the policy', 'Renew or extend the cover once before it lapses'],
    [['payment'], 'Send $C through @@N@@ on @@CH@@ to a wallet you control', 'Receive a $B payment back through @@N@@ and keep the receipt'],
    [['chain'], 'Bridge $C of USDC onto @@CH@@ and use @@N@@ as your first app there', 'Make a second transaction inside @@N@@ a week later'],
    [['', ''], 'Deposit $C of USDC into @@N@@ on @@CH@@ and keep the position open', 'Make a second, different action inside @@N@@, such as a swap or a vote']
  ];
  function actionPair(p) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < ACTIONS.length; i++) {
      var keys = ACTIONS[i][0];
      for (var j = 0; j < keys.length; j++) {
        if (keys[j] && c.indexOf(keys[j]) >= 0) return ACTIONS[i];
      }
    }
    return ACTIONS[ACTIONS.length - 1];
  }
  function fill(tpl, p, capital, chain) {
    return tpl.split('$C').join('$' + capital).split('$B').join('$' + Math.max(10, Math.round(capital / 5))).split('@@N@@').join(p.name).split('@@CH@@').join(chain);
  }
  function stepText(s) {
    var out = s.text + ' Cost: ' + s.cost + '. Time: ' + s.time + '.';
    if (out.length > 600) out = out.slice(0, 596) + '...';
    if (out.length < 20) out += ' Hold the position and check the protocol page.';
    return out;
  }
  function farmSteps(p) {
    var chain = chainName(p), capital = capitalFor(p), hold = holdDaysFor(p.age_days);
    var pair = actionPair(p), gas = capital >= 150 ? 8 : 4;
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: fill(pair[1], p, capital, chain) + '.', cost: '$' + capital + ' of capital and about $' + gas + ' of gas', time: '15 minutes to set up' },
      { text: fill(pair[2], p, capital, chain) + '.', cost: 'about $3 of gas', time: '10 minutes' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Before you withdraw, open the protocol\u2019s own points or rewards page and claim only from the link it publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log, and plan the exit: unwind in reverse order and keep $10 of gas in the wallet.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  /* ---------- element helper ---------- */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var ch = arguments[i];
      if (ch === null || ch === undefined) continue;
      if (Array.isArray(ch)) ch.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof ch === 'string') node.appendChild(document.createTextNode(ch));
      else node.appendChild(ch);
    }
    return node;
  }

  /* ---------- hash deep-links ---------- */
  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('tab') === 'live') state.tab = 'live';
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /* ---------- filtering and sorting ---------- */
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  /* ---------- board ---------- */
  function growthCell(r) {
    var cls = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
    return el('td', { class: 'num ' + cls, text: fmtPct(r.change_7d) });
  }
  function renderBoard() {
    var tbody = $('boardBody');
    tbody.textContent = '';
    var list = sortedRows(filteredRows());
    var max = 1;
    DATA.rows.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    $('emptyState').hidden = list.length !== 0;
    $('board').querySelector('.table-wrap').style.display = list.length === 0 ? 'none' : '';
    list.forEach(function (r) {
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (r.chains && r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        growthCell(r),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }), r.watchlist ? el('span', { class: 'watch', text: ' watchlist' }) : null)
      );
      tbody.appendChild(tr);
    });
    $('count').textContent = list.length + ' of ' + DATA.rows.length + ' rows shown';
  }

  /* ---------- live tab + calibration ---------- */
  function renderLive() {
    var tbody = $('liveBody');
    tbody.textContent = '';
    (DATA.live || []).forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    var cal = $('calBody');
    cal.textContent = '';
    (DATA.calibration || []).slice().sort(function (a, b) { return b.multiple - a.multiple; }).forEach(function (c) {
      cal.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: fmtMult(c.multiple) + '×' }),
        el('td', { class: 'num', text: String(c.peers) }),
        el('td', { text: c.fallback ? 'Yes — global median ' + fmtMult(M.global_median_multiple) + '×' : 'No' })
      ));
    });
    $('count').textContent = (DATA.live || []).length + ' live-token protocols';
  }

  /* ---------- detail dialog ---------- */
  var dialog = $('detail');
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); renderBoard(); });
  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var g = growthOf(row), m = maturityOf(row), c = chainOf(row);
    var recomputed = impliedOf(row);
    var matches = recomputed === row.implied_value_usd;
    var cal = calFor(row.category);
    var baseNote = cal
      ? 'Median of ' + cal.peers + ' live-token peer' + (cal.peers === 1 ? '' : 's') + (cal.fallback ? ' — too few peers, so the global median is used' : '') + ' in ' + (row.category || 'Other') + '.'
      : 'Global median multiple — no category peers on record.';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'rank', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · Watchlist' : ' · Early radar') }),
        el('h2', { id: 'detailTitle', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · records no token' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    var eq = el('div', { class: 'equation' });
    eq.appendChild(el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })));
    eq.appendChild(el('div', null, el('span', { text: 'Category multiple (' + (row.category || 'Other') + ')' }), el('b', { text: fmtMult(row.base_multiple) + '×' })));
    eq.appendChild(el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { text: fmtPct(row.change_7d) + ' → ' + fmtMult(g.mult) + '×' })));
    eq.appendChild(el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(row.age_days) + ' → ' + fmtMult(m.mult) + '×' })));
    eq.appendChild(el('div', null, el('span', { text: 'Chains (' + (row.chains || []).length + ')' }), el('b', { text: '+' + c.extra + ' extra → ' + fmtMult(c.mult) + '×' })));
    eq.appendChild(el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) })));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value — factor breakdown' }),
      eq,
      el('p', { class: 'note', text: baseNote }),
      el('p', { class: 'match' + (matches ? '' : ' bad'), text: matches
        ? 'Recomputed in this page from the snapshot figures: ' + fmtUsd(recomputed) + ' — matches board.json.'
        : 'Recomputed in this page: ' + fmtUsd(recomputed) + ' — does not match board.json (' + fmtUsd(row.implied_value_usd) + '); the data would be stale.' }),
      el('p', { class: 'note', text: 'An estimate, not a price. It does not predict whether or when a token is issued.' })
    ));
    var steps = farmSteps(row);
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — 7 steps' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
    renderBoard();
  }

  /* ---------- tabs, controls, render ---------- */
  function setTab(tab) {
    state.tab = tab;
    $('tabPre').setAttribute('aria-pressed', tab === 'pre-token' ? 'true' : 'false');
    $('tabLive').setAttribute('aria-pressed', tab === 'live' ? 'true' : 'false');
    $('prePanel').hidden = tab !== 'pre-token';
    $('livePanel').hidden = tab !== 'live';
    writeHash();
    render();
  }
  function render() {
    if (state.tab === 'pre-token') renderBoard(); else renderLive();
    document.querySelectorAll('[data-arrow]').forEach(function (s) {
      s.textContent = state.sort === s.getAttribute('data-arrow') ? (state.dir < 0 ? ' ↓' : ' ↑') : '';
    });
  }
  function initStatic() {
    $('snapDate').textContent = 'Snapshot ' + DATA.as_of;
    $('ledeHead').textContent = DATA.watchlist_size + ' watchlist protocols, ranked by implied value';
    $('floorUsd').textContent = '$' + Math.round(DATA.floor_usd / 1e6) + 'M';
    $('earlyCount').textContent = DATA.early_size + '';
    $('factWatch').textContent = DATA.watchlist_size + ' / ' + DATA.watchlist_size;
    $('factBoard').textContent = String(DATA.board_size);
    $('factEarly').textContent = String(DATA.early_size);
    $('factLive').textContent = String(DATA.live_size);
    $('sourceLine').textContent = 'Source: ' + DATA.source + '. Snapshot only — no hand-kept list of names.';
    $('formula').innerHTML = '';
    $('formula').appendChild(document.createTextNode('implied = round( TVL × '));
    var b = document.createElement('b'); b.textContent = 'category multiple'; $('formula').appendChild(b);
    $('formula').appendChild(document.createTextNode(' × (1 + clamp(7d change, ' + M.growth_floor + ', ' + M.growth_cap + ') / 100 × ' + M.growth_weight + ') × (' + M.maturity_floor + ' + min(age, ' + M.maturity_days + ') / ' + M.maturity_days + ' × ' + M.maturity_range + ') × (1 + min(extra chains × ' + M.chain_per_extra + ', ' + M.chain_cap + ')) )'));
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var sel = $('category');
    sel.appendChild(el('option', { value: 'all', text: 'All categories' }));
    cats.forEach(function (c) { sel.appendChild(el('option', { value: c, text: c })); });
    sel.value = state.category;
    var q = $('q');
    q.value = state.q;
    q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); });
    sel.addEventListener('change', function () { state.category = sel.value; writeHash(); render(); });
    $('tabPre').addEventListener('click', function () { setTab('pre-token'); });
    $('tabLive').addEventListener('click', function () { setTab('live'); });
    $('clearFilters').addEventListener('click', function () {
      state.q = ''; state.category = 'all';
      $('q').value = ''; $('category').value = 'all';
      writeHash(); render();
    });
    document.querySelectorAll('[data-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-sort');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === 'name' ? 1 : -1; }
        render();
      });
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dialog.open) dialog.close();
    });
  }

  readHash();
  initStatic();
  if (state.tab === 'live') setTab('live'); else render();
  if (state.selected) openDetail(state.selected);
})();
