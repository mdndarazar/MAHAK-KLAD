# Race-fix candidate — metadata supplied in chat (2026-10-18)

> Provenance warning: this note transcribes the user's pasted summary of Claude's candidate. The actual `race-fix.patch`, candidate ZIP, `changed-files.txt`, and new test source were not attached to this workspace when this note was created. Their hashes below are claims from the pasted message and were not independently computed here. This note is **not** the patch and does not prove the candidate works.

## Candidate artifacts claimed by Claude

- Candidate ZIP: `MAHAK-KLAD-fixed-race-2026-10-18.zip`
  - Claimed SHA-256: `cad98a42031c52c3daaff59d5e12316efbb978605b65941f6734b1ea58d1ef0b`
- `changed-files.txt`
  - Claimed SHA-256: `be9f627259ce18e06c902836b8a8176d3e83d489240d16b4f8d1ef08853bc883`
- `race-fix.patch`
  - Claimed SHA-256: `80a35c29a1bd8608586cd5ffb88a82fe3c781196df63a6d2a9f4cf185e73be8e`
- Claude reported working-copy status:
  - `M src/main/services/SalesService.ts`
  - `?? tests/audit-fixes/fix-followup-correction-finalclose-race.mjs`
  - `?? tools/followup-tmp/`

## Claude's reported result (not independently verified)

- It changed only the race path in `returnReconcileVoid` in its candidate copy, adding `custodyFence` to the service input and re-reading the operational shift within the Prisma transaction via `shiftService.shiftForNow(tx, { custodyFence })`.
- It reported the new test passed for both orders: finalClose before correction rejects/rolls back; correction before finalClose is counted.
- It reported S5 with `refundAmount=4,333,334` still passed.
- It explicitly did **not** implement S2, S3, S6, or S8, did **not** run full regression, did **not** test real Prisma/Electron/Windows, and did not change the original ZIP or GitHub.

## Patch excerpt as pasted by the user

The pasted diff adds an optional `custodyFence` to `returnReconcileVoid`, retains a pre-transaction `preShift` for operational-day/approval decisions, and inside the `$transaction` callback calls:

```ts
const operationalShift = await shiftService.shiftForNow(tx, {
  custodyFence: (input as any)?.custodyFence ?? null
})
if (!operationalShift?.id || !operationalShift.userId) {
  throw new BusinessError('برای ثبت اصلاح جبرانی باید یک نشست باز با کارمند مشخص وجود داشته باشد؛ ابتدا نشست/کارمند فعلی را تعیین کنید.')
}
if (operationalShift.closedAt) {
  throw new BusinessError('نشست جبران همین لحظه بسته شد؛ اصلاح جبرانی ثبت نشد. صفحه را تازه کنید و دوباره تلاش کنید.', 'CUSTODY_STALE')
}
```

The exact patch file and complete new test were not available to verify here. Review the actual artifacts before treating the candidate as accepted.
