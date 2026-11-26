import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DSH_ENGINES_RANGE, isCompatibleDshVersion, isVerifiedDshVersion, SUPPORTED_DSH_VERSIONS } from '../src/compatibility.ts';

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
  for (const version of ['0.2.3-alpha.02', '0.2.3-alpha.2.1', '0.2.3-nightly.1']) {
    assert.equal(isCompatibleDshVersion(version), false, version);
  }
});

test('a DSH line released after the verified ones is accepted unverified, so the phone stays connected that day', () => {
  // These stay accepted when a later line is verified: the floor is 0.2.4-0, not the line after the last one in LINES.
  for (const version of ['0.2.4-alpha.1', '0.2.4-0', '0.2.4-nightly.1', '0.2.4', '0.2.10-rc.3', '0.3.0-alpha.1', '0.3.0', '0.9.99']) {
    assert.equal(isCompatibleDshVersion(version), true, version);
    assert.equal(isVerifiedDshVersion(version), false, version);
  }
  for (const version of ['0.2.1-rc.5', '0.2.2-rc.1', '0.2.2', '0.2.3-alpha.2', '0.2.3', '0.2.0-rc.2']) assert.equal(isVerifiedDshVersion(version), true, version);
  for (const version of ['1.0.0-0', '1.0.0-alpha.1', '1.0.0', '2.0.0', '0.2.4-alpha.01', '0.2.4-alpha..1', '0.2.4+build', '0.2.4 ', 'v0.2.4', '00.3.0']) {
    assert.equal(isCompatibleDshVersion(version), false, JSON.stringify(version));
  }
  assert.match(DSH_ENGINES_RANGE, / \|\| >=0\.2\.4-0 <1\.0\.0-0$/);
});

test('0.2.0-rc.2 stays accepted; other earlier versions and anything that is not a plain version are refused', () => {
  assert.equal(isCompatibleDshVersion('0.2.0-rc.2'), true);
  for (const version of ['0.2.0-rc.3', '0.2.0', '1.0.0', '0.2.1-rc', '0.2.1-rc.4 ', ' 0.2.1', 'v0.2.1', '0.2.1-rc.4+build', '0.2.1-nightly.1', '^0.2.1', '>=0.2.1', '0.2.1-rc.01', '']) {
    assert.equal(isCompatibleDshVersion(version), false, JSON.stringify(version));
  }
});

test('the supported versions read the same in errors and the installer', () => {
  assert.equal(SUPPORTED_DSH_VERSIONS, '0.2.0-rc.2, every 0.2.1 or 0.2.3 release or pre-release, every 0.2.2 release candidate or release, and every later version below 1.0.0');
});
