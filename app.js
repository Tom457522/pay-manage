'use strict';

// ===== 定数・ストレージ =====
const STORE_KEY = 'futari-seisan-v1';
const METHODS = { paypay: 'PayPay', credit: 'クレカ', cash: '現金', other: 'その他' };
const DEFAULT_MODEL = 'claude-opus-5-5';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm';

const defaultData = () => ({
  settings: { names: { a: '夫', b: '妻' }, ratio: 50, apiKey: '', model: DEFAULT_MODEL },
  payments: [],
  settlements: [],
});

let data = load();
let draft = null;        // 編集中の支払い
let photoDataUrl = null; // 縮小済みレシート画像

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultData();
    const d = JSON.parse(raw);
    const base = defaultData();
    return { ...base, ...d, settings: { ...base.settings, ...d.settings, names: { ...base.settings.names, ...(d.settings || {}).names } } };
  } catch {
    return defaultData();
  }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
  catch { toast('保存に失敗しました（ストレージ不可）'); }
}

// ===== ユーティリティ =====
const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const yen = (n) => '¥' + Math.round(n || 0).toLocaleString('ja-JP');
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
const name = (who) => data.settings.names[who];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const livePayments = () => data.payments.filter((p) => !p.deleted);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ===== 計算 =====
// 1件の支払いについて、それぞれの負担額を返す。
// 品目合計と支払合計がずれる分（外税・値引き・端数）は品目金額に比例して按分する。
function burden(p) {
  const total = Number(p.total) || 0;
  const r = (p.ratio ?? data.settings.ratio) / 100;
  const items = (p.items || []).filter((it) => Number(it.price));
  const sum = items.reduce((s, it) => s + Number(it.price), 0);
  let rawA;
  if (!items.length || sum === 0) {
    rawA = p.wholeOwner === 'a' ? total : p.wholeOwner === 'b' ? 0 : total * r;
  } else {
    const shareA = items.reduce((s, it) => {
      const price = Number(it.price);
      return s + (it.owner === 'a' ? price : it.owner === 'both' ? price * r : 0);
    }, 0);
    rawA = shareA * (total / sum);
  }
  const a = Math.round(rawA);
  return { a, b: total - a };
}

// 支払いを「aだけのもの / bだけのもの / 共有」に分ける（税・値引きの差額も比例按分）。
function split(p) {
  const total = Number(p.total) || 0;
  const items = (p.items || []).filter((it) => Number(it.price));
  const sum = items.reduce((s, it) => s + Number(it.price), 0);
  if (!items.length || sum === 0) {
    const o = p.wholeOwner || 'both';
    return { a: o === 'a' ? total : 0, b: o === 'b' ? total : 0, shared: o === 'both' ? total : 0 };
  }
  const k = total / sum;
  const pick = (owner) => items.filter((it) => it.owner === owner).reduce((s, it) => s + Number(it.price), 0) * k;
  const a = Math.round(pick('a'));
  const b = Math.round(pick('b'));
  return { a, b, shared: total - a - b };
}

// 未清算分の集計。net > 0 なら b → a に支払う。
function summary() {
  const s = { paidA: 0, paidB: 0, burdenA: 0, burdenB: 0, net: 0, count: 0 };
  for (const p of livePayments()) {
    if (p.settled) continue;
    const bd = burden(p);
    s.count++;
    s.burdenA += bd.a;
    s.burdenB += bd.b;
    if (p.payer === 'a') s.paidA += Number(p.total) || 0;
    else s.paidB += Number(p.total) || 0;
  }
  s.net = s.paidA - s.burdenA; // a の立替超過分
  return s;
}

// ===== 画面切り替え =====
function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'home') renderHome();
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  if (view === 'monthly') renderMonthly();
  window.scrollTo(0, 0);
}

// ===== ホーム =====
function renderHome() {
  const s = summary();
  const amt = Math.abs(s.net);
  if (s.count === 0) {
    $('#balance-text').textContent = '未清算の記録はありません';
    $('#balance-detail').textContent = '';
  } else if (amt === 0) {
    $('#balance-text').textContent = '差額なし 🎉';
    $('#balance-detail').textContent = `${s.count}件の記録`;
  } else {
    const [from, to] = s.net > 0 ? ['b', 'a'] : ['a', 'b'];
    $('#balance-text').innerHTML = `<span class="${from}-text">${esc(name(from))}</span> → <span class="${to}-text">${esc(name(to))}</span>　${yen(amt)}`;
    $('#balance-detail').textContent = `${s.count}件の記録から計算`;
  }
  $('#btn-settle').disabled = s.count === 0;
  $('#paid-a').textContent = `${name('a')} ${yen(s.paidA)}`;
  $('#paid-b').textContent = `${name('b')} ${yen(s.paidB)}`;
  $('#burden-a').textContent = `${name('a')} ${yen(s.burdenA)}`;
  $('#burden-b').textContent = `${name('b')} ${yen(s.burdenB)}`;

  const recent = [...livePayments()].sort(byDateDesc).slice(0, 5);
  renderEntries($('#recent-list'), recent, 'まだ記録がありません。「記録」から追加しましょう。');
}

function settle() {
  const s = summary();
  const amt = Math.abs(s.net);
  const [from, to] = s.net >= 0 ? ['b', 'a'] : ['a', 'b'];
  const msg = amt === 0
    ? `${s.count}件を清算済みにしますか？`
    : `${name(from)} → ${name(to)} に ${yen(amt)} 支払ったものとして、${s.count}件を清算済みにしますか？`;
  if (!confirm(msg)) return;
  const ids = livePayments().filter((p) => !p.settled).map((p) => p.id);
  const now = Date.now();
  data.payments.forEach((p) => { if (ids.includes(p.id)) { p.settled = true; p.updatedAt = now; } });
  const st = { id: uid(), date: today(), from, to, amount: amt, paymentIds: ids, updatedAt: now };
  data.settlements.push(st);
  save();
  push('payments', data.payments.filter((p) => ids.includes(p.id)));
  push('settlements', [st]);
  toast('清算しました');
  renderHome();
}

// ===== 履歴 =====
const byDateDesc = (x, y) => (y.date || '').localeCompare(x.date || '') || (y.createdAt || 0) - (x.createdAt || 0);

function renderEntries(el, list, emptyMsg) {
  if (!list.length) { el.innerHTML = `<div class="empty">${emptyMsg}</div>`; return; }
  el.innerHTML = list.map((p) => {
    const bd = burden(p);
    return `<button class="entry" data-id="${p.id}">
      <div style="min-width:0">
        <div class="title">${esc(p.store || '（店名なし）')}</div>
        <div class="meta"><span class="badge ${p.payer}">${esc(name(p.payer))}払い</span><span class="badge">${METHODS[p.method] || ''}</span>${esc(p.date)}${p.settled ? '・清算済' : ''}</div>
      </div>
      <div class="amount">${yen(p.total)}<div class="meta">${esc(name('a'))} ${yen(bd.a)} / ${esc(name('b'))} ${yen(bd.b)}</div></div>
    </button>`;
  }).join('');
  el.querySelectorAll('.entry').forEach((b) => b.addEventListener('click', () => openEdit(b.dataset.id)));
}

function renderHistory() {
  const filter = $('#history-filter').value;
  const list = livePayments().filter((p) => filter === 'all' || !p.settled).sort(byDateDesc);
  renderEntries($('#history-list'), list, '記録がありません');

  const sts = data.settlements.filter((s) => !s.deleted).sort((x, y) => y.date.localeCompare(x.date));
  const el = $('#settlement-list');
  if (!sts.length) { el.innerHTML = '<div class="empty">まだ清算していません</div>'; return; }
  el.innerHTML = sts.map((s) => `<div class="entry" style="cursor:default">
      <div><div class="title">${esc(s.date)}</div><div class="meta">${s.paymentIds.length}件を清算</div></div>
      <div class="amount">${esc(name(s.from))} → ${esc(name(s.to))} ${yen(s.amount)}
        <div><button class="btn tiny" data-undo="${s.id}">取り消す</button></div></div>
    </div>`).join('');
  el.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', () => undoSettlement(b.dataset.undo)));
}

function undoSettlement(id) {
  const s = data.settlements.find((x) => x.id === id);
  if (!s || !confirm('この清算を取り消して、対象の記録を未清算に戻しますか？')) return;
  const now = Date.now();
  s.deleted = true; s.updatedAt = now;
  data.payments.forEach((p) => { if (s.paymentIds.includes(p.id)) { p.settled = false; p.updatedAt = now; } });
  save();
  push('payments', data.payments.filter((p) => s.paymentIds.includes(p.id)));
  push('settlements', [s]);
  renderHistory();
}

// ===== 月ごとの集計 =====
let curMonth = today().slice(0, 7); // YYYY-MM

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const monthLabel = (ym) => `${Number(ym.slice(0, 4))}年${Number(ym.slice(5))}月`;
const inMonth = (ym) => livePayments().filter((p) => (p.date || '').startsWith(ym));
const monthTotal = (ym) => inMonth(ym).reduce((s, p) => s + (Number(p.total) || 0), 0);

function hbars(el, rows, emptyMsg) {
  if (!rows.length) { el.innerHTML = `<div class="empty">${emptyMsg}</div>`; return; }
  const max = Math.max(...rows.map((r) => r.value), 1);
  el.innerHTML = rows.map((r) => `
    <div class="hbar" title="${esc(r.label)}：${yen(r.value)}（${r.count}件）">
      <span class="label">${esc(r.label)}</span>
      <div class="track"><div class="fill" style="width:${(r.value / max) * 100}%"></div></div>
      <span class="val">${yen(r.value)}<small>${r.count}件</small></span>
    </div>`).join('');
}

function groupSum(list, keyFn) {
  const m = new Map();
  for (const p of list) {
    const k = keyFn(p);
    const g = m.get(k) || { label: k, value: 0, count: 0 };
    g.value += Number(p.total) || 0;
    g.count++;
    m.set(k, g);
  }
  return [...m.values()].sort((x, y) => y.value - x.value);
}

function renderMonthly() {
  const ym = curMonth;
  const list = inMonth(ym);
  const total = monthTotal(ym);
  $('#m-label').textContent = monthLabel(ym);
  $('#m-next').disabled = ym >= today().slice(0, 7);
  $('#m-total').textContent = yen(total);
  const prev = monthTotal(shiftMonth(ym, -1));
  const diff = prev ? Math.round(((total - prev) / prev) * 100) : null;
  $('#m-sub').textContent = `${list.length}件` + (diff === null ? '' : `・前月比 ${diff >= 0 ? '+' : ''}${diff}%`);

  // 負担の内訳（清算済み・未清算を問わずこの月の全記録）
  const t = { a: 0, b: 0, ownA: 0, ownB: 0, sharedA: 0, sharedB: 0, paidA: 0, paidB: 0 };
  for (const p of list) {
    const bd = burden(p);
    const sp = split(p);
    t.a += bd.a; t.b += bd.b;
    t.ownA += sp.a; t.ownB += sp.b;
    t.sharedA += bd.a - sp.a; t.sharedB += bd.b - sp.b;
    if (p.payer === 'a') t.paidA += Number(p.total) || 0;
    else t.paidB += Number(p.total) || 0;
  }
  const row = (label, a, b, cls = '') => `<tr class="${cls}"><td>${label}</td><td>${yen(a)}</td><td>${yen(b)}</td></tr>`;
  $('#m-burden').innerHTML = `
    <tr><th></th><th><span class="dot a"></span>${esc(name('a'))}</th><th><span class="dot b"></span>${esc(name('b'))}</th></tr>
    ${row('負担合計', t.a, t.b, 'strong')}
    ${row('　個人のもの', t.ownA, t.ownB)}
    ${row('　共有の負担分', t.sharedA, t.sharedB)}
    ${row('実際に払った額', t.paidA, t.paidB)}`;

  hbars($('#m-methods'), groupSum(list, (p) => METHODS[p.method] || 'その他'), 'この月の記録はありません');
  hbars($('#m-stores'), groupSum(list, (p) => p.store || '（店名なし）').slice(0, 5), 'この月の記録はありません');

  // 直近6か月（表示中の月を右端に）。棒をタップするとその月へ移動
  const months = [...Array(6)].map((_, i) => shiftMonth(ym, i - 5));
  const totals = months.map(monthTotal);
  const max = Math.max(...totals, 1);
  const trend = $('#m-trend');
  trend.innerHTML = months.map((m, i) => `
    <button data-m="${m}" class="${m === ym ? 'on' : ''}" title="${monthLabel(m)}：${yen(totals[i])}">
      <span class="v" style="bottom:calc(${(totals[i] / max) * 100}% + 4px)">${yen(totals[i])}</span>
      <div class="bar" style="height:${(totals[i] / max) * 100}%"></div>
    </button>`).join('');
  $('#m-trend-labels').innerHTML = months.map((m) => `<span class="${m === ym ? 'on' : ''}">${Number(m.slice(5))}月</span>`).join('');
  trend.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { curMonth = b.dataset.m; renderMonthly(); }));

  renderEntries($('#m-list'), [...list].sort(byDateDesc), 'この月の記録はありません');
}

// ===== 追加・編集 =====
function newDraft() {
  return { id: null, date: today(), store: '', payer: 'a', method: 'paypay', total: '', memo: '', items: [], wholeOwner: 'both', ratio: data.settings.ratio };
}

function openEdit(id) {
  const p = id && data.payments.find((x) => x.id === id);
  draft = p ? structuredClone(p) : newDraft();
  photoDataUrl = null;
  $('#photo-preview').hidden = true;
  $('#photo-placeholder').hidden = false;
  $('#photo-input').value = '';
  $('#camera-input').value = '';
  $('#btn-ai').disabled = $('#btn-ocr').disabled = true;
  $('#ocr-status').textContent = '';
  $('#edit-title').textContent = p ? '記録を編集' : '支払いを記録';
  $('#btn-delete').hidden = !p;
  fillForm();
  show('edit');
}

function segment(el, options, value, onPick) {
  el.innerHTML = options.map(([v, label]) => `<button type="button" data-v="${v}" class="${v === value ? 'on' : ''}">${esc(label)}</button>`).join('');
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset.v);
  }));
}
const ownerOptions = () => [['a', name('a')], ['both', '共有'], ['b', name('b')]];

function fillForm() {
  $('#f-date').value = draft.date;
  $('#f-store').value = draft.store;
  $('#f-total').value = draft.total;
  $('#f-memo').value = draft.memo || '';
  segment($('#f-payer'), [['a', name('a')], ['b', name('b')]], draft.payer, (v) => { draft.payer = v; });
  segment($('#f-method'), Object.entries(METHODS), draft.method, (v) => { draft.method = v; });
  segment($('#f-whole-owner'), ownerOptions(), draft.wholeOwner, (v) => { draft.wholeOwner = v; updateSummary(); });
  document.querySelector('[data-bulk=a]').textContent = name('a');
  document.querySelector('[data-bulk=b]').textContent = name('b');
  renderItems();
}

function renderItems() {
  const el = $('#items');
  el.innerHTML = draft.items.map((it, i) => `
    <div class="item" data-owner="${it.owner}" data-i="${i}">
      <div class="item-top">
        <input class="name" type="text" value="${esc(it.name)}" placeholder="品名">
        <input class="price" type="number" inputmode="numeric" value="${esc(it.price)}" placeholder="0">
        <button class="del" title="削除">✕</button>
      </div>
      <div class="seg"></div>
    </div>`).join('');
  el.querySelectorAll('.item').forEach((card) => {
    const i = Number(card.dataset.i);
    const it = draft.items[i];
    card.querySelector('.name').addEventListener('input', (e) => { it.name = e.target.value; });
    card.querySelector('.price').addEventListener('input', (e) => { it.price = e.target.value; updateSummary(); });
    card.querySelector('.del').addEventListener('click', () => { draft.items.splice(i, 1); renderItems(); });
    segment(card.querySelector('.seg'), ownerOptions(), it.owner, (v) => {
      it.owner = v;
      card.dataset.owner = v;
      updateSummary();
    });
  });
  const has = draft.items.length > 0;
  $('#items-empty').hidden = has;
  $('#whole-owner-wrap').hidden = has;
  document.querySelector('.bulk').hidden = !has;
  updateSummary();
}

function updateSummary() {
  draft.total = $('#f-total').value;
  const itemsSum = draft.items.reduce((s, it) => s + (Number(it.price) || 0), 0);
  const total = Number(draft.total) || (draft.items.length ? itemsSum : 0);
  const bd = burden({ ...draft, total });
  const payer = draft.payer;
  const other = payer === 'a' ? 'b' : 'a';
  $('#split-summary').innerHTML = `
    <div class="line"><span>${esc(name('a'))} の負担</span><span class="a-text">${yen(bd.a)}</span></div>
    <div class="line"><span>${esc(name('b'))} の負担</span><span class="b-text">${yen(bd.b)}</span></div>
    <div class="line muted small"><span>${esc(name(other))} → ${esc(name(payer))} の立替分</span><span>${yen(bd[other])}</span></div>`;
  const diff = total - itemsSum;
  $('#diff-note').textContent = draft.items.length && diff !== 0
    ? `品目合計 ${yen(itemsSum)} と支払合計の差 ${diff > 0 ? '+' : ''}${diff.toLocaleString()}円（税・値引きなど）は品目の金額に比例して按分します。`
    : '';
}

function readForm() {
  draft.date = $('#f-date').value || today();
  draft.store = $('#f-store').value.trim();
  draft.memo = $('#f-memo').value.trim();
  draft.total = $('#f-total').value;
}

function saveDraft() {
  readForm();
  draft.items = draft.items.filter((it) => it.name.trim() || Number(it.price));
  const itemsSum = draft.items.reduce((s, it) => s + (Number(it.price) || 0), 0);
  draft.total = Number(draft.total) || itemsSum;
  if (!draft.total) { toast('支払合計を入力してください'); return; }
  draft.items = draft.items.map((it) => ({ ...it, price: Number(it.price) || 0 }));
  const now = Date.now();
  draft.updatedAt = now;
  if (draft.id) {
    const i = data.payments.findIndex((p) => p.id === draft.id);
    data.payments[i] = draft;
  } else {
    draft.id = uid();
    draft.createdAt = now;
    draft.settled = false;
    data.payments.push(draft);
  }
  save();
  push('payments', [draft]);
  toast('保存しました');
  show('home');
}

function deleteDraft() {
  if (!draft.id || !confirm('この記録を削除しますか？')) return;
  const p = data.payments.find((x) => x.id === draft.id);
  p.deleted = true; // 他端末との統合のため墓標として残す
  p.updatedAt = Date.now();
  save();
  push('payments', [p]);
  toast('削除しました');
  show('home');
}

// ===== レシート画像 =====
async function onPhoto(file) {
  if (!file) return;
  try {
    photoDataUrl = await downscale(file, 1600);
  } catch {
    toast('画像を読み込めませんでした（HEIC の場合は JPEG で保存した写真を選んでください）');
    return;
  }
  $('#photo-preview').src = photoDataUrl;
  $('#photo-preview').hidden = false;
  $('#photo-placeholder').hidden = true;
  $('#btn-ai').disabled = false;
  $('#btn-ocr').disabled = false;
  $('#ocr-status').textContent = data.settings.apiKey ? '' : 'AI読み取りには設定で API キーが必要です。キーなしでは簡易OCRを使えます。';
}

async function downscale(file, maxSide) {
  const bmp = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

// createImageBitmap が扱えない形式（Safari の HEIC など）は <img> 経由で読み込む
async function loadImage(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// 読み取り結果をフォームに反映
function applyReceipt(r) {
  readForm();
  if (r.store) draft.store = r.store;
  if (r.date) draft.date = r.date;
  if (r.total) draft.total = r.total;
  if (r.method && METHODS[r.method] && r.method !== 'other') draft.method = r.method;
  draft.items = (r.items || []).map((it) => ({ id: uid(), name: it.name, price: it.price, owner: 'both' }));
  fillForm();
}

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    store: { type: 'string', description: '店名。不明なら空文字' },
    date: { type: 'string', description: 'YYYY-MM-DD。不明なら空文字' },
    total: { type: 'integer', description: '実際に支払った税込合計（円）' },
    method: { type: 'string', enum: ['paypay', 'credit', 'cash', 'other'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, price: { type: 'integer' } },
        required: ['name', 'price'],
        additionalProperties: false,
      },
    },
  },
  required: ['store', 'date', 'total', 'method', 'items'],
  additionalProperties: false,
};

const RECEIPT_PROMPT = `このレシート画像を読み取り、夫婦で品目ごとに負担者を仕分けるためのデータを作ってください。
- items には購入した商品を1行ずつ入れる。数量が複数なら、その行の金額（単価×数量）を price にする。
- 値引き・割引の行は独立した品目にせず、直前の商品の price から差し引く。
- 小計・合計・消費税・お預り・お釣り・ポイントなどの行は items に含めない。
- price はレシートに印字された金額をそのまま使う（外税表記なら税抜のままでよい）。
- total は実際に支払った税込の合計金額。
- method は支払い方法の表記から判断（PayPay→paypay、クレジット/カード→credit、現金/お預り→cash、それ以外や不明→other）。`;

async function aiRead() {
  const { apiKey, model } = data.settings;
  if (!apiKey) { toast('設定で API キーを入力してください'); show('settings'); return; }
  setBusy(true, 'Claude がレシートを読み取り中…');
  try {
    const { default: Anthropic } = await import(SDK_URL);
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const response = await client.beta.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoDataUrl.split(',')[1] } },
          { type: 'text', text: RECEIPT_PROMPT },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') throw new Error('この画像は読み取れませんでした');
    if (response.stop_reason === 'max_tokens') throw new Error('出力が途中で切れました。もう一度お試しください');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const result = JSON.parse(text);
    applyReceipt(result);
    setBusy(false, `${result.items.length}品目を読み取りました。各カードの負担者を選んでください。`);
  } catch (e) {
    console.error(e);
    const status = e && e.status;
    const msg = status === 401 ? 'API キーが正しくありません'
      : status === 429 ? '混雑しています。少し待って再度お試しください'
      : (e && e.message) || '読み取りに失敗しました';
    setBusy(false, '⚠ ' + msg);
  }
}

// API キーなしでも使える簡易OCR（Tesseract.js）。精度は低めなので結果は要確認。
async function ocrRead() {
  if (!window.Tesseract) { toast('OCRライブラリを読み込めませんでした'); return; }
  setBusy(true, '簡易OCRで読み取り中…（初回は辞書のダウンロードに時間がかかります）');
  try {
    const { data: res } = await Tesseract.recognize(photoDataUrl, 'jpn', {
      logger: (m) => {
        if (m.status === 'recognizing text') $('#ocr-status').textContent = `読み取り中… ${Math.round(m.progress * 100)}%`;
      },
    });
    const r = parseReceiptText(res.text);
    applyReceipt(r);
    setBusy(false, `${r.items.length}品目を検出しました（簡易OCRのため品名・金額を確認してください）。`);
  } catch (e) {
    console.error(e);
    setBusy(false, '⚠ 読み取りに失敗しました');
  }
}

function parseReceiptText(text) {
  const lines = text.split('\n').map((l) => l.replace(/[ 　]+/g, ' ').trim()).filter(Boolean);
  const z2h = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const skip = /小計|合計|お?預|釣|税|点数|対象|クレジット|ポイント|残高|電話|TEL|領収|レジ|担当|No\.|支払|カード|PayPay/i;
  const r = { store: '', date: '', total: 0, method: 'other', items: [] };
  for (const raw of lines) {
    const line = z2h(raw);
    const d = line.match(/(20\d{2})\s*[\/年.\-]\s*(\d{1,2})\s*[\/月.\-]\s*(\d{1,2})/);
    if (d && !r.date) r.date = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
    if (/paypay/i.test(line)) r.method = 'paypay';
    else if (/クレジット|カード|VISA|JCB|Master/i.test(line) && r.method === 'other') r.method = 'credit';
    else if (/お?預り?|釣/.test(line) && r.method === 'other') r.method = 'cash';
    const t = line.replace(/\s/g, '').match(/^合計[^\d]*([\d,]+)/);
    if (t) r.total = Number(t[1].replace(/,/g, ''));
    if (!r.store && !/\d{3,}/.test(line) && line.length >= 2) r.store = line.replace(/\s/g, '');
    if (skip.test(line)) continue;
    const m = line.match(/^(.*?[^\d\s,¥\\]).*?[¥\\]?\s*(-?[\d,]{2,})\s*[※*軽外内]?$/);
    if (m) {
      const nm = m[1].replace(/\s/g, '').replace(/[¥\\]$/, '');
      const price = Number(m[2].replace(/,/g, ''));
      if (nm && price && Math.abs(price) < 1000000) r.items.push({ name: nm, price });
    }
  }
  return r;
}

function setBusy(busy, msg) {
  $('#btn-ai').disabled = busy || !photoDataUrl;
  $('#btn-ocr').disabled = busy || !photoDataUrl;
  $('#ocr-status').textContent = msg || '';
}

// ===== 設定・入出力 =====
function renderSettings() {
  const s = data.settings;
  $('#s-name-a').value = s.names.a;
  $('#s-name-b').value = s.names.b;
  $('#s-ratio').value = s.ratio;
  $('#s-apikey').value = s.apiKey;
  $('#s-model').value = s.model;
  renderSync();
}

function saveSettings() {
  const s = data.settings;
  s.names.a = $('#s-name-a').value.trim() || '夫';
  s.names.b = $('#s-name-b').value.trim() || '妻';
  s.ratio = Math.min(100, Math.max(0, Number($('#s-ratio').value) || 50));
  s.apiKey = $('#s-apikey').value.trim();
  s.model = $('#s-model').value.trim() || DEFAULT_MODEL;
  save();
  Sync.putSettings({ names: s.names, ratio: s.ratio });
  toast('設定を保存しました');
}

function exportData() {
  // API キーは書き出さない
  const out = { ...data, settings: { ...data.settings, apiKey: '' }, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `futari-seisan-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// id ごとに updatedAt が新しい方を採用して統合する
function mergeById(mine, theirs) {
  const map = new Map(mine.map((x) => [x.id, x]));
  for (const t of theirs || []) {
    const m = map.get(t.id);
    if (!m || (t.updatedAt || 0) > (m.updatedAt || 0)) map.set(t.id, t);
  }
  return [...map.values()];
}

async function importData(file) {
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    if (!Array.isArray(incoming.payments)) throw new Error('形式が違います');
    const before = livePayments().length;
    data.payments = mergeById(data.payments, incoming.payments);
    data.settlements = mergeById(data.settlements, incoming.settlements);
    save();
    push('payments', data.payments);
    push('settlements', data.settlements);
    toast(`読み込みました（記録 ${before} → ${livePayments().length} 件）`);
  } catch (e) {
    toast('読み込みに失敗しました: ' + e.message);
  }
  $('#import-input').value = '';
}

// ===== 同期 =====
const SYNC_LABEL = { connecting: '接続中…', synced: '同期済み', sending: '送信中…', offline: 'オフライン（後で送信）', error: '同期エラー' };

function push(kind, recs) {
  Sync.putMany(kind, recs);
}

// クラウドから届いた記録を統合する。初回はクラウドに無い／古いローカル記録を送り返す。
function onRemoteRecords(kind, remote, isFirst) {
  data[kind] = mergeById(data[kind], remote);
  if (isFirst) {
    const byId = new Map(remote.map((r) => [r.id, r]));
    push(kind, data[kind].filter((l) => !byId.has(l.id) || (l.updatedAt || 0) > (byId.get(l.id).updatedAt || 0)));
  }
  save();
  refreshView();
}

function onRemoteSettings(rs) {
  const s = data.settings;
  if (rs.names) s.names = { ...s.names, ...rs.names };
  if (typeof rs.ratio === 'number') s.ratio = rs.ratio;
  save();
  refreshView();
}

// 編集中の画面は書き換えない
function refreshView() {
  const v = document.querySelector('.view.active').id;
  if (v === 'view-home') renderHome();
  if (v === 'view-history') renderHistory();
  if (v === 'view-monthly') renderMonthly();
}

function renderSync() {
  const st = Sync.status();
  const linked = !!Sync.householdId();
  $('#sync-off').hidden = Sync.configured();
  $('#sync-unlinked').hidden = !Sync.configured() || linked;
  $('#sync-linked').hidden = !linked;
  $('#sync-code').value = Sync.householdId() || '';
  $('#sync-status-text').textContent = SYNC_LABEL[st] || '';
  const badge = $('#sync-badge');
  badge.hidden = !SYNC_LABEL[st];
  badge.dataset.s = st;
  badge.textContent = SYNC_LABEL[st] || '';
}

async function syncCreate() {
  $('#btn-sync-create').disabled = true;
  try {
    // 手元の記録は最初の同期でクラウドへ送られる
    await Sync.create({ names: data.settings.names, ratio: data.settings.ratio });
    toast('共有を始めました。招待リンクをもう1人に送ってください');
  } catch (e) {
    console.error(e);
    toast('共有を始められませんでした: ' + e.message);
  }
  $('#btn-sync-create').disabled = false;
  renderSync();
}

async function syncJoin(code) {
  $('#btn-sync-join').disabled = true;
  try {
    await Sync.join(code);
    toast('参加しました。記録を同期します');
  } catch (e) {
    console.error(e);
    toast(e.message || '参加できませんでした');
  }
  $('#btn-sync-join').disabled = false;
  renderSync();
}

function syncLeave() {
  if (!confirm('この端末の同期を解除しますか？（記録はこの端末に残ります。共有コードがあれば再参加できます）')) return;
  Sync.leave();
  renderSync();
}

async function copyInvite() {
  // コードは URL の # 以降に入れる（サーバーには送信されない）
  const url = location.origin + location.pathname + '#join=' + Sync.householdId();
  try {
    await navigator.clipboard.writeText(url);
    toast('招待リンクをコピーしました');
  } catch {
    prompt('このリンクをもう1人に送ってください', url);
  }
}

// 招待リンク（#join=コード）から開かれた場合
function handleInviteLink() {
  const m = location.hash.match(/^#join=([A-Za-z0-9-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!Sync.configured()) { toast('同期が設定されていません'); return; }
  if (Sync.householdId()) { toast('この端末はすでに同期しています'); return; }
  if (confirm('招待された共有に参加して、記録を同期しますか？')) syncJoin(m[1]);
}

// ===== イベント =====
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view === 'edit') openEdit(null);
  else show(b.dataset.view);
}));
$('#btn-settle').addEventListener('click', settle);
$('#m-prev').addEventListener('click', () => { curMonth = shiftMonth(curMonth, -1); renderMonthly(); });
$('#m-next').addEventListener('click', () => { curMonth = shiftMonth(curMonth, 1); renderMonthly(); });
$('#history-filter').addEventListener('change', renderHistory);
$('#photo-input').addEventListener('change', (e) => onPhoto(e.target.files[0]));
$('#camera-input').addEventListener('change', (e) => onPhoto(e.target.files[0]));
$('#btn-ai').addEventListener('click', aiRead);
$('#btn-ocr').addEventListener('click', ocrRead);
$('#f-total').addEventListener('input', updateSummary);
$('#btn-add-item').addEventListener('click', () => {
  readForm();
  draft.items.push({ id: uid(), name: '', price: '', owner: 'both' });
  renderItems();
  const names = document.querySelectorAll('#items .name');
  names[names.length - 1].focus();
});
document.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => {
  draft.items.forEach((it) => { it.owner = b.dataset.bulk; });
  renderItems();
}));
$('#btn-save').addEventListener('click', saveDraft);
$('#btn-cancel').addEventListener('click', () => show('home'));
$('#btn-delete').addEventListener('click', deleteDraft);
$('#btn-save-settings').addEventListener('click', saveSettings);
$('#btn-export').addEventListener('click', exportData);
$('#import-input').addEventListener('change', (e) => importData(e.target.files[0]));
$('#btn-sync-create').addEventListener('click', syncCreate);
$('#btn-sync-join').addEventListener('click', () => syncJoin($('#sync-code-input').value));
$('#btn-sync-leave').addEventListener('click', syncLeave);
$('#btn-sync-copy').addEventListener('click', copyInvite);

renderHome();
Sync.init({ onRecords: onRemoteRecords, onSettings: onRemoteSettings, onStatus: renderSync }).then(() => {
  renderSync();
  handleInviteLink();
});
