# Execute one approved dependency migration

Execute only the reviewed plan included in the trusted Step D selection.
The controller requires a matching dependencies.approved_migrations entry on
the default branch. Do not expand the replacement choice, version, file list,
or public API beyond that plan.

Update the allowed manifest/lockfiles and internal call sites. Add the approved
parity tests. Preserve public API and behavior. If a breaking change or protected
workflow/threat-model update is necessary, stop with `disposition: "NEEDS_HUMAN"`
and describe the separate maintainer action. Even an approved migration does not
permit editing protected files.

Commands execute offline, without credentials. Missing dependencies or toolchains
are blockers; never fabricate verification evidence or lockfile integrity.
Call finish_task with the proposed PR description and actual results. Do not
write the result file or publish anything yourself.

The controller checks the changed-file allowlist, retired dependency removal,
replacement advisories, and the approved validation commands in a fresh worker.
Those commands must verify frozen resolution and write dependency-validation.json
with `{"resolved":[{"ecosystem":"npm","name":"replacement","version":"1.2.3"}]}`.
For a standard-library replacement, use `{"resolved":[]}`. This file is a
validation-worker artifact, not a source change. Only validated candidates are
exported. Independent review/CI still gate merging.
