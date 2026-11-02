import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { Approvals } from './approvals.js';
import { digest, Fault, requireRole, type Identity, Id } from './security.js';
import { probe, targets, type Target, type Observation } from './probes.js';
export interface Incident {
  id: string;
  target: string;
  status: 'open' | 'acknowledged' | 'monitoring' | 'resolved';
  detectedAt: string;
  version: number;
  evidence: string[];
  notes: { at: string; actor: string; text: string }[];
  resolvedAt?: string;
  runbookVersion: string;
}
interface Restore {
  backupId: string;
  backupDigest: string;
  before: string;
}
export const runbook = {
  version: '1.0.0',
  steps: [
    'Identify the failing probe and affected dependencies',
    'Check DNS, TLS, status and recent changes using the recorded evidence',
    'Restore the intended configuration through an approved operation',
    'Collect two fresh successful observations',
    'Record cause, impact, recovery, and follow-up actions',
  ],
};
export class Reliability {
  readonly book: Approvals<Restore>;
  private inFlight = new Set<string>();
  constructor(
    readonly store: Store,
    initial: Target[],
    readonly allowLocal = false,
    private probeOptions: { ca?: string; timeout?: number } = {},
    tenant = 'sandbox',
  ) {
    this.book = new Approvals(store, digest(runbook));
    if (!store.get(tenant, 'config', 'catalog'))
      store.put(tenant, 'config', 'catalog', { version: 1, targets: targets(initial, allowLocal) });
  }
  config(actor: Identity) {
    return this.store.need<{ version: number; targets: Target[] }>(
      actor.tenant,
      'config',
      'catalog',
    );
  }
  observations(actor: Identity) {
    return this.store.list<Observation>(actor.tenant, 'observation', 10000);
  }
  incidents(actor: Identity) {
    return this.store.list<Incident>(actor.tenant, 'incident');
  }
  score(actor: Identity) {
    const observations = this.observations(actor),
      now = this.store.now();
    return this.config(actor).targets.map((target) => {
      const rows = observations
        .filter(
          (o) =>
            o.target === target.id && now - Date.parse(o.at) <= 3600000 && Date.parse(o.at) <= now,
        )
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const good = rows.filter((o) => o.success).length;
      const ratio = rows.length ? good / rows.length : null;
      const recent = rows.at(-1),
        fresh = recent
          ? now - Date.parse(recent.at) <= target.expectedIntervalSeconds * 2000
          : false;
      return {
        id: target.id,
        label: target.label,
        kind: target.kind,
        dependencies: target.dependencies,
        objective: target.objective,
        samples: rows.length,
        good,
        successRatio: ratio,
        errorBudgetRemainingSamples: rows.length
          ? Math.max(0, rows.length * (1 - target.objective) - (rows.length - good))
          : null,
        burnRate: ratio === null ? null : (1 - ratio) / (1 - target.objective),
        state: !fresh ? 'unknown' : recent!.success ? 'healthy' : 'failing',
        eligible:
          rows.length >= 6 &&
          fresh &&
          Date.parse(rows.at(-1)!.at) - Date.parse(rows[0]!.at) >=
            Math.max(3420000, 3600000 - target.expectedIntervalSeconds * 2000) &&
          rows.every(
            (r, i) =>
              i === 0 ||
              Date.parse(r.at) - Date.parse(rows[i - 1]!.at) <=
                target.expectedIntervalSeconds * 2000,
          ),
        window: 'last-hour-probe-samples',
        latest: recent ?? null,
      };
    });
  }
  async collect(actor: Identity) {
    requireRole(actor, 'operator');
    if (this.inFlight.has(actor.tenant)) throw new Fault(409, 'collection_in_progress');
    this.inFlight.add(actor.tenant);
    try {
      const config = this.config(actor),
        output: Observation[] = [];
      for (const target of config.targets) {
        const previous = this.observations(actor).find((o) => o.target === target.id);
        if (previous && this.store.now() - Date.parse(previous.at) < 500)
          throw new Fault(429, 'probe_minimum_interval');
        const observed = await probe(target, {
          allowLocal: this.allowLocal,
          ...this.probeOptions,
          now: this.store.now,
        });
        const result: Observation = { ...observed, id: randomUUID() };
        this.store.tx(() => {
          if (this.config(actor).version !== config.version)
            throw new Fault(409, 'configuration_changed');
          const retained = this.observations(actor);
          if (retained.length >= 5000) {
            const protectedIds = new Set(this.incidents(actor).flatMap((i) => i.evidence));
            let removed = 0;
            for (const old of retained.slice(4000))
              if (!protectedIds.has(old.id)) {
                this.store.remove(actor.tenant, 'observation', old.id);
                removed++;
              }
            if (removed)
              this.store.audit(actor, 'observation.retention', 'completed', {
                removed,
                protectedIncidentEvidence: true,
              });
          }
          if (this.store.count(actor.tenant, 'observation') >= 10000)
            throw new Fault(409, 'observation_capacity_reached');
          this.store.put(actor.tenant, 'observation', result.id, result);
          this.store.audit(actor, 'probe.observed', result.success ? 'success' : 'failure', {
            id: result.id,
            target: result.target,
            reason: result.reason,
          });
          const previousRows = this.observations(actor).filter((o) => o.target === target.id);
          const pair = previousRows.slice(0, 2);
          if (
            pair.length === 2 &&
            pair.every((o) => !o.success) &&
            Date.parse(pair[0]!.at) - Date.parse(pair[1]!.at) <=
              target.expectedIntervalSeconds * 2000 &&
            !this.incidents(actor).some((i) => i.target === target.id && i.status !== 'resolved')
          ) {
            if (this.store.count(actor.tenant, 'incident') >= 200)
              throw new Fault(409, 'incident_capacity_reached');
            const incident: Incident = {
              id: randomUUID(),
              target: target.id,
              status: 'open',
              detectedAt: result.at,
              version: 1,
              evidence: pair.map((o) => o.id),
              notes: [],
              runbookVersion: runbook.version,
            };
            this.store.put(actor.tenant, 'incident', incident.id, incident);
            this.store.audit(actor, 'incident.opened', 'open', {
              id: incident.id,
              target: target.id,
            });
          }
        });
        output.push(result);
      }
      return { observations: output, configVersion: config.version };
    } finally {
      this.inFlight.delete(actor.tenant);
    }
  }
  transition(actor: Identity, id: string, input: unknown) {
    requireRole(actor, 'operator');
    const b = z
      .object({
        version: z.number().int().positive(),
        status: z.enum(['acknowledged', 'monitoring', 'resolved']),
        note: z.string().min(10).max(2000),
      })
      .strict()
      .parse(input);
    return this.store.tx(() => {
      const incident = this.store.need<Incident>(actor.tenant, 'incident', id);
      const edges: Record<Incident['status'], string[]> = {
        open: ['acknowledged'],
        acknowledged: ['monitoring'],
        monitoring: ['resolved'],
        resolved: [],
      };
      if (incident.version !== b.version || !edges[incident.status].includes(b.status))
        throw new Fault(409, 'incident_state_or_version_conflict');
      if (incident.notes.length >= 100) throw new Fault(409, 'incident_note_capacity_reached');
      if (b.status === 'resolved') {
        const rows = this.observations(actor)
          .filter((o) => o.target === incident.target)
          .slice(0, 2);
        const interval = this.config(actor).targets.find(
          (t) => t.id === incident.target,
        )!.expectedIntervalSeconds;
        if (
          rows.length < 2 ||
          rows.some(
            (o) =>
              !o.success ||
              Date.parse(o.at) <= Date.parse(incident.detectedAt) ||
              this.store.now() - Date.parse(o.at) > interval * 2000,
          )
        )
          throw new Fault(409, 'two_fresh_successful_observations_required');
        incident.resolvedAt = new Date(this.store.now()).toISOString();
        incident.evidence.push(...rows.map((o) => o.id));
      }
      incident.status = b.status;
      incident.version++;
      incident.notes.push({
        at: new Date(this.store.now()).toISOString(),
        actor: actor.subject,
        text: b.note,
      });
      this.store.put(actor.tenant, 'incident', id, incident);
      this.store.audit(actor, 'incident.' + b.status, b.status, { id, version: incident.version });
      return incident;
    });
  }
  dependencies(actor: Identity) {
    const scores = this.score(actor);
    return scores
      .filter((s) => s.state === 'failing')
      .map((s) => ({
        target: s.id,
        candidateDependencies: s.dependencies.filter((id) =>
          scores.some((x) => x.id === id && x.state === 'failing'),
        ),
        conclusion: 'Candidate dependency overlap, not proof of root cause',
      }));
  }
  backup(actor: Identity) {
    requireRole(actor, 'operator');
    return this.store.tx(() => {
      if (this.store.count(actor.tenant, 'backup') >= 100)
        throw new Fault(409, 'backup_capacity_reached');
      const payload = {
          tenant: actor.tenant,
          at: new Date(this.store.now()).toISOString(),
          config: this.config(actor),
        },
        signature = this.store.sign(payload),
        id = randomUUID();
      const backup = { id, payload, signature, digest: digest(payload) };
      this.store.put(actor.tenant, 'backup', id, backup);
      this.store.audit(actor, 'configuration.backed-up', 'completed', {
        id,
        digest: backup.digest,
      });
      return backup;
    });
  }
  changeObjective(actor: Identity, input: unknown) {
    requireRole(actor, 'operator');
    const b = z
      .object({
        version: z.number().int().positive(),
        target: Id,
        objective: z.number().min(0.9).max(0.9999),
      })
      .strict()
      .parse(input);
    return this.store.tx(() => {
      const config = this.config(actor);
      if (config.version !== b.version) throw new Fault(409, 'configuration_version_changed');
      const t = config.targets.find((t) => t.id === b.target);
      if (!t) throw new Fault(404, 'target_not_found');
      t.objective = b.objective;
      config.version++;
      this.store.put(actor.tenant, 'config', 'catalog', config);
      this.store.audit(actor, 'configuration.objective-changed', 'completed', {
        target: t.id,
        objective: t.objective,
        version: config.version,
      });
      return config;
    });
  }
  planRestore(actor: Identity, input: unknown) {
    const b = z.object({ backupId: z.string().uuid() }).strict().parse(input);
    const backup = this.validBackup(actor, b.backupId);
    return this.book.plan(actor, {
      backupId: b.backupId,
      backupDigest: backup.digest,
      before: digest(this.config(actor)),
    });
  }
  private validBackup(actor: Identity, id: string) {
    const backup = this.store.need<{
      id: string;
      payload: { tenant: string; at: string; config: { version: number; targets: Target[] } };
      signature: string;
      digest: string;
    }>(actor.tenant, 'backup', id);
    if (
      backup.payload.tenant !== actor.tenant ||
      digest(backup.payload) !== backup.digest ||
      !this.store.check(backup.payload, backup.signature)
    )
      throw new Fault(409, 'backup_integrity_failed');
    targets(backup.payload.config.targets, this.allowLocal);
    return backup;
  }
  restore(actor: Identity, id: string, hash: string, key: string) {
    return this.store.tx(() => {
      const claim = this.book.claim(actor, id, hash, key);
      if (!claim.claimed) return claim.plan;
      const p = claim.plan,
        backup = this.validBackup(actor, p.binding.data.backupId),
        before = this.config(actor);
      if (digest(before) !== p.binding.data.before || backup.digest !== p.binding.data.backupDigest)
        throw new Fault(409, 'restore_inputs_changed');
      const after = { version: before.version + 1, targets: backup.payload.config.targets };
      this.store.put(actor.tenant, 'config', 'catalog', after);
      if (digest(this.config(actor).targets) !== digest(backup.payload.config.targets))
        throw new Fault(500, 'restore_readback_failed');
      return this.book.save(actor, p, 'completed', {
        verified: true,
        before: digest(before),
        after: digest(after),
        backup: backup.id,
        scope: 'service-catalog-configuration-only',
      });
    });
  }
  export(actor: Identity, id: string) {
    requireRole(actor, 'viewer', 'operator');
    const incident = this.store.need<Incident>(actor.tenant, 'incident', id);
    return {
      schemaVersion: 1,
      incident,
      observations: incident.evidence
        .map((id) => this.store.get<Observation>(actor.tenant, 'observation', id))
        .filter(Boolean),
      runbook,
      configDigest: digest(this.config(actor)),
      scope: 'recorded-probe-observations',
    };
  }
}
