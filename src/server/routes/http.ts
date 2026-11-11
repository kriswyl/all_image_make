import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";

export function ok<T>(data: T) { return { ok: true, data }; }

export function fail(code: string, message: string, requestId = crypto.randomUUID(), details?: unknown) {
  return { ok: false, error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res, next).catch(next);
}

export function routeParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}
