This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Microsoft OneDrive Backup and Exports

OneDrive is the signed-in user's personal backup and export destination. The app uploads project
data plus computer-accessible JPEG photos into that user's `PunchList/<project>/` folder and saves
PDF reports under the project's `exports` folder. Backup is one-way: it never pulls or merges over
an existing local project.

`Restore Backup` is a separate recovery action for a new device. It downloads only projects that
are missing on that device and never overwrites an existing local project. Shared-project teamwork,
members, area locks, Push Changes, and Pull Changes use Supabase instead of OneDrive.

For multi-user use on phones or desktops inside UAI, configure one Microsoft Entra app for the
UAI tenant, then set:

```
NEXT_PUBLIC_MS_CLIENT_ID=your_microsoft_app_client_id
NEXT_PUBLIC_MS_TENANT_ID=your_uai_tenant_id
NEXT_PUBLIC_MS_REDIRECT_URI=https://punchlist-pwa.vercel.app/
```

Notes:

- `NEXT_PUBLIC_MS_TENANT_ID` should be your UAI tenant ID when only UAI work accounts should sign
  in.
- The app registration should stay single-tenant and include every production and development
  redirect URI you plan to use.
- Users back up to their own OneDrive files. This is per-user storage, not a shared team drive or
  the source of truth for team collaboration.

After updating env vars, restart the dev server or redeploy.

## Production Release Notes

Use [`.env.example`](./.env.example) as the baseline for local and Vercel environment setup.

Required public env vars for production:

```bash
NEXT_PUBLIC_MS_CLIENT_ID=your_microsoft_app_client_id
NEXT_PUBLIC_MS_TENANT_ID=your_uai_tenant_id_or_organizations
NEXT_PUBLIC_MS_REDIRECT_URI=https://your-production-domain/
```

Default local baseline in [`.env.example`](./.env.example):

```bash
NEXT_PUBLIC_MS_CLIENT_ID=376ef496-5fa7-447d-9559-2e128a6b74a4
NEXT_PUBLIC_MS_TENANT_ID=organizations
NEXT_PUBLIC_MS_REDIRECT_URI=http://localhost:3000/
```

Vercel notes:

- Set the same `NEXT_PUBLIC_MS_*` variables in the Vercel project for Production and Preview as needed.
- The Microsoft Entra app registration must include each deployed redirect URI exactly, including trailing slash if used.
- This repository currently ships without an active service worker. Old PWA caches are cleaned up once on first load after deploy so stale offline assets do not persist across releases.

## Fonts

The app uses the browser's system font stack, so it does not fetch external fonts during build or
request a missing local font at runtime.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
