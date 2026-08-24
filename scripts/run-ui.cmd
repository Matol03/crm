@echo off
REM Operations console (read-only lead view + resend), served by the API server.
REM Launched by the "LeadServiceUI" scheduled task at logon.
REM Configuration comes from .env — same database the poller writes to.

cd /d "%~dp0.."

if not exist "logs" mkdir "logs"

echo [%date% %time%] starting lead-service UI >> "logs\ui.log"
npx tsx server/src/api/server.ts >> "logs\ui.log" 2>&1
echo [%date% %time%] lead-service UI exited with code %ERRORLEVEL% >> "logs\ui.log"
