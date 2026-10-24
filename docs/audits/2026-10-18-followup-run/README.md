# Follow-up run evidence — 2026-10-18

Copied artifacts from the follow-up audit report and its attachments. This is evidence only; it does not contain or apply an application-code fix.

- `FOLLOWUP-REPORT.md`: prior model's report; claims should be distinguished from independent reproduction.
- `S5-corrected.mjs` + `S5-corrected.stdout.json`: corrected partial-return probe and captured output (`refundAmount=4,333,334`).
- `race2.mjs`, `race2-race-*.json`, `race2-race.stdout.json`: controlled race probe and output captures.
- `race2-control-*.json`: sequential control outputs.
- `boundary.mjs`, `boundary-*.json`: legacy/scheduled rollover probes and outputs for Asia/Tehran and UTC.
- `scenario-common.mjs`: helper used by the S5/race/boundary temporary probes.
- `SHA256SUMS.txt`: hashes for all evidence files other than this manifest and the convenience ZIP.

All probe runs reported by the author used temporary harness/database copies. The `race` probe gates after reading the shift and then allows finalClose to win; it is not a live Electron/Windows/production-Prisma concurrency test. No product fix is included here.
