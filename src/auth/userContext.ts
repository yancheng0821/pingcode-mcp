/**
 * User context for TOKEN_MODE scoping.
 *
 * Enterprise mode: no restrictions, queries run with the enterprise token.
 * User mode: queries are restricted to the authenticated user's own data.
 */

export interface UserContext {
  userId: string;
  tokenMode: 'enterprise' | 'user';
}

export const ENTERPRISE_CONTEXT: UserContext = {
  userId: '',
  tokenMode: 'enterprise',
};
