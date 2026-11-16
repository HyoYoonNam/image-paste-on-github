import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.jsonc', root), 'utf8'));
const package_ = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

test('committed configuration cannot start real authentication or identify an operator account', () => {
  assert.equal(config.main, 'worker.mjs');
  assert.equal(config.vars.AUTH_ENABLED, 'false');
  assert.equal(config.vars.PUBLIC_BASE_URL, 'https://auth.invalid');
  assert.equal(config.vars.GITHUB_CLIENT_ID, '');
  assert.equal(config.vars.GITHUB_APP_SLUG, '');
  assert.equal(config.account_id, undefined);
  assert.equal(config.vars.GITHUB_CLIENT_SECRET, undefined);
  assert.equal(config.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000000');
  assert.match(config.vars.APP_NAMESPACE, /^[A-Za-z][A-Za-z0-9_]{0,63}$/);
});

test('logs, invocation logs, traces, issue collection, previews, and tail consumers are disabled', () => {
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal(config.send_metrics, false);
  assert.equal(config.logpush, false);
  assert.deepEqual(config.tail_consumers, []);
  assert.equal(config.observability.enabled, false);
  assert.equal(config.observability.head_sampling_rate, 0);
  assert.equal(config.observability.logs.enabled, false);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.observability.logs.head_sampling_rate, 0);
  assert.deepEqual(config.observability.logs.destinations, []);
  assert.equal(config.observability.traces.enabled, false);
  assert.equal(config.observability.traces.head_sampling_rate, 0);
  assert.deepEqual(config.observability.traces.destinations, []);
  assert.equal(config.observability.issues.enabled, false);
  assert.equal(config.env, undefined);
});

test('one local D1 binding and one cleanup schedule do not request paid-only infrastructure', () => {
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].binding, 'DB');
  assert.equal(config.d1_databases[0].migrations_dir, 'migrations');
  assert.equal(config.d1_databases[0].remote, false);
  assert.deepEqual(config.triggers.crons, ['*/15 * * * *']);
  for (const key of ['usage_model', 'limits', 'durable_objects', 'kv_namespaces', 'r2_buckets', 'queues', 'containers', 'services']) {
    assert.equal(config[key], undefined, key);
  }
});

test('local secret files, real deployment configuration, and runtime artifacts are ignored', () => {
  const ignored = readFileSync(new URL('.gitignore', root), 'utf8').split(/\r?\n/);
  for (const name of ['.dev.vars', '.dev.vars.*', '.env', '.env.*', 'wrangler.local.jsonc', '.wrangler/', 'dist/', 'node_modules/']) {
    assert.ok(ignored.includes(name), name);
  }
  assert.match(package_.scripts.deploy, /--config wrangler\.local\.jsonc$/);
  assert.match(package_.scripts.build, /--dry-run/);
  assert.match(package_.scripts['migrate:local'], /--local$/);
});

test('tool versions are exact and local tests use the same workerd version as Wrangler', () => {
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
  assert.equal(package_.engines.node, '>=22.12.0');
  assert.equal(package_.devDependencies.wrangler, '4.162.0');
  assert.equal(package_.devDependencies.miniflare, '5.20261113.0-beta');
  for (const name of ['wrangler', 'miniflare']) {
    assert.equal(lock.packages[`node_modules/${name}`].version, package_.devDependencies[name]);
  }
  assert.equal(lock.packages['node_modules/wrangler'].dependencies.miniflare, package_.devDependencies.miniflare);
  assert.equal(lock.packages['node_modules/wrangler'].dependencies.workerd, lock.packages['node_modules/miniflare'].dependencies.workerd);
});
