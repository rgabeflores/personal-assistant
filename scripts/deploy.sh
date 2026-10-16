#!/usr/bin/env bash
# Builds the Lambda bundles, deploys the SAM stack, syncs model provider keys into Secrets Manager,
# and runs pending migrations.
#   scripts/deploy.sh CognitoDomainPrefix=<unique-prefix> [ModelConfig='<json>']
# Keys come from the shell environment (CI) or the root .env, e.g. ANTHROPIC_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."

STACK=personal-assistant-dev
REGION=us-west-2

pnpm build
sam deploy --template-file infra/template.yaml --config-file samconfig.toml --config-dir infra \
  --parameter-overrides Stage=dev "$@"

# A missing key is reported but does not stop the deploy; the Lambda picks a key up within
# 30 seconds of it being synced later (pnpm keys:sync).
pnpm keys:sync --stack "$STACK" --stage dev --region "$REGION" || echo "Warning: some model keys are missing (see above)."

FN=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='MigrateFunctionName'].OutputValue" --output text)
aws lambda invoke --function-name "$FN" --region "$REGION" /dev/stdout
echo
