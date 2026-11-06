#!/usr/bin/env bash
# ============================================================
#  LiteMark View 一键编译（macOS / Linux / Windows Git Bash）
#  用法：./build.sh   （首次使用先 chmod +x build.sh）
#  Windows 产物 build/bin/LiteMarkView.exe，macOS 产物 build/bin/LiteMarkView.app
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "=========================================="
echo " LiteMark View 一键编译"
echo "=========================================="

for cmd in go node npm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "[错误] 未找到 $cmd，请先安装"; exit 1; }
done

GOOS_VAL=$(go env GOOS)
GOARCH_VAL=$(go env GOARCH)
GOPATH_VAL=$(go env GOPATH)
if command -v cygpath >/dev/null 2>&1; then
  GOPATH_VAL=$(cygpath -u "$GOPATH_VAL")
fi

echo "[1/5] 检查 Wails CLI ..."
WAILS_BIN="$GOPATH_VAL/bin/wails"
[ -x "$WAILS_BIN" ] || WAILS_BIN="${WAILS_BIN}.exe"
if [ ! -x "$WAILS_BIN" ]; then
  if command -v wails >/dev/null 2>&1; then
    WAILS_BIN=$(command -v wails)
  else
    # 版本跟随 go.mod，避免脚本里的版本号过时
    WAILS_VER=$(awk '/github.com\/wailsapp\/wails\/v2 v/{print $2; exit}' go.mod)
    WAILS_VER=${WAILS_VER:-v2.17.1}
    echo "      安装 wails@$WAILS_VER ..."
    go install "github.com/wailsapp/wails/v2/cmd/wails@$WAILS_VER"
    WAILS_BIN="$GOPATH_VAL/bin/wails"
    [ -x "$WAILS_BIN" ] || WAILS_BIN="${WAILS_BIN}.exe"
  fi
fi
echo "      Wails: $WAILS_BIN"

echo "[2/5] 检查前端依赖 ..."
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
fi

echo "[3/5] 重新构建前端 ..."
# 把旧 dist 移走而不是删除：既避开批量删除限制，也防止旧 hash 文件被打进包里
if [ -d frontend/dist ]; then
  OLD_DIST="${TMPDIR:-/tmp}/litemark-dist-$$-$(date +%s)"
  if mv frontend/dist "$OLD_DIST" 2>/dev/null; then
    echo "      旧 dist 已移到 $OLD_DIST"
  else
    echo "      [警告] 无法移走旧 dist，交给 Vite 自行清理"
  fi
fi
(cd frontend && npm run build)

echo "[4/5] 编译 $GOOS_VAL/$GOARCH_VAL ..."
# -s：前端上面已构建，跳过 Wails 内置的第二遍 Vite
case "$GOOS_VAL" in
  windows)
    TMP_OUT="LiteMarkView.new.exe"
    "$WAILS_BIN" build -s -platform "$GOOS_VAL/$GOARCH_VAL" -o "$TMP_OUT"
    ;;
  darwin)
    if [ "$GOARCH_VAL" != "arm64" ]; then
      echo "      [提示] 本项目 mac 版仅按 Apple Silicon 验证，当前架构为 $GOARCH_VAL"
    fi
    "$WAILS_BIN" build -s -platform "$GOOS_VAL/$GOARCH_VAL" -o LiteMarkView
    ;;
  *)
    "$WAILS_BIN" build -s -platform "$GOOS_VAL/$GOARCH_VAL" -o LiteMarkView
    ;;
esac

echo "[5/5] 整理产物 ..."
if [ "$GOOS_VAL" = "windows" ]; then
  # 旧 exe 正在运行时 Windows 会锁文件，不强杀用户进程，保留新文件即可
  if mv -f "build/bin/$TMP_OUT" build/bin/LiteMarkView.exe 2>/dev/null; then
    echo "      完成: $PWD/build/bin/LiteMarkView.exe"
  else
    echo "      [警告] LiteMarkView.exe 正被占用，关掉运行中的程序后可手动替换"
    echo "             新版本保留在: $PWD/build/bin/$TMP_OUT"
  fi
else
  echo "      完成: $PWD/build/bin/LiteMarkView.app"
fi
grep productVersion wails.json
echo "全部完成。"
