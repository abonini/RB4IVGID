import path from "path";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import type { RuntimeConfig } from "./config";
import { readBearer, tokensMatch } from "./crypto";
import { SourceError } from "./errors";
import { errorMessage, logError } from "./log";
import type { ResultsService } from "./resultsService";

export function createApp(service: ResultsService, config: RuntimeConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("Content-Security-Policy", "frame-ancestors *");
    response.removeHeader("X-Frame-Options");
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.getHealth());
    } catch (error) {
      logError("health_failed", { message: errorMessage(error) });
      response.status(500).json({ ok: false, warning: "Health check failed." });
    }
  });

  app.get("/api/results", async (_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(await service.getResults());
    } catch (error) {
      logError("results_request_failed", { message: errorMessage(error) });
      response.status(500).json({ ok: false, warning: "Results are temporarily unavailable." });
    }
  });

  app.post("/api/manual-entry", async (request, response) => {
    if (!config.adminToken) {
      response.status(404).json({ ok: false, warning: "Not found" });
      return;
    }
    if (!tokensMatch(readBearer(request.get("authorization")), config.adminToken)) {
      logError("manual_entry_rejected", { reason: "unauthorized" });
      response.status(401).json({ ok: false, warning: "Unauthorized" });
      return;
    }
    try {
      response.json(await service.applyManualEntry(request.body));
    } catch (error) {
      if (error instanceof SourceError) {
        response.status(400).json({ ok: false, warning: error.message });
        return;
      }
      logError("manual_entry_failed", { message: errorMessage(error) });
      response.status(500).json({ ok: false, warning: "Manual entry could not be saved." });
    }
  });

  const clientDir = path.join(process.cwd(), "dist/client");
  app.use(express.static(clientDir, { index: false }));
  app.get("/", (request, response) => {
    const query = request.originalUrl.includes("?") ? request.originalUrl.slice(request.originalUrl.indexOf("?")) : "";
    response.redirect(302, `/ivgid-results${query}`);
  });
  app.get("/ivgid-results", (_request, response) => {
    response.sendFile(path.join(clientDir, "index.html"), (error) => {
      if (!error) return;
      logError("widget_missing", { message: errorMessage(error) });
      if (!response.headersSent) {
        response.status(503).type("text/plain").send("Widget build is missing. Run npm run build.");
      }
    });
  });

  app.use(jsonErrorHandler);
  return app;
}

const jsonErrorHandler: ErrorRequestHandler = (error: unknown, _request: Request, response: Response, next: NextFunction) => {
  if (error instanceof SyntaxError) {
    response.status(400).json({ ok: false, warning: "Request body must be JSON." });
    return;
  }
  next(error);
};
