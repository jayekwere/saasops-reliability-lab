import { performance } from 'node:perf_hooks';
import { Resolver } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { fixedUrl } from './net.js';
import { Id, Text, Fault } from './security.js';
const Base = {
  id: Id,
  label: Text,
  dependencies: z.array(Id).max(10),
  expectedIntervalSeconds: z.number().int().min(5).max(300),
  objective: z.number().min(0.9).max(0.9999),
};
export const TargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...Base,
      kind: z.literal('http'),
      url: z.url(),
      expectedStatus: z.number().int().min(200).max(399),
    })
    .strict(),
  z
    .object({
      ...Base,
      kind: z.literal('dns'),
      hostname: z.string().regex(/^[a-zA-Z0-9.-]{1,253}$/),
      expectedAddresses: z.array(z.ipv4()).min(1).max(10),
      resolver: z.string().max(100).optional(),
    })
    .strict(),
  z
    .object({
      ...Base,
      kind: z.literal('tls'),
      hostname: z.string().regex(/^[a-zA-Z0-9.-]{1,253}$/),
      port: z.number().int().min(1).max(65535),
      minimumDays: z.number().int().min(0).max(90),
    })
    .strict(),
]);
export type Target = z.infer<typeof TargetSchema>;
export interface Observation {
  id: string;
  target: string;
  kind: Target['kind'];
  at: string;
  success: boolean;
  latencyMs: number;
  reason: string;
  detail: Record<string, unknown>;
}
export function targets(input: unknown, allowLocal = false): Target[] {
  const items = z.array(TargetSchema).min(1).max(20).parse(input);
  if (new Set(items.map((t) => t.id)).size !== items.length) throw new Error('Duplicate target');
  for (const t of items) {
    if (
      t.dependencies.includes(t.id) ||
      t.dependencies.some((id) => !items.some((x) => x.id === id))
    )
      throw new Error('Unknown or self dependency');
    if (t.kind === 'http') {
      const u = fixedUrl(t.url, allowLocal);
      if (!allowLocal && u.protocol !== 'https:') throw new Error('HTTPS required');
    }
    if (t.kind === 'dns' && t.resolver && !allowLocal)
      throw new Error('Custom DNS resolvers are restricted to the local lab');
  }
  const visit = (id: string, stack: Set<string>) => {
    if (stack.has(id)) throw new Error('Cyclic dependency');
    for (const dep of items.find((x) => x.id === id)!.dependencies)
      visit(dep, new Set([...stack, id]));
  };
  for (const t of items) visit(t.id, new Set());
  return items;
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');
function publicAddress(address: string) {
  return !blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
/** Resolve once per probe and pin the checked address at the socket boundary for TLS. */
async function addresses(host: string, allowLocal: boolean) {
  const list = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!list.length || (!allowLocal && list.some((x) => !publicAddress(x.address))))
    throw new Fault(403, 'probe_destination_rejected');
  return list;
}
export async function probe(
  target: Target,
  options: { allowLocal?: boolean; ca?: string; timeout?: number; now?: () => number } = {},
): Promise<Omit<Observation, 'id'>> {
  const start = performance.now(),
    at = new Date((options.now ?? Date.now)()).toISOString(),
    allowLocal = options.allowLocal ?? false,
    timeout = options.timeout ?? 2000;
  let success = false,
    reason = 'unavailable',
    detail: Record<string, unknown> = {};
  try {
    if (target.kind === 'http') {
      const url = fixedUrl(target.url, allowLocal),
        hostname = url.hostname.replace(/^\[|\]$/g, ''),
        resolved = await addresses(hostname, allowLocal),
        address = resolved.find((x) => x.family === 4) ?? resolved[0]!;
      const status = await new Promise<number>((resolve, reject) => {
        const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const request = requester(
          {
            protocol: url.protocol,
            hostname: address.address,
            port: url.port || undefined,
            path: url.pathname,
            method: 'GET',
            servername: isIP(hostname) ? '' : hostname,
            headers: { host: url.host, 'user-agent': 'saasops-reliability-lab/1.0' },
            agent: false,
            maxHeaderSize: 16384,
            rejectUnauthorized: true,
            ...(options.ca ? { ca: options.ca } : {}),
          },
          (response) => {
            const status = response.statusCode ?? 0;
            response.destroy();
            resolve(status);
          },
        );
        request.setTimeout(timeout, () => request.destroy(new Error('timeout')));
        request.once('error', reject);
        request.end();
      });
      success = status === target.expectedStatus;
      reason = success ? 'expected-status' : 'unexpected-status';
      detail = { status, expected: target.expectedStatus };
    } else if (target.kind === 'dns') {
      const resolver = new Resolver({ timeout, tries: 1 });
      if (target.resolver) resolver.setServers([target.resolver]);
      const records = await resolver.resolve4(target.hostname);
      success =
        records.length > 0 &&
        records.every((a) => target.expectedAddresses.includes(a)) &&
        target.expectedAddresses.every((a) => records.includes(a));
      reason = success ? 'expected-addresses' : 'dns-answer-mismatch';
      detail = { addresses: records.sort(), expected: target.expectedAddresses };
    } else {
      const choices = await addresses(target.hostname, allowLocal),
        address = choices.find((x) => x.family === 4) ?? choices[0]!;
      const info = await new Promise<{ days: number; authorized: boolean }>((resolve, reject) => {
        const socket = tlsConnect(
          {
            host: address.address,
            port: target.port,
            ...(isIP(target.hostname) ? {} : { servername: target.hostname }),
            rejectUnauthorized: true,
            ...(options.ca ? { ca: options.ca } : {}),
          },
          () => {
            const certificate = socket.getPeerCertificate();
            const days = (Date.parse(certificate.valid_to) - Date.now()) / 86400000;
            const authorized = socket.authorized;
            socket.end();
            resolve({ days, authorized });
          },
        );
        socket.setTimeout(timeout, () => {
          socket.destroy();
          reject(new Error('timeout'));
        });
        socket.once('error', reject);
      });
      success = info.authorized && info.days >= target.minimumDays;
      reason = success ? 'trusted-certificate' : 'certificate-expiring';
      detail = { remainingDays: Math.floor(info.days), minimumDays: target.minimumDays };
    }
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? String(e.code) : '';
    reason =
      code === 'ENOTFOUND' || code === 'ENODATA'
        ? 'dns-unavailable'
        : code.includes('CERT') || code.includes('TLS')
          ? 'tls-validation-failed'
          : e instanceof Fault
            ? e.code
            : 'probe-unavailable';
    detail = { code: /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'unavailable' };
  }
  return {
    target: target.id,
    kind: target.kind,
    at,
    success,
    latencyMs: Math.round((performance.now() - start) * 100) / 100,
    reason,
    detail,
  };
}
