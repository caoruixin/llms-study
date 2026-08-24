import { useAuthStore } from '../../auth/authStore'
import { PAPER_DB_NAME, getPaperDb, type PaperDb } from './db'
import type { PaperRepository } from './paperRepo'
import type { CopilotRepository } from './copilotRepo'
import type { LearnerRepository } from './learnerRepo'
import { createTranslationRepository, type TranslationRepository } from './translationRepo'
import {
  createSyncedCopilotRepository,
  createSyncedLearnerRepository,
  createSyncedPaperRepository,
} from './syncedRepos'

/**
 * 仓储单例工厂（P4）：对外返回**引用永不变**的门面对象，方法体内在每次调用时
 * 解析「当前活跃 DB」（游客库或账号库）再委托——组件里的
 * `useMemo(() => getRepos().paper, [])` 因此不需要任何依赖，账号登录/登出/切换
 * 都不重挂组件，写入却始终路由到正确的库。
 *
 * 入队条件（shouldQueue）也在调用时判定：写账号库且已登录才镜像进 outbox。
 */

export interface Repos {
  paper: PaperRepository
  copilot: CopilotRepository
  learner: LearnerRepository
  translation: TranslationRepository
}

interface Bundle {
  paper: PaperRepository
  copilot: CopilotRepository
  learner: LearnerRepository
  translation: TranslationRepository
}

/** 每个库一套装饰后的仓储：按库名缓存，避免每次调用重建装饰器对象 */
const bundles = new Map<string, Bundle>()

function bundleFor(db: PaperDb): Bundle {
  let b = bundles.get(db.name)
  if (!b) {
    const deps = {
      // 游客库永不入队：游客写入没有归属账号，推送只会 401 空转
      shouldQueue: () => db.name !== PAPER_DB_NAME && useAuthStore.getState().status === 'authed',
    }
    b = {
      paper: createSyncedPaperRepository(db, deps),
      copilot: createSyncedCopilotRepository(db, deps),
      learner: createSyncedLearnerRepository(db, deps),
      // 译文 V1 不入 outbox（可再生派生物，不占同步配额），挂裸实现即可
      translation: createTranslationRepository(db),
    }
    bundles.set(db.name, b)
  }
  return b
}

/**
 * 门面：Proxy 在**属性访问时**返回一个「先解析活跃库、再委托」的函数。
 * 方法在真实 bundle 对象上调用（select(...)[prop](...)），`this` 绑定正确
 * （copilotRepo 内部有 this.getBrief 之类的自引用）。
 */
function makeFacade<T extends object>(select: (b: Bundle) => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      return (...args: unknown[]) => {
        const repo = select(bundleFor(getPaperDb()))
        const fn = repo[prop as keyof T]
        if (typeof fn !== 'function') throw new Error(`repo 门面：未知方法 ${String(prop)}`)
        return (fn as (...a: unknown[]) => unknown).apply(repo, args)
      }
    },
  })
}

const repos: Repos = {
  paper: makeFacade((b) => b.paper),
  copilot: makeFacade((b) => b.copilot),
  learner: makeFacade((b) => b.learner),
  translation: makeFacade((b) => b.translation),
}

/** 稳定引用：任何时刻返回同一组门面对象，可安全作为 hook 依赖 */
export function getRepos(): Repos {
  return repos
}
