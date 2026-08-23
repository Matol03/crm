@echo off
REM Continuous lead-service poller (see README "Running permanently").
REM Launched by the "LeadService" scheduled task at logon; also runnable by hand.
REM All configuration comes from .env — no env overrides here, so what the task
REM runs is exactly what `npm run watch` runs.

cd /d "%~dp0.."

REM Timestamped log, kept alongside the database.
if not exist "logs" mkdir "logs"

echo [%date% %time%] starting lead-service watch >> "logs\service.log"
npx tsx scripts/poll-teams.ts --watch >> "logs\service.log" 2>&1
echo [%date% %time%] lead-service watch exited with code %ERRORLEVEL% >> "logs\service.log"
