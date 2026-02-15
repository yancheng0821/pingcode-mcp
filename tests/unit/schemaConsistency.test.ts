import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { UserWorkSummaryInputSchema, userWorkSummaryToolDefinition } from '../../src/tools/userWorkSummary.js';
import { TeamWorkSummaryInputSchema, teamWorkSummaryToolDefinition } from '../../src/tools/teamWorkSummary.js';
import { ListUsersInputSchema, listUsersToolDefinition } from '../../src/tools/listUsers.js';
import { ListWorkloadsInputSchema, listWorkloadsToolDefinition } from '../../src/tools/listWorkloads.js';
import { GetWorkItemInputSchema, getWorkItemToolDefinition } from '../../src/tools/getWorkItem.js';

function getJsonSchemaProperties(zodSchema: unknown): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(zodSchema as Parameters<typeof zodToJsonSchema>[0], {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  return (jsonSchema.properties ?? {}) as Record<string, unknown>;
}

const tools = [
  { name: 'user_work_summary', schema: UserWorkSummaryInputSchema, definition: userWorkSummaryToolDefinition },
  { name: 'team_work_summary', schema: TeamWorkSummaryInputSchema, definition: teamWorkSummaryToolDefinition },
  { name: 'list_users', schema: ListUsersInputSchema, definition: listUsersToolDefinition },
  { name: 'list_workloads', schema: ListWorkloadsInputSchema, definition: listWorkloadsToolDefinition },
  { name: 'get_work_item', schema: GetWorkItemInputSchema, definition: getWorkItemToolDefinition },
];

describe('Schema Consistency', () => {
  for (const tool of tools) {
    describe(tool.name, () => {
      it('Zod schema and toolDefinition have matching top-level property keys', () => {
        const zodProperties = getJsonSchemaProperties(tool.schema);
        const definitionProperties = tool.definition.inputSchema.properties;
        const zodKeys = Object.keys(zodProperties).sort();
        const defKeys = Object.keys(definitionProperties).sort();
        expect(zodKeys).toEqual(defKeys);
      });

      it('toolDefinition required array matches Zod required fields', () => {
        const jsonSchema = zodToJsonSchema(tool.schema, {
          target: 'jsonSchema7',
          $refStrategy: 'none',
        }) as Record<string, unknown>;
        const zodRequired = ((jsonSchema.required ?? []) as string[]).sort();
        const defRequired = ((tool.definition.inputSchema.required ?? []) as string[]).sort();
        expect(zodRequired).toEqual(defRequired);
      });

      it('generated schema has valid type=object', () => {
        expect(tool.definition.inputSchema.type).toBe('object');
        expect(tool.definition.inputSchema.properties).toBeDefined();
        expect(typeof tool.definition.inputSchema.properties).toBe('object');
      });

      it('enum values in toolDefinition match Zod schema', () => {
        const zodProperties = getJsonSchemaProperties(tool.schema);
        const defProperties = tool.definition.inputSchema.properties as Record<string, Record<string, unknown>>;

        for (const key of Object.keys(defProperties)) {
          const defProp = defProperties[key];
          if (defProp.enum) {
            const zodProp = zodProperties[key] as Record<string, unknown> | undefined;
            // Zod may wrap in anyOf for optional enums; check both
            if (zodProp?.enum) {
              expect((zodProp.enum as string[]).sort()).toEqual((defProp.enum as string[]).sort());
            } else if (zodProp?.anyOf) {
              const enumBranch = (zodProp.anyOf as Array<Record<string, unknown>>).find(b => b.enum);
              if (enumBranch) {
                expect((enumBranch.enum as string[]).sort()).toEqual((defProp.enum as string[]).sort());
              }
            }
          }
        }
      });
    });
  }

  it('no tool files contain hand-written inputSchema objects', () => {
    const toolDir = path.resolve(import.meta.dirname, '../../src/tools');
    const toolFiles = ['userWorkSummary.ts', 'teamWorkSummary.ts', 'listUsers.ts', 'listWorkloads.ts', 'getWorkItem.ts'];

    for (const file of toolFiles) {
      const content = fs.readFileSync(path.join(toolDir, file), 'utf-8');
      // The only place inputSchema should appear is as part of createToolDefinition usage
      // There should be no hand-written "inputSchema: {" literal (i.e. directly assigning an object)
      const handWrittenPattern = /inputSchema:\s*\{[\s\S]*?type:\s*['"]object['"]/;
      expect(content).not.toMatch(handWrittenPattern);
    }
  });
});
