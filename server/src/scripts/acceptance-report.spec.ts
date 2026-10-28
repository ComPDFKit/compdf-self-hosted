import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

function deploymentPath(...parts: string[]): string {
  return join(process.cwd(), '..', 'tests', 'fixtures', 'deployment', ...parts);
}

function readJson(...parts: string[]): unknown {
  return JSON.parse(readFileSync(deploymentPath(...parts), 'utf8'));
}

describe('acceptance report contract', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(join(process.cwd(), '..', 'deployment', 'acceptance-report.schema.json'), 'utf8')));

  it('accepts a blocked report that honestly records missing runtime evidence', () => {
    expect(
      validate(readJson('acceptance-report.valid.json')),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it('rejects undeclared secret fields', () => {
    expect(
      validate(readJson('acceptance-report.invalid-secret.json')),
    ).toBe(false);
    expect(
      validate.errors?.some(
        (error) =>
          error.instancePath === '/environment' &&
          error.keyword === 'additionalProperties',
      ),
    ).toBe(true);
  });
});
