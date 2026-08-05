import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerIndexRoute } from "./index";

describe("registerIndexRoute", () => {
  it("serves the page shell with the containers HTMX hydrates", async () => {
    const server = Fastify();
    registerIndexRoute(server);

    try {
      const response = await server.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain('hx-get="/web/stats"');
      expect(response.body).toContain('hx-get="/web/jobs"');
      expect(response.body).toContain('hx-get="/web/libraries"');
    } finally {
      await server.close();
    }
  });

  it("does not embed worker connection details in the page", async () => {
    const server = Fastify();
    registerIndexRoute(server);

    try {
      const response = await server.inject({ method: "GET", url: "/" });

      // The browser reaches real-time updates through this coordinator's SSE
      // endpoint, which RemoteEventProxy feeds from the worker. It never talks
      // to the worker directly, so the worker URL must not leak into the page.
      expect(response.body).not.toContain("__EVENT_CLIENT_CONFIG__");
    } finally {
      await server.close();
    }
  });
});
