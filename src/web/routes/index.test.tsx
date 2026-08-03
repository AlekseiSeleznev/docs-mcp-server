import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerIndexRoute } from "./index";

describe("registerIndexRoute", () => {
  it.each([
    "http://worker:8080/api",
    "http://worker:8080/api/",
  ])("renders the complete remote worker endpoint for %s", async (serverUrl) => {
    const server = Fastify();
    registerIndexRoute(server, serverUrl);

    try {
      const response = await server.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        'window.__EVENT_CLIENT_CONFIG__ = {"useRemoteWorker":true,' +
          '"trpcUrl":"http://worker:8080/api"};',
      );
      expect(response.body).not.toContain("/api/api");
    } finally {
      await server.close();
    }
  });

  it("omits the remote worker endpoint when it is empty", async () => {
    const server = Fastify();
    registerIndexRoute(server, "");

    try {
      const response = await server.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        'window.__EVENT_CLIENT_CONFIG__ = {"useRemoteWorker":false};',
      );
    } finally {
      await server.close();
    }
  });
});
