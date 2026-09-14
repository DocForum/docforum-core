import { PrismaClient } from '@prisma/client';

// Single shared client for the whole process — Prisma's own guidance for
// a long-running server (as opposed to a new client per request/lambda).
export const prisma = new PrismaClient();
