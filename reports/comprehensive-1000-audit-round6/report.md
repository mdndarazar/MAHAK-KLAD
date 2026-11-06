> **یادداشت بازبینی:** این فایل شمارش خام رانر است، نه نتیجهٔ نهایی محصول. از ۲۰۵ خطای خام، ۱۹۹ مورد تکرار F-01 و ۶ مورد ردِ درستِ اعتبارِ خارج از محدوده‌اند؛ ۲۱ PASS خام سناریوی داده‌سازیِ نامعتبر و ۴۸ موردِ دریافتِ اضافه بدون تأیید است. جمع‌بندی معتبر و محدودیت پوشش در `reviewed-report.md` آمده است.

# گزارش جامع ۱۰۰۰ سناریو — ممیزی منطق مالک

**اجرا:** ۱٬۰۰۰/۱٬۰۰۰ سناریو · **PASS** ۷۹۵ · **FAIL منطقی** ۲۰۵ · **رد منطقی** ۳۶۳ (FAIL نیست) · عملیات ۲٬۳۲۳
**دیتابیس:** SQLite موقت ایزوله (/tmp/mahak-comprehensive-round6-1000-dbAvCb/isolated.db) — بدون دست‌زدن به production
**تعریف blue:** cash+card منهای refund؛ چکِ PENDING شمرده نمی‌شود؛ موجودی از StockMovement؛ ALL pooled

**پوشش:** پنل‌ها retail-1, retail-5, retail-30, retail-15, wholesale-200, wholesale-500, wholesale-50؛ پرداخت‌ها CASH, CARD, CASH+CARD, NASIYE, CHEQUE, NASIYE+CHEQUE, CASH+NASIYE, CARD+CHEQUE, CASH+CARD+NASIYE, CASH+CARD+CHEQUE, NASIYE+CHEQUE+CASH, NASIYE+CHEQUE+CARD, NASIYE+CHEQUE+CASH+CARD, BARCODE؛ بارکد NONE, ALL, VARIANTS_SINGLE, VARIANTS_MULTI, CATEGORY_SINGLE, MIXED_ALL+CAT؛ تخفیف NO, YES, YES_ZERO؛ انقضا expired, edge, valid؛ عمق زنجیره 1, 2, 3, 4

> هر FAIL فقط زمانی ثبت شد که رفتار سیستم با منطق مالک ناسازگار بود (محاسبه اشتباه، بدهی اشتباه، اعتبار گمشده، انبار منفی، ALL سهم‌بندی شده). ردهای منطقی (کالای قبلاً برگشت‌خورده، بارکد مصرف‌شده، فاکتور تاریخ‌گذشته، موجودی ناکافی، عدم انتخاب تسویه) به‌درستی PASS شمرده شد.

## جدول خلاصه ۱۰۰۰ سناریو
| # | پنل | اقلام | پرداخت | بارکد | تخفیف | انقضا | زنجیره | وضعیت | رد منطقی |
|---:|---|---|---|---|---|---|---|---|---|
| 5001 | retail-1 | 1 | CASH | NONE×0 | NO | expired+راه‌دور | 1 | PASS | 0 |
| 5002 | retail-5 | 5 | CARD | ALL×1 | YES | edge | 2 | PASS | 0 |
| 5003 | retail-30 | 30 | CASH+CARD | ALL×2 | YES_ZERO | valid | 3 | PASS | 2 |
| 5004 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5005 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 2 |
| 5006 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5007 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 5008 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5009 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5010 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5011 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 5012 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5013 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 2 |
| 5014 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 2 | PASS | 1 |
| 5015 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5016 | retail-15 | 15 | CARD | ALL×6 | NO | valid | 4 | PASS | 1 |
| 5017 | retail-1 | 1 | CASH+CARD | ALL×7 | YES | valid | 1 | PASS | 1 |
| 5018 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5019 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 5020 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5021 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | expired+راه‌دور | 1 | PASS | 1 |
| 5022 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | edge | 2 | PASS | 1 |
| 5023 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 1 |
| 5024 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5025 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 5026 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 2 |
| 5027 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 5028 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 4 | PASS | 0 |
| 5029 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5030 | retail-5 | 5 | CARD | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5031 | retail-30 | 30 | CASH+CARD | ALL×3 | NO | valid+راه‌دور | 3 | PASS | 1 |
| 5032 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5033 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5034 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5035 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 5036 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5037 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 1 |
| 5038 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 5039 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 5040 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 1 |
| 5041 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | expired+راه‌دور | 1 | PASS | 2 |
| 5042 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | edge | 2 | PASS | 1 |
| 5043 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5044 | retail-15 | 15 | CARD | ALL×7 | YES | valid | 4 | PASS | 1 |
| 5045 | retail-1 | 1 | CASH+CARD | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5046 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5047 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 5048 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5049 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 5050 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 5051 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid+راه‌دور | 1 | PASS | 2 |
| 5052 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 5053 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 5054 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5055 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 5056 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 4 | PASS | 0 |
| 5057 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5058 | retail-5 | 5 | CARD | ALL×3 | NO | valid | 2 | PASS | 1 |
| 5059 | retail-30 | 30 | CASH+CARD | ALL×4 | YES | valid | 3 | PASS | 1 |
| 5060 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5061 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×6 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5062 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | edge | 2 | PASS | 2 |
| 5063 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5064 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5065 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 2 |
| 5066 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5067 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 5068 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 1 |
| 5069 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5070 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 2 | PASS | 1 |
| 5071 | retail-30 | 30 | CASH | NONE×0 | YES | valid+راه‌دور | 3 | PASS | 0 |
| 5072 | retail-15 | 15 | CARD | ALL×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 5073 | retail-1 | 1 | CASH+CARD | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5074 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5075 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5076 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5077 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | PASS | 1 |
| 5078 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 5079 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | PASS | 1 |
| 5080 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 5081 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 5082 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | edge | 2 | PASS | 1 |
| 5083 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5084 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 5085 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5086 | retail-5 | 5 | CARD | ALL×4 | YES | valid | 2 | PASS | 1 |
| 5087 | retail-30 | 30 | CASH+CARD | ALL×5 | YES_ZERO | valid | 3 | PASS | 2 |
| 5088 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5089 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | PASS | 2 |
| 5090 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5091 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid+راه‌دور | 1 | PASS | 0 |
| 5092 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5093 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5094 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 5095 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 5096 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5097 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | PASS | 2 |
| 5098 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 2 | PASS | 1 |
| 5099 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5100 | retail-15 | 15 | CARD | ALL×0 | NO | valid | 4 | PASS | 0 |
| 5101 | retail-1 | 1 | CASH+CARD | ALL×1 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 5102 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | edge | 2 | PASS | 2 |
| 5103 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | PASS | 1 |
| 5104 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5105 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5106 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 5107 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | PASS | 1 |
| 5108 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5109 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 1 |
| 5110 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 2 |
| 5111 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid+راه‌دور | 1 | PASS | 1 |
| 5112 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 4 | PASS | 1 |
| 5113 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5114 | retail-5 | 5 | CARD | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5115 | retail-30 | 30 | CASH+CARD | ALL×6 | NO | valid | 3 | PASS | 1 |
| 5116 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5117 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5118 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5119 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 1 |
| 5120 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5121 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×3 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5122 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×4 | YES | edge | 2 | PASS | 1 |
| 5123 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5124 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | PASS | 1 |
| 5125 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 5126 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5127 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5128 | retail-15 | 15 | CARD | ALL×1 | YES | valid | 4 | PASS | 0 |
| 5129 | retail-1 | 1 | CASH+CARD | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5130 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5131 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×4 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 5132 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5133 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 5134 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 5135 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5136 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5137 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 2 |
| 5138 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5139 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 5140 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 4 | PASS | 1 |
| 5141 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | expired+راه‌دور | 1 | PASS | 0 |
| 5142 | retail-5 | 5 | CARD | ALL×6 | NO | edge | 2 | PASS | 1 |
| 5143 | retail-30 | 30 | CASH+CARD | ALL×7 | YES | valid | 3 | PASS | 1 |
| 5144 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5145 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 5146 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5147 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5148 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5149 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 2 |
| 5150 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5151 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 5152 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 1 |
| 5153 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5154 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 2 | PASS | 0 |
| 5155 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5156 | retail-15 | 15 | CARD | ALL×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 5157 | retail-1 | 1 | CASH+CARD | ALL×3 | NO | valid | 1 | PASS | 1 |
| 5158 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5159 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5160 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5161 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 5162 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | edge | 2 | PASS | 1 |
| 5163 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5164 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 5165 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5166 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 2 |
| 5167 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 5168 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 5169 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5170 | retail-5 | 5 | CARD | ALL×7 | YES | valid | 2 | PASS | 1 |
| 5171 | retail-30 | 30 | CASH+CARD | ALL×8 | YES_ZERO | valid+راه‌دور | 3 | PASS | 2 |
| 5172 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5173 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 5174 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5175 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 5176 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5177 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5178 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 5179 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 1 |
| 5180 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5181 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5182 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×1 | YES | edge | 2 | PASS | 0 |
| 5183 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5184 | retail-15 | 15 | CARD | ALL×3 | NO | valid | 4 | PASS | 1 |
| 5185 | retail-1 | 1 | CASH+CARD | ALL×4 | YES | valid | 1 | PASS | 1 |
| 5186 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5187 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | PASS | 1 |
| 5188 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5189 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 5190 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 5191 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×1 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 5192 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5193 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 2 |
| 5194 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 2 |
| 5195 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5196 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 4 | PASS | 1 |
| 5197 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5198 | retail-5 | 5 | CARD | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5199 | retail-30 | 30 | CASH+CARD | ALL×0 | NO | valid | 3 | PASS | 0 |
| 5200 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5201 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 5202 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | edge | 2 | PASS | 2 |
| 5203 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | PASS | 1 |
| 5204 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5205 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | PASS | 2 |
| 5206 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 5207 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 5208 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 5209 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 2 |
| 5210 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5211 | retail-30 | 30 | CASH | NONE×0 | NO | valid+راه‌دور | 3 | PASS | 0 |
| 5212 | retail-15 | 15 | CARD | ALL×4 | YES | valid | 4 | PASS | 1 |
| 5213 | retail-1 | 1 | CASH+CARD | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5214 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5215 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | PASS | 1 |
| 5216 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5217 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 1 |
| 5218 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 5219 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5220 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 5221 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | expired+راه‌دور | 1 | PASS | 2 |
| 5222 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | edge | 2 | PASS | 2 |
| 5223 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 5224 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 4 | PASS | 1 |
| 5225 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5226 | retail-5 | 5 | CARD | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5227 | retail-30 | 30 | CASH+CARD | ALL×1 | YES | valid | 3 | PASS | 0 |
| 5228 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5229 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | PASS | 2 |
| 5230 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5231 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid+راه‌دور | 1 | PASS | 2 |
| 5232 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5233 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | PASS | 2 |
| 5234 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5235 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 5236 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 5237 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5238 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 2 | PASS | 1 |
| 5239 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5240 | retail-15 | 15 | CARD | ALL×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 5241 | retail-1 | 1 | CASH+CARD | ALL×6 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5242 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×7 | YES | edge | 2 | PASS | 2 |
| 5243 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 5244 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5245 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 2 |
| 5246 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 5247 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | PASS | 1 |
| 5248 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | PASS | 1 |
| 5249 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5250 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | PASS | 2 |
| 5251 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 5252 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 5253 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5254 | retail-5 | 5 | CARD | ALL×1 | YES | valid | 2 | PASS | 0 |
| 5255 | retail-30 | 30 | CASH+CARD | ALL×2 | YES_ZERO | valid | 3 | PASS | 2 |
| 5256 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5257 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 2 |
| 5258 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5259 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 5260 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5261 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 5262 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×0 | NO | edge | 2 | PASS | 0 |
| 5263 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5264 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5265 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 5266 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 2 | PASS | 1 |
| 5267 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5268 | retail-15 | 15 | CARD | ALL×6 | NO | valid | 4 | PASS | 1 |
| 5269 | retail-1 | 1 | CASH+CARD | ALL×7 | YES | valid | 1 | PASS | 1 |
| 5270 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5271 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×0 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 5272 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5273 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 5274 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 5275 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 1 |
| 5276 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5277 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 2 |
| 5278 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 2 |
| 5279 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 5280 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 4 | PASS | 0 |
| 5281 | retail-1 | 1 | CASH | NONE×0 | YES | expired+راه‌دور | 1 | PASS | 0 |
| 5282 | retail-5 | 5 | CARD | ALL×2 | YES_ZERO | edge | 2 | PASS | 1 |
| 5283 | retail-30 | 30 | CASH+CARD | ALL×3 | NO | valid | 3 | PASS | 1 |
| 5284 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5285 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5286 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5287 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 5288 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5289 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 1 |
| 5290 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 5291 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid+راه‌دور | 1 | PASS | 1 |
| 5292 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 1 |
| 5293 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | PASS | 2 |
| 5294 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5295 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5296 | retail-15 | 15 | CARD | ALL×7 | YES | valid | 4 | PASS | 1 |
| 5297 | retail-1 | 1 | CASH+CARD | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5298 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5299 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 5300 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5301 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5302 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | edge | 2 | PASS | 1 |
| 5303 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5304 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 5305 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 5306 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5307 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 5308 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 4 | PASS | 0 |
| 5309 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5310 | retail-5 | 5 | CARD | ALL×3 | NO | valid | 2 | PASS | 1 |
| 5311 | retail-30 | 30 | CASH+CARD | ALL×4 | YES | valid+راه‌دور | 3 | PASS | 1 |
| 5312 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5313 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | PASS | 2 |
| 5314 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5315 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5316 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5317 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 2 |
| 5318 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5319 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 5320 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 1 |
| 5321 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 5322 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×6 | NO | edge | 2 | PASS | 1 |
| 5323 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5324 | retail-15 | 15 | CARD | ALL×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 5325 | retail-1 | 1 | CASH+CARD | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5326 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5327 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5328 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5329 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | PASS | 1 |
| 5330 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 5331 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×6 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 5332 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 5333 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5334 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 1 |
| 5335 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5336 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 5337 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5338 | retail-5 | 5 | CARD | ALL×4 | YES | valid | 2 | PASS | 1 |
| 5339 | retail-30 | 30 | CASH+CARD | ALL×5 | YES_ZERO | valid | 3 | PASS | 2 |
| 5340 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5341 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×7 | YES | expired+راه‌دور | 1 | PASS | 2 |
| 5342 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | edge | 2 | PASS | 2 |
| 5343 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 0 |
| 5344 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5345 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5346 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 5347 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 5348 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5349 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | PASS | 2 |
| 5350 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 2 | PASS | 1 |
| 5351 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid+راه‌دور | 3 | PASS | 0 |
| 5352 | retail-15 | 15 | CARD | ALL×0 | NO | valid | 4 | PASS | 0 |
| 5353 | retail-1 | 1 | CASH+CARD | ALL×1 | YES | valid | 1 | PASS | 0 |
| 5354 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5355 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | PASS | 1 |
| 5356 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5357 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5358 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 5359 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | PASS | 1 |
| 5360 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5361 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5362 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | edge | 2 | PASS | 2 |
| 5363 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 5364 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 4 | PASS | 1 |
| 5365 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5366 | retail-5 | 5 | CARD | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5367 | retail-30 | 30 | CASH+CARD | ALL×6 | NO | valid | 3 | PASS | 1 |
| 5368 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5369 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5370 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5371 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 5372 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5373 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | PASS | 1 |
| 5374 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | PASS | 1 |
| 5375 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5376 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | PASS | 1 |
| 5377 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 5378 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5379 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5380 | retail-15 | 15 | CARD | ALL×1 | YES | valid | 4 | PASS | 0 |
| 5381 | retail-1 | 1 | CASH+CARD | ALL×2 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 5382 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×3 | NO | edge | 2 | PASS | 2 |
| 5383 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 1 |
| 5384 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5385 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 5386 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 5387 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5388 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5389 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 2 |
| 5390 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5391 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 5392 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 4 | PASS | 1 |
| 5393 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5394 | retail-5 | 5 | CARD | ALL×6 | NO | valid | 2 | PASS | 1 |
| 5395 | retail-30 | 30 | CASH+CARD | ALL×7 | YES | valid | 3 | PASS | 1 |
| 5396 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5397 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 5398 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5399 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5400 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5401 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×4 | YES | expired+راه‌دور | 1 | PASS | 2 |
| 5402 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | edge | 2 | PASS | 1 |
| 5403 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 5404 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 1 |
| 5405 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5406 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 2 | PASS | 0 |
| 5407 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5408 | retail-15 | 15 | CARD | ALL×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 5409 | retail-1 | 1 | CASH+CARD | ALL×3 | NO | valid | 1 | PASS | 1 |
| 5410 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5411 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid+راه‌دور | 1 | PASS | 1 |
| 5412 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5413 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 5414 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 5415 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5416 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 5417 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5418 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 2 |
| 5419 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 5420 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 5421 | retail-1 | 1 | CASH | NONE×0 | NO | expired+راه‌دور | 1 | PASS | 0 |
| 5422 | retail-5 | 5 | CARD | ALL×7 | YES | edge | 2 | PASS | 1 |
| 5423 | retail-30 | 30 | CASH+CARD | ALL×8 | YES_ZERO | valid | 3 | PASS | 2 |
| 5424 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5425 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 5426 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5427 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 5428 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5429 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5430 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 5431 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 5432 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5433 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 1 |
| 5434 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 2 | PASS | 0 |
| 5435 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5436 | retail-15 | 15 | CARD | ALL×3 | NO | valid | 4 | PASS | 1 |
| 5437 | retail-1 | 1 | CASH+CARD | ALL×4 | YES | valid | 1 | PASS | 1 |
| 5438 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5439 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | PASS | 1 |
| 5440 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5441 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | expired+راه‌دور | 1 | PASS | 1 |
| 5442 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | edge | 2 | PASS | 1 |
| 5443 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 1 |
| 5444 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5445 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 2 |
| 5446 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 2 |
| 5447 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5448 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 4 | PASS | 1 |
| 5449 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5450 | retail-5 | 5 | CARD | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5451 | retail-30 | 30 | CASH+CARD | ALL×0 | NO | valid+راه‌دور | 3 | PASS | 0 |
| 5452 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5453 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5454 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5455 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | PASS | 1 |
| 5456 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5457 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | PASS | 1 |
| 5458 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 5459 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 5460 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 5461 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 5462 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | edge | 2 | PASS | 1 |
| 5463 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5464 | retail-15 | 15 | CARD | ALL×4 | YES | valid | 4 | PASS | 1 |
| 5465 | retail-1 | 1 | CASH+CARD | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5466 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5467 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | PASS | 1 |
| 5468 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5469 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 1 |
| 5470 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 5471 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid+راه‌دور | 1 | PASS | 2 |
| 5472 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 5473 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | PASS | 2 |
| 5474 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5475 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 5476 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 4 | PASS | 1 |
| 5477 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5478 | retail-5 | 5 | CARD | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5479 | retail-30 | 30 | CASH+CARD | ALL×1 | YES | valid | 3 | PASS | 0 |
| 5480 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5481 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×3 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5482 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | edge | 2 | PASS | 2 |
| 5483 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5484 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5485 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | PASS | 2 |
| 5486 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5487 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 5488 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 5489 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5490 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 2 | PASS | 1 |
| 5491 | retail-30 | 30 | CASH | NONE×0 | YES | valid+راه‌دور | 3 | PASS | 0 |
| 5492 | retail-15 | 15 | CARD | ALL×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 5493 | retail-1 | 1 | CASH+CARD | ALL×6 | NO | valid | 1 | PASS | 1 |
| 5494 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5495 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 5496 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5497 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 2 |
| 5498 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 5499 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | PASS | 1 |
| 5500 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | PASS | 1 |
| 5501 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 5502 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | edge | 2 | PASS | 2 |
| 5503 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | PASS | 1 |
| 5504 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 5505 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5506 | retail-5 | 5 | CARD | ALL×1 | YES | valid | 2 | PASS | 0 |
| 5507 | retail-30 | 30 | CASH+CARD | ALL×2 | YES_ZERO | valid | 3 | PASS | 2 |
| 5508 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5509 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 2 |
| 5510 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5511 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 5512 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5513 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5514 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5515 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5516 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5517 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 5518 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 2 | PASS | 1 |
| 5519 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5520 | retail-15 | 15 | CARD | ALL×6 | NO | valid | 4 | PASS | 1 |
| 5521 | retail-1 | 1 | CASH+CARD | ALL×7 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 5522 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | edge | 2 | PASS | 2 |
| 5523 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 5524 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5525 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 5526 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 5527 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 1 |
| 5528 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5529 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 5530 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 2 |
| 5531 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid+راه‌دور | 1 | PASS | 1 |
| 5532 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 4 | PASS | 0 |
| 5533 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5534 | retail-5 | 5 | CARD | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5535 | retail-30 | 30 | CASH+CARD | ALL×3 | NO | valid | 3 | PASS | 1 |
| 5536 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5537 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5538 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5539 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 5540 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5541 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×0 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5542 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×1 | YES | edge | 2 | PASS | 1 |
| 5543 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 5544 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 1 |
| 5545 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | PASS | 2 |
| 5546 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5547 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5548 | retail-15 | 15 | CARD | ALL×7 | YES | valid | 4 | PASS | 1 |
| 5549 | retail-1 | 1 | CASH+CARD | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5550 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5551 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×1 | YES | valid+راه‌دور | 1 | PASS | 2 |
| 5552 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5553 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 5554 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 5555 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5556 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 5557 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 5558 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5559 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 5560 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 4 | PASS | 0 |
| 5561 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | expired+راه‌دور | 1 | PASS | 0 |
| 5562 | retail-5 | 5 | CARD | ALL×3 | NO | edge | 2 | PASS | 1 |
| 5563 | retail-30 | 30 | CASH+CARD | ALL×4 | YES | valid | 3 | PASS | 1 |
| 5564 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5565 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | PASS | 1 |
| 5566 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5567 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5568 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5569 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 2 |
| 5570 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5571 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 5572 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 1 |
| 5573 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 5574 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 2 | PASS | 1 |
| 5575 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5576 | retail-15 | 15 | CARD | ALL×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 5577 | retail-1 | 1 | CASH+CARD | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5578 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5579 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5580 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5581 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 5582 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | edge | 2 | PASS | 1 |
| 5583 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | PASS | 1 |
| 5584 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 5585 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5586 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 1 |
| 5587 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5588 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 5589 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5590 | retail-5 | 5 | CARD | ALL×4 | YES | valid | 2 | PASS | 1 |
| 5591 | retail-30 | 30 | CASH+CARD | ALL×5 | YES_ZERO | valid+راه‌دور | 3 | PASS | 2 |
| 5592 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5593 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | PASS | 2 |
| 5594 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5595 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 0 |
| 5596 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5597 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5598 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 5599 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 5600 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5601 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5602 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×7 | YES | edge | 2 | PASS | 1 |
| 5603 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5604 | retail-15 | 15 | CARD | ALL×0 | NO | valid | 4 | PASS | 0 |
| 5605 | retail-1 | 1 | CASH+CARD | ALL×1 | YES | valid | 1 | PASS | 0 |
| 5606 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5607 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | PASS | 1 |
| 5608 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 5609 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5610 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 5611 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×7 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 5612 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5613 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 1 |
| 5614 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 2 |
| 5615 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 5616 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 4 | PASS | 1 |
| 5617 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5618 | retail-5 | 5 | CARD | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5619 | retail-30 | 30 | CASH+CARD | ALL×6 | NO | valid | 3 | PASS | 1 |
| 5620 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5621 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 5622 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | edge | 2 | PASS | 1 |
| 5623 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 1 |
| 5624 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5625 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | PASS | 2 |
| 5626 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | PASS | 1 |
| 5627 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5628 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | PASS | 1 |
| 5629 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 5630 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5631 | retail-30 | 30 | CASH | NONE×0 | NO | valid+راه‌دور | 3 | PASS | 0 |
| 5632 | retail-15 | 15 | CARD | ALL×1 | YES | valid | 4 | PASS | 0 |
| 5633 | retail-1 | 1 | CASH+CARD | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5634 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 5635 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 1 |
| 5636 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5637 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 5638 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 5639 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 5640 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5641 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 5642 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | edge | 2 | PASS | 2 |
| 5643 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 5644 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 4 | PASS | 1 |
| 5645 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5646 | retail-5 | 5 | CARD | ALL×6 | NO | valid | 2 | PASS | 1 |
| 5647 | retail-30 | 30 | CASH+CARD | ALL×7 | YES | valid | 3 | PASS | 1 |
| 5648 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 5649 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 5650 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5651 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid+راه‌دور | 1 | PASS | 2 |
| 5652 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5653 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 2 |
| 5654 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 5655 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 5656 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 1 |
| 5657 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5658 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 2 | PASS | 0 |
| 5659 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5660 | retail-15 | 15 | CARD | ALL×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 5661 | retail-1 | 1 | CASH+CARD | ALL×3 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5662 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×4 | YES | edge | 2 | PASS | 2 |
| 5663 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5664 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 5665 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 5666 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 5667 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5668 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 5669 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 5670 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 2 |
| 5671 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 5672 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 5673 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5674 | retail-5 | 5 | CARD | ALL×7 | YES | valid | 2 | PASS | 1 |
| 5675 | retail-30 | 30 | CASH+CARD | ALL×8 | YES_ZERO | valid | 3 | PASS | 2 |
| 5676 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5677 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 5678 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 5679 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 5680 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5681 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 5682 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×6 | NO | edge | 2 | PASS | 1 |
| 5683 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 1 |
| 5684 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 5685 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 1 |
| 5686 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 2 | PASS | 0 |
| 5687 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5688 | retail-15 | 15 | CARD | ALL×3 | NO | valid | 4 | PASS | 1 |
| 5689 | retail-1 | 1 | CASH+CARD | ALL×4 | YES | valid | 1 | PASS | 1 |
| 5690 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 5691 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×6 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 5692 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 5693 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 5694 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 5695 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 1 |
| 5696 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 5697 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 2 |
| 5698 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 2 |
| 5699 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 5700 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 4 | PASS | 1 |
| 5701 | wholesale-200 | 200 | CASH | NONE×0 | YES | expired+راه‌دور | 1 | PASS | 0 |
| 5702 | wholesale-500 | 500 | CARD | ALL×8 | YES_ZERO | edge | 2 | FAIL | 0 |
| 5703 | wholesale-50 | 50 | CASH+CARD | ALL×0 | NO | valid | 3 | PASS | 0 |
| 5704 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5705 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5706 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 5707 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | FAIL | 0 |
| 5708 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5709 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | FAIL | 0 |
| 5710 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | FAIL | 0 |
| 5711 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid+راه‌دور | 1 | FAIL | 0 |
| 5712 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 5713 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5714 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5715 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5716 | wholesale-200 | 200 | CARD | ALL×4 | YES | valid | 4 | FAIL | 0 |
| 5717 | wholesale-500 | 500 | CASH+CARD | ALL×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5718 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 5719 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | FAIL | 0 |
| 5720 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5721 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | expired+راه‌دور | 1 | PASS | 0 |
| 5722 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | edge | 2 | PASS | 0 |
| 5723 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5724 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | FAIL | 0 |
| 5725 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | FAIL | 0 |
| 5726 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5727 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | FAIL | 0 |
| 5728 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 4 | FAIL | 0 |
| 5729 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5730 | wholesale-50 | 50 | CARD | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5731 | wholesale-200 | 200 | CASH+CARD | ALL×1 | YES | valid+راه‌دور | 3 | PASS | 0 |
| 5732 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5733 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | FAIL | 0 |
| 5734 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 5735 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5736 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5737 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | FAIL | 0 |
| 5738 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5739 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 5740 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 5741 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | expired+راه‌دور | 1 | FAIL | 0 |
| 5742 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×3 | NO | edge | 2 | FAIL | 0 |
| 5743 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5744 | wholesale-500 | 500 | CARD | ALL×5 | YES_ZERO | valid | 4 | FAIL | 0 |
| 5745 | wholesale-50 | 50 | CASH+CARD | ALL×6 | NO | valid | 1 | FAIL | 0 |
| 5746 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 5747 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5748 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5749 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 1 |
| 5750 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5751 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×3 | NO | valid+راه‌دور | 1 | FAIL | 0 |
| 5752 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | FAIL | 0 |
| 5753 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5754 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | FAIL | 0 |
| 5755 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | FAIL | 0 |
| 5756 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 4 | FAIL | 0 |
| 5757 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5758 | wholesale-200 | 200 | CARD | ALL×1 | YES | valid | 2 | PASS | 0 |
| 5759 | wholesale-500 | 500 | CASH+CARD | ALL×2 | YES_ZERO | valid | 3 | FAIL | 0 |
| 5760 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 5761 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×4 | YES | expired+راه‌دور | 1 | FAIL | 0 |
| 5762 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | edge | 2 | FAIL | 0 |
| 5763 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | FAIL | 0 |
| 5764 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5765 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5766 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5767 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5768 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5769 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | FAIL | 0 |
| 5770 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 2 | FAIL | 0 |
| 5771 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid+راه‌دور | 3 | PASS | 0 |
| 5772 | wholesale-50 | 50 | CARD | ALL×6 | NO | valid | 4 | FAIL | 0 |
| 5773 | wholesale-200 | 200 | CASH+CARD | ALL×7 | YES | valid | 1 | FAIL | 0 |
| 5774 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5775 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 5776 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5777 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5778 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5779 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | FAIL | 0 |
| 5780 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5781 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | expired+راه‌دور | 1 | FAIL | 0 |
| 5782 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | edge | 2 | FAIL | 0 |
| 5783 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5784 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 4 | PASS | 0 |
| 5785 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5786 | wholesale-500 | 500 | CARD | ALL×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5787 | wholesale-50 | 50 | CASH+CARD | ALL×3 | NO | valid | 3 | FAIL | 0 |
| 5788 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 5789 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5790 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 5791 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid+راه‌دور | 1 | FAIL | 0 |
| 5792 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5793 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5794 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 5795 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5796 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | FAIL | 0 |
| 5797 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | FAIL | 0 |
| 5798 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5799 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5800 | wholesale-200 | 200 | CARD | ALL×7 | YES | valid | 4 | FAIL | 0 |
| 5801 | wholesale-500 | 500 | CASH+CARD | ALL×8 | YES_ZERO | expired+راه‌دور | 1 | FAIL | 0 |
| 5802 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×0 | NO | edge | 2 | PASS | 1 |
| 5803 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 5804 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5805 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | FAIL | 0 |
| 5806 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5807 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5808 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | FAIL | 0 |
| 5809 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | FAIL | 0 |
| 5810 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5811 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid+راه‌دور | 1 | PASS | 0 |
| 5812 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 4 | PASS | 0 |
| 5813 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5814 | wholesale-50 | 50 | CARD | ALL×3 | NO | valid | 2 | FAIL | 0 |
| 5815 | wholesale-200 | 200 | CASH+CARD | ALL×4 | YES | valid | 3 | FAIL | 0 |
| 5816 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5817 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | FAIL | 0 |
| 5818 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 5819 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5820 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5821 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×1 | YES | expired+راه‌دور | 1 | PASS | 0 |
| 5822 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | edge | 2 | FAIL | 0 |
| 5823 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | FAIL | 0 |
| 5824 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | FAIL | 0 |
| 5825 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5826 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 2 | FAIL | 0 |
| 5827 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5828 | wholesale-500 | 500 | CARD | ALL×8 | YES_ZERO | valid | 4 | FAIL | 0 |
| 5829 | wholesale-50 | 50 | CASH+CARD | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5830 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5831 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid+راه‌دور | 1 | FAIL | 0 |
| 5832 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 5833 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | FAIL | 0 |
| 5834 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5835 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | FAIL | 0 |
| 5836 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | FAIL | 0 |
| 5837 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5838 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 5839 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5840 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 4 | FAIL | 0 |
| 5841 | wholesale-50 | 50 | CASH | NONE×0 | NO | expired+راه‌دور | 1 | PASS | 0 |
| 5842 | wholesale-200 | 200 | CARD | ALL×4 | YES | edge | 2 | FAIL | 0 |
| 5843 | wholesale-500 | 500 | CASH+CARD | ALL×5 | YES_ZERO | valid | 3 | FAIL | 0 |
| 5844 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 5845 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | FAIL | 0 |
| 5846 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5847 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 0 |
| 5848 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5849 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5850 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | FAIL | 0 |
| 5851 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid+راه‌دور | 1 | FAIL | 0 |
| 5852 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5853 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | FAIL | 0 |
| 5854 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 2 | FAIL | 0 |
| 5855 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5856 | wholesale-50 | 50 | CARD | ALL×0 | NO | valid | 4 | PASS | 0 |
| 5857 | wholesale-200 | 200 | CASH+CARD | ALL×1 | YES | valid | 1 | PASS | 0 |
| 5858 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5859 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | FAIL | 0 |
| 5860 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 5861 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | expired+راه‌دور | 1 | FAIL | 0 |
| 5862 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | edge | 2 | PASS | 0 |
| 5863 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | FAIL | 0 |
| 5864 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5865 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 5866 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 5867 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5868 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 4 | FAIL | 0 |
| 5869 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5870 | wholesale-500 | 500 | CARD | ALL×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5871 | wholesale-50 | 50 | CASH+CARD | ALL×6 | NO | valid+راه‌دور | 3 | FAIL | 0 |
| 5872 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 5873 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5874 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5875 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 1 |
| 5876 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5877 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | FAIL | 0 |
| 5878 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | FAIL | 0 |
| 5879 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5880 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | FAIL | 0 |
| 5881 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | expired+راه‌دور | 1 | FAIL | 0 |
| 5882 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | edge | 2 | FAIL | 0 |
| 5883 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5884 | wholesale-200 | 200 | CARD | ALL×1 | YES | valid | 4 | PASS | 0 |
| 5885 | wholesale-500 | 500 | CASH+CARD | ALL×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5886 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 5887 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | FAIL | 0 |
| 5888 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5889 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | FAIL | 0 |
| 5890 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5891 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid+راه‌دور | 1 | FAIL | 0 |
| 5892 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 5893 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5894 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5895 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | FAIL | 0 |
| 5896 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 4 | FAIL | 0 |
| 5897 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 5898 | wholesale-50 | 50 | CARD | ALL×6 | NO | valid | 2 | FAIL | 0 |
| 5899 | wholesale-200 | 200 | CASH+CARD | ALL×7 | YES | valid | 3 | FAIL | 0 |
| 5900 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5901 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×0 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 5902 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | edge | 2 | PASS | 2 |
| 5903 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5904 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5905 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | FAIL | 0 |
| 5906 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5907 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | FAIL | 0 |
| 5908 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | FAIL | 0 |
| 5909 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5910 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 2 | PASS | 0 |
| 5911 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid+راه‌دور | 3 | PASS | 0 |
| 5912 | wholesale-500 | 500 | CARD | ALL×2 | YES_ZERO | valid | 4 | FAIL | 0 |
| 5913 | wholesale-50 | 50 | CASH+CARD | ALL×3 | NO | valid | 1 | FAIL | 0 |
| 5914 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 5915 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5916 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 5917 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | FAIL | 0 |
| 5918 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5919 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 5920 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 5921 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | expired+راه‌دور | 1 | FAIL | 0 |
| 5922 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | edge | 2 | FAIL | 0 |
| 5923 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | FAIL | 0 |
| 5924 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 4 | FAIL | 0 |
| 5925 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 5926 | wholesale-200 | 200 | CARD | ALL×7 | YES | valid | 2 | FAIL | 0 |
| 5927 | wholesale-500 | 500 | CASH+CARD | ALL×8 | YES_ZERO | valid | 3 | FAIL | 0 |
| 5928 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 5929 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 5930 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5931 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid+راه‌دور | 1 | FAIL | 0 |
| 5932 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5933 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5934 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | FAIL | 0 |
| 5935 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | FAIL | 0 |
| 5936 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5937 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 5938 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 2 | PASS | 0 |
| 5939 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 5940 | wholesale-50 | 50 | CARD | ALL×3 | NO | valid | 4 | FAIL | 0 |
| 5941 | wholesale-200 | 200 | CASH+CARD | ALL×4 | YES | expired+راه‌دور | 1 | FAIL | 0 |
| 5942 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | edge | 2 | FAIL | 0 |
| 5943 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | FAIL | 0 |
| 5944 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 5945 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5946 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5947 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 1 |
| 5948 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5949 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | FAIL | 0 |
| 5950 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | FAIL | 0 |
| 5951 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid+راه‌دور | 1 | FAIL | 0 |
| 5952 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 4 | FAIL | 0 |
| 5953 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 5954 | wholesale-500 | 500 | CARD | ALL×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5955 | wholesale-50 | 50 | CASH+CARD | ALL×0 | NO | valid | 3 | PASS | 0 |
| 5956 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 5957 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5958 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 5959 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | FAIL | 0 |
| 5960 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 5961 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×6 | NO | expired+راه‌دور | 1 | FAIL | 0 |
| 5962 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×7 | YES | edge | 2 | FAIL | 0 |
| 5963 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5964 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 5965 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 5966 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5967 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 5968 | wholesale-200 | 200 | CARD | ALL×4 | YES | valid | 4 | FAIL | 0 |
| 5969 | wholesale-500 | 500 | CASH+CARD | ALL×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5970 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 5971 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×7 | YES | valid+راه‌دور | 1 | FAIL | 0 |
| 5972 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5973 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 0 |
| 5974 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 5975 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5976 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | FAIL | 0 |
| 5977 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | FAIL | 0 |
| 5978 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5979 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | FAIL | 0 |
| 5980 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 4 | FAIL | 0 |
| 5981 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | expired+راه‌دور | 1 | PASS | 0 |
| 5982 | wholesale-50 | 50 | CARD | ALL×0 | NO | edge | 2 | PASS | 0 |
| 5983 | wholesale-200 | 200 | CASH+CARD | ALL×1 | YES | valid | 3 | PASS | 0 |
| 5984 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5985 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | FAIL | 0 |
| 5986 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 5987 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5988 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 5989 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | FAIL | 0 |
| 5990 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 5991 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid+راه‌دور | 1 | PASS | 0 |
| 5992 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 5993 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5994 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 2 | FAIL | 0 |
| 5995 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 5996 | wholesale-500 | 500 | CARD | ALL×5 | YES_ZERO | valid | 4 | FAIL | 0 |
| 5997 | wholesale-50 | 50 | CASH+CARD | ALL×6 | NO | valid | 1 | FAIL | 0 |
| 5998 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 5999 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 6000 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |

## FAILهای منطقی (باگ واقعی)
- سناریو 5117 (retail-1 CHEQUE VARIANTS_MULTI): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 5153 (retail-1 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 5333 (retail-1 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 5369 (retail-1 CHEQUE VARIANTS_MULTI): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 5585 (retail-1 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 5657 (retail-1 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 5702 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5705 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5706 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5707 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5709 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5710 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5711 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5714 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5716 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5717 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5718 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5719 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5720 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5723 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5724 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5725 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5726 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5727 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5728 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5732 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5733 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5734 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5735 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5737 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5738 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5741 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5742 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5744 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5745 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5746 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5747 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5751 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5752 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5753 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5754 (wholesale-50 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5755 (wholesale-200 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5756 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5759 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5760 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5761 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5762 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5763 (wholesale-50 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5765 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5768 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5769 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5770 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5772 (wholesale-50 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5773 (wholesale-200 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5774 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5777 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5779 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5780 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5781 (wholesale-50 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5782 (wholesale-200 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5783 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5786 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5787 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5788 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5789 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5790 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5791 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5795 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5796 (wholesale-50 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5797 (wholesale-200 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5798 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5800 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5801 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5804 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5805 (wholesale-50 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5807 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5808 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5809 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5810 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5814 (wholesale-50 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5815 (wholesale-200 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5816 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5817 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5818 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5819 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5822 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5823 (wholesale-50 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5824 (wholesale-200 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5825 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5826 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5828 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5831 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5832 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5833 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5835 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5836 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5837 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5840 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5842 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5843 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5844 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5845 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5846 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5849 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5850 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5851 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5852 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5853 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5854 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5858 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5859 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5860 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5861 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5863 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5864 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5867 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5868 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5870 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5871 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5872 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5873 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5877 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5878 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5879 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5880 (wholesale-50 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5881 (wholesale-200 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5882 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5885 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5886 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5887 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5888 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5889 (wholesale-50 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5891 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5894 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5895 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5896 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5898 (wholesale-50 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5899 (wholesale-200 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5900 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5903 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5905 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5906 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5907 (wholesale-50 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5908 (wholesale-200 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5909 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5912 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5913 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5914 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5915 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5916 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5917 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5921 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5922 (wholesale-50 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5923 (wholesale-200 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5924 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5926 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5927 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5930 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5931 (wholesale-50 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5933 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5934 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5935 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5936 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5940 (wholesale-50 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5941 (wholesale-200 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5942 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5943 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5944 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5945 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5948 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5949 (wholesale-50 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5950 (wholesale-200 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5951 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5952 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5954 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5957 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5958 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5959 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5961 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5962 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5963 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5966 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5968 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5969 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5970 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5971 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5972 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5975 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5976 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5977 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5978 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5979 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5980 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5984 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5985 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5986 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5987 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5989 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5990 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5993 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5994 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5996 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5997 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5998 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 5999 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.

## ردهای منطقی نمونه
- کالای قبلاً برگشت‌خورده دوباره برگشت → سیستم رد کرد → PASS
- بارکد کاملاً مصرف‌شده دوباره استفاده → رد شد → PASS
- فاکتور تاریخ‌گذشته (۴۵ روز پیش) برای تعویض → رد شد → PASS
- موجودی صفر و درخواست فروش → رد شد → PASS
- عدم انتخاب روش تسویه برای مازاد → سیستم متوقف شد → PASS

## روش تست
- هر سناریو یک Shift جدا با SKUهای خودش در یک DB ایزوله؛ هیچ reset بین سناریوها نیست اما داده مشترک نیست.
- همهٔ حالاتِ کمیاب: ۱ تا ۵۰۰ قلم، تا ۸ بارکد (ALL/تک‌کالا/چندکالا/دسته/ترکیبی)، نسیه/چک/ترکیبی فقط ۲ مرحله، زنجیرهٔ تعویض/برگشت تا ۴ سطح (بجز نسیه/چک)، تخفیف NO/YES/YES_ZERO، انقضای لبه/گذشته/راه‌دور.
- هیچ کدی تغییر نکرد؛ فقط SQLite موقت.
