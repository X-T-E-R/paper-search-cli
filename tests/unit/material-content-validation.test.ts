import { describe, expect, it } from "vitest";
import { detectUnusableMaterialContent } from "../../src/material/contentValidation.js";

describe("material content validation", () => {
  it.each([
    {
      content: "Checking your browser before accessing pmc.ncbi.nlm.nih.gov",
      marker: "checking your browser before accessing",
    },
    {
      content: "<head><title>Radware Bot Manager Captcha</title></head>",
      marker: "radware bot manager captcha",
    },
    {
      content: "# Human Verification\n\nPlease complete the browser check to continue.",
      marker: "human verification",
    },
    {
      content: "<html><h1>503 Service Unavailable</h1></html>",
      marker: "503 service unavailable",
    },
  ])("identifies challenge/error material containing $marker", ({ content, marker }) => {
    expect(detectUnusableMaterialContent(content)).toMatchObject({ marker });
  });

  it.each([
    "OK",
    "# Brief note\n",
    "<p>Short but legitimate HTML.</p>",
  ])("accepts legitimate short content without a size threshold", (content) => {
    expect(detectUnusableMaterialContent(content)).toBeUndefined();
  });
});
