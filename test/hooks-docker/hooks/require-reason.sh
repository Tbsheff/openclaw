#!/bin/bash
# UserPromptSubmit hook: Require messages to have substance
# Blocks empty or very short messages

INPUT=$(cat)

# Get the prompt content
PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // ""')
LENGTH=${#PROMPT}

if [ "$LENGTH" -lt 3 ]; then
  echo "Message too short - please provide more context" >&2
  exit 2
fi

# Allow with optional modification
echo '{"decision":"allow"}'
exit 0
