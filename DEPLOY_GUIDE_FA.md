# انتشار آنلاین World Dominion

این پروژه برای اجرا روی Render آماده شده است.

## کاری که باید انجام بدهی

1. محتویات این پوشه را در یک GitHub Repository قرار بده.
2. در Render یک Blueprint جدید بساز و همان Repository را انتخاب کن.
3. Render فایل `render.yaml` را می‌خواند و Web Service و PostgreSQL را ایجاد می‌کند.
4. روی Apply Blueprint بزن.
5. بعد از Deploy، آدرس `onrender.com` را باز کن.
6. برای تست، آخر آدرس `/health` را اضافه کن. اگر `{"ok":true,"service":"world-dominion"}` دیدی، سرور بالا است.

`DATABASE_URL` و `JWT_SECRET` داخل کد نوشته نشده‌اند؛ Render آن‌ها را از Blueprint تنظیم می‌کند.
