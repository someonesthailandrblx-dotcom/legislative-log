# Legislation.gov.th — National Assembly tracker

Static site (GitHub Pages) + Supabase. Same page as the old Google Apps Script app; `api.js` replaces `google.script.run`.

- `index.html` – the app · `api.js` – Supabase backend shim · `config.js` – public Supabase URL/anon key
- `supabase/002_parliament.sql` – tables, row-level security, login functions (`parl_*`)
- `supabase/003_delete_functions.sql` – optional; run by hand to enable "delete user"
- `tools/ExportForSupabase.gs` – one-time exporter for the old Google Sheet

Enable Pages: repo **Settings → Pages → Deploy from branch → main / root**.
Site: https://someonesthailandrblx-dotcom.github.io/legislative-log/

Security: accounts are checked in the database from a login token (passwords are hashed; roles are not trusted from the browser).
