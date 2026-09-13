import { TERMS } from './architectureTerms'
import type { MechanismId } from './architectureTypes'
export interface AttentionStage { id: MechanismId; name: string; mechanism: string; kvCost: string; models: string }
const row = (id: MechanismId, mechanism: string, kvCost: string, models: string): AttentionStage => ({ id, name: `${TERMS[id].short} · ${TERMS[id].english}`, mechanism, kvCost, models })
export const ATTENTION_EVOLUTION: AttentionStage[] = [
  row('mha', '每个 Q Head 有独立的 K/V Head。', '每 token 每层 2 × Hq × d 个 KV 元素；随序列增长。', 'Original Transformer、Llama 2 7B'),
  row('mqa', '所有 Q Heads 共享一组 K/V；各 Head 的权重与输出独立。', '每 token 每层 2 × d；存储份数降低，质量与具体训练有关。', 'PaLM、Falcon'),
  row('gqa', 'Q Heads 按组共享 KV；各 Head 独立打分、聚合，再 Concat / Wᴼ。', '每 token 每层 2 × Hkv × d；共享比例 Hq / Hkv。', 'Llama 3、Qwen3、Mistral Medium 3.5'),
  row('mla', '保存共享 Latent KV + 独立位置分量；投影可吸收到打分和输出。', 'rKV + dRoPE 元素；V3 为 512 + 64 = 576；仍随长度增长。', 'DeepSeek V3、Kimi K2、Mistral Small 4'),
  row('dsa', '独立 Indexer Heads 汇总得分，Main Heads 共享 Top-K token，分别计算 MLA。', '保留主 KV，并另计 Indexer K；主读取稀疏，不等于整个索引路径都是 O(k)。', 'DeepSeek V3.2、GLM-5 / 5.2 / 5.3'),
  row('qsa', 'Indexer K 先 AvgPool / RMSNorm / RoPE；共享 Micro-block selection + incomplete tail；主 KV 保持 token 粒度。', 'GQA KV + Indexer state；与 GDN 组成 Hybrid，全层总状态分别计算。', 'Qwen3.8-Flash-Next'),
  row('msa', '每个 GQA Group 用 Block Max Score 选择历史块，始终保留 Local Block。', '稀疏主读取；块索引及历史 KV 仍需存储。', 'MiniMax M3'),
  row('swa', 'Sliding Window；只读取最近 W 个位置，淘汰窗口外 KV。', '单纯局部层 O(W)；混合模型的 Global layers 仍会增长。', 'Mistral、Gemma 4、DeepSeek V4 / V4.1'),
  row('csa', 'Shared KV MQA；重叠加权压缩 + 摘要 Top-K + Window；Partial RoPE / inverse RoPE、Sink、Grouped Output Projection。', '摘要数量仍随长度增长；压缩率与窗口共同决定缓存。', 'DeepSeek V4 Pro / Flash'),
  row('hca', 'Shared KV MQA；更强无重叠压缩，读取全部合格摘要 + Window；含 Sink 与 Grouped Output Projection。', 'Sequence Compression，不是固定大小 Recurrent State；与 CSA / SWA 混合。', 'DeepSeek V4 Pro / Flash'),
  row('gdn', 'Gated DeltaNet；scalar decay + prediction error + delta write。', '每层每请求持有固定形状 State；Hybrid 中的全 Attention KV 另算。', 'Qwen3.5、Qwen3.8-Flash-Next'),
  row('kda', 'Kimi Delta Attention；channel-wise decay 控制各记忆通道。', '固定 State；Kimi K3 的 24 Gated MLA 层仍有随长度增长的 KV。', 'Kimi Linear、Kimi K3'),
  row('csa2', 'CED 生成 Shared Global KV；Full / Reindex / Reuse 跨层共享索引与缓存。', '同一份 Global KV 按对象去重；FP4 KV、Indexer、SWA 工作状态分别列示。', 'DeepSeek V4.1-Flash'),
]
export const ATTENTION_SUMMARY = 'Head Sharing（MQA/GQA）、Latent KV（MLA）、Sparse Retrieval（DSA/QSA/MSA）、Sequence Compression（CSA/HCA）、Sliding Window、Recurrent State（GDN/KDA）与 Cross-layer KV Sharing（CED/CSA2）是不同优化维度，可以组合。必须分别观察存储、读取与更新成本；SSM 使用自己的状态方程。'
