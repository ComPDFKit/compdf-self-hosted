// Run: node --test deploy/apple-container/compdf-container.test.cjs
// Requires Bash and jq (BASH_BIN/JQ_BIN may select explicit executable paths).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bash = process.env.BASH_BIN || 'bash';
const shellPath = p => p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
const script = shellPath(path.join(__dirname, 'compdf-container.sh'));

// Simulated CLI process boundaries, with Apple's documented inspect JSON shape.
const mock = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2), scenario = process.env.SCENARIO;
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args)+'\n');
const out = x => console.log(JSON.stringify(x));
if(args[0]==='inspect') {
  const name=args[1];
  const existing=fs.existsSync(process.env.MOCK_LOG+'.'+name);
  if(!existing && scenario!=='exists') process.exit(1);
  out([{configuration:{id:name}, status:{state:'running',networks:[{network:'compdf-apple-net',ipv4Address:scenario==='bad-ip'?'invalid':(name.endsWith('infra')?'192.168.65.2/24':'192.168.65.3/24')}]}}]);
} else if(args[0]==='list') {
  out(['compdf-apple-server','unrelated-server'].map(id => ({configuration:{id,env:['SECRET-FIXTURE']},status:{state:'running',networks:[]}})));
} else if(args[0]==='image') {
  out([{variants:[{platform:{os:'linux',architecture:scenario==='wrong-arch'?'arm64':'amd64'}}]}]);
} else if((args[0]==='network'||args[0]==='volume') && args[1]==='inspect') {
  process.exit(scenario==='reuse'?0:1);
} else if(args[0]==='run') {
  fs.writeFileSync(process.env.MOCK_LOG+'.'+args[args.indexOf('--name')+1], 'created');
} else if(args[0]==='exec' && scenario==='unhealthy') process.exit(1);
`;

function exercise(t, action = 'up', scenario = '', changes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compdf-apple-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, 'config space');
  fs.mkdirSync(path.join(configDir, 'app-license'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fonts'));
  fs.mkdirSync(path.join(dir, 'storage'));
  fs.writeFileSync(path.join(configDir, 'settings.yml'), 'branding: {}\n');
  if (scenario !== 'xml-only') {
    fs.writeFileSync(path.join(configDir, 'license.jwt'), 'test-fixture-not-a-license');
  }
  if (scenario === 'xml-only') {
    fs.writeFileSync(path.join(configDir, 'app-license', 'license.xml'), '<license>test-fixture</license>');
  }
  const config = {
    CONFIG_DIR: shellPath(configDir), FONT_DIR: shellPath(path.join(dir, 'fonts')),
    STORAGE_DIR: shellPath(path.join(dir, 'storage')), COMPDF_LICENSE_KEY: 'SECRET-FIXTURE-DO-NOT-PRINT',
    HEALTH_ATTEMPTS: '1', ...changes,
  };
  if (scenario === 'xml-only') delete config.COMPDF_LICENSE_KEY;
  fs.writeFileSync(path.join(dir, '.env'), Object.entries(config).map(([k,v]) => `${k}=${v}`).join('\n'));
  fs.writeFileSync(path.join(dir, 'mock.cjs'), mock);
  const result = spawnSync(bash, ['-c', String.raw`
    container() { node "$MOCK_JS" "$@"; }
    uname() { if [[ $1 == -s ]]; then echo Darwin; else echo arm64; fi; }
    sw_vers() { echo 26.0; }
    jq() { command "$JQ_BIN" "$@"; }
    export -f container uname sw_vers jq
    bash "$TEST_SCRIPT" "$TEST_ACTION" --config "$TEST_CONFIG"
  `], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1',
    JQ_BIN: shellPath(process.env.JQ_BIN || 'jq'), TEST_SCRIPT: script,
    TEST_ACTION: action, TEST_CONFIG: shellPath(path.join(dir, '.env')),
    MOCK_JS: path.join(dir, 'mock.cjs').replaceAll('\\', '/'), MOCK_LOG: path.join(dir, 'calls.jsonl'), SCENARIO: scenario,
  }});
  if(result.error) throw result.error;
  const log = path.join(dir, 'calls.jsonl');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...result, calls, dir };
}

test('plan preserves space-containing paths, hides license, and performs no CLI calls', t => {
  const r = exercise(t, 'plan');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  assert.match(r.stdout, /config\\ space/);
  assert.doesNotMatch(r.stdout, /SECRET-FIXTURE/);
  assert.match(r.stdout, /--rosetta/);
});
test('up orders dependencies and injects actual inspected IPs', t => {
  const r = exercise(t);
  assert.equal(r.status, 0, r.stderr);
  const runs = r.calls.filter(c => c[0] === 'run');
  assert.equal(runs.length, 3);
  assert.ok(runs[1].includes('MYSQL_HOST=192.168.65.2'));
  assert.ok(runs[2].includes('DATABASE_HOST=192.168.65.2'));
  assert.ok(runs[2].includes('PDF_SDK_BASE_URL=http://192.168.65.3:7001'));
  assert.ok(runs[2].includes('127.0.0.1:8080:8080'));
  const calls = r.calls.map(c => c[0]);
  assert.ok(calls.indexOf('exec') < calls.lastIndexOf('run'));
  assert.doesNotMatch(JSON.stringify(r.calls), /SECRET-FIXTURE/);
});

test('XML license starts all components without an environment license key', t => {
  const r = exercise(t, 'up', 'xml-only');
  assert.equal(r.status, 0, r.stderr);
  const runs = r.calls.filter(c => c[0] === 'run');
  assert.equal(runs.length, 3);
  assert.ok(runs[1].some(arg => arg.includes('target=/opt/compdf_sdk/license,readonly')));
});

test('missing XML and legacy credentials fail before creating resources', t => {
  const r = exercise(t, 'up', '', { COMPDF_LICENSE_KEY: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /app-license\/license\.xml/);
  assert.equal(r.calls.length, 1); // Read-only runtime availability check.
  assert.ok(!r.calls.some(c => c[0] === 'run' || c[1] === 'create'));
});
test('native arm64 plan omits Rosetta', t => {
  const r = exercise(t, 'plan', '', { ARCH: 'arm64' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /--rosetta/);
});
for (const scenario of ['exists', 'wrong-arch']) {
  test(`${scenario} refuses before creating resources`, t => {
    const r = exercise(t, 'up', scenario);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, scenario === 'exists' ? /exists\. See the manual/ : /architecture unavailable/);
    assert.ok(!r.calls.some(c => c[0] === 'run' || c[1] === 'create'));
  });
}
for (const scenario of ['unhealthy', 'bad-ip']) {
  test(`${scenario} blocks App and Server startup`, t => {
    const r = exercise(t, 'up', scenario);
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.filter(c => c[0] === 'run').length, 1);
  });
}
test('existing network and all five data volumes are reused', t => {
  const r = exercise(t, 'up', 'reuse');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some(c => c[1] === 'create'));
});
test('stop uses reverse dependency order and never deletes volumes or containers', t => {
  const r = exercise(t, 'stop', 'exists');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter(c => c[0] === 'stop').map(c => c.at(-1)),
    ['compdf-apple-server', 'compdf-apple-app', 'compdf-apple-infra']);
  assert.ok(!r.calls.some(c => c.includes('delete') || c.includes('prune')));
});
test('literal config cannot execute shell substitution', t => {
  const r = exercise(t, 'plan', '', { COMPDF_LICENSE_KEY: '$(touch /should-never-be-created)' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /touch|should-never/);
});
test('status filters unrelated containers and omits environment secrets', t => {
  const r = exercise(t, 'status');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 1);
  assert.doesNotMatch(r.stdout, /SECRET-FIXTURE|unrelated-server/);
});
test('unknown config key rejected', t => {
  const r = exercise(t, 'plan', '', { PATH: '/unexpected' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown config key/);
});
test('missing required directory rejected before resource creation', t => {
  const r = exercise(t, 'plan', '', { FONT_DIR: '/does-not-exist-compdf-fixture' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Required directory missing/);
  assert.equal(r.calls.length, 0);
});
