#!/bin/bash
# 停止并移除 A 上的 clouddev-base SSH 隧道。
# 用法: client/tunnel/uninstall.sh [--purge]
#   --purge  连同 ~/.clouddev-tunnel（密钥、配置、B 的指纹）一起删除
set -u

# shellcheck source=common.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/common.sh"

if launchctl bootout "$TARGET" >/dev/null 2>&1; then
  echo "已停止隧道。"
else
  echo "隧道没有在运行。"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "已移除 ${PLIST}。"
fi

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$DIR"
  echo "已删除 ${DIR}（包括隧道密钥）。记得把 B 上 ~/.ssh/authorized_keys 里对应的那一行也删掉。"
else
  echo "保留了 ${DIR}（密钥、配置和 B 的指纹），重新安装时会沿用；加 --purge 可以一起删除。"
fi
