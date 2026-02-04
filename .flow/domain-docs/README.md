# Domain Documents for RAG

This directory contains domain knowledge documents used by the Domain Expert Agent for validating epics against home health care requirements.

## Document Categories

Place documents in subdirectories by category:

```
domain-docs/
  hipaa/           # HIPAA compliance guides
  medicare/        # Medicare/Medicaid regulations
  workflow/        # Standard care delivery workflows
  terminology/     # Glossary and terminology guides
  safety/          # Patient safety protocols
```

## Supported Formats

- Markdown (`.md`) - preferred
- Plain text (`.txt`)

## Document Structure

For best RAG retrieval, structure documents with:

1. **Clear headings** - Use markdown headers for sections
2. **Concise paragraphs** - 2-5 sentences per paragraph works best
3. **Keywords** - Include relevant terms the agent will search for
4. **References** - Include regulation numbers (e.g., "42 CFR 484.60")

## Example Documents

### hipaa/minimum-necessary.md

```markdown
# HIPAA Minimum Necessary Standard

The minimum necessary standard requires covered entities to limit PHI access to the minimum necessary to accomplish the intended purpose.

## Key Requirements

- Identify roles that need PHI access
- Limit access based on job functions
- Implement role-based access controls
- Document access policies

Reference: 45 CFR 164.502(b)
```

### terminology/visit-types.md

```markdown
# Home Health Visit Types

## Skilled Nursing (SN)

Nursing care requiring licensed nurse (RN/LPN). Includes wound care, medication management, patient education.

## Home Health Aide (HHA)

Personal care assistance under nursing supervision. Includes bathing, dressing, light housekeeping.
```

## Enhancing RAG

The current implementation uses keyword-based retrieval. For production:

1. **Vector embeddings** - Use sentence-transformers or OpenAI embeddings
2. **Chunking** - Split documents into semantic chunks
3. **Reranking** - Use cross-encoder reranking for better relevance
4. **Metadata filtering** - Filter by category before semantic search

## Adding Documents

1. Add `.md` or `.txt` files to appropriate subdirectory
2. Agent will automatically discover on next run
3. Cache clears when agent restarts
