import {
  getWorkItem,
  getWorkItemsBatch,
  getWorkItemsFromWorkloads,
} from '../api/endpoints/workItems.js';
import type { PingCodeWorkItem, PingCodeWorkload } from '../api/types.js';

export interface WorkItemInfo {
  id: string;
  identifier: string;
  title: string;
  project: {
    id: string;
    identifier: string;
    name: string;
    type?: string;
  };
  state?: string;
  type?: string;
  assignee?: {
    id: string;
    name: string;
    display_name: string;
  };
}

export interface ProjectInfo {
  id: string;
  identifier: string;
  name: string;
}

/**
 * 工作项服务 - 封装工作项相关业务逻辑
 */
export class WorkItemService {
  /**
   * 获取工作项详情
   */
  async getWorkItem(workItemId: string): Promise<WorkItemInfo | null> {
    const item = await getWorkItem(workItemId);
    return item ? this.toWorkItemInfo(item) : null;
  }

  /**
   * 批量获取工作项
   */
  async getWorkItems(workItemIds: string[]): Promise<{
    items: Map<string, WorkItemInfo>;
    missingCount: number;
  }> {
    const { items, missingCount } = await getWorkItemsBatch(workItemIds);

    const result = new Map<string, WorkItemInfo>();
    for (const [id, item] of items) {
      result.set(id, this.toWorkItemInfo(item));
    }

    return { items: result, missingCount };
  }

  /**
   * 从工时记录中提取并获取所有关联的工作项
   */
  async enrichWorkloadsWithWorkItems(
    workloads: PingCodeWorkload[]
  ): Promise<{
    workItems: Map<string, WorkItemInfo>;
    missingCount: number;
  }> {
    const { items, missingCount } = await getWorkItemsFromWorkloads(workloads);

    const result = new Map<string, WorkItemInfo>();
    for (const [id, item] of items) {
      result.set(id, this.toWorkItemInfo(item));
    }

    return { workItems: result, missingCount };
  }

  /**
   * 从工作项中提取项目信息
   */
  extractProjects(workItems: Map<string, WorkItemInfo>): Map<string, ProjectInfo> {
    const projects = new Map<string, ProjectInfo>();

    for (const item of workItems.values()) {
      if (item.project && !projects.has(item.project.id)) {
        projects.set(item.project.id, item.project);
      }
    }

    return projects;
  }

  /**
   * 转换为 WorkItemInfo 格式
   */
  private toWorkItemInfo(item: PingCodeWorkItem): WorkItemInfo {
    return {
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      project: {
        id: item.project.id,
        identifier: item.project.identifier,
        name: item.project.name,
        type: item.project.type,
      },
      state: item.state,
      type: item.type,
      assignee: item.assignee ? {
        id: item.assignee.id,
        name: item.assignee.name,
        display_name: item.assignee.display_name,
      } : undefined,
    };
  }
}

// Singleton instance
export const workItemService = new WorkItemService();
