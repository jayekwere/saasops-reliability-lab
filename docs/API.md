# API

All `/api/*` requests require signed access tokens. The server registry supplies tenant and roles. Inputs are strict JSON. The target catalog comes from trusted configuration rather than request payloads.

| Route                           | Role                       | Contract                                                           |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `GET /api/overview`             | Workflow/view roles        | Scoped services, incidents, observations, backups, plans and audit |
| `POST /api/collect`             | Operator                   | Empty object; probe the stored catalog only                        |
| `POST /api/incidents/:id`       | Operator                   | `{version,status: acknowledged/monitoring/resolved,note}`          |
| `GET /api/incidents/:id/export` | Viewer, operator           | Incident, referenced observations and runbook                      |
| `POST /api/backups`             | Operator                   | Empty object; signed current catalog snapshot                      |
| `POST /api/objective`           | Operator                   | `{version,target,objective}`; objective 0.90 through 0.9999        |
| `POST /api/plans`               | Requester                  | `{backupId}`; exact current state bound for restore                |
| `POST /api/plans/:id/review`    | Independent reviewer       | `{digest,approve}`                                                 |
| `POST /api/plans/:id/execute`   | Independent operator       | `{digest,key}`; transactionally verified catalog restore           |
| `GET /api/audit`                | Viewer, reviewer, operator | Scoped evidence and full-chain integrity                           |
| `POST /api/demo/fault`          | Operator, demo only        | `{directory,workspace,dns}` booleans                               |

Notes are 10 to 2,000 characters and capped at 100 per incident. They are operational records and must not contain secrets. Incident state/version conflicts and missing fresh recovery evidence return 409. A premature resolve cannot close an incident. Foreign IDs return 404. Collection in progress returns 409 and calls inside the minimum interval return 429. Input/credential/origin failures, size bounds and unexpected errors use stable generic codes.

The API does not upload or restore arbitrary configuration files. Backup payloads originate inside the service and signatures are checked again at plan and execute time. The viewer can inspect exported evidence but cannot change an objective, collect a probe, inject a fault, restore a catalog or close an incident. Requester and reviewer roles authorize the corresponding stage, not a self-approved restore.
