#!/bin/bash
# usage: run-regression.sh <repo-dir> <out-file> [parallelism]
REPO="$1"; OUT="$2"; P="${3:-3}"
REGRESSION_FAILURES=0
LOGDIR="${OUT%.txt}.logs"; rm -rf "$LOGDIR"; mkdir -p "$LOGDIR"
cd "$REPO" || exit 2
run_one() { f="$1"; logdir="$2"; name=$(echo "$f" | tr '/' '_'); if timeout 1200 node --import ./test/harness/register.mjs "$f" > "$logdir/$name.log" 2>&1; then echo "PASS $f"; else echo "FAIL $f (exit $?)"; fi; }
export -f run_one
suite() {
  local title="$1"; local glob="$2"; local tag="$3"
  echo "## $title"
  # فقط فایل‌های تست مستقل: ابزارهای _regen/_run-all می‌توانند دادهٔ مرجع را
  # بازنویسی کنند یا تست‌ها را دوباره اجرا کنند؛ *-fixture.mjs نیز تست مستقل
  # نیست. پوشه‌های support/helpers عمداً در glob سطح اول نمی‌آیند.
  find "${glob%/*.mjs}" -maxdepth 1 -type f -name '*.mjs' ! -name '_*' ! -name '*-fixture.mjs' -print0 \
    | xargs -0 -r -P "$P" -I{} bash -c 'run_one "$@"' _ {} "$LOGDIR" | sort -k2 > "$LOGDIR/$tag.txt"
  cat "$LOGDIR/$tag.txt"
  local T=$(wc -l < "$LOGDIR/$tag.txt"); local PS=$(grep -c '^PASS' "$LOGDIR/$tag.txt"); local F=$(grep -c '^FAIL' "$LOGDIR/$tag.txt")
  echo "TOTAL=$T PASS=$PS FAIL=$F"
  echo "FAILED: $(grep '^FAIL' "$LOGDIR/$tag.txt" | awk '{print $2}' | xargs -r -n1 basename | tr '\n' ' ')"
  REGRESSION_FAILURES=$((REGRESSION_FAILURES + F))
}
{
  date -u +"start %FT%TZ"
  # ---------------------------------------------------------------------------
  # 🔴 نشست ۱۸۵ — typecheck داخل *همین* لاگ اجرا می‌شود.
  #
  # تا امروز `npm run typecheck` جدا اجرا می‌شد و نتیجه‌اش هیچ‌جا در فایل
  # خروجی نمی‌نشست. بازبینی مستقل درست گرفت: لاگ تحویلی هیچ اثری از tsc
  # نداشت، پس ادعای «typecheck سبز است» از روی همان فایل **قابل راستی‌آزمایی
  # نبود**.
  #
  # حالا خروجی واقعی (یا دلیل اجرا نشدن) همیشه بالای همین فایل است.
  # ---------------------------------------------------------------------------
  echo "## typecheck"
  if [ -x ./node_modules/.bin/tsc ]; then
    if ./node_modules/.bin/tsc --noEmit -p tsconfig.json > "$LOGDIR/typecheck.txt" 2>&1; then
      echo "TYPECHECK_OK (0 error) · tsc $(./node_modules/.bin/tsc -v 2>/dev/null)"
    else
      echo "TYPECHECK_FAILED · $(grep -c 'error TS' "$LOGDIR/typecheck.txt") خطا"
      head -40 "$LOGDIR/typecheck.txt"
      REGRESSION_FAILURES=$((REGRESSION_FAILURES + 1))
    fi
  else
    echo "TYPECHECK_SKIPPED · ./node_modules/.bin/tsc پیدا نشد (npm install اجرا نشده است)"
    REGRESSION_FAILURES=$((REGRESSION_FAILURES + 1))
  fi
  echo "## guards"
  for guard in check-money-fields check-test-coverage; do
    if node "tools/$guard.mjs" > "$LOGDIR/$guard.txt" 2>&1; then
      tail -2 "$LOGDIR/$guard.txt"
    else
      tail -20 "$LOGDIR/$guard.txt"
      REGRESSION_FAILURES=$((REGRESSION_FAILURES + 1))
    fi
  done
  suite "tests/audit-fixes/*.mjs" "tests/audit-fixes/*.mjs" af
  # 🔴 نشست ۱۸۱ — این خط جا افتاده بود و ۸۴ تست هرگز اجرا نمی‌شدند.
  #
  # پیامدش این بود که گزارش‌های «رگرسیون کامل، بدون افت» چند نشست پشت سر هم
  # یک پوشه‌ی کامل را اصلاً نمی‌دیدند. در نشست ۱۸۱ همین باعث شد شکستن
  # `tests/audit/audit-a107-01-credit-batch-scope.mjs` (که از یک تغییر ناخواسته
  # در migration می‌آمد) بی‌صدا از رگرسیون رد شود و فقط در بازبینی بیرونی
  # پیدا شود.
  #
  # قاعده: هر پوشه‌ی تستی که در مخزن هست باید در همین اسکریپت اجرا شود.
  suite "tests/audit/*.mjs" "tests/audit/*.mjs" audit
  # 🔴 بازبینی گزارش مدیریت — ۲۱ تست `tests/management/` هرگز در این اسکریپت
  # اجرا نمی‌شدند (همان خطایی که نشست ۱۸۱ برای tests/audit گرفته بود؛ نگهبان
  # `check-test-coverage.mjs` هم خودِ همین پوشه را رد می‌زند).
  suite "tests/management/*.mjs" "tests/management/*.mjs" mgmt
  # ماژول پیامکی: منطق خالص + اجرای واقعی صف روی دیتابیس هارنس.
  suite "tests/sms/*.mjs" "tests/sms/*.mjs" sms
  suite "test/*.mjs" "test/*.mjs" legacy
  echo "## esbuild"
  if node tools/esbuild-check.mjs $(find src -name "*.ts" -o -name "*.tsx") > "$LOGDIR/esbuild-syntax.txt" 2>&1; then
    tail -1 "$LOGDIR/esbuild-syntax.txt"
  else
    tail -30 "$LOGDIR/esbuild-syntax.txt"
    REGRESSION_FAILURES=$((REGRESSION_FAILURES + 1))
  fi
  if node tools/esbuild-bundle-check.mjs > "$LOGDIR/esbuild-bundle.txt" 2>&1; then
    tail -4 "$LOGDIR/esbuild-bundle.txt"
  else
    tail -30 "$LOGDIR/esbuild-bundle.txt"
    REGRESSION_FAILURES=$((REGRESSION_FAILURES + 1))
  fi
  date -u +"end %FT%TZ"
  echo "DONE · failures=$REGRESSION_FAILURES"
} > "$OUT" 2>&1
# خروجیِ قرمز را با exit=0 پنهان نکنیم؛ خود فایل گزارش/لاگ‌ها همچنان می‌مانند.
test "$REGRESSION_FAILURES" -eq 0
