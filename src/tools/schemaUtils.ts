import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition } from './versions.js';

/**
 * Generate a ToolDefinition from a description and a Zod schema.
 *
 * Uses zod-to-json-schema to produce the JSON Schema, eliminating the need
 * for hand-written inputSchema objects.
 *
 * Note: z.refine() validators are runtime-only and not reflected in the
 * generated JSON Schema. This is acceptable since the MCP SDK validates
 * via Zod at call time.
 */
export function createToolDefinition(
  description: string,
  schema: z.ZodTypeAny,
): Omit<ToolDefinition, 'name'> {
  const jsonSchema = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // Strip the $schema key (not needed for MCP tool definitions)
  delete jsonSchema.$schema;

  return {
    description,
    inputSchema: jsonSchema as ToolDefinition['inputSchema'],
  };
}
