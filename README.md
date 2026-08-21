# Copilot License Guard

GitHub Copilot が **意図した Copilot Business / Enterprise ライセンス**で動作しているかを VS Code 内で常時監視し、
意図せず **Copilot Free** 等に落ちている場合にモーダルダイアログで強力に警告する拡張機能です。

---

> ## ⚠️ 重要なお知らせ（必ずお読みください）
>
> ### プラン種別の判定は GitHub の**公開 API** で行います
>
> 本拡張は Business/Enterprise か個人プランかの判定に、GitHub が公開している
> GraphQL API のフィールド **`viewer.copilotEndpoints.api`** を使用します。
> これは GitHub が公開しているスキーマ
> ([schema.docs.graphql](https://docs.github.com/public/fpt/schema.docs.graphql)) に
> `@docsCategory(name: "copilot")` 付きで掲載された正式なフィールドで、
> **管理者権限は不要**です。
>
> ### 詳細情報の取得には非公式 API を併用します（任意・OFF 可能）
>
> プラン名（`free` / `individual_pro` / `business` 等）・SKU・シート提供元組織といった
> **詳細情報**は、公開 API では取得できません。これらは GitHub の内部エンドポイント
> `GET https://api.github.com/copilot_internal/user` から取得しています。
>
> - このエンドポイントは **GitHub から公式にドキュメント化・サポートされていません**。
>   予告なく仕様変更・廃止される可能性があります。
> - **廃止されても主判定は公開 API で継続します。** 違反時の説明が簡素になるだけです。
> - 非公開 API の利用が組織ポリシー上問題になる場合は、設定
>   **`copilotLicenseGuard.useInternalApi` を `false`** にしてください。
> - 本拡張は **GitHub, Inc. および Microsoft とは無関係**であり、これらによる承認・提供・
>   サポートを受けたものではありません。
>
> ### 公開 API のみでは判別できないこと
>
> - **Free / Pro / Pro+ / Max の区別**（いずれも `api.individual.githubcopilot.com` になります）
> - **Business と Enterprise の区別**（いずれも `api.business.githubcopilot.com` になります）
> - **どの組織が Copilot シートを提供しているか**
>
> 本拡張の主目的である「**法人シートで動いているか否か**」の判定には影響しません。
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
> 懸念がある場合は `copilotLicenseGuard.useInternalApi` を `false` にすれば、
> **公開 API のみで動作**します。

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

### 1. 主判定 — 公開 GraphQL API（常に実行）

VS Code が保持する GitHub セッションのトークンで、公開 GraphQL API を照会します。

```graphql
{ viewer { login copilotEndpoints { api } } }
```

返される `api` のホスト名からプラン種別を判定します（実測値）。

| `copilotEndpoints.api` | 判定 |
|---|---|
| `https://api.business.githubcopilot.com` | **法人**（Business / Enterprise） |
| `https://api.enterprise.githubcopilot.com` | **法人** |
| `https://api.individual.githubcopilot.com` | **個人**（Free / Pro / Pro+ / Max）→ 既定では違反 |
| `https://api.githubcopilot.com`（旧形式） | **個人** → 既定では違反 |
| 上記以外・取得失敗 | **不明** → 許可外に倒す（fail-safe） |

`*.githubcopilot.com` で終わらないホストは、サフィックス偽装を避けるため必ず「不明」になります。

### 2. 詳細判定 — 内部 API（`useInternalApi: true` のときのみ）

```
GET https://api.github.com/copilot_internal/user
```

| フィールド | 判定 |
|---|---|
| `copilot_plan` | `allowedPlans` に無ければ違反 |
| `access_type_sku` | `free_limited_copilot` = **Free 確定** |
| `limited_user_quotas` | non-null = Free のクォータ制限下 |
| `can_signup_for_limited` | `true` = 組織シート未割当 |
| `organization_login_list` | 空 = 組織経由で使っていない |

未知の SKU は `unknown` として**許可外（＝警告）に倒します**（fail-safe）。
このステップが失敗しても、1. の判定結果はそのまま有効です。

### 3. Organization の確認（`requireOrganization` 設定時のみ）

内部 API から `organization_login_list`（＝**シート提供元**）が取れていればそれで照合します。
取れない場合は公開 REST API で**所属だけ**を確認します。

```
GET https://api.github.com/user/memberships/orgs/{org}
```

| 応答 | 扱い |
|---|---|
| `200` + `state: active` | 所属を確認（ただし「その組織がシートを提供しているか」までは不明） |
| `200` + `state: pending` | 参加未完了 → 違反 |
| `404` | メンバーではない → 違反 |
| `403` など | **確認不能**（IP 許可リスト / SAML SSO 未認可）→ **違反にしません** |

> **Organization owner 権限は不要です。** これは「**自分自身の**メンバーシップ」を返す
> 自己参照 API で、必要なのは OAuth スコープ（一般メンバーが自分で付与できるもの）だけです。
> GitHub が返す受理スコープは実測で
> `admin:org, read:org, repo, user, write:org` であり、`admin:org` は要求されません。
>
> 対照的に、組織管理者向けの `GET /orgs/{org}/members/{username}/copilot`
> （シート割当状況を返す）は **`admin:org` が必須**で、一般開発者は自分の状態すら確認できません。
> 本拡張がこちらを使わないのはこのためです。

> 組織一覧の列挙（`GET /user/orgs` や GraphQL `viewer.organizations`）は使いません。
> IP 許可リストや SSO が有効な組織が一覧から欠落し、「メンバーではない」と
> **誤検知する**ことを実際に確認したためです。
> また上記スコープが無い場合は `404` の誤読を防ぐため確認をスキップし、
> 手動チェック（ステータスバーのクリック／コマンド実行）時にのみ権限を要求します。
> Organization login の比較は大小文字を区別しません。

---

## 設定

| 設定キー | 既定値 | 説明 |
|---|---|---|
| `copilotLicenseGuard.enabled` | `true` | 監視の有効/無効 |
| `copilotLicenseGuard.allowedPlans` | `["business","enterprise"]` | 許可するプラン |
| `copilotLicenseGuard.requireOrganization` | `""` | 必須の Organization login（空なら未チェック） |
| `copilotLicenseGuard.checkIntervalMinutes` | `30` | 再チェック間隔（分、最小 5） |
| `copilotLicenseGuard.modalWarning` | `true` | `false` にすると通知のみ（ブロックしない） |
| `copilotLicenseGuard.warnOnOrganizationless` | `true` | 組織が空の場合も警告する（内部 API 併用時のみ評価） |
| `copilotLicenseGuard.statusBar` | `true` | ステータスバー表示 |
| `copilotLicenseGuard.useInternalApi` | `true` | 詳細情報の取得に非公式 API を併用する。`false` でも主判定は動作 |

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
gh release download v1.2.0 --repo Kuro524/copilot-license-guard --pattern "*.vsix"
code --install-extension .\copilot-license-guard.vsix
```

> VSIX を手動配布した場合、**自動更新は行われません**。更新時は再度インストールしてください。

---

## 送信されるデータ / プライバシー

本拡張が外部に送信するのは、以下のリクエストのみです。いずれも宛先は `api.github.com` です。

| 宛先 | 実行条件 | 内容 | 目的 |
|---|---|---|---|
| `POST /graphql` | 常時 | GitHub セッショントークン（`Authorization` ヘッダ） | 自分の Copilot エンドポイント情報の取得 |
| `GET /copilot_internal/user` | `useInternalApi: true` のとき | 同上 | プラン名・SKU・シート提供元の取得 |
| `GET /user/memberships/orgs/{org}` | `requireOrganization` 設定時かつシート提供元が不明なとき | 同上 | 指定組織への所属確認 |

- **テレメトリ・解析サービスへの送信は一切行いません。**
- ソースコード・ファイル内容・プロンプト等を送信することはありません。
- トークンは `vscode.authentication` から都度取得し、**拡張側で保存しません**。
- 取得した情報は出力パネル（ローカル）にのみ記録されます。
- 要求する権限は `read:user` のみです（`requireOrganization` を設定した場合のみ `read:org` を追加要求）。

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
