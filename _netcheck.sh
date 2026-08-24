echo "--- container resolv.conf ---"
sudo docker run --rm lead-service:latest cat /etc/resolv.conf | grep -v '^#' | head -3
echo "--- DNS from container ---"
sudo docker run --rm lead-service:latest node -e 'require("dns").promises.lookup("graph.microsoft.com").then(r=>console.log("resolved:",r.address)).catch(e=>console.log("DNS FAIL:",e.code))'
echo "--- HTTPS from container ---"
sudo docker run --rm lead-service:latest node -e 'fetch("https://graph.microsoft.com/").then(r=>console.log("graph http:",r.status)).catch(e=>console.log("FETCH FAIL:",(e.cause&&e.cause.code)||e.message))'
echo "--- HTTPS from WSL host ---"
curl -s -o /dev/null -w "wsl->graph: %{http_code}\n" --max-time 10 https://graph.microsoft.com/ || echo "wsl curl failed"
