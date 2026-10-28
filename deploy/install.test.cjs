// node --test deploy/install.test.cjs (BASH_BIN and DOCKER_BIN optional)
// Real filesystem, Bash and Docker Compose parser; simulated network and daemons.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const bash = process.env.BASH_BIN || 'bash';
const shellPath = p => p.replaceAll('\\','/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
const mock = String.raw`
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const [tool,...a]=process.argv.slice(2);
const native=p=>process.platform==='win32'?p.replace(/^\/([a-z])\//,(_,d)=>d+':/'):p;
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify([tool,...a])+'\n');
if(tool==='curl'){
 const url=a.find(v=>v.startsWith('https:'));
 if(url.includes('api.github.com')) {console.log('a'.repeat(40));process.exit(0);}
 if(!url.includes('/'+'a'.repeat(40)+'/')) process.exit(23);
 const asset=url.split('/'+'a'.repeat(40)+'/')[1];
 if(process.env.SCENARIO==='download-failure'&&asset==='.env.example') process.exit(22);
 const target=native(a[a.indexOf('--output')+1]);
 if(asset==='.env.example') fs.writeFileSync(target,'COMPDF_VERSION=1.1.0\nCOMPDF_DB_SCHEMA_VERSION=1.1.0\nCOMPDF_INFRA_IMAGE=compdfkit/compdf-infra:1.0.0\nCOMPDF_APP_IMAGE=compdfkit/compdf-app:1.0.0\nCOMPDF_SERVER_IMAGE=compdfkit/compdf-server:1.1.0\nCOMPDF_LICENSE_KEY='+(process.env.SCENARIO==='no-license'?'':'secret-fixture')+'\n');
 else if(asset==='configs/license.jwt') fs.writeFileSync(target,'fake-server-license');
 else if(asset==='deploy/apple-container/compdf-container.sh') fs.writeFileSync(target,'#!/bin/bash\ncontainer helper-invoked "$@"\n');
 else fs.copyFileSync(path.join(process.env.TEST_REPO,asset),target);
} else if(tool==='docker') {
 if(a[0]==='info'&&process.env.SCENARIO==='daemon-failure') process.exit(1);
 if(a.includes('--help')) console.log('--wait-timeout');
 if(a.includes('config')) {
   const r=spawnSync(process.env.DOCKER_BIN||'docker',a.map(native),{encoding:'utf8'});
   if(r.error) throw r.error;
   if(r.status) process.stderr.write('Compose parser command: '+JSON.stringify([process.env.DOCKER_BIN||'docker',...a.map(native)])+'\n');
   process.stderr.write(r.stderr);process.exit(r.status);
 }
 if(a.includes('up')&&!a.includes('--help')&&process.env.SCENARIO==='health-failure') process.exit(1);
} else if(tool==='container'&&a[0]==='inspect') process.exit(1);
`;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compdf-installer-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'mock.cjs'), mock);
  return { dir, target: path.join(dir, 'install space') };
}
function invoke(f, args = [], scenario = '', piped = false) {
  const r = spawnSync(bash, ['-c', String.raw`
    curl() { node "$TEST_MOCK" curl "$@"; }
    docker() { node -- "$TEST_MOCK" docker "$@"; }
    container() { node "$TEST_MOCK" container "$@"; }
    jq() { :; }
    uname() { if [[ $1 == -s ]]; then echo "$TEST_OS"; else echo arm64; fi; }
    sw_vers() { echo 26.0; }
    export -f curl docker container jq uname sw_vers
    if [[ $TEST_PIPE == 1 ]]; then bash -s -- "$@"; else bash "$TEST_INSTALLER" "$@"; fi
  `, 'test-installer', '--dir', shellPath(f.target), ...args], { encoding:'utf8', input:piped?fs.readFileSync(path.join(__dirname,'install.sh')):undefined, env: {
    ...process.env, MSYS_NO_PATHCONV:'1', TEST_PIPE:piped?'1':'0', TEST_OS:args.includes('apple')?'Darwin':'Linux',
    TEST_MOCK:path.join(f.dir,'mock.cjs').replaceAll('\\','/'), TEST_LOG:path.join(f.dir,'calls.jsonl'),
    TEST_REPO:repo, TEST_INSTALLER:shellPath(path.join(__dirname,'install.sh')), SCENARIO:scenario,
  }});
  if(r.error) throw r.error;
  const log = path.join(f.dir,'calls.jsonl');
  r.calls=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  return r;
}
test('fresh Docker installation downloads minimal pinned assets and starts with health wait', t => {
  const f=fixture(t), r=invoke(f);
  assert.equal(r.status,0,r.stderr);
  assert.ok(fs.existsSync(path.join(f.target,'configs/app-license')));
  assert.ok(fs.existsSync(path.join(f.target,'fonts/windows')));
  assert.ok(fs.existsSync(path.join(f.target,'data/server-storage')));
  assert.ok(!fs.existsSync(path.join(f.target,'.git')));
  assert.ok(r.calls.some(c=>c.includes('--wait')&&c.includes('--wait-timeout')));
  assert.ok(r.calls.some(c=>c.includes('--project-name')));
  assert.doesNotMatch(r.stdout+r.stderr,/secret-fixture/);
});
test('rerun preserves customized configuration and data without downloading again', t => {
  const f=fixture(t); assert.equal(invoke(f).status,0);
  fs.writeFileSync(path.join(f.target,'data/server-storage/keep'),'customer-data');
  fs.appendFileSync(path.join(f.target,'.env'),'# preserved\n');
  const before=fs.readFileSync(path.join(f.target,'.env'));
  fs.unlinkSync(path.join(f.dir,'calls.jsonl'));
  const r=invoke(f);
  assert.equal(r.status,0,r.stderr);
  assert.ok(!r.calls.some(c=>c[0]==='curl'));
  assert.deepEqual(fs.readFileSync(path.join(f.target,'.env')),before);
  assert.equal(fs.readFileSync(path.join(f.target,'data/server-storage/keep'),'utf8'),'customer-data');
});
test('download failure leaves no final or staging installation and never starts services', t => {
  const f=fixture(t),r=invoke(f,[],'download-failure');
  assert.notEqual(r.status,0);
  assert.ok(!fs.existsSync(f.target));
  assert.ok(!fs.readdirSync(f.dir).some(p=>p.startsWith('.compdf-install.')));
  assert.ok(!r.calls.some(c=>c.includes('pull')));
});
test('refuses to overwrite an unmanaged directory', t => {
  const f=fixture(t);fs.mkdirSync(f.target);fs.writeFileSync(path.join(f.target,'keep'),'original');
  const r=invoke(f);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/not managed/);
  assert.equal(fs.readFileSync(path.join(f.target,'keep'),'utf8'),'original');
});
test('prepare-only creates files without touching a runtime', t => {
  const f=fixture(t),r=invoke(f,['--prepare-only']);
  assert.equal(r.status,0,r.stderr);
  assert.ok(r.calls.every(c=>c[0]==='curl'));
});
test('dry-run performs no IO or external calls', t => {
  const f=fixture(t),r=invoke(f,['--dry-run']);
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.calls.length,0);
  assert.ok(!fs.existsSync(f.target));
});
test('daemon failure stops before downloads', t => {
  const r=invoke(fixture(t),[],'daemon-failure');
  assert.notEqual(r.status,0);assert.match(r.stderr,/daemon unavailable/);
  assert.ok(!r.calls.some(c=>c[0]==='curl'));
});
test('failed health wait returns failure and preserves diagnostic files', t => {
  const f=fixture(t),r=invoke(f,[],'health-failure');
  assert.notEqual(r.status,0);
  assert.ok(fs.existsSync(path.join(f.target,'.env')));
  assert.ok(r.calls.some(c=>c.includes('up')&&c.includes('--wait')));
  assert.doesNotMatch(r.stdout,/passed startup/);
});
test('script piped to bash works without a local checkout or script path', t => {
  const f=fixture(t),r=invoke(f,['--prepare-only'],'',true);
  assert.equal(r.status,0,r.stderr);
  assert.ok(fs.existsSync(path.join(f.target,'install.sh')));
  assert.ok(!fs.existsSync(path.join(f.target,'.git')));
});
test('Apple bootstrap generates absolute paths, pulls three images and delegates startup', t => {
  const f=fixture(t),r=invoke(f,['--runtime','apple']);
  assert.equal(r.status,0,r.stderr);
  const env=fs.readFileSync(path.join(f.target,'.apple.env'),'utf8');
  assert.ok(env.includes('CONFIG_DIR='+shellPath(f.target)+'/configs'));
  assert.match(env,/PROJECT=compdf-[0-9]+/);
  assert.equal(r.calls.filter(c=>c[0]==='container'&&c[1]==='image'&&c[2]==='pull').length,3);
  assert.ok(r.calls.some(c=>c.includes('helper-invoked')&&c.includes('up')));
  assert.doesNotMatch(r.stdout+r.stderr,/secret-fixture/);
});

test('Apple preparation accepts a blank license for configuration before startup', t => {
  const f=fixture(t),r=invoke(f,['--runtime','apple','--prepare-only'],'no-license');
  assert.equal(r.status,0,r.stderr);
  assert.doesNotMatch(fs.readFileSync(path.join(f.target,'.apple.env'),'utf8'),/^COMPDF_LICENSE_KEY=/m);
  assert.ok(r.calls.every(c=>c[0]==='curl'));
});
test('explicit license and fonts are copied, never replaced by downloaded trial values', t => {
  const f=fixture(t),license=path.join(f.dir,'customer.jwt'),fonts=path.join(f.dir,'fonts');
  fs.writeFileSync(license,'customer-license');fs.mkdirSync(fonts);fs.writeFileSync(path.join(fonts,'test.ttf'),'font-fixture');
  const r=invoke(f,['--prepare-only','--license-file',shellPath(license),'--fonts-dir',shellPath(fonts)]);
  assert.equal(r.status,0,r.stderr);
  assert.equal(fs.readFileSync(path.join(f.target,'configs/license.jwt'),'utf8'),'customer-license');
  assert.ok(fs.existsSync(path.join(f.target,'fonts/windows/test.ttf')));
  assert.ok(!r.calls.some(c=>c.some(a=>a.endsWith('/configs/license.jwt'))));
});
