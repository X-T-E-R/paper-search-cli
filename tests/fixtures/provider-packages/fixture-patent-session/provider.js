var __zrs_exports = {
  createProvider(api) {
    let authenticated = false;

    async function login(force) {
      if (authenticated && !force) {
        return;
      }
      const loginName = api.config.getString("loginName", "").trim();
      const password = api.config.getString("password", "").trim();
      if (!loginName || !password) {
        throw new Error("Fixture patent credentials are required");
      }
      const response = await api.http.post(
        "https://fixture.example/login",
        JSON.stringify({ loginName, password }),
        {
          headers: { "content-type": "application/json" },
          withCredentials: true
        }
      );
      if (!response.data || response.data.ok !== true) {
        throw new Error(response.data?.error || "Fixture patent login failed");
      }
      authenticated = true;
    }

    return {
      async search(query, options) {
        await login(false);
        const response = await api.http.post(
          "https://fixture.example/search",
          JSON.stringify({ query, options }),
          {
            headers: { "content-type": "application/json" },
            withCredentials: true
          }
        );
        if (!response.data || response.data.ok !== true) {
          throw new Error(response.data?.error || "Fixture patent search failed");
        }
        return response.data.result;
      },

      async getDetail(sourceId, options) {
        await login(false);
        const response = await api.http.post(
          "https://fixture.example/detail",
          JSON.stringify({ sourceId, options }),
          {
            headers: { "content-type": "application/json" },
            withCredentials: true
          }
        );
        if (!response.data || response.data.ok !== true) {
          throw new Error(response.data?.error || "Fixture patent detail failed");
        }
        return response.data.result;
      }
    };
  }
};
globalThis.__zrs_exports = __zrs_exports;
