#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, process.argv[2] ?? '.env.example');
const releaseEnv = readEnvFile(envFile);
const releaseVersion = JSON.parse(readFileSync(resolve(root, 'release/version.json'), 'utf8'));
const imageVariables = [
  'COMPDF_INFRA_IMAGE',
  'COMPDF_APP_IMAGE',
  'COMPDF_SERVER_IMAGE',
  'COMPDF_SERVER_BUILD_IMAGE',
  'COMPDF_SERVER_DEV_IMAGE',
];
const variants = [
  {
    name: 'production',
    files: ['docker-compose.yml'],
    buildServices: [],
    portPolicy: 'production',
  },
  {
    name: 'production debug ports',
    files: ['docker-compose.yml', 'docker-compose.debug.yml'],
    buildServices: [],
    portPolicy: 'debug',
  },
  {
    name: 'production updater socket',
    files: ['docker-compose.yml', 'docker-compose.updater.yml'],
    buildServices: [],
    portPolicy: 'production',
    updaterSocket: true,
  },
  {
    name: 'local production build',
    files: ['docker-compose.yml', 'docker-compose.build.yml'],
    buildServices: ['compdf-server'],
    portPolicy: 'production',
  },
  {
    name: 'published container updater',
    files: ['docker-compose.yml', 'docker-compose.updater-container.yml'],
    buildServices: [],
    portPolicy: 'production',
    containerUpdater: true,
  },
  {
    name: 'full stack with container updater',
    files: ['docker-compose.full.yml'],
    buildServices: ['compdf-server', 'compdf-updater'],
    portPolicy: 'production',
    containerUpdater: true,
  },
  {
    name: 'development',
    files: ['docker-compose.dev.yml'],
    buildServices: ['compdf-server'],
    portPolicy: 'development',
  },
];

let failed = false;

try {
  validateReleaseEnvironment(releaseEnv, releaseVersion);
} catch (error) {
  failed = true;
  console.error(`[compose-check] release environment: ${error.message}`);
}

for (const variant of variants) {
  try {
    const config = loadComposeConfig(variant.files);
    validateVariant(variant, config);
    console.log(`[compose-check] ${variant.name}: ok`);
  } catch (error) {
    failed = true;
    console.error(`[compose-check] ${variant.name}: ${error.message}`);
  }
}

process.exitCode = failed ? 1 : 0;

function readEnvFile(path) {
  const values = new Map();
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function validateReleaseEnvironment(values, version) {
  for (const name of ['COMPDF_VERSION', 'COMPDF_DB_SCHEMA_VERSION']) {
    const value = releaseValue(values, name);
    if (!value || !/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(`${name} must be an explicit semantic version`);
    }
  }

  for (const name of imageVariables) {
    const value = releaseValue(values, name);
    if (!value) throw new Error(`${name} must not be empty`);
    validateImage(name, value);
  }

  const expectedValues = new Map([
    ['COMPDF_VERSION', version.productVersion],
    ['COMPDF_DB_SCHEMA_VERSION', version.databaseSchemaVersion],
  ]);
  for (const [name, expected] of expectedValues) {
    if (releaseValue(values, name) !== expected) {
      throw new Error(`${name} does not match release/version.json`);
    }
  }

  const componentImages = new Map([
    ['COMPDF_INFRA_IMAGE', version.components?.infra],
    ['COMPDF_APP_IMAGE', version.components?.app],
    ['COMPDF_SERVER_IMAGE', version.components?.server],
  ]);
  for (const [name, expectedVersion] of componentImages) {
    if (imageTag(releaseValue(values, name)) !== expectedVersion) {
      throw new Error(`${name} does not match release/version.json`);
    }
  }
}

function releaseValue(values, name) {
  return Object.hasOwn(process.env, name) ? process.env[name].trim() : values.get(name);
}

function loadComposeConfig(files) {
  const args = ['compose', '--env-file', envFile];
  for (const file of files) args.push('-f', file);
  args.push('config', '--format', 'json');

  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot run Docker Compose: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Docker Compose exited with ${result.status}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Docker Compose returned invalid JSON: ${error.message}`);
  }
}

function validateVariant(variant, config) {
  const services = config.services ?? {};
  const actualBuildServices = Object.entries(services)
    .filter(([, service]) => service.build)
    .map(([name]) => name)
    .sort();
  const expectedBuildServices = [...variant.buildServices].sort();
  if (actualBuildServices.join(',') !== expectedBuildServices.join(',')) {
    throw new Error(
      `expected build services [${expectedBuildServices}], got [${actualBuildServices}]`,
    );
  }

  for (const [name, service] of Object.entries(services)) validateImage(name, service.image);

  const published = Object.entries(services).flatMap(([serviceName, service]) =>
    (service.ports ?? []).map((port) => ({ serviceName, target: Number(port.target), hostIP: port.host_ip ?? '' })),
  );
  const internalAppPorts = published.filter(({ serviceName, target }) =>
    serviceName === 'compdf-app' && [7000, 7001, 9903].includes(target),
  );
  if (variant.portPolicy === 'production' && internalAppPorts.length > 0) {
    throw new Error('production publishes internal compdf-app ports');
  }
  if (variant.portPolicy === 'debug') {
    const targets = internalAppPorts.map(({ target }) => target).sort().join(',');
    if (targets !== '7000,7001,9903' || internalAppPorts.some(({ hostIP }) => hostIP !== '127.0.0.1')) {
      throw new Error('debug ports must publish 7000/7001/9903 on 127.0.0.1 only');
    }
  }

  const serverEnv = services['compdf-server']?.environment ?? {};
  if (variant.containerUpdater) {
    const updater = services['compdf-updater'];
    const volumes = updater?.volumes ?? [];
    if (!volumes.some((volume) => volume.source === '/var/run/docker.sock' && volume.target === '/var/run/docker.sock')) {
      throw new Error('container updater must have Docker access');
    }
    if ((services['compdf-server']?.volumes ?? []).some((volume) => volume.source === '/var/run/docker.sock')) {
      throw new Error('Server must not have Docker access');
    }
    const serverSocket = (services['compdf-server']?.volumes ?? []).find((volume) => volume.target === '/run/compdf-updater');
    if (!serverSocket?.read_only || !volumes.some((volume) => volume.source === serverSocket.source && volume.target === serverSocket.target)) {
      throw new Error('Server and updater must share the socket volume');
    }
    if (updater.ports?.length || updater.network_mode) {
      throw new Error('Updater must use the private network without publishing ports');
    }
    if (updater.environment.COMPDF_COMPOSE_PROJECT !== config.name) {
      throw new Error('Updater must use the actual Compose project name');
    }
  }
  for (const name of ['COMPDF_VERSION', 'COMPDF_DB_SCHEMA_VERSION']) {
    if (serverEnv[name] !== releaseValue(releaseEnv, name)) {
      throw new Error(`compdf-server ${name} does not match the release environment`);
    }
  }
  if (variant.updaterSocket) {
    if (serverEnv.COMPDF_UPDATER_SOCKET !== '/run/compdf-updater/compdf-updater.sock') {
      throw new Error('updater overlay must configure the fixed Unix socket path');
    }
    const sources = (services['compdf-server']?.volumes ?? []).map((volume) =>
      typeof volume === 'string' ? volume.split(':', 1)[0] : volume.source,
    );
    if (!sources.includes('/run/compdf-updater/compdf-updater.sock')) {
      throw new Error('updater overlay must mount the fixed updater socket');
    }
    if (sources.some((source) => String(source).includes('docker.sock'))) {
      throw new Error('compdf-server must never receive the Docker socket');
    }
  }
}

function validateImage(name, image) {
  if (!image || !image.trim()) throw new Error(`${name} has an empty image reference`);

  const digestIndex = image.lastIndexOf('@');
  if (digestIndex >= 0) {
    if (!/^sha256:[0-9a-f]{64}$/i.test(image.slice(digestIndex + 1))) {
      throw new Error(`${name} has an invalid sha256 digest`);
    }
    return;
  }

  const lastSegment = image.slice(image.lastIndexOf('/') + 1);
  const tagIndex = lastSegment.lastIndexOf(':');
  if (tagIndex <= 0 || tagIndex === lastSegment.length - 1) {
    throw new Error(`${name} must use a fixed tag or sha256 digest`);
  }
  if (lastSegment.slice(tagIndex + 1).toLowerCase() === 'latest') {
    throw new Error(`${name} must not use the floating latest tag`);
  }
}

function imageTag(image) {
  const withoutDigest = image.split('@', 1)[0];
  const lastSegment = withoutDigest.slice(withoutDigest.lastIndexOf('/') + 1);
  const tagIndex = lastSegment.lastIndexOf(':');
  return tagIndex < 0 ? null : lastSegment.slice(tagIndex + 1);
}
