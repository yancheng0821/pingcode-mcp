// PingCode API Response Types

export interface PingCodeUser {
  id: string;
  name: string;
  display_name: string;
  email?: string;
  department?: string;
  job?: string;
}

export interface PingCodeWorkloadWorkItem {
  id: string;
  identifier: string;
  title: string;
  type?: string;
}

/**
 * /v1/workloads API 原始响应格式
 */
export interface RawPingCodeWorkload {
  id: string;
  principal_type: 'work_item' | 'idea' | 'test_case';
  principal?: {
    id: string;
    identifier: string;
    title: string;
    type?: string;
  };
  type?: {
    id: string;
    name: string;
  };
  duration: number;
  review_state?: string;
  description?: string;
  report_at: number;
  report_by: {
    id: string;
    name: string;
    display_name: string;
  };
  created_at: number;
  created_by?: {
    id: string;
    name: string;
    display_name: string;
  };
}

/**
 * 标准化后的工时记录
 */
export interface PingCodeWorkload {
  id: string;
  project?: PingCodeProject;
  work_item?: PingCodeWorkloadWorkItem;
  duration: number;       // hours
  description?: string;
  report_at: number;      // Unix timestamp (seconds)
  report_by: {
    id: string;
    name: string;
    display_name: string;
  };
  type?: string;
  created_at: number;
}

export interface PingCodeProject {
  id: string;
  identifier: string;
  name: string;
  type?: string;
}

export interface PingCodeWorkItem {
  id: string;
  identifier: string;
  title: string;
  project: PingCodeProject;
  assignee?: PingCodeUser;
  state?: string;
  type?: string;
}

export interface PaginatedResponse<T> {
  values: T[];
  total: number;
  page_index: number;
  page_size: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
