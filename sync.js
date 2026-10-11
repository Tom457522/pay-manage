'use strict';

// Firebase (Firestore) による2台間の自動同期。
// データ構造: households/{共有コード} に設定、その下の payments / settlements に記録を1件1ドキュメントで保存。
// 共有コードは推測困難なランダム文字列で、知っている人だけが読み書きできる（firestore.rules 参照）。
const Sync = (() => {
  const BASE = 'https://www.gstatic.com/firebasejs/13.0.0/';
  const HID_KEY = 'futari-seisan-household';
  const KINDS = ['payments', 'settlements'];

  let fb = null;        // { fs: firestore モジュール, db }
  let hid = null;
  let unsubs = [];
  let handlers = {};
  let status = 'off';

  const configured = () => !!window.FIREBASE_CONFIG;
  const householdId = () => hid;
  const active = () => !!(fb && hid);

  function setStatus(s) {
    if (s === status) return;
    status = s;
    handlers.onStatus && handlers.onStatus(s);
  }

  function getStoredHid() {
    try { return localStorage.getItem(HID_KEY); } catch { return null; }
  }
  function storeHid(v) {
    try { v ? localStorage.setItem(HID_KEY, v) : localStorage.removeItem(HID_KEY); } catch { /* 保存できなくても動作は継続 */ }
  }

  // 紛らわしい文字（0/O, 1/I/L）を除いた 24 文字 ≒ 120 bit
  function newCode() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const s = [...bytes].map((b) => abc[b % abc.length]).join('');
    return s.match(/.{4}/g).join('-');
  }
  const normalize = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g)?.join('-') || '';

  async function connect() {
    if (fb) return fb;
    const [{ initializeApp }, auth, fs] = await Promise.all([
      import(BASE + 'firebase-app.js'),
      import(BASE + 'firebase-auth.js'),
      import(BASE + 'firebase-firestore.js'),
    ]);
    const app = initializeApp(window.FIREBASE_CONFIG);
    const a = auth.getAuth(app);
    await new Promise((resolve, reject) => {
      const off = auth.onAuthStateChanged(a, (user) => {
        if (user) { off(); resolve(user); }
        else auth.signInAnonymously(a).catch((e) => { off(); reject(e); });
      });
    });
    // オフラインでも書き込みを端末に貯め、つながった時に送信する
    const db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
    fb = { fs, db };
    return fb;
  }

  function subscribe() {
    const { fs, db } = fb;
    unsubs.forEach((u) => u());
    unsubs = [];
    for (const kind of KINDS) {
      let first = true;
      unsubs.push(fs.onSnapshot(fs.collection(db, 'households', hid, kind), { includeMetadataChanges: true }, (snap) => {
        setStatus(snap.metadata.fromCache ? 'offline' : snap.metadata.hasPendingWrites ? 'sending' : 'synced');
        // キャッシュからの初回スナップショットは不完全なことがあるので、
        // 「初回マージ（ローカル→クラウドへの送信判定）」はサーバー由来の最初の1回で行う
        const isFirst = first && !snap.metadata.fromCache;
        if (isFirst) first = false;
        handlers.onRecords(kind, snap.docs.map((d) => d.data()), isFirst);
      }, (err) => { console.error(err); setStatus('error'); }));
    }
    unsubs.push(fs.onSnapshot(fs.doc(db, 'households', hid), (snap) => {
      const d = snap.data();
      if (d && d.settings) handlers.onSettings(d.settings);
    }, (err) => console.error(err)));
  }

  async function init(h) {
    handlers = h;
    hid = getStoredHid();
    if (!configured() || !hid) { setStatus(configured() ? 'unlinked' : 'off'); return; }
    setStatus('connecting');
    try {
      await connect();
      subscribe();
    } catch (e) {
      console.error(e);
      setStatus('error');
    }
  }

  async function create(settings) {
    await connect();
    const code = newCode();
    const { fs, db } = fb;
    await fs.setDoc(fs.doc(db, 'households', code), { createdAt: Date.now(), settings: clean(settings) });
    hid = code;
    storeHid(code);
    subscribe();
    return code;
  }

  async function join(code) {
    const c = normalize(code);
    if (c.replace(/-/g, '').length !== 24) throw new Error('コードの形式が正しくありません');
    await connect();
    const { fs, db } = fb;
    const snap = await fs.getDocFromServer(fs.doc(db, 'households', c));
    if (!snap.exists()) throw new Error('このコードの共有が見つかりません');
    hid = c;
    storeHid(c);
    subscribe();
    return c;
  }

  function leave() {
    unsubs.forEach((u) => u());
    unsubs = [];
    hid = null;
    storeHid(null);
    setStatus('unlinked');
  }

  // Firestore は undefined を受け付けないので JSON 経由で取り除く
  const clean = (o) => JSON.parse(JSON.stringify(o));

  // 書き込みはローカルキャッシュに即反映され、オフライン時は後で送信される。
  // 完了を待つと圏外で止まるので待たずにエラーだけ拾う。
  function putMany(kind, recs) {
    if (!active() || !recs.length) return;
    const { fs, db } = fb;
    for (let i = 0; i < recs.length; i += 400) {
      const batch = fs.writeBatch(db);
      recs.slice(i, i + 400).forEach((r) => batch.set(fs.doc(db, 'households', hid, kind, r.id), clean(r)));
      batch.commit().catch((e) => { console.error(e); setStatus('error'); });
    }
  }

  function putSettings(settings) {
    if (!active()) return;
    const { fs, db } = fb;
    fs.setDoc(fs.doc(db, 'households', hid), { settings: clean(settings) }, { merge: true })
      .catch((e) => { console.error(e); setStatus('error'); });
  }

  return { configured, active, householdId, init, create, join, leave, putMany, putSettings, normalize, status: () => status };
})();
