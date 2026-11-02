import Fastify from 'fastify';
import { createSocket } from 'node:dgram';
import type { Target } from './probes.js';
export async function startLab() {
  const faults = { directory: false, workspace: false, dns: false };
  const app = Fastify({ logger: false });
  app.get('/directory', async (_req, reply) =>
    reply
      .status(faults.directory ? 503 : 200)
      .send({ service: 'directory', mode: 'local-fault-lab' }),
  );
  app.get('/workspace', async (_req, reply) =>
    reply
      .status(faults.workspace || faults.directory ? 503 : 200)
      .send({ service: 'workspace', mode: 'local-fault-lab' }),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Lab bind failed');
  const dns = createSocket('udp4');
  dns.on('message', (msg, remote) => {
    if (msg.length < 17 || msg.length > 512) return;
    let i = 12;
    const labels: string[] = [];
    while (i < msg.length && msg[i] !== 0) {
      const length = msg[i]!;
      if (length > 63 || i + length + 1 >= msg.length) return;
      labels.push(msg.subarray(i + 1, i + 1 + length).toString('ascii'));
      i += length + 1;
    }
    if (i + 5 > msg.length) return;
    const question = msg.subarray(12, i + 5),
      name = labels.join('.'),
      success = name === 'directory.lab.test' && !faults.dns && msg.readUInt16BE(i + 1) === 1;
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2);
    header.writeUInt16BE(success ? 0x8180 : 0x8183, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(success ? 1 : 0, 6);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 1]);
    dns.send(
      Buffer.concat([header, question, ...(success ? [answer] : [])]),
      remote.port,
      remote.address,
    );
  });
  await new Promise<void>((resolve) => dns.bind(0, '127.0.0.1', resolve));
  const dnsAddress = dns.address();
  const targets: Target[] = [
    {
      id: 'directory',
      label: 'Directory sign-in',
      kind: 'http',
      url: `http://127.0.0.1:${address.port}/directory`,
      expectedStatus: 200,
      dependencies: ['directory-dns'],
      expectedIntervalSeconds: 30,
      objective: 0.99,
    },
    {
      id: 'workspace',
      label: 'Workspace access',
      kind: 'http',
      url: `http://127.0.0.1:${address.port}/workspace`,
      expectedStatus: 200,
      dependencies: ['directory'],
      expectedIntervalSeconds: 30,
      objective: 0.99,
    },
    {
      id: 'directory-dns',
      label: 'Directory DNS',
      kind: 'dns',
      hostname: 'directory.lab.test',
      expectedAddresses: ['127.0.0.1'],
      resolver: `127.0.0.1:${dnsAddress.port}`,
      dependencies: [],
      expectedIntervalSeconds: 30,
      objective: 0.99,
    },
  ];
  return {
    faults,
    targets,
    close: async () => {
      await app.close();
      await new Promise<void>((resolve) => dns.close(() => resolve()));
    },
  };
}
