import { z } from "zod";

export const EXTERNAL_SEARCH_PROTOCOL = "paper-search.external-search" as const;
export const EXTERNAL_SEARCH_VERSION = 1 as const;

export const ExternalSearchModeSchema = z.enum(["auto", "fast", "deep", "answer"]);
export const ExternalSearchIntentSchema = z.enum([
  "factual",
  "status",
  "comparison",
  "tutorial",
  "exploratory",
  "news",
  "resource",
]);
export const ExternalSearchFreshnessSchema = z.enum(["pd", "pw", "pm", "py"]);

const RequestBaseSchema = z.object({
  protocol: z.literal(EXTERNAL_SEARCH_PROTOCOL),
  version: z.literal(EXTERNAL_SEARCH_VERSION),
  requestId: z.string().min(1).max(256),
}).strict();

export const ExternalSearchProbeRequestSchema = RequestBaseSchema.extend({
  operation: z.literal("probe"),
}).strict();

export const ExternalSearchSearchRequestSchema = RequestBaseSchema.extend({
  operation: z.literal("search"),
  query: z.string().trim().min(1).max(32_768),
  mode: ExternalSearchModeSchema,
  intent: ExternalSearchIntentSchema.optional(),
  freshness: ExternalSearchFreshnessSchema.optional(),
  maxResults: z.number().int().min(1).max(10_000),
}).strict();

export const ExternalSearchRequestSchema = z.discriminatedUnion("operation", [
  ExternalSearchProbeRequestSchema,
  ExternalSearchSearchRequestSchema,
]);

const ToolIdentitySchema = z.object({
  name: z.string().trim().min(1).max(256),
  version: z.string().trim().min(1).max(256),
}).strict();

const ExternalErrorSchema = z.object({
  code: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(4_096),
  retryable: z.boolean(),
}).strict();

const ProbeDataSchema = z.object({
  tool: ToolIdentitySchema,
  protocolVersions: z.array(z.number().int().positive()).max(32),
  modes: z.array(ExternalSearchModeSchema.exclude(["auto"])).max(32),
  intents: z.array(ExternalSearchIntentSchema).max(32),
  freshness: z.array(ExternalSearchFreshnessSchema).max(32),
}).strict();

const SearchResultSchema = z.object({
  title: z.string().max(32_768),
  url: z.string().url().max(32_768),
  snippet: z.string().max(131_072).optional(),
  // Search providers commonly expose either a calendar date or a timestamp.
  // Preserve both ISO forms rather than rejecting an otherwise valid response.
  publishedAt: z.union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    z.string().datetime({ offset: true }),
  ]).optional(),
  score: z.number().finite().optional(),
  providers: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
}).strict();

const CitationSchema = z.object({
  url: z.string().url().max(32_768),
  title: z.string().max(32_768).optional(),
  providers: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
}).strict();

const ProviderAttemptSchema = z.object({
  provider: z.string().trim().min(1).max(256),
  status: z.enum(["succeeded", "empty", "failed", "timeout", "skipped"]),
  resultCount: z.number().int().min(0),
  durationMs: z.number().int().min(0).optional(),
  error: ExternalErrorSchema.optional(),
}).strict();

const ArtifactSchema = z.object({
  kind: z.string().trim().min(1).max(256),
  id: z.string().trim().min(1).max(4_096).optional(),
  uri: z.string().trim().min(1).max(32_768).optional(),
}).strict();

const SearchDataSchema = z.object({
  query: z.string().trim().min(1).max(32_768),
  answer: z.string().max(262_144).nullable().optional(),
  results: z.array(SearchResultSchema).max(10_000),
  citations: z.array(CitationSchema).max(20_000),
}).strict();

const SearchProvenanceSchema = z.object({
  tool: ToolIdentitySchema,
  providerAttempts: z.array(ProviderAttemptSchema).max(1_000),
  artifacts: z.array(ArtifactSchema).max(1_000),
  semanticVerification: z.literal(false),
}).strict();

const ResponseBaseSchema = z.object({
  protocol: z.literal(EXTERNAL_SEARCH_PROTOCOL),
  version: z.literal(EXTERNAL_SEARCH_VERSION),
  requestId: z.string().min(1).max(256),
  warnings: z.array(z.string().max(4_096)).max(1_000),
}).strict();

const ProbeSuccessSchema = ResponseBaseSchema.extend({
  operation: z.literal("probe"),
  ok: z.literal(true),
  status: z.literal("ready"),
  data: ProbeDataSchema,
}).strict();

const ProbeFailureSchema = ResponseBaseSchema.extend({
  operation: z.literal("probe"),
  ok: z.literal(false),
  status: z.literal("failed"),
  error: ExternalErrorSchema,
}).strict();

const SearchSuccessSchema = ResponseBaseSchema.extend({
  operation: z.literal("search"),
  ok: z.literal(true),
  status: z.enum(["succeeded", "partial"]),
  data: SearchDataSchema,
  provenance: SearchProvenanceSchema,
}).strict();

const SearchFailureSchema = ResponseBaseSchema.extend({
  operation: z.literal("search"),
  ok: z.literal(false),
  status: z.literal("failed"),
  error: ExternalErrorSchema,
  data: SearchDataSchema.optional(),
  provenance: SearchProvenanceSchema.optional(),
}).strict();

export const ExternalSearchResponseSchema = z.union([
  ProbeSuccessSchema,
  ProbeFailureSchema,
  SearchSuccessSchema,
  SearchFailureSchema,
]);

export type ExternalSearchMode = z.infer<typeof ExternalSearchModeSchema>;
export type ExternalSearchIntent = z.infer<typeof ExternalSearchIntentSchema>;
export type ExternalSearchFreshness = z.infer<typeof ExternalSearchFreshnessSchema>;
export type ExternalSearchRequest = z.infer<typeof ExternalSearchRequestSchema>;
export type ExternalSearchProbeRequest = z.infer<typeof ExternalSearchProbeRequestSchema>;
export type ExternalSearchSearchRequest = z.infer<typeof ExternalSearchSearchRequestSchema>;
export type ExternalSearchResponse = z.infer<typeof ExternalSearchResponseSchema>;
export type ExternalSearchProbeResponse = Extract<ExternalSearchResponse, { operation: "probe" }>;
export type ExternalSearchSearchResponse = Extract<ExternalSearchResponse, { operation: "search" }>;

export interface ExternalWebSearchRequest {
  query: string;
  mode?: ExternalSearchMode;
  intent?: ExternalSearchIntent;
  freshness?: ExternalSearchFreshness;
  maxResults?: number;
}
