#!/usr/bin/env bash
set -euo pipefail

REPO="IoT-Billing-Service/IoT-Billing-Service"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  dev-to-staging    Create a PR to promote dev -> staging
  staging-to-main   Create a PR to promote staging -> main
  help              Show this help message

Examples:
  $(basename "$0") dev-to-staging
  $(basename "$0") staging-to-main
EOF
  exit 0
}

validate_branch_exists() {
  local branch="$1"
  if ! git ls-remote --exit-code --heads origin "$branch" > /dev/null 2>&1; then
    echo "Error: Remote branch '$branch' does not exist."
    exit 1
  fi
}

promote_dev_to_staging() {
  echo "Creating promotion PR: dev -> staging"

  validate_branch_exists "dev"
  validate_branch_exists "staging"

  git fetch origin dev staging

  PR_TITLE="[Promote] dev -> staging $(date +%Y-%m-%d)"
  PR_BODY="## Promotion: dev → staging

Automated promotion PR created via \`promote.sh\`.

### Checklist
- [ ] All CI checks pass on \`dev\`
- [ ] Feature freeze verified
- [ ] No regressions in staging-targeted tests

### Commits included:
\`\`\`
$(git log origin/staging..origin/dev --oneline)
\`\`\`"

  gh pr create \
    --repo "$REPO" \
    --base staging \
    --head dev \
    --title "$PR_TITLE" \
    --body "$PR_BODY" \
    --label "promotion,auto-generated"

  echo "PR created successfully for dev -> staging"
}

promote_staging_to_main() {
  echo "Creating promotion PR: staging -> main"

  validate_branch_exists "staging"
  validate_branch_exists "main"

  git fetch origin staging main

  PR_TITLE="[Promote] staging -> main $(date +%Y-%m-%d)"
  PR_BODY="## Promotion: staging → main (Production)

Automated promotion PR created via \`promote.sh\`.

⚠️ **This will deploy to production.** Only repository owners should merge this PR.

### Checklist
- [ ] All CI checks pass on \`staging\`
- [ ] QA sign-off complete
- [ ] Staging environment validated
- [ ] Rollback plan documented

### Commits included:
\`\`\`
$(git log origin/main..origin/staging --oneline)
\`\`\`"

  gh pr create \
    --repo "$REPO" \
    --base main \
    --head staging \
    --title "$PR_TITLE" \
    --body "$PR_BODY" \
    --label "promotion,production,auto-generated"

  echo "PR created successfully for staging -> main"
}

case "${1:-help}" in
  dev-to-staging)
    promote_dev_to_staging
    ;;
  staging-to-main)
    promote_staging_to_main
    ;;
  help|*)
    usage
    ;;
esac
