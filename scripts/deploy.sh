#!/usr/bin/env bash
# Builds the Lambda bundles, deploys the SAM stack, and runs pending migrations.
#   scripts/deploy.sh CognitoDomainPrefix=<unique-prefix>
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm build
sam deploy --template-file infra/template.yaml --config-file samconfig.toml --config-dir infra \
  --parameter-overrides Stage=dev "$@"

STACK=personal-assistant-dev
FN=$(aws cloudformation describe-stacks --stack-name "$STACK" --region us-west-2 \
  --query "Stacks[0].Outputs[?OutputKey=='MigrateFunctionName'].OutputValue" --output text)
aws lambda invoke --function-name "$FN" --region us-west-2 /dev/stdout
echo
