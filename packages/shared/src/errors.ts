import { z } from "zod";

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional()
  })
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiError(code: string, message: string, details?: unknown): ApiError {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}
