# Frontend Docker Setup

This Dockerfile creates a production-ready container for the frontend application.

## Build Stages

1. **Builder Stage**: Uses Node.js 18 to install dependencies and build the Vite app
2. **Production Stage**: Uses nginx Alpine to serve the static files efficiently

## Building the Docker Image

### Basic Build
```bash
cd frontend
docker build -t exameye-frontend .
```

### Build with Tag
```bash
docker build -t exameye-frontend:latest .
```

## Running the Container

### Basic Run
```bash
docker run -p 3000:80 exameye-frontend
```

The app will be available at: `http://localhost:3000`

### Run with Custom Port
```bash
docker run -p 8080:80 exameye-frontend
```

### Run in Background (Detached)
```bash
docker run -d -p 3000:80 --name frontend exameye-frontend
```

## Environment Variables

If you need to pass environment variables at build time (for Vite):

```bash
docker build --build-arg VITE_PROCTORING_API_URL=https://exameye-shield-backend.onrender.com \
             --build-arg VITE_PROCTORING_WS_URL=wss://exameye-shield-backend.onrender.com \
             -t exameye-frontend .
```

**Note**: For runtime environment variables, you'll need to use a different approach (see below).

## Using with Docker Compose

Create a `docker-compose.yml`:

```yaml
version: '3.8'

services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "3000:80"
    environment:
      - VITE_PROCTORING_API_URL=https://exameye-shield-backend.onrender.com
      - VITE_PROCTORING_WS_URL=wss://exameye-shield-backend.onrender.com
    restart: unless-stopped
```

## Deployment Platforms

### Railway
- Railway will automatically detect and use the Dockerfile
- No additional configuration needed
- Make sure to set environment variables in Railway dashboard

### Render
- Select "Docker" as the environment
- Point to the Dockerfile location
- Set environment variables in Render dashboard

### Northflank
- Select "Dockerfile" build method
- Set environment variables in the service configuration

### Vercel
- Vercel doesn't use Dockerfiles for frontend deployments
- Use Vercel's native build system instead (recommended for frontend)

## Environment Variables at Build Time

The Dockerfile already supports build-time environment variables (required for Vite).

### Build with Environment Variables

```bash
docker build \
  --build-arg VITE_PROCTORING_API_URL=https://exameye-shield-backend.onrender.com \
  --build-arg VITE_PROCTORING_WS_URL=wss://exameye-shield-backend.onrender.com \
  --build-arg VITE_SUPABASE_URL=https://ukwnvvuqmiqrjlghgxnf.supabase.co \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=your-key \
  --build-arg VITE_SUPABASE_PROJECT_ID=ukwnvvuqmiqrjlghgxnf \
  -t exameye-frontend .
```

### Using a Build Script (Alternative)

Create a `build-docker.sh` script:
```bash
#!/bin/bash
docker build \
  --build-arg VITE_PROCTORING_API_URL=${VITE_PROCTORING_API_URL} \
  --build-arg VITE_PROCTORING_WS_URL=${VITE_PROCTORING_WS_URL} \
  --build-arg VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY} \
  --build-arg VITE_SUPABASE_PROJECT_ID=${VITE_SUPABASE_PROJECT_ID} \
  -t exameye-frontend .
```

Then source your `.env` file and run:
```bash
source .env
chmod +x build-docker.sh
./build-docker.sh
```

**Note**: Vite requires environment variables at **build time**, not runtime, because they're embedded into the JavaScript bundle during the build process.

## Troubleshooting

### Build Fails
- Make sure `package-lock.json` is up to date: `npm install`
- Check that all dependencies are listed in `package.json`

### App Shows Blank Page
- Check browser console for errors
- Verify environment variables are set correctly
- Ensure the build completed successfully

### Routing Issues (404 on refresh)
- The nginx config includes SPA routing support (`try_files`)
- If issues persist, check the nginx configuration

### Port Already in Use
- Change the host port: `docker run -p 8080:80 exameye-frontend`
- Or stop the existing container: `docker stop <container-id>`

## Image Size Optimization

The current setup uses:
- **Builder stage**: ~500MB (Node.js + dependencies)
- **Production stage**: ~25MB (nginx Alpine)
- **Final image**: ~25MB (only production stage is included)

This is already optimized using multi-stage builds!

