import { useState } from 'react'
import { AGENT_ELEMENTS, AGENT_PITFALLS, FC_LOOP, GRAPH_NODES } from '../data/agent'

function Box({ title, sub, tone = 'default' }: { title: string; sub?: string; tone?: 'default' | 'accent' | 'ok' | 'warn' | 'model' }) {
  const border =
    tone === 'accent'
      ? 'border-accent/60 bg-accent/10'
      : tone === 'ok'
        ? 'border-ok/50 bg-ok/10'
        : tone === 'warn'
          ? 'border-warn/50 bg-warn/10'
          : tone === 'model'
            ? 'border-accent-2/60 bg-accent-2/10'
            : 'border-line bg-panel-2'
  return (
    <div className={`rounded-lg border px-3 py-2 text-center ${border}`}>
      <div className="text-sm font-medium">{title}</div>
      {sub && <div className="text-[11px] text-dim">{sub}</div>}
    </div>
  )
}

const V = () => <div className="text-center text-dim">↓</div>

export default function AgentPage() {
  const [sel, setSel] = useState('tools')
  const el = AGENT_ELEMENTS.find((e) => e.id === sel)!

  return (
    <div className="space-y-8">
      {/* 五要素蓝图 */}
      <section>
        <h2 className="mb-3 text-lg font-bold">Agent 架构五要素</h2>
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="grid flex-1 grid-cols-2 gap-2 md:grid-cols-5">
            {AGENT_ELEMENTS.map((e) => (
              <button
                key={e.id}
                onClick={() => setSel(e.id)}
                className={`rounded-xl border px-3 py-4 text-sm font-medium transition-colors ${
                  sel === e.id ? 'border-accent bg-accent/15 text-accent' : 'border-line bg-panel hover:border-accent/40'
                }`}
              >
                {e.name}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-line bg-panel shadow-sm p-5">
          <h3 className="font-bold text-accent">{el.name}</h3>
          <p className="mt-2 text-sm leading-relaxed">{el.what}</p>
          <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm leading-relaxed">
            <span className="text-xs font-semibold text-warn">售前一句话：</span>
            {el.interview}
          </div>
        </div>
      </section>

      {/* RAG + Agent 混合架构图 */}
      <section>
        <h2 className="mb-1 text-lg font-bold">RAG + Agent 混合架构</h2>
        <p className="mb-3 text-sm text-dim">
          一句话定位：RAG 解决「知识从哪来」，Agent 解决「任务怎么完成」；混合架构 = Agent 循环中把检索当工具按需调用（agentic RAG）。
        </p>
        <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
          <div className="mx-auto max-w-3xl">
            <Box title="用户请求" tone="accent" />
            <V />
            <div className="rounded-xl border-2 border-dim/50 p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs font-semibold">
                <span>Agent =</span>
                <span className="rounded bg-accent-2/20 px-1.5 py-0.5 text-accent-2">基础模型（LLM）</span>
                <span>+</span>
                <span className="rounded border border-line bg-panel-2 px-1.5 py-0.5 text-dim">Harness（运行时脚手架）</span>
              </div>
              <div className="mb-2 mt-1 text-center text-[11px] text-dim">紫色框 = 模型职责；其余组件均在应用侧（Harness）</div>
              <Box title="入口 / 路由" sub="鉴权 · 会话加载 · 简单问题直答分流" />
              <V />
              <div className="rounded-xl border-2 border-dashed border-dim/40 p-3 sm:p-4">
                <div className="mb-2 text-center text-xs font-semibold text-dim">Agent 循环（Harness 编排 · 直到任务完成）</div>
                <div className="mx-auto max-w-sm">
                  <Box title="基础模型（LLM）" sub="每轮：读上下文 → 推理规划 → 提议 tool_call 或产出回答" tone="model" />
                </div>
                <div className="my-1.5 flex flex-wrap justify-center gap-x-4 gap-y-0.5 text-center text-[11px] text-dim">
                  <span>↓ 提议（tool_call / 最终回答）</span>
                  <span>↑ 上下文组装 · 观察回填</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Box title="规划" sub="拆解 · 更新计划" tone="model" />
                  <Box title="工具调用" sub="模型提议 → Harness 执行" />
                  <Box title="观察" sub="结果回填 · 校验 · 反思" />
                </div>
                <div className="my-2 text-center text-xs text-dim">工具层（Harness 执行 · 按需调用）↓</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Box title="检索工具（RAG 管线）" sub="查询改写 → 向量召回 → 重排 → 注入" tone="ok" />
                  <Box title="业务 API" sub="查订单 / 下工单（鉴权+幂等）" />
                  <Box title="代码执行" sub="计算 / 数据分析（沙箱）" />
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Box title="记忆层" sub="会话 scratchpad / 用户画像 / 知识库写回" tone="warn" />
                <Box title="观测与评估" sub="全链路 tracing · 任务级成功率" tone="warn" />
              </div>
            </div>
            <V />
            <Box title="生成回答 + 引用溯源" sub="toB 场景 citations 几乎是硬需求" tone="accent" />
          </div>
        </div>
      </section>

      {/* 两个编排流程图 */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
          <h3 className="mb-3 font-bold">编排流程 ①：Function Calling 循环</h3>
          <div className="space-y-2">
            {FC_LOOP.map((s) => (
              <div key={s.step} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg bg-panel-2 px-3 py-2 text-sm">
                <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${s.actor === 'model' ? 'bg-accent-2/20 text-accent-2' : 'bg-accent/20 text-accent'}`}>
                  {s.actor === 'model' ? '模型' : '应用'}
                </span>
                <span className="font-medium">{s.step}</span>
                <span className="basis-full text-dim sm:basis-auto">{s.desc}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-dim">
            关键认知：模型从不执行工具，只生成调用请求；②→⑤ 循环的 token 消耗随步数放大，前缀缓存在这里最值钱。
          </p>
        </div>

        <div className="rounded-xl border border-line bg-panel shadow-sm p-5">
          <h3 className="mb-3 font-bold">编排流程 ②：LangGraph 式状态机</h3>
          <div className="space-y-2">
            {GRAPH_NODES.map((n) => (
              <div key={n.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg bg-panel-2 px-3 py-2 text-sm">
                <span className="shrink-0 rounded bg-ok/20 px-2 py-0.5 text-xs font-semibold text-ok">{n.kind === 'edge' ? '条件边' : '节点'}</span>
                <span className="font-medium">{n.name}</span>
                <span className="basis-full text-dim sm:basis-auto">{n.desc}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-dim">
            Plan → Router ⇄ Act → Observe →（条件回到 Router；不可逆操作先过 Human Gate）→ End。状态外置 + checkpoint =
            可回滚、可断点续跑、可审计——对客户讲这三个「可」最有说服力。
          </p>
        </div>
      </section>

      {/* 落地坑清单 */}
      <section>
        <h2 className="mb-3 text-lg font-bold">落地坑清单</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {AGENT_PITFALLS.map((p) => (
            <div key={p.name} className="rounded-xl border border-line bg-panel shadow-sm p-4">
              <div className="mb-1 font-semibold text-bad">⚠ {p.name}</div>
              <p className="text-sm leading-relaxed text-dim">{p.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
