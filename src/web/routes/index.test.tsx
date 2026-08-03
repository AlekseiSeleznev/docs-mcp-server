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

    const response = await server.inject({ method: "GET", url: "/" });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      'window.__EVENT_CLIENT_CONFIG__ = {"useRemoteWorker":true,' +
        '"trpcUrl":"http://worker:8080/api"};',
    );
    expect(response.body).not.toContain("/api/api");
  });
});
