#!/usr/bin/env bash
# Deployed smoke test: stops the smoke target, waits for its monitor to go down with failing
# results from every probe region, restarts it, waits for recovery, and checks that trigger.dev
# ran `monitor.state-changed` exactly once per transition. Runs in CI with the smoke role; locally
# with credentials that can do the same, in the home region.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash would rewrite the /galena/... parameter names
stage=${GLN_STAGE:-dev}

param() { aws ssm get-parameter --name "/galena/$stage/$1" "${@:2}" --query Parameter.Value --output text; }
table=$(param telemetry-table)
bucket=$(param config-bucket)
target=$(param smoke-target-function)
url=$(param smoke-target-url)
regions=$(param probe-regions | tr ',' '\n' | sort | paste -sd, -)
key=$(param trigger-secret-key --with-decryption)
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$key"; fi

monitor=$(aws s3 cp "s3://$bucket/monitors.json" - |
  jq -r --arg url "$url" 'first(.monitors[] | select(.http.url == $url) | .id) // empty')
if [ -z "$monitor" ]; then
  echo "No enabled monitor checks $url. Add one in the dashboard (Internal only), then run this again."
  exit 1
fi

state() {
  aws dynamodb get-item --table-name "$table" --consistent-read \
    --key "{\"pk\":{\"S\":\"MON#$monitor\"},\"sk\":{\"S\":\"STATE\"}}" \
    --query 'Item.detection.M.[state.S, transitionSeq.N]' --output text
}
# wait_for <states as a regex> <minutes>: polls the evaluator's state item.
wait_for() {
  local deadline=$(($(date +%s) + $2 * 60)) now seq
  while :; do
    read -r now seq <<<"$(state)"
    if [[ $now =~ ^($1)$ ]]; then
      echo "$(date -u +%H:%M:%S) $now (transition $seq)"
      return
    fi
    if (($(date +%s) > deadline)); then
      echo "Still $now after $2 minutes, expected $1."
      if [ "$now" = flapping ]; then echo "Recent runs made it flap; it settles after 30 steady minutes."; fi
      return 1
    fi
    sleep 15
  done
}

echo "Monitor $monitor checks $url from $regions."
started=$(date +%s)
# A run that was cut short may have left the target stopped.
aws lambda delete-function-concurrency --function-name "$target"
wait_for "up|recovering" 10
read -r _ before <<<"$(state)"

stopped=$(date -u +%Y-%m-%dT%H:%M:00.000Z)
aws lambda put-function-concurrency --function-name "$target" --reserved-concurrent-executions 0
echo "Target stopped at $(date -u +%H:%M:%S)."
wait_for down 8

# Every probe region saw the outage, not just a quorum; the last one may land a minute later.
failing_regions() {
  aws dynamodb query --table-name "$table" \
    --key-condition-expression 'pk = :pk AND sk >= :from' \
    --expression-attribute-values "{\":pk\":{\"S\":\"MON#$monitor\"},\":from\":{\"S\":\"R#$stopped\"}}" \
    --query 'Items[?status.S==`down`].sk.S' --output text |
    tr '\t' '\n' | awk -F'#' 'NF == 3 { print $3 }' | sort -u | paste -sd, -
}
for attempt in 1 2 3 4 5 6 7 8 9; do
  failing=$(failing_regions)
  if [ "$failing" = "$regions" ]; then break; fi
  if [ "$attempt" = 9 ]; then
    echo "Failing results came from [$failing], expected every probe region [$regions]."
    aws lambda delete-function-concurrency --function-name "$target"
    exit 1
  fi
  sleep 15
done
echo "Every region reported the outage: $failing."

aws lambda delete-function-concurrency --function-name "$target"
echo "Target restarted at $(date -u +%H:%M:%S)."
wait_for "recovering|up" 8
read -r _ after <<<"$(state)"

# One monitor.state-changed run per transition. The evaluator may retry a trigger, so allow it a
# minute to land; idempotency keys must keep it to one run each.
api=https://api.trigger.dev
runs_since=$(((started - 120) * 1000))
for attempt in 1 2 3 4; do
  seqs=$(curl -fsS -H "Authorization: Bearer $key" \
    "$api/api/v1/runs?filter%5BtaskIdentifier%5D=monitor.state-changed&filter%5Btag%5D=monitor:$monitor&filter%5BcreatedAt%5D%5Bfrom%5D=$runs_since&page%5Bsize%5D=100" |
    jq -r '.data[].id' |
    while read -r run; do
      curl -fsS -H "Authorization: Bearer $key" "$api/api/v3/runs/$run" | jq -r '.payload.data.transitionSeq'
    done | sort -n)
  expected=$(seq $((before + 1)) "$after")
  actual=$(awk -v lo="$before" -v hi="$after" '$1 > lo && $1 <= hi' <<<"$seqs")
  if [ "$actual" = "$expected" ]; then break; fi
  if [ "$attempt" = 4 ]; then
    echo "Transitions $((before + 1))..$after should each have one run; got [$(paste -sd, - <<<"$actual")]."
    exit 1
  fi
  sleep 15
done
echo "Smoke test passed: $((after - before)) transitions, one monitor.state-changed run each."
