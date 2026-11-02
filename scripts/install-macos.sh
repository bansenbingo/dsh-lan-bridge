#!/usr/bin/env bash
#
# dsh-lan-bridge 0.2.1 — macOS 安装脚本
#
#   1. unzip -o dsh-lan-bridge-0.2.1-macos.zip -d ~/Downloads/lan-bridge
#   2. bash ~/Downloads/lan-bridge/install-macos.sh
#   3. 完全退出 DSH（Command+Q）再重新打开，不是刷新页面
#
# 它做四件事：备份旧版本 → 覆盖插件文件 → 注册 desktop profile → 校验语法。
# 不会碰 ~/.dsh/lan-bridge/config.json（空间密钥、节点 ID 都在那里）。
# 0.2.1 起不再把 uiWorkspace/sessions 写进客户端 inject，避免旧版 DSH 因缺少
# 服务在启动时崩溃；宿主工具也改为 ctx.get('tools') 的可选访问。
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
[ -f "$PROFILE_DIR/package.json" ] || die "找不到 profile：$PROFILE_DIR/package.json"

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
say "文件已更新到 0.2.1"

# 3. 注册 profile（依赖 + bundle + node_modules 链接）
register_with_node() {
  node - "$PROFILE_DIR/package.json" "$DEST" <<'NODE'
const fs = require('fs')
const file = process.argv[2]
const dest = process.argv[3]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-lan-bridge'] = 'link:' + dest
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
if (!pkg.dsh.profile.bundles.includes('dsh-lan-bridge')) {
  pkg.dsh.profile.bundles.push('dsh-lan-bridge')
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('profile 已注册 dsh-lan-bridge')
NODE
}

register_with_perl() {
  perl -MJSON::PP -e '
    my ($file, $dest) = @ARGV;
    open my $in, "<", $file or die "open: $!";
    local $/;
    my $pkg = decode_json(<$in>);
    close $in;
    $pkg->{dependencies} ||= {};
    $pkg->{dependencies}{"dsh-lan-bridge"} = "link:$dest";
    $pkg->{dsh} ||= {};
    $pkg->{dsh}{profile} ||= {};
    $pkg->{dsh}{profile}{bundles} ||= [];
    my $found = 0;
    for my $b (@{$pkg->{dsh}{profile}{bundles}}) { $found = 1 if $b eq "dsh-lan-bridge" }
    push @{$pkg->{dsh}{profile}{bundles}}, "dsh-lan-bridge" unless $found;
    open my $out, ">", $file or die "write: $!";
    print $out JSON::PP->new->pretty->encode($pkg);
    close $out;
  ' "$PROFILE_DIR/package.json" "$DEST"
  say "profile 已注册 dsh-lan-bridge（perl）"
}

cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak.$STAMP"
if command -v node >/dev/null 2>&1; then
  register_with_node
elif perl -MJSON::PP -e 1 >/dev/null 2>&1; then
  register_with_perl
else
  say "警告：没有 node 或 perl，无法自动改 profile。请手动在 $PROFILE_DIR/package.json 中加入："
  say '  "dependencies": { "dsh-lan-bridge": "link:'"$DEST"'" }'
  say '  并在 "dsh.profile.bundles" 中加入 "dsh-lan-bridge"'
fi

mkdir -p "$PROFILE_DIR/node_modules"
if [ -e "$PROFILE_DIR/node_modules/dsh-lan-bridge" ] && [ ! -L "$PROFILE_DIR/node_modules/dsh-lan-bridge" ]; then
  mv "$PROFILE_DIR/node_modules/dsh-lan-bridge" "$PROFILE_DIR/node_modules/dsh-lan-bridge.bak.$STAMP"
fi
ln -sfn "$DEST" "$PROFILE_DIR/node_modules/dsh-lan-bridge"
say "profile 链接已建立"

# 4. 校验
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

say ""
say "完成。请完全退出 DSH（Command+Q）再重新打开，更新才会加载。"
say "启动后：侧边栏「局域网」→ 概览 → 邀请设备，或设置 → 加入已有空间。"
