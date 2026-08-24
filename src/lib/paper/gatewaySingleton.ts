import { createModelGateway, type ModelGateway } from './modelGateway'
import { getRepos } from './repo/repos'

/**
 * Paper 模型网关的模块级单例。
 * 令牌桶参数与生产 nginx 同参（6 次/分钟、burst 3）——翻译、对话、论文地图必须
 * 共享**同一个**桶与熔断器，各自新建 gateway 会让合成流量绕过客户端排队直接撞 429。
 * 依赖走 getRepos() 门面（引用永不变，调用时解析活跃库），账号切换无需重建单例。
 */

let gateway: ModelGateway | null = null

export function getPaperGateway(): ModelGateway {
  gateway ??= createModelGateway({
    hasConsent: async (p) => (await getRepos().copilot.getConsent(p))?.granted === true,
    // addUsage 返回落库行（同步装饰器用），gateway 只要 void：显式吞掉返回值
    recordUsage: async (d) => {
      await getRepos().copilot.addUsage(d)
    },
  })
  return gateway
}
