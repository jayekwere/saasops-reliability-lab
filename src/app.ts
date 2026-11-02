import { z } from 'zod';
import { Auth, requireRole, Fault } from './security.js';
import { Store } from './store.js';
import { secureApp, planRoutes, idParam, ExecuteSchema } from './http.js';
import { Reliability, runbook } from './reliability.js';
import type { Target } from './probes.js';
export function createApp(o: {
  auth: Auth;
  store: Store;
  baseUrl: string;
  targets: Target[];
  allowLocal?: boolean;
  webRoot?: string;
  tenant?: string;
  faults?: { directory: boolean; workspace: boolean; dns: boolean };
}) {
  const ownerTenant = o.tenant ?? 'sandbox';
  const app = secureApp(o.auth, o.store, o.baseUrl, o.webRoot),
    service = new Reliability(o.store, o.targets, o.allowLocal, {}, ownerTenant);
  planRoutes(app, service.book);
  app.get('/api/overview', async (req) => {
    requireRole(req.identity, 'viewer', 'operator', 'requester', 'reviewer');
    let config;
    try {
      config = service.config(req.identity);
    } catch (e) {
      if (e instanceof Fault && e.status === 404)
        return {
          services: [],
          incidents: [],
          observations: [],
          backups: [],
          plans: [],
          dependencies: [],
          audit: [],
          integrity: o.store.verify(),
          runbook,
        };
      throw e;
    }
    return {
      demo: !!o.faults,
      services: service.score(req.identity),
      incidents: service.incidents(req.identity),
      observations: service.observations(req.identity).slice(0, 50),
      backups: o.store.list(req.identity.tenant, 'backup'),
      plans: service.book.list(req.identity),
      dependencies: service.dependencies(req.identity),
      configVersion: config.version,
      audit: o.store.audits(req.identity.tenant, 30),
      integrity: o.store.verify(),
      runbook,
    };
  });
  app.post('/api/collect', async (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return service.collect(req.identity);
  });
  app.post('/api/incidents/:id', async (req) =>
    service.transition(req.identity, idParam(req), req.body),
  );
  app.get('/api/incidents/:id/export', async (req) => service.export(req.identity, idParam(req)));
  app.post('/api/backups', async (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return service.backup(req.identity);
  });
  app.post('/api/objective', async (req) => service.changeObjective(req.identity, req.body));
  app.post('/api/plans', async (req, reply) =>
    reply.status(201).send(service.planRestore(req.identity, req.body)),
  );
  app.post('/api/plans/:id/execute', async (req) => {
    const b = ExecuteSchema.parse(req.body);
    return service.restore(req.identity, idParam(req), b.digest, b.key);
  });
  if (o.faults)
    app.post('/api/demo/fault', async (req) => {
      requireRole(req.identity, 'operator');
      if (req.identity.tenant !== ownerTenant) throw new Fault(403, 'demo_tenant_not_authorized');
      const b = z
        .object({ directory: z.boolean(), workspace: z.boolean(), dns: z.boolean() })
        .strict()
        .parse(req.body);
      o.store.tx(() => o.store.audit(req.identity, 'demo.fault-changed', 'completed', b));
      Object.assign(o.faults!, b);
      return { scope: 'local-http-and-dns-lab', ...b };
    });
  return { app, service };
}
