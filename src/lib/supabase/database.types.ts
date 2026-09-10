/**
 * Database types matching supabase/migrations/*.sql.
 *
 * Hand-maintained. If you change the schema, regenerate with:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/supabase/database.types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type JobStatus = "queued" | "running" | "complete" | "failed" | "canceled";
export type JobStep =
  | "fetch_article"
  | "extract_content"
  | "crawl_dealership"
  | "analyze_links"
  | "analyze_qa_rules"
  | "verify_facts"
  | "apply_fixes"
  | "final_audit"
  | "save_report"
  | "complete";
export type IssueSeverity = "info" | "low" | "medium" | "high" | "critical";
export type FixMode = "none" | "safe" | "suggest";
export type RuleKind = "regex" | "ai" | "link" | "structural";
export type FactVerdict = "supported" | "contradicted" | "unverified";
export type FeedbackVerdict = "accept" | "reject" | "modify";

/** Keys whose column accepts NULL — those are optional on insert. */
type NullableKeys<T> = {
  [K in keyof T]-?: null extends T[K] ? K : never;
}[keyof T];

/**
 * Row → { Row, Insert, Update }.
 *
 * A column is optional on insert when the database can supply it: either it has
 * a default (listed in `Generated`) or it accepts NULL.
 */
type Table<Row, Generated extends keyof Row> = {
  Row: Row;
  Insert: Omit<Row, Generated | NullableKeys<Row>> &
    Partial<Pick<Row, (Generated | NullableKeys<Row>) & keyof Row>>;
  Update: Partial<Row>;
  Relationships: [];
};

export type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  created_at: string;
}

export type DealershipRow = {
  id: string;
  user_id: string;
  name: string;
  primary_domain: string;
  city: string | null;
  state: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type DealershipDomainRow = {
  id: string;
  dealership_id: string;
  domain: string;
  label: string | null;
  is_approved: boolean;
  max_pages: number;
  created_at: string;
}

export type QaRuleRow = {
  id: string;
  user_id: string | null;
  dealership_id: string | null;
  code: string;
  title: string;
  description: string;
  category: string;
  kind: RuleKind;
  severity: IssueSeverity;
  pattern: string | null;
  replacement: string | null;
  guidance: string | null;
  fix_mode: FixMode;
  is_active: boolean;
  is_builtin: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type AuditJobRow = {
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
  state: Json;
  options: Json;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ArticleRow = {
  id: string;
  job_id: string;
  kind: "original" | "revised";
  url: string | null;
  title: string | null;
  byline: string | null;
  html: string | null;
  markdown: string | null;
  text: string | null;
  word_count: number;
  meta: Json;
  created_at: string;
}

export type CrawledPageRow = {
  id: string;
  job_id: string;
  dealership_id: string | null;
  url: string;
  title: string | null;
  summary: string | null;
  text: string | null;
  status_code: number | null;
  render_mode: string;
  links: Json;
  fetched_at: string;
}

export type LinkCheckRow = {
  id: string;
  job_id: string;
  url: string;
  resolved_url: string | null;
  anchor_text: string | null;
  link_type: "internal" | "external";
  is_dealership: boolean;
  status_code: number | null;
  ok: boolean;
  redirected: boolean;
  error: string | null;
  checked_at: string;
}

export type FactCheckRow = {
  id: string;
  job_id: string;
  claim: string;
  verdict: FactVerdict;
  confidence: number;
  source_url: string | null;
  evidence: string | null;
  notes: string | null;
  created_at: string;
}

export type IssueRow = {
  id: string;
  job_id: string;
  rule_id: string | null;
  rule_code: string | null;
  category: string;
  severity: IssueSeverity;
  title: string;
  detail: string | null;
  evidence: string | null;
  suggestion: string | null;
  location: Json;
  auto_fixable: boolean;
  status: string;
  phase: "initial" | "final";
  created_at: string;
}

export type AutoFixRow = {
  id: string;
  job_id: string;
  issue_id: string | null;
  rule_code: string | null;
  kind: string;
  before_text: string;
  after_text: string;
  reason: string | null;
  applied: boolean;
  skipped_reason: string | null;
  created_at: string;
}

export type AuditResultRow = {
  id: string;
  job_id: string;
  score: number;
  final_score: number;
  summary: string | null;
  totals: Json;
  report: Json;
  created_at: string;
}

export type QaFeedbackRow = {
  id: string;
  user_id: string;
  issue_id: string | null;
  rule_id: string | null;
  job_id: string | null;
  verdict: FeedbackVerdict;
  note: string | null;
  created_at: string;
}

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, "created_at">;
      dealerships: Table<DealershipRow, "id" | "created_at" | "updated_at">;
      dealership_domains: Table<
        DealershipDomainRow,
        "id" | "created_at" | "is_approved" | "max_pages" | "label"
      >;
      qa_rules: Table<
        QaRuleRow,
        | "id" | "created_at" | "updated_at" | "category" | "kind" | "severity"
        | "fix_mode" | "is_active" | "is_builtin" | "sort_order"
      >;
      audit_jobs: Table<
        AuditJobRow,
        | "id" | "created_at" | "updated_at" | "status" | "step" | "progress"
        | "status_message" | "attempts" | "state" | "options" | "error"
        | "lease_expires_at" | "started_at" | "finished_at"
      >;
      articles: Table<ArticleRow, "id" | "created_at" | "word_count" | "meta">;
      crawled_pages: Table<CrawledPageRow, "id" | "fetched_at" | "render_mode" | "links">;
      link_checks: Table<
        LinkCheckRow,
        "id" | "checked_at" | "is_dealership" | "ok" | "redirected"
      >;
      fact_checks: Table<FactCheckRow, "id" | "created_at" | "verdict" | "confidence">;
      issues: Table<
        IssueRow,
        | "id" | "created_at" | "category" | "severity" | "location"
        | "auto_fixable" | "status" | "phase"
      >;
      auto_fixes: Table<AutoFixRow, "id" | "created_at" | "kind" | "applied">;
      audit_results: Table<
        AuditResultRow,
        "id" | "created_at" | "score" | "final_score" | "totals" | "report"
      >;
      qa_feedback: Table<QaFeedbackRow, "id" | "created_at">;
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: {
      job_status: JobStatus;
      job_step: JobStep;
      issue_severity: IssueSeverity;
      fix_mode: FixMode;
      rule_kind: RuleKind;
      fact_verdict: FactVerdict;
      feedback_verdict: FeedbackVerdict;
    };
    CompositeTypes: { [_ in never]: never };
  };
}
