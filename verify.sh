#!/usr/bin/env bash
#
# verify.sh — runs the same quality-gate checks as .github/workflows/ci.yml
# for backend/, frontend/, and desktop/, in sequence. Exits non-zero on the
# first failure; prints a pass/fail summary at the end either way.
#
# Usage:
#   ./verify.sh                 Run backend + frontend + desktop checks (matches ci.yml)
#   ./verify.sh --with-security Also run npm audit + the secret scanner
#                                (matches security.yml). Off by default because
#                                these can fail for reasons unrelated to the
#                                code itself (advisory database churn, or — as
#                                is the case today — a real leaked credential
#                                sitting in a gitignored local file that CI
#                                never sees). Run it explicitly to check.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WITH_SECURITY=0
[[ "${1:-}" == "--with-security" ]] && WITH_SECURITY=1

RESULTS=()
FAILED=0

# run <label> <working-dir> <command...>
run() {
  local label="$1"
  local dir="$2"
  shift 2

  echo ""
  echo "==> ${label} (${dir})"
  if (cd "${ROOT_DIR}/${dir}" && "$@"); then
    RESULTS+=("PASS  ${label}")
  else
    RESULTS+=("FAIL  ${label}")
    FAILED=1
  fi
}

echo "IDP — verify.sh: running quality-gate checks (mirrors .github/workflows/ci.yml)"
echo "Root: ${ROOT_DIR}"

# ---- Backend ----
run "backend: npm ci"        backend npm ci
run "backend: lint (syntax)" backend npm run lint
run "backend: test"          backend npm test

# ---- Frontend ----
run "frontend: npm ci"       frontend npm ci
run "frontend: typecheck"    frontend npm run typecheck
run "frontend: lint"         frontend npm run lint
run "frontend: build"        frontend npm run build

# ---- Desktop ----
# Packaging (`npm run build`) is NOT run here on purpose — same reasoning as
# the `desktop` job in .github/workflows/ci.yml: it's slow (Electron
# download + native rebuild) and produces an unsigned artifact this script
# has no reason to build on every check. `check:syntax` is the fast sanity
# gate; see docs/06-DAGITIM.md for how to run a real signed/packaged build.
run "desktop: npm ci"          desktop npm ci
run "desktop: check (syntax)"  desktop npm run check:syntax

# ---- Optional: security checks (mirrors .github/workflows/security.yml) ----
if [[ "${WITH_SECURITY}" -eq 1 ]]; then
  run "backend: npm audit (high)"  backend  npm audit --audit-level=high
  run "frontend: npm audit (high)" frontend npm audit --audit-level=high
  run "secret scan"                .        node backend/scripts/scan-secrets.js "${ROOT_DIR}"
else
  echo ""
  echo "==> Skipping security checks (run with --with-security to include npm audit + secret scan)"
fi

# ---- Summary ----
echo ""
echo "================ SUMMARY ================"
for line in "${RESULTS[@]}"; do
  echo "  ${line}"
done
echo "==========================================="

if [[ "${FAILED}" -ne 0 ]]; then
  echo "verify.sh: FAILED — see above."
  exit 1
fi

echo "verify.sh: all checks passed."
exit 0
