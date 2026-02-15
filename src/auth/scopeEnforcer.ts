/**
 * Scope enforcer for TOKEN_MODE=user.
 *
 * In user mode, rewrites tool arguments to restrict queries
 * to the authenticated user's own data.
 */

import type { UserContext } from './userContext.js';

export interface ScopeResult {
  allowed: boolean;
  args?: unknown;
  error?: string;
}

/**
 * Enforce user-mode scope restrictions on tool arguments.
 *
 * - Enterprise mode: always passthrough (no restrictions)
 * - User mode: rewrites args per tool to restrict to ctx.userId
 */
export function enforceUserScope(
  toolName: string,
  args: unknown,
  ctx: UserContext
): ScopeResult {
  // Enterprise mode: no restrictions
  if (ctx.tokenMode === 'enterprise') {
    return { allowed: true, args };
  }

  // User mode: enforce per-tool restrictions
  const parsedArgs = (args ?? {}) as Record<string, unknown>;

  // Strip version suffix for matching (e.g., "user_work_summary_v1" → "user_work_summary")
  const baseName = toolName.replace(/_v\d+$/, '');

  switch (baseName) {
    case 'user_work_summary': {
      // Force user.id to ctx.userId
      return {
        allowed: true,
        args: {
          ...parsedArgs,
          user: { ...(parsedArgs.user as Record<string, unknown> ?? {}), id: ctx.userId },
        },
      };
    }

    case 'team_work_summary': {
      // Force user_ids to [ctx.userId] — user can only see their own data
      return {
        allowed: true,
        args: {
          ...parsedArgs,
          user_ids: [ctx.userId],
        },
      };
    }

    case 'list_workloads': {
      // Force report_by_id to ctx.userId
      return {
        allowed: true,
        args: {
          ...parsedArgs,
          report_by_id: ctx.userId,
        },
      };
    }

    case 'list_users': {
      // User mode: restrict to the authenticated user's own record only,
      // preventing full enterprise user enumeration.
      return {
        allowed: true,
        args: {
          ...parsedArgs,
          _restrict_to_user_id: ctx.userId,
        },
      };
    }

    case 'get_work_item': {
      // User mode: deny direct tool access to prevent probing arbitrary
      // work item metadata.  Internal enrichment (workItemService) is
      // unaffected — it bypasses the tool layer entirely.
      return {
        allowed: false,
        error: 'get_work_item is not available in user token mode. '
          + 'Work item details are automatically included in user_work_summary results.',
      };
    }

    default: {
      // Unknown tools in user mode: deny by default for safety
      return {
        allowed: false,
        error: `Tool "${toolName}" is not available in user token mode`,
      };
    }
  }
}
