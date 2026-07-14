var __zrs_exports = {
  createProvider(api) {
    return {
      async search(query, options) {
        await api.rateLimit.acquire();
        const response = await api.http.get("https://fixture.example/search", {
          params: {
            q: query,
            rows: options?.maxResults ?? 10
          }
        });
        return {
          platform: "fixture-academic",
          query,
          totalResults: response.data.totalResults ?? 0,
          items: response.data.items ?? [],
          page: options?.page ?? 1,
          hasMore: false
        };
      }
    };
  }
};
globalThis.__zrs_exports = __zrs_exports;
