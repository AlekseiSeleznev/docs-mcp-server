import { describe, expect, it } from "vitest";
import { formatSearchResults } from "./utils";

describe("formatSearchResults", () => {
  it("prints available publication fields", () => {
    const [formatted] = formatSearchResults([
      {
        url: "file:///book.pdf",
        content: "Book excerpt",
        publication: { authors: ["Stefan Haas", "Bince Mathew"], year: 2019 },
      },
    ]);

    expect(formatted).toContain("Publication authors: Stefan Haas; Bince Mathew");
    expect(formatted).toContain("Publication year: 2019");
  });

  it("preserves the old output when metadata is absent", () => {
    const [formatted] = formatSearchResults([
      { url: "file:///legacy.md", content: "Legacy excerpt" },
    ]);

    expect(formatted).toBe(`
------------------------------------------------------------
Result 1: file:///legacy.md

Legacy excerpt\n`);
  });
});
