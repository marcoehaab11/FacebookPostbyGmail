# NUVEXA on Vercel

The local app and cloud app share the same review, image validation, Gmail parser, Facebook publisher, deletion, counts and Cairo scheduling. Cloud records use Turso/libSQL; images use **private** Vercel Blob. No production data lives in a Function's filesystem. Administrator login protects pages, API and images, with salted scrypt password hashes, signed HttpOnly cookies, CSRF, persistent session revocation and login rate limits.

## 1. Create the project and storage

Import `marcoehaab11/FacebookPostbyGmail` into Vercel. Use **Other**, no build command, and leave the output directory unset. Use Node 24. Create a Turso database, and obtain its database URL and auth token. In Vercel Storage create a Blob store with **Private** access and connect it to the Production environment. Keep Production storage separate from Preview deployments.

## 2. Bring the current credentials

On the original computer, `node scripts/prepare-vercel-env.js` generates `.env.vercel.local`. The file is ignored by Git and includes the configured administrator hash, session/cron secrets, the existing settings encryption key, and an encrypted copy of the current Google and Facebook settings. The configured password stays out of the repository.

Fill these values in that file:

- `APP_URL=https://your-project.vercel.app` (the final Production domain, no trailing slash).
- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` from Turso.
- `BLOB_READ_WRITE_TOKEN` from your **private** Blob store, for local migration. Connected Vercel deployments can also use their `BLOB_STORE_ID`/OIDC credentials.

In Vercel Project Settings → Environment Variables, import this file into **Production only**, then redeploy. Do not add `NEXT_PUBLIC_` or expose these settings in browser code. `INITIAL_SETTINGS_ENCRYPTED` initializes an empty database only; later edits are saved encrypted in Turso. Keep `SETTINGS_ENCRYPTION_KEY` unchanged, including when you redeploy.

## 3. Move existing posts and images

Cancel local schedules and finish/reconcile any active Facebook upload first. Then run:

```powershell
node --env-file=.env.vercel.local scripts/migrate-cloud.js
```

The script copies posts, deleted-post deduplication records, email history, events and private images. Re-running after an interrupted migration is safe. Local and cloud data become separate databases: stop local automatic synchronization and publishing before activating cloud cron. Existing schedules deliberately require review after migration to prevent both installations publishing the same post.

## 4. Google OAuth

In Google Auth Platform → Clients → NUVEXA Local, add this **Authorized redirect URI** alongside the existing local URI:

```text
https://your-project.vercel.app/auth/google/callback
```

Sign into the website, open Settings and reconnect Gmail if necessary. Existing Google refresh tokens can be transferred, but a token can still expire or be revoked; Testing-mode OAuth commonly needs reconnection. Facebook tokens likewise keep their existing lifetime and permissions. Cloud hosting does not renew either service's access automatically.

## 5. Native Facebook scheduling and unattended Gmail sync

New schedules upload unpublished photo media, create a Facebook feed post with `published=false`, `unpublished_content_type=SCHEDULED` and `scheduled_publish_time`, and verify the returned post ID and time. **Facebook publishes these schedules without Vercel cron or a running computer.** The app allows 11 minutes to 28 days ahead as a conservative window; Meta is the final authority on accepting a time. Cancel a schedule from the app or Meta Planner before editing it. Local-only delete is blocked while a Facebook schedule is active. Unknown create/cancel outcomes are held for manual reconciliation, never retried automatically.

For automatic Gmail intake and status updates, call `GET https://your-project.vercel.app/api/jobs/tick` **every minute** using `Authorization: Bearer <CRON_SECRET>`. The endpoint is protected independently of browser login and has persistent job/Gmail locks. It reads due Facebook post statuses (never reposting them), processes at most one legacy local schedule, then does a bounded Gmail sync. Partial email batches resume on later invocations without duplicating posts.

On Vercel **Pro**, add this entry to `vercel.json` and redeploy:

```json
"crons": [{"path":"/api/jobs/tick","schedule":"* * * * *"}]
```

Vercel sends the configured `CRON_SECRET` automatically. On Hobby, use an external scheduler that supports a one-minute interval and a secret Authorization header; Hobby's native cron only runs daily. Do not put the secret in a query parameter. No cron is included by default, so importing the repository on Hobby will not fail a per-minute-cron plan check.

Only legacy local schedules depend on the job and its five-minute delay window; they remain supported until manually transferred with the “Move schedule to Facebook” button. New native schedules are independent of this job. Facebook publication status in the local dashboard updates with the “Check Facebook” button or a later job invocation. A failed read does not recreate the post.

## 6. Phone and final checks

Open the Production HTTPS URL on your phone and sign in with the configured administrator account. Check Gmail sync, a post preview, scheduling/cancellation, logout, and an authorized Facebook publication. Browser uploads on Vercel are limited here to **3 MB per image**; keep a combined import request under Vercel's request-body limit (4.5 MB), or import images individually/use public image links. Server-side Gmail/direct-image downloads retain the original 8 MB validation limit.

Cloud deployment and real storage/cron verification require your Vercel/Turso account configuration; local tests use temporary databases and mocked image storage/Facebook responses and do not publish to Facebook.

References: [Vercel Express](https://vercel.com/kb/guide/ship-a-express-app-on-vercel), [Private Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk), [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [libSQL client](https://tursodatabase.github.io/libsql-client-ts/).

Native scheduling parameter reference: [Meta official SDK: Page feed](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py), [Meta official SDK: Post](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/post.py).
