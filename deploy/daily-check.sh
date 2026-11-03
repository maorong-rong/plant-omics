#!/usr/bin/env bash
# 每日巡检包装（CHECK-01）：跑 check.sh --quiet，结果追加到日志；有任何 FAIL 就非零退出。
#
# 为什么需要这么一层：cron 的单行命令不好写重定向与退出码处理，
# 而"异常时非零退出"要靠退出码——cron 会把非零写进 syslog/journal（Debian/Ubuntu 的 cron 记录 CRON ... cmd exited with status N）。
#
# 用法：/usr/local/sbin/plantomics-daily.sh       （由 /etc/cron.d/plantomics-check 调用）
# 环境变量：LOG（默认 /var/log/plantomics-check.log）、CHECK、MAX_BYTES
set -uo pipefail

LOG="${LOG:-/var/log/plantomics-check.log}"
CHECK="${CHECK:-/usr/local/sbin/plantomics-check.sh}"
MAX_BYTES="${MAX_BYTES:-1048576}"

[ -x "$CHECK" ] || { echo "找不到可执行的巡查脚本：$CHECK" >&2; exit 2; }

out="$("$CHECK" --quiet 2>&1)"
rc=$?

# 简易上限：超 1 MB 只留最近 500 行。正式的 logrotate 方案还没上，先用这个防止长期把盘写满。
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt "$MAX_BYTES" ]; then
  tail -n 500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

if [ "$rc" -eq 0 ]; then
  if [ -z "$out" ]; then
    printf '[%s] OK 全部通过\n' "$(date -Is)" >> "$LOG"
  else
    # --quiet 通过时仍可能带 ⚠（已知待办告警），单独缩进记，别和 OK 混在一行
    {
      printf '[%s] OK 全部通过\n' "$(date -Is)"
      printf '%s\n' "$out" | sed 's/^/    /'
    } >> "$LOG"
  fi
else
  {
    printf '\n[%s] FAIL rc=%s\n' "$(date -Is)" "$rc"
    printf '%s\n' "$out"
  } >> "$LOG"
fi

exit "$rc"
