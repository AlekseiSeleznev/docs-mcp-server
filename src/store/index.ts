import type { EventBusService } from "../events";
import type { AppConfig } from "../utils/config";
import { CircuitBreakingReranker } from "./CircuitBreakingReranker";
import { DocumentManagementService } from "./DocumentManagementService";
import type { Reranker } from "./Reranker";
import { VoyageReranker } from "./VoyageReranker";

export * from "./DocumentManagementClient";
export * from "./DocumentManagementService";
export * from "./DocumentStore";
export * from "./errors";
export * from "./trpc/interfaces";

/**
 * Creates the local search-executing service and injects its optional Reranker.
 * @param eventBus Local application event bus.
 * @param appConfig Resolved non-secret application configuration.
 * @returns An uninitialized local document management service.
 */
export function createLocalDocumentManagementService(
  eventBus: EventBusService,
  appConfig: AppConfig,
): DocumentManagementService {
  return new DocumentManagementService(
    eventBus,
    appConfig,
    createLocalReranker(appConfig),
  );
}

function createLocalReranker(appConfig: AppConfig): Reranker | undefined {
  if (!appConfig.search.reranker.enabled) {
    return undefined;
  }

  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing required environment variable: VOYAGE_API_KEY");
  }

  return new CircuitBreakingReranker(
    new VoyageReranker({
      apiKey,
      model: appConfig.search.reranker.model,
      requestTimeoutMs: appConfig.search.reranker.requestTimeoutMs,
    }),
  );
}
