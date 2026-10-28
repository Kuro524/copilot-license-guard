## インストール方法

### A. VS Code の画面から（推奨・コマンド不要）

1. このページ下部の **Assets** から `copilot-license-guard.vsix` をダウンロードします。
2. VS Code を開き、左の **拡張機能** ビュー（`Ctrl+Shift+X` / `Cmd+Shift+X`）右上の **`…`** メニュー → **「VSIX からのインストール...」** を選び、ダウンロードしたファイルを指定します。
3. 案内に従って VS Code を再読み込みします。初回のみ「**Copilot License Guard が GitHub を使用してサインインしようとしています**」と表示されるので **「許可」** を押してください。
4. 右下のステータスバーに `Copilot: business`（または `enterprise`）と出れば完了です。

### B. コマンド 1 行で

```powershell
# Windows (PowerShell)
irm https://github.com/Kuro524/copilot-license-guard/releases/download/{{VERSION}}/copilot-license-guard.vsix -OutFile copilot-license-guard.vsix; code --install-extension copilot-license-guard.vsix --force
```

```bash
# macOS / Linux
curl -fL -o copilot-license-guard.vsix https://github.com/Kuro524/copilot-license-guard/releases/download/{{VERSION}}/copilot-license-guard.vsix && code --install-extension copilot-license-guard.vsix --force
```

> 既にインストール済みの場合も同じ手順で上書き更新されます。
> VSIX 配布のため **自動更新はされません**。新しいバージョンが出たら再度実行してください。

詳しい手順・組織内への展開方法・設定項目は [README](https://github.com/Kuro524/copilot-license-guard#readme) を参照してください。

---
