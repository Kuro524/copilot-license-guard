# プライバシーポリシー（送信データ・取り扱いの開示）

対象: **Copilot License Guard**（VS Code 拡張、拡張 ID `Kuro524.copilot-license-guard`）
最終更新: 2026-10-28（v1.4.0）

本拡張は、GitHub Copilot が意図したライセンス（Business / Enterprise）で動作しているかを
**利用者自身の GitHub アカウント情報だけ**を使って確認します。
組織内へ展開する前のセキュリティ・プライバシー審査に使えるよう、取り扱う情報をすべて記載します。

> v1.4.0 には **試験的機能（Experimental）** として、組織が明示的に設定した場合にのみ動作する 2 機能（管理者向けレポート送信・違反時のソフト遮断）があります。
> 既定では無効で、設定しない限り従来と同じ挙動です。該当箇所は「試験的機能」と明記しています。

---

## 要約

| 項目 | 既定 | 試験的機能を設定した場合に追加されるもの |
|---|---|---|
| 送信先 | `https://api.github.com` のみ（GitHub, Inc.） | **組織が `copilotLicenseGuard.report.url` に設定した URL**（組織の Slack / Teams / 関数 / SIEM 等。開発者には送られません） |
| 送信する情報 | GitHub セッションのアクセストークン（`Authorization` ヘッダー）と、拡張名・バージョン（`User-Agent`） | チェック結果の要約: アカウント名・プラン・違反コードと理由・必須 Organization との一致・拡張/VS Code のバージョン・端末情報（既定はコンピューター名とランダムな installId。OS ユーザー名は明示設定時のみ）。**トークンは含みません** |
| 取得する情報 | **自分自身の** GitHub ログイン名、Copilot API エンドポイント URL、（任意）プラン名・SKU・シート提供元組織名、（設定時）指定組織への所属状態 | 変更なし |
| テレメトリ・解析 | **一切送信しません**。開発者を含む第三者がデータを受け取ることはありません | 変更なし（レポートの宛先は利用者の組織であり、開発者ではありません） |
| ワークスペースのデータ | **ファイル・エディタ内容・プロンプト・Git 情報は一切読み取りません** | 変更なし。遮断機能は VS Code の設定値 `chat.disableAIFeatures` の実効値（ワークスペース設定で上書きされているか）を確認します |
| トークンの保存 | **保存しません**。毎回 `vscode.authentication` から取得し、メモリ上でのみ使用します | 変更なし |
| ローカル保存 | 同意要求済みフラグと、前回評価したアカウントの ID・表示名（アカウント切替の検知用） | 遮断の記録（状態・元の設定値・変更時刻）、送信の記録（installId・連番・最終送信状態）。遮断機能は**ユーザー設定** `chat.disableAIFeatures` と `settingsSync.ignoredSettings` を書き換えます |

---

## 1. 外部へのリクエスト

いずれも宛先は `api.github.com` で、**リクエストする主体は利用者自身**（利用者のトークン）です。
他人のデータにはアクセスしません。

| リクエスト | 実行条件 | 取得する内容 | 目的 |
|---|---|---|---|
| `POST /graphql`<br>`{ viewer { login copilotEndpoints { api } } }` | 常時（起動時・定期・アカウント切替時・手動） | 自分のログイン名、Copilot API エンドポイント URL | 法人（Business/Enterprise）か個人プランかの主判定 |
| `GET /copilot_internal/user` | 設定 `copilotLicenseGuard.useInternalApi` が `true`（既定）のとき | プラン名、SKU、シート提供元組織の login 一覧、Free 判定フラグ | 違反時の説明を詳しくするための補強情報。GitHub 非公式 API（詳細は README） |
| `GET /user/memberships/orgs/{org}` | 設定 `copilotLicenseGuard.requireOrganization` を指定し、かつシート提供元が取得できなかったとき | 指定組織への自分の所属状態（`active` / `pending` / 非メンバー） | 必須組織の所属確認 |

リクエストに含める情報は、アクセストークン（`Authorization`）、拡張名とバージョン（`User-Agent`、
非公式 API では VS Code のバージョンも `Editor-Version` として付与）のみです。
送信頻度は既定で約 30 分に 1 回（`checkIntervalMinutes`、最小 5 分）に加え、起動時・GitHub セッション変更時・手動実行時です。

---

## 2. 要求する権限（OAuth スコープ）

| スコープ | 要求タイミング | 用途 |
|---|---|---|
| `read:user` | 初回起動時に VS Code の同意ダイアログで 1 回 | 上記 GraphQL / 非公式 API の呼び出し |
| `read:org` | `requireOrganization` を設定している場合に、**手動チェック時のみ**追加で同意を要求 | 指定組織への所属確認 |

権限の付与・取り消しは VS Code のアカウントメニュー（左下のアカウントアイコン →
アカウント → 「信頼された拡張機能の管理」）からいつでも行えます。
Organization の管理者権限は不要です。

---

## 3. 保存するデータ

| 保存先 | 内容 | 補足 |
|---|---|---|
| VS Code の拡張用ストレージ（`globalState`、ローカル） | 同意ダイアログを表示済みかのフラグ／前回評価した GitHub アカウントの ID と表示名 | 意図しないアカウント切替を検知するため。Settings Sync の同期対象には含めていません |
| 同上（試験的機能・遮断を有効にした場合） | 遮断の記録: 状態、適用前の `chat.disableAIFeatures` の値、変更時刻、手動停止の期限 | 復元と往復防止のため |
| 同上（試験的機能・送信を有効にした場合） | 送信の記録: ランダムな `installId`、連番、最後に送信した状態、次回ハートビート時刻、429 の待機期限 | 重複送信の抑制のため |
| 出力パネル「Copilot License Guard」 | 判定結果・API 応答の要約・エラー（監査ログ） | トークンそのものは記録しません。VS Code の仕組み上、出力チャネルの内容はローカルのログフォルダーに一時的に保持されることがあります。レポートの送信先はホスト名のみ、ヘッダー値・本文は記録しません |

アクセストークンは**ディスクに保存しません**。チェック処理の間だけメモリ上で使用し、処理後は参照を保持しません。
環境変数やファイルへの書き出しは行いません。**試験的機能の遮断を有効にした場合のみ**、VS Code の**ユーザー設定**（`settings.json`）の
`chat.disableAIFeatures` と `settingsSync.ignoredSettings` を書き換えます（§5）。

---

## 4. 第三者への提供

既定: ありません。本拡張の開発者を含め、GitHub 以外のいかなる第三者にもデータは送信されません。
クラッシュレポート・利用統計・広告識別子なども収集しません。

試験的機能: 組織が `copilotLicenseGuard.report.url` を設定した場合に限り、**その組織の受け口**へ §5 の内容を送信します。
開発者（Kuro524）がデータを受け取ることはありません。

---

## 5. 試験的機能: 管理者向けレポート送信

設定 `copilotLicenseGuard.report.url`（ユーザー設定。Settings Sync の対象外で、ワークスペースやリモート設定からは変更不可）が空でない場合にのみ動作します。

| 項目 | 内容 |
|---|---|
| 宛先 | 設定された URL（`https://` のみ。`localhost` に限り `http://`）。リダイレクトには従いません |
| タイミング | 違反の検出・内容変化（同一内容は 24 時間ごと）、違反からの復帰、判定不能への遷移、遮断の適用/解除/上書き検知、監視の無効化、定期ハートビート（既定 24 時間 ±10%）、手動テスト |
| 送信する項目（schema 1） | `event` / `eventId`（送信ごとに一意）/ `dedupeKey`（同じ出来事なら同じ値。重複排除用）/ `seq` / `timestamp`、`status`、`account`（GitHub ログイン名）、`plan` / `tier` / `sku` / `source` / `apiEndpoint`、`violationCodes` / `violations`（違反コードから生成した定型文。画面表示用の文言に含まれる組織名・エンドポイント等の実データは含めません）、`requiredOrganization` / `requiredOrgMatch`（必須 Organization と一致したか。**組織名の一覧は送りません**）、`seatOrgsKnown`、`enforcementMode` / `enforcementActive`、`extension.version`、`vscode.version` / `vscode.remoteName`、`device`（下記）、遮断イベント時は `enforcement.{action,reason,at,deferred,active,overriddenBy}`（`reason` は定型文または失敗の分類のみで、エラーメッセージ全文やファイルパスは含めません）（復帰後に無効のまま残った拡張がある場合は**件数のみ** `disabledExtensionCount`。拡張の ID は送りません） |
| `device`（`report.deviceFields` で選択） | 既定: `hostname`（コンピューター名）と `installId`（本拡張が生成するランダムな UUID。VS Code の machineId やハードウェア識別子ではありません）。`osUser`（OS のログインユーザー名。実名を含むことがあります）は明示的に指定した場合のみ |
| 送らないもの | アクセストークン、ソースコード・ファイル内容・パス、プロンプト、所属 Organization の一覧、補足情報（`infos`） |
| 付与ヘッダー | `Content-Type: application/json`、`User-Agent: CopilotLicenseGuard/<version>`、および `report.headers` に設定された値（例: `Authorization`）。ヘッダーの値はログに出力しません |
| 形式 | `json`（上記そのまま）または `slack`（`{ "text": "..." }` の要約 1 件。利用者由来の文字列はエスケープ） |
| 性質 | 利用者自身の端末からの**自己申告**です。受け口で真正性を保証する仕組みはありません（`report.headers` の値は利用者にも読めます） |

送信が有効な端末では、利用者に「この端末の Copilot ライセンス状態が `<host>` へ送信されます」と **1 回だけ通知**し、本ドキュメントへのリンクを示します。

### 試験的機能: 違反時のソフト遮断

設定 `copilotLicenseGuard.enforcement` が `"disableAI"` の場合にのみ動作します。外部へ送信するデータはありませんが、
**利用者のユーザー設定を書き換える**ため記載します。

- 違反（明確な証拠があるもの）の間、VS Code の設定 `chat.disableAIFeatures` をユーザー設定で `true` にし、解消時に元の値へ戻します。
- 他端末への波及を防ぐため、`settingsSync.ignoredSettings` に `chat.disableAIFeatures` を追加します（自動では外しません）。
- 書き換える前に元の値を拡張用ストレージへ記録します。VS Code の仕組み上、ユーザー設定は Settings Sync で同期されることがあります。
- 適用時に読み込まれていた拡張機能の ID 一覧を拡張用ストレージ（ローカル）に一時記録し、復帰後に無効のまま残った拡張を利用者へ通知するために使います。
  この一覧は端末外へ送信しません（レポートには件数のみ）。通知後に削除します。

---

## 6. 非公式 API について

`GET https://api.github.com/copilot_internal/user` は GitHub が公式にドキュメント化していないエンドポイントです。
取得するのは利用者自身の Copilot 契約情報のみですが、組織ポリシー上問題になる場合は
設定 **`copilotLicenseGuard.useInternalApi` を `false`** にしてください。
公開 API のみで主判定は継続します（違反時の説明が簡素になるだけです）。

---

## 7. 変更

取り扱うデータや送信先に変更がある場合は、[CHANGELOG](./CHANGELOG.md) と本ファイルを更新します。

## 8. 連絡先

質問・懸念は GitHub Issues へ: <https://github.com/Kuro524/copilot-license-guard/issues>

---

本拡張は MIT ライセンスで「現状有姿」で提供され、GitHub, Inc. および Microsoft Corporation とは無関係です。
