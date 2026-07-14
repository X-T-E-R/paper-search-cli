import { describe, expect, it } from "vitest";
import {
  assertToolArgumentsMatchSchema,
  mergeToolArguments,
  ToolArgumentValidationError,
} from "../../src/surface/toolArguments.js";
import { cloneToolSchemas } from "../../src/surface/toolCatalog.js";

function schema(name: string) {
  const tool = cloneToolSchemas().find((entry) => entry.name === name);
  expect(tool, `missing schema for ${name}`).toBeDefined();
  return tool!;
}

describe("tool argument parsing and validation", () => {
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
    expect(() => assertToolArgumentsMatchSchema(webSearch, { query: "RAG", max_results: "5" })).toThrow(
      /max_results must be a number/u,
    );
    expect(() =>
      assertToolArgumentsMatchSchema(webSearch, { query: "RAG", include_domains: ["example.test"] }),
    ).not.toThrow();
    expect(() =>
      assertToolArgumentsMatchSchema(webSearch, { query: "RAG", include_domains: [5] }),
    ).toThrow(/include_domains\[0\] must be a string/u);
    expect(() => assertToolArgumentsMatchSchema(schema("academic_search"), {
      query: "RAG",
      extra: { provider: "fixture" },
    })).not.toThrow();
    expect(() => assertToolArgumentsMatchSchema(webSearch, { query: "RAG", unknown: true })).toThrow(
      /unknown is not a valid argument/u,
    );
  });
});
