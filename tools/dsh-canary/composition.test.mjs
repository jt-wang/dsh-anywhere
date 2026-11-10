import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canaryAccepts, line022, rc2Family } from './composition.mjs';

test('the daily canary runs every 0.2.1 rc from rc.2 on, and the plain 0.2.1 release, with the rc.2 service set', () => {
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1-rc.12', '0.2.1']) {
    assert.equal(canaryAccepts(version), true, version);
    assert.equal(rc2Family(version), true, version);
  }
});

test('0.2.0-rc.2 and 0.2.1-alpha.1 keep their own service set; untested builds and other lines are refused', () => {
  for (const version of ['0.2.0-rc.2', '0.2.1-alpha.1']) {
    assert.equal(canaryAccepts(version), true, version);
    assert.equal(rc2Family(version), false, version);
  }
  for (const version of ['0.2.1-alpha.2', '0.2.1-rc.1', '0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.3-rc.1', '0.3.0', '0.2.1-rc.4 ', 'latest']) {
    assert.equal(canaryAccepts(version), false, version);
  }
});

test('0.2.2 release candidates and the 0.2.2 release run with the 0.2.2 service set', () => {
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2']) {
    assert.equal(canaryAccepts(version), true, version);
    assert.equal(line022(version), true, version);
    assert.equal(rc2Family(version), false, version);
  }
  for (const version of ['0.2.1-rc.3', '0.2.1', '0.2.2-alpha.3']) assert.equal(line022(version), false, version);
});
