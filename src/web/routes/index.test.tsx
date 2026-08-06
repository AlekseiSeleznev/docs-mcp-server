import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerIndexRoute } from "./index";

describe("registerIndexRoute", () => {
  it("renders the dashboard shell with the containers HTMX hydrates", async () => {
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
});
