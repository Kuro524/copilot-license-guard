#!/usr/bin/env bash
#
# Copilot License Guard (VS Code 拡張) を GitHub Releases からダウンロードしてインストールします。
#
#   1. GitHub Releases から VSIX (copilot-license-guard.vsix) をダウンロード (既定: 最新版)
#   2. VS Code の `code` コマンドを探して `code --install-extension` を実行
#   3. `code --list-extensions` でインストール結果を確認
#
# 使い方:
#   curl -fsSL https://raw.githubusercontent.com/Kuro524/copilot-license-guard/main/install.sh -o install.sh
#   bash install.sh                      # 最新版
#   bash install.sh --version v1.3.0     # バージョン固定
#   bash install.sh --nightly            # 最新の試験版 (pre-release)。追加機能は既定で無効
#   bash install.sh --insiders           # VS Code Insiders へ
#   bash install.sh --code /path/to/code # code コマンドのパスを明示
#
#   1 行で実行する場合 (内容を確認せずに実行することになるため、組織のポリシーに従ってください):
#   curl -fsSL https://raw.githubusercontent.com/Kuro524/copilot-license-guard/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version v1.3.0
#
# 管理者権限は不要です。通信先は GitHub のみです (github.com / 配信先の *.githubusercontent.com / バージョン表示用の api.github.com)。

set -euo pipefail

REPO="Kuro524/copilot-license-guard"
ASSET_NAME="copilot-license-guard.vsix"
EXTENSION_ID="Kuro524.copilot-license-guard"

VERSION=""
NIGHTLY=0
INSIDERS=0
CODE_PATH=""
KEEP_VSIX=0

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$1"; }
note() { printf '\033[33m    %s\033[0m\n' "$1"; }
fail() {
  printf '\n\033[31mエラー: %s\033[0m\n' "$1" >&2
  printf '\033[33m手動でインストールする場合: https://github.com/%s/releases から %s をダウンロードし、\n' "$REPO" "$ASSET_NAME" >&2
  printf 'VS Code の拡張機能ビュー右上の "..." > "VSIX からのインストール..." で選択してください。\033[0m\n' >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)  [ $# -ge 2 ] || fail "--version には値が必要です"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --nightly)  NIGHTLY=1; shift ;;
    --insiders) INSIDERS=1; shift ;;
    --code)     [ $# -ge 2 ] || fail "--code には値が必要です"; CODE_PATH="$2"; shift 2 ;;
    --code=*)   CODE_PATH="${1#*=}"; shift ;;
    --keep-vsix) KEEP_VSIX=1; shift ;;
    -h|--help)  sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "不明なオプション: $1" ;;
  esac
done

command -v curl >/dev/null 2>&1 || fail "curl が必要です。"

# ---------------------------------------------------------------------------
# 1) VS Code の code コマンドを探す
# ---------------------------------------------------------------------------
find_code() {
  if [ -n "$CODE_PATH" ]; then
    [ -x "$CODE_PATH" ] || fail "指定された --code が見つからないか実行できません: $CODE_PATH"
    printf '%s' "$CODE_PATH"; return
  fi

  local name="code" app="Visual Studio Code.app"
  if [ "$INSIDERS" -eq 1 ]; then name="code-insiders"; app="Visual Studio Code - Insiders.app"; fi

  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"; return
  fi

  local c
  for c in \
    "/Applications/$app/Contents/Resources/app/bin/$name" \
    "$HOME/Applications/$app/Contents/Resources/app/bin/$name" \
    "/usr/bin/$name" "/usr/local/bin/$name" "/snap/bin/$name" \
    "/usr/share/$name/bin/$name" "/opt/visual-studio-code/bin/$name" \
    "$HOME/.local/bin/$name"
  do
    if [ -x "$c" ]; then printf '%s' "$c"; return; fi
  done

  local hint
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    hint="VS Code を起動し、コマンドパレット (Cmd+Shift+P) で \"Shell Command: Install 'code' command in PATH\" を実行するか、--code でパスを指定してください。"
  else
    hint="ディストリビューションのパッケージ (.deb / .rpm / snap) でインストールされた VS Code なら通常 PATH に含まれます。--code でパスを指定してください。"
  fi
  fail "VS Code の '$name' コマンドが見つかりません。$hint"
}

# ---------------------------------------------------------------------------
# 2) VSIX をダウンロード
# ---------------------------------------------------------------------------
download_url() {
  if [ -z "$VERSION" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$ASSET_NAME"
  else
    local tag="$VERSION"
    case "$tag" in v*) ;; *) tag="v$tag" ;; esac
    printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$tag" "$ASSET_NAME"
  fi
}

latest_nightly_tag() {
  # 試験版は releases/latest に含まれないため、一覧から最新の pre-release を探す (api.github.com が必須)。
  # jq に依存せず、macOS (BSD grep/awk/sed) でも動く書き方にしている。
  curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: copilot-license-guard-installer' \
    "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null \
    | grep -oE '"(tag_name|draft|prerelease)"[[:space:]]*:[[:space:]]*("[^"]*"|true|false)' \
    | awk -F'"' '
        $2 == "tag_name"   { tag = $4; draft = 0; next }
        $2 == "draft"      { if ($0 ~ /true/) draft = 1; next }
        $2 == "prerelease" { if ($0 ~ /true/ && !draft && tag != "") { print tag; exit } }
      ' || true
}
latest_tag() {
  # 表示用。api.github.com に出られない環境では空を返し、インストールは続行する
  curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: copilot-license-guard-installer' \
    "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true
}

step "VS Code の確認"
CODE_CMD="$(find_code)"
ok "code コマンド: $CODE_CMD"

step "VSIX のダウンロード"
if [ "$NIGHTLY" -eq 1 ]; then
  [ -z "$VERSION" ] || fail "--nightly と --version は同時に指定できません。"
  VERSION="$(latest_nightly_tag)"
  [ -n "$VERSION" ] || fail "試験版 (pre-release) が見つかりません。--nightly を外して安定版をインストールしてください。"
  note "試験版 (nightly) を選択しました: $VERSION  ※追加機能は既定で無効です"
fi
URL="$(download_url)"
LABEL="$VERSION"
[ -n "$LABEL" ] || LABEL="$(latest_tag)"
[ -n "$LABEL" ] || LABEL="latest"
ok "対象バージョン: $LABEL"
ok "URL: $URL"

# 作業ディレクトリ: 推測しにくい名前で毎回新規作成し、終了時に必ず削除する (共有 /tmp での衝突・差し替え対策)
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/copilot-license-guard.XXXXXX")" || fail "一時ディレクトリを作成できません。"
trap 'rm -rf "$WORK_DIR"' EXIT
VSIX="$WORK_DIR/$ASSET_NAME"
curl -fsSL --retry 3 -H 'User-Agent: copilot-license-guard-installer' -o "$VSIX" "$URL" \
  || fail "ダウンロードに失敗しました。URL またはバージョン指定を確認してください: $URL"
SIZE=$(wc -c < "$VSIX" | tr -d ' ')
[ "$SIZE" -ge 10240 ] || fail "ダウンロードしたファイルが小さすぎます (${SIZE} bytes): $URL"
ok "ダウンロード完了 (${SIZE} bytes)"

step "インストール (\"$CODE_CMD\" --install-extension)"
# --force: 同じ/古いバージョンが入っていても上書きする (更新にも使える)
# code CLI (Node) が stderr に出す DeprecationWarning は利用者に意味が無いので除外する
"$CODE_CMD" --install-extension "$VSIX" --force 2>&1 | sed -E '/^\(node:[0-9]+\) |--trace-deprecation/d; s/^/    /' \
  || fail "code --install-extension が失敗しました。"

step "インストール結果の確認"
INSTALLED="$("$CODE_CMD" --list-extensions --show-versions 2>/dev/null | grep -i "^${EXTENSION_ID}@" || true)"
if [ -n "$INSTALLED" ]; then
  ok "インストール済み: $INSTALLED"
else
  note "一覧に見つかりませんでした。VS Code を再起動してから拡張機能ビューで 'Copilot License Guard' を確認してください。"
fi

if [ "$KEEP_VSIX" -eq 1 ]; then
  # 作業ディレクトリは削除されるので、カレントディレクトリにコピーして残す
  KEPT="$PWD/copilot-license-guard-$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '_').vsix"
  cp "$VSIX" "$KEPT"
  ok "VSIX を残しました: $KEPT"
fi

printf '\n\033[36m完了しました。次の手順:\033[0m\n'
printf '  1. VS Code を再起動する (開いている場合はコマンドパレット > "Developer: Reload Window")\n'
printf '  2. 初回のみ「Copilot License Guard が GitHub を使用してサインインしようとしています」と表示されるので「許可」を押す\n'
printf '  3. 右下のステータスバーに "Copilot: business" (または enterprise) と表示されれば正常です\n'
printf '  組織の設定例や詳細: https://github.com/%s#readme\n' "$REPO"
