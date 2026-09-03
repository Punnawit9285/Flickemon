#!/usr/bin/env bash
#
# Executes firestore.rules against the Firestore emulator.
#
# Every other suite asserts what the rules FILE SAYS; this one runs it. The
# rules are the only privacy boundary the project has, so they are worth
# executing rather than reading.
#
# Needs Java (the emulator is a JVM process) and the Firebase CLI:
#
#     brew install openjdk && npm install -g firebase-tools
#
set -uo pipefail
cd "$(dirname "$0")/.."

# macOS ships a /usr/bin/java STUB that exists, is executable, and does nothing
# but print "Unable to locate a Java Runtime". So the test has to be whether
# java RUNS, not whether it is on PATH — `command -v java` succeeds on a machine
# with no JVM at all, which is a memorable way to lose ten minutes.
has_java() { java -version >/dev/null 2>&1; }

# brew keeps openjdk keg-only, deliberately not symlinked into the prefix.
if ! has_java; then
    for p in "$(brew --prefix openjdk 2>/dev/null)/bin" \
             /opt/homebrew/opt/openjdk/bin /usr/local/opt/openjdk/bin; do
        [ -x "$p/java" ] && { export PATH="$p:$PATH"; break; }
    done
fi
has_java || {
    echo "  No Java runtime. The Firestore emulator is a JVM process:"
    echo "      brew install openjdk"
    exit 1
}

exec firebase emulators:exec --only firestore --project flickemon-rules-test \
    'node tests/test_rules.mjs'
