import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canaryAccepts, officialLoader, rc2Family, trialComposition, usesGatewayComposition } from './composition.mjs';
import { isVerifiedDshVersion } from '../../host/src/compatibility.ts';

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
  for (const version of ['0.2.1-alpha.2', '0.2.1-rc.1', '0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.3-nightly.1', '1.0.0-alpha.1', '1.0.0', '0.2.4-alpha.01', '0.2.1-rc.4 ', 'latest']) {
    assert.equal(canaryAccepts(version), false, version);
  }
});

test('supported 0.2.2 and 0.2.3 versions run with the Gateway service set', () => {
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2', '0.2.3-alpha.2', '0.2.3-beta.1', '0.2.3-rc.1', '0.2.3']) {
    assert.equal(canaryAccepts(version), true, version);
    assert.equal(usesGatewayComposition(version), true, version);
    assert.equal(rc2Family(version), false, version);
  }
  for (const version of ['0.2.1-rc.3', '0.2.1', '0.2.2-alpha.3']) assert.equal(usesGatewayComposition(version), false, version);
});

test('a later 0.x DSH runs with the Gateway service set, as a trial until its line is in LINES', async () => {
  // This holds before and after a line is added to LINES: promoting it ends the trial, not the run.
  for (const version of ['0.2.4-0', '0.2.4-alpha.1', '0.2.4-nightly.1', '0.3.0', '0.9.99']) {
    assert.equal(canaryAccepts(version), true, version);
    assert.equal(usesGatewayComposition(version), true, version);
    assert.equal(trialComposition(version), !isVerifiedDshVersion(version), version);
  }
  // Inspected lines are not trials; untested builds of a verified line stay refused, not tried.
  for (const version of ['0.2.3', '0.2.2-rc.1', '0.2.1-rc.3', '0.2.1-alpha.2', '0.2.3-nightly.1']) assert.equal(trialComposition(version), false, version);
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-canary-trial-'));
  try {
    const stage = async version => {
      await mkdir(path.join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
      await writeFile(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
      return officialLoader(root);
    };
    assert.equal(await (await stage('0.2.4-alpha.1')).version(), '0.2.4-alpha.1');
    assert.equal(await (await stage('0.3.0')).version(), '0.3.0');
    await assert.rejects((await stage('1.0.0-alpha.1')).version(), /not 1\.0\.0-alpha\.1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
