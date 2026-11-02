import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:tls';
import { startLab } from '../src/lab.js';
import { probe, targets, type Target } from '../src/probes.js';
import { Reliability, type Incident } from '../src/reliability.js';
import { Store } from '../src/store.js';
import { demoAuth, digest, type Identity } from '../src/security.js';
import { createApp } from '../src/app.js';
const operator: Identity = { tenant: 'sandbox', subject: 'operator', roles: ['operator'] },
  requester: Identity = { tenant: 'sandbox', subject: 'requester', roles: ['requester'] },
  reviewer: Identity = { tenant: 'sandbox', subject: 'reviewer', roles: ['reviewer'] };
async function setup() {
  let now = Date.now();
  const lab = await startLab(),
    store = new Store(':memory:', 'k'.repeat(32), () => now),
    service = new Reliability(store, lab.targets, true);
  return {
    lab,
    store,
    service,
    advance: (n = 1000) => {
      now += n;
    },
    close: async () => {
      await lab.close();
      store.close();
    },
  };
}
async function failure(s: Awaited<ReturnType<typeof setup>>) {
  s.lab.faults.directory = true;
  await s.service.collect(operator);
  s.advance();
  await s.service.collect(operator);
}
test('real HTTP and DNS probes distinguish healthy, status failure and DNS failure', async () => {
  const s = await setup();
  try {
    let result = await s.service.collect(operator);
    assert.ok(result.observations.every((o) => o.success));
    s.advance();
    s.lab.faults.directory = true;
    result = await s.service.collect(operator);
    assert.equal(result.observations.find((o) => o.target === 'directory')!.success, false);
    assert.equal(result.observations.find((o) => o.target === 'workspace')!.success, false);
    assert.equal(result.observations.find((o) => o.target === 'directory-dns')!.success, true);
    s.advance();
    s.lab.faults.dns = true;
    result = await s.service.collect(operator);
    assert.equal(result.observations.find((o) => o.target === 'directory-dns')!.success, false);
  } finally {
    await s.close();
  }
});
test('incident recovery requires the state machine, version and two fresh successes', async () => {
  const s = await setup();
  try {
    await failure(s);
    let incident = s.service.incidents(operator).find((i) => i.target === 'directory')!;
    assert.equal(incident.status, 'open');
    assert.throws(
      () =>
        s.service.transition(operator, incident.id, {
          version: 1,
          status: 'resolved',
          note: 'Attempted premature closure',
        }),
      { code: 'incident_state_or_version_conflict' },
    );
    incident = s.service.transition(operator, incident.id, {
      version: 1,
      status: 'acknowledged',
      note: 'Recorded the actual HTTP 503 evidence',
    });
    incident = s.service.transition(operator, incident.id, {
      version: 2,
      status: 'monitoring',
      note: 'Investigating the local service fault',
    });
    assert.throws(
      () =>
        s.service.transition(operator, incident.id, {
          version: 3,
          status: 'resolved',
          note: 'Cannot close before healthy observations',
        }),
      { code: 'two_fresh_successful_observations_required' },
    );
    s.lab.faults.directory = false;
    s.advance();
    await s.service.collect(operator);
    assert.throws(() =>
      s.service.transition(operator, incident.id, {
        version: 3,
        status: 'resolved',
        note: 'Only one fresh observation exists',
      }),
    );
    s.advance();
    await s.service.collect(operator);
    incident = s.service.transition(operator, incident.id, {
      version: 3,
      status: 'resolved',
      note: 'Two actual successful observations verified recovery',
    });
    assert.equal(incident.status, 'resolved');
    assert.ok(incident.resolvedAt);
    assert.equal(s.service.export(operator, incident.id).observations.length, 4);
    assert.equal(s.store.verify(), true);
  } finally {
    await s.close();
  }
});
test('duplicate incidents are suppressed while unresolved and dependency overlap stays a candidate', async () => {
  const s = await setup();
  try {
    await failure(s);
    s.advance();
    await s.service.collect(operator);
    assert.equal(s.service.incidents(operator).length, 2);
    const candidate = s.service.dependencies(operator).find((d) => d.target === 'workspace')!;
    assert.deepEqual(candidate.candidateDependencies, ['directory']);
    assert.match(candidate.conclusion, /not proof/);
  } finally {
    await s.close();
  }
});
test('unobserved, stale and rapidly sampled windows do not become eligible availability claims', async () => {
  const s = await setup();
  try {
    assert.ok(
      s.service
        .score(operator)
        .every((s) => s.state === 'unknown' && s.successRatio === null && !s.eligible),
    );
    for (let i = 0; i < 6; i++) {
      if (i) s.advance();
      await s.service.collect(operator);
    }
    assert.ok(s.service.score(operator).every((s) => s.successRatio === 1 && !s.eligible));
    s.advance(61000);
    assert.ok(s.service.score(operator).every((s) => s.state === 'unknown' && !s.eligible));
  } finally {
    await s.close();
  }
});
test('collection concurrency, minimum intervals and long-gap failures are bounded', async () => {
  const s = await setup();
  try {
    const first = s.service.collect(operator);
    await assert.rejects(s.service.collect(operator), { code: 'collection_in_progress' });
    await first;
    await assert.rejects(s.service.collect(operator), { code: 'probe_minimum_interval' });
    s.advance();
    s.lab.faults.directory = true;
    await s.service.collect(operator);
    s.advance(61000);
    await s.service.collect(operator);
    assert.equal(s.service.incidents(operator).length, 0);
  } finally {
    await s.close();
  }
});
test('signed backup restore is independently approved, version bound and idempotent', async () => {
  const s = await setup();
  try {
    const before = s.service.config(operator),
      backup = s.service.backup(operator);
    s.service.changeObjective(operator, {
      version: before.version,
      target: 'directory',
      objective: 0.95,
    });
    const p = s.service.planRestore(requester, { backupId: backup.id });
    s.service.book.review(reviewer, p.id, p.digest, true);
    const result = s.service.restore(operator, p.id, p.digest, 'restore-key');
    assert.equal(result.status, 'completed');
    assert.equal(
      s.service.config(operator).targets.find((t) => t.id === 'directory')!.objective,
      0.99,
    );
    const version = s.service.config(operator).version;
    s.service.restore(operator, p.id, p.digest, 'restore-key');
    assert.equal(s.service.config(operator).version, version);
  } finally {
    await s.close();
  }
});
test('backup edits, foreign tenants, stale configuration and changed approvals cannot restore', async () => {
  for (const kind of ['backup', 'tenant', 'config']) {
    const s = await setup();
    try {
      const backup = s.service.backup(operator);
      if (kind === 'backup') {
        const altered = structuredClone(backup);
        altered.payload.config.targets[0]!.objective = 0.9;
        s.store.put('sandbox', 'backup', backup.id, altered);
        assert.throws(() => s.service.planRestore(requester, { backupId: backup.id }), {
          code: 'backup_integrity_failed',
        });
      } else if (kind === 'tenant')
        assert.throws(
          () =>
            s.service.planRestore({ ...requester, tenant: 'isolated' }, { backupId: backup.id }),
          { code: 'record_not_found' },
        );
      else {
        const p = s.service.planRestore(requester, { backupId: backup.id });
        s.service.book.review(reviewer, p.id, p.digest, true);
        s.service.changeObjective(operator, { version: 1, target: 'directory', objective: 0.95 });
        assert.throws(() => s.service.restore(operator, p.id, p.digest, 'stale-restore'), {
          code: 'restore_inputs_changed',
        });
        assert.equal(s.service.book.get(operator, p.id).status, 'approved');
      }
    } finally {
      await s.close();
    }
  }
});
test('fixed target configuration rejects arbitrary endpoints, credentials and dependency cycles', () => {
  const base = {
    id: 'one',
    label: 'Test',
    kind: 'http' as const,
    url: 'https://example.invalid/',
    expectedStatus: 200,
    dependencies: [],
    expectedIntervalSeconds: 30,
    objective: 0.99,
  };
  for (const url of [
    'http://example.invalid',
    'https://u:p@example.invalid',
    'https://example.invalid/?token=private',
  ])
    assert.throws(() => targets([{ ...base, url }]));
  assert.throws(() => targets([{ ...base, dependencies: ['missing'] }]));
  assert.throws(() =>
    targets([
      { ...base, dependencies: ['two'] },
      { ...base, id: 'two', dependencies: ['one'] },
    ]),
  );
  assert.throws(() => targets([{ ...base, timeout: 999999 }]));
});
test('configured probes reject private and metadata ranges before connecting', async () => {
  for (const hostname of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.1.1',
    '::1',
    'fe90::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ]) {
    const t: Target = {
      id: 'private',
      label: 'Private address',
      kind: 'tls',
      hostname,
      port: 443,
      minimumDays: 0,
      dependencies: [],
      expectedIntervalSeconds: 30,
      objective: 0.99,
    };
    const observation = await probe(t, { timeout: 100 });
    assert.equal(observation.success, false);
    assert.equal(observation.reason, 'probe_destination_rejected');
  }
});
test('HTTP API enforces operation roles, tenant isolation and fixed collection input', async () => {
  const s = await setup(),
    { auth, tokens } = await demoAuth('saasops-reliability-lab'),
    { app } = createApp({
      auth,
      store: s.store,
      baseUrl: 'http://127.0.0.1:4430',
      targets: s.lab.targets,
      allowLocal: true,
      faults: s.lab.faults,
    });
  const h = (r: string) => ({ host: '127.0.0.1:4430', authorization: 'Bearer ' + tokens[r] });
  try {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/collect', headers: h('viewer'), payload: {} }))
        .statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/overview', headers: h('outsider') })).json().services.length,
      0,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/objective',
          headers: h('operator'),
          payload: { version: 1, target: 'directory', objective: 1.5 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/demo/fault',
          headers: h('requester'),
          payload: { directory: true, workspace: false, dns: false },
        })
      ).statusCode,
      403,
    );
    const response = await app.inject({ url: '/api/overview', headers: h('viewer') });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().integrity, true);
  } finally {
    await app.close();
    await s.close();
  }
});
let certDir: string, server: ReturnType<typeof createServer>, ca: string, tlsPort: number;
before(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'saasops-tls-'));
  writeFileSync(
    join(certDir, 'config.cnf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyCertSign\n',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      join(certDir, 'key.pem'),
      '-out',
      join(certDir, 'cert.pem'),
      '-config',
      join(certDir, 'config.cnf'),
    ],
    { stdio: 'ignore', timeout: 10000 },
  );
  ca = readFileSync(join(certDir, 'cert.pem'), 'utf8');
  server = createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: ca }, (socket) =>
    socket.end(),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TLS bind failed');
  tlsPort = address.port;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(certDir, { recursive: true, force: true });
});
function tlsTarget(minimumDays = 0): Target {
  return {
    id: 'certificate',
    label: 'Actual TLS fixture',
    kind: 'tls',
    hostname: 'localhost',
    port: tlsPort,
    minimumDays,
    dependencies: [],
    expectedIntervalSeconds: 30,
    objective: 0.99,
  };
}
test('real TLS handshake verifies trusted hostname and reports expiration threshold', async () => {
  const trusted = await probe(tlsTarget(), { allowLocal: true, ca });
  assert.equal(trusted.success, true);
  assert.equal(trusted.reason, 'trusted-certificate');
  const expiring = await probe(tlsTarget(30), { allowLocal: true, ca });
  assert.equal(expiring.success, false);
  assert.equal(expiring.reason, 'certificate-expiring');
});
test('real TLS rejects untrusted certificates and hostname mismatch', async () => {
  assert.equal((await probe(tlsTarget(), { allowLocal: true })).success, false);
  const mismatch = await probe({ ...tlsTarget(), hostname: '127.0.0.1' } as Target, {
    allowLocal: true,
    ca,
  });
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.reason, 'tls-validation-failed', JSON.stringify(mismatch));
});
test('a regularly observed hour has an eligible sample ratio and explicit budget arithmetic', async () => {
  const s = await setup();
  try {
    const config = s.service.config(operator);
    config.targets[0]!.expectedIntervalSeconds = 300;
    s.store.put('sandbox', 'config', 'catalog', config);
    const now = s.store.now();
    for (let i = 0; i < 13; i++) {
      const observation = {
        id: 'math-' + i,
        target: 'directory',
        kind: 'http',
        at: new Date(now - 3600000 + i * 300000).toISOString(),
        success: i !== 6,
        latencyMs: 1,
        reason: i === 6 ? 'unexpected-status' : 'expected-status',
        detail: { status: i === 6 ? 503 : 200 },
      };
      s.store.put('sandbox', 'observation', observation.id, observation);
    }
    const score = s.service.score(operator).find((s) => s.id === 'directory')!;
    assert.equal(score.eligible, true);
    assert.equal(score.samples, 13);
    assert.equal(score.good, 12);
    assert.equal(score.successRatio, 12 / 13);
    assert.equal(score.errorBudgetRemainingSamples, 0);
    assert.ok(score.burnRate! > 1);
  } finally {
    await s.close();
  }
});
test('bounded observation retention preserves incident-referenced evidence', async () => {
  const s = await setup();
  try {
    const now = s.store.now(),
      protectedObservation = {
        id: 'protected-old',
        target: 'directory',
        kind: 'http',
        at: new Date(now - 3600000).toISOString(),
        success: false,
        latencyMs: 1,
        reason: 'unexpected-status',
        detail: { status: 503 },
      };
    s.store.put('sandbox', 'observation', protectedObservation.id, protectedObservation);
    s.store.put('sandbox', 'incident', 'retention-case', {
      id: 'retention-case',
      target: 'directory',
      status: 'resolved',
      detectedAt: protectedObservation.at,
      version: 4,
      evidence: [protectedObservation.id],
      notes: [],
      runbookVersion: '1.0.0',
    });
    for (let i = 0; i < 5000; i++)
      s.store.put('sandbox', 'observation', 'retained-' + i, {
        ...protectedObservation,
        id: 'retained-' + i,
        at: new Date(now - 1000).toISOString(),
        success: true,
      });
    await s.service.collect(operator);
    assert.ok(s.store.get('sandbox', 'observation', protectedObservation.id));
    assert.ok(s.store.count('sandbox', 'observation') < 5000);
    assert.ok(s.store.audits('sandbox').some((a) => a.action === 'observation.retention'));
  } finally {
    await s.close();
  }
});
