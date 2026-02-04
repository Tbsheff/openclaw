/**
 * Domain Expert Agent
 *
 * Home health care domain expert using RAG for domain knowledge.
 * Validates epics against domain requirements before architect review.
 *
 * Domain areas:
 * - HIPAA compliance (patient privacy)
 * - Medicare/Medicaid regulations
 * - Home health care workflows
 * - Caregiver/patient/agency terminology
 *
 * Listens for: review_requested (from PM)
 * Publishes: review_completed -> architect (approved) or pm (needs revision)
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { z } from "zod";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { getLLM, type AnthropicClient } from "../../llm/anthropic.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

// =============================================================================
// SCHEMAS
// =============================================================================

const DomainIssueSchema = z.object({
  category: z.enum(["hipaa", "medicare", "workflow", "terminology", "safety", "other"]),
  severity: z.enum(["critical", "major", "minor"]),
  description: z.string(),
  recommendation: z.string(),
  regulation_reference: z.string().optional(),
});

const DomainReviewSchema = z.object({
  compliant: z.boolean().describe("Whether the epic meets domain requirements"),
  confidence: z.number().min(0).max(1).describe("Confidence in the assessment (0-1)"),
  summary: z.string().describe("Brief summary of the domain review"),
  issues: z.array(DomainIssueSchema).describe("Domain issues found"),
  strengths: z.array(z.string()).describe("Domain aspects handled well"),
  recommendations: z.array(z.string()).describe("General recommendations for improvement"),
  terminology_corrections: z
    .array(
      z.object({
        incorrect: z.string(),
        correct: z.string(),
        context: z.string(),
      }),
    )
    .optional(),
});

type DomainReview = z.infer<typeof DomainReviewSchema>;
type DomainIssue = z.infer<typeof DomainIssueSchema>;

// =============================================================================
// RAG CONTEXT TYPES
// =============================================================================

interface DomainDocument {
  path: string;
  title: string;
  content: string;
  category: string;
}

interface RAGContext {
  documents: DomainDocument[];
  relevantSections: string[];
}

// =============================================================================
// DOMAIN EXPERT AGENT
// =============================================================================

export class DomainExpertAgent extends BaseAgent {
  private llm: AnthropicClient;
  private systemPrompt: string | null = null;
  private domainDocsCache: DomainDocument[] | null = null;

  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "domain-expert",
      instanceId,
    };
    super(config);
    this.llm = getLLM();
  }

  /**
   * Load the domain expert system prompt.
   */
  private async getSystemPrompt(): Promise<string> {
    if (this.systemPrompt) {
      return this.systemPrompt;
    }
    this.systemPrompt = await this.llm.loadSystemPrompt("domain-expert");
    return this.systemPrompt;
  }

  /**
   * Handle review_requested events from PM.
   */
  protected async onWorkAssigned(_message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[domain-expert] Reviewing: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[domain-expert] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Read epic spec if available
      const specContent = workItem.spec_path
        ? await this.readSpecFile(workItem.spec_path)
        : (workItem.description ?? workItem.title);

      // Perform domain compliance review
      const review = await this.reviewDomainCompliance(workItem, specContent);

      // Store domain feedback in work item metadata
      await this.storeDomainFeedback(workItem.id, review);

      if (review.compliant) {
        // Domain requirements met - forward to architect
        // Assign to target role before publishing so they can claim the work
        await this.assignToRole(workItem.id, "architect");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "architect",
          payload: {
            domain_validated: true,
            confidence: review.confidence,
            summary: review.summary,
            strengths: review.strengths,
          },
        });
        console.log(
          `[domain-expert] Approved: ${workItem.title} (confidence: ${review.confidence})`,
        );
      } else {
        // Domain issues found - send back to PM for revision
        const criticalIssues = review.issues.filter((i) => i.severity === "critical");
        const majorIssues = review.issues.filter((i) => i.severity === "major");

        await this.updateWorkStatus(
          workItem.id,
          "blocked",
          `Domain issues: ${criticalIssues.length} critical, ${majorIssues.length} major`,
        );

        // Assign to target role before publishing so they can claim the work
        await this.assignToRole(workItem.id, "pm");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "pm",
          payload: {
            domain_validated: false,
            confidence: review.confidence,
            summary: review.summary,
            issues: review.issues,
            recommendations: review.recommendations,
            terminology_corrections: review.terminology_corrections,
          },
        });
        console.log(
          `[domain-expert] Needs revision: ${workItem.title} (${review.issues.length} issues)`,
        );
      }
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  /**
   * Read epic spec file from repository.
   */
  private async readSpecFile(specPath: string): Promise<string> {
    const repoRoot = process.cwd();
    const fullPath = join(repoRoot, specPath);
    return readFile(fullPath, "utf-8");
  }

  /**
   * Perform domain compliance review using LLM with RAG context.
   */
  private async reviewDomainCompliance(
    workItem: WorkItem,
    specContent: string,
  ): Promise<DomainReview> {
    const systemPrompt = await this.getSystemPrompt();

    // Retrieve relevant domain documents via RAG
    const ragContext = await this.retrieveDomainContext(specContent);

    // Build context string from RAG results
    const contextSection = this.formatRAGContext(ragContext);

    // Build the user prompt with epic and domain context
    const userPrompt = `Review the following epic specification for home health care domain compliance.

## Epic: ${workItem.title}

${specContent}

---

## Relevant Domain Knowledge

${contextSection}

---

Please analyze this epic for:
1. HIPAA compliance (patient data handling, privacy requirements)
2. Medicare/Medicaid regulations compliance
3. Home health care workflow alignment
4. Correct use of industry terminology
5. Patient safety considerations

Provide your assessment using the domain_review tool.`;

    console.log(`[domain-expert] Calling LLM for domain review...`);

    try {
      const review = await this.llm.completeWithSchema({
        systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        schema: DomainReviewSchema,
        schemaName: "domain_review",
        schemaDescription: "Provide domain compliance review for home health care epic",
        maxTokens: 4096,
        temperature: 0.3, // Lower temperature for more consistent compliance review
      });

      console.log(
        `[domain-expert] Review complete: ${review.compliant ? "APPROVED" : "NEEDS_REVISION"}`,
      );
      return review;
    } catch (err) {
      console.error("[domain-expert] LLM review failed:", (err as Error).message);
      // Fallback to conservative review
      return this.generateFallbackReview(specContent);
    }
  }

  /**
   * Generate a conservative fallback review when LLM fails.
   */
  private generateFallbackReview(specContent: string): DomainReview {
    // Check for obvious red flags
    const issues: DomainIssue[] = [];

    // Check for sensitive data handling mentions
    const sensitiveTerms = ["patient data", "health record", "phi", "pii", "social security"];
    const mentionsSensitiveData = sensitiveTerms.some((term) =>
      specContent.toLowerCase().includes(term),
    );

    if (mentionsSensitiveData) {
      issues.push({
        category: "hipaa",
        severity: "major",
        description: "Epic mentions sensitive patient data - requires HIPAA compliance review",
        recommendation: "Ensure all patient data handling follows HIPAA guidelines",
      });
    }

    return {
      compliant: issues.filter((i) => i.severity === "critical").length === 0,
      confidence: 0.5,
      summary: "Fallback review - manual verification recommended",
      issues,
      strengths: [],
      recommendations: [
        "Manual domain expert review recommended",
        "Verify HIPAA compliance requirements",
        "Confirm Medicare/Medicaid alignment",
      ],
    };
  }

  /**
   * Retrieve relevant domain documents using RAG.
   * Placeholder: searches .flow/domain-docs/ for relevant content.
   */
  private async retrieveDomainContext(specContent: string): Promise<RAGContext> {
    const domainDocs = await this.loadDomainDocuments();

    if (domainDocs.length === 0) {
      return {
        documents: [],
        relevantSections: ["No domain documents found. Using built-in domain knowledge."],
      };
    }

    // Simple keyword-based relevance scoring (placeholder for vector search)
    const keywords = this.extractKeywords(specContent);
    const relevantDocs = this.scoreDomainDocuments(domainDocs, keywords);

    // Extract most relevant sections
    const relevantSections = relevantDocs
      .slice(0, 3)
      .flatMap((doc) => this.extractRelevantSections(doc, keywords));

    return {
      documents: relevantDocs.slice(0, 5),
      relevantSections,
    };
  }

  /**
   * Load domain documents from .flow/domain-docs/ directory.
   */
  private async loadDomainDocuments(): Promise<DomainDocument[]> {
    if (this.domainDocsCache) {
      return this.domainDocsCache;
    }

    const repoRoot = process.cwd();
    const domainDocsDir = join(repoRoot, ".flow", "domain-docs");

    try {
      const files = await readdir(domainDocsDir, { recursive: true });
      const documents: DomainDocument[] = [];

      for (const file of files) {
        const ext = extname(String(file));
        if (ext !== ".md" && ext !== ".txt") {
          continue;
        }

        const filePath = join(domainDocsDir, String(file));
        try {
          const content = await readFile(filePath, "utf-8");
          const category = this.inferCategory(String(file), content);

          documents.push({
            path: filePath,
            title: this.extractTitle(String(file), content),
            content,
            category,
          });
        } catch {
          // Skip files that can't be read
        }
      }

      this.domainDocsCache = documents;
      return documents;
    } catch {
      // Directory doesn't exist - return empty
      this.domainDocsCache = [];
      return [];
    }
  }

  /**
   * Infer document category from filename or content.
   */
  private inferCategory(filename: string, content: string): string {
    const lower = (filename + content).toLowerCase();

    if (lower.includes("hipaa") || lower.includes("privacy")) {
      return "hipaa";
    }
    if (lower.includes("medicare") || lower.includes("medicaid")) {
      return "medicare";
    }
    if (lower.includes("workflow") || lower.includes("process")) {
      return "workflow";
    }
    if (lower.includes("glossary") || lower.includes("terminology")) {
      return "terminology";
    }
    if (lower.includes("safety")) {
      return "safety";
    }
    return "general";
  }

  /**
   * Extract title from filename or content.
   */
  private extractTitle(filename: string, content: string): string {
    // Try to find markdown title
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      return titleMatch[1];
    }

    // Use filename without extension
    return filename.replace(/\.(md|txt)$/, "").replace(/[-_]/g, " ");
  }

  /**
   * Extract keywords from content for relevance matching.
   */
  private extractKeywords(content: string): string[] {
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "shall",
      "to",
      "of",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "as",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "under",
      "again",
      "further",
      "then",
      "once",
      "and",
      "but",
      "or",
      "nor",
      "so",
      "yet",
      "both",
      "either",
      "neither",
      "not",
      "only",
      "same",
      "than",
      "too",
      "very",
      "can",
      "just",
      "now",
      "also",
      "that",
      "this",
      "these",
      "those",
      "such",
      "what",
      "which",
      "who",
      "whom",
      "whose",
      "when",
      "where",
    ]);

    return content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stopWords.has(word))
      .slice(0, 50);
  }

  /**
   * Score documents by keyword relevance.
   */
  private scoreDomainDocuments(docs: DomainDocument[], keywords: string[]): DomainDocument[] {
    const scored = docs.map((doc) => {
      const contentLower = doc.content.toLowerCase();
      let score = 0;

      for (const keyword of keywords) {
        if (contentLower.includes(keyword)) {
          score += 1;
        }
      }

      // Boost category matches
      if (keywords.some((k) => doc.category.includes(k))) {
        score += 5;
      }

      return { doc, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .toSorted((a, b) => b.score - a.score)
      .map((s) => s.doc);
  }

  /**
   * Extract relevant sections from a document based on keywords.
   */
  private extractRelevantSections(doc: DomainDocument, keywords: string[]): string[] {
    const paragraphs = doc.content.split(/\n\n+/);
    const relevant: string[] = [];

    for (const para of paragraphs) {
      const lower = para.toLowerCase();
      const matches = keywords.filter((k) => lower.includes(k)).length;

      if (matches >= 2 && para.length > 50 && para.length < 2000) {
        relevant.push(`[${doc.title}]: ${para.trim()}`);
      }
    }

    return relevant.slice(0, 3);
  }

  /**
   * Format RAG context for inclusion in prompt.
   */
  private formatRAGContext(context: RAGContext): string {
    if (context.relevantSections.length === 0) {
      return "Using built-in domain knowledge for home health care, HIPAA, and Medicare/Medicaid compliance.";
    }

    const sections = context.relevantSections.join("\n\n");
    return `The following domain knowledge is relevant to this review:\n\n${sections}`;
  }

  /**
   * Store domain feedback in work item metadata.
   */
  private async storeDomainFeedback(workItemId: string, review: DomainReview): Promise<void> {
    const feedback = {
      reviewed_at: new Date().toISOString(),
      compliant: review.compliant,
      confidence: review.confidence,
      summary: review.summary,
      issue_count: review.issues.length,
      critical_issues: review.issues.filter((i) => i.severity === "critical").length,
      categories: Array.from(new Set(review.issues.map((i) => i.category))),
    };

    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE work_items
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({ domain_review: feedback }), workItemId],
      );
    });
  }
}
