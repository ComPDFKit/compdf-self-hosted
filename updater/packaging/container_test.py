import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).with_name('container.py'))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class ContainerTests(unittest.TestCase):
    def test_docker_desktop_and_linux_paths(self):
        self.assertEqual(bootstrap.host_path(r'D:\work space\compdf'),
                         '/run/desktop/mnt/host/d/work space/compdf')
        self.assertEqual(bootstrap.host_path('/opt/compdf'), '/opt/compdf')
        with self.assertRaises(ValueError):
            bootstrap.host_path('relative/path')

    def test_missing_credentials_have_actionable_errors(self):
        with self.assertRaisesRegex(ValueError, 'COMPDF_UPDATE_BASE_URL.*COMPDF_UPDATE_KEY_ID.*COMPDF_UPDATE_PUBLIC_KEY'):
            bootstrap.settings({})

    def test_public_key_and_automation_validation(self):
        env = {'COMPDF_UPDATE_BASE_URL': 'https://updates.example.com/compdf/',
               'COMPDF_UPDATE_KEY_ID': 'test', 'COMPDF_UPDATE_PUBLIC_KEY': 'AA=='}
        with self.assertRaisesRegex(ValueError, '32 bytes'):
            bootstrap.settings(env)
        env['COMPDF_UPDATE_PUBLIC_KEY'] = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
        self.assertEqual(bootstrap.settings(env)['automation']['checkIntervalMinutes'], 0)
        self.assertFalse(bootstrap.settings(env)['automation']['autoDownload'])
        env['COMPDF_UPDATE_AUTO_DOWNLOAD'] = 'maybe'
        with self.assertRaisesRegex(ValueError, 'true or false'):
            bootstrap.settings(env)

    def test_deployment_preserves_target_images_socket_and_volumes(self):
        model = {
            'services': {
                'compdf-updater': {'environment': {'TOKEN': 'must-not-persist'}},
                'compdf-server': {
                    'image': '${COMPDF_SERVER_IMAGE:-example/server:1.0.0}',
                    'build': {'context': '.'},
                    'volumes': [
                        {'type': 'bind', 'source': './data/server-storage', 'target': '/app/storage'},
                        {'type': 'volume', 'source': 'compdf_updater_run', 'target': '/run/compdf-updater'},
                    ],
                },
            },
            'volumes': {'compdf_updater_run': {'name': 'original_compdf_updater_run'}},
        }
        rendered = bootstrap.deployment_config(copy.deepcopy(model), '/opt/compdf', 'original')
        self.assertNotIn('compdf-updater', rendered['services'])
        server = rendered['services']['compdf-server']
        self.assertNotIn('build', server)
        self.assertEqual(server['image'], model['services']['compdf-server']['image'])
        self.assertEqual(server['volumes'][0]['source'], '/opt/compdf/data/server-storage')
        self.assertEqual(rendered['volumes'], model['volumes'])
        self.assertEqual(server['volumes'][1]['source'], 'compdf_updater_run')


if __name__ == '__main__':
    unittest.main()
