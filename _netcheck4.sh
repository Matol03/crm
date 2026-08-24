echo "--- WSL node fetch with ipv4first ---"
NODE_OPTIONS=--dns-result-order=ipv4first node -e 'fetch("https://graph.microsoft.com/").then(r=>console.log("ipv4first:",r.status)).catch(e=>console.log("FAIL:",(e.cause&&e.cause.code)||e.message))'
echo "--- container with ipv4first ---"
sudo docker run --rm -e NODE_OPTIONS=--dns-result-order=ipv4first lead-service:latest node -e 'fetch("https://graph.microsoft.com/").then(r=>console.log("container ipv4first:",r.status)).catch(e=>console.log("FAIL:",(e.cause&&e.cause.code)||e.message))'
