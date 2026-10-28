> ## ⚠️ これは試験版（nightly / pre-release）です
>
> - 安定版をお使いの方は、このページではなく **[最新の安定版](https://github.com/Kuro524/copilot-license-guard/releases/latest)** をご利用ください。
> - 試験版に含まれる未リリースの変更は、安定版より検証が浅い可能性があります。問題があれば安定版へ戻してください。
> - 不具合に気づいたら [Issues](https://github.com/Kuro524/copilot-license-guard/issues) へお知らせください。
> - **安定版に戻すには**、安定版の VSIX を同じ手順でインストールし直します（上書きされます）。

## インストール方法（試験版）

### A. VS Code の画面から

1. このページ下部の **Assets** から `copilot-license-guard.vsix` をダウンロードします。
2. VS Code の **拡張機能** ビュー右上の **`…`** → **「VSIX からのインストール...」** でファイルを指定し、再読み込みします。

### B. コマンド 1 行で

```powershell
# Windows (PowerShell)
irm https://github.com/Kuro524/copilot-license-guard/releases/download/{{VERSION}}/copilot-license-guard.vsix -OutFile copilot-license-guard.vsix; code --install-extension copilot-license-guard.vsix --force
```

```bash
# macOS / Linux
curl -fL -o copilot-license-guard.vsix https://github.com/Kuro524/copilot-license-guard/releases/download/{{VERSION}}/copilot-license-guard.vsix && code --install-extension copilot-license-guard.vsix --force
```

### C. インストールスクリプト

```powershell
.\install.ps1 -Nightly            # 最新の試験版
.\install.ps1 -Version {{VERSION}}
```

```bash
bash install.sh --nightly
bash install.sh --version {{VERSION}}
```

機能と設定方法は [README](https://github.com/Kuro524/copilot-license-guard#readme) を参照してください。

---
