#!/usr/bin/env bash
#
# dsh-lan-bridge 0.1.2 — macOS 更新脚本
#
#   1. unzip -o dsh-lan-bridge-0.1.2-macos.zip -d ~/Downloads/lan-bridge
#   2. bash ~/Downloads/lan-bridge/install-macos.sh
#   3. 完全退出 DSH 再重新打开（不是刷新页面）
#
# 它只做三件事：备份旧版本 → 覆盖插件文件 → 校验。不会碰
# $DSH_HOME/lan-bridge/config.json（令牌、角色、端口都在那里）。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/dsh-lan-bridge"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$DSH_HOME/profiles/$PROFILE}"
DEST="$DSH_HOME/plugins/dsh-lan-bridge"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ -d "$SRC" ] || die "找不到 dsh-lan-bridge 目录，请在解压出来的文件夹里运行本脚本"
[ -d "$DSH_HOME" ] || die "找不到 $DSH_HOME，请确认 DSH 装过并至少启动过一次"

say "DSH_HOME     : $DSH_HOME"
say "profile 目录 : $PROFILE_DIR"
say "插件目录     : $DEST"
say ""

# 1. 备份旧版本
if [ -d "$DEST" ]; then
  BACKUP="$DEST.bak.$STAMP"
  cp -R "$DEST" "$BACKUP"
  say "已备份旧版本 → $BACKUP"
else
  say "没有旧版本，按全新安装处理"
fi

# 2. 覆盖文件
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
say "文件已更新到 0.1.2"

# 3. 校验
if command -v node >/dev/null 2>&1; then
  failed=0
  while IFS= read -r file; do
    if ! node --check "$file" >/dev/null 2>&1; then
      say "语法错误：$file"
      failed=1
    fi
  done < <(find "$DEST" -name '*.js' -not -path '*/node_modules/*')
  if [ "$failed" -eq 0 ]; then
    say "语法校验通过（node $(node -v 2>/dev/null | sed 's/^v//')）"
  fi
else
  say "没找到 node，跳过语法校验"
fi

# 4. 登记检查（只报告，不改你的 profile）
if [ -f "$PROFILE_DIR/package.json" ]; then
  if grep -q '"dsh-lan-bridge"' "$PROFILE_DIR/package.json"; then
    say "profile 已登记 dsh-lan-bridge，无需重新安装依赖"
  else
    say ""
    say "注意：$PROFILE_DIR/package.json 里没有 dsh-lan-bridge。"
    say "首次安装需要两步："
    say '  1) dependencies 里加 "dsh-lan-bridge": "link:'"$DEST"'"'
    say '  2) dsh.profile.bundles 里加 "dsh-lan-bridge"'
    say "  然后在 $PROFILE_DIR 执行 pnpm install --registry=https://registry.npmjs.org"
  fi
fi

say ""
say "完成。请完全退出 DSH（Command+Q）再重新打开，更新才会加载。"
say "启动后：在侧边栏打开局域网面板 → 设置 → 点「局域网自动发现」，或直接填主机地址 → 测试连接。"
