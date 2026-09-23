# The Cave Ledger — setup & handover

The shop system is a website (installable as an app) plus a Supabase database.

| Piece | Where it lives | What it holds |
|---|---|---|
| App (these files) | Netlify (free plan) | The screens. No data. |
| Database | Supabase (free plan) | Products, sales, stock, orders, expenses, sellers |

## One-time setup
1. **Supabase** → New project "the-cave" (region: Central EU / Frankfurt). Save the database password somewhere safe.
2. **SQL Editor** → run `supabase/schema.sql`, then `supabase/seed.sql` (your 244 products, 3 orders, first sale).
3. **Authentication → Sign In / Providers** → turn **off** "Allow new users to sign up".
4. **Authentication → Users → Add user → Create new user** (tick *Auto Confirm*): the owner's email + a strong password. Then in SQL Editor:
   ```sql
   insert into public.profiles(user_id, role, label)
   select id, 'admin', 'Otuck' from auth.users where email = 'OWNER-EMAIL'
   on conflict (user_id) do update set role = excluded.role, label = excluded.label;
   ```
5. **Edge Functions → Deploy a new function → Via editor**, name it `manage-staff`, paste `supabase/functions/manage-staff/index.ts`, deploy. This is what lets the Admin create seller logins from the Team tab.
6. **Project Settings → API** → copy the Project URL and the anon/publishable key into `config.js`.
7. **Netlify** → drag the `cave-app` folder (or the zip) onto app.netlify.com/drop. Rename the site (e.g. `thecave-ledger`).

## Every day
- **Admin** creates each seller's username + password in the **Team** tab (Add person).
- **Sellers** sign in with their own username and password, and tap **Sign out** at the end of their shift. Sellers are signed out automatically after 15 minutes without use (changeable in Team).
- **Owner:** signs in with the Admin email on any device, including the counter.
- **Install as an app:** Chrome/Edge → the install icon in the address bar (or ⋮ → Cast, save and share → Install page as app).

## Offline
Sales, voids, expenses, credit payments and deliveries recorded without internet are kept on that computer and upload by themselves when the connection returns (the badge at the top shows how many are waiting). Admin changes need internet. Don't clear the browser's site data on the counter while items are waiting.

## Adding people
Everything is done in the app's Team tab: add a Seller or another Admin, set a new password, or turn someone off. Signing in needs internet; once signed in, sales keep working offline.

## Updating the app
Replace files and redeploy on Netlify (Deploys → drag the folder). The database keeps all data.

## Backups
Supabase free plan: download a backup from Database → Backups, or export tables as CSV from the Table Editor. The app's Sales tab also exports CSV.
