/**
 * ===========================================================================
 * نشست ۱۸۱ · خوشه M · بند ۴-۲۸ الف — منبع واحدِ «کدام فیلد پول است»
 * ---------------------------------------------------------------------------
 * این فایل عمداً یک **فهرست صریح** است، نه یک heuristic روی نام فیلد.
 *
 * چرا: یک regex مثل /total|amount|price/ هم `invoiceCount` را جا می‌اندازد و هم
 * `movementCount` را اشتباه می‌گیرد، و بدتر — `qty`، `stock` و `sortOrder` را با
 * مبلغ قاطی می‌کند. تبدیل اشتباهِ یک فیلد تعداد به BigInt یعنی هر جای کد که
 * `qty` را در محاسبه‌ی عدد به کار می‌برد در زمان اجرا می‌ترکد؛ و جا انداختنِ یک
 * فیلد پول یعنی همان سرریزی که کل این کار برای رفعش انجام می‌شود.
 *
 * پس هر فیلد عددی اسکیما دقیقاً یک بار در گروه مبلغ، شناسه، شمارنده یا دنبالهٔ BigInt می‌آید و
 * `tools/check-money-fields.mjs` تضمین می‌کند هیچ فیلدی از قلم نیفتاده و هیچ
 * فیلدی هم دو بار نیامده. اگر فردا کسی فیلد `Int` جدیدی به اسکیما اضافه کند،
 * آن بررسی قرمز می‌شود و مجبور است تصمیم بگیرد این فیلد پول هست یا نه.
 * ===========================================================================
 */

/**
 * گروه ۱ — **مبلغ ریالی** ⇒ باید `BigInt` شود.
 * معیار: مقدارش یک مبلغ پول به ریال است و می‌تواند از جمع شدن بزرگ شود.
 */
export const MONEY_FIELDS = [
  // قیمت پایه‌ی کالا
  'ProductVariant.salePrice',
  'ProductVariant.purchasePrice',

  // جمع دستیِ خرید مشتری (سابقه‌ی قبل از سیستم)
  'Customer.manualPurchaseTotal',

  // صندوق — پرتکرارترین محل سرریز، چون همه‌ی فروش یک شیفت در آن جمع می‌شود
  'CashSession.cashTotal',
  'CashSession.cardTotal',
  'CashSession.creditTotal',
  'CashSession.otherTotal',
  'CashSession.grandTotal',
  'CashSession.countedTotal',
  'CashSession.openingFloat',
  'CashSession.cashSales',
  'CashSession.cardSales',
  'CashSession.otherSales',
  'CashSession.clearedChequeSales',
  'CashSession.priorCreditSettlements',
  'CashSession.cashReturnRefunds',
  'CashSession.cardReturnRefunds',
  'CashSession.cashExchangeRefunds',
  'CashSession.storeCreditIssued',
  'CashSession.storeCreditUsed',
  'CashSession.pendingCheques',
  'CashSession.bouncedCheques',
  'CashSession.withdrawals',
  'CashSession.deposits',
  'CashSession.expectedCash',
  'CashSession.cashDifference',
  'CashSession.managerAccountReceived',
  'CashSession.destinationUnknownReceived',

  'CashMovement.amount',

  // تجمیع — جمع چند شیفت، پس از صندوق هم بزرگ‌تر می‌شود
  'Consolidation.goodsTotal',
  'Consolidation.taxTotal',
  'Consolidation.serviceTotal',
  'Consolidation.discountTotal',
  'Consolidation.deliveryTotal',
  'Consolidation.grandTotal',
  'Consolidation.receivedTotal',
  'Consolidation.returnedTotal',

  // فاکتور فروش
  'SaleInvoice.goodsTotal',
  'SaleInvoice.taxTotal',
  'SaleInvoice.serviceCharge',
  'SaleInvoice.discountTotal',
  'SaleInvoice.deliveryFee',
  'SaleInvoice.grandTotal',
  'SaleInvoice.paidTotal',

  'SaleInvoiceItem.unitPrice',
  'SaleInvoiceItem.discount',
  'SaleInvoiceItem.tax',
  'SaleInvoiceItem.lineTotal',

  'Payment.amount',
  'Payment.overpayAmount',

  // برگشت و تعویض
  'SaleReturn.total',
  'SaleReturn.exchangeTotal',
  'SaleReturn.exchangeDiff',
  'SaleReturn.refundAmount',
  'SaleReturn.debtReduction',

  'SaleReturnItem.unitPrice',
  'SaleReturnItem.lineTotal',

  // خرید
  'PurchaseInvoice.goodsTotal',
  'PurchaseInvoice.discountTotal',
  'PurchaseInvoice.grandTotal',
  'PurchaseInvoice.paidTotal',

  'PurchaseInvoiceItem.unitPrice',
  'PurchaseInvoiceItem.lineTotal',

  // اعتبار فروشگاهی
  'StoreCredit.amount',
  'StoreCredit.usedAmount',
  'StoreCredit.minPurchase',
  'StoreCredit.maxPerTransaction',

  'StoreCreditRedemption.amount',
  'StoreCreditRedemption.remainderAfter',

  'StoreCreditBatch.amountEach',
  'StoreCreditBatch.totalAmount',
  'StoreCreditBatch.minPurchase',
  'StoreCreditBatch.maxPerTransaction',

  /**
   * تغییر قیمت گروهی.
   * ⚠️ `PriceChangeBatch.value` عمداً اینجاست با اینکه *گاهی درصد* است:
   * وقتی `mode === 'AMOUNT'` باشد مقدارش ریال است (`PriceAdjustService.ts:246`
   * حتی واحد را « ریال» چاپ می‌کند). چون یک ستون نمی‌تواند نیمی Int و نیمی
   * BigInt باشد، باید نوعِ بزرگ‌تر را بگیرد. درصدِ ۱۰ هم در BigInt بی‌مشکل است.
   */
  'PriceChangeBatch.value',
  'PriceChangeBatch.roundStep',
  'PriceChangeBatch.minPrice',
  'PriceChangeBatch.deltaTotal',

  'PriceChangeItem.oldPrice',
  'PriceChangeItem.newPrice',

  // کارت‌به‌کارت
  'CardTransferRequest.invoiceTotal',
  'CardTransferRequest.returnTotal',
  'CardTransferRequest.amount',
  'CardTransferRequest.paidAmount',

  // دفتر هزینه گزارش مدیریت (جداول تازه، نه ستون روی فروش)
  'PurchaseLot.unitCost',
  'SaleItemCost.fifoCost',
  'SaleItemCost.replacementCost',
  'SaleItemCost.revenue',
  'CostConsumption.unitCost',
  'MgmtTarget.amount',

  // طبقه‌بندی صریح مدل‌های افزوده‌شده: اسناد Woo، حضانت و دفتر حق/دریافت.
  // SaleReturn
  'SaleReturn.creditRestored',
  // ReturnCorrection
  'ReturnCorrection.cashRecovered', 'ReturnCorrection.cardRecovered', 'ReturnCorrection.cashPaidOut',
  'ReturnCorrection.cardPaidOut', 'ReturnCorrection.unrecoveredAmount',
  'ReturnCorrection.creditAffectedAmount',
  // ReturnCorrectionEffect
  'ReturnCorrectionEffect.amount',
  // CustodyCount
  'CustodyCount.countedCash', 'CustodyCount.expectedCash', 'CustodyCount.differenceCash',
  // CustodyDisposition
  'CustodyDisposition.amount',
  // CustodyHandover
  'CustodyHandover.expectedAtStart', 'CustodyHandover.countedAtStart', 'CustodyHandover.differenceCash',
  // CustodyBlueSnapshot
  'CustodyBlueSnapshot.humanAmount', 'CustodyBlueSnapshot.arithmeticAmount',
  'CustodyBlueSnapshot.referenceAmount', 'CustodyBlueSnapshot.knownSubtotal',
  'CustodyBlueSnapshot.destinationUnknownReceived', 'CustodyBlueSnapshot.ambiguousLegacyCredit',
  'CustodyBlueSnapshot.rawDifference', 'CustodyBlueSnapshot.inheritedDifference',
  'CustodyBlueSnapshot.freshDifference',
  // CustodyBlueResolution
  'CustodyBlueResolution.ambiguousAmount', 'CustodyBlueResolution.destinationAmbiguousAmount',
  'CustodyBlueResolution.effectiveReferenceAmount', 'CustodyBlueResolution.resolvedRawDifference',
  'CustodyBlueResolution.resolvedFreshDifference',
  // CustodyEvidenceRecovery
  'CustodyEvidenceRecovery.countedAmount',
  // CustodyResolution
  'CustodyResolution.nightExpectedCash', 'CustodyResolution.expectedCard',
  'CustodyResolution.provisionalDifference',
  // CustodyAggregateBoundary
  'CustodyAggregateBoundary.priorAcceptedObservedTotal',
  'CustodyAggregateBoundary.priorTheoreticalTotal', 'CustodyAggregateBoundary.physicalMovement',
  'CustodyAggregateBoundary.operationalExpectedTotal',
  'CustodyAggregateBoundary.theoreticalExpectedTotal',
  'CustodyAggregateBoundary.observedOperationalTotal', 'CustodyAggregateBoundary.newDifference',
  'CustodyAggregateBoundary.totalTheoreticalDifference', 'CustodyAggregateBoundary.sourceMovementOffset',
  // CustodyDiscrepancyCase
  'CustodyDiscrepancyCase.operationalExpectedTotal', 'CustodyDiscrepancyCase.theoreticalExpectedTotal',
  'CustodyDiscrepancyCase.observedOperationalTotal', 'CustodyDiscrepancyCase.differenceAmount',
  'CustodyDiscrepancyCase.totalTheoreticalDifference',
  // LegacyShiftRecovery
  'LegacyShiftRecovery.countedCash', 'LegacyShiftRecovery.expectedTotalSnapshot',
  'LegacyShiftRecovery.provisionalDifference',
  // LegacyShiftRecoveryItem
  'LegacyShiftRecoveryItem.expectedCashSnapshot', 'LegacyShiftRecoveryItem.openingFloatSnapshot',
  'LegacyShiftRecoveryItem.cashInSnapshot', 'LegacyShiftRecoveryItem.cashOutSnapshot',
  // LegacyRecoveryOpeningLink
  'LegacyRecoveryOpeningLink.recoveryCountedCash', 'LegacyRecoveryOpeningLink.openingCountedCash',
  'LegacyRecoveryOpeningLink.gapCash',
  // ReturnEntitlement
  'ReturnEntitlement.cashRight', 'ReturnEntitlement.giftOpportunity', 'ReturnEntitlement.debtReduced',
  'ReturnEntitlement.cashPaid', 'ReturnEntitlement.cashReserved', 'ReturnEntitlement.cashConverted',
  // ReturnEntitlementEvent
  'ReturnEntitlementEvent.amount',
  // CreditReplacement
  'CreditReplacement.transferredAmount',
  // CreditReturnAllocation
  'CreditReturnAllocation.originNominal', 'CreditReturnAllocation.amount',
  'CreditReturnAllocation.supplementUnspent',
  // BankStatementEvidence
  'BankStatementEvidence.confirmedAmount',
  // ExchangeFundingEvent and immutable source/return line ledgers (Rial).
  'ExchangeFundingEvent.amount',
  'ExchangeFundingLineAllocation.saleItemValue', 'ExchangeFundingLineAllocation.amount',
  'ExchangeFundingReturnLineAllocation.saleItemValue',
  'ExchangeFundingReturnLineAllocation.sourceItemAmount',
  'ExchangeFundingReturnLineAllocation.priorReturnValue',
  'ExchangeFundingReturnLineAllocation.returnValue',
  'ExchangeFundingReturnLineAllocation.cumulativeReturnValue',
  'ExchangeFundingReturnLineAllocation.priorAmount',
  'ExchangeFundingReturnLineAllocation.amountDelta',
  'ExchangeFundingReturnLineAllocation.cumulativeAmount'
]

/**
 * گروه ۲ — **شناسه و کلید خارجی** ⇒ `Int` می‌ماند.
 * تبدیل این‌ها فقط هزینه دارد: هر `where: { id }` و هر `include` را می‌شکند و
 * هیچ سرریزی هم جلوگیری نمی‌کند (شمارنده‌ی autoincrement هرگز به ۹ کوادریلیون
 * نمی‌رسد).
 */
export const ID_FIELDS = [
  'User.id', 'Category.id', 'Category.parentId', 'Warehouse.id',
  'Product.id', 'Product.categoryId', 'ProductVariant.id', 'ProductVariant.productId',
  'ProductVariant.woocommerceProductId',
  'StockMovement.id', 'StockMovement.variantId', 'StockMovement.warehouseId',
  'StockMovement.refId', 'StockMovement.consolidationId',
  'Customer.id', 'Supplier.id',
  'Shift.id', 'Shift.userId',
  'CashSession.id', 'CashSession.shiftId', 'CashSession.closedBy',
  'CashMovement.id', 'CashMovement.shiftId', 'CashMovement.userId',
  'CashMovement.refId', 'CashMovement.auditLogId',
  'Consolidation.id', 'Consolidation.shiftId',
  'PaymentMethod.id',
  'SaleInvoice.id', 'SaleInvoice.customerId', 'SaleInvoice.userId', 'SaleInvoice.shiftId',
  'SaleInvoice.consolidationId', 'SaleInvoice.exchangeReturnId', 'SaleInvoice.sourceInvoiceId',
  'SaleInvoice.voidedByUserId',
  'SaleInvoiceItem.id', 'SaleInvoiceItem.invoiceId', 'SaleInvoiceItem.variantId',
  'Payment.id', 'Payment.invoiceId', 'Payment.methodId', 'Payment.createdByUserId',
  'Payment.createdShiftId', 'Payment.clearedShiftId', 'Payment.clearedByUserId',
  'Payment.storeCreditId', 'Payment.voidedByUserId',
  'PaymentChequeStatusHistory.id', 'PaymentChequeStatusHistory.paymentId',
  'PaymentChequeStatusHistory.clearedShiftId', 'PaymentChequeStatusHistory.userId',
  'SaleReturn.id', 'SaleReturn.invoiceId', 'SaleReturn.exchangeInvoiceId',
  'SaleReturn.storeCreditId', 'SaleReturn.userId', 'SaleReturn.shiftId',
  'SaleReturn.refundPaymentId', 'SaleReturn.voidedByUserId',
  'SaleReturnItem.id', 'SaleReturnItem.returnId', 'SaleReturnItem.saleItemId',
  'SaleReturnItem.variantId',
  'PurchaseInvoice.id', 'PurchaseInvoice.supplierId',
  'PurchaseInvoiceItem.id', 'PurchaseInvoiceItem.invoiceId', 'PurchaseInvoiceItem.variantId',
  'PurchaseInvoiceItem.warehouseId',
  'SecondaryStockItem.id', 'SecondaryStockItem.warehouseId',
  'SecondaryWarehouse.id',
  'SecondaryStockLog.id', 'SecondaryStockLog.itemId', 'SecondaryStockLog.warehouseId',
  'SecondaryStockLog.userId',
  'StoreCredit.id', 'StoreCredit.batchId', 'StoreCredit.returnId',
  'StoreCredit.exchangeInvoiceId', 'StoreCredit.sourceInvoiceId', 'StoreCredit.customerId',
  'StoreCredit.usedInvoiceId', 'StoreCredit.usedPaymentId', 'StoreCredit.remainderCreditId',
  'StoreCredit.userId',
  'StoreCreditRedemption.id', 'StoreCreditRedemption.creditId', 'StoreCreditRedemption.invoiceId',
  'StoreCreditRedemption.paymentId', 'StoreCreditRedemption.userId', 'StoreCreditRedemption.shiftId',
  'StoreCreditBatch.id', 'StoreCreditBatch.customerId', 'StoreCreditBatch.userId',
  'CreditReminderLog.id', 'CreditReminderLog.creditId', 'CreditReminderLog.userId',
  'AuthLockout.id',
  'AuditLog.id', 'AuditLog.userId', 'AuditLog.entityId',
  'PriceChangeBatch.id', 'PriceChangeBatch.categoryId', 'PriceChangeBatch.userId',
  'PriceChangeItem.id', 'PriceChangeItem.batchId', 'PriceChangeItem.variantId',
  'CardTransferRequest.id', 'CardTransferRequest.returnId', 'CardTransferRequest.sourceInvoiceId',
  'CardTransferRequest.exchangeInvoiceId', 'CardTransferRequest.userId',
  'CardTransferRequest.shiftId', 'CardTransferRequest.paidByUserId',
  'CardTransferRequest.paidShiftId', 'CardTransferRequest.adjustsRequestId',
  'StockCountSession.id', 'StockCountSession.userId',
  'StockCountItem.id', 'StockCountItem.sessionId', 'StockCountItem.variantId',
  'SaleItemStockAllocation.id', 'SaleItemStockAllocation.invoiceId',
  'SaleItemStockAllocation.saleItemId', 'SaleItemStockAllocation.variantId',
  'SaleItemStockAllocation.warehouseId',
  'PurchaseLot.id', 'PurchaseLot.purchaseInvoiceId', 'PurchaseLot.variantId',
  'SaleItemCost.id', 'SaleItemCost.saleItemId', 'SaleItemCost.invoiceId', 'SaleItemCost.variantId',
  'CostConsumption.id', 'CostConsumption.movementId', 'CostConsumption.lotId', 'CostConsumption.saleItemId',
  'CostEngineState.lastMovementId',
  'CostEngineFailure.id', 'CostEngineFailure.movementId',
  /**
   * جدول «هدف ماه» گزارش مدیریت — دو ستون عددی غیرپول. `id` و `userId` شناسه‌اند
   * (مثل بقیه‌ی جدول‌ها `Int` می‌مانند) و فقط `amount` ریال است که در گروه ۱ ثبت شده.
   * بدون این دو خط، نگهبان `check-money-fields.mjs` (از نشست ۱۸۱: هر فیلد عددی اسکیما
   * باید دقیقاً در یک گروه باشد) قرمز می‌ماند.
   */
  'MgmtTarget.id', 'MgmtTarget.userId',
  /**
   * نشست SMS — جدول‌های پنل پیامکی.
   *
   * ⚠️ این‌ها **هیچ‌کدام پول نیستند** و عمداً در گروه «شناسه» و «شمارنده»
   * می‌مانند: پنل پیامکی هیچ محاسبه‌ی مالی پروژه را لمس نمی‌کند و تنها عدد
   * پولی‌اش (برآورد هزینه‌ی پیامک) در جدول `Setting` است، نه اینجا.
   *
   * بدون این خطوط، نگهبان `check-money-fields.mjs` (هر فیلد عددی اسکیما باید
   * دقیقاً در یک گروه باشد) قرمز می‌ماند.
   */
  'SaleItemCost.replacementPurchaseInvoiceId',
  'SmsProviderConfig.id',
  'SmsTemplate.id', 'SmsTemplate.createdByUserId', 'SmsTemplate.updatedByUserId',
  'SmsOutbox.id', 'SmsOutbox.templateId', 'SmsOutbox.providerConfigId', 'SmsOutbox.customerId',
  'SmsOutbox.relatedEntityId', 'SmsOutbox.canceledByUserId', 'SmsOutbox.createdByUserId',
  'SmsAttempt.id', 'SmsAttempt.outboxId',
  /* فاز ۴ — کمپین و دفتر «لغو ۱۱»: کلیدها و ارجاع‌ها (هیچ‌کدام مبلغ نیستند) */
  'SmsOutbox.campaignId',
  'SmsOptOut.id', 'SmsOptOut.createdByUserId',
  'SmsCampaign.id', 'SmsCampaign.templateId', 'SmsCampaign.createdByUserId', 'SmsCampaign.canceledByUserId',

  // طبقه‌بندی صریح مدل‌های افزوده‌شده: اسناد Woo، حضانت و دفتر حق/دریافت.
  // WooProductLink
  'WooProductLink.id', 'WooProductLink.variantId', 'WooProductLink.wooProductId',
  'WooProductLink.wooVariationId', 'WooProductLink.lastPushedMovementId', 'WooProductLink.pausedBy',
  'WooProductLink.resumedBy',
  // WooSyncOutbox
  'WooSyncOutbox.id', 'WooSyncOutbox.linkId', 'WooSyncOutbox.variantId', 'WooSyncOutbox.movementId',
  // WooInboundEvent
  'WooInboundEvent.id', 'WooInboundEvent.linkId', 'WooInboundEvent.variantId',
  'WooInboundEvent.movementId',
  // WooApproval
  'WooApproval.id', 'WooApproval.linkId', 'WooApproval.variantId', 'WooApproval.sourceId',
  'WooApproval.resolvedBy',
  // WooSyncLog
  'WooSyncLog.id', 'WooSyncLog.linkId', 'WooSyncLog.variantId',
  // ReturnCorrection
  'ReturnCorrection.id', 'ReturnCorrection.returnId', 'ReturnCorrection.originalUserId',
  'ReturnCorrection.originalShiftId', 'ReturnCorrection.correctingUserId',
  'ReturnCorrection.correctingShiftId', 'ReturnCorrection.approvingManagerId',
  // ReturnCorrectionEffect
  'ReturnCorrectionEffect.id', 'ReturnCorrectionEffect.correctionId', 'ReturnCorrectionEffect.variantId',
  'ReturnCorrectionEffect.cashMovementId', 'ReturnCorrectionEffect.referenceId',
  'ReturnCorrectionEffect.shiftId', 'ReturnCorrectionEffect.userId',
  // StoreCreditRedemption
  'StoreCreditRedemption.compensatedReturnId',
  // StaffProfile
  'StaffProfile.userId',
  // CustodyCredential
  'CustodyCredential.userId', 'CustodyCredential.setByUserId',
  // ShiftPlan
  'ShiftPlan.id',
  // ShiftPlanStaff
  'ShiftPlanStaff.planId', 'ShiftPlanStaff.userId',
  // CustodySaleEvidence
  'CustodySaleEvidence.id', 'CustodySaleEvidence.invoiceId', 'CustodySaleEvidence.custodyShiftId',
  'CustodySaleEvidence.custodianUserId', 'CustodySaleEvidence.operatorUserId',
  // CustodyState
  'CustodyState.activeShiftId', 'CustodyState.pendingHandoverId',
  // CustodyShiftMeta
  'CustodyShiftMeta.shiftId', 'CustodyShiftMeta.custodianUserId', 'CustodyShiftMeta.openCountId',
  'CustodyShiftMeta.planId', 'CustodyShiftMeta.cashSessionId',
  // CustodyCount
  'CustodyCount.id', 'CustodyCount.shiftId', 'CustodyCount.countedByUserId', 'CustodyCount.handoverId',
  // CustodyEvent
  'CustodyEvent.id', 'CustodyEvent.shiftId', 'CustodyEvent.handoverId', 'CustodyEvent.resolutionId',
  'CustodyEvent.legacyRecoveryId', 'CustodyEvent.actorUserId', 'CustodyEvent.managerUserId',
  // CustodyDisposition
  'CustodyDisposition.id', 'CustodyDisposition.cashSessionId', 'CustodyDisposition.shiftId',
  'CustodyDisposition.recipientUserId', 'CustodyDisposition.claimedByUserId',
  'CustodyDisposition.confirmedByUserId',
  // CustodyHandover
  'CustodyHandover.id', 'CustodyHandover.fromShiftId', 'CustodyHandover.fromUserId',
  'CustodyHandover.selectedRecipientUserId', 'CustodyHandover.finalCustodianUserId',
  'CustodyHandover.acceptedByUserId', 'CustodyHandover.managerApproverUserId',
  'CustodyHandover.outCountId', 'CustodyHandover.toShiftId',
  // CustodyBlueSnapshot
  'CustodyBlueSnapshot.id', 'CustodyBlueSnapshot.handoverId', 'CustodyBlueSnapshot.shiftId',
  'CustodyBlueSnapshot.actorUserId', 'CustodyBlueSnapshot.priorSnapshotId',
  // CustodyBlueResolution
  'CustodyBlueResolution.id', 'CustodyBlueResolution.snapshotId', 'CustodyBlueResolution.managerUserId',
  // CustodyBlueNote
  'CustodyBlueNote.id', 'CustodyBlueNote.snapshotId', 'CustodyBlueNote.managerUserId',
  // CustodyEvidenceQuarantine
  'CustodyEvidenceQuarantine.id', 'CustodyEvidenceQuarantine.shiftId',
  'CustodyEvidenceQuarantine.handoverId', 'CustodyEvidenceQuarantine.snapshotId',
  // CustodyEvidenceRecovery
  'CustodyEvidenceRecovery.id', 'CustodyEvidenceRecovery.quarantineId',
  'CustodyEvidenceRecovery.shiftId', 'CustodyEvidenceRecovery.managerUserId',
  'CustodyEvidenceRecovery.recoverySnapshotId',
  // CustodyResolution
  'CustodyResolution.id', 'CustodyResolution.shiftId', 'CustodyResolution.nightEvidenceCountId',
  'CustodyResolution.morningWitnessCountId', 'CustodyResolution.attributedToUserId',
  'CustodyResolution.decisionByUserId', 'CustodyResolution.cashSessionId',
  // CustodyAggregateBoundary
  'CustodyAggregateBoundary.id', 'CustodyAggregateBoundary.fromShiftId',
  'CustodyAggregateBoundary.toShiftId', 'CustodyAggregateBoundary.handoverId',
  'CustodyAggregateBoundary.previousBoundaryId', 'CustodyAggregateBoundary.countedByUserId',
  // CustodyDiscrepancyCase
  'CustodyDiscrepancyCase.id', 'CustodyDiscrepancyCase.boundaryId', 'CustodyDiscrepancyCase.fromShiftId',
  'CustodyDiscrepancyCase.toShiftId', 'CustodyDiscrepancyCase.closedByUserId',
  // CustodyDiscrepancyReview
  'CustodyDiscrepancyReview.id', 'CustodyDiscrepancyReview.caseId',
  'CustodyDiscrepancyReview.managerUserId',
  // LegacyShiftRecovery
  'LegacyShiftRecovery.id', 'LegacyShiftRecovery.witnessUserId',
  // LegacyShiftRecoveryItem
  'LegacyShiftRecoveryItem.id', 'LegacyShiftRecoveryItem.recoveryId', 'LegacyShiftRecoveryItem.shiftId',
  'LegacyShiftRecoveryItem.legacyUserId',
  // LegacyShiftRecoveryReview
  'LegacyShiftRecoveryReview.id', 'LegacyShiftRecoveryReview.recoveryId',
  'LegacyShiftRecoveryReview.itemId', 'LegacyShiftRecoveryReview.actorUserId',
  // LegacyRecoveryOpeningLink
  'LegacyRecoveryOpeningLink.id', 'LegacyRecoveryOpeningLink.recoveryId',
  'LegacyRecoveryOpeningLink.openingShiftId', 'LegacyRecoveryOpeningLink.openingCountId',
  'LegacyRecoveryOpeningLink.openerUserId',
  // ReceiptCodeReservation
  'ReceiptCodeReservation.invoiceId',
  // ReturnEntitlement
  'ReturnEntitlement.id', 'ReturnEntitlement.returnId', 'ReturnEntitlement.invoiceId',
  'ReturnEntitlement.requestId',
  // ReturnEntitlementEvent
  'ReturnEntitlementEvent.id', 'ReturnEntitlementEvent.entitlementId',
  'ReturnEntitlementEvent.requestId', 'ReturnEntitlementEvent.creditId',
  'ReturnEntitlementEvent.actorUserId',
  // CreditDelivery
  'CreditDelivery.id', 'CreditDelivery.creditId', 'CreditDelivery.originCreditId',
  'CreditDelivery.deliveredByUserId',
  // CreditReplacement
  'CreditReplacement.id', 'CreditReplacement.originalCreditId', 'CreditReplacement.successorCreditId',
  'CreditReplacement.approvingManagerId', 'CreditReplacement.actorUserId',
  // CreditReturnAllocation
  'CreditReturnAllocation.id', 'CreditReturnAllocation.returnId', 'CreditReturnAllocation.invoiceId',
  'CreditReturnAllocation.redemptionId', 'CreditReturnAllocation.parentCreditId',
  'CreditReturnAllocation.rootCreditId', 'CreditReturnAllocation.successorCreditId',
  // ReturnGoodsReceipt
  'ReturnGoodsReceipt.id', 'ReturnGoodsReceipt.returnId', 'ReturnGoodsReceipt.returnItemId',
  'ReturnGoodsReceipt.variantId', 'ReturnGoodsReceipt.actorUserId',
  // ReturnGoodsReceiptSource (scalar historical references)
  'ReturnGoodsReceiptSource.id', 'ReturnGoodsReceiptSource.receiptId',
  'ReturnGoodsReceiptSource.returnItemId', 'ReturnGoodsReceiptSource.variantId',
  'ReturnGoodsReceiptSource.allocationId', 'ReturnGoodsReceiptSource.warehouseId',
  'ReturnGoodsReceiptSource.secondaryStockItemId',
  // BankStatementEvidence
  'BankStatementEvidence.id', 'BankStatementEvidence.requestId',
  'BankStatementEvidence.reviewedByUserId',
  // ExchangeFundingEvent: scalar historical links (not ORM foreign keys).
  'ExchangeFundingEvent.id', 'ExchangeFundingEvent.sourceInvoiceId', 'ExchangeFundingEvent.childInvoiceId',
  'ExchangeFundingEvent.returnId', 'ExchangeFundingEvent.sourcePaymentId',
  'ExchangeFundingEvent.sourceRedemptionId', 'ExchangeFundingEvent.sourceCreditId',
  'ExchangeFundingEvent.parentEventId', 'ExchangeFundingEvent.debtId', 'ExchangeFundingEvent.actorUserId',
  'ExchangeFundingEvent.reversesEventId',
  // Immutable exchange line allocation scope.
  'ExchangeFundingLineAllocation.id', 'ExchangeFundingLineAllocation.sourceInvoiceId',
  'ExchangeFundingLineAllocation.childInvoiceId', 'ExchangeFundingLineAllocation.returnId',
  'ExchangeFundingLineAllocation.sourceEventId', 'ExchangeFundingLineAllocation.saleItemId',
  'ExchangeFundingReturnLineAllocation.id', 'ExchangeFundingReturnLineAllocation.returnId',
  'ExchangeFundingReturnLineAllocation.returnItemId', 'ExchangeFundingReturnLineAllocation.sourceInvoiceId',
  'ExchangeFundingReturnLineAllocation.childInvoiceId', 'ExchangeFundingReturnLineAllocation.saleItemId',
  'ExchangeFundingReturnLineAllocation.sourceEventId',
  'ExchangeFundingReturnLineAllocation.reversesAllocationId'
]

/**
 * گروه ۳ — **تعداد، شمارنده، ترتیب، شماره‌ی سند، درصد و روز** ⇒ `Int` می‌ماند.
 * هیچ‌کدام مبلغ نیستند و هیچ‌کدام از محدوده‌ی امن رد نمی‌شوند.
 */
export const COUNT_FIELDS = [
  'ProductVariant.stock',          // تعداد موجودی
  'ProductVariant.minStock',       // تعداد
  'StockMovement.delta',           // تعداد (مثبت ورود، منفی خروج)
  'Shift.number', 'Shift.sessionSeq', 'Shift.suggestedSlot', 'Shift.slotNumber',
  'CashSession.invoiceCount',
  'Consolidation.invoiceCount', 'Consolidation.movementCount',
  'PaymentMethod.sortOrder',
  'SaleInvoice.receiptNo',                  // شماره‌ی فیش، نه مبلغ
  'SaleInvoice.wholesaleDiscountPercent',   // درصد
  'SaleInvoiceItem.qty',
  'Payment.seq',
  'SaleReturn.exchangeReceiptNo',           // شماره‌ی فیش
  'SaleReturnItem.qty', 'SaleReturnItem.restockedQty',
  'PurchaseInvoice.invoiceNo',              // شماره‌ی سند
  'PurchaseInvoiceItem.qty',
  'SecondaryStockItem.qty', 'SecondaryStockItem.minQty',
  'SecondaryWarehouse.sortOrder',
  'SecondaryStockLog.qtyBefore', 'SecondaryStockLog.qtyAfter', 'SecondaryStockLog.delta',
  'StoreCredit.usedCount', 'StoreCredit.maxUses', 'StoreCredit.issuedDays',
  'StoreCredit.printCount', 'StoreCredit.reminderCount', 'StoreCredit.usedReceiptNo',
  'StoreCreditRedemption.seq', 'StoreCreditRedemption.receiptNo',
  'StoreCreditBatch.count', 'StoreCreditBatch.days', 'StoreCreditBatch.maxUses',
  'StoreCreditBatch.codeLength',
  'AuthLockout.failCount', 'AuthLockout.lockCount',
  'PriceChangeBatch.itemCount', 'PriceChangeBatch.editCount',
  'CardTransferRequest.sourceReceiptNo', 'CardTransferRequest.exchangeReceiptNo',
  'CardTransferRequest.stockReleasedQty',
  'StockCountItem.countedQty', 'StockCountItem.systemQty', 'StockCountItem.diffQty',
  'StockCountItem.pendingRestockQty',
  'SaleItemStockAllocation.qty', 'SaleItemStockAllocation.balanceAfter',
  'SaleItemStockAllocation.restoredQty',
  'PurchaseLot.qtyIn', 'PurchaseLot.qtyLeft',
  'SaleItemCost.qty',
  'CostConsumption.qty',
  /* نشست SMS — شمارنده/ترتیب/بخش‌ها. هیچ‌کدام مبلغ نیستند. */
  'SmsProviderConfig.credentialsVersion',
  'SmsTemplate.version',
  'SmsOutbox.priority', 'SmsOutbox.attemptCount', 'SmsOutbox.maxAttempts', 'SmsOutbox.segments',
  'SmsAttempt.attemptNo', 'SmsAttempt.httpStatus',
  /* فاز ۴ — شمارنده‌های کمپین. «برآورد هزینه» هم عمداً اینجاست نه در گروه پول:
     هیچ تراکنش مالی‌ای با آن انجام نمی‌شود و فقط برای نمایش قبل از ارسال است
     (پولِ واقعی در جدول‌های فروش/اعتبار است، نه اینجا). */
  'SmsCampaign.audienceCount', 'SmsCampaign.queuedCount', 'SmsCampaign.skippedCount',
  'SmsCampaign.optOutSkipped', 'SmsCampaign.invalidCount', 'SmsCampaign.duplicateCount',
  'SmsCampaign.segments', 'SmsCampaign.costEstimate',

  // طبقه‌بندی صریح مدل‌های افزوده‌شده: اسناد Woo، حضانت و دفتر حق/دریافت.
  // WooProductLink
  'WooProductLink.lastWooQty', 'WooProductLink.lastMahakQty',
  // WooSyncOutbox
  'WooSyncOutbox.expectedWooQty', 'WooSyncOutbox.targetQty', 'WooSyncOutbox.attemptCount',
  // WooInboundEvent
  'WooInboundEvent.oldQty', 'WooInboundEvent.newQty', 'WooInboundEvent.delta',
  // ReturnCorrectionEffect
  'ReturnCorrectionEffect.qty',
  // StaffProfile
  'StaffProfile.version',
  // CustodyCredential
  'CustodyCredential.version',
  // ShiftPlan
  'ShiftPlan.startMinute', 'ShiftPlan.durationMinutes', 'ShiftPlan.daysMask', 'ShiftPlan.sortOrder',
  'ShiftPlan.reminderRepeatMin', 'ShiftPlan.version',
  // CustodyState
  'CustodyState.epoch', 'CustodyState.financialRevision',
  // CustodyShiftMeta
  'CustodyShiftMeta.dayCutoverSnapshot', 'CustodyShiftMeta.openEpoch',
  // CustodyCount
  'CustodyCount.epochAtCount',
  // CustodyEvent
  'CustodyEvent.epochBefore', 'CustodyEvent.epochAfter',
  // CustodyHandover
  'CustodyHandover.fenceEpochAtStart', 'CustodyHandover.protocolVersion',
  'CustodyHandover.deadlinePolicyMinutes', 'CustodyHandover.version',
  // CustodyBlueSnapshot
  'CustodyBlueSnapshot.financialRevision', 'CustodyBlueSnapshot.epochAtCount',
  // CustodyEvidenceQuarantine
  'CustodyEvidenceQuarantine.detectedEpoch',
  // CustodyEvidenceRecovery
  'CustodyEvidenceRecovery.seenEpoch', 'CustodyEvidenceRecovery.epochAfter',
  // CustodyDiscrepancyCase
  'CustodyDiscrepancyCase.version',
  // LegacyShiftRecovery
  'LegacyShiftRecovery.epochBefore', 'LegacyShiftRecovery.epochAfter',
  // LegacyShiftRecoveryItem
  'LegacyShiftRecoveryItem.invoiceCountSnapshot',
  // ReturnEntitlement
  'ReturnEntitlement.version',
  // ReturnEntitlementEvent
  'ReturnEntitlementEvent.beforeVersion',
  // CreditDelivery
  'CreditDelivery.version',
  // ReturnGoodsReceipt
  'ReturnGoodsReceipt.qty',
  // ReturnGoodsReceiptSource
  'ReturnGoodsReceiptSource.qty',
  // ExchangeFunding line snapshots contain quantities, not rial amounts.
  'ExchangeFundingLineAllocation.saleItemQty',
  'ExchangeFundingReturnLineAllocation.saleItemQty',
  'ExchangeFundingReturnLineAllocation.returnedQtyBefore',
  'ExchangeFundingReturnLineAllocation.returningQty',
  'ExchangeFundingReturnLineAllocation.returnedQtyAfter',
  'ExchangeFundingReturnLineAllocation.allocationVersion'
]

/**
 * شمارنده‌های دنبالهٔ Woo که به BigInt نیاز دارند، اما مبلغ ریالی نیستند.
 * این استثنا صریح است: آن‌ها را به MONEY_FIELDS تبدیل نکنید و نوعِ منبع Woo
 * را هم صرفاً برای سبز کردن گیت به Int تقلیل ندهید.
 */
export const WIDE_COUNT_FIELDS = [
  // WooProductLink
  'WooProductLink.pauseSeqFloor', 'WooProductLink.relinkSeqFloor',
  // WooInboundEvent
  'WooInboundEvent.seq'
]

/** استخراج همه‌ی فیلدهای `Int` از فایل اسکیما. */
export function parseIntFields(schemaText) {
  const out = []
  let model = null
  for (const line of schemaText.split('\n')) {
    const m = /^model\s+(\w+)\s*\{/.exec(line)
    if (m) { model = m.group?.(1) ?? m[1]; continue }
    if (/^\}/.test(line)) { model = null; continue }
    if (!model) continue
    const f = /^\s{2}(\w+)\s+Int(\?)?(\s|$)/.exec(line)
    if (f) out.push({ key: `${model}.${f[1]}`, model, field: f[1], optional: Boolean(f[2]) })
  }
  return out
}

/** همان، ولی برای فیلدهای `BigInt` (برای بررسی «بعد از مهاجرت»). */
export function parseBigIntFields(schemaText) {
  const out = []
  let model = null
  for (const line of schemaText.split('\n')) {
    const m = /^model\s+(\w+)\s*\{/.exec(line)
    if (m) { model = m[1]; continue }
    if (/^\}/.test(line)) { model = null; continue }
    if (!model) continue
    const f = /^\s{2}(\w+)\s+BigInt(\?)?(\s|$)/.exec(line)
    if (f) out.push({ key: `${model}.${f[1]}`, model, field: f[1], optional: Boolean(f[2]) })
  }
  return out
}
