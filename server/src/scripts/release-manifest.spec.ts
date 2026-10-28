import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function releasePath(...parts: string[]): string {
  return join(process.cwd(), '..', 'tests', 'fixtures', 'release', ...parts);
}

describe('release contracts', () => {
  it('accepts the valid manifest and rejects floating image tags', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(readJson(join(process.cwd(), '..', 'release', 'manifest.schema.json')));

    expect(validate(readJson(releasePath('release.valid.json'))), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(readJson(releasePath('release.invalid-floating-tag.json')))).toBe(false);
    expect(validate.errors?.some((error) => error.instancePath.endsWith('/tag'))).toBe(true);
  });

  it('keeps the product version aligned with the Server package', () => {
    const versions = readJson(join(process.cwd(), '..', 'release', 'version.json')) as { productVersion: string };
    const serverPackage = readJson(join(process.cwd(), 'package.json')) as { version: string };

    expect(versions.productVersion).toBe(serverPackage.version);
  });

  it('keeps both release schemas valid in strict mode', () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);

    expect(() => ajv.compile(readJson(join(process.cwd(), '..', 'release', 'manifest.schema.json')))).not.toThrow();
    expect(() => ajv.compile(readJson(join(process.cwd(), '..', 'release', 'signature.schema.json')))).not.toThrow();
  });
});
