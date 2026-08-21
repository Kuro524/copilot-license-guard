# Changelog

## [1.2.0] - 2026-08-21

### Changed
- **プラン種別の主判定を GitHub の公開 API に移行。**
  公開 GraphQL API の `viewer.copilotEndpoints.api`（GitHub 公開スキーマ
  `schema.docs.graphql` に `@docsCategory(name: "copilot")` 付きで掲載された正式フィールド、
  管理者権限不要）を使用し、ホスト名から法人／個人を判定するようにした。
  - `api.business.githubcopilot.com` / `api.enterprise.githubcopilot.com` → 法人
  - `api.individual.githubcopilot.com` / `api.githubcopilot.com` → 個人
  - `*.githubcopilot.com` 以外は必ず「不明」（サフィックス偽装対策）
- **非公式エンドポイント `/copilot_internal/user` を「詳細情報の任意な補強」に降格。**
  取得に失敗しても主判定は継続し、ステータスバーは「不明」にならなくなった。
- `requireOrganization` の確認を、組織一覧の列挙ではなく
  `GET /user/memberships/orgs/{org}` によるピンポイント照会に変更。
  一覧列挙（`GET /user/orgs` / GraphQL `viewer.organizations`）は IP 許可リストや
  SAML SSO が有効な組織を取りこぼし、「メンバーではない」と**誤検知する**ことを確認したため。
  `403`（IP 許可リスト等）は「確認不能」として扱い、違反にしない。
  `read:org` 権限が無い場合は `404` の誤読を避けるため確認自体をスキップする。
- ステータスバーのツールチップ・警告ダイアログ・ログに「判定元（公開 API のみ / 公開 API + 非公式 API）」と
  補足情報を表示するようにした。

### Added
- 設定 `copilotLicenseGuard.useInternalApi`（既定 `true`）。
  `false` にすると非公式 API を一切呼ばず、**公開 API のみで動作**する。
- `requireOrganization` を設定している場合のみ、`read:org` 権限をあわせて要求するようにした。

### Notes
- 公開 API のみのモードでは、以下は判別できない（主目的である「法人シートか否か」の判定には影響しない）:
  - Free / Pro / Pro+ / Max の区別
  - Business と Enterprise の区別
  - どの組織がシートを提供しているか

### Fixed
- 内部 API が `200` を返しつつ `copilot_plan` / `access_type_sku` を欠く場合に、
  プラン名が `unknown` に丸められ、公開 API の判定と**矛盾する違反警告**が出ていた問題を修正。
  プラン情報の有無を区別し、無い場合は補足表示にとどめるようにした。
- `warnOnOrganizationless` が `organization_login_list` の**欠落**（不明）と
  **空配列**（シートなし）を区別せず、欠落時に誤って違反としていた問題を修正。
- `requireOrganization` を後から設定した場合に、既存の `read:user` のみのセッションが
  先に一致してしまい `read:org` を**永久に取得できず、所属確認が黙って無効化される**問題を修正。
  手動チェック時に明示的に権限を要求するようにした。
- GraphQL が `data` とあわせて `errors` を返す部分的失敗を握り潰し、
  「判定不能」ではなく**違反（モーダル警告）**として扱っていた問題を修正。
  エンドポイントを特定できない場合は判定不能（ステータスバー「不明」）とし、
  エラー内容をログに記録するようにした。
- `allowedPlans` に認識できない値（例: 大文字の `Business`）が入っていると、
  許可ティアが誤って `individual` に広がり**個人プランを見逃す**（フェイルオープン）問題を修正。
  既知のプラン名のみを対応付け、未知の値は無視してログに記録するようにした。
- `requireOrganization` と `organization_login_list` の比較が大小文字を区別しており、
  内部 API が使える環境とそうでない環境で判定が食い違う問題を修正。
- 出力チャネル初期化前に `log()` が呼ばれると例外になりうる箇所を修正。
- `read:org` 権限の要求時に、サインインフローで**別アカウント**が選択されても検証していなかった問題を修正。
  個人アカウントと会社アカウントを併用している環境で、以降のチェックが別アカウントを
  評価し続け「問題なし」を出し続ける恐れがあった。対策として:
  - 権限要求時に対象アカウントを固定し、返却されたアカウント ID も照合する。
  - セッション探索候補から `read:org` を含むものを除外し、昇格で作られた別アカウントの
    セッションが以降のチェックで先に拾われないようにした。
  - 昇格済みセッションは同一アカウントに固定して再利用し、毎回の同意要求を避ける。
  - 初回同意で作成するセッションのスコープを探索候補と一致させ、
    `requireOrganization` 設定時に「作ったセッションを次回以降見つけられない」状態を防止。
  - 評価対象アカウントが前回から変わった場合はログと補足に記録する。
- 公開 API でエンドポイントを取得できなかった場合に、内部 API が持つプラン情報が
  参照されず、v1.1.0 なら検知できた**個人プラン（Free だけでなく Pro / Max も）**の
  利用を見逃す状態になっていた問題を修正。
  縮退時も同じ `evaluate()` を通すようにし、判定ロジックの二重化をなくした。
  主判定もプラン情報も得られない場合は「問題なし」ではなく「不明」を表示する。

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
