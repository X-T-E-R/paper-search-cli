export function expandRegistryUrlCandidates(input: string): string[] {
  const normalized = input.trim().replace(/\/+$/, "");
  if (!normalized) {
    return [];
  }

  if (/\.json($|\?)/i.test(normalized)) {
    return [normalized];
  }

  const githubMatch = normalized.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?$/i,
  );
  if (githubMatch) {
    const [, owner, repo, branch] = githubMatch;
    const candidates = [
      `https://github.com/${owner}/${repo}/releases/download/providers-registry-latest/registry.json`,
      `https://github.com/${owner}/${repo}/releases/latest/download/registry.json`,
    ];
    const branches = branch ? [branch] : ["main", "master"];
    for (const branchName of branches) {
      candidates.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branchName}/registry.json`);
    }
    return candidates;
  }

  if (/^https:\/\/raw\.githubusercontent\.com\//i.test(normalized)) {
    return [`${normalized}/registry.json`];
  }

  return [`${normalized}/registry.json`, normalized];
}
