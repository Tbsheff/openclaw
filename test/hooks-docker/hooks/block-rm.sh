#!/bin/bash
# PreToolUse hook: Block dangerous rm commands
# Exit 0 = allow, Exit 2 = block

INPUT=$(cat)

# Check for rm -rf or rm -r
if echo "$INPUT" | grep -qE '"command".*rm\s+(-rf|-r\s+-f|-fr)'; then
  echo "Blocked: rm -rf/rm -r is not allowed" >&2
  exit 2
fi

# Check for rm on root or home
if echo "$INPUT" | grep -qE '"command".*rm.*(/\s|~/)'; then
  echo "Blocked: rm on root or home directory" >&2
  exit 2
fi

# Allow
echo '{"decision":"allow"}'
exit 0
