// 经典 Transformer（decoder-only 视图）组件讲解
export interface TfComponent {
  id: string
  name: string
  enName: string
  inBlock: boolean // 是否属于 N× 重复的 Transformer Block
  what: string
  why: string
  interview: string // 面试一句话
}

// encoder-decoder 原始结构（2017）专属组件
export const ENCDEC_COMPONENTS: TfComponent[] = [
  {
    id: 'enc-attn',
    name: '双向自注意力（编码器）',
    enName: 'Bidirectional Self-Attention',
    inBlock: true,
    what: '编码器内每个 token 可以看见整句的前后文（无因果掩码），把输入序列编码成上下文表示。',
    why: '翻译等任务里源句是完整给定的，双向理解显然更优；BERT 一系就是只留编码器的路线。',
    interview: '「为什么 GPT 用 decoder-only」的对照物：生成任务必须逐 token 自回归，双向编码器无法直接生成。',
  },
  {
    id: 'cross-attn',
    name: '交叉注意力（解码器）',
    enName: 'Cross-Attention',
    inBlock: true,
    what: '解码器的 Q 来自已生成的目标序列，K/V 来自编码器输出——每生成一个词都"回头查看"源句的对应部分。',
    why: '这是 encoder-decoder 的桥梁：对齐源与目标（如翻译中的词对应）。decoder-only 把它省掉，源信息直接拼进同一序列。',
    interview: 'decoder-only 胜出的工程原因之一：同一序列统一处理 → KV cache 可以跨轮复用、训练数据格式更简单、扩展到多轮对话零成本。',
  },
]

export const TF_COMPONENTS: TfComponent[] = [
  {
    id: 'tokenizer',
    name: '分词与嵌入',
    enName: 'Tokenizer + Embedding',
    inBlock: false,
    what: '把文本切成 token（BPE 等子词算法），每个 token 查表映射为 d_model 维向量。',
    why: '模型只认向量不认字。词表大小（如 Kimi K3 160K）决定切分粒度：中文 1 字≈0.6~1 token，切得越碎序列越长、成本越高。',
    interview: 'Token 是计费和上下文的基本单位——同样一段中文，不同分词器 token 数可差 30%+，报价前要用对方的 tokenizer 算。',
  },
  {
    id: 'pos',
    name: '位置编码',
    enName: 'Positional Encoding → RoPE',
    inBlock: false,
    what: '注意力本身不感知顺序，需要注入位置信息。原始 Transformer 用固定正弦编码加在嵌入上；现代模型改用 RoPE（旋转位置编码）直接作用在 Q/K 上。',
    why: 'RoPE 编码相对位置、外推性好，是长上下文扩展（YaRN 等插值方法）的基础。',
    interview: '「上下文窗口怎么扩」的答案一半在 RoPE：位置插值 + 少量长文本继续训练。',
  },
  {
    id: 'norm',
    name: '归一化',
    enName: 'LayerNorm → RMSNorm (Pre-Norm)',
    inBlock: true,
    what: '把每层输入的数值分布拉回稳定范围。原始设计是残差之后归一化（Post-Norm），现代模型改为进子层之前归一化（Pre-Norm）且用更简的 RMSNorm。',
    why: 'Pre-Norm 让梯度直通残差主干，深层训练稳定——没有它就没有 100 层级的大模型。',
    interview: '训练稳定性三件套之一（Pre-RMSNorm / 优化器 / 精度策略），大模型训崩往往从这里查起。',
  },
  {
    id: 'attention',
    name: '多头自注意力',
    enName: 'Multi-Head Self-Attention (QKV)',
    inBlock: true,
    what: '每个 token 生成 Q/K/V 三组向量：Q 与所有历史 K 算相似度得到权重，加权求和 V 得到输出；多个 head 并行捕捉不同关系。decoder-only 用因果掩码，只看得见左侧。',
    why: '这是 Transformer 的核心：任意两 token 直接交互，长程依赖一步到位。代价是 O(n²) 计算 + KV cache 显存——推理成本的根源。',
    interview: '推理时 K/V 会缓存下来避免重算（KV cache），它随「上下文 × 并发」线性膨胀，是显存墙的主角——后续 GQA/MLA/DSA/线性注意力全是围绕它省钱。',
  },
  {
    id: 'ffn',
    name: '前馈网络',
    enName: 'FFN → SwiGLU / MoE',
    inBlock: true,
    what: '每个 token 独立过一个两层（现代为 SwiGLU 门控三矩阵）的全连接网络，中间维度约 4×d_model。参数量占模型 2/3。',
    why: '注意力负责「token 间通信」，FFN 负责「每个 token 内部加工」，被认为是知识的主要存储处。',
    interview: 'MoE 就是把 FFN 换成多个专家网络按 token 路由——总参数（显存）与激活参数（算力）从此分家，这是现代开源旗舰的共同选择。',
  },
  {
    id: 'residual',
    name: '残差连接',
    enName: 'Residual Connection',
    inBlock: true,
    what: '每个子层的输出加回其输入（x + Sublayer(x)），信息与梯度沿主干直通。',
    why: '让百层网络可训练的基础设施。2026 年新动向：Kimi K3 的 Attention Residuals、DeepSeek V4 的 mHC 都在改造这条「主干公路」。',
    interview: '新架构在残差上动刀（AttnRes/mHC）说明：注意力和 FFN 之外，深度方向的信息流成了新的效率战场。',
  },
  {
    id: 'lmhead',
    name: '输出层与采样',
    enName: 'Final Norm + LM Head + Sampling',
    inBlock: false,
    what: '最后归一化后，把向量投影回词表大小的 logits，softmax 成概率分布，按温度/top-p 采样出下一个 token；随后拼回输入循环生成。',
    why: '自回归生成 = 一次只出一个 token 再喂回去，这就是 decode 阶段逐 token、带宽受限的原因。',
    interview: '「为什么输出比输入贵 3~5 倍」的答案就在这：每个输出 token 都要完整跑一遍模型并读全部权重，MTP/投机解码就是想一次多出几个。',
  },
]
