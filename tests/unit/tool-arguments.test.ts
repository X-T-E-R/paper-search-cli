import { describe, expect, it } from "vitest";
import {
  assertToolArgumentsMatchSchema,
  mergeToolArguments,
  ToolArgumentValidationError,
} from "../../src/surface/toolArguments.js";
import { cloneToolSchemas } from "../../src/surface/toolCatalog.js";
import { getTools } from "../../src/surface/tools.js";

function schema(name: string) {
  const tool = cloneToolSchemas().find((entry) => entry.name === name);
  expect(tool, `missing schema for ${name}`).toBeDefined();
  return tool!;
}

describe("tool argument parsing and validation", () => {
  it("keeps search selectors open for catalogue-known sources on partial installs", () => {
  const tools = getTools([], { externalSearchAvailable: true });
    const academic = tools.find((entry) => entry.name === "academic_search")!;
    const patentDetail = tools.find((entry) => entry.name === "patent_detail")!;
    const platform = academic.inputSchema.properties.platform as { enum?: string[] };
    const sources = academic.inputSchema.properties.sources as {
      items?: { enum?: string[] };
    };
    const detailPlatform = patentDetail.inputSchema.properties.platform as { enum?: string[] };

    expect(platform.enum).toBeUndefined();
    expect(sources.items?.enum).toBeUndefined();
    expect(detailPlatform.enum).toBeUndefined();
    expect(() => assertToolArgumentsMatchSchema(academic, {
      query: "RAG",
      platform: "catalogue-only",
      sources: ["catalogue-only"],
      excludeSources: ["portable-source"],
    })).not.toThrow();
  });

  it("merges JSON args with repeated key=value args and parses scalar/JSON-looking values", () => {
    const args = mergeToolArguments({
      jsonArgs: '{"query":"RAG"}',
      argAssignments: [
        "max_results=5",
        "include_answer=false",
        "include_domains=[\"example.test\",\"docs.example.test\"]",
        "extra={\"provider\":\"fixture\"}",
      ],
    });

    expect(args).toEqual({
      query: "RAG",
      max_results: 5,
      include_answer: false,
      include_domains: ["example.test", "docs.example.test"],
      extra: { provider: "fixture" },
    });
  });

  it("rejects duplicate keys instead of building implicit arrays", () => {
    expect(() =>
      mergeToolArguments({
        jsonArgs: '{"query":"RAG"}',
        argAssignments: ["query=override"],
      }),
    ).toThrow(ToolArgumentValidationError);
  });

  it("enforces required fields, enum values, types, arrays, objects, and unknown keys", () => {
    const webSearch = schema("web_search");

    expect(() => assertToolArgumentsMatchSchema(webSearch, { mode: "web" })).toThrow(
      /query is required/u,
    );
    expect(() => assertToolArgumentsMatchSchema(webSearch, { query: "RAG", mode: "invalid" })).toThrow(
      /mode must be one of/u,
    );
    expect(() => assertToolArgumentsMatchSchema(webSearch, { query: "RAG", maxResults: "5" })).toThrow(
      /maxResults must be a number/u,
    );
    expect(() =>
      assertToolArgumentsMatchSchema(webSearch, { query: "RAG", freshness: "pw" }),
    ).not.toThrow();
    expect(() =>
      assertToolArgumentsMatchSchema(webSearch, { query: "RAG", freshness: "week" }),
    ).toThrow(/freshness must be one of/u);
    expect(() => assertToolArgumentsMatchSchema(schema("academic_search"), {
      query: "RAG",
      extra: { provider: "fixture" },
      recordHistory: false,
    })).not.toThrow();
    expect(() => assertToolArgumentsMatchSchema(schema("academic_search"), {
      query: "RAG",
      recordHistory: "false",
    })).toThrow(/recordHistory must be a boolean/u);
    expect(() => assertToolArgumentsMatchSchema(schema("academic_search"), {
      query: "RAG",
      presets: ["general", "biomedicine"],
      sources: ["pubmed"],
      categories: ["content:preprint"],
      excludeSources: ["medrxiv"],
    })).not.toThrow();
    expect(() => assertToolArgumentsMatchSchema(schema("academic_search"), {
      query: "RAG",
      sources: [5],
    })).toThrow(/sources\[0\] must be a string/u);
    expect(() => assertToolArgumentsMatchSchema(webSearch, { query: "RAG", unknown: true })).toThrow(
      /unknown is not a valid argument/u,
    );
  });
});
