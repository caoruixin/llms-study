// 注意力机制演进速查（来源见 models.ts 各模型条目）
export interface AttentionStage {
  id: string
  name: string
  mechanism: string
  kvCost: string
  models: string
}

export const ATTENTION_EVOLUTION: AttentionStage[] = [
  {
    id: 'mha',
    name: 'MHA 多头注意力',
    mechanism: '每个 Q head 配独立 K/V head，原始 Transformer 设计',
    kvCost: '每 token 每层 2×heads×head_dim（最贵，如 32768 元素）',
    models: 'GPT-3、Llama 1/2-7B',
  },
  {
    id: 'mqa',
    name: 'MQA 多查询注意力',
    mechanism: '所有 Q heads 共享 1 组 K/V',
    kvCost: '缩小 heads 倍，质量略损',
    models: 'PaLM、Falcon',
  },
  {
    id: 'gqa',
    name: 'GQA 分组查询注意力',
    mechanism: 'Q heads 分组共享少量 KV heads（如 64Q/4KV），质量与显存折中',
    kvCost: '缩小 heads/kv_heads 倍（如 16 倍）',
    models: 'Llama 2-70B/3、Qwen2.5、Qwen3-235B',
  },
  {
    id: 'mla',
    name: 'MLA 多头潜在注意力',
    mechanism: 'K/V 低秩压缩为共享 latent 向量（512 维 + 64 维 RoPE），推理只缓存 latent',
    kvCost: '每 token 每层 576 元素，比 GQA 再降数倍',
    models: 'DeepSeek-V2/V3/R1、Kimi K2',
  },
  {
    id: 'dsa',
    name: 'DSA 稀疏注意力',
    mechanism: 'lightning indexer 打分，每个 query 只对 top-k(2048) 历史 token 做注意力，O(L²)→O(L·k)',
    kvCost: 'cache 结构同 MLA，读取稀疏化；GLM-5.2 的 IndexShare 再把 indexer 开销摊薄 4 层',
    models: 'DeepSeek-V3.2、GLM-5/5.1/5.2',
  },
  {
    id: 'kda',
    name: 'KDA / GDN 线性注意力混合',
    mechanism: 'delta-rule 线性注意力层为主（恒定状态、无增长 KV cache）+ 少量全注意力/MLA 层兜底召回',
    kvCost: '线性层恒定；仅少数全注意力层随长度增长',
    models: 'Kimi K3（69 KDA + 24 Gated MLA）、Qwen3.5（Gated DeltaNet）',
  },
  {
    id: 'csa-hca',
    name: 'CSA + HCA 混合',
    mechanism: '压缩式稀疏注意力 + 重压缩注意力的混合栈（MLA 压缩 × DSA 稀疏的融合下一步）',
    kvCost: '官方口径：1M 上下文下 FLOPs 为 V3.2 的 27%、KV cache 为 10%',
    models: 'DeepSeek-V4-Pro / V4-Flash',
  },
]

export const ATTENTION_SUMMARY =
  '演进主线：先减 KV heads（MQA/GQA）→ 再压 KV 表征（MLA）→ 再稀疏化读取（DSA）→ 最后改成恒定状态的线性注意力混合（KDA/GDN/CSA-HCA）。每一步都是为了让「上下文长度 × 并发」的 KV cache 账单可负担。'
