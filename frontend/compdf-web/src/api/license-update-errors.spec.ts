import { describe, expect, it } from 'vitest';
import { licenseUpdateErrorKey } from './license-update-errors';
import en from '@/i18n/locales/en.json';
import zhcn from '@/i18n/locales/zh-cn.json';
import zhtw from '@/i18n/locales/zh-tw.json';
import ja from '@/i18n/locales/ja.json';
import ko from '@/i18n/locales/ko.json';
import th from '@/i18n/locales/th.json';
import es from '@/i18n/locales/es.json';

const xmlFormatError = 'PDF SDK cannot validate this XML key format. Use a PDF SDK compatible license or update the compdf-app engine; runtime license was not changed';

describe('license update error localization', () => {
  it.each([
    [xmlFormatError, 'error.sdkXmlUnsupported'],
    ['SDK rejected the uploaded license or license validation is unavailable', 'error.sdkRejected'],
    ['license.xml is not valid XML', 'error.invalidXml'],
    ['XML directives and DTDs are not allowed', 'error.invalidXml'],
    ['license.xml requires a nonempty key', 'error.invalidKey'],
    ['license.xml must contain 1 to 65536 bytes', 'invalidFile'],
    ['Select a license XML file (maximum 64 KiB) and confirm the restart.', 'invalidFile'],
    ['License validation interrupted; runtime license was not changed', 'error.validationInterrupted'],
    ['License update interrupted; restore the previous license before resuming work', 'error.recoveryRequired'],
    ['License operation lost its updater lock; manual recovery is required', 'error.recoveryRequired'],
    ['Active tasks did not drain within 60 seconds; license was not changed.', 'error.drainFailed'],
    ['Maintenance ownership changed; license was not changed.', 'error.ownershipChanged'],
    ['Server restarted before license replacement; license was not changed.', 'error.serverRestarted'],
    ['Another maintenance operation is active.', 'error.operationActive'],
    ['  no matching license recovery is available  ', 'error.noRecovery'],
    ['License operation status is unavailable; maintenance remains active.', 'error.statusUnavailable'],
    ['The host updater service is unavailable.', 'error.updaterUnavailable'],
    ['Could not persist license operation state; keep maintenance mode and recover the previous license', 'error.persistFailed'],
    ['Updater rejected license update.', 'error.updaterRejected'],
    ['Cannot safely read existing license', 'error.readFailed'],
    ['Cannot back up existing license', 'error.backupFailed'],
    ['New license did not complete verification; restoring previous license', 'error.restoring'],
    ['Previous license could not be restored and verified; keep maintenance mode and retry recovery', 'error.restoreFailed'],
    ['License update failed; previous license restored and verified', 'error.rolledBack'],
    ['exactly one running compdf-app is required', 'error.containerInvalid'],
    ['compdf-app needs read-only directory mount configs/app-license:/opt/compdf_sdk/license', 'error.mountInvalid'],
    ['license directory is missing or unsafe', 'error.directoryUnsafe'],
    ['remove conflicting license*.xml files from the managed directory first', 'error.conflictingFiles'],
  ])('maps %s to a translation key', (message, suffix) => {
    expect(licenseUpdateErrorKey(message)).toBe(`license.update.${suffix}`);
  });

  it('uses translated fallbacks without exposing raw diagnostics or claiming a rollback', () => {
    expect(licenseUpdateErrorKey()).toBe('license.update.requestFailed');
    expect(licenseUpdateErrorKey('  ')).toBe('license.update.requestFailed');
    for (const message of ['Unexpected internal error /private/path', 'constructor', '__proto__']) {
      expect(licenseUpdateErrorKey(message)).toBe('license.update.error.unknown');
    }
  });

  it.each(Object.entries({ en, 'zh-cn': zhcn, 'zh-tw': zhtw, ja, ko, th, es }))('provides every error translation in %s', (locale, messages) => {
    const keys = Object.keys(en).filter((key) => key.startsWith('license.update.error.')) as Extract<keyof typeof en, `license.update.error.${string}`>[];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(messages[key]?.trim(), key).toBeTruthy();
      if (locale !== 'en') expect(messages[key], key).not.toBe(en[key]);
    }
  });
});
