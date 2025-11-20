# Railway Deployment Fix - Frontend

## Problem
Railway was auto-detecting Bun (because `bun.lockb` exists) and trying to run `bun install --frozen-lockfile`, but the lockfile was out of sync.

## Solution
I've created `nixpacks.toml` to force Railway to use **npm** instead of Bun.

## Railway Configuration

### Option 1: Use the nixpacks.toml file (Recommended)
The `nixpacks.toml` file I created will:
- Use Node.js 18 and npm
- Run `npm ci` (clean install from package-lock.json)
- Build with `npm run build`
- Start with `npm run preview`

### Option 2: Configure in Railway Dashboard
If you prefer to configure in the Railway UI:

1. Go to your Railway project → **Settings** → **Service**
2. Set **Build Command**: `npm ci && npm run build`
3. Set **Start Command**: `npm run preview`
4. Add environment variable:
   - `NIXPACKS_NO_MUSL=1` (if needed)

### Option 3: Remove Bun Lockfile (Alternative)
If you're not using Bun, you can delete `bun.lockb`:
```bash
cd frontend
rm bun.lockb
git add .
git commit -m "Remove bun.lockb, use npm only"
git push
```

## Environment Variables for Railway

Make sure to add these in Railway → **Variables**:

```
VITE_PROCTORING_API_URL=https://exameye-shield-backend.onrender.com
VITE_PROCTORING_WS_URL=wss://exameye-shield-backend.onrender.com
VITE_SUPABASE_PROJECT_ID=ukwnvvuqmiqrjlghgxnf
VITE_SUPABASE_PUBLISHABLE_KEY=your-key
VITE_SUPABASE_URL=https://ukwnvvuqmiqrjlghgxnf.supabase.co
```

## After Configuration

1. Commit and push the `nixpacks.toml` file
2. Railway will automatically redeploy
3. The build should now use npm instead of bun

## Verify Build

Check Railway build logs - you should see:
- `npm ci` instead of `bun install`
- Successful build completion
- No lockfile errors

