# Claude Code-style Hooks Testing Container

Test the hooks system in an isolated Docker environment.

## Quick Start

```bash
cd test/hooks-docker

# Build and run
docker compose up -d --build

# Enter container
docker compose exec openclaw-hooks-test bash

# Inside container - run openclaw
pnpm openclaw agent --message "list files in /app"
```

## Test Scenarios

### 1. PreToolUse - Block Dangerous Commands

```bash
# This should be BLOCKED by block-rm.sh
pnpm openclaw agent --message "run rm -rf /tmp/test"

# This should SUCCEED
pnpm openclaw agent --message "run ls -la"
```

### 2. PostToolUse - Check Logging

```bash
# Run any tool
pnpm openclaw agent --message "what is 2+2"

# Check the log
cat /tmp/tool-log.txt
```

### 3. UserPromptSubmit - Message Validation

```bash
# This might be blocked (too short)
pnpm openclaw agent --message "hi"

# This should work
pnpm openclaw agent --message "Please list the files in the current directory"
```

## Editing Hooks

Hooks are mounted from `./hooks/`. Edit them locally and they update in the container immediately (no rebuild needed).

```bash
# Edit a hook
vim hooks/block-rm.sh

# Test immediately in container
docker compose exec openclaw-hooks-test pnpm openclaw agent --message "test"
```

## Viewing Logs

```bash
# Hook execution logs appear in container stderr
docker compose logs -f openclaw-hooks-test

# Tool execution log (from PostToolUse hook)
cat logs/tool-log.txt
```

## Cleanup

```bash
docker compose down -v
```

## Hook Protocol

| Exit Code | Meaning                                |
| --------- | -------------------------------------- |
| 0         | Allow - parse stdout JSON for response |
| 2         | Block - stderr contains reason         |
| Other     | Error - log and continue               |

### Input (stdin)

```json
{
  "session_id": "...",
  "tool_name": "Bash",
  "tool_input": { "command": "ls -la" },
  "cwd": "/app"
}
```

### Output (stdout for exit 0)

```json
{
  "decision": "allow",
  "updatedInput": { "command": "ls -la --color=never" }
}
```
