echo "--- graph.microsoft.com x4 from container (is it flaky?) ---"
for i in 1 2 3 4; do
  sudo docker run --rm lead-service:latest node -e 'fetch("https://graph.microsoft.com/").then(r=>console.log("  attempt: "+r.status)).catch(e=>console.log("  attempt: FAIL "+((e.cause&&e.cause.code)||e.message)))'
done
echo "--- same from WSL host via curl x2 ---"
for i in 1 2; do curl -s -o /dev/null -w "  curl: %{http_code}\n" --max-time 8 https://graph.microsoft.com/ || echo "  curl: fail"; done
