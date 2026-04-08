/**
 * Environment configuration helpers.
 *
 * Skills self-configure from environment variables via SkillHelpers.
 * This module provides the env() utility for direct env var access.
 */

/** Read an environment variable with optional fallback. */
export function env(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}
