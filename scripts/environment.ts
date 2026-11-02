import { demoAuth } from '../src/security.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { startLab } from '../src/lab.js';
export async function environment(baseUrl = 'http://127.0.0.1:4430') {
  const { auth, tokens } = await demoAuth('saasops-reliability-lab'),
    store = new Store(':memory:', 'k'.repeat(32));
  const lab = await startLab();
  const { app, service } = createApp({
    auth,
    store,
    baseUrl,
    targets: lab.targets,
    allowLocal: true,
    faults: lab.faults,
  });
  return {
    app,
    service,
    store,
    auth,
    tokens,
    lab,
    close: async () => {
      await app.close();
      await lab.close();
      store.close();
    },
  };
}
