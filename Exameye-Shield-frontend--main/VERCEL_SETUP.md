# Connecting Frontend (Vercel) to Backend (Render)

Your backend is deployed at: **https://exameye-shield-backend.onrender.com**

## Step 1: Set Environment Variables in Vercel

1. Go to your Vercel project dashboard
2. Navigate to **Settings** → **Environment Variables**
3. Add the following variables:

### Required Environment Variables:

| Variable Name | Value | Environment |
|--------------|-------|-------------|
| `VITE_PROCTORING_API_URL` | `https://exameye-shield-backend.onrender.com` | Production, Preview, Development |
| `VITE_PROCTORING_WS_URL` | `wss://exameye-shield-backend.onrender.com` | Production, Preview, Development |
| `VITE_SUPABASE_PROJECT_ID` | `ukwnvvuqmiqrjlghgxnf` | Production, Preview, Development |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Your Supabase publishable key | Production, Preview, Development |
| `VITE_SUPABASE_URL` | `https://ukwnvvuqmiqrjlghgxnf.supabase.co` | Production, Preview, Development |

### Important Notes:

- **WebSocket URL**: Use `wss://` (secure WebSocket) for HTTPS backends, not `ws://`
- **Apply to all environments**: Make sure to select **Production**, **Preview**, and **Development** when adding each variable
- **Redeploy**: After adding variables, you need to **redeploy** your Vercel project for changes to take effect

## Step 2: Redeploy Your Frontend

1. In Vercel dashboard, go to **Deployments**
2. Click the **"..."** menu on your latest deployment
3. Select **"Redeploy"**
4. Or simply push a new commit to trigger automatic deployment

## Step 3: Verify Connection

After redeployment, test the connection:

1. Open your Vercel frontend URL
2. Open browser DevTools (F12) → Console tab
3. Try to register/login or start an exam
4. Look for console logs showing:
   - `🔌 WebSocket URL configured: wss://exameye-shield-backend.onrender.com`
   - `✅ Proctoring WebSocket connected successfully!`
   - API calls to `https://exameye-shield-backend.onrender.com/api/...`

## Step 4: Test Backend Health

Visit these URLs to verify your backend is working:

- **Health Check**: https://exameye-shield-backend.onrender.com/health
- **API Docs**: https://exameye-shield-backend.onrender.com/docs
- **Root**: https://exameye-shield-backend.onrender.com/

## Troubleshooting

### CORS Errors
- Your backend already has CORS configured to allow all origins (`allow_origins=["*"]`)
- If you see CORS errors, check that your backend is actually running on Render

### WebSocket Connection Failed
- Verify `VITE_PROCTORING_WS_URL` uses `wss://` (not `ws://`) for HTTPS
- Check browser console for WebSocket connection errors
- Ensure Render backend is running and not sleeping (free tier may sleep after inactivity)

### API Calls Failing
- Verify `VITE_PROCTORING_API_URL` is set correctly
- Check Network tab in DevTools to see actual API requests
- Ensure backend endpoints are accessible (test `/health` endpoint)

### Environment Variables Not Working
- Vite requires variables to start with `VITE_` prefix
- After adding variables, you **must redeploy** - variables are baked into the build
- Check Vercel build logs to verify variables are being used

## Backend Endpoints Used by Frontend

- `POST /api/environment-check` - Environment verification
- `POST /api/calibrate` - Head pose calibration
- `POST /api/process-frame` - Frame processing
- `POST /api/grade-exam` - Auto-grading
- `GET /api/violations` - Get violations
- `POST /api/violations` - Save violations
- `WS /api/ws/proctoring/{session_id}` - Real-time WebSocket monitoring

All endpoints should be prefixed with your backend URL: `https://exameye-shield-backend.onrender.com`

