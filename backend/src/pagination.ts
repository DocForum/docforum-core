import { Buffer } from "node:buffer";
export const MAX_PAGE_SIZE = 100;
export function decodeCursor(cursor?: string): number { if (!cursor) return 0; const n=Number(Buffer.from(cursor,"base64url").toString()); if(!Number.isSafeInteger(n)||n<0) throw new Error("invalid cursor"); return n; }
export function encodeCursor(offset:number): string { return Buffer.from(String(offset)).toString("base64url"); }
export function page<T>(items:T[],limit=50,cursor?:string){const size=Math.min(Math.max(1,limit),MAX_PAGE_SIZE),start=decodeCursor(cursor),slice=items.slice(start,start+size);return {items:slice,nextCursor:start+size<items.length?encodeCursor(start+size):null};}
