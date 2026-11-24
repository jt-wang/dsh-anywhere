import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCompatibleDshVersion, SUPPORTED_DSH_VERSIONS } from '../src/compatibility.ts';

test('every 0.2.1 release and pre-release is accepted, so a DSH update every other day does not cut the phone off', () => {
  for (const version of ['0.2.1-alpha.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1-rc.17', '0.2.1-beta.1', '0.2.1']) {
    assert.equal(isCompatibleDshVersion(version), true, version);
  }
});

test('0.2.2 release candidates and the 0.2.2 release are accepted: rc.1 passed the canary and the packed-plugin load', () => {
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.12', '0.2.2']) {
    assert.equal(isCompatibleDshVersion(version), true, version);
  }
});

test('0.2.2 alphas and betas are refused: none was run, and alpha.2 left resumed empty sessions in the list', () => {
  for (const version of ['0.2.2-alpha.1', '0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-beta.1', '0.2.2-rc.01', '0.2.2-rc', '0.2.2-nightly.1']) {
    assert.equal(isCompatibleDshVersion(version), false, version);
  }
});

test('DSH 0.2.3-alpha.2 and the 0.2.3 alpha, beta, rc, and final channels are accepted', () => {
  for (const version of ['0.2.3-alpha.0', '0.2.3-alpha.2', '0.2.3-beta.1', '0.2.3-rc.1', '0.2.3']) {
    assert.equal(isCompatibleDshVersion(version), true, version);
  }
  for (const version of ['0.2.3-alpha.02', '0.2.3-alpha.2.1', '0.2.3-nightly.1', '0.2.4-alpha.2', '0.2.4']) {
    assert.equal(isCompatibleDshVersion(version), false, version);
  }
});

test('0.2.0-rc.2 stays accepted; other lines and anything that is not a plain version are refused', () => {
  assert.equal(isCompatibleDshVersion('0.2.0-rc.2'), true);
  for (const version of ['0.2.0-rc.3', '0.2.0', '0.3.0', '1.0.0', '0.2.10', '0.2.1-rc', '0.2.1-rc.4 ', ' 0.2.1', 'v0.2.1', '0.2.1-rc.4+build', '0.2.1-nightly.1', '^0.2.1', '>=0.2.1', '0.2.1-rc.01', '']) {
    assert.equal(isCompatibleDshVersion(version), false, JSON.stringify(version));
  }
});

test('the supported versions read the same in errors and the installer', () => {
  assert.equal(SUPPORTED_DSH_VERSIONS, '0.2.0-rc.2, every 0.2.1 or 0.2.3 release or pre-release, and every 0.2.2 release candidate or release');
});
