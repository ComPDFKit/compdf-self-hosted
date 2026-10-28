"""Publisher input checks using isolated synthetic digests and migration files."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = importlib.util.spec_from_file_location('prepare_release', Path(__file__).with_name('prepare-release.py'))
release = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(release)


class PrepareReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'release').mkdir()
        self.metadata = {
            'productVersion': '1.1.0', 'databaseSchemaVersion': '1.1.0',
            'components': {'app': '1.0.0', 'server': '1.1.0', 'updater': '1.1.0'},
            'releaseNotes': 'Synthetic test release',
        }
        self.write_metadata()
        self.env = {'RELEASE_VERSION': '1.1.0', 'APP_DIGEST': 'sha256:' + 'a' * 64,
                    'SERVER_DIGEST': 'sha256:' + 'b' * 64}

    def write_metadata(self):
        (self.root / 'release/version.json').write_text(json.dumps(self.metadata), encoding='utf-8')

    def test_initial_baseline_has_no_migration_and_keeps_component_identity(self):
        spec = release.prepare(self.root, self.env)
        self.assertEqual(spec['version'], '1.1.0')
        self.assertFalse(spec['migration']['required'])
        self.assertEqual(spec['images']['app']['tag'], '1.0.0')
        self.assertEqual(spec['images']['server']['digest'], self.env['SERVER_DIGEST'])

    def test_rejects_mismatch_and_placeholder_digest(self):
        for change in ({'RELEASE_VERSION': '1.2.0'}, {'APP_DIGEST': '<REAL_DIGEST>'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.prepare(self.root, {**self.env, **change})
        self.metadata['components']['server'] = '1.0.0'
        self.write_metadata()
        with self.assertRaises(ValueError):
            release.prepare(self.root, self.env)

    def test_schema_change_requires_exact_migration_artifact(self):
        env = {**self.env, 'DATABASE_SCHEMA_FROM': '1.0.0', 'MINIMUM_VERSION': '1.0.0'}
        with self.assertRaisesRegex(ValueError, 'Missing migration'):
            release.prepare(self.root, env)
        (self.root / 'migrations').mkdir()
        migration = self.root / 'migrations/1.0.0-to-1.1.0.sql'
        migration.write_text('SELECT 1;', encoding='utf-8')
        spec = release.prepare(self.root, env)
        self.assertTrue(spec['migration']['required'])
        self.assertEqual(spec['migration']['artifact']['source'], str(migration))

    def test_rejects_downgrade_invalid_schema_and_unsupported_minimum(self):
        for change in ({'DATABASE_SCHEMA_FROM': '2.0.0'}, {'DATABASE_SCHEMA_FROM': '../unsafe'},
                       {'MINIMUM_VERSION': '1.2.0'}, {'MINIMUM_VERSION': '01.0.0'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.prepare(self.root, {**self.env, **change})


if __name__ == '__main__':
    unittest.main()
