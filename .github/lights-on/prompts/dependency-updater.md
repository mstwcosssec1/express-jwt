# Routine dependency update

Your only assignment is the dependency in the trusted Step D selection.
Use its current/target version and manifest, scan evidence, and downstream context.
Do not choose another dependency, perform migration research, or remediate a
different security issue. Security fixes are assigned to Step C.

1. Inspect the selected manifest and any existing package-lock.json. Change only
   this package's requirement and its existing lockfile. Do not edit scripts,
   tests, source, workflows, settings, or THREAT_MODEL.md. Process one package,
   not a repository-wide upgrade.
2. If the selection's `lockfile.mode` is `temporary`, change only the selected
   requirement in package.json. Do not add a lockfile to the candidate: the
   controller generates one in its independent validation worker.
   Otherwise, regenerate the existing lockfile with the native package manager,
   offline and without lifecycle scripts (`npm install --package-lock-only --offline --ignore-scripts
   --no-audit --no-fund` in the selected package directory). The worker has no
   network or credentials. Do not invent versions, integrity hashes, or registry URLs.
3. If required offline metadata/cache entries are missing or an existing lockfile
   is unsupported, stop with `disposition: "NEEDS_HUMAN"` and explain the missing evidence in
   `comment_body`. Do not present a manifest-only bump as verified.
4. Call finish_task. Report proposed changes, target version, and any checks
   actually performed. Do not write an output file, create GitHub objects, add
   labels, or claim that CI/downstream packages passed.

The controller independently checks change scope, manifest/lock agreement, exact
target resolution, and target advisories. For a lockfile-free source, it resolves
a temporary v3 lock with npm offline and with lifecycle scripts disabled.
In a fresh offline worker it installs the candidate lockfile and runs the
original build/lint/test scripts. Only then
can it export the candidate and open a PR. Independent review and CI remain
separate merge requirements.
