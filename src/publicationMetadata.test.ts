import { describe, expect, it } from "vitest";
import {
  extractPublicationMetadata,
  parsePublicationMetadata,
} from "./publicationMetadata";

describe("extractPublicationMetadata", () => {
  it("uses structured PDF or EPUB authors and removes duplicates", () => {
    const result = extractPublicationMetadata({
      content: "1st edition 2019\nCopyright 2018",
      structuredAuthors: ["Stefan Haas", "Bince Mathew", "Stefan Haas"],
    });

    expect(result.publication).toEqual({
      authors: ["Stefan Haas", "Bince Mathew"],
      year: 2019,
    });
  });

  it("extracts one or several authors from book metadata", () => {
    expect(
      extractPublicationMetadata({ content: "Author: Jane Doe" }).publication,
    ).toEqual({ authors: ["Jane Doe"] });
    expect(
      extractPublicationMetadata({ content: "Authors: Jane Doe; John Smith" })
        .publication,
    ).toEqual({ authors: ["Jane Doe", "John Smith"] });
    expect(
      extractPublicationMetadata({
        content:
          "Names: Haas, Stefan (Information technology consultant), author. | Mathew, Bince, author. Title: ABAP Programming Model",
      }).publication,
    ).toEqual({ authors: ["Haas, Stefan", "Mathew, Bince"] });
  });

  it("parses multiline library author records without swallowing the title", () => {
    const result = extractPublicationMetadata({
      content:
        "Names: Densborn, Frank, author. | Finkbohner, Frank, 1969- author.\n| Another, Alex (Developer), author.\nTitle: Migrating to SAP S/4HANA",
    });

    expect(result.publication).toEqual({
      authors: ["Densborn, Frank", "Finkbohner, Frank", "Another, Alex"],
    });
  });

  it("does not treat prose or authorization headings as authors", () => {
    expect(
      extractPublicationMetadata({
        content:
          "By first understanding the typical customer requirements, we can map them.\nAuthorizations in SAP S/4HANA",
      }),
    ).toEqual({});
  });

  it("does not treat editors and other contributors as authors", () => {
    const result = extractPublicationMetadata({
      content: "Edited by Jane Doe\nCopyeditor: John Smith\nCover design: Pat Jones",
      structuredAuthors: ["Jane Doe (Editor)", "Real Author"],
    });

    expect(result.publication).toEqual({ authors: ["Real Author"] });
  });

  it("prefers an edition year over publisher and copyright years", () => {
    const result = extractPublicationMetadata({
      content: "2nd edition 2024\nBoston: Rheinwerk Publishing, 2023\nCopyright © 2022",
    });

    expect(result.publication).toEqual({ year: 2024 });
  });

  it("does not use a historical edition or a person's life year", () => {
    const result = extractPublicationMetadata({
      content:
        "Welcome to the second edition. The first edition was published in 2007.\nGalileo was observed in 1610.\nSAP Press ISBN 978-1-4932-1516-4.",
    });

    expect(result).toEqual({});
  });

  it("does not use years from ISBNs or advertised books", () => {
    const result = extractPublicationMetadata({
      content:
        "SAP Press SBN 978-1-4932-1587-4.\nOther Book, first edition 2019, 500 pages, www.example.test",
    });

    expect(result).toEqual({});
  });

  it("does not use an edition year mentioned in prose about another book", () => {
    const result = extractPublicationMetadata({
      content:
        "The author contributed to the most recent edition of Discover SAP, published in 2014.\nIn 2015, SAP released SAP Fiori, cloud edition to serve customers.",
    });

    expect(result).toEqual({});
  });

  it("omits a conflicting year at the strongest available level", () => {
    const result = extractPublicationMetadata({
      content: "1st edition 2023\nRevised edition 2024\nCopyright © 2022",
    });

    expect(result.publication).toBeUndefined();
    expect(result.conflicts?.year).toEqual([2023, 2024]);
  });

  it("returns no metadata when evidence is absent", () => {
    expect(
      extractPublicationMetadata({ content: "# Chapter 1\nOrdinary prose." }),
    ).toEqual({});
  });

  it("never uses a PDF creation timestamp as publication year", () => {
    const result = extractPublicationMetadata({
      content: "# Book without bibliographic details",
      structuredAuthors: ["Jane Doe"],
    });

    expect(result.publication).toEqual({ authors: ["Jane Doe"] });
  });

  it("accepts old pages without publication metadata", () => {
    expect(parsePublicationMetadata(null)).toBeUndefined();
    expect(parsePublicationMetadata("not-json")).toBeUndefined();
  });
});
