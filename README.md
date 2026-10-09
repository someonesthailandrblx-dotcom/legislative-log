# Bill Drafter (ร่างพระราชบัญญัติ)

A static website for drafting พระราชบัญญัติ from your Word template. It runs on GitHub Pages and stores each person's bills in Supabase.

## What is in this folder

| File | Purpose |
| --- | --- |
| `index.html` | The whole app (page, styles, scripts). |
| `config.js` | Supabase URL and public anon key. Safe to publish. |
| `supabase/001_bill_drafts.sql` | The `bill_drafts` table and its access rules. Already applied to your project. |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are. |

## Put it online (GitHub Pages)

1. Create a repository on GitHub, for example `bill-drafter`.
2. Upload everything in this folder to the repository root (keep `.nojekyll`).
3. In the repository, open Settings, then Pages. Under "Build and deployment" choose "Deploy from a branch", pick `main` and `/ (root)`, and save.
4. After a minute the site is at `https://<your-username>.github.io/bill-drafter/`.

## Let sign-up emails return to the site

In Supabase, open Authentication, then URL Configuration, and add your Pages address to "Redirect URLs". Without it, the confirmation link in the sign-up email goes to the project's Site URL instead.

## How it behaves

- Sign in with email and password. Each account sees only its own bills (row-level security on `bill_drafts`).
- Every change is saved about a second after you stop typing.
- If `config.js` is empty, or Supabase cannot be reached, bills are saved in that browser only.
- "Download Word" builds a `.docx` with the same page setup as your template: A4, margins 3 / 2 / 2 / 3 cm, Prompt 10.5 pt, Thai-distributed paragraphs, page number in the header. Install the Prompt font on the computer that opens the file, or Word substitutes another font.

## Things to know

- This Supabase project also holds the luggage-storage tables. The bill table is separate and has its own rules, but sign-ups and sign-in accounts are shared across the whole project.
- Supabase's leaked-password check is currently off for the project. Turn it on under Authentication, then Providers, then Email.
