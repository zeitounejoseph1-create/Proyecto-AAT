// Verify the Vercel production install in a clean directory, without env files.
// This intentionally runs real pnpm and the existing API tests after the install.
const { mkdtemp, readFile, writeFile, mkdir, copyFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
async function run(command, args, cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
  });
}
async function main() {
  const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(config.installCommand, 'pnpm install --prod --frozen-lockfile');
  const temp = await mkdtemp(path.join(tmpdir(), 'mesalista-production-install-'));
  try {
    await mkdir(path.join(temp, 'api'));
    // Copy an explicit list: no secrets, SQL, browser state, or existing modules.
    for (const name of ['package.json', 'pnpm-lock.yaml', 'reservation-api.test.cjs', 'api/reservations.js', 'api/package.json', 'api/pnpm-lock.yaml']) {
      await copyFile(path.join(root, name), path.join(temp, name));
    }
    const originalLock = await readFile(path.join(temp, 'pnpm-lock.yaml'));
    // An unknown dependency script must remain an error even on machines whose
    // user-wide pnpm policy differs. No dependency script is approved here.
    await writeFile(path.join(temp, 'pnpm-workspace.yaml'), 'strictDepBuilds: true\n');
    const cleanEnv = {};
    for (const name of ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP']) {
      if (process.env[name]) cleanEnv[name] = process.env[name];
    }
    Object.assign(cleanEnv, {
      CI: '1', VERCEL: '1', NODE_ENV: 'production',
      XDG_CONFIG_HOME: path.join(temp, 'config'),
      XDG_DATA_HOME: path.join(temp, 'data'),
      XDG_CACHE_HOME: path.join(temp, 'cache')
    });
    // pnpm supplies its exact executable to package scripts; no shell or version
    // switch is needed. Running this script directly falls back to PATH's pnpm.
    const pnpm = process.env.npm_execpath;
    if (pnpm && /pnpm\.(?:c?js|mjs)$/.test(pnpm)) {
      await run(process.execPath, [pnpm, ...config.installCommand.split(' ').slice(1)], temp, cleanEnv);
    } else {
      await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', config.installCommand.split(' ').slice(1), temp, cleanEnv);
    }
    assert.deepEqual(await readFile(path.join(temp, 'pnpm-lock.yaml')), originalLock, 'production install must preserve the lockfile');
    const requireFromProduction = createRequire(path.join(temp, 'package.json'));
    for (const name of ['embedded-postgres', 'pg', 'playwright']) {
      assert.throws(() => requireFromProduction.resolve(name), { code: 'MODULE_NOT_FOUND' }, `${name} must not be in the production install`);
    }
    // Native /api functions can ignore the project Install Command. Their
    // default install must stop at the API's own empty package and lockfile.
    const apiPackage = JSON.parse(await readFile(path.join(temp, 'api/package.json'), 'utf8'));
    assert.equal(Object.keys(apiPackage.dependencies || {}).length, 0);
    assert.equal(Object.keys(apiPackage.devDependencies || {}).length, 0);
    const apiLock = await readFile(path.join(temp, 'api/pnpm-lock.yaml'));
    // The repository has no workspace. Remove only this verifier's temporary
    // root policy file so it cannot turn the independent API into a workspace.
    await rm(path.join(temp, 'pnpm-workspace.yaml'));
    if (pnpm && /pnpm\.(?:c?js|mjs)$/.test(pnpm)) {
      await run(process.execPath, [pnpm, 'install', '--frozen-lockfile'], path.join(temp, 'api'), cleanEnv);
    } else {
      await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install', '--frozen-lockfile'], path.join(temp, 'api'), cleanEnv);
    }
    assert.deepEqual(await readFile(path.join(temp, 'api/pnpm-lock.yaml')), apiLock);
    // pnpm may leave metadata under node_modules; no dependency package may remain.
    const modules = await readdir(path.join(temp, 'node_modules')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    assert.deepEqual(modules.filter(name => !name.startsWith('.')), [], 'no runtime dependency is currently required');
    await run(process.execPath, ['--test', 'reservation-api.test.cjs'], temp, cleanEnv);
    console.log('PASS: clean production and native API installs; strict dependency script policy; unchanged lockfiles; no test packages; 20 API tests');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
