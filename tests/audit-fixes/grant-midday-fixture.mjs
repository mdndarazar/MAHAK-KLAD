/** Historical integration fixtures predate the explicit S460 default-deny
 * policy. They test transfer/absence/math, NOT bypassing it. Every caller
 * must authorize a specific cashier through the real, PIN-authenticated Main
 * workflow; S460 separately verifies that omitting this grant is denied. */
export async function grantMiddayFixture({ manager, password, custodian }) {
  const { settingsService } = await import('../../src/main/services/SettingsService.ts')
  return settingsService.saveCustodySchedulingWorkflow({
    shift: {
      ...await settingsService.shiftConfig(),
      custodyMode: 'SINGLE_SHIFT',
      singleShiftCustodianUserId: custodian,
      singleShiftAllowMidDayHandover: true
    },
    managerUserId: manager, managerPassword: password,
    reason: 'مجوز صریح مدیر برای تحویل میان‌روز در سناریوی رگرسیون تاریخی'
  })
}
