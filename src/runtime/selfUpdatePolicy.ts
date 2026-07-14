export interface OfficialRepositoryOrigin {
  fetchUrl: string;
  branches?: readonly string[];
}

export type OfficialOriginPolicy =
  | {
      status: "available";
      policyId: string;
      repositories: readonly OfficialRepositoryOrigin[];
    }
  | {
      status: "unavailable";
      policyId: string;
      reason: string;
    };

const OFFICIAL_REPOSITORIES = Object.freeze([
  Object.freeze({
    fetchUrl: "https://github.com/X-T-E-R/paper-search-cli.git",
    branches: Object.freeze(["main"]),
  }),
]);

/** Production self-update authority is sealed into the compiled source. */
export const PRODUCTION_OFFICIAL_ORIGIN_POLICY: OfficialOriginPolicy = Object.freeze({
  status: "available",
  policyId: "paper-search-official-origin-v1",
  repositories: OFFICIAL_REPOSITORIES,
});
