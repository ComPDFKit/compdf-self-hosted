// The updater also persists English errors in historical jobs. Translate those
// messages at display time so existing jobs follow the selected UI language.
const ERROR_KEYS: Readonly<Record<string, string>> = {
  "pdf sdk cannot validate this xml key format. use a pdf sdk compatible license or update the compdf-app engine; runtime license was not changed": 'license.update.error.sdkXmlUnsupported',
  "sdk rejected the uploaded license or license validation is unavailable": 'license.update.error.sdkRejected',
  "select a license xml file (maximum 64 kib) and confirm the restart": 'license.update.invalidFile',
  "license.xml must contain 1 to 65536 bytes": 'license.update.invalidFile',
  "license.xml is not valid xml": 'license.update.error.invalidXml',
  "xml directives and dtds are not allowed": 'license.update.error.invalidXml',
  "unexpected data outside xml root": 'license.update.error.invalidXml',
  "license.xml requires a nonempty key": 'license.update.error.invalidKey',
  "license.xml requires one root and one nonempty key": 'license.update.error.invalidKey',
  "license validation interrupted; runtime license was not changed": 'license.update.error.validationInterrupted',
  "license update interrupted; restore the previous license before resuming work": 'license.update.error.recoveryRequired',
  "license operation lost its updater lock; manual recovery is required": 'license.update.error.recoveryRequired',
  "application container changed; manual recovery required": 'license.update.error.recoveryRequired',
  "could not persist license operation state; keep maintenance mode and recover the previous license": 'license.update.error.persistFailed',
  "active tasks did not drain within 60 seconds; license was not changed": 'license.update.error.drainFailed',
  "task drain failed": 'license.update.error.drainFailed',
  "maintenance ownership changed; license was not changed": 'license.update.error.ownershipChanged',
  "server restarted before license replacement; license was not changed": 'license.update.error.serverRestarted',
  "another maintenance operation is active": 'license.update.error.operationActive',
  "a license operation is active or requires recovery": 'license.update.error.operationActive',
  "no matching license recovery is available": 'license.update.error.noRecovery',
  "license operation status is unavailable; maintenance remains active": 'license.update.error.statusUnavailable',
  "license updater unavailable": 'license.update.error.updaterUnavailable',
  "the host updater service is unavailable": 'license.update.error.updaterUnavailable',
  "updater rejected license update": 'license.update.error.updaterRejected',
  "cannot safely read existing license": 'license.update.error.readFailed',
  "unsafe license file": 'license.update.error.readFailed',
  "cannot back up existing license": 'license.update.error.backupFailed',
  "new license did not complete verification; restoring previous license": 'license.update.error.restoring',
  "previous license could not be restored and verified; keep maintenance mode and retry recovery": 'license.update.error.restoreFailed',
  "license update failed; previous license restored and verified": 'license.update.error.rolledBack',
  "exactly one running compdf-app is required": 'license.update.error.containerInvalid',
  "invalid container identity": 'license.update.error.containerInvalid',
  "cannot inspect application mounts": 'license.update.error.containerInvalid',
  "invalid application mounts": 'license.update.error.containerInvalid',
  "compdf-app needs read-only directory mount configs/app-license:/opt/compdf_sdk/license": 'license.update.error.mountInvalid',
  "license directory is missing or unsafe": 'license.update.error.directoryUnsafe',
  "remove conflicting license*.xml files from the managed directory first": 'license.update.error.conflictingFiles',
};

export function licenseUpdateErrorKey(message?: string): string {
  const normalized = message?.trim().toLowerCase().replace(/[.]+$/, '');
  if (!normalized) return 'license.update.requestFailed';
  return Object.hasOwn(ERROR_KEYS, normalized) ? ERROR_KEYS[normalized]! : 'license.update.error.unknown';
}
