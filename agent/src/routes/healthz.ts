/**
 * supplier/src/routes/healthz.ts — GET /healthz
 *
 * Minimal liveness probe. Independent of /status (free/working/offline) —
 * /healthz reports only that the HTTP layer is up. It MUST NOT touch chain
 * (no UTxO query, no submitTx) and MUST NOT depend on supplier state.
 *
 * Per ARCHITECTURE.md §5 endpoint table: every service exposes
 *   GET /healthz → 200 { ok: true } with Cache-Control: no-store
 */

import { Router, type Request, type Response } from "express";

export function healthzRouter(): Router {
  const router = Router();
  router.get("/healthz", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true });
  });
  return router;
}
