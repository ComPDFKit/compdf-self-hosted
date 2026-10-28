import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import Ajv2020, { ErrorObject } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { loadAll } from 'js-yaml';

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ValidationResult {
  valid: true;
  schemaVersion: number;
  path: string;
}

export class DeploymentConfigValidationError extends Error {
  constructor(
    message: string,
    readonly errors: ErrorObject[] = [],
  ) {
    super(message);
    this.name = 'DeploymentConfigValidationError';
  }
}

export function validateDeploymentConfigFile(
  path: string,
  schemaPath = defaultSchemaPath(),
): ValidationResult {
  const configPath = resolve(path);
  const bytes = readFileSync(configPath);
  if (bytes.length === 0 || bytes.length > MAX_CONFIG_BYTES) {
    throw new DeploymentConfigValidationError(
      'deployment config is empty or exceeds 1 MiB',
    );
  }

  const documents: unknown[] = [];
  try {
    loadAll(bytes.toString('utf8'), (document) => documents.push(document));
  } catch {
    throw new DeploymentConfigValidationError(
      'deployment config is not valid YAML',
    );
  }
  if (
    documents.length !== 1 ||
    documents[0] === null ||
    typeof documents[0] !== 'object'
  ) {
    throw new DeploymentConfigValidationError(
      'deployment config must contain exactly one object document',
    );
  }

  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(documents[0])) {
    const errors = validate.errors ?? [];
    throw new DeploymentConfigValidationError(formatErrors(errors), errors);
  }

  return {
    valid: true,
    schemaVersion: (documents[0] as { schemaVersion: number }).schemaVersion,
    path: configPath,
  };
}

function defaultSchemaPath(): string {
  const candidates = [
    join(process.cwd(), 'deployment', 'deployment-config.schema.json'),
    join(process.cwd(), '..', 'deployment', 'deployment-config.schema.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error('deployment config schema could not be located');
  return path;
}

function formatErrors(errors: ErrorObject[]): string {
  const summary = errors
    .map(
      (error) =>
        `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    )
    .join('; ');
  return `deployment config is invalid: ${summary}`;
}

function parseArgs(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--file' || !args[1]) {
    throw new DeploymentConfigValidationError(
      'usage: validate-deployment-config --file <deployment-config.yaml>',
    );
  }
  return args[1];
}

function main(): void {
  try {
    const result = validateDeploymentConfigFile(
      parseArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof DeploymentConfigValidationError ? 2 : 1;
  }
}

if (require.main === module) main();
