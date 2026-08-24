cd /mnt/c/Users/murat/workspace/lead-service
sudo docker build -q -t lead-service:latest . >/dev/null 2>&1
echo "--- one-shot poll inside container (live Graph + live Bitrix) ---"
sudo docker run --rm --env-file .env -e DB_PATH=/app/data/prod.sqlite -v lead-data:/app/data lead-service:latest npx tsx scripts/poll-teams.ts 2>&1 | tail -12
