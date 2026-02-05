import {
  listUsers,
  getUserById,
  matchUserByName,
  getUsersByIds,
} from '../api/endpoints/users.js';
import type { PingCodeUser } from '../api/types.js';

export interface UserInfo {
  id: string;
  name: string;
  display_name: string;
  email?: string;
  department?: string;
}

export interface UserMatchResult {
  user: UserInfo | null;
  candidates: Array<{
    user: UserInfo;
    matchType: 'exact' | 'contains' | 'fuzzy';
  }>;
  ambiguous: boolean;
}

/**
 * 用户服务 - 封装用户相关业务逻辑
 */
export class UserService {
  /**
   * 获取所有用户
   */
  async getAllUsers(): Promise<UserInfo[]> {
    const users = await listUsers();
    return users.map(this.toUserInfo);
  }

  /**
   * 根据 ID 获取用户
   */
  async getUser(userId: string): Promise<UserInfo | null> {
    const user = await getUserById(userId);
    return user ? this.toUserInfo(user) : null;
  }

  /**
   * 根据姓名匹配用户
   */
  async matchUser(
    name: string,
    strategy?: 'strict' | 'best' | 'prompt'
  ): Promise<UserMatchResult> {
    const result = await matchUserByName(name, strategy);

    return {
      user: result.matched ? this.toUserInfo(result.matched) : null,
      candidates: result.candidates.map(c => ({
        user: this.toUserInfo(c.user),
        matchType: c.matchType,
      })),
      ambiguous: result.ambiguous,
    };
  }

  /**
   * 解析用户输入（支持 ID 或姓名）
   */
  async resolveUser(input: { id?: string; name?: string }): Promise<UserMatchResult> {
    if (input.id) {
      const user = await this.getUser(input.id);
      return {
        user,
        candidates: user ? [{ user, matchType: 'exact' }] : [],
        ambiguous: false,
      };
    }

    if (input.name) {
      return this.matchUser(input.name);
    }

    return {
      user: null,
      candidates: [],
      ambiguous: false,
    };
  }

  /**
   * 批量获取用户信息
   */
  async getUsersMap(userIds: string[]): Promise<Map<string, UserInfo>> {
    const users = await getUsersByIds(userIds);
    const result = new Map<string, UserInfo>();

    for (const [id, user] of users) {
      result.set(id, this.toUserInfo(user));
    }

    return result;
  }

  /**
   * 转换为 UserInfo 格式
   */
  private toUserInfo(user: PingCodeUser): UserInfo {
    return {
      id: user.id,
      name: user.name,
      display_name: user.display_name,
      email: user.email,
      department: user.department,
    };
  }
}

// Singleton instance
export const userService = new UserService();
