import { WEIGHT_REVISIONS } from './architectureRevisions'
import { MODELS } from './models'
import { TERMS } from './architectureTerms'
import { ARCHITECTURE_AXES, type ArchitectureChange, type ArchitectureModel, type AxisId, type BenchmarkEvidence, type MechanismId, type SourceRef, type TermId } from './architectureTypes'

export const CATALOG_VERSION = '2026-09-12.1'
export const CATALOG_VERIFIED_ON = '2026-09-12'
const hf = (repo: string) => `https://huggingface.co/${repo}`
const source = (url: string, title = 'Official model card', locator = 'Architecture / Model Overview / Evaluation Results', id = 'card'): SourceRef => ({ id, url, title, locator, verifiedOn: CATALOG_VERIFIED_ON })
function change(axis: AxisId, label: string, explanation: string, implication: string, terms: TermId[] = [], sourceIds = ['card']): ArchitectureChange {
  return { axis, label, explanation, implication, terms, sourceIds, disclosed: true }
}
const axes = (items: ArchitectureChange[]): ArchitectureChange[] => ARCHITECTURE_AXES.map(a => items.find(c => c.axis === a.id) ?? { axis: a.id, label: 'Not disclosed', explanation: '本次核验的官方资料未明确披露此项。', implication: '不根据同族名称推断配置。', terms: [], sourceIds: [], disclosed: false })
const dense = (label = 'Dense FFN') => change('ffn', label, '每 token 执行完整 Dense FFN。', '权重存储与激活计算规模接近。')
const rope = () => change('position', 'RoPE', '以旋转形式编码 Q/K 的位置信息。', '长上下文范围仍以各 checkpoint 的配置和验证为准。', ['rope'])
const rms = () => change('residual', 'Pre-Norm · RMSNorm', '在子层输入做 RMSNorm，并保留 residual connection。', '沿深度传播表征；不代表跨层共享 KV。')
const decoder = (description = 'Causal Decoder-only Transformer') => change('topology', 'Decoder-only', description, 'Prefill 与 Decode 复用同一主干，计算组织方式不同。')
const input = (vision = false) => change('input', vision ? 'Token Embedding + Vision Encoder' : 'Token Embedding', vision ? '视觉编码器将图像转换为模型可处理的表征。' : 'Token ID 查表得到输入表征。', 'Embedding 参数与每请求 KV Cache 分别记账。')
const mtp = (text = 'MTP 训练目标；推理是否启用草稿头取决于 Runtime。') => change('decoding', 'MTP · Multi-token Prediction', text, '区分训练时的预测目标与推理时的 draft / verify 加速。', ['mtp'])
const evidence = (id: string, metric: string, value: number, unit: string, baseline: string, conditions: string, kind: BenchmarkEvidence['kind'] = 'model', baselineValue?: number, sourceId = 'card'): BenchmarkEvidence => ({ id, metric, value, unit, baseline, conditions, kind, baselineValue, sourceId, locator: `${metric} · Architecture / benchmark table` })
const topology = (items: [string, string, TermId?][]): ArchitectureModel['topology'] => items.map(([label, detail, term]) => ({ label, detail, term }))
const defaultTopology = (mechanisms: MechanismId[], moe: boolean): ArchitectureModel['topology'] => topology([
  ['Embedding', 'Token ID → hidden state'],
  [mechanisms.map(m => TERMS[m].short).join(' + ') || 'Attention', 'Causal sequence mixing', mechanisms[0]],
  [moe ? 'MoE' : 'FFN', moe ? 'Sparse expert routing' : 'Dense feed-forward', moe ? 'moe' : undefined],
  ['Residual → Repeat', '沿 Layer depth 传递表征'], ['LM Head', 'Next-token logits'],
])
const attention = (ids: MechanismId[], detail?: string) => change('attention', ids.map(x => TERMS[x].short).join(' + '), detail ?? ids.map(x => TERMS[x].explanation).join(' '), '区分存储量、主 Attention 读取量和额外状态。', ids)
const moe = (description: string) => change('ffn', 'MoE · Expert Routing', description, 'Active parameters 不等于权重存储规模；还需考虑专家通信。', ['moe'])
const baselineProfiles: Record<string, ArchitectureChange[]> = {
  'llama3-70b': [decoder(), input(), rope(), rms(), attention(['gqa'], '64 Query heads / 8 KV heads；Llama 3 初始版本为 8K context。'), dense('SwiGLU · Dense FFN'), change('decoding', 'Autoregressive LM Head', '单步预测下一 token。', 'Decode 为每个新 token 生成自身 Q/K/V，并追加 K/V。'), change('training', '15T+ training tokens', '官方披露使用超过 15T tokens 预训练。', '评测提升包含训练规模和数据影响。')],
  'deepseek-v3': [decoder(), input(), rope(), rms(), attention(['mla'], '512D KV latent + 64D decoupled RoPE key；61 layers。'), moe('256 routed experts，top-8 + 1 shared expert；671B total / 37B active。'), mtp(), change('training', 'FP8 Mixed Precision', '采用 FP8 混合精度训练及 auxiliary-loss-free load balancing。', '训练精度与推理 KV 精度不是同一字段。')],
  'deepseek-v32': [decoder(), input(), rope(), rms(), attention(['dsa', 'mla'], '在 MLA 上加入 Lightning Indexer，主 Attention 读取 top-2048 历史 token。'), moe('沿用 V3 系列 MoE 配置。'), mtp(), change('training', 'Sparse Attention adaptation', '此记录对应 V3.2-Exp checkpoint，验证稀疏 Attention。', '不将 Exp 与后续正式 V3.2 的评测混用。')],
  'qwen3-235b': [decoder(), input(), rope(), rms(), attention(['gqa'], '64 Q heads / 4 KV heads，94 layers。'), moe('128 experts，top-8；235B total / 22B active。'), change('decoding', 'Thinking / Non-thinking', '同一模型支持不同推理模式。', '模式属于输出行为；不自动意味着 Attention 改变。')],
  'qwen35-397b': [decoder('60-layer hybrid Decoder；3 GDN layers + 1 Gated Attention layer 重复。'), input(true), rope(), rms(), attention(['gdn', 'gqa'], 'GDN 固定递归状态与 full-attention KV 并存。'), moe('512 routed experts，top-10 + 1 shared；397B total / 17B active。'), mtp()],
  'kimi-k2': [decoder(), input(), rope(), rms(), attention(['mla']), moe('384 routed experts，top-8 + 1 shared；1.04T total / 32B active。'), change('training', 'MuonClip', 'Muon + QK clipping 控制训练稳定性。', '优化器收益须结合训练规模与数据评估。')],
  'kimi-k3': [change('topology', 'Hybrid Architecture · 93 layers', '69 KDA + 24 Gated MLA；不推断未披露的逐层排列。', '固定状态池与逐 token KV 池并存。', ['kda', 'mla']), input(true), change('position', 'KDA transition / MLA RoPE', 'KDA 与 MLA 使用不同的序列信息路径。', '不把整模型所有层视为同一位置编码配置。', ['kda', 'rope']), attention(['kda', 'mla']), change('residual', 'AttnRes · Attention Residuals', '沿 Layer depth 选择聚合较早层的表征。', '纵向信息流与 token 时间轴上的 Attention 分开观察。', ['attnres']), moe('Stable LatentMoE：896 routed experts，top-16 + 2 shared；104B active。'), change('training', 'MXFP4 / MXFP8 · QAT', '官方配置为 MXFP4 weights / MXFP8 activations。', '量化感知训练不等同于任意 Runtime 的实际存储布局。')],
  'glm-45': [decoder(), input(), rope(), rms(), attention(['gqa']), moe('355B total / 32B active；ARC：Agentic, Reasoning, Coding。')],
  'glm-5': [decoder(), input(), rope(), rms(), attention(['dsa'], '采用 DeepSeek Sparse Attention 路线。'), moe('744B total / 40B active。'), mtp()],
  'glm-52': [decoder(), input(), rope(), rms(), attention(['dsa'], 'DSA + IndexShare：跨层复用 indexer 相关计算；主 KV 仍需保存。'), moe('HF checkpoint 标注 753B params；backbone / activated 参数未单独披露。'), mtp()],
  'deepseek-v4-pro': [decoder('CSA / HCA 与局部窗口构成混合 Attention 栈。'), input(), rope(), attention(['csa', 'hca', 'swa']), change('residual', 'mHC · Hyper-Connections', '对多条 residual streams 的混合施加流形约束。', '改善深层信号传播；不等同于 token KV 压缩。', ['mhc']), moe('Pro：1.6T / 49B active；Flash：284B / 13B active。'), mtp(), change('training', 'Muon · FP4 + FP8', 'MoE expert weights 使用 FP4，大部分其他参数使用 FP8。', '需要对应精度的推理 kernel；不把训练和缓存字节混算。')],
}
const legacyWeights: Record<string, string> = {
  'llama3-70b': 'meta-llama/Meta-Llama-3-70B', 'deepseek-v3': 'deepseek-ai/DeepSeek-V3', 'deepseek-v32': 'deepseek-ai/DeepSeek-V3.2-Exp', 'deepseek-v4-pro': 'deepseek-ai/DeepSeek-V4-Pro',
  'qwen3-235b': 'Qwen/Qwen3-235B-A22B', 'qwen35-397b': 'Qwen/Qwen3.5-397B-A17B', 'kimi-k2': 'moonshotai/Kimi-K2-Instruct', 'kimi-k3': 'moonshotai/Kimi-K3', 'glm-45': 'zai-org/GLM-4.5', 'glm-5': 'zai-org/GLM-5', 'glm-52': 'zai-org/GLM-5.2',
}
const predecessor: Record<string, string> = { 'deepseek-v32': 'deepseek-v3', 'deepseek-v4-pro': 'deepseek-v32', 'qwen35-397b': 'qwen3-235b', 'kimi-k3': 'kimi-k2', 'glm-5': 'glm-45', 'glm-52': 'glm-5' }
const legacy: ArchitectureModel[] = MODELS.map(m => {
  const changes = axes(baselineProfiles[m.id] ?? [])
  const mechanisms = (changes.find(c => c.axis === 'attention')?.terms ?? []) as MechanismId[]
  const family = m.id.startsWith('deepseek') ? 'DeepSeek' : m.id.startsWith('qwen') ? 'Qwen' : m.id.startsWith('kimi') ? 'Kimi' : m.id.startsWith('glm') ? 'GLM' : 'Llama'
  const result: ArchitectureModel = { id: m.id, legacyModelId: m.id, family, name: m.name, vendor: m.vendor, released: m.asOf, verifiedOn: CATALOG_VERIFIED_ON,
    weightsUrl: hf(legacyWeights[m.id]), license: m.license, parameters: { backboneB: m.totalParamsB, activeB: m.activeParamsB },
    context: m.id === 'llama3-70b' ? '8K' : m.contextK >= 1000 ? '1M' : `${m.contextK}K`, predecessorId: predecessor[m.id], mechanisms,
    summary: changes.filter(c => c.disclosed && ['attention', 'residual', 'ffn'].includes(c.axis)).map(c => c.label).join(' · '), changes, evidence: [], sources: [source(hf(legacyWeights[m.id]))], topology: defaultTopology(mechanisms, m.totalParamsB !== m.activeParamsB),
  }
  if (m.id === 'glm-52') result.parameters = { backboneB: null, activeB: null, note: 'HF checkpoint 标注 753B params；backbone / activated 未单独披露，不沿用 GLM-5 的 40B 作为已核验数字。' }
  if (m.id === 'deepseek-v32') { result.name = 'DeepSeek-V3.2-Exp'; result.released = '2025-09-29'; result.summary = 'MLA + Lightning Indexer：先筛选，再读取；主缓存与索引开销分别记账。' }
  if (m.id === 'llama3-70b') { result.released = '2024-04-18'; result.summary = 'GQA / RoPE / RMSNorm / SwiGLU：现代 Dense Decoder 的历史基线。' }
  if (m.id === 'deepseek-v3') {
    result.license = 'DeepSeek License Agreement v1.0 (weights)'; result.sources.push(source(hf('deepseek-ai/DeepSeek-V3/blob/main/LICENSE-MODEL'), 'Model weights license', 'LICENSE-MODEL; code uses a separate MIT license', 'license'))
    result.summary = 'MLA + MoE + MTP：压缩 KV、稀疏激活专家，并引入多 token 训练目标。'
    result.evidence = [evidence('kv', 'Cached dimensions / token / layer', 576, 'elements', '完整逐头 K/V', '512 latent + 64 RoPE；是架构存储维度，不是整服务显存。', 'architecture')]
  }
  if (m.id === 'deepseek-v4-pro') {
    result.released = '2026-04-24'; result.sources.push(source('https://deepseek.com/en/news/v4-preview/', 'Initial open-weight release', 'News date: April 24, 2026', 'release')); result.name = 'DeepSeek-V4 · Pro / Flash'; result.summary = 'CSA / HCA 压缩时间轴上的历史，mHC 改造深度方向的信息流。'
    result.variants = ['Pro · 1.6T backbone / 49B active', 'Flash · 284B backbone / 13B active']
    result.sources.push(source(hf('deepseek-ai/DeepSeek-V4-Flash'), 'Official Flash model card', 'Introduction / Model Downloads', 'flash'))
    result.evidence = [evidence('kv', 'KV Cache vs V3.2', 10, '% of baseline', 'DeepSeek-V3.2', 'V4-Pro；1M context；官方架构对比，非本站测量。', 'architecture', 100, 'flash'), evidence('flops', 'Single-token inference FLOPs', 27, '% of baseline', 'DeepSeek-V3.2', 'V4-Pro；1M context；不能作为端到端 TPS 比例。', 'architecture', 100, 'flash')]
  }
  if (m.id === 'kimi-k3') {
    result.released = '2026-07-27'; result.license = 'Kimi K3 License'; result.context = '1,048,576 tokens'; result.summary = 'KDA fixed state + Gated MLA KV；AttnRes 沿层深度选择性聚合。'
    result.evidence = [evidence('scaling', 'Overall scaling efficiency', 2.5, '×', 'Kimi K2', 'KDA + AttnRes + Stable LatentMoE 的综合收益；不能单项归因。', 'model')]
    result.topology = topology([['MoonViT-V2 + Embedding', 'Native multimodality'], ['69 KDA + 24 Gated MLA', '固定状态 + 增长的 latent KV', 'kda'], ['AttnRes', '沿深度聚合表征', 'attnres'], ['Stable LatentMoE', '16 / 896 routed + 2 shared', 'moe'], ['LM Head', 'Autoregressive output']])
  }
  return result
})

const fresh = (m: Omit<ArchitectureModel, 'verifiedOn' | 'changes'> & { changes: ArchitectureChange[] }): ArchitectureModel => ({ ...m, verifiedOn: CATALOG_VERIFIED_ON, changes: axes(m.changes) })
const modern: ArchitectureModel[] = [
  fresh({ id: 'deepseek-v41-flash', family: 'DeepSeek', name: 'DeepSeek-V4.1-Flash', vendor: 'DeepSeek', released: '2026-09-10', weightsUrl: hf('deepseek-ai/DeepSeek-V4.1-Flash'), license: 'MIT', predecessorId: 'deepseek-v4-pro',
    parameters: { backboneB: 552, activeB: null, prefillActiveB: 8, decodeActiveB: 16, lookupB: 196, note: '552B 为 backbone；Engram 单独列示，不将不同口径机械相加为完整 checkpoint 参数。' }, context: '1M', mechanisms: ['csa2', 'swa'],
    summary: 'CED + Shared Global KV：把 KV 优化从层内压缩推进到跨层共享，并拆分 Prefill / Decode 的计算路径。',
    changes: [change('topology', 'CED · Causal Encoder-Decoder', '20-layer causal encoder + 20-layer decoder；Encoder 最终状态生成 Decoder 共享的 Global KV。', 'Prefill 8B active / Decode 16B active，阶段计算预算分别观察。', ['ced', 'kv-sharing']),
      change('input', 'DeepSeek-ViT + Engram', '原生视觉输入；196B Engram conditional memory 提供 token-based lookup。', 'Lookup parameters 与逐请求缓存分开；整体 checkpoint 不只包含 backbone。', ['engram']),
      change('position', 'Decoupled RoPE / 2D-RoPE', '语言 Attention 与视觉编码器的位置信息路径分开。', '2D-RoPE 属于 Vision Encoder，不能套用为语言层维度。', ['rope']),
      attention(['csa2', 'swa'], 'Full / Reindex / Reuse 层模式共享 KV / Indexer K / Top-K；SWA Bounded Replay 恢复最近窗口。'),
      change('residual', 'Single-Pass mHC', '修订 residual-stream mixing，并提供 Mega-mHC kernel。', '架构收益和 fused kernel 效率需要分别理解。', ['mhc']), moe('384 routed experts，top-6 + 1 shared。'),
      change('decoding', 'DSpark · Draft / Verify', '半自回归草稿生成，按置信度调度验证。', '加速取决于接受率与验证成本，不能直接从 active parameters 推断 TPS。', ['dspark']),
      change('training', 'FP4 Global KV · 45T tokens', 'Global KV 使用 E2M1 FP4，每 16 channels 一份 E4M3 scale；45T 多模态预训练。', '官方 890 B/token 指 Global KV，不包含完整服务工作集。')],
    evidence: [evidence('kv', 'Global KV / token', 890, 'bytes', '约为 V4-Flash 的 1/4', 'FP4 main KV + scale；不包括 SWA、索引元数据、draft buffer 与运行时开销。', 'architecture'), evidence('persistent', 'Persistent KV footprint', 12.5, '% of baseline', 'DeepSeek-V4-Flash', '官方约 1/8；SWA Bounded Replay 避免将全部 SWA KV 持久化到 SSD。', 'architecture', 100), evidence('deepswe', 'DeepSWE v1.1 · Resolved', 74.2, '%', 'V4-Flash', '官方 Instruct 对比；mini-SWE harness；effort=100，1M context，temperature=1，top_p=.95。', 'model', 54.4)],
    sources: [source(hf('deepseek-ai/DeepSeek-V4.1-Flash')), source(hf('deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf'), 'Technical report', 'CED / CSA2 / SWA Bounded Replay', 'paper')],
    topology: topology([['Text / Image', 'Embedding + DeepSeek-ViT'], ['Causal Encoder ×20', 'Prefill active 8B', 'ced'], ['Shared Global KV', 'Project once → share across Decoder layers', 'kv-sharing'], ['Causal Decoder ×20', 'CSA2 + SWA + Single-Pass mHC', 'csa2'], ['DSpark + LM Head', 'Draft → Verify → Autoregressive output', 'dspark']]),
  }),
  fresh({ id: 'qwen38-flash-next', family: 'Qwen', name: 'Qwen3.8-Flash-Next', vendor: 'Qwen', released: '2026-08', weightsUrl: hf('Qwen/Qwen3.8-Flash-Next'), license: 'Qwen Community License 1.0', predecessorId: 'qwen35-397b',
    parameters: { backboneB: 125, activeB: 6, lookupB: 51, predictionHeadB: 4, note: '按官方 Language Model 口径分列；Vision Encoder 与存储精度另见模型卡。' }, context: '262,144 native → 1M extended', mechanisms: ['gdn', 'qsa'],
    summary: 'GDN + QSA / GR / N-gram Embedding：同时改造时间记忆、纵向信息流和查表容量。',
    changes: [change('topology', '12 × (3 GDN + 1 QSA)', '48 layers：36 GDN + 12 QSA，交替连接 MoE。', '多数层维护固定状态，少数层读取稀疏历史。', ['gdn', 'qsa']),
      change('input', 'N-gram Embedding · 51B', 'Layer 2 加入 bigram / trigram 查表嵌入，参数可在 Host Memory 中预取。', '增加 lookup memory 与 Host→GPU 数据路径，而不是逐请求 KV。', ['ngram']),
      change('position', 'Partial RoPE · QSA', 'QSA head_dim=256，其中 rotary dimension=64。', 'RoPE 维度属于 QSA 分支，不直接套用 GDN state。', ['rope']),
      attention(['gdn', 'qsa'], 'QSA：24 Q / 2 KV heads；512 micro-blocks，即 2048 token budget。'),
      change('residual', 'GR · 4 Residual Streams', '逐元素 Read gate 从 4 路 residual streams 读取；逐分支 Write gate 写回。', 'GR 沿深度传递，GDN / QSA 沿 token 时间轴混合。', ['gr']), moe('512 routed experts，top-10 + 1 shared。'), mtp('额外 4B MTP；1 layer，采用 multi-step 训练。'),
      change('training', 'Muon + AdamW', '不同权重类别使用不同优化器；训练配方与架构一起评估。', '不能把综合训练效率提升全部归因于 QSA。')],
    evidence: [evidence('train', 'Training FLOPs', 11.1, '% of baseline', '397B-A17B predecessor', '论文约 1/9；约 1/3 activated parameters 与 1/3 training tokens，14 项预训练评测；综合比较。', 'model', 100, 'paper'), evidence('deepswe', 'DeepSWE 1.1', 58.7, '%', 'Qwen3.8-27B', 'Claude Code 与 mini-SWE 两种 harness 取较高分；256K context，temperature=1，top_p=.95。', 'model', 42.2)],
    sources: [source(hf('Qwen/Qwen3.8-Flash-Next')), source('https://arxiv.org/abs/2608.30320', 'Architecture technical report', 'Abstract / Architecture / Ablations', 'paper')],
    topology: topology([['Embedding + Vision', 'Text / Image → hidden state'], ['N-gram Lookup', 'Layer 2 · 51B table', 'ngram'], ['GR Read → GDN / QSA', '4 streams · 36 GDN + 12 QSA', 'gr'], ['MoE → GR Write', '10 routed + 1 shared', 'moe'], ['LM Head + MTP', '125B backbone + 4B MTP', 'mtp']]),
  }),
  fresh({ id: 'glm-53', family: 'GLM', name: 'GLM-5.3', vendor: 'Z.ai', released: '2026-08', weightsUrl: hf('zai-org/GLM-5.3'), license: 'GLM-5.3 License', predecessorId: 'glm-52', parameters: { backboneB: null, activeB: null, note: '沿用 GLM-5.2 base model；HF checkpoint 标注 753B params，backbone / active 未单列；默认 FP8。' }, context: '1M', mechanisms: ['dsa'],
    summary: 'Same base, stronger post-training：架构继承 GLM-5.2，主要变化是 Coding 与长任务能力。',
    changes: [decoder('沿用 GLM-5.2 base model；78 layers，来自官方 config。'), input(), rope(), rms(), change('attention', 'DSA + IndexShare · inherited', '复用 GLM-5.2 的 Sparse Attention 架构。', '本次模型能力提升不能归因于新的 Attention。', ['dsa', 'indexer']), moe('沿用基座；config：256 routed experts / top-8。'), mtp(), change('training', 'Post-training · Native FP8 checkpoint', '官方明确所有增益来自 post-training；默认权重为 FP8，BF16 单独发布。', '保持架构差异与能力差异两个观察维度。')],
    evidence: [evidence('deepswe', 'DeepSWE v1.1', 66.9, '%', 'GLM-5.2', '官方表；mini-swe-agent，temperature=.95，top_p=1，400K context，6h timeout。', 'model', 46.2)],
    sources: [source(hf('zai-org/GLM-5.3')), source(hf('zai-org/GLM-5.3/blob/main/config.json'), 'Official configuration', 'num_hidden_layers / n_routed_experts', 'config')], topology: defaultTopology(['dsa'], true),
  }),
  fresh({ id: 'glm-53-flash', family: 'GLM', name: 'GLM-5.3-Flash', vendor: 'Z.ai', released: '2026-08', weightsUrl: hf('zai-org/GLM-5.3-Flash'), license: 'MIT', predecessorId: 'glm-53', parameters: { backboneB: 320, activeB: 18 }, context: '1M', mechanisms: ['dsa'],
    summary: 'New base + Hybrid Attention：Linear Attention 与 Sparse Attention 并存，mHC 改善深度信息流。',
    changes: [change('topology', 'Hybrid Architecture · 45 layers', '官方 config：34 linear_attention + 11 deepseek_sparse_attention layers。', '需要按不同层类型分别管理请求状态。', ['state', 'dsa'], ['card', 'config']), input(true), change('position', 'RoPE · Sparse branch', '稀疏分支保留位置编码；不同分支的配置分别读取。', '不把整栈视为普通全 Attention。', ['rope'], ['config']),
      change('attention', 'Linear Attention + DSA', '以线性状态层配合 sparse-attention 历史检索；官方博客另介绍 IndexPool。', '固定状态与逐 token KV 分开记账；不从名称推断线性层的精确 recurrence。', ['state', 'dsa', 'indexer']),
      change('residual', 'mHC', '重新设计 base model，加入 Manifold-Constrained Hyper-Connections。', '与 GLM-5.3 的 post-training 更新属于不同性质的变化。', ['mhc']), moe('320B total / 18B active；config：288 routed experts / top-8。'),
      change('decoding', 'Autoregressive · Thinking Effort', '支持 low / high / max reasoning effort；由请求控制。', '不同 effort 的评测不能直接混比。'), change('training', '30T Multimodal Pre-training', '新基座使用 30T-token multimodal corpus。', '整模型收益同时包含新架构、数据与训练配方。')],
    evidence: [evidence('kv', 'KV Cache reduction', 4.4, '× smaller', 'GLM-5.3', '官方博客的架构平均比较；未提供统一硬件和负载，不能解释为本站端到端加速。', 'architecture', undefined, 'blog'), evidence('compute', 'Attention compute reduction', 3, '× less', 'GLM-5.3', '仅 Attention compute；不等于整模型 FLOPs 或请求吞吐。', 'architecture', undefined, 'blog')],
    sources: [source(hf('zai-org/GLM-5.3-Flash')), source(hf('zai-org/GLM-5.3-Flash/blob/main/config.json'), 'Official configuration', 'text_config.layer_types / num_hidden_layers', 'config'), source('https://autoclaw.z.ai/blog/model/glm-5.3-flash/', 'Official release / evaluation', 'Architecture for Extreme Efficiency', 'blog')],
    topology: topology([['Vision + Embedding', 'Native multimodal inputs'], ['Linear + Sparse Attention', '34 linear / 11 sparse layers', 'dsa'], ['mHC', 'Residual stream mixing', 'mhc'], ['MoE', '18B activated', 'moe'], ['LM Head', 'Autoregressive output']]),
  }),
  fresh({ id: 'minimax-m3', family: 'MiniMax', name: 'MiniMax M3', vendor: 'MiniMax', released: '2026-06-01', weightsUrl: hf('MiniMaxAI/MiniMax-M3'), license: 'MiniMax Community License', parameters: { backboneB: 428, activeB: 23 }, context: '1M', mechanisms: ['msa'],
    summary: 'MSA · Block-level retrieval：聚焦百万上下文的稀疏读取，支持原生多模态与长程 Agent 任务。',
    changes: [decoder('Native multimodal MoE language model，支持 1M context。'), input(true), attention(['msa']), moe('约 428B total / 23B active；具体专家配置以 checkpoint 为准。'), change('decoding', 'Autoregressive Generation', '逐 token 输出；官方提供多种 Runtime 部署入口。', '9× / 15× 结果具有各自阶段和比较条件。')],
    evidence: [evidence('prefill', 'Prefill speedup', 9, '×', 'MiniMax M2', '1M context；官方整体比较，模型卡未列出统一硬件／并发，不与其他模型的 kernel speedup 横比。'), evidence('decode', 'Decode speedup', 15, '×', 'MiniMax M2', '1M context；官方整体比较；不能仅归因于 MSA 单一模块。')],
    sources: [source(hf('MiniMaxAI/MiniMax-M3')), source('https://github.com/MiniMax-AI/MSA', 'MSA reference implementation', 'README / Sparse Attention operator', 'msa')], topology: defaultTopology(['msa'], true),
  }),
  fresh({ id: 'nemotron-3-super', family: 'Nemotron', name: 'Nemotron 3 Super · 120B-A12B', vendor: 'NVIDIA', released: '2026-03-11', weightsUrl: hf('nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16'), license: 'NVIDIA Nemotron Open Model License', parameters: { backboneB: 120, activeB: 12, note: '采用官方模型卡四舍五入口径；技术报告的含／不含 Embedding 口径另列。' }, context: '1M', mechanisms: ['gqa'],
    summary: 'Mamba-2 + Attention + LatentMoE：SSM hybrid 路线，状态更新不是 GDN / KDA 的 delta rule。',
    changes: [change('topology', 'Mamba-2 / Attention Hybrid', '交错使用 Mamba-2、MoE 和选择性的 Attention layers。', 'SSM state 与 Attention KV 需要分别管理。', ['ssm', 'gqa']), input(), change('attention', 'Mamba-2 State + GQA', 'SSM 更新状态，选择性的 GQA 层读取全局历史。', '本实验室只对 GQA 分支提供数值演示；不将 Mamba 替换成 KDA。', ['ssm', 'gqa']), moe('LatentMoE：在较低维度的 latent 空间执行专家计算。'), mtp('原生 MTP head；MTPv2 为额外发布的更新 checkpoint。'), change('training', 'NVFP4 Pre-training', '采用 NVFP4 预训练，发布 BF16 / NVFP4 等 checkpoint。', '训练精度与下载权重 dtype 分开理解。')],
    evidence: [evidence('gpqa', 'GPQA · no tools', 79.23, '%', '官方独立报告值', 'NeMo Evaluator / NeMo Skills；temperature=1，top_p=.95；不是与本目录其他模型的同批测试。')],
    sources: [source(hf('nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16'), 'Official model card', 'Quick summary / Benchmarks / Architecture')],
    topology: topology([['Embedding', 'Text input'], ['Mamba-2', 'SSM recurrence ≠ delta rule', 'ssm'], ['Selected GQA layers', 'Global historical retrieval', 'gqa'], ['LatentMoE', 'Sparse expert computation', 'moe'], ['LM Head + MTP', 'Native speculative decoding', 'mtp']]),
  }),
  ...([{ id: 'gemma4-31b', name: 'Gemma 4 · 31B Dense', size: 30.7, active: 30.7, kind: 'dense', released: '2026-04', score: 85.2 },
    { id: 'gemma4-26b', name: 'Gemma 4 · 26B-A4B MoE', size: 25.2, active: 3.8, kind: 'moe', released: '2026-04', score: 82.6 },
    { id: 'gemma4-12b', name: 'Gemma 4 · 12B Unified', size: 11.95, active: 11.95, kind: 'unified', released: '2026-06-03', score: 77.2 }] as const).map(g => fresh({
      id: g.id, family: 'Gemma', name: g.name, vendor: 'Google DeepMind', released: g.released,
      weightsUrl: hf(g.kind === 'moe' ? 'google/gemma-4-26B-A4B-it' : g.kind === 'unified' ? 'google/gemma-4-12B-it' : 'google/gemma-4-31B-it'), license: 'Apache 2.0',
      parameters: { backboneB: g.size, activeB: g.active, note: '官方 Total Parameters 口径；Vision Encoder 的独立规格见来源表。' }, context: '256K', mechanisms: ['swa', 'gqa'],
      summary: g.kind === 'unified' ? 'Encoder-free multimodality：原始 image patches / audio 经轻量投影直接进入同一 Decoder。' : 'Local / Global Attention：SWA 与 Global Attention 交替；全局层采用 unified K/V 与 p-RoPE。',
      changes: [decoder(g.kind === 'unified' ? '48 layers；Encoder-free multimodal Decoder。' : g.kind === 'moe' ? '30-layer MoE Decoder。' : '60-layer Dense Decoder。'),
        change('input', g.kind === 'unified' ? 'Encoder-free · Linear Projection' : 'Token Embedding + Vision Encoder', g.kind === 'unified' ? 'Image patches 与 audio waveforms 经轻量线性投影进入 LLM；不使用独立视觉／音频编码器。' : '独立 Vision Encoder 为图像生成表征；文本采用 Token Embedding。', '同一模型家族的输入拓扑不同，不能合并成仅参数量不同的变体。'),
        change('position', 'p-RoPE · Proportional RoPE', 'Global layers 使用 p-RoPE；local / global 分支分别配置。', '普通 RoPE 示意不代表此模型的全部频率配置。', ['rope']),
        change('attention', 'SWA + Global Attention · Unified K/V', 'Local window=1024；最终层为 global；global layers 统一 Key / Value。', 'GQA 演示仅解释头共享；Unified K/V 是额外的参数／缓存设计。', ['swa', 'gqa']),
        g.kind === 'moe' ? moe('128 experts，8 active + 1 shared；官方 25.2B total / 3.8B active。') : dense(),
        change('decoding', 'Autoregressive · Thinking', 'Instruction-tuned checkpoint 支持 thinking 与 function calling。', '对比时保留 thinking 条件；不单独归因于 SWA。')],
      evidence: [evidence('mmlu', 'MMLU Pro', g.score, '%', 'Gemma 3 27B · no think', '官方 instruction-tuned 表；Gemma 3 baseline 为 no think，属于整模型结果，非同算力消融。', 'model', 67.6)],
      sources: [source('https://ai.google.dev/gemma/docs/core/model_card_4', 'Official Gemma 4 model card', 'Model Architecture / Dense Models / MoE / Benchmark Results')],
      topology: topology([[g.kind === 'unified' ? 'Raw image / audio → Linear' : 'Vision + Embedding', g.kind === 'unified' ? 'Encoder-free input' : 'Modality-specific encoding'], ['SWA ↔ Global', '1024 local window · final global', 'swa'], [g.kind === 'moe' ? 'MoE' : 'Dense FFN', g.kind === 'moe' ? '8 / 128 + 1 shared' : `${g.size}B total`, g.kind === 'moe' ? 'moe' : undefined], ['LM Head', 'Autoregressive output']]),
  })),
  fresh({ id: 'mistral-small-4', family: 'Mistral', name: 'Mistral Small 4 · 119B-A6.5B', vendor: 'Mistral AI', released: '2026-03-16', weightsUrl: hf('mistralai/Mistral-Small-4-119B-2603'), license: 'Apache 2.0', parameters: { backboneB: 119, activeB: 6.5 }, context: '256K · model-card supported range', mechanisms: ['mla'],
    summary: 'MLA + sparse MoE：统一 Instruct / Reasoning / Coding，并提供独立 EAGLE draft head。',
    changes: [decoder('36 layers；官方 config 的 model_type=mistral4。'), input(true), rope(), attention(['mla'], '官方 config：kv_lora_rank=256；使用低秩 KV 路径。'), moe('128 experts / 4 active；119B total / 6.5B activated。'), change('decoding', 'EAGLE · Speculative Decoding', '另行发布训练好的 EAGLE head，可在支持的 Runtime 中启用。', 'Draft head 是附加组件，不假设所有部署默认启用。'), change('training', 'NVFP4 checkpoint', '另行发布 NVFP4 权重版本。', '这是 checkpoint 精度选项，不推断全部预训练精度。')],
    evidence: [evidence('latency', 'End-to-end completion time reduction', 40, '%', 'Mistral Small 3', '官方 latency-optimized setup；模型卡未完整列出硬件／负载。不能与 throughput-optimized setup 合并。', 'runtime'), evidence('rps', 'Requests per second', 3, '×', 'Mistral Small 3', '官方 throughput-optimized setup；RPS 不等于单用户 output tok/s。', 'runtime')],
    sources: [source(hf('mistralai/Mistral-Small-4-119B-2603')), source(hf('mistralai/Mistral-Small-4-119B-2603/blob/main/config.json'), 'Official configuration', 'text_config / kv_lora_rank', 'config')], topology: defaultTopology(['mla'], true),
  }),
  fresh({ id: 'mistral-medium-35', family: 'Mistral', name: 'Mistral Medium 3.5 · 128B', vendor: 'Mistral AI', released: '2026-04-28', weightsUrl: hf('mistralai/Mistral-Medium-3.5-128B'), license: 'Modified MIT', parameters: { backboneB: 128, activeB: 128 }, context: '256K', mechanisms: ['gqa'],
    summary: 'Dense 128B merged model：统一 Instruct / Reasoning / Coding；GQA 主干配合可选 EAGLE。',
    changes: [decoder('官方 config：88-layer Dense Decoder，hidden_size=12288。'), input(true), rope(), change('attention', 'GQA · 96 Q / 8 KV', '官方 text_config 披露 96 attention heads / 8 KV heads。', '此处是头共享路线，与 Small 4 的 MLA 路线不同。', ['gqa'], ['config']), dense(), change('decoding', 'EAGLE · Optional Draft Head', '独立发布 EAGLE checkpoint。', '请求的 reasoning effort 与是否使用 draft head 是两个设置。'), change('training', 'Merged capabilities', '官方定位为首个旗舰 merged model；统一指令、推理和编码能力。', '模型合并细节未在模型卡展开，不推断具体训练算法。')],
    evidence: [evidence('swe', 'SWE-bench Verified', 77.6, '%', '官方独立报告值', '官方 Agentic benchmark；当前文字未完整披露 harness / 硬件，保留原始评测入口。')],
    sources: [source(hf('mistralai/Mistral-Medium-3.5-128B')), source(hf('mistralai/Mistral-Medium-3.5-128B/blob/main/config.json'), 'Official configuration', 'text_config / num_attention_heads / num_key_value_heads', 'config')], topology: defaultTopology(['gqa'], false),
  }),
]
const datedSources: Record<string, [string, string]> = {
  'qwen38-flash-next': ['https://qwen.ai/blog?id=qwen3.8-flash-next', 'August 2026 release; bibliography month in official model card'],
  'glm-53': ['https://zcode.z.ai/en/changelog', 'GLM-5.3 announced in August; weights repository verified separately'],
  'glm-53-flash': ['https://zcode.z.ai/en/changelog', 'August availability; September 12 AutoClaw article is a later publication, not the first release'],
  'gemma4-31b': ['https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-april-2026/', 'April 2026 model release recap'],
  'gemma4-26b': ['https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-april-2026/', 'April 2026 model release recap'],
  'gemma4-12b': ['https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemma-4-12b/', 'June 3, 2026 announcement'],
  'minimax-m3': ['https://www.minimax.io/blog/minimax-m3', 'June 1, 2026 announcement; official site dates may differ by timezone'],
  'kimi-k3': ['https://www.kimi.com/en/help/agent/agent-overview', 'July 16 model announcement; full weights July 27, 2026'],
  'mistral-medium-35': ['https://docs.mistral.ai/models/mistral-medium-3-5-26-04', 'April 28 model-version date; Vibe remote-agent launch article is May 22'],
  'deepseek-v41-flash': ['https://www.deepseek.com/en/news/deepseek-v4-1-flash/', 'September 10, 2026 announcement'],
}
function freezeProfile(m: ArchitectureModel): ArchitectureModel {
  const verified = WEIGHT_REVISIONS[m.weightsUrl.replace('https://huggingface.co/', '')]
  const date = datedSources[m.id]
  const sources = date ? [...m.sources, source(date[0], 'Release / version date', date[1], 'release-date')] : m.sources
  if (m.id === 'glm-53') sources.push(source(hf('zai-org/GLM-5.3/blob/main/LICENSE'), 'Official weights license', 'GLM-5.3 License', 'license'))
  return { ...m, weightsRevision: verified?.revision,
    releaseNote: m.id === 'kimi-k3' ? '首次公布 2026-07-16；完整权重 2026-07-27。' : m.id === 'mistral-medium-35' ? '使用官方 model-version date 2026-04-28；Vibe 发布文章日期为 2026-05-22。' : m.released.length === 7 ? '按官方发布月份记录；不将仓库创建或最后更新日期当作发布日。' : undefined,
    sources: sources.map(s => {
      const match = s.url.match(/^https:\/\/huggingface.co\/([^/]+\/[^/]+)(.*)$/)
      if (!match) return s
      const rev = WEIGHT_REVISIONS[match[1]]?.revision
      return rev ? { ...s, url: match[2] === '' ? `${s.url}/blob/${rev}/README.md` : s.url.replace('/blob/main/', `/blob/${rev}/`) } : s
    }),
  }
}
export const ARCHITECTURE_MODELS: ArchitectureModel[] = [...legacy, ...modern].map(freezeProfile).sort((a, b) => b.released.localeCompare(a.released) || a.name.localeCompare(b.name))
export const CLASSIC_BASELINE: ArchitectureChange[] = axes([
  decoder('教学对比基线：经典 Transformer 的 causal decoder block；不指代某个已发布模型。'), input(),
  change('position', 'Sinusoidal Position Encoding', '原始 Transformer 使用 sinusoidal positions。', '位置编码与网络主干结构分开比较。'),
  attention(['mha']), change('residual', 'Post-Norm · LayerNorm', 'Residual addition 后进行 LayerNorm。', '作为历史组件基线。'), dense('ReLU · Dense FFN'),
  change('decoding', 'Next-token Prediction', '因果位置预测下一 token。', '不使用附加 draft head。'), change('training', 'Adam', '历史教学基线；不作为现代模型的性能对照。', '本基线没有 Benchmark 数字。'),
])
export function getArchitectureModel(id: string | null): ArchitectureModel | undefined { return ARCHITECTURE_MODELS.find(m => m.id === id) }
export function modelSearchText(m: ArchitectureModel): string { return [m.name, m.vendor, m.family, m.summary, ...m.changes.flatMap(c => [c.label, c.explanation, ...c.terms.map(t => `${TERMS[t].short} ${TERMS[t].english} ${TERMS[t].chinese}`)])].join(' ').toLowerCase() }
export function parameterLabel(m: ArchitectureModel): string {
  const p = m.parameters
  const size = p.backboneB === null ? 'Not disclosed' : p.backboneB >= 1000 ? `${Number((p.backboneB / 1000).toFixed(3))}T` : `${p.backboneB}B`
  if (p.prefillActiveB !== undefined) return `${size} · Prefill ${p.prefillActiveB}B / Decode ${p.decodeActiveB}B active`
  if (p.backboneB === null) return 'Parameters · 未单独披露'
  return p.activeB === p.backboneB ? `${size} Dense` : `${size} / ${p.activeB ?? '—'}B active`
}
