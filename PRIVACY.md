# プライバシーポリシー（送信データ・取り扱いの開示）

対象: **Copilot License Guard**（VS Code 拡張、拡張 ID `Kuro524.copilot-license-guard`）
最終更新: 2026-10-28（v1.3.0）

本拡張は、GitHub Copilot が意図したライセンス（Business / Enterprise）で動作しているかを
**利用者自身の GitHub アカウント情報だけ**を使って確認します。
組織内へ展開する前のセキュリティ・プライバシー審査に使えるよう、取り扱う情報をすべて記載します。

---

## 要約

| 項目 | 内容 |
|---|---|
| 送信先 | `https://api.github.com` のみ（GitHub, Inc.） |
| 送信する情報 | VS Code が保持する GitHub セッションのアクセストークン（`Authorization` ヘッダー）と、拡張名・バージョン（`User-Agent`） |
| 取得する情報 | **自分自身の** GitHub ログイン名、Copilot API エンドポイント URL、（任意）プラン名・SKU・シート提供元組織名、（設定時）指定組織への所属状態 |
| テレメトリ・解析 | **一切送信しません**。開発者を含む第三者がデータを受け取ることはありません |
| ワークスペースのデータ | **一切読み取りません**（ファイル・エディタ内容・プロンプト・Git 情報など） |
| トークンの保存 | **保存しません**。毎回 `vscode.authentication` から取得し、メモリ上でのみ使用します |
| ローカル保存 | 同意要求済みフラグと、前回評価したアカウントの ID・表示名（アカウント切替の検知用）のみ |

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
| 出力パネル「Copilot License Guard」 | 判定結果・API 応答の要約・エラー（監査ログ） | トークンそのものは記録しません。VS Code の仕組み上、出力チャネルの内容はローカルのログフォルダーに一時的に保持されることがあります |

アクセストークンは**ディスクに保存しません**。チェック処理の間だけメモリ上で使用し、処理後は参照を保持しません。
ファイル・設定・環境変数などへの書き出しも行いません。

---

## 4. 第三者への提供

ありません。本拡張の開発者を含め、GitHub 以外のいかなる第三者にもデータは送信されません。
クラッシュレポート・利用統計・広告識別子なども収集しません。

---

## 5. 非公式 API について

`GET https://api.github.com/copilot_internal/user` は GitHub が公式にドキュメント化していないエンドポイントです。
取得するのは利用者自身の Copilot 契約情報のみですが、組織ポリシー上問題になる場合は
設定 **`copilotLicenseGuard.useInternalApi` を `false`** にしてください。
公開 API のみで主判定は継続します（違反時の説明が簡素になるだけです）。

---

## 6. 変更

取り扱うデータや送信先に変更がある場合は、[CHANGELOG](./CHANGELOG.md) と本ファイルを更新します。

## 7. 連絡先

質問・懸念は GitHub Issues へ: <https://github.com/Kuro524/copilot-license-guard/issues>

---

本拡張は MIT ライセンスで「現状有姿」で提供され、GitHub, Inc. および Microsoft Corporation とは無関係です。
