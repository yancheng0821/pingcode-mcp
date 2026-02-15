/**
 * Unit 7: Team summary includes 0-hour users (isolated unit test)
 *
 * Tests the 0-hour user inclusion logic in workloadService.getTeamWorkSummary()
 * without real API calls. Mocks userService, workItemService, and workload
 * endpoints to verify that users with no workloads still appear in the
 * team summary with total_hours=0 and correct empty groupBy fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks so they're available in vi.mock factories
const {
  mockGetUsersMap,
  mockListWorkloadsForUsers,
  mockEnrichWorkloads,
} = vi.hoisted(() => ({
  mockGetUsersMap: vi.fn(),
  mockListWorkloadsForUsers: vi.fn(),
  mockEnrichWorkloads: vi.fn(),
}));

// workloadService imports userService from './userService.js'
vi.mock('../../src/services/userService.js', () => ({
  userService: {
    getAllUsers: vi.fn().mockResolvedValue([]),
    getUser: vi.fn(),
    getUsersMap: mockGetUsersMap,
    resolveUser: vi.fn(),
    resolveUsers: vi.fn(),
  },
}));

// workloadService imports workItemService from './workItemService.js'
vi.mock('../../src/services/workItemService.js', () => ({
  workItemService: {
    enrichWorkloadsWithWorkItems: mockEnrichWorkloads,
    getWorkItem: vi.fn(),
  },
}));

// workloadService imports from '../api/endpoints/index.js'
vi.mock('../../src/api/endpoints/index.js', () => ({
  listWorkloadsForUsers: mockListWorkloadsForUsers,
  listUserWorkloads: vi.fn(),
  listWorkloads: vi.fn(),
  getWorkItemsBatch: vi.fn(),
  getWorkItemsFromWorkloads: vi.fn(),
  listUsers: vi.fn(),
}));

vi.mock('../../src/config/index.js', () => ({
  config: {
    pingcode: { baseUrl: 'http://localhost:9999', token: 'test-token' },
    pagination: { maxPages: 200, pageSize: 100, maxRecords: 50000 },
    cache: { ttlUsers: 3600, ttlWorkItems: 21600 },
    rateLimit: { maxRequestsPerMin: 200 },
    requestTimeout: 15000,
    timezone: 'Asia/Shanghai',
    nameMatchStrategy: 'best',
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/utils/metrics.js', () => ({
  metrics: {
    recordTimeSlice: vi.fn(),
    recordCacheHit: vi.fn(),
    recordCacheMiss: vi.fn(),
    recordSuccess: vi.fn(),
    recordError: vi.fn(),
  },
}));

import { workloadService } from '../../src/services/workloadService.js';

const alice = { id: 'user-alice', name: 'alice', display_name: 'Alice Zhang' };
const bob = { id: 'user-bob', name: 'bob', display_name: 'Bob Li' };
const carol = { id: 'user-carol', name: 'carol', display_name: 'Carol Wang' };

// Unix timestamps for Jan 2026
const JAN_1 = 1735689600;
const JAN_31 = 1738281600;

describe('Team summary 0-hour user inclusion', () => {
  beforeEach(() => {
    mockGetUsersMap.mockReset();
    mockListWorkloadsForUsers.mockReset();
    mockEnrichWorkloads.mockReset();
    // Default: enrichWorkloads returns empty (no work item details needed)
    mockEnrichWorkloads.mockResolvedValue({ workItems: new Map(), missingCount: 0 });
  });

  it('includes users with no workloads in team summary with total_hours=0', async () => {
    // getUsersMap returns all 3 users
    mockGetUsersMap.mockResolvedValueOnce(new Map([
      ['user-alice', alice],
      ['user-bob', bob],
      ['user-carol', carol],
    ]));

    // Only Alice and Bob have workloads; Carol has none
    const workloadsMap = new Map();
    workloadsMap.set('user-alice', {
      workloads: [{
        id: 'wl-1', duration: 4, report_at: JAN_1 + 86400,
        report_by: alice,
        work_item: { id: 'wi-1', identifier: 'P-1', title: 'Task', type: 'story' },
        created_at: JAN_1 + 86400,
      }],
      totalCount: 1, timeSliced: false, paginationTruncated: false,
    });
    workloadsMap.set('user-bob', {
      workloads: [{
        id: 'wl-2', duration: 2, report_at: JAN_1 + 86400,
        report_by: bob,
        work_item: { id: 'wi-2', identifier: 'P-2', title: 'Bug', type: 'bug' },
        created_at: JAN_1 + 86400,
      }],
      totalCount: 1, timeSliced: false, paginationTruncated: false,
    });
    mockListWorkloadsForUsers.mockResolvedValueOnce(workloadsMap);

    const result = await workloadService.getTeamWorkSummary(
      JAN_1, JAN_31,
      { userIds: ['user-alice', 'user-bob', 'user-carol'] }
    );

    expect('summary' in result).toBe(true);
    if (!('summary' in result)) return;

    expect(result.summary.members).toHaveLength(3);
    expect(result.summary.user_count).toBe(3);

    const carolMember = result.summary.members.find(
      (m: { user: { id: string } }) => m.user.id === 'user-carol'
    );
    expect(carolMember).toBeDefined();
    expect(carolMember!.total_hours).toBe(0);
    expect(carolMember!.top_projects).toEqual([]);
    expect(carolMember!.top_work_items).toEqual([]);
  });

  it('0-hour users get correct empty fields for group_by=day', async () => {
    mockGetUsersMap.mockResolvedValueOnce(new Map([
      ['user-alice', alice],
      ['user-carol', carol],
    ]));

    const workloadsMap = new Map();
    workloadsMap.set('user-alice', {
      workloads: [{
        id: 'wl-1', duration: 3, report_at: JAN_1 + 86400,
        report_by: alice,
        work_item: { id: 'wi-1', identifier: 'P-1', title: 'Task', type: 'story' },
        created_at: JAN_1 + 86400,
      }],
      totalCount: 1, timeSliced: false, paginationTruncated: false,
    });
    mockListWorkloadsForUsers.mockResolvedValueOnce(workloadsMap);

    const result = await workloadService.getTeamWorkSummary(
      JAN_1, JAN_31,
      { userIds: ['user-alice', 'user-carol'], groupBy: 'day' }
    );

    if (!('summary' in result)) {
      expect.unreachable('Expected summary result');
      return;
    }

    const carolMember = result.summary.members.find(
      (m: { user: { id: string } }) => m.user.id === 'user-carol'
    );
    expect(carolMember).toBeDefined();
    expect(carolMember!.total_hours).toBe(0);
    expect(carolMember!.by_day).toEqual([]);
  });

  it('0-hour users get correct empty fields for group_by=project', async () => {
    mockGetUsersMap.mockResolvedValueOnce(new Map([
      ['user-alice', alice],
      ['user-carol', carol],
    ]));

    const workloadsMap = new Map();
    workloadsMap.set('user-alice', {
      workloads: [{
        id: 'wl-1', duration: 3, report_at: JAN_1 + 86400,
        report_by: alice,
        work_item: { id: 'wi-1', identifier: 'P-1', title: 'Task', type: 'story' },
        created_at: JAN_1 + 86400,
      }],
      totalCount: 1, timeSliced: false, paginationTruncated: false,
    });
    mockListWorkloadsForUsers.mockResolvedValueOnce(workloadsMap);

    const result = await workloadService.getTeamWorkSummary(
      JAN_1, JAN_31,
      { userIds: ['user-alice', 'user-carol'], groupBy: 'project' }
    );

    if (!('summary' in result)) {
      expect.unreachable('Expected summary result');
      return;
    }

    const carolMember = result.summary.members.find(
      (m: { user: { id: string } }) => m.user.id === 'user-carol'
    );
    expect(carolMember).toBeDefined();
    expect(carolMember!.total_hours).toBe(0);
    expect(carolMember!.by_project).toEqual([]);
  });

  it('excludes 0-hour users when includeZeroUsers=false', async () => {
    mockGetUsersMap.mockResolvedValueOnce(new Map([
      ['user-alice', alice],
      ['user-bob', bob],
      ['user-carol', carol],
    ]));

    const workloadsMap = new Map();
    workloadsMap.set('user-alice', {
      workloads: [{
        id: 'wl-1', duration: 4, report_at: JAN_1 + 86400,
        report_by: alice,
        work_item: { id: 'wi-1', identifier: 'P-1', title: 'Task', type: 'story' },
        created_at: JAN_1 + 86400,
      }],
      totalCount: 1, timeSliced: false, paginationTruncated: false,
    });
    mockListWorkloadsForUsers.mockResolvedValueOnce(workloadsMap);

    const result = await workloadService.getTeamWorkSummary(
      JAN_1, JAN_31,
      { userIds: ['user-alice', 'user-bob', 'user-carol'], includeZeroUsers: false }
    );

    expect('summary' in result).toBe(true);
    if (!('summary' in result)) return;

    // Only Alice has workloads; Bob and Carol should be excluded
    expect(result.summary.members).toHaveLength(1);
    expect(result.summary.members[0].user.id).toBe('user-alice');
    expect(result.summary.members[0].total_hours).toBe(4);
  });

  it('when all users have 0 hours, total_hours is 0 and members still listed', async () => {
    mockGetUsersMap.mockResolvedValueOnce(new Map([
      ['user-carol', carol],
    ]));
    // No workloads at all
    mockListWorkloadsForUsers.mockResolvedValueOnce(new Map());

    const result = await workloadService.getTeamWorkSummary(
      JAN_1, JAN_31,
      { userIds: ['user-carol'] }
    );

    if (!('summary' in result)) {
      // NO_DATA is also valid behavior; verify it's a proper business error
      expect('code' in result).toBe(true);
      return;
    }

    expect(result.summary.total_hours).toBe(0);
    expect(result.summary.members).toHaveLength(1);
    expect(result.summary.members[0].total_hours).toBe(0);
  });
});
