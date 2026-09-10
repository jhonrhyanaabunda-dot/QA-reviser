/** Anything that round-trips through a jsonb column. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JOB_STEPS = [
  "fetch_article",
  "extract_content",
  "crawl_dealership",
  "analyze_links",
  "analyze_qa_rules",
  "verify_facts",
  "apply_fixes",
  "final_audit",
  "save_report",
  "complete",
] as const;

export type JobStep = (typeof JOB_STEPS)[number];
export type JobStatus = "queued" | "running" | "complete" | "failed" | "canceled";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type FixMode = "none" | "safe" | "suggest";
export type RuleKind = "regex" | "ai" | "link" | "structural";
export type FactVerdict = "supported" | "contradicted" | "unverified";

/** User-facing label + progress for each step, per the product spec. */
export const STEP_META: Record<JobStep, { label: string; progress: number }> = {
  fetch_article: { label: "Checking article...", progress: 8 },
  extract_content: { label: "Checking article...", progress: 18 },
  crawl_dealership: { label: "Checking dealership pages...", progress: 32 },
  analyze_links: { label: "Checking links...", progress: 48 },
  analyze_qa_rules: { label: "Applying QA rules...", progress: 62 },
  verify_facts: { label: "Final verification...", progress: 74 },
  apply_fixes: { label: "Applying QA rules...", progress: 84 },
  final_audit: { label: "Final verification...", progress: 92 },
  save_report: { label: "Final verification...", progress: 97 },
  complete: { label: "Audit complete", progress: 100 },
};

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 1,
  low: 3,
  medium: 7,
  high: 14,
  critical: 25,
};

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export type QaRule = {
  id: string;
  user_id: string | null;
  dealership_id: string | null;
  code: string;
  title: string;
  description: string;
  category: string;
  kind: RuleKind;
  severity: Severity;
  pattern: string | null;
  replacement: string | null;
  guidance: string | null;
  fix_mode: FixMode;
  is_active: boolean;
  is_builtin: boolean;
  sort_order: number;
}

export type AuditJob = {
  id: string;
  user_id: string;
  dealership_id: string | null;
  source_url: string;
  status: JobStatus;
  step: JobStep;
  progress: number;
  status_message: string;
  error: string | null;
  attempts: number;
  lease_expires_at: string | null;
  state: JobState;
  options: JobOptions;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export type JobOptions = {
  /** Apply safe auto-fixes, or only report them. */
  applyFixes?: boolean;
  /** Hard ceiling on dealership pages crawled for this job. */
  maxCrawlPages?: number;
  /** Skip the fact-verification step (faster, cheaper). */
  skipFactCheck?: boolean;
}

/** Per-step scratch state. Persisted so a step can resume across invocations. */
export type JobState = {
  /** Dealership URLs still to crawl. */
  crawlQueue?: string[];
  /** Dealership URLs already crawled (dedupe). */
  crawlSeen?: string[];
  crawlCount?: number;
  /** Article links still to verify. */
  linkQueue?: LinkRef[];
  linkCount?: number;
  /** Non-fatal problems worth surfacing without failing the audit. */
  warnings?: string[];
  /** Claims queued for fact verification. */
  claims?: string[];
  /** Set when the article needed JS rendering. */
  renderMode?: "fetch" | "firecrawl";
}

export type LinkRef = {
  url: string;
  anchor: string;
}

export type ExtractedArticle = {
  url: string;
  title: string | null;
  byline: string | null;
  metaDescription: string | null;
  html: string;
  text: string;
  markdown: string;
  wordCount: number;
  headings: { level: number; text: string }[];
  images: { src: string; alt: string | null }[];
  links: LinkRef[];
  renderMode: "fetch" | "firecrawl";
}

export type DetectedIssue = {
  rule_id?: string | null;
  rule_code: string;
  category: string;
  severity: Severity;
  title: string;
  detail?: string | null;
  evidence?: string | null;
  suggestion?: string | null;
  location?: Record<string, JsonValue>;
  auto_fixable?: boolean;
}
