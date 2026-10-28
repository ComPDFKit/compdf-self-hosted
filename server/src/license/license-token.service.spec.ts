import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LicenseTokenService } from './license-token.service';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createService(xml?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'compdf-license-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'app-license'));
  writeFileSync(join(directory, 'license.jwt'), 'ignored');
  if (xml !== undefined) writeFileSync(join(directory, 'app-license', 'license.xml'), xml);
  return new LicenseTokenService({ get: () => join(directory, 'license.jwt') } as never);
}

describe('LicenseTokenService runtime XML display', () => {
  it('uses starttime and endtime to determine an expired license', () => {
    const service = createService('<license><starttime>2020-07-13</starttime><endtime>2020-08-13</endtime><key>secret</key></license>');

    expect(service.decodeForDisplay()).toMatchObject({
      startTime: '2020-07-13',
      endTime: '2020-08-13',
      status: 'expired',
      present: true,
    });
  });

  it('keeps the file present but inactive when XML dates are missing', () => {
    const service = createService('<license><key>secret</key></license>');

    expect(service.decodeForDisplay()).toMatchObject({ status: 'inactive', present: true });
    expect(service.decodeForDisplay().startTime).toBeUndefined();
    expect(service.decodeForDisplay().endTime).toBeUndefined();
  });

  it('reports no license when the runtime XML file is absent', () => {
    expect(createService().decodeForDisplay()).toEqual({ status: 'inactive', present: false });
  });
});
