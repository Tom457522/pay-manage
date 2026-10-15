'use strict';

// Firebase (Firestore) による端末間の自動同期。
// データ構造: households/{共有コード} に設定、その下の payments / settlements に記録を1件1ドキュメントで保存。
// 共有コードは推測困難なランダム文字列。コードを使って参加した端末（最大 MAX_MEMBERS 台）だけが読み書きできる（firestore.rules 参照）。
const Sync = (() => {
  const BASE = 'https://www.gstatic.com/firebasejs/13.0.0/';
  const HID_KEY = 'futari-seisan-household';
  const MEMBER_KEY = 'futari-seisan-member'; // 参加登録済みの「共有コード:端末ID」
  const KINDS = ['payments', 'settlements'];
  const MAX_MEMBERS = 4; // firestore.rules の上限と合わせる

  let fb = null;        // { fs: firestore モジュール, db, uid }
  let hid = null;
  let unsubs = [];
  let handlers = {};
  let status = 'off';
  let memberCount = 0;  // 参加中の端末数（設定画面に表示）

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
  const memberMark = () => hid + ':' + fb.uid;
  function isMarkedMember() {
    try { return localStorage.getItem(MEMBER_KEY) === memberMark(); } catch { return false; }
  }
  function markMember(on) {
    try { on ? localStorage.setItem(MEMBER_KEY, memberMark()) : localStorage.removeItem(MEMBER_KEY); } catch { /* 同上 */ }
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
    // getAuth() はポップアップ用の外部スクリプト・iframe を読み込むことがあるので、
    // 匿名ログインに必要な分だけで初期化する（保存先は getAuth と同じ＝端末IDは変わらない）
    const a = auth.initializeAuth(app, {
      persistence: [auth.indexedDBLocalPersistence, auth.browserLocalPersistence, auth.browserSessionPersistence],
    });
    const user = await new Promise((resolve, reject) => {
      const off = auth.onAuthStateChanged(a, (user) => {
        if (user) { off(); resolve(user); }
        else auth.signInAnonymously(a).catch((e) => { off(); reject(e); });
      });
    });
    // オフラインでも書き込みを端末に貯め、つながった時に送信する
    const db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
    fb = { fs, db, uid: user.uid };
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
      }, onListenError));
    }
    unsubs.push(fs.onSnapshot(fs.doc(db, 'households', hid), (snap) => {
      const d = snap.data();
      if (d && Array.isArray(d.members)) memberCount = d.members.length;
      if (d && d.settings) handlers.onSettings(d.settings);
    }, (err) => console.error(err)));
  }

  function onListenError(err) {
    console.error(err);
    // もう1人が参加枠をリセットした等で、この端末が共有メンバーでなくなった
    if (err && err.code === 'permission-denied') { markMember(false); setStatus('denied'); }
    else setStatus('error');
  }

  // 共有メンバー（members）に自分の端末IDを登録する。
  // ルール上、登録できるのは「すでにメンバー」か「空き枠（MAX_MEMBERS 台まで）がある」場合だけ。
  async function register() {
    const { fs, db } = fb;
    try {
      await fs.updateDoc(fs.doc(db, 'households', hid), { members: fs.arrayUnion(fb.uid) });
    } catch (e) {
      if (e && (e.code === 'permission-denied' || e.code === 'not-found')) {
        const err = new Error(`コードが違うか、すでに${MAX_MEMBERS}台が参加しています（参加中の端末の設定で「参加枠をリセット」すると参加できます）`);
        err.denied = true;
        throw err;
      }
      throw e;
    }
    markMember(true);
  }

  async function init(h) {
    handlers = h;
    hid = getStoredHid();
    if (!configured() || !hid) { setStatus(configured() ? 'unlinked' : 'off'); return; }
    setStatus('connecting');
    try {
      await connect();
      // 以前のバージョンから更新した端末や、端末IDが変わった場合はここで参加登録する
      if (!isMarkedMember()) await register();
      subscribe();
    } catch (e) {
      console.error(e);
      setStatus(e.denied ? 'denied' : 'error');
    }
  }

  async function create(settings) {
    await connect();
    const code = newCode();
    const { fs, db } = fb;
    await fs.setDoc(fs.doc(db, 'households', code), { createdAt: Date.now(), settings: clean(settings), members: [fb.uid] });
    hid = code;
    storeHid(code);
    markMember(true);
    subscribe();
    return code;
  }

  async function join(code) {
    const c = normalize(code);
    if (c.replace(/-/g, '').length !== 24) throw new Error('コードの形式が正しくありません');
    await connect();
    hid = c;
    try {
      await register();
    } catch (e) {
      hid = null;
      throw e;
    }
    storeHid(c);
    subscribe();
    return c;
  }

  function leave() {
    // 参加枠を空ける（オフラインなら後で送信される）
    if (active() && isMarkedMember()) {
      const { fs, db } = fb;
      fs.updateDoc(fs.doc(db, 'households', hid), { members: fs.arrayRemove(fb.uid) }).catch((e) => console.error(e));
    }
    if (fb && hid) markMember(false);
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

  // 参加枠をこの端末だけにする（もう1台がデータ消去などで参加し直せなくなった時用）
  async function resetMembers() {
    const { fs, db } = fb;
    await fs.updateDoc(fs.doc(db, 'households', hid), { members: [fb.uid] });
  }

  function putSettings(settings) {
    if (!active()) return;
    const { fs, db } = fb;
    fs.setDoc(fs.doc(db, 'households', hid), { settings: clean(settings) }, { merge: true })
      .catch((e) => { console.error(e); setStatus('error'); });
  }

  return { configured, active, householdId, init, create, join, leave, resetMembers, putMany, putSettings, normalize, status: () => status, members: () => memberCount, MAX_MEMBERS };
})();
