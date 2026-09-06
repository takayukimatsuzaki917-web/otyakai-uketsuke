/* =============================================================
   茶会受付帳 － 画面の動作確認（実DOM）
   -------------------------------------------------------------
   本物のブラウザと同じ DOM（jsdom）の上で app.js を動かし、
   「ボタンを押したら本当に反応するか」を確かめます。

   これを用意した理由:
     設定画面の「組の名称」「削除」「リセット」が、押しても何も
     起きない不具合を二度起こしました。原因はどちらも押した先の
     処理ではなく、押されたことを受け取る側（重なり順・目印の
     取り違え）でした。作り物の DOM では見つけられなかったため、
     本物の DOM で押して確かめる形にしています。

   使い方:
     npm install jsdom     （初回のみ）
     node build/dom-test.js

   保存先（Firebase / Artifact）にはつなぎません。差し替え可能な
   アダプタの代わりに、呼ばれたことだけを控える偽物を渡します。
   ============================================================= */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
let ng = 0;

/** 合否を1行で表示する */
function check(label, ok, detail) {
  if (!ok) ng++;
  console.log("  " + (ok ? "✓" : "✗") + " " + label + (detail ? " … " + detail : ""));
}

/** アプリを1つ起動して、操作に必要な道具を返す */
function boot() {
  const dom = new JSDOM(
    '<!doctype html><html><head><style>' +
      fs.readFileSync(path.join(ROOT, "src/app.css"), "utf8") +
    '</style></head><body><div id="app-root"></div></body></html>',
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.test/" }
  );
  const win = dom.window;
  const commits = [];      // 書き込みの記録
  let handlers = null;     // アプリが渡してくる受け口

  win.ChakaiStore = {
    label: "test",
    cacheKey: "test",
    connect: (h) => { handlers = h; return Promise.resolve({ ok: true }); },
    commit: (ops) => { commits.push(ops); return Promise.resolve(); },
    refresh: () => Promise.resolve(),
  };
  win.eval(fs.readFileSync(path.join(ROOT, "src/app.js"), "utf8"));
  return { win, doc: win.document, commits, h: () => handlers };
}

const click = (el) =>
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));

/* 検査用の名簿。実際の参加者ではありません。
   1日目に2組（うちA組に3名）、2日目に1組（1名）という構成 */
const DAYS = [{ id: "d1", name: "1日目" }, { id: "d2", name: "2日目" }];
const GROUPS = [
  { id: "g_a", name: "A", order: 0, day: "d1" },
  { id: "g_b", name: "B", order: 1, day: "d1" },
  { id: "g_c", name: "C", order: 0, day: "d2" },
];
const MEMBERS = [
  { id: "m1", gid: "g_a", name: "山田 太郎", order: 0, status: "arrived", arrivedAt: "2026-09-06T09:42:00+09:00", note: "" },
  { id: "m2", gid: "g_a", name: "佐藤 花子", order: 1, status: "waiting", arrivedAt: null, note: "お履物あずかり" },
  { id: "m3", gid: "g_a", name: "鈴木 一郎", order: 2, status: "absent", arrivedAt: null, note: "" },
  { id: "m9", gid: "g_c", name: "高橋 二郎", order: 0, status: "waiting", arrivedAt: null, note: "" },
];

(async () => {
  const { win, doc, commits, h } = boot();
  await tick();
  h().meta({ title: "秋季茶会", days: DAYS, activeDay: "d1" });
  h().groups(GROUPS);
  h().members(MEMBERS);

  /* ---------------- 受付画面 ---------------- */
  console.log("\n■ 受付画面");
  check("その日の名簿だけ3行出る（2日目の1名は出ない）", doc.querySelectorAll(".item").length === 3);
  check("見出しに開催日が出る", doc.getElementById("daylabel").textContent === "1日目");
  check("組タブはその日の2組だけ", doc.querySelectorAll(".tab").length === 2);
  check("全体の到着数もその日だけ",
    doc.getElementById("tot-d").textContent === "/3", doc.getElementById("tot-d").textContent);
  check("到着した方に印がつく", doc.querySelectorAll(".item.arrived").length === 1);
  check("欠席の方が区別される", doc.querySelectorAll(".item.absent").length === 1);
  check("到着時刻が出る", /09:42/.test(doc.getElementById("list").innerHTML));
  check("備考が行に出る", /お履物あずかり/.test(doc.getElementById("list").innerHTML));

  /* 絞り込みは、到着を記録する前に確かめる（記録すると未到着が居なくなるため） */
  click(doc.getElementById("only-waiting"));
  await tick();
  check("「未着のみ」で未到着の1名だけになる", doc.querySelectorAll(".item").length === 1);
  click(doc.getElementById("only-waiting"));
  await tick();
  check("もう一度押すと全員に戻る", doc.querySelectorAll(".item").length === 3);

  const before = commits.length;
  click(doc.querySelector('[data-act="toggle"][data-id="m2"]'));
  await tick();
  const op = commits[commits.length - 1] && commits[commits.length - 1][0];
  check("氏名をタップすると到着として記録される",
    commits.length > before && op.op === "member.update" && op.data.status === "arrived",
    op ? op.data.status : "書き込みなし");
  check("押し間違えたときの「取消」が出る",
    !!doc.getElementById("toast") && /取消/.test(doc.getElementById("toast").textContent));

  click(doc.querySelector('[data-act="detail"][data-id="m3"]'));
  await tick();
  check("「変更」で詳細が開く", /鈴木 一郎/.test(doc.querySelector(".sheet")?.textContent || ""));
  click(doc.querySelector(".scrim [data-close]"));
  await tick();

  click(doc.getElementById("btn-refresh"));
  await tick();
  check("「更新」で最新にした旨が出る", /最新の名簿にしました/.test(doc.body.textContent));

  /* ---------------- 設定画面 ----------------
     押しても何も起きない不具合を繰り返した箇所。
     「確認画面が出るか」を実際に押して確かめる。 */
  console.log("\n■ 設定画面（押して反応するか）");
  click(doc.getElementById("btn-settings"));
  await tick();
  const panel = doc.getElementById("settings");
  check("設定画面が開く", !!panel);

  const cases = [
    ["組の「名称」", "[data-ren]", "組の名称"],
    ["組の「削除」", "[data-delg]", "組を削除します"],
    ["受付の記録だけ消す", "#reset-records", "受付の記録を消します"],
    ["すべて消して最初から", "#reset-all", "すべて消して最初から"],
  ];
  for (const [label, sel, expect] of cases) {
    doc.querySelectorAll(".scrim").forEach((s) => s.remove());
    const btn = panel.querySelector(sel);
    if (!btn) { check(label, false, "ボタンが無い"); continue; }
    click(btn);
    await tick();
    const scrim = doc.querySelector(".scrim");
    const title = (scrim?.querySelector("h2, h3")?.textContent || "").trim();
    check(label, title.includes(expect), title || "何も起こらない");
  }

  /* 確認画面は設定画面より手前に出る必要がある */
  doc.querySelectorAll(".scrim").forEach((s) => s.remove());
  click(panel.querySelector("#reset-all"));
  await tick();
  const scrim = doc.querySelector(".scrim");
  const z = (el) => Number(win.getComputedStyle(el).zIndex);
  check("確認画面が設定画面より手前に出る", z(scrim) > z(panel),
    "確認 " + z(scrim) + " / 設定 " + z(panel));
  click(scrim.querySelector("[data-no]"));
  await tick();
  check("「やめる」で閉じて何も消えない", !doc.querySelector(".scrim"));

  const sizeBefore = doc.documentElement.getAttribute("data-size");
  click(panel.querySelector('[data-set-size="l"]'));
  await tick();
  check("文字の大きさを変えられる",
    doc.documentElement.getAttribute("data-size") === "l", sizeBefore + " → l");

  /* ---------------- 開催日の切り替え ---------------- */
  console.log("\n■ 開催日（1日目 / 2日目）");
  doc.querySelectorAll(".scrim").forEach((s) => s.remove());
  check("設定に開催日の選択がある", panel.querySelectorAll("[data-set-day]").length === 2);
  check("いまの日が選ばれている",
    panel.querySelector('[data-set-day="d1"]').getAttribute("aria-pressed") === "true");
  check("日ごとの組数・人数が出る",
    /2 組 3 名/.test(panel.querySelector('[data-set-day="d1"]').textContent) &&
    /1 組 1 名/.test(panel.querySelector('[data-set-day="d2"]').textContent));

  click(panel.querySelector('[data-set-day="d2"]'));
  await tick();
  const dayScrim = doc.querySelector(".scrim");
  check("切り替えには確認画面が出る",
    /2日目.*に切り替えます/.test(dayScrim?.querySelector("h3")?.textContent || ""),
    dayScrim?.querySelector("h3")?.textContent || "出ない");
  check("全員の画面が変わる旨を伝える", /全員の画面/.test(dayScrim?.textContent || ""));

  const n0 = commits.length;
  click(dayScrim.querySelector("[data-yes]"));
  await tick();
  const dayOp = commits[commits.length - 1]?.[0];
  check("切り替えが共有として保存される",
    commits.length > n0 && dayOp.op === "meta.update" && dayOp.data.activeDay === "d2",
    dayOp ? dayOp.op + " activeDay=" + dayOp.data.activeDay : "書き込みなし");

  /* 保存先から届いた形で反映されるか（実際の経路と同じ） */
  h().meta({ title: "秋季茶会", days: DAYS, activeDay: "d2" });
  await tick();
  check("2日目の名簿に入れ替わる", doc.querySelectorAll(".item").length === 1);
  check("見出しが2日目になる", doc.getElementById("daylabel").textContent === "2日目");
  check("2日目の氏名が出る", /高橋 二郎/.test(doc.getElementById("list").innerHTML));

  /* 組を足すと、いま選んでいる日のものになる */
  const n1 = commits.length;
  panel.querySelector("#new-group").value = "D";
  click(panel.querySelector("#add-group"));
  await tick();
  const gOp = commits[commits.length - 1]?.[0];
  check("追加した組はその日のものになる",
    commits.length > n1 && gOp.op === "group.set" && gOp.data.day === "d2",
    gOp ? "day=" + gOp.data.day : "書き込みなし");

  /* リセットはその日だけが対象 */
  doc.querySelectorAll(".scrim").forEach((s) => s.remove());
  h().meta({ title: "秋季茶会", days: DAYS, activeDay: "d1" });
  await tick();
  click(panel.querySelector("#reset-records"));
  await tick();
  const rs = doc.querySelector(".scrim");
  check("リセットはその日だけが対象と分かる",
    /ほかの日の記録はそのまま/.test(rs?.textContent || ""),
    (rs?.querySelector("h3")?.textContent || "").trim());
  click(rs.querySelector("[data-no]"));
  await tick();

  console.log("\n" + (ng === 0 ? "すべて通りました。" : ng + " 件が通りませんでした。"));
  process.exit(ng === 0 ? 0 : 1);
})();
