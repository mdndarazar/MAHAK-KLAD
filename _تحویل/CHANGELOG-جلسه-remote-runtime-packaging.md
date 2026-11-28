# بسته‌بندی runtime آزمایشی هاب

مالک افزایش محدود سقف تغییر `package.json` برای بسته‌بندی child و Node سازگار را تأیید کرد. فقط یک خط تنظیمات Windows افزوده شد؛ `package-lock.json` تغییر نکرد و dependency تازه‌ای نصب نشد. ابزار build در Windows، Node x64 همان محیط build را پس از بررسی `node:sqlite` به همراه LICENSE بسته‌بندی می‌کند؛ فایل‌ها در resources و خارج از asar قرار می‌گیرند. نصب‌کننده و runtime در Windows این تغییر هنوز اجرا نشدند.

گیت راه دور همچنان خاموش است. بسته‌بندی به معنی اتصال Electron، ایمنی کلید/restore یا آمادگی محصول نیست. نتیجه تست‌ها و خطاهای CI در `docs/REMOTE-TODO.md` ثبت شده‌اند.
