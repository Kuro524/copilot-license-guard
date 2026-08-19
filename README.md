# Copilot License Guard

GitHub Copilot が **意図した Copilot Business / Enterprise ライセンス**で動作しているかを VS Code 内で常時監視し、
意図せず **Copilot Free** 等に落ちている場合にモーダルダイアログで強力に警告する拡張機能です。

---

> ## ⚠️ 重要なお知らせ（必ずお読みください）
>
> ### 本拡張は GitHub の**非公開（非公式）API に依存**しています
>
> 本拡張はプラン判定に、GitHub の内部エンドポイント
> **`GET https://api.github.com/copilot_internal/user`** を使用しています。
>
> - このエンドポイントは **GitHub から公式にドキュメント化・サポートされていません**。
> - **予告なく仕様変更・廃止される可能性があります。** その場合、本拡張は
>   プランを判定できなくなり、ステータスバーは「不明」になります
>   （**判定不能を「問題なし」とは表示しません**が、監視は事実上停止します）。
> - GitHub が提供する**公式 API には、自分自身の Copilot プランを取得する手段が存在しません**
>   （2026-08 時点）。組織管理者向けの `GET /orgs/{org}/copilot/billing/seats` 等は
>   オーナー権限が必要で、個々の開発者が自分の VS Code 上の状態を確認する用途には使えません。
> - 本拡張は **GitHub, Inc. および Microsoft とは無関係**であり、これらによる承認・提供・
>   サポートを受けたものではありません。
>
> ### 免責
>
> 本拡張は MIT ライセンスに基づき **「現状有姿（AS IS）」** で提供されます。
> 判定結果の正確性・可用性はいかなる形でも保証されません。
> **ライセンスコンプライアンスの最終的な確認は、必ず組織の正規の管理画面
> （GitHub Organization の Copilot 設定・課金画面）で行ってください。**
> 本拡張はあくまで**事故の早期検知を補助するもの**であり、監査証跡の代替にはなりません。
>
> 業務環境へ広く展開する前に、非公開 API の利用について自組織のポリシー・
> GitHub との契約条件に照らして問題がないかご確認ください。

---

## なぜ必要か

GitHub 側には **「組織メンバーに Copilot Free の利用を禁止する」設定が存在しません**（2026-08 時点）。
組織シートが未割当・剥奪されたユーザーが個人の Free プランで Copilot を使うことを、
GitHub プラットフォーム側で技術的にブロックする手段はありません。

そのため **クライアント側での検知と警告が現実的な唯一の対処法**になります。

### 意図せず Free になる主な原因

| 原因 | 本拡張の検知方法 |
|---|---|
| VS Code が個人アカウントでサインインしている | VS Code のサインインアカウントと API 応答の不一致を検出 |
| 組織の Copilot シートが剥奪された | 次回トークン更新（約30分）で SKU が `free_limited_copilot` に変化するのを検出 |
| シート未割当のまま Free で使い始めた | `can_signup_for_limited=true` / `organization_login_list` が空 |
| 複数アカウントの取り違え（EMU と個人など） | アカウント切替イベントを捕捉して即再検査 |

---

## 初回セットアップ

インストール後の初回起動時に **「Copilot License Guard が GitHub を使用してサインインしようとしています」**
という同意ダイアログが 1 回だけ表示されます。**「許可 (Allow)」** を押してください。

これは拡張が VS Code の GitHub セッショントークンを読み取るために必要です
（`vscode.authentication.getSession` は `silent: true` では「既に許可済みの拡張」にしかセッションを返さないため）。
一度許可すれば以降は自動でサイレント取得されます。

許可し損ねた場合は、ステータスバーの `Copilot: 不明` をクリックするか、
コマンドパレットから `Copilot License Guard: 今すぐライセンスを確認` を実行すれば再度要求されます。

---

## 機能

- **起動時チェック** — VS Code 起動完了時に自動検査
- **定期チェック** — 既定 30 分間隔（Copilot トークンの更新周期に合わせる）
- **アカウント切替の即時検知** — `authentication.onDidChangeSessions` を購読し、
  サインイン/サインアウトの瞬間に再検査
- **モーダル警告** — 違反時は操作をブロックするダイアログを表示（対処手順つき）
- **ステータスバー表示** — 現在のプランを常時表示。違反時は赤背景
- **出力パネルの監査ログ** — `出力 > Copilot License Guard`

---

## 判定ロジック

VS Code が保持する GitHub セッションのトークンで、GitHub の内部 API を照会します。

```
GET https://api.github.com/copilot_internal/user
Authorization: token <VS Code の GitHub セッショントークン>
```

| フィールド | 判定 |
|---|---|
| `copilot_plan` | `business` / `enterprise` 以外は違反（既定） |
| `access_type_sku` | `free_limited_copilot` = **Free 確定** |
| `limited_user_quotas` | non-null = Free のクォータ制限下 |
| `can_signup_for_limited` | `true` = 組織シート未割当 |
| `organization_login_list` | 空 = 組織経由で使っていない |
| `endpoints.api` | 法人は `api.business.githubcopilot.com`。`api.githubcopilot.com` は個人/Free |

未知の SKU は `unknown` として**許可外（＝警告）に倒します**（fail-safe）。

> ⚠️ `/copilot_internal/user` は GitHub の**内部 API で公式サポート対象外**です。
> 仕様変更で動作しなくなる可能性があります。取得に失敗した場合はステータスバーが「不明」になります。

---

## 設定

| 設定キー | 既定値 | 説明 |
|---|---|---|
| `copilotLicenseGuard.enabled` | `true` | 監視の有効/無効 |
| `copilotLicenseGuard.allowedPlans` | `["business","enterprise"]` | 許可するプラン |
| `copilotLicenseGuard.requireOrganization` | `""` | 必須の Organization login（空なら未チェック） |
| `copilotLicenseGuard.checkIntervalMinutes` | `30` | 再チェック間隔（分、最小 5） |
| `copilotLicenseGuard.modalWarning` | `true` | `false` にすると通知のみ（ブロックしない） |
| `copilotLicenseGuard.warnOnOrganizationless` | `true` | 組織が空の場合も警告する |
| `copilotLicenseGuard.statusBar` | `true` | ステータスバー表示 |

設定例（`settings.json`）:

```json
{
  "copilotLicenseGuard.requireOrganization": "my-org",
  "copilotLicenseGuard.checkIntervalMinutes": 30
}
```

---

## コマンド

| コマンド | 説明 |
|---|---|
| `Copilot License Guard: 今すぐライセンスを確認` | 手動チェック（結果が OK でも通知） |
| `Copilot License Guard: ログを表示` | 出力パネルを開く |

ステータスバーの項目をクリックしても手動チェックが走ります。

---

## 違反を検出したときの対処

1. VS Code 左下のアカウントアイコン → 該当アカウントを**サインアウト**
2. 組織の GitHub アカウントで再サインイン
3. コマンドパレット → `Developer: Reload Window`
4. 再チェックして `business` になることを確認

シートが割り当てられていない場合は、組織の Copilot 管理者にシート割当を依頼してください。

---

## 組織管理者向け（併用推奨）

クライアント側の検知に加えて、組織側でシート割当状況を監視できます。

```bash
# シート一覧
gh api /orgs/<ORG>/copilot/billing/seats --paginate

# 特定ユーザーのシート状態
gh api /orgs/<ORG>/members/<USER>/copilot
```

Organization Settings > Copilot > Access を **`assign_selected`（明示的に割り当てた人のみ）**
にしておくとシート状況を把握しやすくなります。

---

## ビルド / インストール

```powershell
npm install
npm run compile
npx @vscode/vsce package
code --install-extension copilot-license-guard-<version>.vsix
```

### Release からインストール（VSIX 配布）

```powershell
gh release download v1.1.0 --repo Kuro524/copilot-license-guard --pattern "*.vsix"
code --install-extension .\copilot-license-guard.vsix
```

> VSIX を手動配布した場合、**自動更新は行われません**。更新時は再度インストールしてください。

---

## 送信されるデータ / プライバシー

本拡張が外部に送信するのは、以下の 1 リクエストのみです。

| 宛先 | 内容 | 目的 |
|---|---|---|
| `https://api.github.com/copilot_internal/user` | VS Code が保持する GitHub セッショントークン（`Authorization` ヘッダ） | 自分の Copilot プラン情報の取得 |

- **テレメトリ・解析サービスへの送信は一切行いません。**
- ソースコード・ファイル内容・プロンプト等を送信することはありません。
- トークンは `vscode.authentication` から都度取得し、**拡張側で保存しません**。
- 取得した情報は出力パネル（ローカル）にのみ記録されます。

---

## ライセンス

### 本拡張

**MIT License** — 全文は [LICENSE](./LICENSE) を参照してください。
Copyright (c) 2026 Kuro524

### 同梱物とサードパーティ

本拡張の VSIX に同梱されるのは、**自作の MIT ライセンスコードのみ**です。

- **実行時依存パッケージ（`dependencies`）は 0 件**です。サードパーティコードを再配布していません。
- ビルド時のみ使用する依存（`devDependencies`）は以下のとおりで、いずれも VSIX には含まれません。

| パッケージ | 用途 | ライセンス |
|---|---|---|
| `typescript` | TypeScript コンパイラ | Apache-2.0 |
| `@types/vscode` | VS Code API 型定義 | MIT |
| `@types/node` | Node.js 型定義 | MIT |

詳細は [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) を参照してください。

### 由来に関する明示

プラン判定に用いる SKU 文字列（`free_limited_copilot`、`copilot_for_business_seat` など）および
`copilot_plan` の取りうる値は、公開情報および MIT ライセンスで公開されている
[microsoft/vscode](https://github.com/microsoft/vscode) の**外部から観測可能な挙動を調査して特定した識別子**です。
**同リポジトリからソースコードを複製・翻案してはいません。** 判定ロジックはすべて本プロジェクトの独自実装です。

### 商標

**GitHub** および **GitHub Copilot** は GitHub, Inc. の、**Visual Studio Code** は Microsoft Corporation の
商標または登録商標です。本拡張はこれらの企業とは**無関係**であり、承認・提供・サポートを受けたものではありません。
拡張名・説明中のこれらの名称は、対象製品を識別する目的でのみ使用しています。

> 本拡張を Visual Studio Marketplace 等で一般公開する場合は、
> 公開者側で各社の商標ガイドラインおよび Marketplace の命名規約への適合をご確認ください。
