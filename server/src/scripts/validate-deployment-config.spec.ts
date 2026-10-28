import { join } from 'path';
import { dump, load } from 'js-yaml';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  DeploymentConfigValidationError,
  validateDeploymentConfigFile,
} from './validate-deployment-config';

const examples = (...parts: string[]) =>
  join(process.cwd(), '..', 'tests', 'fixtures', 'deployment', ...parts);

describe('deployment config schema', () => {
  it('accepts the complete v1 example', () => {
    expect(
      validateDeploymentConfigFile(examples('deployment-config.valid.yaml')),
    ).toMatchObject({
      valid: true,
      schemaVersion: 1,
    });
  });

  it.each([
    'deployment-config.invalid-plaintext-secret.yaml',
    'deployment-config.invalid-permissive-cors.yaml',
  ])('rejects unsafe example %s', (name) => {
    expect(() => validateDeploymentConfigFile(examples(name))).toThrow(
      DeploymentConfigValidationError,
    );
  });

  it('rejects unknown schema versions and fields', () => {
    const source = load(
      readFileSync(examples('deployment-config.valid.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    source.schemaVersion = 2;
    source.unreviewedOption = true;
    const directory = mkdtempSync(join(tmpdir(), 'compdf-deployment-config-'));
    const path = join(directory, 'invalid.yaml');
    writeFileSync(path, dump(source), 'utf8');

    expect(() => validateDeploymentConfigFile(path)).toThrow(
      DeploymentConfigValidationError,
    );
  });

  it('requires a maintenance window for automatic installation', () => {
    const source = load(
      readFileSync(examples('deployment-config.valid.yaml'), 'utf8'),
    ) as {
      updates: Record<string, unknown>;
    };
    source.updates.automaticInstall = true;
    const directory = mkdtempSync(join(tmpdir(), 'compdf-deployment-config-'));
    const path = join(directory, 'invalid.yaml');
    writeFileSync(path, dump(source), 'utf8');

    expect(() => validateDeploymentConfigFile(path)).toThrow(
      DeploymentConfigValidationError,
    );
  });

  it('rejects duplicate YAML keys', () => {
    const directory = mkdtempSync(join(tmpdir(), 'compdf-deployment-config-'));
    const path = join(directory, 'duplicate.yaml');
    writeFileSync(path, 'schemaVersion: 1\nschemaVersion: 1\n', 'utf8');

    expect(() => validateDeploymentConfigFile(path)).toThrow(
      'deployment config is not valid YAML',
    );
  });
});
