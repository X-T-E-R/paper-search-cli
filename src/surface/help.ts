import type { ResolvedConfig } from "../config/schema.js";
import type { ProviderHelpExample, ProviderUsageHelp, SourceType } from "../providers/sdk/types.js";
import { listInstalledProviders, type InstalledProviderSummary } from "../providers/registry/sync.js";
import { createPlatformStatusSnapshot } from "./status.js";
import { CLI_ONLY_COMMANDS, CLI_TOOL_MAPPINGS, getTools } from "./tools.js";
import { inspectExternalSearchStatic } from "../external-search/config.js";

type HelpLocale = "zh" | "en";

export interface HelpOptions {
  topic?: string;
  tool?: string;
  provider?: string;
  locale?: string;
}

interface ProviderHelpEntry {
  id: string;
  name: string;
  sourceType: SourceType;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  summary: string;
  notes: string[];
  examples: ProviderHelpExample[];
}

function resolveLocale(locale?: string): HelpLocale {
  return locale === "en" ? "en" : "zh";
}

function pickLocalizedText(
  locale: HelpLocale,
  values: { zh?: string; en?: string; fallback?: string },
): string {
  if (locale === "zh") {
    return values.zh || values.en || values.fallback || "";
  }
  return values.en || values.zh || values.fallback || "";
}

function pickLocalizedList(
  locale: HelpLocale,
  values: { zh?: string[]; en?: string[]; fallback?: string[] },
): string[] {
  return (
    (locale === "zh" ? values.zh || values.en : values.en || values.zh) ||
    values.fallback ||
    []
  );
}

function buildGenericProviderHelp(
  locale: HelpLocale,
  providerId: string,
  sourceType: SourceType,
): ProviderUsageHelp {
  if (sourceType === "academic") {
    return {
      summaryZh: "使用 academic_search 检索论文或学术条目，再按需用 resource_add 写入本地 workspace sink。",
      summary:
        "Use academic_search for papers and scholarly records, then write selected results into the local workspace sink with resource_add.",
      notesZh: [
        "初次检索先把 maxResults 控制小一点，确认 provider 输出格式后再扩量。",
        "provider-specific extra 参数通过 --extra / extra 传入。",
      ],
      notes: [
        "Keep the first pass small with maxResults, then widen after confirming the provider response shape.",
        "Pass provider-specific options through --extra / extra.",
      ],
      examples: [
        {
          titleZh: "基础论文检索",
          title: "Basic academic search",
          tool: "academic_search",
          arguments: {
            query: "retrieval augmented generation",
            platform: providerId,
            maxResults: 5,
          },
        },
      ],
    };
  }

  if (sourceType === "patent") {
    return {
      summaryZh:
        "使用 patent_search 检索专利，再按需用 patent_detail 拉取法律状态、权利要求、说明书、PDF 或图片链接，最后用 resource_add 写入本地 workspace sink。",
      summary:
        "Use patent_search for patent discovery, then patent_detail for legal status, claims, description, PDF, or image links before storing the result with resource_add.",
      notesZh: [
        "专利详情默认是 read-only；需要保存时，把 detail payload 交给后续 resource_add。",
        "如果 provider 需要登录态，优先在 TOML 的 platform.<id> 段配置凭据。",
      ],
      notes: [
        "Patent detail is read-only by default; hand the detail payload to a later resource_add step when you decide to store it.",
        "When the provider needs a login session, configure credentials in the TOML platform.<id> section first.",
      ],
      examples: [
        {
          titleZh: "专利检索",
          title: "Patent search",
          tool: "patent_search",
          arguments: {
            platform: providerId,
            query: "solid state battery",
            maxResults: 5,
          },
        },
        {
          titleZh: "专利详情",
          title: "Patent detail",
          tool: "patent_detail",
          arguments: {
            platform: providerId,
            sourceId: "example-source-id",
            include: ["legalStatus", "claims"],
          },
        },
      ],
    };
  }

  return {
    summaryZh: "该 provider 已安装，但对应 source type 的 CLI 工作流尚未完整开放。",
    summary:
      "This provider is installed, but the matching source-type workflow is not fully exposed in the CLI yet.",
  };
}

function toProviderHelpEntry(
  locale: HelpLocale,
  provider: InstalledProviderSummary,
  availability: {
    enabled: boolean;
    configured: boolean;
    available: boolean;
  },
): ProviderHelpEntry {
  const manifest = provider.manifest!;
  const manifestHelp =
    manifest.help ?? buildGenericProviderHelp(locale, manifest.id, manifest.sourceType);
  return {
    id: manifest.id,
    name: manifest.name,
    sourceType: manifest.sourceType,
    enabled: availability.enabled,
    configured: availability.configured,
    available: availability.available,
    summary: pickLocalizedText(locale, {
      zh: manifestHelp.summaryZh,
      en: manifestHelp.summary,
      fallback: manifest.description || manifest.name,
    }),
    notes: pickLocalizedList(locale, {
      zh: manifestHelp.notesZh,
      en: manifestHelp.notes,
    }),
    examples: manifestHelp.examples ?? [],
  };
}

function buildQuickstart(config: ResolvedConfig, locale: HelpLocale): string[] {
  const configHint =
    config.meta.loadedFiles.length > 0
      ? config.meta.loadedFiles[config.meta.loadedFiles.length - 1]
      : "paper-search.toml";
  return locale === "zh"
    ? [
        `先跑 paper-search status --json，确认安装、配置层和 workspace root（当前显式配置参考：${configHint}）。`,
        "再跑 paper-search tools --json，看当前 canonical tool 与 CLI alias 映射。",
        "做论文检索时先用 academic，再对选中的结果用 resource-add。",
        "普通检索默认不记历史；需要可重放记录时用 run academic_search，引用雪球用 citation plan/run/resume。",
        "评估只读取校验和绑定的观察快照；先用 assess plan 查看证据、冲突和策略轨迹，再决定是否持久化。",
        "需要带走本地 workspace 结果时，用 workspace-export 输出 JSON、JSONL、CSV 或 BibTeX；--store 写入配置的 export root。",
        "网页检索仅在用户级 external-search.toml 启用后使用 web。",
        "已知 DOI / URL 先走 lookup，不要直接手填 metadata。",
      ]
    : [
        `Start with paper-search status --json to confirm install/config layers and workspace root (current config hint: ${configHint}).`,
        "Then run paper-search tools --json to inspect the canonical tools and CLI aliases.",
        "Use academic first for paper search, then resource-add for selected results.",
        "Ordinary search is ephemeral; use run academic_search for a durable record and citation plan/run/resume for snowballing.",
        "Assessment reads checksum-bound observation snapshots; inspect assess plan before persisting a run.",
        "For patents, use patent first, then patent-detail, then resource-add.",
        "Use workspace-export for portable JSON, JSONL, CSV, or BibTeX; --store writes below the configured export root.",
        "Use web only after enabling the user-level external-search.toml integration.",
        "Use lookup for known DOI/URL records instead of hand-authoring metadata.",
      ];
}

export async function createHelpSnapshot(
  config: ResolvedConfig,
  options: HelpOptions = {},
): Promise<{
  locale: HelpLocale;
  surface: "capability-first";
  quickstart: string[];
  tools: ReturnType<typeof getTools>;
  cliMappings: typeof CLI_TOOL_MAPPINGS;
  cliOnlyCommands: typeof CLI_ONLY_COMMANDS;
  providers: ProviderHelpEntry[];
  notes: string[];
}> {
  const locale = resolveLocale(options.locale);
  const installed = await listInstalledProviders(config.providers.installDir);
  const externalSearch = await inspectExternalSearchStatic();
  const toolSchemas = getTools(installed, { externalSearchAvailable: externalSearch.state === "configured" });
  const platformStatus = await createPlatformStatusSnapshot(config);
  const statusMap = new Map(
    [...platformStatus.academic, ...platformStatus.patent, ...platformStatus.web].map((entry) => [
      entry.id,
      entry,
    ]),
  );

  const providerEntries = installed
    .filter((entry) => entry.valid && entry.manifest)
    .map((entry) =>
      toProviderHelpEntry(locale, entry, {
        enabled: statusMap.get(entry.id)?.enabled ?? true,
        configured: statusMap.get(entry.id)?.configured ?? true,
        available: statusMap.get(entry.id)?.available ?? entry.valid,
      }),
    )
    .sort((left, right) =>
      left.sourceType === right.sourceType
        ? left.id.localeCompare(right.id)
        : left.sourceType.localeCompare(right.sourceType),
    );

  const topic = options.topic?.trim();
  const toolFilter = options.tool?.trim();
  const providerFilter = options.provider?.trim();

  const filteredTools = toolFilter
    ? toolSchemas.filter((tool) => tool.name === toolFilter)
    : topic === "patents"
      ? toolSchemas.filter((tool) => tool.name === "patent_search" || tool.name === "patent_detail")
    : topic === "lookup"
      ? toolSchemas.filter((tool) => tool.name === "resource_lookup")
    : topic === "web"
      ? toolSchemas.filter((tool) => tool.name === "web_search")
    : topic === "citations"
      ? toolSchemas.filter((tool) => tool.name === "citation_expand" || tool.name === "citation_run_status")
    : topic === "assessment"
      ? toolSchemas.filter((tool) => tool.name.startsWith("assessment_"))
    : topic === "runs"
      ? toolSchemas.filter((tool) => tool.name === "research_run" || tool.name.startsWith("run_"))
    : topic === "workspace"
        ? toolSchemas.filter((tool) =>
            tool.name === "resource_add" ||
            tool.name === "collection_list" ||
            tool.name === "workspace_export" ||
            tool.name === "resource_pdf",
          )
        : topic === "tools"
          ? toolSchemas
          : toolSchemas;

  const filteredProviders = providerFilter
    ? providerEntries.filter((provider) => provider.id === providerFilter)
    : topic === "providers"
      ? providerEntries
      : topic === "patents"
        ? providerEntries.filter((provider) => provider.sourceType === "patent")
      : topic === "overview" || !topic
        ? providerEntries
        : topic === "lookup" || topic === "workspace" || topic === "skills"
          ? []
          : providerEntries;

  const notes = locale === "zh"
    ? [
        "resource_lookup 会返回规范化 metadata；通用网页检索使用可选的 External Search v1 web 命令。",
        "patent_detail 是显式只读详情拉取；后续如需保存，走 patent-detail -> resource-add。",
        "web_search 仅从用户级 external-search.toml 获取执行授权；status 不启动进程，doctor 只运行无网络 probe。",
        "resource_add / collection_list 指向本地 workspace sink；没有宿主应用写入副作用。",
        "workspace_export 是本地导出 sink；CLI 的 --store 形式可先 dry-run，再写入配置的 export root。",
        "resource_pdf 是兼容别名：它通过已安装 material provider 获取 PDF，再把 artifact 投影为 workspace attachment。",
        "citation_expand 只接受精确标识符并设有深度、节点、边、分页和并发上限；plan 不联网也不写入。",
        "assessment_run 保留来源、时间、缺失与冲突，不输出隐藏的通用质量分数，也不替用户决定取舍。",
        "runs 默认永久保留（maxAgeDays=-1）；删除必须先看 run_prune_plan，再在 CLI 显式使用 runs prune --apply。",
        "昂贵烟测仍然必须单独显式启动；这里展示的是默认安全路径。",
      ]
    : [
        "resource_lookup returns normalized metadata; use optional External Search v1 web_search for general web discovery.",
        "patent_detail is an explicit read-only detail step; store the result later through patent-detail -> resource-add.",
        "web_search gets execution authority only from user-level external-search.toml; status is static and doctor runs a no-network probe.",
        "resource_add / collection_list target the local workspace sink with no host-application write side effects.",
        "workspace_export is a local export sink; the CLI-only --store path supports dry-run and managed export-root writes.",
        "resource_pdf is a compatibility alias: it acquires through an installed material provider, then projects the artifact as a workspace attachment.",
        "citation_expand requires exact identifiers and bounded depth, node, edge, page, and concurrency limits; plan performs no network or writes.",
        "assessment_run preserves source, time, missing evidence, and conflicts without a hidden universal quality score or user decision.",
        "Runs are retained indefinitely by default (maxAgeDays=-1); inspect run_prune_plan before the explicit CLI-only runs prune --apply.",
        "Expensive smoke checks remain separate and must be enabled explicitly.",
      ];

  return {
    locale,
    surface: "capability-first",
    quickstart: buildQuickstart(config, locale),
    tools: filteredTools,
    cliMappings: CLI_TOOL_MAPPINGS.filter(
      (mapping) =>
        filteredTools.some((tool) => tool.name === mapping.tool) ||
        topic === "overview" ||
        topic === "tools" ||
        !topic,
    ),
    cliOnlyCommands: topic === "overview" || topic === "tools" || !topic ? CLI_ONLY_COMMANDS : [],
    providers: filteredProviders,
    notes,
  };
}
