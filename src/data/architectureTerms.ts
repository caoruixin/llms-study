import type { ArchitectureTerm, MechanismId, TermId } from './architectureTypes'
const hf = 'https://huggingface.co/'
const term = (id: TermId, short: string, english: string, chinese: string, explanation: string, sourceUrl: string): ArchitectureTerm => ({ id, short, english, chinese, explanation, sourceUrl })
export const TERMS: Record<TermId, ArchitectureTerm> = {
  mha: term('mha', 'MHA', 'Multi-head Attention', '多头注意力', '每个 Query head 使用独立的 Key / Value head；历史 K/V 随 token 增长。', 'https://arxiv.org/abs/1706.03762'),
  mqa: term('mqa', 'MQA', 'Multi-query Attention', '多查询注意力', '多个 Query heads 共享一组 K/V；各自计算 Attention Weights 与 Head Output。', 'https://arxiv.org/abs/1911.02150'),
  gqa: term('gqa', 'GQA', 'Grouped-query Attention', '分组查询注意力', 'Query heads 分组共享 K/V；共享缓存不等于共享权重或输出。', 'https://arxiv.org/abs/2305.13245'),
  mla: term('mla', 'MLA', 'Multi-head Latent Attention', '多头潜在注意力', '缓存低维 latent 与解耦的 RoPE key；内容打分可吸收投影矩阵，避免重建整套 K/V。', 'https://arxiv.org/abs/2405.04434'),
  dsa: term('dsa', 'DSA', 'DeepSeek Sparse Attention', 'DeepSeek 稀疏注意力', '独立 Indexer Heads 汇总得分；所有 Main Heads 共享所选 token，但分别计算主 Attention。', hf + 'deepseek-ai/DeepSeek-V3.2-Exp'),
  qsa: term('qsa', 'QSA', 'Qwen Sparse Attention', 'Qwen 稀疏注意力', '在 micro-block 粒度筛选，再读取选中块内的 token K/V；未完成的 causal tail 单独处理。', hf + 'Qwen/Qwen3.8-Flash-Next'),
  msa: term('msa', 'MSA', 'MiniMax Sparse Attention', 'MiniMax 稀疏注意力', '每个 GQA Group 使用 Block Max Score 选择历史块；组内共享选择，始终保留 Local Block。', hf + 'MiniMaxAI/MiniMax-M3'),
  swa: term('swa', 'SWA', 'Sliding Window Attention', '滑动窗口注意力', '仅保留并读取最近窗口；超出窗口的细节需要其他全局层或记忆路径承接。', 'https://arxiv.org/abs/2310.06825'),
  csa: term('csa', 'CSA', 'Compressed Sparse Attention', '压缩稀疏注意力', 'Shared KV MQA；重叠加权压缩与稀疏摘要选择，加上局部窗口；历史摘要仍随长度增长。', hf + 'deepseek-ai/DeepSeek-V4-Flash'),
  hca: term('hca', 'HCA', 'Heavily Compressed Attention', '高度压缩注意力', 'Shared KV MQA；更高比例、无重叠的加权压缩；全部合格摘要与局部窗口共同参与。', hf + 'deepseek-ai/DeepSeek-V4-Flash'),
  gdn: term('gdn', 'GDN', 'Gated DeltaNet', '门控 DeltaNet', '用标量遗忘门衰减旧状态，再按预测误差写入；状态矩阵大小不随序列长度增长。', 'https://arxiv.org/abs/2412.06464'),
  kda: term('kda', 'KDA', 'Kimi Delta Attention', 'Kimi Delta 注意力', '以逐通道遗忘门控制固定状态矩阵的保留与更新；混合栈中的 MLA 层仍有增长的 KV。', 'https://arxiv.org/abs/2510.26692'),
  csa2: term('csa2', 'CSA2', 'Compressed Sparse Attention 2', '第二代压缩稀疏注意力', 'Full / Reindex / Reuse 是静态层模式：共享 KV、重算索引或连同 Top-K 一起复用。', hf + 'deepseek-ai/DeepSeek-V4.1-Flash'),
  ced: term('ced', 'CED', 'Causal Encoder-Decoder', '因果编码器—解码器', 'Encoder 仍遵循因果约束；最终 Encoder states 生成全局 KV，供 Decoder 层共享。', hf + 'deepseek-ai/DeepSeek-V4.1-Flash'),
  rope: term('rope', 'RoPE', 'Rotary Position Embedding', '旋转位置编码', '旋转 Q/K 的指定维度，使打分包含相对位置信息。', 'https://arxiv.org/abs/2104.09864'),
  moe: term('moe', 'MoE', 'Mixture of Experts', '混合专家', '每 token 只激活部分专家；激活参数关联计算量，全量权重仍需存储。', 'https://arxiv.org/abs/2401.06066'),
  mtp: term('mtp', 'MTP', 'Multi-token Prediction', '多 token 预测', '训练时引入后续 token 的预测任务；是否以预测头进行 speculative decoding 取决于推理实现。', 'https://arxiv.org/abs/2412.19437'),
  dspark: term('dspark', 'DSpark', 'DSpark Speculative Decoding', 'DSpark 投机解码', '半自回归生成草稿，再按置信度调度验证；收益依赖草稿接受率及执行开销。', hf + 'deepseek-ai/DeepSeek-V4.1-Flash'),
  engram: term('engram', 'Engram', 'Engram Conditional Memory', '条件记忆', '基于 token 查表的模型参数，与每请求增长的 KV Cache 属于不同存储对象。', hf + 'deepseek-ai/DeepSeek-V4.1-Flash'),
  ngram: term('ngram', 'N-gram Embedding', 'N-gram Embedding', '相邻 token 组合的查表嵌入', '将短 token 组合映射到学习得到的表项；可通过 Host Memory offload 扩大参数容量。', hf + 'Qwen/Qwen3.8-Flash-Next'),
  gr: term('gr', 'GR', 'Gated Residual', '门控残差', '对加宽的 residual streams 做逐元素 Read gate 与逐分支 Write gate。', hf + 'Qwen/Qwen3.8-Flash-Next'),
  mhc: term('mhc', 'mHC', 'Manifold-Constrained Hyper-Connections', '流形约束超连接', '对多条 residual streams 的混合施加约束，以改善深层信号传播。', 'https://arxiv.org/abs/2512.24880'),
  attnres: term('attnres', 'AttnRes', 'Attention Residuals', '注意力残差', '沿网络深度选择性聚合较早层的表征；与 token 时间轴上的 Attention 是不同方向。', hf + 'moonshotai/Kimi-K3'),
  ssm: term('ssm', 'SSM', 'State Space Model', '状态空间模型', '维护递归状态的另一类序列模型；Mamba 的状态更新不等同于 GDN / KDA 的 delta rule。', 'https://arxiv.org/abs/2405.21060'),
  'kv-sharing': term('kv-sharing', 'Cross-layer KV Sharing', 'Cross-layer KV Sharing', '跨层共享 KV', '多层引用同一份历史 KV，降低沿层维度重复存储的开销。', hf + 'deepseek-ai/DeepSeek-V4.1-Flash'),
  state: term('state', 'Recurrent State', 'Recurrent State', '递归状态', '每个请求持有可更新状态；固定形状不代表可无损保留任意长历史。', 'https://arxiv.org/abs/2412.06464'),
  indexer: term('indexer', 'Sparse Indexer', 'Sparse Indexer', '稀疏索引器', '用较便宜的打分寻找主 Attention 的候选历史；需单独计入索引计算和存储。', hf + 'deepseek-ai/DeepSeek-V3.2-Exp'),
}
export const MECHANISMS: MechanismId[] = ['mha', 'mqa', 'gqa', 'mla', 'dsa', 'qsa', 'msa', 'swa', 'csa', 'hca', 'gdn', 'kda', 'csa2']
export function isMechanism(value: string | null): value is MechanismId { return MECHANISMS.includes(value as MechanismId) }
