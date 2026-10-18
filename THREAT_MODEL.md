# express-jwt Threat Model

> **Status:** Unratified draft (draft-first, Lights On bootstrap, 2026-10). Triage policy: **relaxed** *(documented, .github/lights-on.yml `threat_model.triage_policy`)*.
> Structure follows the canonical `alpha-omega-security/threat-model` §1.1–§1.19 layout. This document is the single source of truth for security posture and KTLO scope.

---

## §1.1 Triager Quick-Start

**What this is:** `express-jwt` is an in-process Node.js library. It exports one Express middleware factory, `expressjwt(options)`. The middleware pulls a JWT from the request, verifies it with `jsonwebtoken`, optionally checks revocation, and writes the decoded payload to `req.auth` (or a custom property) *(documented, README.md)*.

**Routing algorithm (apply in order, stop at first match):**

1. Report is about a feature listed in §1.3, or about the caller's app, keys, or IdP → `OUT-OF-SCOPE`.
2. Report matches a §1.15 known non-finding → `CLOSE-KNOWN`.
3. Report relies only on a property disclaimed in §1.12 → `CLOSE-DISCLAIMED`.
4. Report requires the attacker to control a caller-controlled input from §1.7 (options, callbacks, `requestProperty`, keys) → `CLOSE-ASSUMPTION`.
5. Report breaks a §1.11 claimed property with an attacker-controlled input from §1.7 → `CONFIRM` (security-critical: route privately per §1.13 disclosure note, and add `lights-on:needs-human`).
6. Report touches a §1.7 matrix row marked `unresolved`, or a claim tagged *(inferred, QN)* → `ESCALATE-MAINTAINER` (inferred claims never license a close).
7. Report reveals behavior this model does not describe → `MODEL-GAP`.
8. Not enough detail to apply steps 1–7 → `NEEDS-INFO`.

**Confidence summary (provenance counts in this document):**

| Tag | Count |
| --- | --- |
| documented | 67 |
| maintainer | 0 |
| inferred | 18 |
| assumption | 6 |

Open questions: 8 (see §1.18). No backtest corpus has been run yet; routing figures are a placeholder until a Phase 3.6 backtest (`threat-model-backtest`) is performed.

---

## §1.2 Scope and Intended Use

**In scope (component families):**

| Family | Files | Notes |
| --- | --- | --- |
| Middleware factory and request pipeline | `src/index.ts` | Option checks, token extraction, decode, key lookup, verify, revocation, payload assignment *(documented, src/index.ts)* |
| Error type | `src/errors/UnauthorizedError.ts` | `UnauthorizedError` with `code`, `status = 401`, `inner` *(documented, src/errors/UnauthorizedError.ts)* |
| Nested property setter | `src/util/set.ts` | Writes payload to dotted `requestProperty` path *(documented, CHANGELOG.md 8.3.0)* |
| Public TypeScript types | `src/index.ts` exports | `Params`, `GetVerificationKey`, `IsRevoked`, `ExpirationHandler`, `TokenGetter`, `Request`, deprecated aliases *(documented, src/index.ts)* |

**Intended use:** Authenticate HTTP requests in Express (4.x) apps by verifying bearer JWTs signed with a caller-supplied secret or public key, using a caller-pinned algorithm list *(documented, README.md)*.

**KTLO maintenance covers:**

- Security fixes to token extraction, verification wiring, revocation, and error handling.
- Reproducible bug fixes with regression tests.
- Keeping `jsonwebtoken` and `express-unless` patched within compatible majors.
- README/type accuracy fixes.
- Preserving the public API and the `UnauthorizedError` codes listed in §1.8.

---

## §1.3 Out of Scope / Non-Goals

Lights On must decline these in KTLO mode:

- Issuing, signing, or refreshing tokens. The library only verifies *(documented, README.md)*.
- JWKS fetching, key caching, or key rotation logic. Callers use `secret` callbacks (for example `jwks-rsa`) *(documented, README.md "Retrieve key dynamically")*.
- Authorization, scopes, or permissions. See `express-jwt-permissions` *(documented, README.md "Related Modules")*.
- Session management, cookies, CSRF protection *(inferred, Q4)*.
- Non-Express frameworks (Koa, Fastify, etc.) *(inferred, Q4)*.
- JWE (encrypted tokens) and non-JWS formats *(inferred, Q4)*.
- New option surfaces or architectural rewrites (feature creep).
- Build, release, and CI hygiene (outside a threat model).

---

## §1.4 Architecture, Components, and Trust Boundaries

**Request flow** *(documented, src/index.ts)*:

1. **CORS preflight bypass:** if `req.method === 'OPTIONS'` and `access-control-request-headers` lists `authorization`, call `next()` with no auth check.
2. **Token extraction:** use `options.getToken(req)` if given; else parse `Authorization` (or `authorization`) header as `<scheme> <credentials>`; scheme must match `/^Bearer$/i`.
3. **Missing token:** throw `credentials_required` unless `credentialsRequired === false`, then `next()` with no `req.auth`.
4. **Decode (unverified):** `jwt.decode(token, { complete: true })`.
5. **Key lookup:** `getVerificationKey(req, decodedToken)` — receives the **unverified** token.
6. **Verify:** `jwt.verify(token, key, options)`. `options` (including `algorithms`, `audience`, `issuer`, etc.) is passed straight through.
7. **Expiry hook:** on `TokenExpiredError` with `onExpired` set, call it; if it returns without throwing, processing continues.
8. **Revocation:** `isRevoked(req, decodedToken)`; truthy → `revoked_token`.
9. **Assign:** `set(req, requestProperty, decodedToken.payload)` then `setImmediate(next)`.
10. Any thrown error → `setImmediate(next, err)`.

**Trust boundaries:**

| Boundary | Side A | Side B |
| --- | --- | --- |
| HTTP request → middleware | Remote client (untrusted) | Library |
| Library → caller callbacks | Library | Caller code (trusted, `secret`, `getToken`, `isRevoked`, `onExpired`) |
| Library → `jsonwebtoken` | Library | Dependency (trusted for crypto, §1.9) |
| Library → downstream handlers | `req.auth` set only after steps 6–8 pass | Caller route handlers |

**Reachability preconditions:** An attacker reaches the library by sending any HTTP request to a route that mounts the middleware and is not excluded via `.unless()`. No authentication is needed to reach token parsing *(inferred, Q1)*.

---

## §1.5 No-Surprise Side-Effects Inventory

| Side effect | Present? | Notes |
| --- | --- | --- |
| Network I/O | No | None in library code *(documented, src/index.ts)*. Caller callbacks may do I/O. |
| Filesystem I/O | No | *(documented, src/index.ts)* |
| Process / child processes | No | *(documented, src/index.ts)* |
| Environment variable reads | No | *(documented, src/index.ts)* |
| Global state / caches | No | No module-level mutable state *(documented, src/index.ts)* |
| Mutation of `req` | Yes | Only the `requestProperty` path (default `auth`) *(documented, README.md)* |
| Logging | No | Errors are passed to `next(err)` only *(documented, src/index.ts)* |
| Timers | Yes | `setImmediate(next)` to defer continuation *(documented, src/index.ts)* |

Any change adding network, filesystem, process, env, or logging side effects must update this table and is a §1.16 trigger.

---

## §1.6 Adversary Model

- **Remote unauthenticated client:** controls method, headers (including `Authorization`, `Access-Control-Request-Headers`), and the full token string (header, payload, signature) *(inferred, Q1)*.
- **Holder of an expired, revoked, or wrong-audience token:** tries to reuse it *(inferred, Q1)*.
- **Algorithm-confusion attacker:** tries `alg: none` or HS/RS confusion *(documented, README.md "Required Parameters")*.
- **Not modeled:** an attacker who controls middleware options, callbacks, the verification key, the process, or `node_modules` *(assumption, Q5)*.
- **Not modeled:** a compromised identity provider issuing validly signed malicious tokens *(assumption, Q5)*.

---

## §1.7 Per-Input Trust Table and Contract-Dimension Matrix

### Per-input trust table

| Input | Source | Trust | Library obligation |
| --- | --- | --- | --- |
| `Authorization` / `authorization` header | Remote client | **Untrusted** | Parse as two space-separated parts: scheme `Bearer` (case-insensitive) then the credentials; reject other formats with `credentials_bad_format` / `credentials_bad_scheme` *(documented, src/index.ts)* |
| `req.method`, `Access-Control-Request-Headers` | Remote client | **Untrusted** | Only used to decide the CORS preflight bypass *(documented, src/index.ts)* |
| JWT header, payload, signature | Remote client | **Untrusted** until `jwt.verify` passes | Never assign to `req[requestProperty]` unless verify (and revocation) pass, except the `onExpired` path *(documented, src/index.ts)* |
| Decoded token passed to `secret` callback | Remote client | **Untrusted (unverified)** | Pass as-is; caller must treat fields (`kid`, `iss`, `alg`) as attacker data *(inferred, Q3)* |
| Decoded token passed to `isRevoked` | Remote client, post-verify | Verified | Called only after verify succeeds *(documented, src/index.ts)* |
| `options.secret` (value or callback) | Caller | Trusted | Required; non-falsy *(documented, src/index.ts)* |
| `options.algorithms` | Caller | Trusted | Required; must be an array *(documented, src/index.ts; CHANGELOG.md 7.6.1)* |
| `options.requestProperty` | Caller | Trusted | Dotted path used by `set()`; not sanitized *(inferred, Q6)* |
| `options.getToken`, `isRevoked`, `onExpired` | Caller | Trusted | Awaited; thrown errors forwarded to `next(err)` *(documented, README.md)* |
| Other `jwt.VerifyOptions` (`audience`, `issuer`, `maxAge`, ...) | Caller | Trusted | Passed straight to `jwt.verify` *(documented, README.md)* |

### Contract-dimension matrix

| Dimension | Decision | Notes |
| --- | --- | --- |
| Signature verification | **Claimed** | Delegated to `jsonwebtoken.verify` with caller `algorithms` *(documented, README.md)* |
| Algorithm pinning | **Claimed** | `algorithms` is mandatory *(documented, README.md; CHANGELOG.md 7.6.1)* |
| Expiry (`exp`) / `nbf` checks | **Claimed** | Via `jsonwebtoken`; can be overridden by `onExpired` *(documented, README.md)* |
| Audience / issuer | **Claimed when configured** | Off unless caller sets them *(documented, README.md "Additional Options")* |
| Numeric limits (token/header size) | **Disclaimed** | Bounded by Node/Express header limits, not the library *(assumption, Q7)* |
| Failure atomicity | **Claimed** | On any error `req[requestProperty]` is not set *(documented, src/index.ts)* |
| Recursive / cyclic topology | **N/A** | Payload is JSON from `jsonwebtoken`; no recursion in library |
| Callback execution | **Claimed** | Caller callbacks are awaited; errors go to `next(err)` *(documented, README.md)* |
| Serialization | **N/A** | Library does not serialize output |
| Reference lifecycle | **N/A** | No retained references |
| Concurrency | **Claimed** | Stateless per request *(documented, src/index.ts)* |
| Resource complexity | **Unresolved** | Cost of `jwt.verify` and caller callbacks per request; no rate limiting *(inferred, Q7)* |
| CORS preflight bypass | **Unresolved** | See §1.12 and Q2 |

---

## §1.8 Output Guarantees and Taint Statements

- `req[requestProperty]` is set **only** when the token verified (or `onExpired` returned normally) and `isRevoked` returned falsy *(documented, src/index.ts)*.
- `req[requestProperty]` holds the JWT payload (object or string). Claim **values** remain issuer-controlled data; the library does not validate custom claims *(inferred, Q3)*.
- When `credentialsRequired: false` and no token is sent (or the `Authorization` scheme is not `Bearer`), `req[requestProperty]` is **unset**; downstream must check for it *(documented, README.md)*.
- Errors are `UnauthorizedError` with `status: 401`, `name: 'UnauthorizedError'`, `inner` (original error) and one of these codes *(documented, src/errors/UnauthorizedError.ts)*: `credentials_bad_scheme`, `credentials_bad_format`, `credentials_required`, `invalid_token`, `revoked_token`. These codes are part of the public API.
- `inner` may contain `jsonwebtoken` error details (e.g., `expiredAt`). Callers must not echo raw errors to clients if they consider that detail sensitive *(inferred, Q3)*.

---

## §1.9 Dependency Assumptions

| Dependency | Range | Assumption |
| --- | --- | --- |
| `jsonwebtoken` | `^9.0.0` | Correct signature verification, algorithm enforcement, and claim checks. v9 required after `GHSA-27h2-hvpr-p74q` *(documented, CHANGELOG.md 8.0.0)* |
| `express-unless` | `^2.1.3` | Path exclusion logic for `.unless()`; its matching semantics are its own contract *(documented, README.md)* |
| `@types/jsonwebtoken` | `^9` | Types only; runtime dependency for consumers' type checking *(documented, CHANGELOG.md 7.7.1)* |
| Express | peer (dev `^4.17.3`) | Supplies `req.headers` with lower-cased header names and bounded header size *(assumption, Q7)* |

A vulnerability in `jsonwebtoken` verification is reachable through this library and is in scope for dependency bumps.

---

## §1.10 Configuration and Deployment Assumptions

- `algorithms` must list only the algorithms the caller's key supports. Mixing symmetric and asymmetric algorithms is unsafe *(documented, README.md)*.
- `credentialsRequired` defaults to `true` (secure default) *(documented, README.md)*.
- `requestProperty` defaults to `auth` *(documented, README.md)*.
- Supported Node.js versions: `engines` says `>= 8.0.0`, but `jsonwebtoken@9` needs newer Node *(inferred, Q8)*.
- The app must install an error handler that turns `UnauthorizedError` into a 401 response *(documented, README.md "Error handling")*.

---

## §1.11 Claimed Security Properties

1. **P1 — No auth without verification:** A request never gets `req[requestProperty]` set unless `jwt.verify` succeeded with the caller's key and `algorithms` (or `onExpired` accepted an expired token) *(documented, src/index.ts)*.
2. **P2 — Algorithm pinning:** The middleware refuses to start without an `algorithms` array *(documented, src/index.ts; CHANGELOG.md 7.6.1)*.
3. **P3 — Revocation is honored:** If `isRevoked` returns truthy, the request fails with `revoked_token` *(documented, README.md)*.
4. **P4 — Invalid tokens fail even when optional:** With `credentialsRequired: false`, a present but invalid or expired token still fails *(documented, test/jwt.test.ts)*.
5. **P5 — Fail closed on callback errors:** Errors thrown by `secret`, `getToken`, `isRevoked`, or `onExpired` are forwarded to `next(err)` and do not authenticate *(documented, test/multitenancy.test.ts; test/revocation.test.ts)*.
6. **P6 — Claim checks configured by the caller are enforced:** `audience`, `issuer`, `exp`, `nbf`, `maxAge` per `jsonwebtoken` *(documented, README.md)*.

**Worked routing examples (de-identified, synthetic):**

- "A token signed with a different HS256 secret sets `req.auth`." → breaks P1 → `CONFIRM`.
- "With `algorithms: ['HS256', 'RS256']` an attacker signs with the RSA public key as HMAC secret." → caller misconfiguration (§1.10, §1.14) → `CLOSE-ASSUMPTION`.
- "`requestProperty: '__proto__.x'` pollutes prototypes." → caller-controlled input → `CLOSE-ASSUMPTION` (pending Q6).

---

## §1.12 Disclaimed Security Properties

1. **Authorization:** The library does not check scopes, roles, or claim values *(documented, README.md "Related Modules")*.
2. **Key management:** The library does not fetch, cache, rotate, or validate keys *(documented, README.md)*.
3. **Protection of unauthenticated routes:** Routes excluded by `.unless()` or not mounted are not protected *(documented, README.md)*.
4. **CORS preflight:** `OPTIONS` requests that announce `authorization` in `Access-Control-Request-Headers` skip verification by design *(inferred, Q2)*.
5. **Expired-token acceptance via `onExpired`:** If the handler returns normally, the expired payload is attached *(documented, README.md "Handling expired tokens"; test/jwt.test.ts)*.
6. **Rate limiting / DoS:** No request-rate or token-size limits *(assumption, Q7)*.
7. **Token confidentiality / transport:** TLS and token leakage (logs, URLs via custom `getToken`) are the caller's concern *(inferred, Q4)*.

---

## §1.13 Downstream / Caller Responsibilities

- Pin `algorithms` to one family that matches the key *(documented, README.md)*.
- Set `audience` and `issuer` *(documented, README.md "highly recommended")*.
- Treat the token passed to the `secret` callback as **unverified**; never trust `kid`/`iss` lookups to imply authenticity *(inferred, Q3)*.
- Make `onExpired` throw unless accepting an expired token is intended *(documented, README.md)*.
- Check `req.auth` exists when `credentialsRequired: false` *(documented, README.md)*.
- Handle `UnauthorizedError` in an Express error handler *(documented, README.md)*.
- Ensure `OPTIONS` handlers do not expose protected data *(inferred, Q2)*.
- Report security issues privately via the Auth0 Responsible Disclosure Program, not public issues *(documented, README.md "Issue Reporting")*.

---

## §1.14 Common Misuses

- Mixing HS* and RS* in `algorithms` (key confusion) *(documented, README.md)*.
- Omitting `audience`/`issuer`, so tokens for another API are accepted *(documented, README.md)*.
- `onExpired` that never throws, making `exp` meaningless *(inferred, Q2)*.
- `getToken` reading tokens from query strings, leaking them in logs *(assumption, Q4)*.
- Using `credentialsRequired: false` and assuming `req.auth` is always set *(documented, README.md)*.
- Using unverified `token.payload` fields from the `secret` callback for authorization decisions *(inferred, Q3)*.

---

## §1.15 Known Non-Findings

- **`jwt.decode` before `jwt.verify`:** Intentional, to supply `kid`/`iss` to the key callback. Not a bypass, because `verify` still runs *(documented, README.md "Secret rotation")*.
- **`algorithms` required:** Breaking-looking runtime throw is the intended defense *(documented, CHANGELOG.md 7.6.1)*.
- **Case-insensitive `Bearer` scheme and `Authorization` capitalization:** Intentional *(documented, CHANGELOG.md 7.3.0, 7.4.0)*.

---

## §1.16 Conditions That Change This Model

- Replacing or major-bumping `jsonwebtoken` or `express-unless` → update §1.9.
- Any new option, callback, export, or `UnauthorizedError` code → update §1.7, §1.8.
- Changes to the CORS preflight bypass, `onExpired` flow, or `credentialsRequired` semantics → update §1.11, §1.12.
- Any new side effect (network, filesystem, logging, env) → update §1.5.
- Supporting a new framework or token format → update §1.2, §1.3.
- Maintainer answers to §1.18 → promote provenance tags.

---

## §1.17 Triage Dispositions

| Disposition | Meaning |
| --- | --- |
| `CONFIRM` | Valid finding that breaks a §1.11 property via an untrusted input. Fix + regression test. |
| `ESCALATE-MAINTAINER` | Needs human judgment (unresolved matrix row, inferred claim, breaking change). |
| `NEEDS-INFO` | Not enough detail to route. |
| `CLOSE-ASSUMPTION` | Requires control of a trusted/caller input (§1.7) or violates §1.10/§1.13. |
| `CLOSE-DISCLAIMED` | Relies only on a §1.12 disclaimed property. |
| `CLOSE-KNOWN` | Matches a §1.15 known non-finding. |
| `OUT-OF-SCOPE` | Concerns §1.3 non-goals or other software. |
| `MODEL-GAP` | Behavior not described here; add a §1.18 question. |

**Precedence:** `OUT-OF-SCOPE` > `CLOSE-KNOWN` > `CLOSE-DISCLAIMED` > `CLOSE-ASSUMPTION` > `CONFIRM` > `ESCALATE-MAINTAINER` > `MODEL-GAP` > `NEEDS-INFO`.

**Policy floor (relaxed):** An *(assumption, QN)* claim may license a close only for low-blast-radius routes and never against P1–P6. An *(inferred, QN)* claim never licenses a close.

---

## §1.18 Open Questions for Maintainers

Reply with `/lights-on update-threat-model` and e.g. `Q1: yes, Q2: yes, ...`. Proposed defaults are in bold.

- **Q1 — Adversary reach:** Is any remote, unauthenticated HTTP client the primary adversary, able to reach token parsing on any mounted route? **Proposed: yes.**
- **Q2 — CORS preflight bypass:** Is skipping verification for `OPTIONS` requests whose `Access-Control-Request-Headers` include `authorization` intended and disclaimed (caller must keep `OPTIONS` handlers harmless)? Is an `onExpired` that never throws a caller misuse? **Proposed: yes to both.**
- **Q3 — Unverified token in `secret` callback:** Is the token passed to `GetVerificationKey` explicitly unverified and caller-responsibility, and are payload claim values and `inner` error details untrusted for callers? **Proposed: yes.**
- **Q4 — Non-goals:** Are sessions/cookies/CSRF, non-Express frameworks, JWE, and transport/token-leakage concerns out of scope? **Proposed: yes.**
- **Q5 — Trusted configuration:** Is an attacker who controls options, callbacks, keys, the IdP, or the process out of model? **Proposed: yes.**
- **Q6 — `requestProperty` path:** Is `requestProperty` trusted developer config, so prototype-pollution via values like `__proto__.x` is `CLOSE-ASSUMPTION`? **Proposed: yes; hardening `set()` is optional, non-breaking.**
- **Q7 — Resource limits:** Are token size, header size, and per-request verification cost delegated to Node/Express and the caller (no rate limiting claimed)? **Proposed: yes.**
- **Q8 — Supported Node.js versions:** Which Node versions are supported, given `engines: >= 8.0.0` but `jsonwebtoken@9` requires newer? **Proposed: Node.js versions supported by `jsonwebtoken@9` (>= 12); update `engines` in a later PR.**

---

## §1.19 Machine-Readable Companion References

- Prose (`THREAT_MODEL.md`) is canonical. Authority order: prose > YAML > JSON.
- `threat-model.yaml` / `threat-model.json`: not yet generated. They will be emitted after maintainers ratify §1.18.
