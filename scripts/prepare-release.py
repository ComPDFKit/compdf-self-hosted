"""Create publisher input from real image digests; never sign or publish by itself."""
import json
import os
from pathlib import Path
import re
from datetime import datetime, timedelta, timezone


def stable_version(value):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('Expected a stable MAJOR.MINOR.PATCH version: ' + value)
    return tuple(map(int, value.split('.')))


def prepare(root, env):
    metadata = json.loads((root / 'release/version.json').read_text(encoding='utf-8'))
    version = metadata['productVersion']
    stable_version(version)
    if env['RELEASE_VERSION'] != version or metadata['components']['server'] != version:
        raise ValueError('Release tag must match release/version.json')
    for value in metadata['components'].values():
        stable_version(value)
    minimum = env.get('MINIMUM_VERSION', '1.1.0')
    if stable_version(minimum) > stable_version(version):
        raise ValueError('Minimum supported version exceeds the release version')
    images = {}
    for component in ('app', 'server'):
        digest = env[f'{component.upper()}_DIGEST']
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
            raise ValueError(f'{component} requires a real registry digest')
        images[component] = {
            'name': f'compdfkit/compdf-{component}',
            'tag': metadata['components'][component],
            'digest': digest,
        }
    schema_from = env.get('DATABASE_SCHEMA_FROM', metadata['databaseSchemaVersion'])
    schema_to = metadata['databaseSchemaVersion']
    if stable_version(schema_from) > stable_version(schema_to):
        raise ValueError('Database downgrade is not supported')
    migration = {'from': schema_from, 'to': schema_to, 'required': schema_from != schema_to}
    if migration['required']:
        filename = f'{schema_from}-to-{schema_to}.sql'
        source = root / 'migrations' / filename
        if not source.is_file():
            raise ValueError(f'Missing migration: {filename}')
        migration['artifact'] = {'path': f'migrations/{filename}', 'source': str(source)}
    now = datetime.now(timezone.utc).replace(microsecond=0)
    timestamp = lambda value: value.isoformat().replace('+00:00', 'Z')
    return {
        'schemaVersion': 1, 'version': version, 'channel': 'stable', 'status': 'active',
        'minimumVersion': minimum,
        'minimumUpdaterVersion': metadata['components']['updater'],
        'releasedAt': timestamp(now), 'expiresAt': timestamp(now + timedelta(days=365)),
        'maintenanceRequired': True, 'infraUpgradeRequired': False,
        'images': images, 'migration': migration,
        'rollback': {'application': True, 'database': False, 'requiresBackupRestore': False},
        'releaseNotes': metadata['releaseNotes'], 'knownIssues': [],
    }


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    spec = prepare(root, os.environ)
    output = Path(os.environ['RELEASE_SPEC_PATH'])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(spec, indent=2) + '\n', encoding='utf-8')
    print('Prepared release input for ' + spec['version'])
