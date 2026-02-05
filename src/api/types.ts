// PingCode API Response Types

export interface PingCodeUser {
  id: string;
  name: string;
  display_name: string;
  email?: string;
  department?: string;
  job?: string;
}

export interface PingCodeWorkload {
  id: string;
  user_id: string;
  work_item_id?: string;
  project_id?: string;
  hours: number;
  date_at: number;        // Unix timestamp (seconds)
  type_id?: string;
  description?: string;
  created_at: number;
  updated_at: number;
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
  data: T[];
  total: number;
  page_index: number;
  page_size: number;
  has_more: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
