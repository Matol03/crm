cd /mnt/c/Users/murat/workspace/lead-service
echo "--- image ENV ---"
sudo docker run --rm lead-service:latest sh -c 'echo NODE_OPTIONS=$NODE_OPTIONS'
echo "--- login.microsoftonline.com from container ---"
sudo docker run --rm lead-service:latest node -e 'fetch("https://login.microsoftonline.com/").then(r=>console.log("login:",r.status)).catch(e=>console.log("login FAIL:",(e.cause&&e.cause.code)||e.message))'
echo "--- graph from container ---"
sudo docker run --rm lead-service:latest node -e 'fetch("https://graph.microsoft.com/").then(r=>console.log("graph:",r.status)).catch(e=>console.log("graph FAIL:",(e.cause&&e.cause.code)||e.message))'
echo "--- with --env-file .env (does it clobber NODE_OPTIONS?) ---"
sudo docker run --rm --env-file .env lead-service:latest sh -c 'echo NODE_OPTIONS=$NODE_OPTIONS'
