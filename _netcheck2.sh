echo "--- HTTPS with --network host ---"
sudo docker run --rm --network host lead-service:latest node -e 'fetch("https://graph.microsoft.com/").then(r=>console.log("graph http:",r.status)).catch(e=>console.log("FAIL:",(e.cause&&e.cause.code)||e.message))'
