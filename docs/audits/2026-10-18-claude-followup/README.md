# Follow-up evidence for independent Claude review (2026-10-18)

This directory contains selected artifacts from the prior audit. It is evidence/reference material only; it does not implement the credit-exchange fix.

## Prior report
- `previous-claude-scenario8-design-plan.md` — previous Claude's analysis/design report. Claims in it should be separated from independently reproduced facts.
- `source-sha256-from-previous-report.txt` — source hashes reported previously; compare against the ZIP being reviewed.

## Scenario 5
- `S5-partial-mixed-original.mjs` is the historical attached probe. It supplies `refundAmount=4333333`, which is one rial below the later corrected expectation. Its output in `S5-partial-mixed-original.stdout.txt` shows the service's message that the actual cash entitlement is 4,333,334 and the noncash share is 666,666. Do not treat that rejected attempt as a successful scenario run.
- `S5-partial-mixed-repo-probe.mjs` is the corresponding probe present in the repository working tree at packaging time; it also has the historical 4,333,333 input and must not be presented as corrected.
- `S5-scenario-common.mjs` is the helper used by the repository probe. The probe was copied as evidence; no test was executed while preparing this directory.

## Race
- `round3-no-session-race.mjs` is the existing project probe.
- `race-run-timeout.stdout-stderr.txt` records the prior `race` invocation: exit code 13, timeout, no stdout. This is NOT a successful race test.
- `no-session-control.stdout-stderr.txt` is the no-session control only; it is not evidence that the finalClose-vs-financial-operation race passed.

## Scope / provenance
These are copied audit artifacts. No application source, schema, migration, or test logic was changed in preparing this directory. The S5 copies preserve the old input rather than silently correcting historical evidence. Any corrected run should be a separate, explicitly labeled run on a temporary copy.
