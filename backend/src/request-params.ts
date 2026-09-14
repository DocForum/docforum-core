import type { Request } from 'express';
import { HttpError } from './http-error';

/** Express 5 types a route param as `string | string[] | undefined` (it
 * now supports repeated param names). Every route in this repo uses
 * single-segment params, so this narrows that back to `string` or 400s —
 * one place to do it instead of an `as string` cast at every call site. */
export function getParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') {
    throw new HttpError(400, `Missing or invalid path parameter: ${name}`);
  }
  return value;
}
