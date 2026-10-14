# Six-phase execution contract

The workbench and PaperPipeline share `config/dsh/web/paper-phases.js`.
Twenty stable task IDs remain for old checkpoints; they are not twenty independent workflows.

1. Question: initial literature, bounded question, journal fit and author approval.
2. Protocol and experiment setup: select a data-source route; run an optional-feasibility pilot only for newly executed experiments.
3. Formal experiments/results: bounded batches, validated result hashes, full existing data/reproduction gates.
4. Literature/manuscript: result-directed sources including alternative explanations; results, methods, discussion, introduction, abstract/conclusion.
5. Cross-review: retain review budgets/cache; optional outages permit an explicitly unvalidated draft, never invented approval.
6. Delivery: final citations, actual exported files, scientific/format reports and explicit author confirmation.

## Experiment plans

DSH's paper agent can prepare `milestones/experiment-plan.json` from the approved question and existing project code.
See `config/dsh/examples/experiment-plan.json`; it is a template, not an executable research result.
The exact selected research question is checked. When a pilot applies, pilot and formal results must be distinct files. Project-local `experiments/results/...` remains supported; large shared results can use `@shared/processed/<paper-scope>/<run-id>/...` when `PAPER_SHARED_DATA_ROOT` is configured. Each output stays namespaced by paper and run, and the paper checkpoint/manifest binds its hash rather than copying the dataset into the paper directory.
The last batch must produce the configured main result, or supplies that result if none was previously configured.
The plan contains at most 31 formal batches plus one pilot; each command has a bounded deadline (default five minutes, configurable via existing EXPERIMENT_TIMEOUT_MS, maximum one hour).

`executionMode: "run-experiments"` keeps the existing behavior: it requires a feasibility pilot before formal batches.
`executionMode: "provided-data"` requires `sourceFiles` under the project or `@shared/datasets/<dataset>/<version>/...`, binds their SHA256 values into the checkpoint, skips pilot dispatch, and runs the declared reproducible analysis batches. With `PAPER_SHARED_DATA_ROOT`, shared analysis outputs must be under `@shared/processed/<paper-scope>/<run-id>/...`; the scope must match the current paper project. A changed source file invalidates reuse and requires an explicit amendment and revalidation.
Provided-data mode does not skip source/provenance, data-quality, statistical or independent-recomputation checks. The analysis command creates a reproducible run log; the original dataset remains an input and is never overwritten. The runner supplies `PAPER_SHARED_DATA_ROOT`, `DSH_RESULTS_FILE`, and `DSH_EXPERIMENT_OUTPUT_DIR` to each command so paper-local scripts can read shared source files and write the resolved run output without embedding machine-specific paths. Shared references are path-checked and hashed; symlinks and path traversal are rejected. If the hypothesis was formed after inspecting the data, report the analysis as exploratory.
See `config/dsh/examples/provided-data-experiment-plan.json` for this route. Existing schema-1 plans without `executionMode` remain `run-experiments` for compatibility.

Each batch is checkpointed before dispatch. Accepted result/log/validation-report hashes are checked before reuse.
Failure retries are capped at three execution attempts and three validation attempts; validation failure never automatically reruns accepted execution.
Interrupted execution requires explicit resolution so a lost response cannot launch a duplicate experiment.
In Web, `continue_paper_workflow` action `resolve-experiment` requires explicit `userConfirmed`, a task ID, `retry`/`validate`/`stop`, and an author reason; then `resume` forwards the decision once.
For CLI, the same decision can be supplied as JSON with `--experiment-resolution`; counters and accepted evidence are not reset.
Pilot/batch validation is a feasibility/data integrity check, not the final scientific or independent-recomputation gate.
Formal results still pass the existing complete data-validation stage before manuscript writing.
Missing plans retain the legacy configured command, so existing audited projects are not forced to rerun a pilot.
Amending plan/protocol/evidence invalidates the bound checkpoint and requires an explicit amendment, not automatic reset.

## Interpretation

Preserve original hypotheses and failed, null, adverse and unknown outcomes.
Optional `milestones/reproducibility/result-interpretation.json` records `resultSha256`, `originalHypothesis`,
`outcome` (supported/unsupported/conditional/inconclusive), `explanation`, and optional `exploratoryHypothesis`.
This records an interpretation, not proof. New hypotheses remain exploratory until independent verification.

## Recovery and retention

`metadata.workflow.tasks` records actual completion, waiting, degradation and failure.
Successful tasks advance the checkpoint before another task runs. Workbench status uses this ledger when present.
Ordinary paragraph failures retain completed prose and a persistent gap marker, then continue; billing/integrity failures stop.
Optional citation/polish/review/format failures retain a draft marker and advance to safe draft delivery.
Submission stays blocked until actual reports pass and gaps are resolved; an exported file alone is not approval.
Review context changes retain previous paid budgets and require author authorization for a new audit.
Author-approved `continue_paper_workflow` action `repair-gate` rechecks one citation/polish/quality/format gate. A successful recheck clears only that gate's owned markers; prose gaps and unrelated blockers remain, and attempt/review budgets are never reset.

`.dsh-state/pipeline-artifacts.json` records paths, sizes, roles and retention decisions at phase boundaries.
Raw inputs, code, results, manuscripts, checkpoints, logs, archives and unknown files are retained.
Only ordinary `.tmp` files older than 24 hours under `.dsh-state/runtime/tmp/` are automatically removed, at most 200 per check.
Fresh temporary files over 64 MiB produce a warning; no mass deletion, archive purge or source-data deletion is performed.
