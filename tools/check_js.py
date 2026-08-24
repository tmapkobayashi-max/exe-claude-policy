# -*- coding: utf-8 -*-
"""JSの簡易構文チェッカー（2026/8/24 作成）

この環境には node が入っていないため、拡張機能のJSを編集したあと
「読み込めるかどうか」を確かめる手段が無い。
2026/8/24、1行を2行に置き換える処理を4回繰り返して古い末尾行が3本残り、
テンプレートリテラルが壊れた。拡張機能は黙って動かなくなり、
設定画面の「テスト送信」が「送信中…」のまま止まった（原因が見えない壊れ方）。

完全なパーサではない。文字列・テンプレートリテラル・コメントを読み飛ばしながら
括弧の対応と閉じ忘れを見るだけ。だが、上の事故はこれで確実に捕まる。

  python tools/check_js.py                     … 主要ファイルをまとめて
  python tools/check_js.py chatwork-notify.js  … 個別に

⚠️ このファイルを拡張機能のルートに置かないこと。
   Chromeは "_" で始まるファイル名をルートで予約しており、置いた瞬間に
   「Cannot load extension with file or directory name _xxx」で読み込めなくなる
   （2026/8/24に実際に踏んだ）。tools/ の下に置いてある理由がこれ。

⚠️ 既知の誤検知：正規表現リテラル（/.../）を解釈しない。
   options.js の csvEscape にある  if (/[",\r\n]/.test(s))  のように
   正規表現の中に引用符があると「閉じ忘れ」と誤って言う。ここは無視してよい。
"""
import sys, io, os

BS = chr(92)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def check(path):
    s = io.open(path, encoding='utf-8').read()
    i, n = 0, len(s)
    line = 1
    stack = []
    errors = []

    while i < n:
        c = s[i]
        if c == chr(10):
            line += 1; i += 1; continue

        if c == '/' and i + 1 < n and s[i+1] == '/':
            while i < n and s[i] != chr(10): i += 1
            continue
        if c == '/' and i + 1 < n and s[i+1] == '*':
            start = line; i += 2
            while i + 1 < n and not (s[i] == '*' and s[i+1] == '/'):
                if s[i] == chr(10): line += 1
                i += 1
            if i + 1 >= n: errors.append(str(start) + '行: /* が閉じていない')
            i += 2; continue

        if c == '"' or c == chr(39):
            q, start = c, line
            i += 1
            while i < n and s[i] != q:
                if s[i] == BS: i += 1
                elif s[i] == chr(10):
                    errors.append(str(start) + '行: ' + q + ' で開いた文字列が改行をまたいでいる（閉じ忘れ）')
                    break
                i += 1
            i += 1; continue

        if c == chr(96):
            start = line
            i += 1
            closed = False
            while i < n:
                if s[i] == BS: i += 2; continue
                if s[i] == chr(10): line += 1; i += 1; continue
                if s[i] == '$' and i + 1 < n and s[i+1] == '{':
                    depth = 1; i += 2
                    while i < n and depth:
                        if s[i] == '{': depth += 1
                        elif s[i] == '}': depth -= 1
                        elif s[i] == chr(10): line += 1
                        i += 1
                    continue
                if s[i] == chr(96):
                    closed = True; i += 1; break
                i += 1
            if not closed: errors.append(str(start) + '行: バッククォートが閉じていない')
            continue

        if c in '([{':
            stack.append((c, line)); i += 1; continue
        if c in ')]}':
            pair = {')': '(', ']': '[', '}': '{'}[c]
            if not stack:
                errors.append(str(line) + '行: 対応する開き括弧の無い ' + c)
            elif stack[-1][0] != pair:
                errors.append(str(line) + '行: ' + c + ' が ' + stack[-1][0] + '（' + str(stack[-1][1]) + '行）と対応していない')
                stack.pop()
            else:
                stack.pop()
            i += 1; continue
        i += 1

    for ch, ln in stack:
        errors.append(str(ln) + '行: ' + ch + ' が閉じていない')
    return errors

if __name__ == '__main__':
    names = sys.argv[1:] or ['chatwork-notify.js', 'background.js', 'options.js', 'content.js', 'floating-widget.js']
    bad = 0
    for name in names:
        path = name if os.path.isabs(name) else os.path.join(ROOT, name)
        try:
            errs = check(path)
        except FileNotFoundError:
            print('--- ' + name + ': 見つかりません'); continue
        if errs:
            bad += 1
            print('--- ' + name + ': NG')
            for e in errs: print('    ' + e)
        else:
            print('--- ' + name + ': OK')
    sys.exit(1 if bad else 0)
