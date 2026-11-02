import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.js';
import { performance } from 'node:perf_hooks';
const e = await environment();
const headers = (role: string) => ({
  host: new URL('http://127.0.0.1:4430').host,
  authorization: 'Bearer ' + e.tokens[role],
});
async function call(path: string, role: string, body?: unknown) {
  const response = await e.app.inject({
    method: body === undefined ? 'GET' : 'POST',
    url: path,
    headers: headers(role),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: response.statusCode, body: response.json() };
}
async function planAndApprove(data: unknown) {
  const p = await call('/api/plans', 'requester', data);
  assert.equal(p.status, 201);
  const reviewed = await call('/api/plans/' + p.body.id + '/review', 'reviewer', {
    digest: p.body.digest,
    approve: true,
  });
  assert.equal(reviewed.status, 200);
  return p.body;
}
try {
  const pause = () => new Promise((r) => setTimeout(r, 550));
  assert.equal((await call('/api/collect', 'operator', {})).status, 200);
  const injected = performance.now();
  await call('/api/demo/fault', 'operator', { directory: true, workspace: false, dns: false });
  await pause();
  await call('/api/collect', 'operator', {});
  await pause();
  await call('/api/collect', 'operator', {});
  let incidents = (await call('/api/overview', 'viewer')).body.incidents;
  assert.equal(incidents.length, 2);
  const detectionMs = Math.round(performance.now() - injected);
  for (const incident of incidents) {
    await call('/api/incidents/' + incident.id, 'operator', {
      version: 1,
      status: 'acknowledged',
      note: 'Scripted lab: inspected the actual failing HTTP probe evidence',
    });
    await call('/api/incidents/' + incident.id, 'operator', {
      version: 2,
      status: 'monitoring',
      note: 'Scripted lab: clearing the local directory fault',
    });
  }
  const recoveryStart = performance.now();
  await call('/api/demo/fault', 'operator', { directory: false, workspace: false, dns: false });
  await pause();
  await call('/api/collect', 'operator', {});
  await pause();
  await call('/api/collect', 'operator', {});
  for (const incident of incidents) {
    const resolved = await call('/api/incidents/' + incident.id, 'operator', {
      version: 3,
      status: 'resolved',
      note: 'Scripted lab: two actual successful probes verify recovery',
    });
    assert.equal(resolved.body.status, 'resolved');
  }
  const recoveryMs = Math.round(performance.now() - recoveryStart),
    backup = (await call('/api/backups', 'operator', {})).body;
  assert.equal(
    (await call('/api/objective', 'operator', { version: 1, target: 'directory', objective: 0.95 }))
      .status,
    200,
  );
  const p = await planAndApprove({ backupId: backup.id });
  const restored = await call('/api/plans/' + p.id + '/execute', 'operator', {
    digest: p.digest,
    key: 'demo-catalog-restore',
  });
  assert.equal(restored.body.status, 'completed');
  const output = {
    scope: 'scripted local HTTP and DNS drill, not human response or production availability',
    observations: e.service.observations(
      e.auth.config.identities.find((i) => i.roles.includes('operator'))!,
    ).length,
    incidentsOpened: 2,
    incidentsResolved: 2,
    scriptedFailureDetectionMs: detectionMs,
    scriptedRecoveryVerificationMs: recoveryMs,
    configurationRestored: restored.body.result.verified,
    configVersion: e.service.config(
      e.auth.config.identities.find((i) => i.roles.includes('operator'))!,
    ).version,
    auditIntegrity: e.store.verify(),
  };
  if (process.argv.includes('--write'))
    writeFileSync('evidence/demo.json', JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
} finally {
  await e.close();
}
