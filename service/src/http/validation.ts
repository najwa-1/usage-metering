import { z } from 'zod';
import { parseMonth } from '../domain/period.js';

// keeps all the arithmetic far away from Number.MAX_SAFE_INTEGER
const MAX_QUANTITY = 1_000_000_000;

const positiveInt = z.number().int('must be a whole number').min(1, 'must be at least 1').max(MAX_QUANTITY);
const nonNegativeInt = z.number().int('must be a whole number').min(0, 'must be 0 or more').max(MAX_QUANTITY);
const uuid = z.string().uuid('must be a UUID');
const identifier = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(128, 'must be at most 128 characters')
  .regex(/^[A-Za-z0-9_\-.:@]+$/, 'may contain only letters, digits and _ - . : @');

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(200),
  planId: uuid.optional(),
});

export const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['account', 'user']),
  monthlyAllowance: nonNegativeInt,
  maxUnitsPerRequest: positiveInt,
});

export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    monthlyAllowance: nonNegativeInt.optional(),
    maxUnitsPerRequest: positiveInt.optional(),
  })
  .strict() // scope can't be changed once users/accounts are on the plan
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field to update' });

export const assignPlanSchema = z.object({
  planId: uuid,
});

export const createUserSchema = z.object({
  userId: identifier,
  planId: uuid.optional(),
});

export const consumeSchema = z.object({
  userId: identifier,
  units: positiveInt,
  requestId: identifier,
});

export const monthQuery = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    const parsed = parseMonth(value);
    if (!parsed) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'month must look like YYYY-MM' });
    return parsed ?? undefined;
  });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().min(1).optional(),
});

export const historyQuery = paginationQuery.extend({
  month: monthQuery,
  userId: identifier.optional(),
  outcome: z.enum(['accepted', 'rejected']).optional(),
});

export const listUsersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
