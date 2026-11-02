import { readFileSync } from 'node:fs';
import { configuration } from './config.js';
import { Store } from './store.js';
import { targets } from './probes.js';
import { startLab } from './lab.js';
import { createApp } from './app.js';
import { Id, type Identity } from './security.js';
const c = await configuration('saasops-reliability-lab', 4430),
  store = new Store(c.db, c.key);
if (c.demo && c.db !== ':memory:')
  throw new Error('The ephemeral fault lab requires in-memory core storage');
const lab = c.demo ? await startLab() : null;
if (!lab && !process.env.TARGET_CONFIG) throw new Error('TARGET_CONFIG required');
const configured =
  lab?.targets ?? targets(JSON.parse(readFileSync(process.env.TARGET_CONFIG!, 'utf8')));
const { app, service } = createApp({
  auth: c.auth,
  store,
  baseUrl: c.baseUrl,
  targets: configured,
  allowLocal: c.demo,
  tenant: Id.parse(process.env.TENANT_ID ?? 'sandbox'),
  ...(lab ? { faults: lab.faults } : {}),
});
await app.listen({ port: c.port, host: c.host });
console.log(`SaaSOps Reliability Lab listening at ${c.baseUrl}`);
if (c.demo)
  console.log('Ephemeral demo tokens (15 minutes):\n' + JSON.stringify(c.tokens, null, 2));
let timer: ReturnType<typeof setInterval> | undefined;
if (process.env.AUTO_COLLECT === '1') {
  const collector: Identity = {
    tenant: Id.parse(process.env.TENANT_ID ?? 'sandbox'),
    subject: 'scheduled-collector',
    roles: ['operator'],
  };
  timer = setInterval(() => {
    void service
      .collect(collector)
      .catch(() => console.error('Scheduled collection failed; inspect availability and capacity'));
  }, 30000);
  timer.unref();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (timer) clearInterval(timer);
    void app
      .close()
      .then(() => lab?.close())
      .then(() => {
        store.close();
        process.exit(0);
      });
  });
