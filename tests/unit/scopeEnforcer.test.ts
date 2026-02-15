/**
 * Tests for Issue 2: scopeEnforcer
 *
 * Pure unit tests for enforceUserScope() logic.
 */
import { describe, it, expect } from 'vitest';
import { enforceUserScope } from '../../src/auth/scopeEnforcer.js';
import { ENTERPRISE_CONTEXT, type UserContext } from '../../src/auth/userContext.js';

const userCtx: UserContext = { userId: 'user-123', tokenMode: 'user' };

describe('enforceUserScope', () => {
  describe('enterprise mode', () => {
    it('always passes through args unchanged', () => {
      const args = { user: { id: 'other-user' }, time_range: { start: '2026-01-01', end: '2026-01-31' } };
      const result = enforceUserScope('user_work_summary', args, ENTERPRISE_CONTEXT);
      expect(result.allowed).toBe(true);
      expect(result.args).toEqual(args);
    });
  });

  describe('user mode', () => {
    it('user_work_summary: forces user.id to ctx.userId', () => {
      const args = { user: { id: 'other-user' }, time_range: { start: '2026-01-01', end: '2026-01-31' } };
      const result = enforceUserScope('user_work_summary', args, userCtx);
      expect(result.allowed).toBe(true);
      const rewritten = result.args as Record<string, unknown>;
      expect((rewritten.user as Record<string, unknown>).id).toBe('user-123');
    });

    it('user_work_summary_v1: version suffix is stripped for matching', () => {
      const args = { user: { name: 'alice' }, time_range: { start: '2026-01-01', end: '2026-01-31' } };
      const result = enforceUserScope('user_work_summary_v1', args, userCtx);
      expect(result.allowed).toBe(true);
      const rewritten = result.args as Record<string, unknown>;
      expect((rewritten.user as Record<string, unknown>).id).toBe('user-123');
    });

    it('team_work_summary: forces user_ids to [ctx.userId]', () => {
      const args = { time_range: { start: '2026-01-01', end: '2026-01-31' }, user_ids: ['a', 'b'] };
      const result = enforceUserScope('team_work_summary', args, userCtx);
      expect(result.allowed).toBe(true);
      const rewritten = result.args as Record<string, unknown>;
      expect(rewritten.user_ids).toEqual(['user-123']);
    });

    it('list_workloads: forces report_by_id to ctx.userId', () => {
      const args = { time_range: { start: '2026-01-01', end: '2026-01-31' } };
      const result = enforceUserScope('list_workloads', args, userCtx);
      expect(result.allowed).toBe(true);
      const rewritten = result.args as Record<string, unknown>;
      expect(rewritten.report_by_id).toBe('user-123');
    });

    it('list_users: restricted to own user record', () => {
      const args = {};
      const result = enforceUserScope('list_users', args, userCtx);
      expect(result.allowed).toBe(true);
      const rewritten = result.args as Record<string, unknown>;
      expect(rewritten._restrict_to_user_id).toBe('user-123');
    });

    it('get_work_item: denied in user mode', () => {
      const args = { id: 'wi-001' };
      const result = enforceUserScope('get_work_item', args, userCtx);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('not available in user token mode');
    });

    it('unknown tool: denied by default', () => {
      const result = enforceUserScope('unknown_custom_tool', {}, userCtx);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('not available');
    });
  });
});
