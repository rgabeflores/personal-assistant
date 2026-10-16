// Copies model provider keys into Secrets Manager (model-providers.md §5). Run by scripts/deploy.sh
// after `sam deploy`, or on its own:
//   pnpm keys:sync [--stack personal-assistant-dev] [--stage dev] [--region us-west-2] [--dry-run]
//
// Which providers need a key comes from the deployed stack's ModelConfig parameter. Each key is read
// from the shell environment first (CI), then from the root .env. Values are never printed.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { apiKeyEnvName, loadModelConfig, routedProviders } from "@pa/models";
import { planKeySync } from "./key-sync-plan.js";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";

const { values: args } = parseArgs({
  options: {
    stack: { type: "string", default: "personal-assistant-dev" },
    stage: { type: "string", default: "dev" },
    region: { type: "string", default: "us-west-2" },
    "dry-run": { type: "boolean", default: false },
  },
});

const cfn = new CloudFormationClient({ region: args.region });
const sm = new SecretsManagerClient({ region: args.region });

const stack = (await cfn.send(new DescribeStacksCommand({ StackName: args.stack }))).Stacks?.[0];
const modelConfigParam = stack?.Parameters?.find((p) => p.ParameterKey === "ModelConfig")?.ParameterValue;
const config = loadModelConfig(modelConfigParam ?? "{}");

// Only the *_API_KEY names we need are taken from .env; its other settings are for local runs.
const dotenv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};

async function currentValue(name: string): Promise<{ exists: boolean; value: string | undefined }> {
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: name }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return { exists: false, value: undefined };
    throw err;
  }
  try {
    return { exists: true, value: (await sm.send(new GetSecretValueCommand({ SecretId: name }))).SecretString };
  } catch (err) {
    // Created by the template but never given a value.
    if (err instanceof ResourceNotFoundException) return { exists: true, value: undefined };
    throw err;
  }
}

let missing = 0;
for (const id of routedProviders(config)) {
  const provider = config.providers[id]!;
  if ((provider.auth ?? "key") === "none") {
    console.log(`${id.padEnd(12)} no key needed`);
    continue;
  }
  const envName = apiKeyEnvName(id, provider);
  const local = (process.env[envName] || dotenv[envName] || "").trim() || undefined;
  const name = `pa/${args.stage}/llm/${id}`;
  const current = await currentValue(name);

  const action = planKeySync(local, current);
  let outcome: string = action;
  if (action === "missing") {
    outcome = `MISSING: set ${envName} and rerun`;
    missing++;
  } else if (action === "keep") {
    outcome = `kept (no ${envName} locally)`;
  } else if (args["dry-run"] && (action === "create" || action === "update")) {
    outcome = `would ${action}`;
  } else if (action === "create") {
    await sm.send(new CreateSecretCommand({ Name: name, SecretString: local, Description: `${id} API key (model provider)` }));
    outcome = "created";
  } else if (action === "update") {
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: local }));
    outcome = "updated";
  }
  console.log(`${id.padEnd(12)} ${name.padEnd(28)} ${outcome}`);
}

if (missing) {
  console.warn(`\n${missing} provider key(s) missing. Turns routed to those providers fail until the key is synced.`);
  process.exitCode = 1;
}
