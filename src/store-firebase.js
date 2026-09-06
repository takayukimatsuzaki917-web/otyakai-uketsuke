/* =============================================================
   茶会受付帳 － 保存先アダプタ（Firebase Realtime Database）
   -------------------------------------------------------------
   自前ホスティング版で使います。URL を開くだけで（ログイン操作なしで）
   複数の端末が同じデータを見られるようにします。

   データの置きかた（Realtime Database のツリー）:
     chakai/<会のID>/meta            = {title: "…"}
     chakai/<会のID>/groups/<組ID>   = {name, order, createdAt}
     chakai/<会のID>/members/<人ID>  = {gid, name, order, status, arrivedAt, note, …}

   「会のID」は config.js の roomId で決まります。URL に ?room=xxx を
   付けるとそちらが優先されるので、1つの設置で複数の茶会を使い分けられます。
   ============================================================= */
(function () {
  "use strict";

  var CFG = window.CHAKAI_CONFIG || {};
  var ROOT = "chakai";
  var OFFLINE_GRACE_MS = 4000;   // 圏外と判断するまでの猶予

  /** 会のID。URL の ?room= を最優先し、無ければ config.js の値を使う */
  function resolveRoom() {
    var fromUrl = "";
    try {
      fromUrl = new URLSearchParams(window.location.search).get("room") || "";
    } catch (e) { /* 古いブラウザでは無視 */ }
    var room = (fromUrl || CFG.roomId || "default").trim();
    /* Realtime Database のキーに使えない文字を除く */
    return room.replace(/[.#$/[\]\s]/g, "-") || "default";
  }

  /** 設定がまだ埋まっていないときに受付画面へ出す案内 */
  function setupHelp(reason) {
    return '<div class="setup">' +
      "<h2>はじめの設定が残っています</h2>" +
      "<p>" + reason + "この受付帳を動かすには、無料の Firebase プロジェクトを1つ用意し、" +
      "<code>config.js</code> にその設定を貼り付けます。手順は同梱の <code>README.md</code> に書いてあります。</p>" +
      "<ol>" +
        "<li><b>Firebase コンソール</b>（console.firebase.google.com）でプロジェクトを作る</li>" +
        "<li>「構築 → <b>Realtime Database</b>」を作成する（ロケーションはどこでも可）</li>" +
        "<li>「構築 → Authentication」で <b>匿名</b> ログインを有効にする</li>" +
        "<li>プロジェクトの設定で <b>ウェブアプリ</b> を登録し、表示される設定値を写す</li>" +
        "<li><code>config.js</code> の <code>firebase</code> にその値を貼り、<code>databaseURL</code> も入れる</li>" +
        "<li>データベースのルールに、同梱の <code>database.rules.json</code> を貼る</li>" +
      "</ol>" +
      "<p>設定を保存してこのページを再読み込みすると、受付画面が開きます。</p>" +
    "</div>";
  }

  /** {キー: 値} の形で届くデータを、id 付きの配列に直す */
  function toList(val) {
    if (!val || typeof val !== "object") return [];
    return Object.keys(val).map(function (k) {
      var v = val[k] || {};
      return Object.assign({}, v, { id: k });
    });
  }

  var base = null;   // chakai/<会のID> を指す参照
  var H = null;      // 画面へ知らせるためのコールバック一式

  window.ChakaiStore = {
    label: "Firebase",
    /* 端末内の控えを会ごとに分ける鍵。別の会の名簿が混ざらないようにする */
    cacheKey: "fb:" + resolveRoom(),

    /**
     * 保存先につなぎ、変化の購読を始める。
     * @param {Object} h {meta, groups, members, status} の各コールバック
     */
    connect: async function (h) {
      H = h;
      var fb = CFG.firebase || {};

      /* --- 設定と読み込みの確認 --- */
      if (typeof window.firebase === "undefined") {
        return { ok: false, error: "sdk-not-loaded",
          help: setupHelp("Firebase の読み込みに失敗しました。通信環境を確かめてください。") };
      }
      if (!fb.apiKey || !fb.databaseURL || /^ここに/.test(fb.apiKey) || /^ここに/.test(fb.databaseURL)) {
        return { ok: false, error: "not-configured", help: setupHelp("") };
      }

      try {
        firebase.initializeApp(fb);
      } catch (e) {
        /* 二重初期化（再読み込みなど）は無視してよい */
        if (!/already exists/i.test(String(e && e.message))) {
          return { ok: false, error: "init-failed", help: setupHelp("設定の値が正しくないようです。") };
        }
      }

      /* --- 匿名ログイン ---
         受付担当者に操作は求めません。ページを開いた瞬間に裏側で済ませます。
         これでデータベースのルールを「ログイン済みのみ許可」にでき、
         URL を知らない第三者が直接書き込むことを防げます。
         Authentication で匿名ログインを有効にしていない場合はここを素通りし、
         ルール側が誰でも許可なら、そのまま動きます。 */
      try {
        if (firebase.auth) await firebase.auth().signInAnonymously();
      } catch (e) {
        console.warn("匿名ログインを使いませんでした:", e && e.code);
      }

      try {
        var rtdb = firebase.database();
        base = rtdb.ref(ROOT + "/" + resolveRoom());

        base.child("meta").on("value", function (s) { h.meta(s.val()); });
        base.child("groups").on("value",
          function (s) { h.groups(toList(s.val())); },
          function (e) { h.status(false, (e && e.code) || "permission-denied"); });
        base.child("members").on("value",
          function (s) { h.members(toList(s.val())); },
          function (e) { h.status(false, (e && e.code) || "permission-denied"); });

        /* 圏外・復帰を画面のバナーに反映する。
           接続直後は必ず一度 false を通るので、少し待ってもまだ切れている
           ときだけ知らせる（開いた瞬間に警告が明滅するのを防ぐ） */
        var offlineTimer = null;
        rtdb.ref(".info/connected").on("value", function (s) {
          if (s.val()) {
            if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
            h.status(true);
          } else if (!offlineTimer) {
            offlineTimer = setTimeout(function () {
              offlineTimer = null;
              h.status(false, "offline");
            }, OFFLINE_GRACE_MS);
          }
        });
      } catch (e) {
        return { ok: false, error: (e && e.code) || "connect-failed",
          help: setupHelp("データベースに接続できませんでした。") };
      }

      return { ok: true };
    },

    /**
     * 「更新」ボタン用。保存先から今の中身を読み直して画面へ渡す。
     * 普段は自動で届いているが、押して確かめられること自体に意味がある。
     * 一度に丸ごと読むので、届いていない変化があればここで必ず揃う。
     */
    refresh: function () {
      if (!base || !H) return Promise.reject({ code: "not-connected" });
      return base.once("value").then(function (s) {
        var v = s.val() || {};
        H.meta(v.meta || null);
        H.groups(toList(v.groups));
        H.members(toList(v.members));
      });
    },

    /**
     * 書き込みをまとめて実行する。
     * Realtime Database は「パスごとの一括更新」ができるので、
     * 91名の一括登録でも通信は1往復で済み、途中で失敗して半端に残ることがない。
     * @param {Array} ops app.js が組み立てた操作の配列
     * @param {Function} onProgress 進捗の通知（done, total）
     */
    commit: function (ops, onProgress) {
      if (!base) return Promise.reject({ code: "not-connected" });

      var patch = {};
      ops.forEach(function (o) {
        var kind = o.op.split(".")[0];        // member / group / meta
        var verb = o.op.split(".")[1];        // set / update / delete
        var dir = kind === "member" ? "members" : (kind === "group" ? "groups" : "meta");

        if (kind === "meta") {
          if (verb === "set") { patch["meta"] = o.data; return; }
          /* update は項目ごとのパスにばらす。
             会の名称を保存したときに開催日の設定まで消さないため */
          Object.keys(o.data).forEach(function (k) { patch["meta/" + k] = o.data[k]; });
          return;
        }

        var path = dir + "/" + o.id;
        if (verb === "delete") { patch[path] = null; return; }
        if (verb === "set") { patch[path] = o.data; return; }
        /* update は項目ごとのパスにばらす。
           こうすると同じ人の別の項目を他の端末が触っていても打ち消さない */
        Object.keys(o.data).forEach(function (k) { patch[path + "/" + k] = o.data[k]; });
      });

      if (onProgress) onProgress(0, ops.length);
      return base.update(patch).then(function () {
        if (onProgress) onProgress(ops.length, ops.length);
      });
    }
  };
})();
