/* =============================================================
   茶会受付帳 － 保存先アダプタ（Claude Artifact の共有ストレージ）
   -------------------------------------------------------------
   Artifact 版で使います。claude.use("db") で得られる共有ストレージに、
   参加者1人＝1ドキュメントで保存します。

   データの置きかた:
     meta/config        = {title: "…"}
     groups/<組ID>      = {name, order, createdAt}
     members/<人ID>     = {gid, name, order, status, arrivedAt, note, …}
   ============================================================= */
(function () {
  "use strict";

  var COL_GROUPS = "groups";
  var COL_MEMBERS = "members";
  var DOC_META = "meta/config";

  var CONCURRENCY = 3;   // 同時に走らせる書き込み数（呼び出し回数の上限対策）
  var RETRY = 3;         // 一時的な失敗をやり直す回数

  var db = null;
  var H = null;      // 画面へ知らせるためのコールバック一式

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** やり直して直る種類の失敗か */
  function isRetryable(e) {
    var c = e && e.code;
    return c === "unavailable" || c === "resource_exhausted";
  }

  /** 1件の書き込みを、一時的な失敗なら間隔をあけてやり直しながら実行する */
  async function runTask(task) {
    for (var i = 0; i <= RETRY; i++) {
      try { return await task(); }
      catch (e) {
        if (i === RETRY || !isRetryable(e)) throw e;
        await sleep(300 * Math.pow(2, i) + Math.random() * 200);
      }
    }
  }

  /** 同時実行数を絞ってまとめて実行する */
  async function runAll(tasks, onProgress) {
    var done = 0, idx = 0, firstError = null;
    async function worker() {
      while (idx < tasks.length) {
        var task = tasks[idx++];
        try { await runTask(task); }
        catch (e) { if (!firstError) firstError = e; }
        done++;
        if (onProgress) onProgress(done, tasks.length);
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, tasks.length); i++) workers.push(worker());
    await Promise.all(workers);
    if (firstError) throw firstError;
  }

  /** 届いたドキュメントを id 付きの素のオブジェクトに直す */
  function toObj(d) {
    return Object.assign({ id: d.id }, d.data() || {});
  }

  /** 操作1件を、実行できる関数に変える */
  function toTask(o) {
    var kind = o.op.split(".")[0];
    var verb = o.op.split(".")[1];
    if (kind === "meta") return function () { return db.doc(DOC_META).set(o.data); };

    var path = (kind === "member" ? COL_MEMBERS : COL_GROUPS) + "/" + o.id;
    if (verb === "set")    return function () { return db.doc(path).set(o.data); };
    if (verb === "update") return function () { return db.doc(path).update(o.data); };
    return function () { return db.doc(path).delete(); };
  }

  window.ChakaiStore = {
    label: "共有ストレージ",
    /* 端末内の控えの鍵。Artifact は1つにつき保存先も1つなので固定でよい */
    cacheKey: "artifact",

    connect: async function (h) {
      H = h;
      var api = null;
      try {
        api = (window.claude && window.claude.use) ? await window.claude.use("db") : null;
      } catch (e) { api = null; }
      db = api;

      if (!db) {
        return { ok: false, error: "not_granted",
          help: "<h2>共有データを開けません</h2><p>この受付帳は、共有ストレージが使える環境でのみ動きます。" +
                "受付担当の方が同じ組織のアカウントでサインインしているか確かめてください。</p>" };
      }

      db.doc(DOC_META).onSnapshot(
        function (s) { h.meta(s.exists ? s.data() : null); },
        function () { /* 会の名称は無くても受付はできる */ });

      db.collection(COL_GROUPS).onSnapshot(
        function (s) { h.groups(s.docs.map(toObj)); },
        function (e) { h.status(false, (e && e.code) || "unavailable"); });

      db.collection(COL_MEMBERS).onSnapshot(
        function (s) { h.members(s.docs.map(toObj)); },
        function (e) { h.status(false, (e && e.code) || "unavailable"); });

      return { ok: true };
    },

    /** 「更新」ボタン用。保存先から今の中身を読み直して画面へ渡す */
    refresh: async function () {
      if (!db || !H) throw { code: "not_granted" };
      var meta = await runTask(function () { return db.doc(DOC_META).get(); });
      var gs = await runTask(function () { return db.collection(COL_GROUPS).get(); });
      var ms = await runTask(function () { return db.collection(COL_MEMBERS).get(); });
      H.meta(meta.exists ? meta.data() : null);
      H.groups(gs.docs.map(toObj));
      H.members(ms.docs.map(toObj));
    },

    commit: function (ops, onProgress) {
      if (!db) return Promise.reject({ code: "not_granted" });
      return runAll(ops.map(toTask), onProgress);
    }
  };
})();
