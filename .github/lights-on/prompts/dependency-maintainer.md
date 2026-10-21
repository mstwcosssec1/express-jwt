# Legacy dependency-maintainer task

This task name is retained for installed callers, but is routed to the
read-only dependency-migration-planner. It must not edit code, manifests,
workflows, or the threat model.

Routine updates use dependency-updater with a trusted Step D selection.
Migration execution uses dependency-migrator with an explicitly approved plan.
Call finish_task with the analysis; the controller publishes the result.
