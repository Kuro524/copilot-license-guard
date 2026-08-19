# Changelog

## [1.1.0] - 2026-08-19

### Added
- `THIRD-PARTY-NOTICES.md` を追加。VSIX に同梱されるサードパーティコードが
  **0 件**であること（実行時依存なし）を明示。
- README に以下を明記:
  - **GitHub の非公式エンドポイント `/copilot_internal/user` に依存している**こと、
    予告なく変更・廃止される可能性、GitHub / Microsoft と無関係であること。
  - 免責事項（AS IS 提供、最終確認は組織の管理画面で行うこと）。
  - 送信データ / プライバシー（テレメトリ送信なし、トークンを保存しないこと）。
  - ライセンス詳細（本体 MIT、ビルド依存は Apache-2.0 / MIT で非同梱）。
  - SKU 等の識別子の由来（microsoft/vscode からのコード複製は行っていないこと）。
  - 商標表記。
- 起動時の出力ログと、ステータスバーのツールチップにも非公式 API 依存の注意を表示。

### Changed
- `.vscodeignore` に `.github/**` を追加し、VSIX へワークフロー定義が
  含まれてしまう問題を修正。

## [1.0.2] - 2026-08-19

### Fixed
- `authentication.onDidChangeSessions` が 1 操作で複数回発火するため、
  検査が重複実行される問題を修正（debounce + 実行中フラグ）。
- 実行中フラグを UI 表示の前に解放するようにし、モーダル内の「再チェック」が
  自分自身にブロックされる問題を回避。

## [1.0.1] - 2026-08-19

### Fixed
- `vscode.authentication.getSession(..., { silent: true })` は
  「拡張が既にアクセス許可を得ている場合のみ」セッションを返すため、
  初回起動時に必ず判定不能になっていた問題を修正。
  初回のみ同意ダイアログ（`createIfNone`）を表示するようにした。
- ログのタイムスタンプを UTC からローカル時刻に変更。

## [1.0.0] - 2026-08-19

### Added
- 起動時・定期（既定30分）・GitHub アカウント切替時に Copilot ライセンスを検査。
- Business / Enterprise 以外を検出した場合にモーダルダイアログで警告。
- ステータスバーへの現在プラン表示（違反時は赤背景）。
- 出力パネル `Copilot License Guard` への監査ログ。
- 設定: `allowedPlans` / `requireOrganization` / `checkIntervalMinutes` /
  `modalWarning` / `warnOnOrganizationless` / `statusBar` / `enabled`。
- コマンド: 手動チェック、ログ表示。
