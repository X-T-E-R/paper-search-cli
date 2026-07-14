import { z } from "zod";

export const ConfigScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export const ConfigArraySchema: z.ZodType<unknown[]> = z.lazy(() =>
  z.array(z.union([ConfigScalarSchema, ConfigArraySchema, ConfigRecordSchema])),
);
export const ConfigRecordSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.record(z.union([ConfigScalarSchema, ConfigArraySchema, ConfigRecordSchema])),
);

export const ProvidersConfigSchema = z.object({
  registryUrl: z.string().min(1),
  installDir: z.string().min(1),
  autoUpdate: z.boolean(),
  allowReleaseFallback: z.boolean(),
}).strict();

export const WorkspaceConfigSchema = z.object({
  root: z.string().min(1),
  defaultSink: z.enum(["workspace", "jsonl", "stdout"]),
  defaultCollection: z.string().min(1),
}).strict();

export const ServerConfigSchema = z.object({
  enabled: z.boolean(),
  transport: z.enum(["stdio", "http"]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
}).strict();

export const DefaultsConfigSchema = z.object({
  timeoutMs: z.number().int().min(100).max(300_000),
  maxResults: z.number().int().min(1).max(10_000),
}).strict();

export const OutputConfigSchema = z.object({
  format: z.enum(["table", "json"]),
  locale: z.string().min(1),
  prettyJson: z.boolean(),
}).strict();

export const SmokeConfigSchema = z.object({
  enabled: z.boolean(),
  envVar: z.string().min(1),
}).strict();

export const ConfigOriginSchema = z.object({
  kind: z.enum(["default", "user", "project", "explicit", "credentials", "env"]),
  source: z.string().min(1),
}).strict();

export const ConfigMetaSchema = z.object({
  cwd: z.string().min(1),
  userConfigPath: z.string().min(1),
  projectConfigPath: z.string().nullable(),
  explicitConfigPath: z.string().nullable(),
  loadedFiles: z.array(z.string()),
  appliedEnvOverrides: z.array(z.string()),
  origins: z.record(ConfigOriginSchema).optional(),
  warnings: z.array(z.string()).optional(),
}).strict();

export const ResolvedConfigSchema = z.object({
  providers: ProvidersConfigSchema,
  workspace: WorkspaceConfigSchema,
  server: ServerConfigSchema,
  defaults: DefaultsConfigSchema,
  output: OutputConfigSchema,
  smoke: SmokeConfigSchema,
  platform: z.record(ConfigRecordSchema),
  api: z.record(ConfigRecordSchema),
  meta: ConfigMetaSchema,
}).strict();

export const UserConfigSchema = z.object({
  providers: ProvidersConfigSchema.partial().optional(),
  workspace: WorkspaceConfigSchema.partial().optional(),
  server: ServerConfigSchema.partial().optional(),
  defaults: DefaultsConfigSchema.partial().optional(),
  output: OutputConfigSchema.partial().optional(),
  smoke: SmokeConfigSchema.partial().optional(),
  platform: z.record(ConfigRecordSchema).optional(),
  api: z.record(ConfigRecordSchema).optional(),
}).strict();

/** Strict on-disk v1 config shape. Missing schemaVersion is accepted only for legacy compatibility. */
export const UserConfigFileSchema = UserConfigSchema.extend({
  schemaVersion: z.literal(1).optional(),
}).strict();

export const CredentialsConfigFileSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.record(ConfigRecordSchema).optional(),
  api: z.record(ConfigRecordSchema).optional(),
}).strict();

export const SubscriptionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const SubscriptionRecordSchema = z.object({
  runtimeKind: z.enum(["search", "material"]),
  url: z.string().min(1),
  enabled: z.boolean(),
}).strict();
export const SubscriptionsConfigFileSchema = z.object({
  schemaVersion: z.literal(1),
  subscriptions: z.record(SubscriptionIdSchema, SubscriptionRecordSchema),
}).strict();

export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;
export type UserConfig = z.infer<typeof UserConfigSchema>;
export type CredentialsConfigFile = z.infer<typeof CredentialsConfigFileSchema>;
export type SubscriptionsConfigFile = z.infer<typeof SubscriptionsConfigFileSchema>;
