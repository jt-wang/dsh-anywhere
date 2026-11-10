// The id the stores and the phone's system see: one id for the app on Android and iOS.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const app = join(import.meta.dirname, '..', '..', 'nsh-app');
const ID = 'io.jingtao.dshanywhere';

test('Android takes its application id from nsh.json, which is the app id', () => {
  assert.equal(JSON.parse(readFileSync(join(app, 'nsh.json'), 'utf8')).id, ID);
  assert.match(readFileSync(join(app, 'android', 'app', 'build.gradle'), 'utf8'), /applicationId app\.id\b/);
});

test('iOS bundle ids are the same id under the default prefix; a build for your own phone swaps only the prefix', () => {
  const project = readFileSync(join(app, 'ios', 'project.yml'), 'utf8');
  const prefix = project.match(/^\s*DSH_BUNDLE_PREFIX: (\S+)/m)?.[1];
  assert.equal(prefix, 'io.jingtao');
  const ids = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER: (\S+)/g)].map(m => m[1]);
  assert.ok(ids.every(id => id.startsWith('$(DSH_BUNDLE_PREFIX).')), 'every target takes the configurable prefix');
  assert.deepEqual(ids.map(id => id.replace('$(DSH_BUNDLE_PREFIX)', prefix!)), [ID, `${ID}.uitests`]);
});

test('the iPhone keeps its link in a keychain item named with the same id', () => {
  assert.match(readFileSync(join(app, 'ios', 'DSH', 'Vault.swift'), 'utf8'), new RegExp(`kSecAttrService as String: "${ID}"`));
});

