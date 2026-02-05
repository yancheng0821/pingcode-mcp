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

export interface PingCodeWorkload {
  id: string;
  project: PingCodeProject;
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
