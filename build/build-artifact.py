# -*- coding: utf-8 -*-
"""
Artifact 版（1ファイル）を src/ から組み立てるスクリプト。

自前ホスティング版（index.html）と Artifact 版は、画面もロジックも
src/app.css・src/app.js を共有します。違うのは保存先アダプタだけです。
    自前ホスティング版 : src/store-firebase.js
    Artifact 版        : src/store-claude.js

Artifact は外部ファイルを読み込めないため、CSS と JS を1枚の HTML に
まとめてから publish します。

使い方:
    python build/build-artifact.py
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dist", "chakai-uketsuke-artifact.html")

TITLE = "茶会受付帳"
FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
    'family=Zen+Kaku+Gothic+New:wght@400;500;700&family=Zen+Old+Mincho:wght@600&display=swap">'
)


def read(rel_path):
    """src/ 以下のファイルを UTF-8 で読む"""
    with io.open(os.path.join(ROOT, rel_path), encoding="utf-8") as f:
        return f.read()


def main():
    css = read("src/app.css")
    store = read("src/store-claude.js")
    app = read("src/app.js")

    # 埋め込む JS の中に </script> があると、そこで script が終わってしまう
    for name, code in (("store-claude.js", store), ("app.js", app)):
        if "</script" in code.lower():
            raise SystemExit("!! %s に </script> が含まれています。埋め込めません。" % name)

    parts = [
        "<title>%s</title>" % TITLE,
        FONTS,
        "",
        "<style>",
        css.rstrip(),
        "</style>",
        "",
        '<div id="app-root"></div>',
        "",
        "<script>",
        store.rstrip(),
        "</script>",
        "",
        "<script>",
        app.rstrip(),
        "</script>",
        "",
    ]
    html = "\n".join(parts)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    print("組み立てました: %s (%d 文字)" % (os.path.relpath(OUT, ROOT), len(html)))


if __name__ == "__main__":
    main()
