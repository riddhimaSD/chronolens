@echo off
cd /d "%~dp0"
echo Starting ChronoLens on http://localhost:8000 ...
start "" http://localhost:8000
python -m uvicorn backend.app:app --port 8000
