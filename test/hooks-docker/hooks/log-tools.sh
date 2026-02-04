#!/bin/bash
# PostToolUse hook: Log all tool executions (fire-and-forget)

INPUT=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Extract tool name and truncate result
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
RESULT_PREVIEW=$(echo "$INPUT" | jq -r '.tool_result // "" | tostring | .[0:100]')

# Log to file
echo "[$TIMESTAMP] Tool: $TOOL | Result: $RESULT_PREVIEW..." >> /tmp/tool-log.txt

# Always succeed (fire-and-forget)
echo '{"logged":true}'
exit 0
