<#
.SYNOPSIS
    Copilot License Guard (VS Code 拡張) を GitHub Releases からダウンロードしてインストールします。

.DESCRIPTION
    1. GitHub Releases から VSIX (copilot-license-guard.vsix) をダウンロードします (既定: 最新版)。
    2. VS Code の `code` コマンドを探し、`code --install-extension` でインストールします。
    3. インストール結果を `code --list-extensions` で確認します。

    Windows PowerShell 5.1 / PowerShell 7 の両方で動作します。管理者権限は不要です。
    注意: `irm ... | iex` による直接実行には対応していません (ファイルに保存してから実行してください)。
    通信先は GitHub のみです (github.com / 配信先の *.githubusercontent.com / バージョン表示用の api.github.com)。

.PARAMETER Version
    インストールするバージョン (例: v1.3.0 または 1.3.0)。省略時は最新リリース。

.PARAMETER Insiders
    VS Code Insiders (code-insiders) にインストールします。

.PARAMETER CodePath
    `code` コマンド (Windows では code.cmd) のパスを明示します。PATH に無く自動検出もできない場合に使います。

.PARAMETER KeepVsix
    ダウンロードした VSIX ファイルを削除せずに残します (オフライン配布用に取っておく場合など)。

.EXAMPLE
    # スクリプトをダウンロードして実行 (最新版をインストール)
    irm https://raw.githubusercontent.com/Kuro524/copilot-license-guard/main/install.ps1 -OutFile install.ps1
    .\install.ps1

.EXAMPLE
    # バージョンを固定してインストール
    .\install.ps1 -Version v1.3.0

.EXAMPLE
    # VS Code Insiders にインストール
    .\install.ps1 -Insiders

.LINK
    https://github.com/Kuro524/copilot-license-guard#readme
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [switch]$Insiders,
    [string]$CodePath = '',
    [switch]$KeepVsix
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 では進捗バーの描画でダウンロードが極端に遅くなるため抑止する
$ProgressPreference = 'SilentlyContinue'

$Repo        = 'Kuro524/copilot-license-guard'
$AssetName   = 'copilot-license-guard.vsix'
$ExtensionId = 'Kuro524.copilot-license-guard'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

# ファイルとして実行された場合のみ終了コードを返す。
# 文字列として Invoke-Expression された場合に exit すると呼び出し元のシェルごと閉じてしまうため。
function Stop-Installer([int]$Code) {
    if ($PSCommandPath) { exit $Code }
}

# Windows PowerShell 5.1 は既定で TLS 1.2 を有効にしないことがある
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# ---------------------------------------------------------------------------
# 1) VS Code の code コマンドを探す
# ---------------------------------------------------------------------------
function Find-CodeCommand([bool]$UseInsiders, [string]$Explicit) {
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) {
            throw "指定された -CodePath が見つかりません: $Explicit"
        }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $name = if ($UseInsiders) { 'code-insiders' } else { 'code' }

    # PATH 上にあればそれを使う
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # PATH に無い場合は既定のインストール先を探す
    $candidates = @()
    $isWin = ($env:OS -eq 'Windows_NT')
    if ($isWin) {
        $dir = if ($UseInsiders) { 'Microsoft VS Code Insiders' } else { 'Microsoft VS Code' }
        $exe = "$name.cmd"
        $candidates += @(
            (Join-Path $env:LOCALAPPDATA "Programs\$dir\bin\$exe"),
            (Join-Path $env:ProgramFiles "$dir\bin\$exe"),
            (Join-Path ${env:ProgramFiles(x86)} "$dir\bin\$exe")
        )
    } else {
        $app = if ($UseInsiders) { 'Visual Studio Code - Insiders.app' } else { 'Visual Studio Code.app' }
        $candidates += @(
            "/Applications/$app/Contents/Resources/app/bin/$name",
            "$HOME/Applications/$app/Contents/Resources/app/bin/$name",
            "/usr/bin/$name", "/usr/local/bin/$name", "/snap/bin/$name",
            "/usr/share/$name/bin/$name", "/opt/visual-studio-code/bin/$name"
        )
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }

    $hint = if ($isWin) {
        "VS Code が未インストールか、`"PATH への追加`" を外してインストールされています。" +
        " VS Code のインストーラーを再実行して `"PATH への追加`" を有効にするか、" +
        " -CodePath で code.cmd のパス (例: `$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd) を指定してください。"
    } elseif ($IsMacOS) {
        "VS Code を起動し、コマンドパレット (Cmd+Shift+P) で `"Shell Command: Install 'code' command in PATH`" を実行するか、" +
        " -CodePath で code のパスを指定してください。"
    } else {
        "ディストリビューションのパッケージ (.deb / .rpm / snap) でインストールされた VS Code なら通常 PATH に含まれます。" +
        " -CodePath で code のパスを指定してください。"
    }
    throw "VS Code の '$name' コマンドが見つかりません。$hint"
}

# ---------------------------------------------------------------------------
# 2) VSIX をダウンロード
# ---------------------------------------------------------------------------
function Get-DownloadUrl([string]$Ver) {
    if ([string]::IsNullOrWhiteSpace($Ver)) {
        return "https://github.com/$Repo/releases/latest/download/$AssetName"
    }
    $tag = if ($Ver.StartsWith('v')) { $Ver } else { "v$Ver" }
    return "https://github.com/$Repo/releases/download/$tag/$AssetName"
}

function Get-LatestTag {
    # 表示用。失敗しても (プロキシ等で api.github.com に出られない環境) インストールは続行する
    try {
        $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing `
             -Headers @{ 'User-Agent' = 'copilot-license-guard-installer'; 'Accept' = 'application/vnd.github+json' }
        return $r.tag_name
    } catch {
        return $null
    }
}

# 作業フォルダー: 推測しにくい名前で毎回新規作成し、終了時に削除する (共有 /tmp での衝突・差し替え対策)
$workDir = Join-Path ([IO.Path]::GetTempPath()) ("copilot-license-guard-" + [guid]::NewGuid().ToString('N'))
$exitCode = 1
try {
    Write-Step "VS Code の確認"
    $code = Find-CodeCommand -UseInsiders:$Insiders.IsPresent -Explicit $CodePath
    Write-Ok "code コマンド: $code"

    Write-Step "VSIX のダウンロード"
    $url = Get-DownloadUrl $Version
    $label = $Version
    if (-not $label) { $label = Get-LatestTag }
    if (-not $label) { $label = 'latest' }
    Write-Ok "対象バージョン: $label"
    Write-Ok "URL: $url"

    New-Item -ItemType Directory -Path $workDir | Out-Null
    $vsix = Join-Path $workDir $AssetName
    Invoke-WebRequest -Uri $url -OutFile $vsix -UseBasicParsing -Headers @{ 'User-Agent' = 'copilot-license-guard-installer' }
    $size = (Get-Item -LiteralPath $vsix).Length
    if ($size -lt 10KB) {
        throw "ダウンロードしたファイルが小さすぎます ($size bytes)。URL またはバージョン指定を確認してください: $url"
    }
    Write-Ok ("ダウンロード完了 ({0:N0} bytes)" -f $size)

    Write-Step "インストール (`"$code`" --install-extension)"
    # --force: 同じ/古いバージョンが入っていても上書きする (更新にも使える)
    $out = & $code --install-extension $vsix --force 2>&1
    $out | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) {
        throw "code --install-extension が終了コード $LASTEXITCODE で失敗しました。"
    }

    Write-Step "インストール結果の確認"
    $installed = & $code --list-extensions --show-versions 2>$null |
        Where-Object { $_ -match ('^' + [regex]::Escape($ExtensionId) + '@') }
    if ($installed) {
        Write-Ok "インストール済み: $installed"
    } else {
        Write-Note "一覧に見つかりませんでした。VS Code を再起動してから拡張機能ビューで 'Copilot License Guard' を確認してください。"
    }

    if ($KeepVsix) {
        # 作業フォルダーは削除するので、カレントディレクトリにコピーして残す
        $kept = Join-Path (Get-Location).Path ("copilot-license-guard-{0}.vsix" -f ($label -replace '[^\w\.-]', '_'))
        Copy-Item -LiteralPath $vsix -Destination $kept -Force
        Write-Ok "VSIX を残しました: $kept"
    }

    Write-Host ""
    Write-Host "完了しました。次の手順:" -ForegroundColor Cyan
    Write-Host "  1. VS Code を再起動する (開いている場合はコマンドパレット > 'Developer: Reload Window')"
    Write-Host "  2. 初回のみ『Copilot License Guard が GitHub を使用してサインインしようとしています』と表示されるので『許可』を押す"
    Write-Host "  3. 右下のステータスバーに 'Copilot: business' (または enterprise) と表示されれば正常です"
    Write-Host "  組織の設定例や詳細: https://github.com/$Repo#readme"
    $exitCode = 0
}
catch {
    Write-Host ""
    Write-Host "エラー: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "手動でインストールする場合: https://github.com/$Repo/releases から $AssetName をダウンロードし、" -ForegroundColor Yellow
    Write-Host "VS Code の拡張機能ビュー右上の '...' > 'VSIX からのインストール...' で選択してください。" -ForegroundColor Yellow
    $exitCode = 1
}
finally {
    if (Test-Path -LiteralPath $workDir) {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Stop-Installer $exitCode
