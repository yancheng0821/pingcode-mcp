import type { PingCodeUser, PingCodeWorkload, PingCodeWorkItem, PingCodeProject } from '../api/types.js';

/**
 * Mock 用户数据
 */
export const mockUsers: PingCodeUser[] = [
  {
    id: 'user-001',
    name: 'zhangsan',
    display_name: '张三',
    email: 'zhangsan@example.com',
    department: '研发部',
    job: '高级工程师',
  },
  {
    id: 'user-002',
    name: 'lisi',
    display_name: '李四',
    email: 'lisi@example.com',
    department: '研发部',
    job: '工程师',
  },
  {
    id: 'user-003',
    name: 'wangwu',
    display_name: '王五',
    email: 'wangwu@example.com',
    department: '产品部',
    job: '产品经理',
  },
  {
    id: 'user-004',
    name: 'zhaoliu',
    display_name: '赵六',
    email: 'zhaoliu@example.com',
    department: '研发部',
    job: '工程师',
  },
  {
    id: 'user-005',
    name: 'sunqi',
    display_name: '孙七',
    email: 'sunqi@example.com',
    department: '测试部',
    job: '测试工程师',
  },
];

/**
 * Mock 项目数据
 */
export const mockProjects: PingCodeProject[] = [
  {
    id: 'proj-001',
    identifier: 'PRJ-A',
    name: '用户中心重构',
    type: 'scrum',
  },
  {
    id: 'proj-002',
    identifier: 'PRJ-B',
    name: 'API 网关开发',
    type: 'scrum',
  },
  {
    id: 'proj-003',
    identifier: 'PRJ-C',
    name: '移动端 App',
    type: 'kanban',
  },
];

/**
 * Mock 工作项数据
 */
export const mockWorkItems: PingCodeWorkItem[] = [
  {
    id: 'wi-001',
    identifier: 'PRJ-A-101',
    title: '用户登录模块重构',
    project: mockProjects[0],
    state: '进行中',
    type: '需求',
  },
  {
    id: 'wi-002',
    identifier: 'PRJ-A-102',
    title: '用户权限系统设计',
    project: mockProjects[0],
    state: '已完成',
    type: '需求',
  },
  {
    id: 'wi-003',
    identifier: 'PRJ-A-103',
    title: '修复登录页面样式问题',
    project: mockProjects[0],
    state: '已完成',
    type: '缺陷',
  },
  {
    id: 'wi-004',
    identifier: 'PRJ-B-201',
    title: 'API 限流功能开发',
    project: mockProjects[1],
    state: '进行中',
    type: '需求',
  },
  {
    id: 'wi-005',
    identifier: 'PRJ-B-202',
    title: 'API 文档编写',
    project: mockProjects[1],
    state: '待开始',
    type: '任务',
  },
  {
    id: 'wi-006',
    identifier: 'PRJ-C-301',
    title: 'iOS 首页改版',
    project: mockProjects[2],
    state: '进行中',
    type: '需求',
  },
  {
    id: 'wi-007',
    identifier: 'PRJ-C-302',
    title: 'Android 性能优化',
    project: mockProjects[2],
    state: '进行中',
    type: '任务',
  },
];

/**
 * 生成 Mock 工时数据
 */
export function generateMockWorkloads(
  userId: string,
  startAt: number,
  endAt: number
): PingCodeWorkload[] {
  const workloads: PingCodeWorkload[] = [];
  const userIndex = mockUsers.findIndex(u => u.id === userId);

  // 每天生成 1-3 条工时记录
  const dayMs = 24 * 60 * 60 * 1000;
  const startDate = new Date(startAt * 1000);
  const endDate = new Date(endAt * 1000);

  let currentDate = new Date(startDate);
  let workloadId = 1;

  while (currentDate < endDate) {
    // 跳过周末
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // 每天 1-3 条工时
      const recordsPerDay = 1 + Math.floor(Math.random() * 3);

      for (let i = 0; i < recordsPerDay; i++) {
        // 随机选择工作项
        const workItemIndex = (userIndex + workloadId) % mockWorkItems.length;
        const workItem = mockWorkItems[workItemIndex];

        // 随机工时 1-4 小时
        const hours = 1 + Math.floor(Math.random() * 4);

        workloads.push({
          id: `wl-${userId}-${workloadId}`,
          user_id: userId,
          work_item_id: workItem.id,
          project_id: workItem.project.id,
          hours,
          date_at: Math.floor(currentDate.getTime() / 1000),
          description: `${workItem.title} - 工时记录`,
          created_at: Math.floor(currentDate.getTime() / 1000),
          updated_at: Math.floor(currentDate.getTime() / 1000),
        });

        workloadId++;
      }
    }

    currentDate = new Date(currentDate.getTime() + dayMs);
  }

  return workloads;
}

/**
 * 获取 Mock 用户
 */
export function getMockUser(userId: string): PingCodeUser | undefined {
  return mockUsers.find(u => u.id === userId);
}

/**
 * 获取 Mock 工作项
 */
export function getMockWorkItem(workItemId: string): PingCodeWorkItem | undefined {
  return mockWorkItems.find(w => w.id === workItemId);
}
