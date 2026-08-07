import { Component } from 'react'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 路由级错误边界（必须是 class 组件：函数组件无法捕获 render 期错误）。
 * 每个 Route 各包一层：数据漂移触发的 render 期 throw（如 kda.ts 的 fail-loud 校验）
 * 只废掉当前页面，导航与其余页面照常可用。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-xl rounded-xl border border-bad/40 bg-panel shadow-sm p-6">
          <h2 className="mb-2 font-semibold text-bad">该模块加载失败</h2>
          <p className="mb-4 break-all text-sm leading-relaxed text-dim">
            {this.state.error.message || String(this.state.error)}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg border border-line bg-panel-2 px-4 py-2 text-sm font-medium transition-colors hover:bg-panel"
          >
            刷新
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
