# Daily Checklist

A weekly checklist that runs in your browser. Each weekday has its own list, repeated every week. Tick a task and it fades out; tomorrow starts fresh.

## What's in this folder

| File | What it does |
|---|---|
| `index.html` | The page structure |
| `style.css` | The look — colours are at the top under `:root` |
| `app.js` | How it works |
| `config.js` | Your Supabase details for online saving |
| `supabase-setup.sql` | One-off database setup for Supabase |
| `fonts/`, `icon.png` | Font files and the tab icon |

---

## 1. Put it on GitHub Pages

1. Sign in at github.com and click **New repository**. Call it `checklist`, set it to **Public**, and tick **Add a README file**. Click **Create repository**.
2. In the repo, click **Add file → Upload files**. Drag in **everything inside this folder** (including the `fonts` folder), then click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment*, set **Source** to *Deploy from a branch*, **Branch** to `main`, folder `/ (root)`, and click **Save**.
4. After a minute, the page shows your link, something like `https://YOUR-USERNAME.github.io/checklist/`. Bookmark it on your computer and phone.

At this point it already works, but it only saves in each browser separately. Do step 2 so your phone and computer share the same lists.

## 2. Turn on online saving (Supabase, free)

1. Go to supabase.com, sign up, and click **New project**. Pick any name, set a database password (you won't need it again), choose the **London** region, and create it.
2. When it's ready, open **SQL Editor → New query**, paste in the whole of `supabase-setup.sql`, and click **Run**. It should say *Success*.
3. Go to **Authentication → URL Configuration** and set **Site URL** to your GitHub Pages link from step 1. This makes the confirmation email link back to your checklist.
4. Go to **Project Settings → API** (or **API Keys**) and copy:
   - the **Project URL**
   - the **publishable** key (older projects call it the **anon public** key)
5. Back on GitHub, open `config.js`, click the pencil icon to edit, paste both values between the quotes, and click **Commit changes**.
6. Open your checklist link, click **Create account**, confirm the email, then sign in. Do the same sign-in on your phone.

The publishable key is designed to be public, so it's fine in a public repo. Your lists are protected by your login. Never paste the **secret** / **service_role** key anywhere in this project.

## Changing things later

Edit any file on GitHub (pencil icon → Commit). The live page updates within a minute or so. If you don't see the change, refresh. On a phone you may need to close and reopen the tab.

Your tasks are stored in Supabase, not in the files, so editing the code never touches your lists.
