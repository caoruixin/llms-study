/**
 * 渲染服务自己的 env 解析——**刻意不复用 ../config.ts 的 loadConfig()**。
 *
 * loadConfig() 要求 LLM_KEY_MASTER,而这个进程跑的是不可信网页:它以独立用户(llmrender)、
 * 独立 env 文件(/etc/llms-study/render.env,无任何机密)运行,进程环境里**不该出现**主密钥,
 * 也不该碰 DB。所以这里只读渲染服务用得到的三个变量,同样 fail-fast:配置错了宁可起不来
 * (systemd StartLimitBurst 之后 unit 进 failed,API 那边如实回 503),不要带病服务。
 *
 * 同理,入口(index.ts)不加载 server/.env——那是 API 的 env 文件,里面有主密钥与上游 key,
 * 读进来就会被 Chromium 子进程一并继承。本地开发请在命令行上内联传这几个变量。
 */
import path from 'node:path'

export interface RenderConfig {
  /** 监听的 unix socket 路径(只听 socket,不开 TCP 端口);生产 = /run/llms-study-render/render.sock */
  socketPath: string
  /**
   * Chrome 可执行文件的**显式**路径。不让 playwright 自己找/自己下:
   * 线上跑哪个二进制必须是运维看得见、包管理器管得到的那一个(能跟着 dnf 拿安全更新)。
   */
  chromePath: string
  /**
   * 【仅本机开发】容忍 fake-IP DNS,与 API 的 FETCH_URL_ALLOW_FORBIDDEN_DEV 同源、但**收得更紧**。
   *
   * fake-IP 模式的代理(Surge/Clash 等)把所有公网域名解析进 198.18/15,不开它 safeFetchHop 会把
   * 每一个子请求都判成内网、本机什么都渲染不出来。开了之后只有"解析到 198.18/15"这一种情况被放行
   * (devLookup.ts);`localhost`、解析到 127.0.0.1/192.168.x 的域名、字面 IP 的 URL 照样被拒,
   * 端口/协议/限额等其余防线全部保留——渲染服务跑的是不可信页面里的任意脚本,
   * 开发机上同样不该让它们够得着本机服务。
   *
   * !!! 生产严禁配置 !!! 198.18/15 在公网不可路由,但在云上的 VPC 里未必没人用;
   * 生产的 DNS 也不会返回这个网段,开它有害无益。为防手滑,检测到 systemd 环境
   * (INVOCATION_ID)时直接拒绝启动。
   */
  allowForbiddenDev: boolean
}

/** 与 ../config.ts 的 parseBool 同语义;不 import 它——那个模块的入口函数不该出现在本进程的依赖图里 */
function parseBool(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new Error(`${name} 只接受 true/false/1/0,得到:${raw}`)
}

function requireAbsolutePath(name: string, raw: string | undefined): string {
  if (!raw) throw new Error(`${name} 必填`)
  // 相对路径会随 cwd 漂移:systemd 的 WorkingDirectory 一改,socket 就建到了 API 找不到的地方
  if (!path.isAbsolute(raw)) throw new Error(`${name} 必须是绝对路径,得到:${raw}`)
  return raw
}

export function loadRenderConfig(env: Record<string, string | undefined> = process.env): RenderConfig {
  const socketPath = requireAbsolutePath('RENDER_SOCKET_PATH', env.RENDER_SOCKET_PATH)
  const chromePath = requireAbsolutePath('RENDER_CHROME_PATH', env.RENDER_CHROME_PATH)
  const allowForbiddenDev = parseBool('RENDER_ALLOW_FORBIDDEN_DEV', env.RENDER_ALLOW_FORBIDDEN_DEV)

  // systemd 给它拉起的每个服务进程都注入 INVOCATION_ID。开发逃生口 + systemd = 有人把 dev 的
  // env 抄进了 render.env:拒绝启动比"文档里写了别这么干"可靠
  if (allowForbiddenDev && env.INVOCATION_ID) {
    throw new Error(
      'RENDER_ALLOW_FORBIDDEN_DEV 只允许本机开发使用;检测到 systemd 环境(INVOCATION_ID),拒绝启动。' +
        '请从 render.env 里删掉这一行',
    )
  }

  return { socketPath, chromePath, allowForbiddenDev }
}
