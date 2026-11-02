# Security review and remediation

Source release: **1.0.1**. Reviewed baseline: [1ff2b9d](https://github.com/jayekwere/saasops-reliability-lab/tree/1ff2b9d284d7fd5191d9989a725a73156e8ba2f6).

The review covered application source, API and browser boundaries, startup/configuration, storage, tests, fixtures, container and CI definitions. It used a fresh independent baseline reviewer and architecture reviewer, parent source validation, a pre-patch compatibility investigation and one fresh patch-review cycle. This was an agent-assisted source review with synthetic validation. No independent external penetration test or live provider acceptance was performed. Third-party package internals were not fully audited; generated receipts and visual assets received targeted review.

| Confirmed issue                                                                                                | Severity | Remediation                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Slow upstream progress or address lookup could outlive the probe timeout and retain the tenant collection lock | Medium   | Start one total deadline before resolution; cancel owned DNS work, destroy sockets/requests and fence late address results before connection. |
| Foreign-tenant operator could change sandbox HTTP/DNS fault flags                                              | Low      | Bind fault controls to the explicit catalog owner, including the default tenant, and audit before changing flags.                             |

The new slow-header and foreign-operator regressions failed against an isolated v1.0.0 source copy. Patched tests use actual trickling HTTP headers, silent TLS/DNS peers, delayed lookup results, repeated collection with a healthy later target, non-default tenant ownership and audit-failure rollback. A separate patch review found no surviving route through these controls. Shared tenant audit budgets were propagated from the EndpointOps resource fix.

## Validation

The patched source passed formatting, strict types, build, 42 automated tests, 1 browser workflows and its restricted container demo. Containers independently repeat the suite under Node 24; host runs use Node 26. The recorded locked-dependency query reports zero advisories, which is time-sensitive and does not scan every base-image package. [Validation record](../evidence/VALIDATION.md), [test/coverage transcript](../evidence/coverage.txt), [browser results](../evidence/browser.txt), [container results](../evidence/container-smoke.txt) and [source fingerprints](../evidence/source-manifest.json) retain the evidence. Hosted CI is linked from the README and must be assessed for its exact commit.

## Capacity and deployment limits

Audit history retains a 100,000-entry global cap and a 10,000-entry tenant cap. Counts derive from complete persisted history, so restart cannot clear them. The existing audit body/HMAC format is retained and indexes are additive. A database already beyond a new limit remains readable and verifiable but refuses affected new audited mutations. One tenant cannot consume an otherwise empty global budget, but many tenants or legacy history can still reach the shared bound. This is bounded reference-service storage, without automatic archive, quota reset or state migration. Preserve authenticated history and operational state during reviewed maintenance. External effects cannot be undone by a later SQLite capacity failure. See [operations](OPERATIONS.md).

Native OS lookup may finish in the background after the caller's deadline; its late result cannot open a socket. Event-loop timing is not hard real time. Collection is sequential, at most 20 targets, so default whole-collection duration may approach 40 seconds. Recovery changes only the local catalog and no external SaaS administration was accepted live.

The issuer, host, trusted configuration, TLS termination, private credentials and independent audit checkpoints remain deployment responsibilities. Coverage and passing tests establish the checked behavior; they do not certify every possible input or deployment. Copied documentation claims were corrected to match this repository's implemented interfaces.
