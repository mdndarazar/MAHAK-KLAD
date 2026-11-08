> **یادداشت بازبینی:** این فایل شمارش خام رانر است، نه نتیجهٔ نهایی محصول. از ۲۰۵ خطای خام، ۱۹۹ مورد تکرار F-01 و ۶ مورد ردِ درستِ اعتبارِ خارج از محدوده‌اند؛ ۲۱ PASS خام سناریوی داده‌سازیِ نامعتبر و ۴۸ موردِ دریافتِ اضافه بدون تأیید است. جمع‌بندی معتبر و محدودیت پوشش در `reviewed-report.md` آمده است.

# گزارش جامع ۱۰۰۰ سناریو — ممیزی منطق مالک

**اجرا:** ۱٬۰۰۰/۱٬۰۰۰ سناریو · **PASS** ۷۹۵ · **FAIL منطقی** ۲۰۵ · **رد منطقی** ۳۶۲ (FAIL نیست) · عملیات ۲٬۳۲۵
**دیتابیس:** SQLite موقت ایزوله (/tmp/mahak-comprehensive-round5-1000-AnYNVw/isolated.db) — بدون دست‌زدن به production
**تعریف blue:** cash+card منهای refund؛ چکِ PENDING شمرده نمی‌شود؛ موجودی از StockMovement؛ ALL pooled

**پوشش:** پنل‌ها retail-1, retail-5, retail-30, retail-15, wholesale-200, wholesale-500, wholesale-50؛ پرداخت‌ها CASH, CARD, CASH+CARD, NASIYE, CHEQUE, NASIYE+CHEQUE, CASH+NASIYE, CARD+CHEQUE, CASH+CARD+NASIYE, CASH+CARD+CHEQUE, NASIYE+CHEQUE+CASH, NASIYE+CHEQUE+CARD, NASIYE+CHEQUE+CASH+CARD, BARCODE؛ بارکد NONE, ALL, VARIANTS_SINGLE, VARIANTS_MULTI, CATEGORY_SINGLE, MIXED_ALL+CAT؛ تخفیف NO, YES, YES_ZERO؛ انقضا expired, edge, valid؛ عمق زنجیره 1, 2, 3, 4

> هر FAIL فقط زمانی ثبت شد که رفتار سیستم با منطق مالک ناسازگار بود (محاسبه اشتباه، بدهی اشتباه، اعتبار گمشده، انبار منفی، ALL سهم‌بندی شده). ردهای منطقی (کالای قبلاً برگشت‌خورده، بارکد مصرف‌شده، فاکتور تاریخ‌گذشته، موجودی ناکافی، عدم انتخاب تسویه) به‌درستی PASS شمرده شد.

## جدول خلاصه ۱۰۰۰ سناریو
| # | پنل | اقلام | پرداخت | بارکد | تخفیف | انقضا | زنجیره | وضعیت | رد منطقی |
|---:|---|---|---|---|---|---|---|---|---|
| 4001 | retail-1 | 1 | CASH | NONE×0 | NO | expired+راه‌دور | 1 | PASS | 0 |
| 4002 | retail-5 | 5 | CARD | ALL×1 | YES | edge | 2 | PASS | 0 |
| 4003 | retail-30 | 30 | CASH+CARD | ALL×2 | YES_ZERO | valid | 3 | PASS | 2 |
| 4004 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4005 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 2 |
| 4006 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4007 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 4008 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4009 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4010 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4011 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 4012 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4013 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 4014 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 2 | PASS | 1 |
| 4015 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4016 | retail-15 | 15 | CARD | ALL×6 | NO | valid | 4 | PASS | 1 |
| 4017 | retail-1 | 1 | CASH+CARD | ALL×7 | YES | valid | 1 | PASS | 1 |
| 4018 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4019 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 4020 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4021 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | expired+راه‌دور | 1 | PASS | 1 |
| 4022 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | edge | 2 | PASS | 1 |
| 4023 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 1 |
| 4024 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4025 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 2 |
| 4026 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 2 |
| 4027 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 4028 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 4 | PASS | 0 |
| 4029 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4030 | retail-5 | 5 | CARD | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4031 | retail-30 | 30 | CASH+CARD | ALL×3 | NO | valid+راه‌دور | 3 | PASS | 1 |
| 4032 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4033 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4034 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4035 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 4036 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4037 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 1 |
| 4038 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 4039 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 4040 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 1 |
| 4041 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | expired+راه‌دور | 1 | PASS | 2 |
| 4042 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | edge | 2 | PASS | 1 |
| 4043 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4044 | retail-15 | 15 | CARD | ALL×7 | YES | valid | 4 | PASS | 1 |
| 4045 | retail-1 | 1 | CASH+CARD | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4046 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4047 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 4048 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4049 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 4050 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 4051 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid+راه‌دور | 1 | PASS | 2 |
| 4052 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 4053 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 4054 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4055 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 4056 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 4 | PASS | 0 |
| 4057 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4058 | retail-5 | 5 | CARD | ALL×3 | NO | valid | 2 | PASS | 1 |
| 4059 | retail-30 | 30 | CASH+CARD | ALL×4 | YES | valid | 3 | PASS | 1 |
| 4060 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4061 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×6 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4062 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | edge | 2 | PASS | 2 |
| 4063 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4064 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4065 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 2 |
| 4066 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4067 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 4068 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 1 |
| 4069 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4070 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 2 | PASS | 1 |
| 4071 | retail-30 | 30 | CASH | NONE×0 | YES | valid+راه‌دور | 3 | PASS | 0 |
| 4072 | retail-15 | 15 | CARD | ALL×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 4073 | retail-1 | 1 | CASH+CARD | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4074 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4075 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4076 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4077 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | PASS | 1 |
| 4078 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 4079 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | PASS | 1 |
| 4080 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 4081 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 4082 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | edge | 2 | PASS | 1 |
| 4083 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4084 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 4085 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4086 | retail-5 | 5 | CARD | ALL×4 | YES | valid | 2 | PASS | 1 |
| 4087 | retail-30 | 30 | CASH+CARD | ALL×5 | YES_ZERO | valid | 3 | PASS | 2 |
| 4088 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4089 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | PASS | 2 |
| 4090 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4091 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid+راه‌دور | 1 | PASS | 0 |
| 4092 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4093 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4094 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 4095 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 4096 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4097 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 4098 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 2 | PASS | 1 |
| 4099 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4100 | retail-15 | 15 | CARD | ALL×0 | NO | valid | 4 | PASS | 0 |
| 4101 | retail-1 | 1 | CASH+CARD | ALL×1 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 4102 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | edge | 2 | PASS | 2 |
| 4103 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | PASS | 1 |
| 4104 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4105 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4106 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 4107 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | PASS | 1 |
| 4108 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4109 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 1 |
| 4110 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 2 |
| 4111 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid+راه‌دور | 1 | PASS | 1 |
| 4112 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 4 | PASS | 1 |
| 4113 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4114 | retail-5 | 5 | CARD | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4115 | retail-30 | 30 | CASH+CARD | ALL×6 | NO | valid | 3 | PASS | 1 |
| 4116 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4117 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4118 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4119 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 1 |
| 4120 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4121 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×3 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4122 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×4 | YES | edge | 2 | PASS | 1 |
| 4123 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4124 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | PASS | 1 |
| 4125 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 4126 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4127 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4128 | retail-15 | 15 | CARD | ALL×1 | YES | valid | 4 | PASS | 0 |
| 4129 | retail-1 | 1 | CASH+CARD | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4130 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4131 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×4 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 4132 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4133 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 4134 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 4135 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4136 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4137 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 2 |
| 4138 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4139 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 4140 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 4 | PASS | 1 |
| 4141 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | expired+راه‌دور | 1 | PASS | 0 |
| 4142 | retail-5 | 5 | CARD | ALL×6 | NO | edge | 2 | PASS | 1 |
| 4143 | retail-30 | 30 | CASH+CARD | ALL×7 | YES | valid | 3 | PASS | 1 |
| 4144 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4145 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 4146 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4147 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4148 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4149 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 2 |
| 4150 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4151 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 4152 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 1 |
| 4153 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4154 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 2 | PASS | 0 |
| 4155 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4156 | retail-15 | 15 | CARD | ALL×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 4157 | retail-1 | 1 | CASH+CARD | ALL×3 | NO | valid | 1 | PASS | 1 |
| 4158 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4159 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4160 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4161 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 4162 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | edge | 2 | PASS | 1 |
| 4163 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4164 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 4165 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4166 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 2 |
| 4167 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 4168 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 4169 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4170 | retail-5 | 5 | CARD | ALL×7 | YES | valid | 2 | PASS | 1 |
| 4171 | retail-30 | 30 | CASH+CARD | ALL×8 | YES_ZERO | valid+راه‌دور | 3 | PASS | 2 |
| 4172 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4173 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 4174 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4175 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 4176 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4177 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4178 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 4179 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 1 |
| 4180 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4181 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4182 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×1 | YES | edge | 2 | PASS | 0 |
| 4183 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4184 | retail-15 | 15 | CARD | ALL×3 | NO | valid | 4 | PASS | 1 |
| 4185 | retail-1 | 1 | CASH+CARD | ALL×4 | YES | valid | 1 | PASS | 1 |
| 4186 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4187 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | PASS | 1 |
| 4188 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4189 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 4190 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 4191 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×1 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 4192 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4193 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 2 |
| 4194 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 2 |
| 4195 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4196 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 4 | PASS | 1 |
| 4197 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4198 | retail-5 | 5 | CARD | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4199 | retail-30 | 30 | CASH+CARD | ALL×0 | NO | valid | 3 | PASS | 0 |
| 4200 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4201 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 4202 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | edge | 2 | PASS | 2 |
| 4203 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | PASS | 1 |
| 4204 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4205 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | PASS | 2 |
| 4206 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 4207 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 4208 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 4209 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 2 |
| 4210 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4211 | retail-30 | 30 | CASH | NONE×0 | NO | valid+راه‌دور | 3 | PASS | 0 |
| 4212 | retail-15 | 15 | CARD | ALL×4 | YES | valid | 4 | PASS | 1 |
| 4213 | retail-1 | 1 | CASH+CARD | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4214 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4215 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | PASS | 1 |
| 4216 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4217 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 1 |
| 4218 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 4219 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4220 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 4221 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | expired+راه‌دور | 1 | PASS | 2 |
| 4222 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | edge | 2 | PASS | 2 |
| 4223 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 4224 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 4 | PASS | 1 |
| 4225 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4226 | retail-5 | 5 | CARD | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4227 | retail-30 | 30 | CASH+CARD | ALL×1 | YES | valid | 3 | PASS | 0 |
| 4228 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4229 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | PASS | 1 |
| 4230 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4231 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid+راه‌دور | 1 | PASS | 2 |
| 4232 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4233 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | PASS | 2 |
| 4234 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4235 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 4236 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 4237 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4238 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 2 | PASS | 1 |
| 4239 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4240 | retail-15 | 15 | CARD | ALL×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 4241 | retail-1 | 1 | CASH+CARD | ALL×6 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4242 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×7 | YES | edge | 2 | PASS | 2 |
| 4243 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 4244 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4245 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 2 |
| 4246 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 4247 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | PASS | 1 |
| 4248 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | PASS | 1 |
| 4249 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4250 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | PASS | 2 |
| 4251 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 4252 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 4253 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4254 | retail-5 | 5 | CARD | ALL×1 | YES | valid | 2 | PASS | 0 |
| 4255 | retail-30 | 30 | CASH+CARD | ALL×2 | YES_ZERO | valid | 3 | PASS | 2 |
| 4256 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4257 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 2 |
| 4258 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4259 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 4260 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4261 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 4262 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×0 | NO | edge | 2 | PASS | 0 |
| 4263 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4264 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4265 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 2 |
| 4266 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 2 | PASS | 1 |
| 4267 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4268 | retail-15 | 15 | CARD | ALL×6 | NO | valid | 4 | PASS | 1 |
| 4269 | retail-1 | 1 | CASH+CARD | ALL×7 | YES | valid | 1 | PASS | 1 |
| 4270 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4271 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×0 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 4272 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4273 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 4274 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 4275 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 1 |
| 4276 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4277 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 2 |
| 4278 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 2 |
| 4279 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 4280 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 4 | PASS | 0 |
| 4281 | retail-1 | 1 | CASH | NONE×0 | YES | expired+راه‌دور | 1 | PASS | 0 |
| 4282 | retail-5 | 5 | CARD | ALL×2 | YES_ZERO | edge | 2 | PASS | 1 |
| 4283 | retail-30 | 30 | CASH+CARD | ALL×3 | NO | valid | 3 | PASS | 1 |
| 4284 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4285 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4286 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4287 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 4288 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4289 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 1 |
| 4290 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 4291 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid+راه‌دور | 1 | PASS | 1 |
| 4292 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 1 |
| 4293 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | PASS | 2 |
| 4294 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4295 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4296 | retail-15 | 15 | CARD | ALL×7 | YES | valid | 4 | PASS | 1 |
| 4297 | retail-1 | 1 | CASH+CARD | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4298 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4299 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 4300 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4301 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4302 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | edge | 2 | PASS | 1 |
| 4303 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4304 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 4305 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 4306 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4307 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 4308 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 4 | PASS | 0 |
| 4309 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4310 | retail-5 | 5 | CARD | ALL×3 | NO | valid | 2 | PASS | 1 |
| 4311 | retail-30 | 30 | CASH+CARD | ALL×4 | YES | valid+راه‌دور | 3 | PASS | 1 |
| 4312 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4313 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | PASS | 1 |
| 4314 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4315 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4316 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4317 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 2 |
| 4318 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4319 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 4320 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 1 |
| 4321 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 4322 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×6 | NO | edge | 2 | PASS | 1 |
| 4323 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4324 | retail-15 | 15 | CARD | ALL×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 4325 | retail-1 | 1 | CASH+CARD | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4326 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4327 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4328 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4329 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | PASS | 1 |
| 4330 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 4331 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×6 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 4332 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 4333 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4334 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 1 |
| 4335 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4336 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 4337 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4338 | retail-5 | 5 | CARD | ALL×4 | YES | valid | 2 | PASS | 1 |
| 4339 | retail-30 | 30 | CASH+CARD | ALL×5 | YES_ZERO | valid | 3 | PASS | 2 |
| 4340 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4341 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×7 | YES | expired+راه‌دور | 1 | PASS | 2 |
| 4342 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | edge | 2 | PASS | 2 |
| 4343 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 0 |
| 4344 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4345 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4346 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 4347 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 4348 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4349 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 4350 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 2 | PASS | 1 |
| 4351 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid+راه‌دور | 3 | PASS | 0 |
| 4352 | retail-15 | 15 | CARD | ALL×0 | NO | valid | 4 | PASS | 0 |
| 4353 | retail-1 | 1 | CASH+CARD | ALL×1 | YES | valid | 1 | PASS | 0 |
| 4354 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4355 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | PASS | 1 |
| 4356 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4357 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4358 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 4359 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | PASS | 1 |
| 4360 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4361 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4362 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | edge | 2 | PASS | 2 |
| 4363 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 4364 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 4 | PASS | 1 |
| 4365 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4366 | retail-5 | 5 | CARD | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4367 | retail-30 | 30 | CASH+CARD | ALL×6 | NO | valid | 3 | PASS | 1 |
| 4368 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4369 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4370 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4371 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 4372 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4373 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | PASS | 1 |
| 4374 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | PASS | 1 |
| 4375 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4376 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | PASS | 1 |
| 4377 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 4378 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4379 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4380 | retail-15 | 15 | CARD | ALL×1 | YES | valid | 4 | PASS | 0 |
| 4381 | retail-1 | 1 | CASH+CARD | ALL×2 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 4382 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×3 | NO | edge | 2 | PASS | 2 |
| 4383 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 1 |
| 4384 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4385 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 4386 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 4387 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4388 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4389 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 2 |
| 4390 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4391 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 4392 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 4 | PASS | 1 |
| 4393 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4394 | retail-5 | 5 | CARD | ALL×6 | NO | valid | 2 | PASS | 1 |
| 4395 | retail-30 | 30 | CASH+CARD | ALL×7 | YES | valid | 3 | PASS | 1 |
| 4396 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4397 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 4398 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4399 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4400 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4401 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×4 | YES | expired+راه‌دور | 1 | PASS | 2 |
| 4402 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | edge | 2 | PASS | 1 |
| 4403 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 4404 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 1 |
| 4405 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4406 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 2 | PASS | 0 |
| 4407 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4408 | retail-15 | 15 | CARD | ALL×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 4409 | retail-1 | 1 | CASH+CARD | ALL×3 | NO | valid | 1 | PASS | 1 |
| 4410 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4411 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid+راه‌دور | 1 | PASS | 1 |
| 4412 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4413 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 4414 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 4415 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4416 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 4417 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4418 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 2 |
| 4419 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 4420 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 4421 | retail-1 | 1 | CASH | NONE×0 | NO | expired+راه‌دور | 1 | PASS | 0 |
| 4422 | retail-5 | 5 | CARD | ALL×7 | YES | edge | 2 | PASS | 1 |
| 4423 | retail-30 | 30 | CASH+CARD | ALL×8 | YES_ZERO | valid | 3 | PASS | 2 |
| 4424 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4425 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 4426 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4427 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 4428 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4429 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4430 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 4431 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 4432 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4433 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 1 |
| 4434 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 2 | PASS | 0 |
| 4435 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4436 | retail-15 | 15 | CARD | ALL×3 | NO | valid | 4 | PASS | 1 |
| 4437 | retail-1 | 1 | CASH+CARD | ALL×4 | YES | valid | 1 | PASS | 1 |
| 4438 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4439 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | PASS | 1 |
| 4440 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4441 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | expired+راه‌دور | 1 | PASS | 1 |
| 4442 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | edge | 2 | PASS | 1 |
| 4443 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 1 |
| 4444 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4445 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 2 |
| 4446 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 2 |
| 4447 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4448 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 4 | PASS | 1 |
| 4449 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4450 | retail-5 | 5 | CARD | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4451 | retail-30 | 30 | CASH+CARD | ALL×0 | NO | valid+راه‌دور | 3 | PASS | 0 |
| 4452 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4453 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4454 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4455 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | PASS | 1 |
| 4456 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4457 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | PASS | 2 |
| 4458 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 4459 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 4460 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 4461 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 4462 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | edge | 2 | PASS | 1 |
| 4463 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4464 | retail-15 | 15 | CARD | ALL×4 | YES | valid | 4 | PASS | 1 |
| 4465 | retail-1 | 1 | CASH+CARD | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4466 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4467 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | PASS | 1 |
| 4468 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4469 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 1 |
| 4470 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 4471 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid+راه‌دور | 1 | PASS | 2 |
| 4472 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 4473 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | PASS | 2 |
| 4474 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4475 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 4476 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 4 | PASS | 1 |
| 4477 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4478 | retail-5 | 5 | CARD | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4479 | retail-30 | 30 | CASH+CARD | ALL×1 | YES | valid | 3 | PASS | 0 |
| 4480 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4481 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×3 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4482 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | edge | 2 | PASS | 2 |
| 4483 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4484 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4485 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | PASS | 2 |
| 4486 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4487 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 4488 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 4489 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4490 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 2 | PASS | 1 |
| 4491 | retail-30 | 30 | CASH | NONE×0 | YES | valid+راه‌دور | 3 | PASS | 0 |
| 4492 | retail-15 | 15 | CARD | ALL×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 4493 | retail-1 | 1 | CASH+CARD | ALL×6 | NO | valid | 1 | PASS | 1 |
| 4494 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4495 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 4496 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4497 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 2 |
| 4498 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 4499 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | PASS | 1 |
| 4500 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | PASS | 1 |
| 4501 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 4502 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | edge | 2 | PASS | 2 |
| 4503 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | PASS | 1 |
| 4504 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 4505 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4506 | retail-5 | 5 | CARD | ALL×1 | YES | valid | 2 | PASS | 0 |
| 4507 | retail-30 | 30 | CASH+CARD | ALL×2 | YES_ZERO | valid | 3 | PASS | 2 |
| 4508 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4509 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 2 |
| 4510 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4511 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 4512 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4513 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4514 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4515 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4516 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4517 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 2 |
| 4518 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 2 | PASS | 1 |
| 4519 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4520 | retail-15 | 15 | CARD | ALL×6 | NO | valid | 4 | PASS | 1 |
| 4521 | retail-1 | 1 | CASH+CARD | ALL×7 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 4522 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | edge | 2 | PASS | 2 |
| 4523 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 4524 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4525 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 4526 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 4527 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 1 |
| 4528 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4529 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 4530 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 2 |
| 4531 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid+راه‌دور | 1 | PASS | 1 |
| 4532 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 4 | PASS | 0 |
| 4533 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4534 | retail-5 | 5 | CARD | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4535 | retail-30 | 30 | CASH+CARD | ALL×3 | NO | valid | 3 | PASS | 1 |
| 4536 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4537 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4538 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4539 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 4540 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4541 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×0 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4542 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×1 | YES | edge | 2 | PASS | 1 |
| 4543 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 4544 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 1 |
| 4545 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | PASS | 2 |
| 4546 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4547 | retail-30 | 30 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4548 | retail-15 | 15 | CARD | ALL×7 | YES | valid | 4 | PASS | 1 |
| 4549 | retail-1 | 1 | CASH+CARD | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4550 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4551 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×1 | YES | valid+راه‌دور | 1 | PASS | 2 |
| 4552 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4553 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 4554 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 4555 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4556 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | PASS | 1 |
| 4557 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 4558 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4559 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 4560 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 4 | PASS | 0 |
| 4561 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | expired+راه‌دور | 1 | PASS | 0 |
| 4562 | retail-5 | 5 | CARD | ALL×3 | NO | edge | 2 | PASS | 1 |
| 4563 | retail-30 | 30 | CASH+CARD | ALL×4 | YES | valid | 3 | PASS | 1 |
| 4564 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4565 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | PASS | 2 |
| 4566 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4567 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4568 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4569 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 2 |
| 4570 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4571 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 4572 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 1 |
| 4573 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 2 |
| 4574 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 2 | PASS | 1 |
| 4575 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4576 | retail-15 | 15 | CARD | ALL×8 | YES_ZERO | valid | 4 | PASS | 1 |
| 4577 | retail-1 | 1 | CASH+CARD | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4578 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4579 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4580 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4581 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 4582 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | edge | 2 | PASS | 1 |
| 4583 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | PASS | 1 |
| 4584 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | PASS | 1 |
| 4585 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4586 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 1 |
| 4587 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4588 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 4589 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4590 | retail-5 | 5 | CARD | ALL×4 | YES | valid | 2 | PASS | 1 |
| 4591 | retail-30 | 30 | CASH+CARD | ALL×5 | YES_ZERO | valid+راه‌دور | 3 | PASS | 2 |
| 4592 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4593 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | PASS | 2 |
| 4594 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4595 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 0 |
| 4596 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4597 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4598 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | PASS | 1 |
| 4599 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | PASS | 1 |
| 4600 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4601 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4602 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×7 | YES | edge | 2 | PASS | 1 |
| 4603 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4604 | retail-15 | 15 | CARD | ALL×0 | NO | valid | 4 | PASS | 0 |
| 4605 | retail-1 | 1 | CASH+CARD | ALL×1 | YES | valid | 1 | PASS | 0 |
| 4606 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4607 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | PASS | 1 |
| 4608 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | PASS | 2 |
| 4609 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4610 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 4611 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×7 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 4612 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4613 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 1 |
| 4614 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 2 |
| 4615 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 1 |
| 4616 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 4 | PASS | 1 |
| 4617 | retail-1 | 1 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4618 | retail-5 | 5 | CARD | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4619 | retail-30 | 30 | CASH+CARD | ALL×6 | NO | valid | 3 | PASS | 1 |
| 4620 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4621 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 4622 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | edge | 2 | PASS | 1 |
| 4623 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 1 |
| 4624 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4625 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | PASS | 2 |
| 4626 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | PASS | 1 |
| 4627 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4628 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | PASS | 1 |
| 4629 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | PASS | 2 |
| 4630 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4631 | retail-30 | 30 | CASH | NONE×0 | NO | valid+راه‌دور | 3 | PASS | 0 |
| 4632 | retail-15 | 15 | CARD | ALL×1 | YES | valid | 4 | PASS | 0 |
| 4633 | retail-1 | 1 | CASH+CARD | ALL×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4634 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | PASS | 2 |
| 4635 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | PASS | 1 |
| 4636 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4637 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | PASS | 1 |
| 4638 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 1 |
| 4639 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | PASS | 2 |
| 4640 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4641 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | expired+راه‌دور | 1 | PASS | 1 |
| 4642 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | edge | 2 | PASS | 2 |
| 4643 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 4644 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 4 | PASS | 1 |
| 4645 | retail-1 | 1 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4646 | retail-5 | 5 | CARD | ALL×6 | NO | valid | 2 | PASS | 1 |
| 4647 | retail-30 | 30 | CASH+CARD | ALL×7 | YES | valid | 3 | PASS | 1 |
| 4648 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | PASS | 2 |
| 4649 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 4650 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4651 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid+راه‌دور | 1 | PASS | 2 |
| 4652 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4653 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | PASS | 2 |
| 4654 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | PASS | 1 |
| 4655 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | PASS | 1 |
| 4656 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | PASS | 1 |
| 4657 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4658 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 2 | PASS | 0 |
| 4659 | retail-30 | 30 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4660 | retail-15 | 15 | CARD | ALL×2 | YES_ZERO | valid | 4 | PASS | 1 |
| 4661 | retail-1 | 1 | CASH+CARD | ALL×3 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4662 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×4 | YES | edge | 2 | PASS | 2 |
| 4663 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4664 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | PASS | 2 |
| 4665 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | PASS | 1 |
| 4666 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 1 |
| 4667 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4668 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 4669 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | PASS | 2 |
| 4670 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | PASS | 2 |
| 4671 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid+راه‌دور | 1 | PASS | 1 |
| 4672 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 4 | PASS | 1 |
| 4673 | retail-1 | 1 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4674 | retail-5 | 5 | CARD | ALL×7 | YES | valid | 2 | PASS | 1 |
| 4675 | retail-30 | 30 | CASH+CARD | ALL×8 | YES_ZERO | valid | 3 | PASS | 2 |
| 4676 | retail-15 | 15 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4677 | retail-1 | 1 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 4678 | retail-5 | 5 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | PASS | 2 |
| 4679 | retail-30 | 30 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | PASS | 1 |
| 4680 | retail-15 | 15 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4681 | retail-1 | 1 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | expired+راه‌دور | 1 | PASS | 2 |
| 4682 | retail-5 | 5 | CASH+CARD+CHEQUE | ALL×6 | NO | edge | 2 | PASS | 1 |
| 4683 | retail-30 | 30 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | PASS | 1 |
| 4684 | retail-15 | 15 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | PASS | 1 |
| 4685 | retail-1 | 1 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 1 |
| 4686 | retail-5 | 5 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 2 | PASS | 0 |
| 4687 | retail-30 | 30 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4688 | retail-15 | 15 | CARD | ALL×3 | NO | valid | 4 | PASS | 1 |
| 4689 | retail-1 | 1 | CASH+CARD | ALL×4 | YES | valid | 1 | PASS | 1 |
| 4690 | retail-5 | 5 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | PASS | 2 |
| 4691 | retail-30 | 30 | CHEQUE | VARIANTS_MULTI×6 | NO | valid+راه‌دور | 1 | PASS | 1 |
| 4692 | retail-15 | 15 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | PASS | 2 |
| 4693 | retail-1 | 1 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | PASS | 1 |
| 4694 | retail-5 | 5 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 1 |
| 4695 | retail-30 | 30 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 1 |
| 4696 | retail-15 | 15 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | PASS | 1 |
| 4697 | retail-1 | 1 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | PASS | 1 |
| 4698 | retail-5 | 5 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | PASS | 2 |
| 4699 | retail-30 | 30 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | PASS | 1 |
| 4700 | retail-15 | 15 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 4 | PASS | 1 |
| 4701 | wholesale-200 | 200 | CASH | NONE×0 | YES | expired+راه‌دور | 1 | PASS | 0 |
| 4702 | wholesale-500 | 500 | CARD | ALL×8 | YES_ZERO | edge | 2 | FAIL | 0 |
| 4703 | wholesale-50 | 50 | CASH+CARD | ALL×0 | NO | valid | 3 | PASS | 0 |
| 4704 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4705 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4706 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 4707 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | FAIL | 0 |
| 4708 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4709 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | FAIL | 0 |
| 4710 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | FAIL | 0 |
| 4711 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid+راه‌دور | 1 | FAIL | 0 |
| 4712 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 4713 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4714 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4715 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4716 | wholesale-200 | 200 | CARD | ALL×4 | YES | valid | 4 | FAIL | 0 |
| 4717 | wholesale-500 | 500 | CASH+CARD | ALL×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4718 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 4719 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | FAIL | 0 |
| 4720 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4721 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | expired+راه‌دور | 1 | PASS | 0 |
| 4722 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | edge | 2 | PASS | 0 |
| 4723 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4724 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | FAIL | 0 |
| 4725 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | FAIL | 0 |
| 4726 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4727 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | FAIL | 0 |
| 4728 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 4 | FAIL | 0 |
| 4729 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4730 | wholesale-50 | 50 | CARD | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4731 | wholesale-200 | 200 | CASH+CARD | ALL×1 | YES | valid+راه‌دور | 3 | PASS | 0 |
| 4732 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4733 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | FAIL | 0 |
| 4734 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 4735 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4736 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4737 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | FAIL | 0 |
| 4738 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4739 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 4740 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 4741 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | expired+راه‌دور | 1 | FAIL | 0 |
| 4742 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×3 | NO | edge | 2 | FAIL | 0 |
| 4743 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4744 | wholesale-500 | 500 | CARD | ALL×5 | YES_ZERO | valid | 4 | FAIL | 0 |
| 4745 | wholesale-50 | 50 | CASH+CARD | ALL×6 | NO | valid | 1 | FAIL | 0 |
| 4746 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 4747 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4748 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4749 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 1 |
| 4750 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4751 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×3 | NO | valid+راه‌دور | 1 | FAIL | 0 |
| 4752 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | FAIL | 0 |
| 4753 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4754 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | FAIL | 0 |
| 4755 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | valid | 1 | FAIL | 0 |
| 4756 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 4 | FAIL | 0 |
| 4757 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4758 | wholesale-200 | 200 | CARD | ALL×1 | YES | valid | 2 | PASS | 0 |
| 4759 | wholesale-500 | 500 | CASH+CARD | ALL×2 | YES_ZERO | valid | 3 | FAIL | 0 |
| 4760 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 4761 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×4 | YES | expired+راه‌دور | 1 | FAIL | 0 |
| 4762 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | edge | 2 | FAIL | 0 |
| 4763 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | FAIL | 0 |
| 4764 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4765 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4766 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4767 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4768 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4769 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | FAIL | 0 |
| 4770 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 2 | FAIL | 0 |
| 4771 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid+راه‌دور | 3 | PASS | 0 |
| 4772 | wholesale-50 | 50 | CARD | ALL×6 | NO | valid | 4 | FAIL | 0 |
| 4773 | wholesale-200 | 200 | CASH+CARD | ALL×7 | YES | valid | 1 | FAIL | 0 |
| 4774 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4775 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×0 | NO | valid | 1 | PASS | 1 |
| 4776 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4777 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4778 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4779 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | FAIL | 0 |
| 4780 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4781 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | expired+راه‌دور | 1 | FAIL | 0 |
| 4782 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | edge | 2 | FAIL | 0 |
| 4783 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4784 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 4 | PASS | 0 |
| 4785 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4786 | wholesale-500 | 500 | CARD | ALL×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4787 | wholesale-50 | 50 | CASH+CARD | ALL×3 | NO | valid | 3 | FAIL | 0 |
| 4788 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 4789 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4790 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 4791 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid+راه‌دور | 1 | FAIL | 0 |
| 4792 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4793 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4794 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 4795 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4796 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | valid | 2 | FAIL | 0 |
| 4797 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | FAIL | 0 |
| 4798 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4799 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4800 | wholesale-200 | 200 | CARD | ALL×7 | YES | valid | 4 | FAIL | 0 |
| 4801 | wholesale-500 | 500 | CASH+CARD | ALL×8 | YES_ZERO | expired+راه‌دور | 1 | FAIL | 0 |
| 4802 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×0 | NO | edge | 2 | PASS | 1 |
| 4803 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 4804 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4805 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid | 1 | FAIL | 0 |
| 4806 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4807 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4808 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | FAIL | 0 |
| 4809 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | FAIL | 0 |
| 4810 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4811 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid+راه‌دور | 1 | PASS | 0 |
| 4812 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 4 | PASS | 0 |
| 4813 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4814 | wholesale-50 | 50 | CARD | ALL×3 | NO | valid | 2 | FAIL | 0 |
| 4815 | wholesale-200 | 200 | CASH+CARD | ALL×4 | YES | valid | 3 | FAIL | 0 |
| 4816 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4817 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | FAIL | 0 |
| 4818 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 4819 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4820 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4821 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×1 | YES | expired+راه‌دور | 1 | PASS | 0 |
| 4822 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | edge | 2 | FAIL | 0 |
| 4823 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | FAIL | 0 |
| 4824 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | FAIL | 0 |
| 4825 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4826 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 2 | FAIL | 0 |
| 4827 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4828 | wholesale-500 | 500 | CARD | ALL×8 | YES_ZERO | valid | 4 | FAIL | 0 |
| 4829 | wholesale-50 | 50 | CASH+CARD | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4830 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4831 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid+راه‌دور | 1 | FAIL | 0 |
| 4832 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 4833 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | FAIL | 0 |
| 4834 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4835 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×6 | NO | valid | 1 | FAIL | 0 |
| 4836 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×7 | YES | valid | 2 | FAIL | 0 |
| 4837 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4838 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 4839 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4840 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 4 | FAIL | 0 |
| 4841 | wholesale-50 | 50 | CASH | NONE×0 | NO | expired+راه‌دور | 1 | PASS | 0 |
| 4842 | wholesale-200 | 200 | CARD | ALL×4 | YES | edge | 2 | FAIL | 0 |
| 4843 | wholesale-500 | 500 | CASH+CARD | ALL×5 | YES_ZERO | valid | 3 | FAIL | 0 |
| 4844 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 4845 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×7 | YES | valid | 1 | FAIL | 0 |
| 4846 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4847 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 0 |
| 4848 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4849 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4850 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | FAIL | 0 |
| 4851 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid+راه‌دور | 1 | FAIL | 0 |
| 4852 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4853 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | FAIL | 0 |
| 4854 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 2 | FAIL | 0 |
| 4855 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4856 | wholesale-50 | 50 | CARD | ALL×0 | NO | valid | 4 | PASS | 0 |
| 4857 | wholesale-200 | 200 | CASH+CARD | ALL×1 | YES | valid | 1 | PASS | 0 |
| 4858 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4859 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | FAIL | 0 |
| 4860 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 4861 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | expired+راه‌دور | 1 | FAIL | 0 |
| 4862 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | edge | 2 | PASS | 0 |
| 4863 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | FAIL | 0 |
| 4864 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4865 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 4866 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 4867 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4868 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 4 | FAIL | 0 |
| 4869 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4870 | wholesale-500 | 500 | CARD | ALL×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4871 | wholesale-50 | 50 | CASH+CARD | ALL×6 | NO | valid+راه‌دور | 3 | FAIL | 0 |
| 4872 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 4873 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4874 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4875 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×1 | YES | valid | 1 | PASS | 1 |
| 4876 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4877 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×3 | NO | valid | 1 | FAIL | 0 |
| 4878 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×4 | YES | valid | 2 | FAIL | 0 |
| 4879 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4880 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×6 | NO | valid | 2 | FAIL | 0 |
| 4881 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×7 | YES | expired+راه‌دور | 1 | FAIL | 0 |
| 4882 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×8 | YES_ZERO | edge | 2 | FAIL | 0 |
| 4883 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4884 | wholesale-200 | 200 | CARD | ALL×1 | YES | valid | 4 | PASS | 0 |
| 4885 | wholesale-500 | 500 | CASH+CARD | ALL×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4886 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 4887 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×4 | YES | valid | 1 | FAIL | 0 |
| 4888 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4889 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×6 | NO | valid | 1 | FAIL | 0 |
| 4890 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4891 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×8 | YES_ZERO | valid+راه‌دور | 1 | FAIL | 0 |
| 4892 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×0 | NO | valid | 2 | PASS | 0 |
| 4893 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4894 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4895 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×3 | NO | valid | 1 | FAIL | 0 |
| 4896 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×4 | YES | valid | 4 | FAIL | 0 |
| 4897 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 1 | PASS | 0 |
| 4898 | wholesale-50 | 50 | CARD | ALL×6 | NO | valid | 2 | FAIL | 0 |
| 4899 | wholesale-200 | 200 | CASH+CARD | ALL×7 | YES | valid | 3 | FAIL | 0 |
| 4900 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4901 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×0 | NO | expired+راه‌دور | 1 | PASS | 1 |
| 4902 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×1 | YES | edge | 2 | PASS | 2 |
| 4903 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4904 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4905 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×4 | YES | valid | 1 | FAIL | 0 |
| 4906 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4907 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×6 | NO | valid | 1 | FAIL | 0 |
| 4908 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×7 | YES | valid | 2 | FAIL | 0 |
| 4909 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4910 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×0 | NO | valid | 2 | PASS | 0 |
| 4911 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid+راه‌دور | 3 | PASS | 0 |
| 4912 | wholesale-500 | 500 | CARD | ALL×2 | YES_ZERO | valid | 4 | FAIL | 0 |
| 4913 | wholesale-50 | 50 | CASH+CARD | ALL×3 | NO | valid | 1 | FAIL | 0 |
| 4914 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 4915 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4916 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 4917 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×7 | YES | valid | 1 | FAIL | 0 |
| 4918 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4919 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×0 | NO | valid | 1 | PASS | 0 |
| 4920 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×1 | YES | valid | 2 | PASS | 1 |
| 4921 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×2 | YES_ZERO | expired+راه‌دور | 1 | FAIL | 0 |
| 4922 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×3 | NO | edge | 2 | FAIL | 0 |
| 4923 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×4 | YES | valid | 1 | FAIL | 0 |
| 4924 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 4 | FAIL | 0 |
| 4925 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 1 | PASS | 0 |
| 4926 | wholesale-200 | 200 | CARD | ALL×7 | YES | valid | 2 | FAIL | 0 |
| 4927 | wholesale-500 | 500 | CASH+CARD | ALL×8 | YES_ZERO | valid | 3 | FAIL | 0 |
| 4928 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×0 | NO | valid | 2 | PASS | 1 |
| 4929 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×1 | YES | valid | 1 | PASS | 2 |
| 4930 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4931 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×3 | NO | valid+راه‌دور | 1 | FAIL | 0 |
| 4932 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4933 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4934 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×6 | NO | valid | 2 | FAIL | 0 |
| 4935 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×7 | YES | valid | 1 | FAIL | 0 |
| 4936 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4937 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×0 | NO | valid | 1 | PASS | 0 |
| 4938 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×1 | YES | valid | 2 | PASS | 0 |
| 4939 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | valid | 3 | PASS | 0 |
| 4940 | wholesale-50 | 50 | CARD | ALL×3 | NO | valid | 4 | FAIL | 0 |
| 4941 | wholesale-200 | 200 | CASH+CARD | ALL×4 | YES | expired+راه‌دور | 1 | FAIL | 0 |
| 4942 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×5 | YES_ZERO | edge | 2 | FAIL | 0 |
| 4943 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×6 | NO | valid | 1 | FAIL | 0 |
| 4944 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 4945 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4946 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4947 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×1 | YES | valid | 1 | PASS | 1 |
| 4948 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4949 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×3 | NO | valid | 1 | FAIL | 0 |
| 4950 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×4 | YES | valid | 2 | FAIL | 0 |
| 4951 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×5 | YES_ZERO | valid+راه‌دور | 1 | FAIL | 0 |
| 4952 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×6 | NO | valid | 4 | FAIL | 0 |
| 4953 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 1 | PASS | 0 |
| 4954 | wholesale-500 | 500 | CARD | ALL×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4955 | wholesale-50 | 50 | CASH+CARD | ALL×0 | NO | valid | 3 | PASS | 0 |
| 4956 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×1 | YES | valid | 2 | PASS | 2 |
| 4957 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4958 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×3 | NO | valid | 2 | FAIL | 0 |
| 4959 | wholesale-200 | 200 | CASH+NASIYE | MIXED_ALL+CAT×4 | YES | valid | 1 | FAIL | 0 |
| 4960 | wholesale-500 | 500 | CARD+CHEQUE | NONE×0 | YES_ZERO | valid | 2 | PASS | 0 |
| 4961 | wholesale-50 | 50 | CASH+CARD+NASIYE | ALL×6 | NO | expired+راه‌دور | 1 | FAIL | 0 |
| 4962 | wholesale-200 | 200 | CASH+CARD+CHEQUE | ALL×7 | YES | edge | 2 | FAIL | 0 |
| 4963 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4964 | wholesale-50 | 50 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×0 | NO | valid | 2 | PASS | 0 |
| 4965 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×1 | YES | valid | 1 | PASS | 1 |
| 4966 | wholesale-500 | 500 | BARCODE | MIXED_ALL+CAT×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4967 | wholesale-50 | 50 | CASH | NONE×0 | NO | valid | 3 | PASS | 0 |
| 4968 | wholesale-200 | 200 | CARD | ALL×4 | YES | valid | 4 | FAIL | 0 |
| 4969 | wholesale-500 | 500 | CASH+CARD | ALL×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4970 | wholesale-50 | 50 | NASIYE | VARIANTS_SINGLE×6 | NO | valid | 2 | FAIL | 0 |
| 4971 | wholesale-200 | 200 | CHEQUE | VARIANTS_MULTI×7 | YES | valid+راه‌دور | 1 | FAIL | 0 |
| 4972 | wholesale-500 | 500 | NASIYE+CHEQUE | CATEGORY_SINGLE×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4973 | wholesale-50 | 50 | CASH+NASIYE | MIXED_ALL+CAT×0 | NO | valid | 1 | PASS | 0 |
| 4974 | wholesale-200 | 200 | CARD+CHEQUE | NONE×0 | YES | valid | 2 | PASS | 0 |
| 4975 | wholesale-500 | 500 | CASH+CARD+NASIYE | ALL×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4976 | wholesale-50 | 50 | CASH+CARD+CHEQUE | ALL×3 | NO | valid | 2 | FAIL | 0 |
| 4977 | wholesale-200 | 200 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×4 | YES | valid | 1 | FAIL | 0 |
| 4978 | wholesale-500 | 500 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×5 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4979 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×6 | NO | valid | 1 | FAIL | 0 |
| 4980 | wholesale-200 | 200 | BARCODE | MIXED_ALL+CAT×7 | YES | valid | 4 | FAIL | 0 |
| 4981 | wholesale-500 | 500 | CASH | NONE×0 | YES_ZERO | expired+راه‌دور | 1 | PASS | 0 |
| 4982 | wholesale-50 | 50 | CARD | ALL×0 | NO | edge | 2 | PASS | 0 |
| 4983 | wholesale-200 | 200 | CASH+CARD | ALL×1 | YES | valid | 3 | PASS | 0 |
| 4984 | wholesale-500 | 500 | NASIYE | VARIANTS_SINGLE×2 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4985 | wholesale-50 | 50 | CHEQUE | VARIANTS_MULTI×3 | NO | valid | 1 | FAIL | 0 |
| 4986 | wholesale-200 | 200 | NASIYE+CHEQUE | CATEGORY_SINGLE×4 | YES | valid | 2 | FAIL | 0 |
| 4987 | wholesale-500 | 500 | CASH+NASIYE | MIXED_ALL+CAT×5 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4988 | wholesale-50 | 50 | CARD+CHEQUE | NONE×0 | NO | valid | 2 | PASS | 0 |
| 4989 | wholesale-200 | 200 | CASH+CARD+NASIYE | ALL×7 | YES | valid | 1 | FAIL | 0 |
| 4990 | wholesale-500 | 500 | CASH+CARD+CHEQUE | ALL×8 | YES_ZERO | valid | 2 | FAIL | 0 |
| 4991 | wholesale-50 | 50 | NASIYE+CHEQUE+CASH | VARIANTS_SINGLE×0 | NO | valid+راه‌دور | 1 | PASS | 0 |
| 4992 | wholesale-200 | 200 | NASIYE+CHEQUE+CARD | VARIANTS_MULTI×1 | YES | valid | 2 | PASS | 1 |
| 4993 | wholesale-500 | 500 | NASIYE+CHEQUE+CASH+CARD | CATEGORY_SINGLE×2 | YES_ZERO | valid | 1 | FAIL | 0 |
| 4994 | wholesale-50 | 50 | BARCODE | MIXED_ALL+CAT×3 | NO | valid | 2 | FAIL | 0 |
| 4995 | wholesale-200 | 200 | CASH | NONE×0 | YES | valid | 3 | PASS | 0 |
| 4996 | wholesale-500 | 500 | CARD | ALL×5 | YES_ZERO | valid | 4 | FAIL | 0 |
| 4997 | wholesale-50 | 50 | CASH+CARD | ALL×6 | NO | valid | 1 | FAIL | 0 |
| 4998 | wholesale-200 | 200 | NASIYE | VARIANTS_SINGLE×7 | YES | valid | 2 | FAIL | 0 |
| 4999 | wholesale-500 | 500 | CHEQUE | VARIANTS_MULTI×8 | YES_ZERO | valid | 1 | FAIL | 0 |
| 5000 | wholesale-50 | 50 | NASIYE+CHEQUE | CATEGORY_SINGLE×0 | NO | valid | 2 | PASS | 1 |

## FAILهای منطقی (باگ واقعی)
- سناریو 4117 (retail-1 CHEQUE VARIANTS_MULTI): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 4333 (retail-1 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 4369 (retail-1 CHEQUE VARIANTS_MULTI): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 4405 (retail-1 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 4585 (retail-1 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 4657 (retail-1 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): هیچ‌کدام از اقلام این فاکتور با محدودیت این اعتبار (کالا/دسته‌بندی) نمی‌خواند، پس این اعتبار روی این فاکتور قابل استفاده نیست.
- سناریو 4702 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4705 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4706 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4707 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4709 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4710 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4711 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4714 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4716 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4717 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4718 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4719 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4720 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4723 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4724 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4725 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4726 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4727 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4728 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4732 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4733 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4734 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4735 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4737 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4738 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4741 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4742 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4744 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4745 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4746 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4747 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4751 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4752 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4753 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4754 (wholesale-50 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4755 (wholesale-200 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4756 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4759 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4760 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4761 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4762 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4763 (wholesale-50 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4765 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4768 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4769 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4770 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4772 (wholesale-50 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4773 (wholesale-200 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4774 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4777 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4779 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4780 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4781 (wholesale-50 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4782 (wholesale-200 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4783 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4786 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4787 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4788 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4789 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4790 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4791 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4795 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4796 (wholesale-50 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4797 (wholesale-200 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4798 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4800 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4801 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4804 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4805 (wholesale-50 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4807 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4808 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4809 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4810 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4814 (wholesale-50 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4815 (wholesale-200 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4816 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4817 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4818 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4819 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4822 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4823 (wholesale-50 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4824 (wholesale-200 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4825 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4826 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4828 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4831 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4832 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4833 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4835 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4836 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4837 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4840 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4842 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4843 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4844 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4845 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4846 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4849 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4850 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4851 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4852 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4853 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4854 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4858 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4859 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4860 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4861 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4863 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4864 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4867 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4868 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4870 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4871 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4872 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4873 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4877 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4878 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4879 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4880 (wholesale-50 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4881 (wholesale-200 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4882 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4885 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4886 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4887 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4888 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4889 (wholesale-50 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4891 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4894 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4895 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4896 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4898 (wholesale-50 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4899 (wholesale-200 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4900 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4903 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4905 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4906 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4907 (wholesale-50 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4908 (wholesale-200 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4909 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4912 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4913 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4914 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4915 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4916 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4917 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4921 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4922 (wholesale-50 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4923 (wholesale-200 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4924 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4926 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4927 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4930 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4931 (wholesale-50 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4933 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4934 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4935 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4936 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4940 (wholesale-50 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4941 (wholesale-200 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4942 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4943 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4944 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4945 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4948 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4949 (wholesale-50 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4950 (wholesale-200 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4951 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4952 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4954 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4957 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4958 (wholesale-50 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4959 (wholesale-200 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4961 (wholesale-50 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4962 (wholesale-200 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4963 (wholesale-500 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4966 (wholesale-500 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4968 (wholesale-200 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4969 (wholesale-500 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4970 (wholesale-50 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4971 (wholesale-200 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4972 (wholesale-500 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4975 (wholesale-500 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4976 (wholesale-50 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4977 (wholesale-200 NASIYE+CHEQUE+CASH VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4978 (wholesale-500 NASIYE+CHEQUE+CARD VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4979 (wholesale-50 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4980 (wholesale-200 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4984 (wholesale-500 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4985 (wholesale-50 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4986 (wholesale-200 NASIYE+CHEQUE CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4987 (wholesale-500 CASH+NASIYE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4989 (wholesale-200 CASH+CARD+NASIYE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4990 (wholesale-500 CASH+CARD+CHEQUE ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4993 (wholesale-500 NASIYE+CHEQUE+CASH+CARD CATEGORY_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4994 (wholesale-50 BARCODE MIXED_ALL+CAT): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4996 (wholesale-500 CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4997 (wholesale-50 CASH+CARD ALL): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4998 (wholesale-200 NASIYE VARIANTS_SINGLE): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.
- سناریو 4999 (wholesale-500 CHEQUE VARIANTS_MULTI): فاکتور عمده فقط یک بارکد اعتبار می‌پذیرد.

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
