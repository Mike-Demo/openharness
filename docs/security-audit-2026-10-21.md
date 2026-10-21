# Security audit triage — 2026-10-21

Parent: <https://github.com/Mike-Demo/openharness/issues/5>

Issue creation is unavailable in this session. The two issue titles and bodies below
are ready to file in Mike-Demo/openharness; they have **not** been filed. This document
is the requested draft-PR fallback, not a remediation. No application code was changed,
project code executed, or deployed endpoint probed for this triage.

## Prioritized backlog

| Order | Status | Item | Risk and fix rationale |
| --- | --- | --- | --- |
| 1 | Confirmed, low | Agent-key app listing escapes its machine scope | A caller with an accepted agent key and another machine's ID can list that machine's app inventory without its key or an SSO session. The demonstrated impact is metadata disclosure, not app contents, mutation, or code execution. Removing one query override is a small, localized fix. |
| Separate validation track | Needs validation; no severity assigned | Cookie-header passthrough and mesh-listener exposure | Resolve the external facts below before confirming either lead or assigning severity. Listing order is not a risk ranking. |

There is one confirmed finding and therefore one root-cause group. The two leads
have distinct claimed causes; neither is grouped with the confirmed finding.
Evidence links pin the inspected source to
`9d8d57ecc406a9b934a49ba7eac765dea0b44450`.

## Issue 1 — exact title

`[security][low] Bind GET /api/apps listings to the authenticated machine`

### Issue body

Parent audit: <https://github.com/Mike-Demo/openharness/issues/5>

**Status:** confirmed by static source inspection; no runtime reproduction.
**Severity:** low (retained from the parent audit).
**Fingerprint:** `apps-list-query-machineid-overrides-agent-binding`.
**Priority:** first and only confirmed remediation in this audit.

#### Evidence and reachability

- [Agent authentication](https://github.com/Mike-Demo/openharness/blob/9d8d57ecc406a9b934a49ba7eac765dea0b44450/backend/src/routes/apps.ts#L31-L51)
  derives a machine ID from `x-api-key`, validates the machine binding and status,
  and attaches the authenticated machine context.
- [SSO middleware](https://github.com/Mike-Demo/openharness/blob/9d8d57ecc406a9b934a49ba7eac765dea0b44450/backend/src/middlewares/authMiddleware.ts#L19-L47)
  skips `/api/apps`; this route still requires agent authentication and is not
  unauthenticated.
- [GET handler](https://github.com/Mike-Demo/openharness/blob/9d8d57ecc406a9b934a49ba7eac765dea0b44450/backend/src/routes/apps.ts#L96-L106)
  builds the Prisma predicate as:

  ```ts
  where: { machineId: machineId, ...(req.query.machineId ? { machineId: req.query.machineId } : {}) }
  ```

  JavaScript's later spread overwrites the authenticated `machineId`. A caller
  authenticated as machine A can supply `?machineId=B` to select B's records.
  The response includes subdomain, machine ID, public URL, and creation time.

The lower-trust caller needs an accepted agent key, a target machine ID, and
reachability to this route; disclosure also requires matching target records.
Production reachability and acquisition of target IDs were not established.
This is cross-machine app-inventory disclosure, not evidence of access to app
contents, credentials, or write operations.

#### Root cause

The database predicate treats the caller-controlled query value as higher
precedence than the authenticated machine binding, defeating the intended
authorization boundary.

#### Smallest proposed fix

Remove the query override spread and use only `where: { machineId }`, with
`machineId` taken from `agentCtx`. Preserve existing authentication and status
checks, consistent with the DELETE handler's ownership enforcement. Do not add
cross-machine listing behavior to this agent-key route.

#### Remediation acceptance criteria

- [ ] With fixtures for machines A and B, A's key lists only A's apps, both with
  no query and with `?machineId=B`.
- [ ] A query for B cannot return B's rows, including when A has no apps.
- [ ] Existing rejection of missing/invalid keys and disallowed machine bindings
  remains intact.
- [ ] Run the affected backend tests and record the result in the remediation PR.

## Issue 2 — exact title

`[security][needs-validation] Audit leads to validate`

### Issue body

Parent audit: <https://github.com/Mike-Demo/openharness/issues/5>

These are unconfirmed leads from static inspection, **not confirmed findings**.
No severity is assigned. Collect deployment evidence or perform only explicitly
authorized validation; record confirmed, rejected, or still-unresolved outcomes
with supporting evidence for each checkbox.

The parent issue itself truncates the end of both missing-fact descriptions
with `…`. The quotations below preserve the exact available text, including
those truncations; do not infer the omitted wording.

- [ ] **Public app tunnel forwards node-app Set-Cookie headers verbatim,
  allowing parent-domain cookie tossing across tenant subdomains**
  - **Fingerprint:** `app-tunnel-set-cookie-domain-passthrough`.
  - **Claimed root cause:** `tunnelHttp` writes app-supplied `app_res` headers to
    `res.writeHead` without `Set-Cookie` filtering or `Domain=` stripping, which
    could allow tenant-controlled parent-domain cookies.
  - **Source evidence:** [response forwarding](https://github.com/Mike-Demo/openharness/blob/9d8d57ecc406a9b934a49ba7eac765dea0b44450/backend/src/lib/appTunnel.ts#L176-L184)
    passes headers directly; [manager frame dispatch](https://github.com/Mike-Demo/openharness/blob/9d8d57ecc406a9b934a49ba7eac765dea0b44450/backend/src/lib/managerWs.ts#L277-L294)
    does not establish browser-visible behavior.
  - **Exact missing fact from the parent:**

    > Whether any layer outside the checked backend source - the agent-manager that produces app_res frames, or an edge, CDN or reverse-proxy in front of the public app-proxy - strips or rewrites Domain= attributes on Set-Cookie before the response reaches a browser. The app_res producer is not in the checked backend or CLI trees and no in-repo edge con…

  - **Evidence needed to resolve:** inspect the deployed frame producer and all
    response-path intermediaries for cookie rewriting, or capture an authorized
    end-to-end response showing whether `Domain=` survives. Establish tenant
    control, actual domain/browser acceptance, and a concrete victim-cookie
    interaction before claiming cross-tenant security impact. Backend passthrough
    alone cannot establish those facts.

- [ ] **Internal mesh listener binds 0.0.0.0 with no peer authentication,
  contradicting its INTERNAL-only design**
  - **Fingerprint:** `mesh-listener-binds-all-interfaces-no-peer-auth`.
  - **Claimed root cause:** `startMeshProxy` binds all interfaces without a
    peer-authentication or source-address check, so a reachable network peer is
    handled like a mesh-forwarded request.
  - **Source evidence:** [mesh listener](https://github.com/Mike-Demo/openharness/blob/9d8d57ecc406a9b934a49ba7eac765dea0b44450/backend/src/lib/subdomainProxy.ts#L157-L166)
    binds `0.0.0.0` when enabled. [Configuration defaults](https://github.com/Mike-Demo/openharness/blob/9d8d57ecc406a9b934a49ba7eac765dea0b44450/backend/src/config/env.ts#L30-L40)
    disable mesh by default; an advertised loopback address does not restrict
    the listener's bind address. Source alone does not prove production exposure.
  - **Exact missing fact from the parent:**

    > The production network topology for the mesh ports (MESH_PORT_BASE 8095 plus worker index): whether firewall, security-group or Kubernetes NetworkPolicy rules in the real deployment restrict those ports to backend peer instances only, and whether any WAF, rate-limit or logging layer fronts the public app-proxy port (PORT_APP_PROXY) that a direct m…

  - **Evidence needed to resolve:** obtain production mesh enablement, worker
    port mappings, network rules, and public app-proxy ingress controls. Use
    deployment configuration or authorized connectivity evidence to determine
    whether non-peer traffic can reach the mesh and bypass public-path controls.
    Distinguish an actual bypass from access to the same already-public apps;
    neither all-interface binding nor host networking alone proves exploitability.
