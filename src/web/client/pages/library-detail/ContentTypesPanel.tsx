/**
 * Library-detail "Content types" panel: the active version's pages grouped by
 * MIME type, shown as proportional bars. Sits under the Scrape Configuration
 * card in the left column (data from `getVersionComposition`).
 */
import { useVersionComposition } from "../../api/hooks";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Loading } from "../../components/Spinner";

export interface ContentTypesPanelProps {
  library: string;
  /** The active version (empty string for unversioned). */
  version: string;
}

/** A labeled proportional bar row; `max` scales the fill width. */
function BarRow({ name, count, max }: { name: string; count: number; max: number }) {
  // Floor non-empty bars at 2% so a single page is still visible.
  const pct = max > 0 && count > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
  return (
    <div className="comp-bar-row">
      <span className="comp-name" title={name}>
        {name}
      </span>
      <span className="comp-bar-track">
        <span className="comp-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="comp-bar-count">{count.toLocaleString()}</span>
    </div>
  );
}

/**
 * @example <ContentTypesPanel library="react" version="19.0" />
 */
export function ContentTypesPanel({ library, version }: ContentTypesPanelProps) {
  const { data, isLoading, isError, error } = useVersionComposition(
    { library, version },
    true,
  );

  const mimeTypes = data?.mimeTypes ?? [];
  const max = Math.max(1, ...mimeTypes.map((mime) => mime.pages));

  return (
    <Card className="panel">
      <div className="panel__head">
        <h3>Content types</h3>
      </div>
      {isLoading ? (
        <Loading label="Loading content types…" />
      ) : isError ? (
        <EmptyState
          icon="i-file"
          title="Couldn't load content types"
          description={error ? error.message : "Please try again."}
        />
      ) : mimeTypes.length === 0 ? (
        <EmptyState
          icon="i-file"
          title="No content yet"
          description="This version has no indexed pages to analyze."
        />
      ) : (
        <div className="comp-list">
          {mimeTypes.map((mime) => (
            <BarRow key={mime.label} name={mime.label} count={mime.pages} max={max} />
          ))}
        </div>
      )}
    </Card>
  );
}
