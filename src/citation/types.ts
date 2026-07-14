import type {
  CitationDirection,
  CitationGraphCapability,
  CitationIdentifiers,
  CitationPaper,
  CitationRelationPage,
  ResourceItem,
} from "../providers/sdk/types.js";
import type {
  CreateResearchRunInput,
  FinishResearchRunInput,
  ResearchRunRecord,
  ResearchRunStatus,
  RunBuildIdentity,
  RunProgressUpdate,
  TerminalRunStatus,
} from "../runs/types.js";

export const CITATION_LIMITS = Object.freeze({
  seeds: 20,
  depth: { default: 1, max: 3 },
  perNode: { default: 25, max: 100 },
  nodes: { default: 250, max: 250 },
  edges: { default: 500, max: 500 },
  providerPages: { default: 100, max: 100 },
  concurrency: { default: 4, max: 4 },
});

export interface CitationTraversalLimits {
  depth: number;
  perNode: number;
  nodes: number;
  edges: number;
  providerPages: number;
  concurrency: number;
}

export interface CitationSeed {
  identifiers: CitationIdentifiers;
  item?: ResourceItem;
}

export interface CitationExpandRequest {
  mode?: "plan" | "run" | "resume";
  runId?: string;
  seeds?: CitationSeed[];
  directions?: CitationDirection[];
  providers?: string[];
  excludeIdentifiers?: CitationIdentifiers[];
  limits?: Partial<CitationTraversalLimits>;
}

export interface NormalizedCitationRequest {
  seeds: Array<{ identifiers: CitationIdentifiers; item: ResourceItem }>;
  directions: CitationDirection[];
  requestedProviders?: string[];
  excludeIdentifiers: CitationIdentifiers[];
  limits: CitationTraversalLimits;
}

export interface CitationProviderSnapshot {
  providerId: string;
  providerVersion: string;
  citationGraph: CitationGraphCapability;
}

export interface CitationProviderPlanEntry {
  providerId: string;
  providerVersion?: string;
  selected: boolean;
  available: boolean;
  supported: boolean;
  eligibleSeedCount: number;
  reasons: string[];
  capability?: CitationGraphCapability;
}

export interface CitationPlan {
  mode: "plan";
  request: NormalizedCitationRequest;
  providers: CitationProviderPlanEntry[];
  selectedProviders: CitationProviderSnapshot[];
  plannedWorkUnits: number;
  warnings: string[];
}

export interface CitationNode {
  key: string;
  identifiers: CitationIdentifiers;
  providerNativeIds: Record<string, string>;
  item: ResourceItem;
  depthDiscovered: number;
}

export interface CitationEdgeProvenance {
  providerId: string;
  providerVersion: string;
  targetKeyAtFetch: string;
  direction: CitationDirection;
  requestCursor?: string;
  observedAt: string;
  providerNativeFrom?: string;
  providerNativeTo?: string;
}

export interface CitationEdge {
  id: string;
  citingKey: string;
  citedKey: string;
  relation: "cites";
  provenance: CitationEdgeProvenance[];
}

export interface CitationWorkUnit {
  depth: number;
  nodeKey: string;
  direction: CitationDirection;
  providerId: string;
  cursor?: string;
  fetchedRelations: number;
}

export interface CitationAttempt {
  providerId: string;
  providerVersion: string;
  nodeKey: string;
  direction: CitationDirection;
  cursor?: string;
  startedAt: string;
  finishedAt: string;
  outcome: "success" | "error";
  relationCount?: number;
  exhausted?: boolean;
  errorCode?: "provider_error" | "invalid_provider_page";
  error?: string;
}

export interface CitationCapStop {
  kind: "per_node" | "nodes" | "edges" | "provider_pages";
  nodeKey?: string;
  providerId?: string;
  limit: number;
}

export interface CitationCheckpoint {
  schemaVersion: 1;
  nodes: CitationNode[];
  edges: CitationEdge[];
  keyAliases: Record<string, string>;
  pending: CitationWorkUnit[];
  completed: CitationWorkUnit[];
  providerPages: number;
  successfulPages: number;
  capStops: CitationCapStop[];
}

export interface CitationRunResult {
  mode: "run" | "resume";
  runId: string;
  status: ResearchRunStatus;
  nodes: CitationNode[];
  edges: CitationEdge[];
  attempts: CitationAttempt[];
  diagnostics: Array<{ code: string; message: string }>;
  capStops: CitationCapStop[];
  pendingWorkUnits: number;
}

export interface CitationProviderRuntime {
  id: string;
  version: string;
  available: boolean;
  unavailableReasons: string[];
  capability?: CitationGraphCapability;
  getCitationPage(request: {
    direction: CitationDirection;
    target: CitationPaper;
    pageSize: number;
    cursor?: string;
  }): Promise<CitationRelationPage>;
}

/**
 * Adapter over the common durable-run API. Implementations must provide the
 * common store's locking, atomic replacement, validation, and redaction.
 */
export interface CitationRunPersistence {
  create(input: CreateResearchRunInput): Promise<ResearchRunRecord>;
  read(runId: string): Promise<ResearchRunRecord>;
  resume(runId: string): Promise<ResearchRunRecord>;
  updateProgress(runId: string, update: RunProgressUpdate): Promise<ResearchRunRecord>;
  finish(runId: string, input: FinishResearchRunInput): Promise<ResearchRunRecord>;
}

export interface CitationServiceDependencies {
  providers: readonly CitationProviderRuntime[];
  runs: CitationRunPersistence;
  build: RunBuildIdentity;
  now?: () => Date;
}

export class CitationServiceError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "run_id_required"
      | "no_capable_provider"
      | "run_not_found"
      | "invalid_checkpoint"
      | "provider_drift",
    message: string,
  ) {
    super(message);
    this.name = "CitationServiceError";
  }
}
