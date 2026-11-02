const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
let token = '',
  roleList: string[] = [];
function el(tag: string, text = '', className = '') {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = className;
  return n;
}
function notice(message: string, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
function failure(e: unknown) {
  notice(e instanceof Error ? e.message : 'Request failed', true);
}
async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
function badge(text: string) {
  return el('span', text, 'badge state-' + text);
}
function addCell(row: HTMLElement, text: string, cls = '') {
  const n = el('td', text, cls);
  row.append(n);
  return n;
}
function option(select: HTMLElement, id: string, label: string) {
  const node = el('option', label) as HTMLOptionElement;
  node.value = id;
  select.append(node);
}
function download(data: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function audit(events: any[]) {
  const root = $('audit');
  root.replaceChildren();
  for (const event of events.slice(0, 8)) {
    const row = el('tr');
    addCell(row, new Date(event.at).toLocaleTimeString([], { hour12: false }), 'mono');
    addCell(row, event.actor);
    const c = addCell(row, '');
    c.append(el('b', event.action), el('small', '#' + event.seq + ' · ' + event.hash.slice(0, 10)));
    root.append(row);
  }
  if (!events.length) {
    const row = el('tr');
    const c = addCell(row, 'No recorded activity.');
    c.setAttribute('colspan', '3');
    root.append(row);
  }
}
function button(label: string, action: () => Promise<unknown>, cls = 'ghost') {
  const b = el('button', label, cls) as HTMLButtonElement;
  b.onclick = () => {
    b.disabled = true;
    void action()
      .catch(failure)
      .finally(() => {
        b.disabled = false;
      });
  };
  return b;
}
async function mutate(path: string, body: unknown, message: string) {
  const result = await api(path, 'POST', body);
  notice(message);
  await refresh();
  return result;
}
$('connect').onclick = () => {
  token = value('token');
  void api('/api/me')
    .then(async (me) => {
      roleList = me.roles;
      $('status').textContent = me.subject + ' · ' + me.roles.join(', ');
      notice('Connected to ' + me.tenant + '. Your role controls the actions available here.');
      await refresh();
    })
    .catch(failure);
};
$('refresh').onclick = () => void refresh().catch(failure);
function approvals(plans: any[], extra?: (p: any, container: HTMLElement) => void) {
  const root = $('plans');
  root.replaceChildren();
  if (!plans.length) {
    root.className = 'empty';
    root.textContent = 'No plans created yet.';
    return;
  }
  root.className = '';
  for (const p of plans) {
    const record = el('article', '', 'record');
    record.dataset.planId = p.id;
    const top = el('header');
    top.append(el('h3', planTitle(p)), badge(p.status));
    record.append(
      top,
      el(
        'p',
        'Requested by ' +
          p.binding.requestedBy +
          ' · ' +
          new Date(p.binding.expiresAt).toLocaleTimeString() +
          ' expiry',
      ),
      el('p', p.digest, 'evidence'),
    );
    const actions = el('div', '', 'row-actions');
    if (roleList.includes('reviewer') && p.status === 'planned') {
      actions.append(
        button(
          'Approve',
          () =>
            mutate(
              '/api/plans/' + p.id + '/review',
              { digest: p.digest, approve: true },
              'Approval granted for this exact plan.',
            ),
          'primary',
        ),
        button('Reject', () =>
          mutate(
            '/api/plans/' + p.id + '/review',
            { digest: p.digest, approve: false },
            'Plan rejected.',
          ),
        ),
      );
    }
    if (roleList.includes('operator') && ['approved', 'blocked'].includes(p.status))
      actions.append(
        button(
          p.status === 'blocked' ? 'Retry known blocked step' : 'Execute',
          () =>
            mutate(
              '/api/plans/' + p.id + '/execute',
              { digest: p.digest, key: p.executionKey ?? 'execute-' + p.id },
              'Execution recorded. Inspect the result and any remaining work.',
            ),
          'primary',
        ),
      );
    actions.append(button('Export evidence', async () => download(p, 'plan-evidence.json')));
    record.append(actions);
    extra?.(p, record);
    root.append(record);
  }
}

let configVersion = 0;
function planTitle(p: any) {
  return 'Restore service catalog · ' + p.binding.data.backupId.slice(0, 8);
}
async function refresh() {
  const d = await api('/api/overview');
  for (const id of [
    'collect',
    'backup',
    'change-objective',
    'interrupt',
    'interrupt-dns',
    'recover',
  ])
    $<HTMLButtonElement>(id).disabled = !roleList.includes('operator');
  $<HTMLButtonElement>('plan-restore').disabled = !roleList.includes('requester');
  configVersion = d.configVersion ?? 0;
  $('fault').hidden = !d.demo;
  $('healthy-count').textContent = String(
    d.services.filter((s: any) => s.state === 'healthy').length,
  );
  $('failing-count').textContent = String(
    d.services.filter((s: any) => s.state === 'failing').length,
  );
  $('incident-count').textContent = String(
    d.incidents.filter((i: any) => i.status !== 'resolved').length,
  );
  $('observation-count').textContent = String(d.observations.length);
  const root = $('services');
  root.replaceChildren();
  root.className = d.services.length ? '' : 'empty';
  if (!d.services.length) root.textContent = 'No configured service catalog in this tenant.';
  const target = $('objective-target');
  target.replaceChildren();
  for (const s of d.services) {
    option(target, s.id, s.label);
    const row = el('article', '', 'service');
    const head = el('header');
    head.append(el('h3', s.label), badge(s.state));
    const numbers = el('div', '', 'service-metrics');
    for (const [v, label] of [
      [s.latest ? s.latest.latencyMs + ' ms' : 'Unknown', 'Latest latency'],
      [s.samples, 'Observed samples'],
      [(s.objective * 100).toFixed(2) + '%', 'Objective'],
    ]) {
      const item = el('div');
      item.append(el('b', String(v)), el('small', String(label)));
      numbers.append(item);
    }
    row.append(
      head,
      numbers,
      el('p', (s.latest?.reason ?? 'No observations') + ' · ' + s.kind.toUpperCase()),
      el(
        'p',
        s.eligible
          ? 'Sufficient fresh, regularly spaced samples for the displayed window.'
          : 'Window incomplete. Sample ratios are descriptive only.',
        'subtle',
      ),
    );
    root.append(row);
  }
  const incidents = $('incidents');
  incidents.replaceChildren();
  incidents.className = d.incidents.length ? '' : 'empty';
  if (!d.incidents.length)
    incidents.textContent = 'No incidents. Two consecutive recent failures open a case.';
  for (const i of d.incidents) {
    const row = el('article', '', 'record');
    row.dataset.incidentId = i.id;
    const head = el('header');
    head.append(el('h3', i.target + ' · incident ' + i.id.slice(0, 8)), badge(i.status));
    row.append(
      head,
      el(
        'p',
        'Detected ' +
          new Date(i.detectedAt).toLocaleString() +
          ' · ' +
          i.evidence.length +
          ' evidence references',
      ),
    );
    for (const n of i.notes) row.append(el('p', n.actor + ': ' + n.text));
    const actions = el('div', '', 'row-actions');
    const next: Record<string, string> = {
      open: 'acknowledged',
      acknowledged: 'monitoring',
      monitoring: 'resolved',
    };
    if (roleList.includes('operator') && next[i.status])
      actions.append(
        button(
          next[i.status] === 'resolved'
            ? 'Resolve with fresh evidence'
            : next[i.status] === 'monitoring'
              ? 'Start monitoring'
              : 'Acknowledge',
          () =>
            mutate(
              '/api/incidents/' + i.id,
              { version: i.version, status: next[i.status], note: value('incident-note') },
              'Incident transition recorded.',
            ),
        ),
      );
    actions.append(
      button('Export investigation', async () =>
        download(await api('/api/incidents/' + i.id + '/export'), 'investigation.json'),
      ),
    );
    row.append(actions);
    incidents.append(row);
  }
  const select = $('backup-select'),
    previous = value('backup-select');
  select.replaceChildren();
  for (const b of d.backups)
    option(
      select,
      b.id,
      new Date(b.payload.at).toLocaleTimeString() + ' · ' + b.digest.slice(0, 10),
    );
  if (previous && d.backups.some((b: any) => b.id === previous))
    $<HTMLSelectElement>('backup-select').value = previous;
  approvals(d.plans);
  audit(d.audit);
  const deps = $('dependencies');
  deps.replaceChildren();
  for (const s of d.services)
    deps.append(el('p', s.id + ' ← ' + (s.dependencies.join(', ') || 'no declared dependencies')));
  for (const candidate of d.dependencies)
    if (candidate.candidateDependencies.length)
      deps.append(
        el('p', candidate.target + ': investigate ' + candidate.candidateDependencies.join(', ')),
      );
  deps.append(
    el('p', 'Dependency overlap is an investigation lead, not proof of root cause.', 'subtle'),
  );
}
$('collect').onclick = () =>
  void mutate('/api/collect', {}, 'Probe observations recorded.').catch(failure);
for (const [id, directory, dns] of [
  ['interrupt', true, false],
  ['interrupt-dns', false, true],
  ['recover', false, false],
] as const)
  $(id).onclick = () =>
    void mutate(
      '/api/demo/fault',
      { directory, workspace: false, dns },
      id === 'recover'
        ? 'Local fault cleared. Collect fresh evidence to verify recovery.'
        : 'Local lab fault enabled.',
    ).catch(failure);
$('backup').onclick = () =>
  void mutate('/api/backups', {}, 'Signed catalog backup recorded.').catch(failure);
$('plan-restore').onclick = () =>
  void mutate(
    '/api/plans',
    { backupId: value('backup-select') },
    'Restore plan created for independent review.',
  ).catch(failure);
$('change-objective').onclick = () =>
  void mutate(
    '/api/objective',
    {
      version: configVersion,
      target: value('objective-target'),
      objective: Number(value('objective')),
    },
    'Objective change recorded. Existing observations are unchanged.',
  ).catch(failure);

$('disconnect').onclick = () => {
  token = '';
  roleList = [];
  location.reload();
};
