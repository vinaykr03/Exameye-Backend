# Backend Deployment Guide (Northflank)

## Prerequisites
- Backend repo contains `server.py`, `requirements.txt`, and supporting modules (models, services, etc.).
- Supabase credentials (or other DB/storage secrets) ready as environment variables.
- Git repository hosted on GitHub/GitLab/Bitbucket.

## Local Development
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Windows use: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn server:app --reload
```

## Deploying to Northflank
1. **Prepare Docker Build**
   - `backend/Dockerfile` installs requirements and runs `uvicorn server:app --host 0.0.0.0 --port 8080`.
   - Commit & push the backend repo (including the Dockerfile) to your git provider.

2. **Create Project and Service**
   - Log in to Northflank → *Create project* → add a *Service*.
   - Choose *Build from repository* and connect your git provider.
   - Select the backend repository and branch; Northflank will execute the Dockerfile.

3. **Configure Service**
   - Service type: *Web Service*.
   - Ports: expose `8080` (or the port you configure via `PORT` env var).
   - Resources: free plan gives 1 shared CPU & 512 MB RAM (upgrade later if ML models require more memory).
   - Environment variables: add `SUPABASE_URL`, `SUPABASE_KEY`, and other secrets in the Environment tab.

4. **Deploy & Test**
   - Trigger a build/deploy. Northflank builds the image, installs dependencies, and starts the container.
   - Verify via the HTTPS endpoint `https://<service>.<region>.northflank.app/health` or `/docs`.

5. **Frontend Integration**
   - In the Vercel frontend, set the API base URL to the Northflank endpoint (store in env vars).
   - Make sure FastAPI’s CORS configuration (`allow_origins`) includes your Vercel domain.

6. **Data & Storage**
   - Use Supabase Storage/S3 for persistent files; container filesystem resets on deploys.
   - Connect to Supabase/Postgres or Northflank managed DB add-ons for data persistence.

## Useful Commands
- `pytest` – run backend tests.
- `black . && isort . && flake8` – lint & format.
- `python download_model.py` – refresh YOLO weights before deploying if required.

