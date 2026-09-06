# -*- coding: utf-8 -*-
"""
取扱説明書（docs/manual.html）を PDF に変換するスクリプト。

LINE で配るための PDF を作ります。変換には、この PC に入っている
Chrome または Edge の「印刷」機能をそのまま使います（追加の導入は不要）。

使い方:
    python build/build-manual.py

出来上がり:
    docs/茶会受付帳_つかいかた.pdf
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "manual.html")
OUT = os.path.join(ROOT, "docs", "茶会受付帳_つかいかた.pdf")

# 探しに行くブラウザ。上から順に、最初に見つかったものを使う
CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_browser():
    """PDF への変換に使えるブラウザを探す"""
    for path in CANDIDATES:
        if os.path.isfile(path):
            return path
    for name in ("chrome", "msedge", "google-chrome", "chromium"):
        found = shutil.which(name)
        if found:
            return found
    return None


def main():
    if not os.path.isfile(SRC):
        sys.exit("!! 元の原稿が見つかりません: %s" % SRC)

    browser = find_browser()
    if not browser:
        sys.exit(
            "!! Chrome も Edge も見つかりませんでした。\n"
            "   docs/manual.html をブラウザで開き、Ctrl+P →「PDF として保存」でも同じものが作れます。"
        )

    # file:/// 形式に直す（Windows の \ を / にして先頭にスラッシュを足す）
    url = "file:///" + SRC.replace("\\", "/")

    cmd = [
        browser,
        "--headless=new",          # 画面を出さずに動かす
        "--disable-gpu",
        "--no-pdf-header-footer",  # ページ上下の日付やURLを入れない
        "--print-to-pdf=" + OUT,
        "--virtual-time-budget=5000",   # 描画が終わるのを待つ
        url,
    ]

    print("使うブラウザ : %s" % browser)
    print("原稿         : %s" % os.path.relpath(SRC, ROOT))
    result = subprocess.run(cmd, capture_output=True)

    if not os.path.isfile(OUT):
        sys.stderr.write(result.stderr.decode("utf-8", "replace"))
        sys.exit("!! PDF を作れませんでした。")

    size_kb = os.path.getsize(OUT) / 1024.0
    print("出来上がり   : %s (%.0f KB)" % (os.path.relpath(OUT, ROOT), size_kb))


if __name__ == "__main__":
    main()
