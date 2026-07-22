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

export const StorageConfigSchema = z.object({
  artifactRoot: z.string().min(1),
  extractionRoot: z.string().min(1),
  exportRoot: z.string().min(1),
}).strict();

export const MaterialConfigSchema = z.object({
  /**
   * `selected` creates or reuses a workspace item after bytes are committed.
   * `materialized` keeps the artifact standalone until an explicit selection.
   */
  downloadDisposition: z.enum(["selected", "materialized"]),
}).strict();

/** User-global authority for the optional visible-browser acquisition sidecar. */
export const InstitutionalProfileIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);

const InstitutionalAgentControlFieldsSchema = z.object({
  mode: z.enum(["ask", "allow", "off"]),
  allowedProfiles: z.array(InstitutionalProfileIdSchema).refine(
    (profiles) => new Set(profiles).size === profiles.length,
    { message: "institutional agent-control profile ids must be unique" },
  ),
}).strict();

export const InstitutionalAgentControlSchema = InstitutionalAgentControlFieldsSchema.superRefine((control, refinement) => {
  if (control.mode === "allow" && control.allowedProfiles.length === 0) {
    refinement.addIssue({ code: "custom", message: "institutional agent control allow mode requires an explicit profile allowlist" });
  }
});

export const InstitutionalConfigSchema = z.object({
  enabled: z.boolean(),
  pythonExecutable: z.string(),
  checkoutRoot: z.string(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  maxPdfBytes: z.number().int().min(1_024).max(1_073_741_824),
  agentControl: InstitutionalAgentControlSchema,
}).strict();

const UserInstitutionalConfigSchema = InstitutionalConfigSchema
  .omit({ agentControl: true })
  .partial()
  .extend({ agentControl: InstitutionalAgentControlFieldsSchema.partial().optional() })
  .strict();

export const RunsConfigSchema = z.object({
  root: z.string().min(1),
  maxAgeDays: z.union([z.literal(-1), z.number().int().min(1)]),
  recordByDefault: z.boolean(),
}).strict();

const ContextConfigFieldsSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  kind: z.enum(["global", "standalone", "paperflow"]),
}).strict();

export const ContextConfigSchema = ContextConfigFieldsSchema.superRefine((context, refinement) => {
  if ((context.kind === "global") !== (context.id === "global")) {
    refinement.addIssue({
      code: "custom",
      message: "the built-in global context must use id = global and project contexts must use another id",
    });
  }
});

export const ProjectContextConfigSchema = ContextConfigSchema.refine(
  (context) => context.kind !== "global",
  { message: "global is a built-in fallback context and cannot be declared in a config file" },
);

export const ZoteroConfigSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().url(),
  timeoutMs: z.number().int().min(100).max(300_000),
  unavailable: z.enum(["error", "warn"]),
  syncOnSelected: z.boolean(),
  collectionKeys: z.array(z.string().regex(/^[A-Za-z0-9]+$/u)),
  attachmentMode: z.enum(["none", "link", "import"]),
  markdownMode: z.enum(["none", "note", "link", "import"]),
}).strict();

export const ZoteroBindingConfigSchema = z.object({
  /** Inherit global selection-sync defaults, disable them, or bind this workspace explicitly. */
  mode: z.enum(["inherit", "off", "bound"]),
  collectionKeys: z.array(z.string().regex(/^[A-Za-z0-9]+$/u)).optional(),
  attachmentMode: z.enum(["none", "link", "import"]).optional(),
  markdownMode: z.enum(["none", "note", "link", "import"]).optional(),
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

export const SourceDomainSchema = z.enum([
  "biomedicine",
  "computer-science",
  "cryptography",
  "engineering",
  "life-sciences",
  "multidisciplinary",
  "patents",
]);

export const ContentKindSchema = z.enum([
  "book",
  "conference-paper",
  "journal-article",
  "patent",
  "preprint",
  "repository-record",
]);

export const AccessClassSchema = z.enum([
  "credentialed",
  "institutional",
  "public",
  "session-gated",
]);

export const ProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);

export const BUILT_IN_SEARCH_PRESET_NAMES = [
  "general",
  "computer-science",
  "biomedicine",
  "preprints",
  "repositories",
  "publishers",
  "patents",
] as const;

export const SearchDefinitionNameSchema = z.string().regex(
  /^[a-z][a-z0-9-]{0,62}$/,
  "definition name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
);

export const SearchSelectorNamespaceSchema = z.enum([
  "source",
  "tag",
  "type",
  "domain",
  "content",
  "access",
  "transport",
]);

const SearchSourceTypeSchema = z.enum(["academic", "patent"]);
const SearchTransportSchema = z.enum(["api", "html"]);

const SEARCH_SELECTOR_VALUE_SCHEMAS: Record<
  z.infer<typeof SearchSelectorNamespaceSchema>,
  z.ZodTypeAny
> = {
  source: ProviderIdSchema,
  tag: SearchDefinitionNameSchema,
  type: SearchSourceTypeSchema,
  domain: SourceDomainSchema,
  content: ContentKindSchema,
  access: AccessClassSchema,
  transport: SearchTransportSchema,
};

export const SearchSelectorSchema = z.string().superRefine((selector, context) => {
  const match = /^([^:]+):([^:]+)$/.exec(selector);
  if (!match) {
    context.addIssue({
      code: "custom",
      message: `selector must use exactly one namespace separator: ${selector}`,
    });
    return;
  }

  const namespace = SearchSelectorNamespaceSchema.safeParse(match[1]);
  if (!namespace.success) {
    context.addIssue({
      code: "custom",
      message: `unknown selector namespace: ${match[1]}`,
    });
    return;
  }

  if (!SEARCH_SELECTOR_VALUE_SCHEMAS[namespace.data].safeParse(match[2]).success) {
    context.addIssue({
      code: "custom",
      message: `invalid ${namespace.data} selector value: ${match[2]}`,
    });
  }
});

export const SearchClassificationConfigSchema = z.object({
  sources: z.array(ProviderIdSchema),
}).strict();

const SearchPresetFieldsSchema = z.object({
  extends: z.array(SearchDefinitionNameSchema),
  include: z.array(SearchSelectorSchema),
  exclude: z.array(SearchSelectorSchema),
}).strict();

export const SearchPresetConfigSchema = z.object({
  extends: z.array(SearchDefinitionNameSchema).default([]),
  include: z.array(SearchSelectorSchema).default([]),
  exclude: z.array(SearchSelectorSchema).default([]),
}).strict();

const BUILT_IN_SEARCH_PRESET_NAME_SET = new Set<string>(BUILT_IN_SEARCH_PRESET_NAMES);

function rejectReservedPresetNames(
  presets: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  for (const name of Object.keys(presets)) {
    if (BUILT_IN_SEARCH_PRESET_NAME_SET.has(name)) {
      context.addIssue({
        code: "custom",
        path: [name],
        message: `built-in search preset name is reserved: ${name}`,
      });
    }
  }
}

const SearchPresetDefinitionsSchema = z
  .record(SearchDefinitionNameSchema, SearchPresetConfigSchema)
  .superRefine(rejectReservedPresetNames);

const UserSearchPresetDefinitionsSchema = z
  .record(SearchDefinitionNameSchema, SearchPresetFieldsSchema.partial())
  .superRefine(rejectReservedPresetNames);

const SearchSelectionFieldsSchema = z.object({
  mode: z.enum(["defaults", "allowlist"]),
  includeIds: z.array(ProviderIdSchema),
  excludeIds: z.array(ProviderIdSchema),
  includeDomains: z.array(SourceDomainSchema),
  excludeDomains: z.array(SourceDomainSchema),
  includeContentKinds: z.array(ContentKindSchema),
  excludeContentKinds: z.array(ContentKindSchema),
  includeAccess: z.array(AccessClassSchema),
  excludeAccess: z.array(AccessClassSchema),
}).strict();

export const SearchSelectionConfigSchema = SearchSelectionFieldsSchema.superRefine((selection, context) => {
  const excluded = new Set(selection.excludeIds);
  for (const id of selection.includeIds) {
    if (excluded.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["includeIds"],
        message: `provider cannot be both included and excluded: ${id}`,
      });
    }
  }
});

export const AcademicSearchSortSchema = z.enum(["relevance", "date", "citations"]);
export const PatentSearchSortSchema = z.enum(["relevance", "date"]);

const SearchConfigFieldsSchema = z.object({
  selection: SearchSelectionConfigSchema,
  defaultAcademicPresets: z.array(SearchDefinitionNameSchema),
  defaultPatentPresets: z.array(SearchDefinitionNameSchema),
  defaultAcademicSort: AcademicSearchSortSchema,
  defaultPatentSort: PatentSearchSortSchema,
  classifications: z.record(SearchDefinitionNameSchema, SearchClassificationConfigSchema),
  presets: SearchPresetDefinitionsSchema,
}).strict();

function selectorTagName(selector: string): string | null {
  return selector.startsWith("tag:") ? selector.slice("tag:".length) : null;
}

export const SearchConfigSchema = SearchConfigFieldsSchema.superRefine((search, context) => {
  const knownPresets = new Set<string>([
    ...BUILT_IN_SEARCH_PRESET_NAMES,
    ...Object.keys(search.presets),
  ]);

  for (const [field, defaults] of [
    ["defaultAcademicPresets", search.defaultAcademicPresets],
    ["defaultPatentPresets", search.defaultPatentPresets],
  ] as const) {
    defaults.forEach((name, index) => {
      if (!knownPresets.has(name)) {
        context.addIssue({
          code: "custom",
          path: [field, index],
          message: `unknown search preset: ${name}`,
        });
      }
    });
  }

  const knownTags = new Set(Object.keys(search.classifications));
  for (const [name, preset] of Object.entries(search.presets)) {
    preset.extends.forEach((extended, index) => {
      if (!knownPresets.has(extended)) {
        context.addIssue({
          code: "custom",
          path: ["presets", name, "extends", index],
          message: `unknown search preset: ${extended}`,
        });
      }
    });
    for (const field of ["include", "exclude"] as const) {
      preset[field].forEach((selector, index) => {
        const tagName = selectorTagName(selector);
        if (tagName !== null && !knownTags.has(tagName)) {
          context.addIssue({
            code: "custom",
            path: ["presets", name, field, index],
            message: `unknown search tag: ${tagName}`,
          });
        }
      });
    }
  }

  const states = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (name: string): void => {
    if (BUILT_IN_SEARCH_PRESET_NAME_SET.has(name) || !search.presets[name]) return;
    const state = states.get(name);
    if (state === "visited") return;
    if (state === "visiting") {
      const cycleStart = stack.indexOf(name);
      const cycle = [...stack.slice(cycleStart), name];
      context.addIssue({
        code: "custom",
        path: ["presets", name, "extends"],
        message: `cyclic search preset inheritance: ${cycle.join(" -> ")}`,
      });
      return;
    }
    states.set(name, "visiting");
    stack.push(name);
    for (const extended of search.presets[name]!.extends) visit(extended);
    stack.pop();
    states.set(name, "visited");
  };
  for (const name of Object.keys(search.presets)) visit(name);
});

const UserSearchConfigSchema = z.object({
  selection: SearchSelectionFieldsSchema.partial().optional(),
  defaultAcademicPresets: z.array(SearchDefinitionNameSchema).optional(),
  defaultPatentPresets: z.array(SearchDefinitionNameSchema).optional(),
  defaultAcademicSort: AcademicSearchSortSchema.optional(),
  defaultPatentSort: PatentSearchSortSchema.optional(),
  classifications: z
    .record(SearchDefinitionNameSchema, SearchClassificationConfigSchema)
    .optional(),
  presets: UserSearchPresetDefinitionsSchema.optional(),
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
  context: ContextConfigSchema,
  providers: ProvidersConfigSchema,
  workspace: WorkspaceConfigSchema,
  storage: StorageConfigSchema,
  material: MaterialConfigSchema,
  institutional: InstitutionalConfigSchema,
  runs: RunsConfigSchema,
  zotero: ZoteroConfigSchema,
  zoteroBinding: ZoteroBindingConfigSchema,
  server: ServerConfigSchema,
  defaults: DefaultsConfigSchema,
  output: OutputConfigSchema,
  smoke: SmokeConfigSchema,
  search: SearchConfigSchema,
  platform: z.record(ConfigRecordSchema),
  api: z.record(ConfigRecordSchema),
  meta: ConfigMetaSchema,
}).strict();

export const UserConfigSchema = z.object({
  context: ProjectContextConfigSchema.optional(),
  providers: ProvidersConfigSchema.partial().optional(),
  workspace: WorkspaceConfigSchema.partial().optional(),
  storage: StorageConfigSchema.partial().optional(),
  material: MaterialConfigSchema.partial().optional(),
  institutional: UserInstitutionalConfigSchema.optional(),
  runs: RunsConfigSchema.partial().optional(),
  zotero: ZoteroConfigSchema.partial().optional(),
  zoteroBinding: ZoteroBindingConfigSchema.partial().optional(),
  server: ServerConfigSchema.partial().optional(),
  defaults: DefaultsConfigSchema.partial().optional(),
  output: OutputConfigSchema.partial().optional(),
  smoke: SmokeConfigSchema.partial().optional(),
  search: UserSearchConfigSchema.optional(),
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
export type SearchSelector = z.infer<typeof SearchSelectorSchema>;
export type SearchClassificationConfig = z.infer<typeof SearchClassificationConfigSchema>;
export type SearchPresetConfig = z.infer<typeof SearchPresetConfigSchema>;
export type AcademicSearchSort = z.infer<typeof AcademicSearchSortSchema>;
export type PatentSearchSort = z.infer<typeof PatentSearchSortSchema>;
export type CredentialsConfigFile = z.infer<typeof CredentialsConfigFileSchema>;
export type SubscriptionsConfigFile = z.infer<typeof SubscriptionsConfigFileSchema>;
