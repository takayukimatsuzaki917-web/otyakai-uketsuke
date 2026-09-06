/* =============================================================
   茶会受付帳 － 画面ロジック（保存先に依存しない共通コア）
   -------------------------------------------------------------
   このファイルは「どこにデータを保存するか」を知りません。
   保存は window.ChakaiStore（アダプタ）に任せます。

   アダプタが備えるべきもの（src/store-firebase.js などを参照）:
     connect(handlers) -> Promise<{ok:boolean, error?:string, help?:string}>
         handlers = { meta(obj), groups(array), members(array), status(ok, code) }
         購読を開始し、変化があるたびに handlers を呼ぶこと。
     commit(ops, onProgress) -> Promise<void>
         ops をまとめて書き込む。onProgress(done, total) で進捗を通知。
     label : 保存先の呼び名（エラー文言に使う）

   ops の書式（アダプタはこの語彙だけ理解すればよい）:
     {op:"member.set",    id, data}   参加者を丸ごと作成／置き換え
     {op:"member.update", id, data}   参加者の一部の項目だけ更新
     {op:"member.delete", id}
     {op:"group.set",     id, data}
     {op:"group.update",  id, data}
     {op:"group.delete",  id}
     {op:"meta.set",      data}
   ============================================================= */
(function () {
  "use strict";

  /* =========================================================
     定数
     ========================================================= */
  var WAITING = "waiting";   // 未到着
  var ARRIVED = "arrived";   // 到着済み
  var ABSENT  = "absent";    // 欠席
  var STATUS_LABEL = { waiting: "未到着", arrived: "到着", absent: "欠席" };

  var DEFAULT_TITLE = "茶会受付帳";
  var TOAST_MS = 5000;          // トーストと「取消」を出しておく時間
  var OVERRIDE_HOLD_MS = 1200;  // 書き込み後、ローカル値を優先し続ける時間

  var Store = window.ChakaiStore;

  /* =========================================================
     状態
     ========================================================= */
  var connected = false;    // 保存先とつながっているか
  var connError = null;     // つながらない理由（コード）
  var connHelp = null;      // つながらないときに出す案内HTML（アダプタが用意）
  var meta = { title: DEFAULT_TITLE };
  var groups = [];          // {id, name, order}
  var members = [];         // {id, gid, name, order, status, arrivedAt, note}
  var activeGid = null;     // 表示中の組
  var onlyWaiting = false;  // 「未着のみ」の絞り込み
  var query = "";           // 氏名検索の入力
  /* 楽観的更新の保持。書き込みが往復する間もローカルの値を優先し、画面のちらつきを防ぐ */
  var overrides = new Map();
  var toastTimer = null;
  var settingsOpen = false;
  var settingsGid = null;   // 一括登録の対象組
  /* 名簿の第一報が届いたか。届く前に「まだ空だ」と決めつけないための番人。
     これが無いと、再読み込みの直後に一瞬だけ初期設定の案内が出てしまう */
  var firstSnap = { groups: false, members: false };
  var fromCache = false;    // いま出ているのが前回の控えか
  var cacheTimer = null;

  /* =========================================================
     小さなユーティリティ
     ========================================================= */
  function $(id) { return document.getElementById(id); }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() { return new Date().toISOString(); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** ISO文字列を「09:42」形式に。不正な値は空文字を返す */
  function hhmm(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function byOrder(a, b) {
    if (a.order !== b.order) return a.order - b.order;
    return String(a.name).localeCompare(String(b.name), "ja");
  }

  /** 検索用の正規化。姓名の間の空白や大文字小文字の違いを無視する */
  function norm(s) { return String(s || "").replace(/[\s　]/g, "").toLowerCase(); }

  /** 名簿がまだ届いていない間は true。この間は空の案内を出さない */
  function isLoading() { return !firstSnap.groups || !firstSnap.members; }

  function errText(e) {
    if (!e) return "通信エラー";
    return e.code || e.message || "通信エラー";
  }

  /* =========================================================
     前回の控え（この端末の中だけの控え）
     -------------------------------------------------------------
     再読み込みのたびに真っ白から始めると、名簿が届くまでの数秒が
     「消えた」ように見えます。前回見えていた内容をこの端末に控えて
     おき、開いた瞬間にそれを描いてから、届いた最新の内容で置き換えます。
     控えはこの端末の中だけのもので、共有もされず、記録の正としても
     扱いません（必ず保存先の内容で上書きされます）。
     ========================================================= */
  function cacheKey() {
    return "chakai-uketsuke:" + ((Store && Store.cacheKey) || "default");
  }

  function loadCache() {
    try {
      var raw = window.localStorage.getItem(cacheKey());
      if (!raw) return false;
      var v = JSON.parse(raw);
      if (!v || !Array.isArray(v.groups) || !Array.isArray(v.members)) return false;
      if (!v.groups.length) return false;
      groups = v.groups.map(mapGroup).sort(byOrder);
      members = v.members.map(mapMember).sort(byOrder);
      activeGid = groups.length ? groups[0].id : null;
      if (v.title) meta.title = String(v.title);
      fromCache = true;
      return true;
    } catch (e) { return false; }   // 使えない環境なら黙って諦める
  }

  function saveCache() {
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () {
      try {
        window.localStorage.setItem(cacheKey(), JSON.stringify({
          groups: groups, members: members, title: meta.title, savedAt: nowIso()
        }));
      } catch (e) { /* 容量超過や無効化。控えが無くても動作に支障はない */ }
    }, 500);
  }

  /* =========================================================
     画面の骨組みを組み立てる
     （自前ホスティング版・Artifact版で同じ画面を使うため、HTMLもここで持つ）
     ========================================================= */
  function renderShell() {
    var root = $("app-root");
    root.innerHTML =
      '<div class="wrap">' +
        '<header class="topbar"><div class="topbar-inner">' +
          '<div class="brand"><h1 id="ttl">' + esc(DEFAULT_TITLE) + "</h1>" +
            '<span class="sub">RECEPTION</span></div>' +
          '<div class="total"><span class="n" id="tot-n">–</span><span class="d" id="tot-d"></span></div>' +
          '<button class="icon-btn" id="btn-settings" aria-label="設定を開く">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle>' +
            '<path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"></path></svg>' +
          "</button>" +
        "</div></header>" +

        '<nav class="tabs" id="tabs-wrap" hidden><div class="tabs-scroll" id="tabs" role="tablist"></div></nav>' +
        '<div id="conn"></div>' +

        '<div class="toolbar" id="toolbar" hidden>' +
          '<div class="search">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
            '<input id="q" type="search" inputmode="search" placeholder="氏名で全組から検索" aria-label="氏名で全組から検索">' +
            '<button id="q-clear" hidden aria-label="検索を消す">×</button>' +
          "</div>" +
          '<button class="filter" id="only-waiting" aria-pressed="false">' +
            '<span class="box" aria-hidden="true"></span>未着のみ</button>' +
        "</div>" +

        '<div class="breakdown" id="breakdown" hidden></div>' +
        '<ul class="list" id="list"></ul>' +
        '<div class="empty" id="empty" hidden></div>' +
      "</div>";
  }

  /* =========================================================
     保存先との接続
     ========================================================= */
  function mapGroup(v) {
    return { id: String(v.id), name: String(v.name || ""), order: Number(v.order) || 0 };
  }

  function mapMember(v) {
    return {
      id: String(v.id),
      gid: String(v.gid || ""),
      name: String(v.name || ""),
      order: Number(v.order) || 0,
      status: (v.status === ARRIVED || v.status === ABSENT) ? v.status : WAITING,
      arrivedAt: v.arrivedAt || null,
      note: String(v.note || "")
    };
  }

  function applyOverrides(list) {
    if (overrides.size === 0) return list;
    return list.map(function (m) {
      var o = overrides.get(m.id);
      return o ? Object.assign({}, m, o) : m;
    });
  }

  async function connect() {
    var res;
    try {
      res = await Store.connect({
        meta: function (v) {
          meta.title = (v && v.title) ? String(v.title) : DEFAULT_TITLE;
          var el = $("ttl");
          if (el) el.textContent = meta.title;
          document.title = meta.title;
        },
        groups: function (list) {
          groups = list.map(mapGroup).sort(byOrder);
          firstSnap.groups = true;
          if (!activeGid || !groups.some(function (g) { return g.id === activeGid; })) {
            activeGid = groups.length ? groups[0].id : null;
          }
          if (!isLoading()) { fromCache = false; saveCache(); }
          renderAll();
          if (settingsOpen) renderSettings();
        },
        members: function (list) {
          members = applyOverrides(list.map(mapMember)).sort(byOrder);
          firstSnap.members = true;
          if (!isLoading()) { fromCache = false; saveCache(); }
          renderAll();
          if (settingsOpen) renderSettings();
        },
        /* 保存先との接続が切れた／戻ったときに呼ばれる */
        status: function (ok, code) {
          connected = !!ok;
          connError = ok ? null : (code || "unavailable");
          renderAll();
        }
      });
    } catch (e) {
      res = { ok: false, error: errText(e) };
    }
    connected = !!(res && res.ok);
    if (!connected) {
      connError = (res && res.error) || "unavailable";
      connHelp = (res && res.help) || null;
    }
    renderAll();
  }

  /* =========================================================
     書き込み
     参加者は1人＝1レコード。別々の担当者が別々の人を同時に触っても、
     互いの記録を打ち消しません。
     ========================================================= */

  /** 参加者1人の項目を更新する。画面には先に反映し、失敗したら戻す */
  async function writeMember(id, patch) {
    overrides.set(id, patch);
    members = applyOverrides(members);
    renderAll();
    /* 保存先からの反映が届くまでのつなぎ。回線が細くても必ず期限で解除する */
    var hold = setTimeout(function () { overrides.delete(id); }, OVERRIDE_HOLD_MS);
    try {
      await Store.commit([{ op: "member.update", id: id, data: patch }]);
    } catch (e) {
      clearTimeout(hold);
      overrides.delete(id);
      members = applyOverrides(members);
      renderAll();
      showToast("保存できませんでした（" + errText(e) + "）。電波を確かめて、もう一度タップしてください。");
      throw e;
    }
  }

  function statusPatch(status) {
    return {
      status: status,
      arrivedAt: status === ARRIVED ? nowIso() : null,
      updatedAt: nowIso()
    };
  }

  /** 行タップ：未到着 ⇄ 到着 のトグル。欠席の行は誤操作を避けて詳細を開く */
  function toggleArrival(m) {
    if (!connected) { showToast("保存先につながっていないため記録できません。"); return; }
    if (m.status === ABSENT) { openDetail(m.id); return; }
    var next = m.status === ARRIVED ? WAITING : ARRIVED;
    var before = { status: m.status, arrivedAt: m.arrivedAt, updatedAt: nowIso() };
    /* 受付は速さが命なので、保存の往復を待たずに結果と「取消」を出す。
       保存に失敗したときは writeMember がエラーのトーストで上書きする */
    showToast(
      m.name + " を「" + STATUS_LABEL[next] + "」にしました",
      "取消",
      function () { writeMember(m.id, before).catch(function () {}); }
    );
    writeMember(m.id, statusPatch(next)).catch(function () {});
  }

  /* =========================================================
     集計
     ========================================================= */
  function tally(list) {
    var t = { total: list.length, arrived: 0, waiting: 0, absent: 0 };
    list.forEach(function (m) {
      if (m.status === ARRIVED) t.arrived++;
      else if (m.status === ABSENT) t.absent++;
      else t.waiting++;
    });
    return t;
  }

  function membersOf(gid) {
    return members.filter(function (m) { return m.gid === gid; });
  }

  /* =========================================================
     描画
     ========================================================= */
  function renderAll() {
    renderConn();
    renderTotal();
    renderTabs();
    renderList();
  }

  function renderConn() {
    var el = $("conn");
    if (!el) return;
    /* 前回の控えを出している間は、それが最新でないことを明示する */
    if (fromCache && isLoading() && !connError) {
      el.innerHTML = '<div class="banner info"><b>前回ひらいたときの名簿です</b>' +
        "最新の内容を受け取っています。数秒お待ちください。</div>";
      return;
    }
    if (connected) { el.innerHTML = ""; return; }
    if (connError === null) { el.innerHTML = ""; return; }  // 接続中はまだ何も出さない
    var msg = connError === "revoked"
      ? "この端末の共有アクセスが解除されました。ページを開き直してください。"
      : "保存先に接続できませんでした（" + esc(connError) + "）。通信状況を確かめ、ページを再読み込みしてください。この間の操作は保存されません。";
    el.innerHTML = '<div class="banner"><b>共有できていません</b>' + msg + "</div>";
  }

  function renderTotal() {
    var t = tally(members);
    $("tot-n").textContent = members.length ? t.arrived : "–";
    $("tot-d").textContent = members.length ? "/" + t.total : "";
  }

  function renderTabs() {
    var wrap = $("tabs-wrap"), box = $("tabs");
    if (!groups.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    box.innerHTML = groups.map(function (g) {
      var t = tally(membersOf(g.id));
      var done = t.total > 0 && t.arrived + t.absent === t.total;
      return '<button class="tab' + (done ? " done" : "") + '" role="tab" data-gid="' + esc(g.id) + '"' +
        ' aria-selected="' + (g.id === activeGid) + '">' +
        '<span class="g">' + esc(g.name) + "</span>" +
        '<span class="c">' + t.arrived + "/" + t.total + "</span></button>";
    }).join("");
  }

  function renderList() {
    var list = $("list"), empty = $("empty");
    var toolbar = $("toolbar"), bd = $("breakdown");

    /* --- 名簿がまだ無い／つながっていない場合の案内 --- */
    if (!groups.length || !members.length) {
      toolbar.hidden = true; bd.hidden = true; list.innerHTML = "";
      empty.hidden = false;
      if (!connected && connError) {
        empty.innerHTML = connHelp ||
          "<h2>読み込めません</h2><p>保存先に接続できないため、名簿を表示できません。</p>";
      } else if (isLoading()) {
        /* 第一報が届くまでは「空」と断定しない。
           ここを飛ばすと、再読み込みのたびに初期設定の案内が明滅する */
        empty.innerHTML = "<h2>名簿を読み込んでいます</h2>" +
          "<p>保存先から最新の内容を受け取っています。しばらくお待ちください。</p>";
      } else if (!groups.length) {
        empty.innerHTML = "<h2>まず組をつくります</h2><p>設定画面で組（A・B・C…）を追加し、それぞれの名簿を貼り付けてください。当日は設定を開く必要はありません。</p>" +
          '<button class="btn primary" data-open-settings>設定をひらく</button>';
      } else {
        empty.innerHTML = "<h2>名簿がまだ空です</h2><p>設定画面で、組ごとに氏名を改行区切りで貼り付けると一括で登録できます。</p>" +
          '<button class="btn primary" data-open-settings>名簿を登録する</button>';
      }
      return;
    }

    toolbar.hidden = false;
    empty.hidden = true;

    /* --- 表示対象：検索中は全組から、通常は選択中の組から --- */
    var searching = query.length > 0;
    var src = searching
      ? members.filter(function (m) { return norm(m.name).indexOf(norm(query)) >= 0; })
      : membersOf(activeGid);

    if (searching) {
      bd.hidden = false;
      bd.innerHTML = "<span>「" + esc(query) + "」に一致 <b>" + src.length + "</b> 件（全組から検索）</span>";
    } else {
      var t = tally(src);
      bd.hidden = false;
      bd.innerHTML =
        "<span>到着 <b>" + t.arrived + "</b></span>" +
        '<span class="sep">|</span><span>未到着 <b>' + t.waiting + "</b></span>" +
        (t.absent ? '<span class="sep">|</span><span>欠席 <b>' + t.absent + "</b></span>" : "") +
        '<span class="sep">|</span><span>名簿 <b>' + t.total + "</b> 名</span>";
    }

    var shown = onlyWaiting ? src.filter(function (m) { return m.status === WAITING; }) : src;

    if (!shown.length) {
      list.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = searching
        ? "<h2>見つかりません</h2><p>氏名の一部だけでも検索できます。姓と名の間の空白は無視されます。</p>"
        : (onlyWaiting
          ? "<h2>この組は受付が済みました</h2><p>未到着の方はいません。ほかの組に切り替えてください。</p>"
          : "<h2>この組に名簿がありません</h2>");
      return;
    }
    empty.hidden = true;

    var gname = {};
    groups.forEach(function (g) { gname[g.id] = g.name; });

    list.innerHTML = shown.map(function (m) {
      var cls = m.status === ARRIVED ? " arrived" : (m.status === ABSENT ? " absent" : "");
      var mark = m.status === ARRIVED ? "✓" : (m.status === ABSENT ? "欠" : "");
      var right = m.status === ARRIVED
        ? '<span class="time">' + esc(hhmm(m.arrivedAt)) + "</span><small>到着</small>"
        : (m.status === ABSENT ? "<small>欠席</small>" : "<small>未到着</small>");
      var noteHtml = m.note ? '<span class="note"><span class="tag">備考</span>' + esc(m.note) + "</span>" : "";
      var gtag = searching ? '<span class="gtag">' + esc(gname[m.gid] || "") + " 組</span>" : "";
      return '<li class="item' + cls + '">' +
          '<button class="row" data-act="toggle" data-id="' + esc(m.id) + '">' +
            '<span class="mark" aria-hidden="true">' + mark + "</span>" +
            '<span class="body">' + gtag + '<span class="nm">' + esc(m.name) + "</span>" + noteHtml + "</span>" +
            '<span class="state">' + right + "</span>" +
          "</button>" +
          '<button class="more" data-act="detail" data-id="' + esc(m.id) + '" aria-label="' + esc(m.name) + ' の詳細">⋯</button>' +
        "</li>";
    }).join("");
  }

  /* =========================================================
     トースト（取消つき）
     ========================================================= */
  function showToast(text, actionLabel, onAction) {
    hideToast();
    var el = document.createElement("div");
    el.className = "toast";
    el.id = "toast";
    el.setAttribute("role", "status");
    var span = document.createElement("span");
    span.className = "txt";
    span.textContent = text;
    el.appendChild(span);
    if (actionLabel) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = actionLabel;
      b.addEventListener("click", function () { hideToast(); onAction(); });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    var t = $("toast");
    if (t) t.remove();
  }

  /* =========================================================
     確認ダイアログ
     取り消せない操作は必ずここを通す。何がいくつ消えるかを数字で見せる。
     （iframe内では標準の confirm() が使えないため自前で用意）
     @param {Object} o {title, body, what:[{k,v}], warn, ok, tone}
     @returns {Promise<boolean>} 「実行する」を押したら true
     ========================================================= */
  function confirmDialog(o) {
    if (typeof o === "string") o = { body: o };
    return new Promise(function (resolve) {
      var whatHtml = (o.what && o.what.length)
        ? '<ul class="what">' + o.what.map(function (r) {
            return "<li><span>" + esc(r.k) + "</span><b>" + esc(r.v) + "</b></li>";
          }).join("") + "</ul>"
        : "";
      var scrim = document.createElement("div");
      scrim.className = "scrim center";
      scrim.innerHTML =
        '<div class="confirm-box' + (o.tone === "danger" ? " tone-danger" : "") + '" role="dialog" aria-modal="true">' +
          (o.title ? "<h3>" + esc(o.title) + "</h3>" : "") +
          (o.body ? "<p>" + esc(o.body) + "</p>" : "") +
          whatHtml +
          (o.warn ? '<p class="warn">' + esc(o.warn) + "</p>" : "") +
          '<div class="btns">' +
            '<button class="btn ghost" data-no>やめる</button>' +
            '<button class="btn danger" data-yes>' + esc(o.ok || "実行する") + "</button>" +
          "</div>" +
        "</div>";
      function close(v) { scrim.remove(); resolve(v); }
      scrim.addEventListener("click", function (e) {
        if (e.target === scrim || e.target.closest("[data-no]")) close(false);
        else if (e.target.closest("[data-yes]")) close(true);
      });
      document.body.appendChild(scrim);
      var yes = scrim.querySelector("[data-yes]");
      if (yes) yes.focus();
    });
  }

  /* =========================================================
     参加者の詳細シート（到着／未到着／欠席・備考・削除）
     ========================================================= */
  function openDetail(id) {
    var m = members.find(function (x) { return x.id === id; });
    if (!m) return;
    var g = groups.find(function (x) { return x.id === m.gid; });

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML =
      '<div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(m.name) + ' の受付">' +
        '<div class="grabber" aria-hidden="true"></div>' +
        "<h2>" + esc(m.name) + "</h2>" +
        '<div class="who">' + esc(g ? g.name + " 組" : "") +
          (m.arrivedAt && m.status === ARRIVED ? "　到着 " + esc(hhmm(m.arrivedAt)) : "") + "</div>" +
        '<div class="seg" role="group" aria-label="状態">' +
          '<button type="button" data-v="waiting" aria-pressed="' + (m.status === WAITING) + '">未到着<small>これから</small></button>' +
          '<button type="button" data-v="arrived" aria-pressed="' + (m.status === ARRIVED) + '">到着<small>時刻を記録</small></button>' +
          '<button type="button" data-v="absent" aria-pressed="' + (m.status === ABSENT) + '">欠席<small>集計から除く</small></button>' +
        "</div>" +
        '<label class="fld"><span>備考</span>' +
          '<textarea id="d-note" placeholder="お連れ様あり／お履物あずかり など">' + esc(m.note) + "</textarea>" +
          '<span class="hint">入力すると名簿の行に表示されます。ほかの端末にもすぐ伝わります。</span>' +
        "</label>" +
        '<div class="sheet-actions">' +
          '<button class="btn ghost" data-close>閉じる</button>' +
          '<button class="btn primary" data-save>備考を保存</button>' +
        "</div>" +
        '<div style="margin-top:14px"><button class="btn danger wide" data-del>この方を名簿から削除</button></div>' +
      "</div>";

    function close() { scrim.remove(); }

    scrim.addEventListener("click", async function (e) {
      if (e.target === scrim || e.target.closest("[data-close]")) { close(); return; }

      var seg = e.target.closest(".seg button");
      if (seg) {
        var v = seg.getAttribute("data-v");
        scrim.querySelectorAll(".seg button").forEach(function (b) {
          b.setAttribute("aria-pressed", String(b === seg));
        });
        writeMember(m.id, statusPatch(v)).catch(function () {});
        return;
      }

      if (e.target.closest("[data-save]")) {
        var note = scrim.querySelector("#d-note").value.trim();
        close();
        writeMember(m.id, { note: note, updatedAt: nowIso() })
          .then(function () { showToast("備考を保存しました"); })
          .catch(function () {});
        return;
      }

      if (e.target.closest("[data-del]")) {
        var ok = await confirmDialog({
          title: "名簿から削除します",
          body: m.name + " さんを名簿から消します。受付の記録も一緒に消えます。",
          warn: "この操作は取り消せません。",
          ok: "削除する", tone: "danger"
        });
        if (!ok) return;
        close();
        try {
          await Store.commit([{ op: "member.delete", id: m.id }]);
          showToast(m.name + " を削除しました");
        } catch (err) { showToast("削除できませんでした（" + errText(err) + "）"); }
      }
    });

    document.body.appendChild(scrim);
  }

  /* =========================================================
     設定画面
     ========================================================= */
  function openSettings() {
    settingsOpen = true;
    if (!settingsGid || !groups.some(function (g) { return g.id === settingsGid; })) {
      settingsGid = activeGid || (groups[0] && groups[0].id) || null;
    }
    var panel = document.createElement("div");
    panel.className = "panel";
    panel.id = "settings";
    document.body.appendChild(panel);
    renderSettings();
    bindSettings(panel);
  }

  function closeSettings() {
    settingsOpen = false;
    var p = $("settings");
    if (p) p.remove();
  }

  function renderSettings() {
    var panel = $("settings");
    if (!panel) return;
    /* 他端末の更新で再描画されても、入力途中の内容は失わないよう退避する */
    var keepTa = panel.querySelector("#bulk-text");
    var keptText = keepTa ? keepTa.value : "";
    var keptMode = panel.querySelector('input[name="bulk-mode"]:checked');
    keptMode = keptMode ? keptMode.value : "append";

    var gopts = groups.map(function (g) {
      return '<option value="' + esc(g.id) + '"' + (g.id === settingsGid ? " selected" : "") + ">" +
        esc(g.name) + " 組（" + membersOf(g.id).length + " 名）</option>";
    }).join("");

    var whole = tally(members);
    var marked = members.filter(function (m) { return m.status !== WAITING || m.note; }).length;

    var inputStyle = 'style="flex:1;min-width:0;padding:12px;background:var(--paper);' +
      'border:1px solid var(--line-strong);border-radius:10px;font-size:1rem"';

    panel.innerHTML =
      '<div class="panel-head"><div class="inner">' +
        '<button class="icon-btn" data-close-settings aria-label="設定を閉じる">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"></path></svg></button>' +
        "<h2>設定</h2>" +
      "</div></div>" +
      '<div class="panel-body">' +

        /* --- 名簿の一括登録 --- */
        '<div class="card">' +
          "<h3>名簿の一括登録</h3>" +
          '<p class="lead">氏名を <b>改行区切り</b> で貼り付けます。空行は無視されます。一度登録すれば、当日はこの画面を開く必要はありません。</p>' +
          '<label class="fld"><span>登録する組</span><select id="bulk-gid">' +
            (gopts || "<option>組がありません</option>") + "</select></label>" +
          '<label class="fld"><span>氏名（改行区切り）</span>' +
            '<textarea id="bulk-text" rows="8" placeholder="山田 太郎&#10;佐藤 花子&#10;鈴木 一郎">' + esc(keptText) + "</textarea></label>" +
          '<div class="fld" style="margin-bottom:16px">' +
            '<span style="display:block;font-size:.78rem;font-weight:700;letter-spacing:.08em;color:var(--ink-2);margin-bottom:6px">登録のしかた</span>' +
            '<div style="display:flex;flex-direction:column;gap:8px">' +
              '<label style="display:flex;gap:9px;align-items:flex-start;font-size:.9rem;line-height:1.6">' +
                '<input type="radio" name="bulk-mode" value="append"' + (keptMode === "append" ? " checked" : "") + ' style="margin-top:4px">' +
                "<span><b>追記する</b>（既にある名前はそのまま、新しい名前だけ足す）</span></label>" +
              '<label style="display:flex;gap:9px;align-items:flex-start;font-size:.9rem;line-height:1.6">' +
                '<input type="radio" name="bulk-mode" value="replace"' + (keptMode === "replace" ? " checked" : "") + ' style="margin-top:4px">' +
                "<span><b>入れ替える</b>（貼り付けた名簿に合わせる。一覧に無い名前は受付記録ごと消えます）</span></label>" +
            "</div></div>" +
          '<button class="btn primary wide" id="bulk-run">この組に登録する</button>' +
          '<div class="status" id="bulk-status"></div>' +
        "</div>" +

        /* --- 組の管理 --- */
        '<div class="card">' +
          "<h3>組の管理</h3>" +
          '<p class="lead">組はいくつでも追加できます。名前は「A」「立礼席」など自由につけられます。</p>' +
          '<ul class="glist">' + (groups.length ? groups.map(function (g) {
            var t = tally(membersOf(g.id));
            return "<li>" +
              '<span class="gn">' + esc(g.name) + "</span>" +
              '<span class="gc">' + t.arrived + "/" + t.total + " 名</span>" +
              '<button data-ren="' + esc(g.id) + '">名称</button>' +
              '<button data-delg="' + esc(g.id) + '">削除</button>' +
            "</li>";
          }).join("") : '<li><span class="gn" style="font-weight:400;color:var(--ink-3)">まだ組がありません</span></li>') + "</ul>" +
          '<div class="row-add">' +
            '<input id="new-group" type="text" placeholder="組の名前（例：H）" ' + inputStyle + ">" +
            '<button class="btn" id="add-group">追加</button>' +
          "</div>" +
          '<div class="status" id="group-status"></div>' +
        "</div>" +

        /* --- 会の名称 --- */
        '<div class="card">' +
          "<h3>会の名称</h3>" +
          '<p class="lead">受付画面の見出しに表示されます。</p>' +
          '<div class="row-add" style="margin-top:0">' +
            '<input id="meta-title" type="text" value="' + esc(meta.title) + '" ' + inputStyle + ">" +
            '<button class="btn" id="save-title">保存</button>' +
          "</div>" +
        "</div>" +

        /* --- リセット --- */
        '<div class="card danger-zone">' +
          "<h3>リセット</h3>" +
          '<p class="lead">どちらも取り消せません。押すと必ず確認画面が出て、何がいくつ消えるかを確かめてから実行します。</p>' +
          '<button class="btn danger wide" id="reset-records">受付の記録だけ消す（名簿は残る）</button>' +
          '<button class="btn danger wide" id="reset-all">すべて消して最初から（名簿・組も消す）</button>' +
          '<div class="status" id="reset-status">現在：名簿 ' + whole.total + " 名／組 " + groups.length +
            "／記録のある方 " + marked + " 名</div>" +
        "</div>" +

      "</div>";
  }

  function bindSettings(panel) {
    panel.addEventListener("change", function (e) {
      if (e.target.id === "bulk-gid") settingsGid = e.target.value;
    });

    panel.addEventListener("click", async function (e) {
      if (e.target.closest("[data-close-settings]")) { closeSettings(); return; }
      if (e.target.closest("#bulk-run"))      { await doBulkRegister(panel); return; }
      if (e.target.closest("#add-group"))     { await doAddGroup(panel); return; }
      if (e.target.closest("#save-title"))    { await doSaveTitle(panel); return; }
      if (e.target.closest("#reset-records")) { await doResetRecords(panel); return; }
      if (e.target.closest("#reset-all"))     { await doResetAll(panel); return; }

      var ren = e.target.closest("[data-ren]");
      if (ren) {
        var g = groups.find(function (x) { return x.id === ren.getAttribute("data-ren"); });
        if (g) openRename(g);
        return;
      }

      var dg = e.target.closest("[data-delg]");
      if (dg) { await doDeleteGroup(panel, dg.getAttribute("data-delg")); return; }
    });
  }

  /** 名簿の一括登録（追記／入れ替え） */
  async function doBulkRegister(panel) {
    var st = panel.querySelector("#bulk-status");
    var btn = panel.querySelector("#bulk-run");
    var gid = panel.querySelector("#bulk-gid").value;
    var mode = panel.querySelector('input[name="bulk-mode"]:checked').value;
    var names = panel.querySelector("#bulk-text").value
      .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);

    if (!connected) { st.className = "status err"; st.textContent = "保存先に接続できていません。"; return; }
    if (!gid) { st.className = "status err"; st.textContent = "先に組を追加してください。"; return; }
    if (!names.length) {
      st.className = "status err";
      st.textContent = "氏名が読み取れませんでした。1行に1名ずつ貼り付けてください。";
      return;
    }

    var existing = membersOf(gid);
    var group = groups.find(function (g) { return g.id === gid; });
    var ops = [], added = 0, removed = 0, kept = 0;

    if (mode === "replace") {
      var used = new Set();
      names.forEach(function (nm, i) {
        var hit = existing.find(function (m) { return !used.has(m.id) && m.name === nm; });
        if (hit) {
          used.add(hit.id); kept++;
          if (hit.order !== i) ops.push({ op: "member.update", id: hit.id, data: { order: i } });
        } else {
          added++;
          ops.push({ op: "member.set", id: uid("m_"), data: newMember(gid, nm, i) });
        }
      });
      var doomed = existing.filter(function (m) { return !used.has(m.id); });
      removed = doomed.length;
      if (removed) {
        var ok = await confirmDialog({
          title: "名簿を入れ替えます",
          body: (group ? group.name + " 組の" : "") + "貼り付けた名簿に合わせます。一覧に無い方は受付の記録ごと消えます。",
          what: [
            { k: "新しく追加", v: added + " 名" },
            { k: "そのまま残る", v: kept + " 名" },
            { k: "削除される", v: removed + " 名" }
          ],
          warn: "この操作は取り消せません。",
          ok: "入れ替える", tone: "danger"
        });
        if (!ok) return;
      }
      doomed.forEach(function (m) { ops.push({ op: "member.delete", id: m.id }); });
    } else {
      var have = new Set(existing.map(function (m) { return m.name; }));
      var base = existing.reduce(function (mx, m) { return Math.max(mx, m.order); }, -1) + 1;
      names.forEach(function (nm) {
        if (have.has(nm)) { kept++; return; }
        have.add(nm);
        ops.push({ op: "member.set", id: uid("m_"), data: newMember(gid, nm, base++) });
        added++;
      });
    }

    if (!ops.length) {
      st.className = "status";
      st.textContent = "変更はありませんでした（" + kept + " 名は登録済みです）。";
      return;
    }

    btn.disabled = true;
    st.className = "status";
    st.textContent = "登録しています… 0 / " + ops.length;
    try {
      await Store.commit(ops, function (d, n) { st.textContent = "登録しています… " + d + " / " + n; });
      st.textContent = "登録しました（追加 " + added + " 名" +
        (kept ? "／そのまま " + kept + " 名" : "") + (removed ? "／削除 " + removed + " 名" : "") + "）。";
      panel.querySelector("#bulk-text").value = "";
    } catch (err) {
      st.className = "status err";
      st.textContent = "一部を登録できませんでした（" + errText(err) +
        "）。もう一度「登録する」を押すと、足りない分だけ追加されます。";
    }
    btn.disabled = false;
  }

  function newMember(gid, name, order) {
    return {
      gid: gid, name: name, order: order,
      status: WAITING, arrivedAt: null, note: "",
      createdAt: nowIso(), updatedAt: nowIso()
    };
  }

  /** 組を追加 */
  async function doAddGroup(panel) {
    var gs = panel.querySelector("#group-status");
    var input = panel.querySelector("#new-group");
    var name = input.value.trim();
    if (!connected) { gs.className = "status err"; gs.textContent = "保存先に接続できていません。"; return; }
    if (!name) { gs.className = "status err"; gs.textContent = "組の名前を入力してください。"; return; }
    if (groups.some(function (g) { return g.name === name; })) {
      gs.className = "status err"; gs.textContent = "同じ名前の組があります。"; return;
    }
    var order = groups.reduce(function (mx, g) { return Math.max(mx, g.order); }, -1) + 1;
    try {
      await Store.commit([{ op: "group.set", id: uid("g_"),
        data: { name: name, order: order, createdAt: nowIso() } }]);
      input.value = "";
      gs.className = "status"; gs.textContent = name + " 組を追加しました。";
    } catch (err) {
      gs.className = "status err"; gs.textContent = "追加できませんでした（" + errText(err) + "）。";
    }
  }

  /** 組を削除（所属する参加者ごと） */
  async function doDeleteGroup(panel, gid) {
    var g = groups.find(function (x) { return x.id === gid; });
    if (!g) return;
    var mem = membersOf(gid);
    var t = tally(mem);
    var ok = await confirmDialog({
      title: g.name + " 組を削除します",
      body: "この組と、所属する方の名簿・受付記録をまとめて消します。",
      what: [
        { k: "消える名簿", v: t.total + " 名" },
        { k: "うち到着済み", v: t.arrived + " 名" }
      ],
      warn: "この操作は取り消せません。",
      ok: "削除する", tone: "danger"
    });
    if (!ok) return;

    var gs = panel.querySelector("#group-status");
    gs.className = "status"; gs.textContent = "削除しています…";
    var ops = mem.map(function (m) { return { op: "member.delete", id: m.id }; });
    ops.push({ op: "group.delete", id: gid });
    try {
      await Store.commit(ops, function (d, n) { gs.textContent = "削除しています… " + d + " / " + n; });
      gs.textContent = g.name + " 組を削除しました。";
    } catch (err) {
      gs.className = "status err";
      gs.textContent = "削除しきれませんでした（" + errText(err) + "）。もう一度お試しください。";
    }
  }

  /** 会の名称を保存 */
  async function doSaveTitle(panel) {
    var v = panel.querySelector("#meta-title").value.trim() || DEFAULT_TITLE;
    try {
      await Store.commit([{ op: "meta.set", data: { title: v, updatedAt: nowIso() } }]);
      meta.title = v;
      $("ttl").textContent = v;
      document.title = v;
      showToast("会の名称を保存しました");
    } catch (err) { showToast("保存できませんでした（" + errText(err) + "）"); }
  }

  /** リセット其の一：受付の記録だけ消す（名簿は残す） */
  async function doResetRecords(panel) {
    var rs = panel.querySelector("#reset-status");
    var marked = members.filter(function (m) { return m.status !== WAITING || m.note; });
    if (!marked.length) {
      rs.className = "status"; rs.textContent = "消す記録がありません。すでにすべて未到着です。"; return;
    }
    var t = tally(marked);
    var noted = marked.filter(function (m) { return !!m.note; }).length;
    var ok = await confirmDialog({
      title: "受付の記録を消します",
      body: "名簿と組はそのまま残り、到着・欠席・備考だけが消えて全員「未到着」に戻ります。",
      what: [
        { k: "到着を取り消す", v: t.arrived + " 名" },
        { k: "欠席を取り消す", v: t.absent + " 名" },
        { k: "備考を消す", v: noted + " 名" },
        { k: "残る名簿", v: members.length + " 名" }
      ],
      warn: "この操作は取り消せません。",
      ok: "記録を消す", tone: "danger"
    });
    if (!ok) return;

    rs.className = "status"; rs.textContent = "消しています… 0 / " + marked.length;
    var ops = marked.map(function (m) {
      return { op: "member.update", id: m.id,
        data: { status: WAITING, arrivedAt: null, note: "", updatedAt: nowIso() } };
    });
    try {
      await Store.commit(ops, function (d, n) { rs.textContent = "消しています… " + d + " / " + n; });
      rs.textContent = "受付の記録を消しました。名簿 " + members.length + " 名はそのまま残っています。";
    } catch (err) {
      rs.className = "status err";
      rs.textContent = "一部が消せませんでした（" + errText(err) + "）。もう一度お試しください。";
    }
  }

  /** リセット其の二：名簿・組も含めてすべて消す */
  async function doResetAll(panel) {
    var rs = panel.querySelector("#reset-status");
    if (!members.length && !groups.length) {
      rs.className = "status"; rs.textContent = "消すものがありません。"; return;
    }
    var t = tally(members);
    var ok = await confirmDialog({
      title: "すべて消して最初からやり直します",
      body: "名簿・組・受付の記録を、この受付帳からすべて消します。空の状態に戻ります。",
      what: [
        { k: "消える組", v: groups.length + " 組" },
        { k: "消える名簿", v: members.length + " 名" },
        { k: "うち到着済み", v: t.arrived + " 名" }
      ],
      warn: "この操作は取り消せません。名簿の貼り直しが必要になります。",
      ok: "すべて消す", tone: "danger"
    });
    if (!ok) return;

    /* 取り返しがつかないので、二度目の確認を挟む */
    var sure = await confirmDialog({
      title: "本当によろしいですか",
      body: "もう一度おたずねします。" + groups.length + " 組・" + members.length +
        " 名の名簿がすべて消えます。受付の途中でないことを確かめてください。",
      ok: "はい、すべて消します", tone: "danger"
    });
    if (!sure) { rs.className = "status"; rs.textContent = "取りやめました。何も消していません。"; return; }

    var ops = members.map(function (m) { return { op: "member.delete", id: m.id }; })
      .concat(groups.map(function (g) { return { op: "group.delete", id: g.id }; }));
    rs.className = "status"; rs.textContent = "消しています… 0 / " + ops.length;
    try {
      await Store.commit(ops, function (d, n) { rs.textContent = "消しています… " + d + " / " + n; });
      rs.textContent = "すべて消しました。組をつくって名簿を貼り付けてください。";
    } catch (err) {
      rs.className = "status err";
      rs.textContent = "一部が消せませんでした（" + errText(err) + "）。もう一度お試しください。";
    }
  }

  /** 組の名称変更シート */
  function openRename(g) {
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' +
      '<div class="grabber" aria-hidden="true"></div>' +
      "<h2>組の名称</h2>" +
      '<label class="fld"><span>名称</span><input id="rn" type="text" value="' + esc(g.name) + '"></label>' +
      '<div class="sheet-actions"><button class="btn ghost" data-close>やめる</button>' +
      '<button class="btn primary" data-ok>保存</button></div></div>';
    scrim.addEventListener("click", async function (e) {
      if (e.target === scrim || e.target.closest("[data-close]")) { scrim.remove(); return; }
      if (e.target.closest("[data-ok]")) {
        var v = scrim.querySelector("#rn").value.trim();
        if (!v) return;
        scrim.remove();
        try { await Store.commit([{ op: "group.update", id: g.id, data: { name: v } }]); }
        catch (err) { showToast("名称を保存できませんでした（" + errText(err) + "）"); }
      }
    });
    document.body.appendChild(scrim);
  }

  /* =========================================================
     イベント配線
     ========================================================= */
  function bindGlobal() {
    document.addEventListener("click", function (e) {
      var tab = e.target.closest(".tab[data-gid]");
      if (tab) {
        activeGid = tab.getAttribute("data-gid");
        query = ""; $("q").value = ""; $("q-clear").hidden = true;
        renderAll();
        return;
      }

      var row = e.target.closest('[data-act="toggle"]');
      if (row) {
        var m = members.find(function (x) { return x.id === row.getAttribute("data-id"); });
        if (m) toggleArrival(m);
        return;
      }

      var more = e.target.closest('[data-act="detail"]');
      if (more) { openDetail(more.getAttribute("data-id")); return; }

      if (e.target.closest("#btn-settings") || e.target.closest("[data-open-settings]")) {
        openSettings();
      }
    });

    $("only-waiting").addEventListener("click", function () {
      onlyWaiting = !onlyWaiting;
      this.setAttribute("aria-pressed", String(onlyWaiting));
      renderList();
    });

    $("q").addEventListener("input", function () {
      query = this.value.trim();
      $("q-clear").hidden = query.length === 0;
      renderList();
    });

    $("q-clear").addEventListener("click", function () {
      query = ""; $("q").value = ""; this.hidden = true; renderList();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var s = document.querySelector(".scrim");
      if (s) { s.remove(); return; }
      if (settingsOpen) closeSettings();
    });
  }

  /* =========================================================
     起動
     ========================================================= */
  function boot() {
    renderShell();
    bindGlobal();
    loadCache();                       // 届くまでのつなぎに前回の内容を出す
    $("ttl").textContent = meta.title;
    document.title = meta.title;
    renderAll();
    if (!Store) {
      connError = "no-store";
      connHelp = "<h2>保存先が設定されていません</h2><p>アダプタ（ChakaiStore）が読み込まれていません。</p>";
      renderAll();
      return;
    }
    connect();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
