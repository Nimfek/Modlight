#!/bin/sh
set -e

# ── Size the runtime to the CGROUP, not to the host ──────────────────────────
#
# Node derives both of these from the machine it can see, and inside this
# container that machine is the whole VPS. Measured on production: `nproc`
# reports 6 against a `cpus: 2.0` quota, and V8 chose a 1120 MB old space inside
# a 2 GiB limit.
#
# The heap number is the dangerous one. Image decoding happens in libvips, whose
# buffers are NATIVE - they count against the cgroup but not against the V8 heap,
# so a heap that is free to grow to 1.1 GB plus half a gigabyte of pixels is a
# container that gets OOM-killed while V8 still believes it has room to spare.
# A quarter of the limit leaves the rest for native allocations and page cache.
#
# Both settings have to exist before the process starts - `--max-old-space-size`
# is read at V8 init and UV_THREADPOOL_SIZE when the pool is first used - which
# is why they are here and not in server.ts. libvips' own thread count IS set
# from JavaScript (lib/media/sharp-runtime.ts), because sharp exposes it.

cgroup_bytes() {
  for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    if [ -r "$f" ]; then
      v=$(cat "$f")
      case "$v" in
        max|"") ;;
        *) [ "$v" -gt 0 ] 2>/dev/null && echo "$v" && return ;;
      esac
    fi
  done
}

MEM_BYTES=$(cgroup_bytes || true)
if [ -n "$MEM_BYTES" ] && [ "$MEM_BYTES" -lt 68719476736 ]; then
  HEAP_MB=$((MEM_BYTES / 1048576 / 4))
  [ "$HEAP_MB" -lt 256 ] && HEAP_MB=256
  case "$NODE_OPTIONS" in
    *max-old-space-size*) ;;  # an explicit setting always wins
    *) NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$HEAP_MB" ;;
  esac
  export NODE_OPTIONS
  echo "→ memory limit ${MEM_BYTES} bytes; NODE_OPTIONS=${NODE_OPTIONS}"
fi

# The pool serves sharp, fs and dns alike. Four is Node's default and is right
# for two cores; pinning it stops a future host with more cores from quietly
# handing this container twelve threads it cannot schedule.
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-4}"

echo "→ Applying database migrations…"
node dist/migrate.js

echo "→ Starting Modlight…"
exec node dist/server.js
