var __zrs_exports = {
  createProvider(api) {
    return {
      async search(query, options) {
        return {
          platform: "fixture-academic-searchable",
          query,
          totalResults: 2,
          items: [
            {
              itemType: "journalArticle",
              title: "Search Result A",
              url: "https://fixture.example/a"
            },
            {
              itemType: "journalArticle",
              title: "Search Result B",
              url: "https://fixture.example/b"
            }
          ],
          page: options?.page ?? 1,
          elapsed: 1,
          hasMore: false
        };
      }
    };
  }
};
globalThis.__zrs_exports = __zrs_exports;
