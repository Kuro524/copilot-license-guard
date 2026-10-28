# Third Party Notices

本ソフトウェア（Copilot License Guard）は MIT License の下で提供されます。

## 再配布されるサードパーティコンポーネント

**なし。**

本拡張の配布物（`.vsix`）に含まれるのは、以下の自作ファイルのみです。

- `out/extension.js` — 本プロジェクトのソース (`src/extension.ts`) をコンパイルしたもの
- `package.json` / `README.md` / `CHANGELOG.md` / `LICENSE` / `PRIVACY.md` / `THIRD-PARTY-NOTICES.md`（本ファイル）
- `icon.png` — 本プロジェクトで作成した拡張アイコン

`package.json` の `dependencies` は空であり、**サードパーティのコードを再配布していません**。

---

## ビルド時にのみ使用するコンポーネント

以下は開発・ビルド時にのみ使用され、配布物には含まれません。

### TypeScript

- バージョン: 5.x
- ライセンス: Apache License 2.0
- https://github.com/microsoft/TypeScript
- Copyright (c) Microsoft Corporation

### @types/vscode

- ライセンス: MIT
- https://github.com/DefinitelyTyped/DefinitelyTyped
- Definitely Typed contributors

### @types/node

- ライセンス: MIT
- https://github.com/DefinitelyTyped/DefinitelyTyped
- Definitely Typed contributors

### @vscode/vsce（パッケージング時のみ・`npx` 実行）

- ライセンス: MIT
- https://github.com/microsoft/vscode-vsce
- Copyright (c) Microsoft Corporation

---

## 実行時に利用する外部サービス

### GitHub REST API（内部エンドポイント）

本拡張は実行時に `https://api.github.com/copilot_internal/user` を呼び出します。

- これは **GitHub がドキュメント化していない非公開エンドポイント**です。
- コードの複製・再配布は行っていません（HTTP 経由での呼び出しのみ）。
- 予告なく変更・廃止される可能性があります。詳細は README の「重要なお知らせ」を参照してください。

---

## 識別子の由来について

プラン判定に使用する SKU 文字列および `copilot_plan` の値は、
公開情報および MIT ライセンスで公開されている
[microsoft/vscode](https://github.com/microsoft/vscode) の外部から観測可能な挙動の調査により
特定した**識別子（文字列定数）**です。

同リポジトリのソースコードを複製・翻案したものではなく、
判定ロジックはすべて本プロジェクトの独自実装です。

---

## 商標

GitHub および GitHub Copilot は GitHub, Inc. の、
Visual Studio Code および TypeScript は Microsoft Corporation の
商標または登録商標です。

本プロジェクトはこれらの企業とは無関係であり、承認・提供・サポートを受けたものではありません。
