/* =============================================================
   茶会受付帳 － 設定ファイル
   -------------------------------------------------------------
   ここだけ書き換えれば動きます。手順は README.md を見てください。

   ★ この値は「公開してよい」設定です ★
     Firebase のウェブ用の設定値は、ブラウザに配られる前提のもので、
     秘密の鍵ではありません。守りは database.rules.json のルールで行います。
     （＝ルールを貼っていないと、名簿が誰にでも書き換えられます）
   ============================================================= */
window.CHAKAI_CONFIG = {

  /* -----------------------------------------------------------
     1) Firebase の設定
        Firebase コンソール →「プロジェクトの設定」→「マイアプリ」の
        ウェブアプリに表示される firebaseConfig の写しです。
     ----------------------------------------------------------- */
  firebase: {
    apiKey:            "AIzaSyBbcGE-QKx0UUgdVdsWmD-ruo33kvxtw1w",
    authDomain:        "otyakai-uketsuke.firebaseapp.com",
    databaseURL:       "https://otyakai-uketsuke-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId:         "otyakai-uketsuke",
    storageBucket:     "otyakai-uketsuke.firebasestorage.app",
    messagingSenderId: "998519404757",
    appId:             "1:998519404757:web:998af3b2ca77d6b2288a5c",
    measurementId:     "G-5JGE9QGVCQ"
  },

  /* -----------------------------------------------------------
     2) 会のID
        データの入れ物を分ける名札です。同じ設置のまま、
        次の茶会では別のIDにすれば、前回の名簿と混ざりません。

        URL に ?room=～ を付けると、そちらが優先されます。
          例) https://～/?room=chakai-20270101

        推測されにくい文字列にしてあるので、URL そのものが
        合言葉として働きます（英数字・ハイフンが使えます）。
     ----------------------------------------------------------- */
  roomId: "chakai-20260906-k7f2q9"
};
