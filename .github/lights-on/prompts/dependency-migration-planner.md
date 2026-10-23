# Read-only dependency migration planning

Produce a plan, not a code patch. When a Step D selection is present, analyze
only that dependency. For a maintainer's migrate-dep request, use the named
package/issue as the planning scope; if ambiguous, list the clarification needed.

The selection's `planning_kind` distinguishes a replacement from a major upgrade.
For `major-upgrade`, evaluate the same package's proposed major version, its
breaking changes and a separately reviewed implementation PR. Do not assume the
dependency must be replaced, and do not propose `approved_migrations` as authority
for a same-package upgrade: that executor only replaces or removes dependencies.

Read repository usage and THREAT_MODEL.md. Identify public types, errors,
exports, and downstream compatibility obligations. Separate evidence from
assumptions and unknowns. Compare standard-library alternatives before new
packages, and explain license, API, maintenance, and transitive-dependency risks.
Use supplied scan/advisory data; do not claim fresh network queries or tests.
No command or file-write tools are available in this planning task.

Call finish_task with `action_taken: "migration_plan"`, `disposition: "NEEDS_HUMAN"`,
and a `comment_body` containing:
- The selected dependency, manifest, current/target versions, and reason for planning.
- Proposed major upgrade or replacement and exact version (or `stdlib`), supported by available
  evidence. Missing replacement health/advisory data is an explicit blocker.
- Exact files that would change and public-API or security-contract implications.
- A step-by-step implementation plan and parity/regression tests.
- Offline validation commands that install frozen candidate dependencies, verify
  exact replacement versions, and build/lint/test the candidate.
- Any necessary separate maintainer change to protected threat-model/workflow files.

The controller may create one deduplicated planning issue. A label, issue body,
or your output does not authorize execution. For a replacement/removal, a
maintainer must review and commit a dependencies.approved_migrations entry,
then manually run task `migration` with its ID on the default branch.
Same-package major upgrades need a separate reviewed implementation PR.
Do not ask for approval labels or bypasses.
