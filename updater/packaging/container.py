"""Bootstrap the real updater without requiring a Linux service on the host."""
import base64
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys

WORKSPACE = Path('/workspace')
PROTECTED = Path('/etc/compdf-updater')
SOCKET = '/run/compdf-updater/compdf-updater.sock'


def docker(*args, stdin=None):
    result = subprocess.run(['docker', *args], input=stdin, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # docker config/inspect/login output can contain credentials.
        raise ValueError('Docker command failed (' + args[0] + '); check Docker access and deployment configuration')
    return result.stdout


def host_path(source):
    """Docker Desktop accepts its Linux VM path when called by a Linux CLI."""
    if re.match(r'^[A-Za-z]:[\\/]', source):
        return '/run/desktop/mnt/host/' + source[0].lower() + '/' + source[3:].replace('\\', '/')
    if not source.startswith('/'):
        raise ValueError('The updater requires an absolute Docker bind source')
    return source.rstrip('/')


def protected_file(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(content)
    path.chmod(0o600)


def settings(env):
    names = ['COMPDF_UPDATE_BASE_URL', 'COMPDF_UPDATE_KEY_ID', 'COMPDF_UPDATE_PUBLIC_KEY']
    missing = [name for name in names if not env.get(name, '').strip()]
    if missing:
        raise ValueError('Fill these variables in .env, then run the startup command again: ' + ', '.join(missing))
    try:
        public_key = base64.b64decode(env['COMPDF_UPDATE_PUBLIC_KEY'].strip(), validate=True)
    except ValueError:
        raise ValueError('COMPDF_UPDATE_PUBLIC_KEY must be a Base64 Ed25519 PUBLIC key') from None
    if len(public_key) != 32:
        raise ValueError('COMPDF_UPDATE_PUBLIC_KEY must decode to 32 bytes; do not supply a private key')
    auto_download = env.get('COMPDF_UPDATE_AUTO_DOWNLOAD', 'false').lower()
    if auto_download not in ('true', 'false'):
        raise ValueError('COMPDF_UPDATE_AUTO_DOWNLOAD must be true or false')
    return {
        'schemaVersion': 1,
        'releaseBaseUrl': env['COMPDF_UPDATE_BASE_URL'].strip(),
        'channel': env.get('COMPDF_UPDATE_CHANNEL', 'stable'),
        'trustedKeys': {env['COMPDF_UPDATE_KEY_ID'].strip(): env['COMPDF_UPDATE_PUBLIC_KEY'].strip()},
        'serverBaseUrl': 'http://compdf-server:8080',
        'minimumFreeBytes': 5 * 1024 ** 3,
        'allowedServices': ['compdf-app', 'compdf-server'],
        'automation': {
            'checkIntervalMinutes': int(env.get('COMPDF_UPDATE_CHECK_INTERVAL_MINUTES', '0')),
            'jitterPercent': 20, 'maximumBackoffMinutes': 1440,
            'autoDownload': auto_download == 'true', 'retainReleases': 2,
        },
    }


def deployment_config(model, host_root, project):
    """Keep interpolation for signed image/version overrides during installation.

    This deployment snapshot contains the three managed services. The updater
    survives server replacement and its socket volume remains attached.
    """
    model['name'] = project
    model['services'].pop('compdf-updater', None)
    for service in model['services'].values():
        service.pop('build', None)
        for volume in service.get('volumes', []):
            if volume.get('type') == 'bind':
                source = volume['source']
                if source.startswith('./'):
                    volume['source'] = host_root + '/' + source[2:]
                elif not source.startswith('/'):
                    raise ValueError('Unsupported relative bind mount in deployment configuration')
    return model


def bootstrap():
    config = settings(os.environ)
    project = os.environ['COMPDF_COMPOSE_PROJECT']
    containers = docker('ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
                        '--filter', 'label=com.docker.compose.service=compdf-updater').split()
    if len(containers) != 1:
        raise ValueError('Cannot uniquely identify this project updater container')
    inspection = json.loads(docker('inspect', containers[0]))[0]
    mounts = [mount for mount in inspection['Mounts'] if mount['Destination'] == '/workspace']
    if len(mounts) != 1 or mounts[0]['Type'] != 'bind':
        raise ValueError('The updater requires the installation directory mounted at /workspace')
    root = host_path(mounts[0]['Source'])
    # Use identical absolute paths inside the updater and the Docker daemon.
    # This also makes downloaded migration bind mounts point at real host files.
    alias = Path(root)
    if alias != WORKSPACE:
        alias.parent.mkdir(parents=True, exist_ok=True)
        if not alias.exists():
            alias.symlink_to(WORKSPACE, target_is_directory=True)
        if not alias.samefile(WORKSPACE):
            raise ValueError('Installation path conflicts with an existing container directory')
    os.chdir(root)
    runtime = alias / 'tmp' / 'runtime-updater'
    runtime.mkdir(parents=True, exist_ok=True)
    state = alias / 'data' / 'updater'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ['COMPOSE_ENV_FILES'] = str(alias / '.env')
    model = json.loads(docker('compose', '--project-name', project,
                             '--env-file', str(alias / '.env'),
                             '-f', str(alias / 'docker-compose.yml'),
                             '-f', str(alias / 'docker-compose.updater-container.yml'),
                             'config', '--no-interpolate', '--no-path-resolution', '--format', 'json'))
    compose_file = runtime / 'docker-compose.json'
    protected_file(compose_file, json.dumps(deployment_config(model, root, project), indent=2) + '\n')
    config.update({
        'composeProject': project, 'workingDirectory': root, 'composeFile': str(compose_file),
        'stateDirectory': str(state), 'backupDirectory': str(state / 'backups'),
        'databasePasswordFile': str(PROTECTED / 'mysql-password'),
    })
    password = os.environ.get('COMPDF_UPDATE_MYSQL_PASSWORD', '')
    if not password or any(char in password for char in '\r\n\0'):
        raise ValueError('COMPDF_UPDATE_MYSQL_PASSWORD must be a nonempty single line')
    protected_file(PROTECTED / 'mysql-password', password + '\n')
    token = os.environ.get('COMPDF_UPDATE_BEARER_TOKEN', '')
    if token:
        protected_file(PROTECTED / 'release-token', token)
        config['releaseBearerTokenFile'] = str(PROTECTED / 'release-token')
    config_path = PROTECTED / 'config.json'
    protected_file(config_path, json.dumps(config, indent=2) + '\n')
    subprocess.run(['compdfctl', 'config', 'validate', '--file', str(config_path)], check=True)
    registry_user = os.environ.get('COMPDF_UPDATE_REGISTRY_USERNAME', '')
    registry_password = os.environ.get('COMPDF_UPDATE_REGISTRY_PASSWORD', '')
    if registry_user or registry_password:
        if not registry_user or not registry_password:
            raise ValueError('Set both COMPDF_UPDATE_REGISTRY_USERNAME and COMPDF_UPDATE_REGISTRY_PASSWORD')
        args = ['login', '--username', registry_user, '--password-stdin']
        if os.environ.get('COMPDF_UPDATE_REGISTRY'):
            args.append(os.environ['COMPDF_UPDATE_REGISTRY'])
        docker(*args, stdin=registry_password + '\n')
    print('Updater ready for Compose project ' + project + '; automatic installation is disabled', flush=True)
    os.execvp('compdf-updater', ['compdf-updater', '--config', str(config_path), '--socket', SOCKET])


def health():
    connection = http.client.HTTPConnection('localhost', timeout=3)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(3)
    connection.sock.connect(SOCKET)
    connection.request('GET', '/healthz')
    response = connection.getresponse()
    if response.status != 200 or json.loads(response.read()).get('status') != 'ok':
        raise ValueError('Updater health check failed')
    connection.close()


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['health']:
            health()
        elif not sys.argv[1:]:
            bootstrap()
        else:
            raise ValueError('Usage: container.py [health]')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Updater: ' + str(error), file=sys.stderr)
        sys.exit(1)
