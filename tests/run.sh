#!/usr/bin/env bash
#
# Runs every test suite. No framework and no dependencies: each file is a plain
# Node script that prints "N passed, M failed" and exits non-zero on failure.
#
#   ./tests/run.sh            all suites
#   ./tests/run.sh evo team   only suites whose name contains one of these
#
# These live in the repo rather than a scratch directory because they age out
# of /tmp — nine suites were silently lost that way, which is exactly the sort
# of thing a test suite exists to prevent.
set -uo pipefail
cd "$(dirname "$0")/.."

total=0; failed=0; suites=0
for f in tests/test_*.js tests/test_*.mjs; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    if [ $# -gt 0 ]; then
        match=0
        for pat in "$@"; do [[ "$name" == *"$pat"* ]] && match=1; done
        [ $match -eq 1 ] || continue
    fi

    out=$(node "$f" 2>&1); rc=$?
    line=$(echo "$out" | tail -1)
    suites=$((suites+1))
    if [[ "$line" == *passed* ]]; then
        p=$(echo "$line" | awk '{print $1}'); fl=$(echo "$line" | awk '{print $3}')
        total=$((total+p)); failed=$((failed+fl))
        printf '  %-26s %4s passed %3s failed\n' "$name" "$p" "$fl"
        [ "$fl" != "0" ] && echo "$out" | grep FAIL | sed 's/^/      /'
    elif [[ "$line" == *SKIPPED* ]]; then
        # A suite that could not run says so. Reporting this as success would
        # be worse than a failure: nothing ran, and it looked fine.
        printf '  %-26s %s\n' "$name" "SKIPPED — needs the Firestore emulator"
        echo "$out" | grep -E '^  SKIP |Run them' | sed 's/^/      /'
    else
        # A suite that reports no tally is a smoke script; its exit code decides.
        printf '  %-26s %s\n' "$name" "$([ $rc -eq 0 ] && echo 'ok (smoke)' || echo 'ERROR')"
        [ $rc -ne 0 ] && { failed=$((failed+1)); echo "$out" | tail -5 | sed 's/^/      /'; }
    fi
done

echo "  ────────────────────────────────────────────"
printf '  %d suites, %d passed, %d failed\n' "$suites" "$total" "$failed"
[ "$failed" -eq 0 ] || exit 1
