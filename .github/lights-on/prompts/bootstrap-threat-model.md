# Lights On — Bootstrap & Refresh Threat Model (`bootstrap-threat-model.md`)

You are executing the **Bootstrap & Threat Model Maintenance** workflow for **Lights On**. Your objective is to create or update the repository's canonical `THREAT_MODEL.md` (and optional machine-readable companions) using the installed [`alpha-omega-security/threat-model`](https://github.com/alpha-omega-security/threat-model) skills (`skills/threat-model*`).

Follow all rules in `system-core.md` and write your final structured result to `$LIGHTS_ON_OUTPUT_FILE` (or `.github/lights-on/tmp/agent-result.json`).

---

## Mode Selection

Determine which mode applies based on the repository state and trigger context:

1. **Mode A — Day-0 Creation (`THREAT_MODEL.md` does not exist)**
2. **Mode B — Maintainer Ratification (`/lights-on update-threat-model` command or direct edits to `THREAT_MODEL.md` §1.18)**
3. **Mode C — §1.16 Model-Change Refresh (triggered by a new public API, dependency migration, or new security mitigation)**

---

## Mode A: Day-0 Creation (`THREAT_MODEL.md` Does Not Exist)

Run the full **draft-first** `alpha-omega-security/threat-model` workflow (`threat-model` orchestrator skill and specialist skills in `skills/threat-model*`) to produce `THREAT_MODEL.md` at the repository root:

1. **Phase 3.1–3.2 Orientation & Mining (`threat-model-recon`)**:
   - Inspect `README.md`, top-level documentation, `SECURITY.md`, package manifests, CLI entry points, public exports, issue rulings, and changelogs.
   - **Upstream Fork Context**: If `<context_file path="/tmp/lights-on-upstream-context.json">` is provided (when maintaining a fork of an unmaintained upstream repository), also mine the upstream repository's historical maintainer issue rulings (`closed_maintainer_rulings`), open issues (`open_issues`), recent PRs (`recent_prs`), and release notes (`releases`) to ground scope (`§1.2`/`§1.3`), known non-findings (`§1.15`), and security guarantees (`§1.11`/`§1.12`). Always wrap any upstream citations in inline code backticks (e.g., `` `upstream/repo#12` ``) and never write to the upstream repository.
   - Classify the project type (library, CLI, service, plugin/action, SDK), carve component families, and flag any shipped-but-unsupported or experimental code.
   - If an older security policy or embedded threat model exists, absorb it as a strict superset with a prior-policy back-map.

2. **Phase 3.3 Deep Code-Surface Analysis (`threat-model-surface`)**:
   - Read public entry points, parsers, network/filesystem/process boundaries, and configuration handlers to derive the **§1.7 Per-Input Trust Table and Contract-Dimension Matrix**.
   - Inventory all host/network/process side effects for **§1.5 No-Surprise Side-Effects Inventory**.
   - Document reachability preconditions for **§1.4 Trust Boundaries** and output taint/guarantees for **§1.8 Output Guarantees**.

3. **Phase 3.5 Canonical Prose Authoring (`threat-model-authoring`)**:
   - Write `THREAT_MODEL.md` adhering strictly to the **§1.1–§1.19 canonical structure**:
     - `§1.1` Triager Quick-Start (routing algorithm + provenance confidence counts: documented, maintainer, inferred, assumption)
     - `§1.2` Scope and Intended Use (explicitly defining what KTLO maintenance covers)
     - `§1.3` Out of Scope / Non-Goals (explicitly defining what feature requests and non-goals Lights On must decline)
     - `§1.4` Architecture, Components, and Trust Boundaries
     - `§1.5` No-Surprise Side-Effects Inventory
     - `§1.6` Adversary Model
     - `§1.7` Per-Input Trust Table and Contract-Dimension Matrix
     - `§1.8` Output Guarantees and Taint Statements
     - `§1.9` Dependency Assumptions
     - `§1.10` Configuration and Deployment Assumptions
     - `§1.11` Claimed Security Properties
     - `§1.12` Disclaimed Security Properties
     - `§1.13` Downstream / Caller Responsibilities
     - `§1.14` Common Misuses
     - `§1.15` Known Non-Findings
     - `§1.16` Conditions That Change This Model
     - `§1.17` Triage Dispositions (closed enum table + precedence order)
     - `§1.18` Open Questions for Maintainers (numbered `Q1`, `Q2`, ... with proposed default answers so maintainers can ratify in one comment)
     - `§1.19` Machine-Readable Companion References
   - Tag every non-trivial claim with provenance: `*(documented)*`, `*(maintainer, YYYY-MM)*`, `*(inferred, QN)*`, or `*(assumption, QN)*`. Every `*(inferred, QN)*` and `*(assumption, QN)*` tag must map to a corresponding question `QN` in `§1.18`.

4. **Phase 3.6–3.7 Companion & Sidecar Generation (`threat-model-sidecar`)**:
   - When configured or appropriate, emit/validate machine-readable companions (`threat-model.yaml` / `threat-model.json`) consistent with `THREAT_MODEL.md` (authority order: prose > YAML > JSON).

---

## Mode B: Maintainer Ratification (`/lights-on update-threat-model` or §1.18 Answers)

When `THREAT_MODEL.md` already exists and a verified repository maintainer provides answers via `/lights-on update-threat-model` or edits `§1.18`:

1. Parse the maintainer's responses to open questions (`Q1`, `Q2`, ...) or policy corrections.
2. Update the corresponding claims across `THREAT_MODEL.md` (§1.2–§1.17):
   - If ratified as proposed, promote `*(inferred, QN)*` or `*(assumption, QN)*` to `*(maintainer, YYYY-MM)*` (using the current `YYYY-MM`).
   - If the maintainer corrected or reversed an assumption, rewrite the claim and §1.7/§1.11/§1.12/§1.17 entries to match the maintainer's ruling and tag with `*(maintainer, YYYY-MM)*`.
3. Retire resolved questions from `§1.18` (or record them as resolved with date and citation).
4. Recalculate and update the provenance confidence counts (`documented`, `maintainer`, `inferred`, `assumption`) in `§1.1`.
5. Keep the diff minimal and surgical.

---

## Mode C: §1.16 Model-Change Refresh

When invoked after a `§1.16` trigger event (such as an automated dependency migration, a new security mitigation, or a ratified public API change):

1. Inspect the diff or migration context against `THREAT_MODEL.md §1.16` ("Conditions That Change This Model").
2. Update only the affected sections of `THREAT_MODEL.md`:
   - Dependency replacement/migration -> update `§1.9 Dependency Assumptions` and `§1.4` component inventory if applicable.
   - New input validation or security fix -> update `§1.7 Per-Input Trust Table`, `§1.11 Claimed Security Properties`, or `§1.15 Known Non-Findings`.
   - New open question introduced -> add `QN` to `§1.18` with `*(inferred, QN)*` provenance and increment `§1.1` counts.
3. Preserve all existing `*(maintainer, YYYY-MM)*` and `*(documented)*` rulings untouched unless directly superseded by the trigger.

---

## Final Output Requirements

Write the result JSON to `$LIGHTS_ON_OUTPUT_FILE` (or `.github/lights-on/tmp/agent-result.json`):
- Set `action_taken` to `"updated_threat_model"` (or `"opened_pr"` if opening a bootstrap/update PR, or `"noop"` if no changes were needed).
- List `"THREAT_MODEL.md"` (and any sidecar files) in `files_changed`.
- Include a concise summary of sections created/updated and any remaining `§1.18` open questions in `comment_body` and `pr_body`.
