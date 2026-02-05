import { z } from 'zod';
import { workItemService } from '../services/workItemService.js';
import { logger } from '../utils/logger.js';

// ============ Schema 定义 ============

export const GetWorkItemInputSchema = z.object({
  id: z.string(),
});

export type GetWorkItemInput = z.infer<typeof GetWorkItemInputSchema>;

// ============ 输出类型 ============

export interface GetWorkItemOutput {
  work_item: {
    id: string;
    identifier: string;
    title: string;
    state?: string;
    type?: string;
    project: {
      id: string;
      identifier: string;
      name: string;
    };
  };
}

export interface GetWorkItemError {
  error: string;
  code: 'NOT_FOUND' | 'INTERNAL_ERROR';
}

export type GetWorkItemResult = GetWorkItemOutput | GetWorkItemError;

// ============ Tool 实现 ============

export async function getWorkItem(input: GetWorkItemInput): Promise<GetWorkItemResult> {
  logger.info({ input }, 'get_work_item called');

  try {
    const workItem = await workItemService.getWorkItem(input.id);

    if (!workItem) {
      return {
        error: `Work item not found: ${input.id}`,
        code: 'NOT_FOUND',
      };
    }

    return {
      work_item: {
        id: workItem.id,
        identifier: workItem.identifier,
        title: workItem.title,
        state: workItem.state,
        type: workItem.type,
        project: {
          id: workItem.project.id,
          identifier: workItem.project.identifier,
          name: workItem.project.name,
        },
      },
    };
  } catch (error) {
    logger.error({ error, input }, 'get_work_item failed');
    return {
      error: `Internal error: ${(error as Error).message}`,
      code: 'INTERNAL_ERROR',
    };
  }
}

// ============ MCP Tool 定义 ============

export const getWorkItemToolDefinition = {
  name: 'get_work_item',
  description: `获取单个工作项的详情。

参数：
- id: 工作项 ID

返回：
- work_item: 工作项详情（含项目信息）`,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '工作项 ID',
      },
    },
    required: ['id'],
  },
};
