# document-processing Specification

## Purpose
Defines how binary documents are routed (distinguishing archives from ZIP-based documents) and how text is extracted from supported document formats via the Xberg library.

## Requirements

### Requirement: Archive detection exclusion for document formats
The archive detection system SHALL NOT treat ZIP-based document formats as archives. Specifically, `ArchiveFactory.getArchiveAdapter()` SHALL return `null` for files with extensions corresponding to supported document formats (`.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.epub`). Archive detection SHALL rely exclusively on file extensions (`.zip`, `.tar`, `.gz`, `.tgz`) rather than magic byte inspection, ensuring document files are routed to `DocumentPipeline` for proper text extraction.

#### Scenario: DOCX file not treated as archive
- **WHEN** `getArchiveAdapter()` is called with a path ending in `.docx`
- **THEN** it SHALL return `null`
- **AND** the file SHALL be processed by `DocumentPipeline` via Xberg

#### Scenario: XLSX file not treated as archive
- **WHEN** `getArchiveAdapter()` is called with a path ending in `.xlsx`
- **THEN** it SHALL return `null`

#### Scenario: PPTX file not treated as archive
- **WHEN** `getArchiveAdapter()` is called with a path ending in `.pptx`
- **THEN** it SHALL return `null`

#### Scenario: EPUB file not treated as archive
- **WHEN** `getArchiveAdapter()` is called with a path ending in `.epub`
- **THEN** it SHALL return `null`

#### Scenario: OpenDocument files not treated as archives
- **WHEN** `getArchiveAdapter()` is called with a path ending in `.odt`, `.ods`, or `.odp`
- **THEN** it SHALL return `null`

#### Scenario: Actual ZIP file still detected
- **WHEN** `getArchiveAdapter()` is called with a path ending in `.zip`
- **THEN** it SHALL return a `ZipAdapter` instance

#### Scenario: Extensionless file not treated as archive
- **WHEN** `getArchiveAdapter()` is called with a file that has no extension
- **THEN** it SHALL return `null`
- **AND** the file SHALL NOT be opened or inspected for magic bytes

### Requirement: Document text extraction via Xberg
The system SHALL use the Xberg library (`@xberg-io/xberg`) to extract text content from binary document formats. The extraction SHALL accept in-memory buffers with a MIME type and return Markdown-formatted content for downstream splitting. The system SHALL request Markdown output from Xberg via `outputFormat: OutputFormat.Markdown` in the extraction configuration.

#### Scenario: PDF text extraction
- **WHEN** a PDF document buffer is passed to the DocumentPipeline
- **THEN** the system SHALL extract text content using Xberg's `extract()` API with a `bytes` input and `outputFormat: OutputFormat.Markdown`
- **AND** the result SHALL contain the document's text content
- **AND** the content type SHALL be `text/markdown`

#### Scenario: DOCX text extraction with formatting
- **WHEN** a DOCX document buffer with headings, bold, italic, lists, and tables is passed to the DocumentPipeline
- **THEN** the system SHALL extract Markdown-formatted content preserving headings, emphasis, lists, and table structure
- **AND** the content type SHALL be `text/markdown`

#### Scenario: Extraction failure handling
- **WHEN** Xberg fails to extract content from a document
- **THEN** the system SHALL return a `PipelineResult` with an error and null text content
- **AND** the system SHALL NOT crash or throw unhandled exceptions

#### Scenario: Envelope without a result
- **WHEN** Xberg's `extract()` resolves with an empty `results` array and a populated `errors` array
- **THEN** the system SHALL treat the extraction as failed
- **AND** the system SHALL include the per-input error message in the failure log

### Requirement: Prefer rendered Markdown content over per-table Markdown
The system SHALL use `content` from Xberg's extracted document as the extracted text whenever it is non-empty, falling back to the concatenated `tables[].markdown` only when `content` is empty. Xberg's Markdown renderer emits the full document structure in `content` — including sheet headings and Markdown tables for spreadsheets — so `content` is a superset of the per-table Markdown.

#### Scenario: Spreadsheet with tabular data
- **WHEN** an XLSX or ODS document with tabular data across one or more sheets is extracted
- **THEN** the system SHALL use `content` as the extracted text
- **AND** each sheet SHALL appear as a Markdown heading followed by a Markdown table

#### Scenario: Document with inline tables
- **WHEN** a DOCX document containing inline tables is extracted
- **AND** Xberg populates both `content` (with full Markdown structure) and `tables` (with table-only data)
- **THEN** the system SHALL use `content` because it includes the full document structure (headings, paragraphs, lists) alongside the tables

#### Scenario: Document without tables
- **WHEN** a document is extracted and `tables` is empty or absent
- **THEN** the system SHALL use `content` as the extracted text

#### Scenario: Empty rendered content with structured tables
- **WHEN** a document is extracted and `content` is empty or whitespace-only
- **AND** `tables` contains at least one entry with non-empty Markdown
- **THEN** the system SHALL use the concatenated `tables[].markdown` as the extracted text

### Requirement: Legacy Office format support
The system SHALL support extraction of legacy Microsoft Office formats (DOC, XLS, PPT) that Xberg handles natively without requiring external tools like LibreOffice.

#### Scenario: DOC file extraction
- **WHEN** a `.doc` file with MIME type `application/msword` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

#### Scenario: XLS file extraction
- **WHEN** a `.xls` file with MIME type `application/vnd.ms-excel` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

#### Scenario: PPT file extraction
- **WHEN** a `.ppt` file with MIME type `application/vnd.ms-powerpoint` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

### Requirement: OpenDocument format support
The system SHALL support extraction of OpenDocument formats (ODT, ODS, ODP).

#### Scenario: ODT file extraction
- **WHEN** a `.odt` file with MIME type `application/vnd.oasis.opendocument.text` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

#### Scenario: ODS file extraction
- **WHEN** a `.ods` file with MIME type `application/vnd.oasis.opendocument.spreadsheet` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

#### Scenario: ODP file extraction
- **WHEN** a `.odp` file with MIME type `application/vnd.oasis.opendocument.presentation` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

### Requirement: RTF format support
The system SHALL support extraction of Rich Text Format (RTF) documents.

#### Scenario: RTF file extraction
- **WHEN** a `.rtf` file with MIME type `application/rtf` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

### Requirement: eBook format support
The system SHALL support extraction of eBook formats (EPUB, FB2).

#### Scenario: EPUB file extraction
- **WHEN** an `.epub` file with MIME type `application/epub+zip` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

#### Scenario: FB2 file extraction
- **WHEN** an `.fb2` file with MIME type `application/x-fictionbook+xml` is processed
- **THEN** the `DocumentPipeline` SHALL accept and extract text content from it

### Requirement: Document metadata extraction
The system SHALL extract document metadata (title) from Xberg's extraction result when available, falling back to filename-based title extraction.

#### Scenario: Title from document metadata
- **WHEN** a document with embedded title metadata is extracted
- **THEN** the system SHALL use the metadata title as the pipeline result title

#### Scenario: Title fallback to filename
- **WHEN** a document has no embedded title metadata
- **THEN** the system SHALL extract the filename from the source URL/path as the title

### Requirement: Document size limit enforcement
The system SHALL enforce the configured maximum document size (`scraper.document.maxSize`) before attempting extraction, rejecting documents that exceed the limit.

#### Scenario: Document within size limit
- **WHEN** a document buffer is smaller than `scraper.document.maxSize`
- **THEN** the system SHALL proceed with extraction

#### Scenario: Document exceeding size limit
- **WHEN** a document buffer exceeds `scraper.document.maxSize`
- **THEN** the system SHALL return an error result without attempting extraction
- **AND** the error message SHALL indicate the size limit was exceeded
