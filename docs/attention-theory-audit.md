# Attention Trace v2：理论核验与验收记录

核验日期：2026-09-13。范围为现有 13 种 Attention 机制；模型目录快照仍为 2026-09-12.1。页面的英文主标签、公式、固定系数和 `Implemented / Not simulated` 与本记录对应。

## 根因与统一修正

旧引擎虽然计算了 4 个 Head，但场景只读取选中的 H0 连线；最终节点实际代表单 Head 的结果，没有 `Concat × Wᴼ`。此外，循环移位并归一化同一个 q/k 的教学输入，让 MHA 各 Head 权重相同。旧测试可以证明程序自洽，却无法证明视觉与理论完整。

v2 使用公开、固定且不同的 WQ/WK/WV。所有 Heads 在各阶段同时可见，点击 Head 只改变强调；普通机制只绘制一个真实计算层。每个 Head 的 score、mask、weights、Weighted V 与 Head Output 独立记录；随后全部经过 Concat 和真实输出矩阵得到 Attention Output。K score 使用虚线，Value / latent 聚合使用实线，颜色始终标识 Query Head。

六阶段共用一条轨迹：Project、Prepare Memory、Route / Decay、Score / Predict、Aggregate / Write、Output。`stageStorage` 是阶段快照，避免出现提前写入的 State 或 Top-K；对象 ID 包含所属存储、位置、Head / Group。`SceneFrame` 只将轨迹转为有效节点和边，三维与二维使用同一语义图。粒子沿实际曲线、按同一时钟播放；暂停保持位置。普通 Head Output 与最终 Attention Output 分开命名。

## 逐机制核验

| 机制 | 官方依据与位置 | 已修复与已实现 | 教学边界 |
| --- | --- | --- | --- |
| MHA | [Transformer](https://arxiv.org/html/1706.03762v7#S3.SS2)，§3.2.1–3.2.2，Eq.1 / Figure 2 | H0–H3 分别读取各自 KV Head 的因果历史，分别 Softmax；所有 Head Outputs → Concat → Wᴼ | 4D input / head，扩张到 16D Concat 后投影回 4D；省略训练、Dropout、Residual、FFN、LM Head |
| MQA | [Fast Transformer Decoding](https://arxiv.org/abs/1911.02150)，§2 | 4 个 Q Heads 引用一个 KV Head；缓存共享但 Query / 权重 / 输出不共享 | 相同固定投影示例，不比较真实模型质量或吞吐 |
| GQA | [GQA](https://arxiv.org/html/2305.13245v3)，§2.2 / Figure 2 | H0/H1 → g0，H2/H3 → g1；各 Head 独立计算；所有输出合并 | 2 KV Groups，省略 checkpoint 特定附加层 |
| MLA | [DeepSeek-V2](https://arxiv.org/html/2405.04434v5#S2.SS1)，§2.1.2–2.1.3，Eqs.9–21 | 保存 shared latent + position key；content / RoPE score、absorbed Query、latent 聚合、Uᵥ 与 Wᴼ；显式重建路径与吸收路径数值等价 | latent=2、RoPE=2、content Q=4；省略 Query down-projection / RMSNorm。重建张量仅作核验，不是持久缓存 |
| DSA | [官方 inference/model.py](https://github.com/deepseek-ai/DeepSeek-V3.2-Exp/blob/main/inference/model.py)，`Indexer.forward` / `MLA.forward` 的 `index_mask.unsqueeze(2)` | 独立 Indexer Q/K，跨 Indexer Heads 汇总 weighted ReLU → Top-K；取消 Main Head 各自选 token，所有 Main Heads 使用同一集合独立 MLA | 2 个 Indexer Heads、2D K、固定聚合系数 [1,.7]、Top-2；省略 input-dependent weights、LayerNorm、Hadamard、量化 |
| QSA | [Qwen3.8 报告](https://github.com/QwenLM/Qwen3.8-Flash-Next/blob/main/tech_report.pdf)，§2 QSA，Eqs.13–16 | Indexer K AvgPool → RMSNorm → block-start RoPE；4 Indexer Heads 汇总 ReLU；完整因果块选择 + incomplete tail；主 KV 仍为 token GQA | micro-block=4、Top-1 block、固定系数；省略主分支 output gate、QK Norm / RoPE、训练及量化 |
| MSA | [MiniMax-M3](https://arxiv.org/html/2606.13392v1#S3)，§3.1 Index/Main Branch，Figure 1 / Local Block | 每 GQA Group 独立块选择；token score 取 block max，取消逐 Head 均值选块；当前 Local Block 永远纳入，包含完整块边界 | block=2，Top-2 budget=一个 nonlocal + local；省略 learned Indexer loss / training、fused Kernel |
| SWA | [Mistral 7B](https://arxiv.org/abs/2310.06825)，§2.1–2.2 | 当前 K/V 写入、窗口内读取、窗口外淘汰；淘汰位置没有活动读取路径 | W=3，2 KV Heads；单纯局部层，不替代 Hybrid 模型全局层 |
| CSA | [DeepSeek-V4](https://arxiv.org/html/2606.19348v1)，§2.3.1–2.3.3，Eqs.9–27 | Shared KV MQA，同一 entry 作 K 和 V；当前块 a 分支 + 前块 b 分支的重叠逐 channel 加权压缩；独立压缩 Indexer 与共享摘要选择；Window、Partial RoPE、inverse output RoPE、Sink、Grouped Output Projection | ratio=2、Top-1 summary、W=3；固定 compressor / bias / sink，省略低秩 Query 投影、训练、量化和真实 Kernel |
| HCA | [DeepSeek-V4](https://arxiv.org/html/2606.19348v1)，§2.3.2–2.3.3，Figure 4 / Eq.27 | Shared KV MQA；更强无重叠加权压缩，所有合格摘要 + Window；与 CSA 相同的输出反向旋转、Sink、分组输出投影 | ratio=4、W=3；摘要数随长度增长，不是固定 State；同样省略 checkpoint 特定部件 |
| GDN | [Gated DeltaNet](https://arxiv.org/html/2412.06464v1#S3)，§3.1 / Eq.8 | 4 个独立 State；每 Head scalar decay → prediction → residual → delta write → Query Readout；独立 q/k；最后阶段才出现读取输出路径 | α=.8，β=.7；q/k L2 normalization；省略短卷积、learned gates、Output Norm / Gate。只复现核心更新及教学输出投影 |
| KDA | [Kimi Linear](https://arxiv.org/html/2510.26692v1#S2)，§2 / Eq.1 | key-channel decay；所有 Heads 独立更新；复用已验证内核；无 token Softmax。采用与论文转置等价的 State[value][key] | α=[1,.6,.9,.4]，β=.7；其余边界同 GDN。不把 SSM 套入此方程 |
| CED / CSA2 | [DeepSeek-V4.1 报告](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf)，§2.2–2.3 / Figures 4–5 | 最后 Encoder states 生成 Decoder Global KV；Full 新建 KV / Indexer K / 候选池 / Top-K，Reindex 在共享 pool 内重索引，Reuse 引用最新索引；每层有自己的 Main Q / SWA KV；按 ID 去重 | **Structure only**：移除假 MLA 数值，无虚构输出向量；4 层静态模式，ratio=1、dim=4、FP16、Top-2 / pool≤4；不模拟完整 CED、FP4、bounded replay 或 890 B/token |

来源定位与边界也随代码保存在 `src/data/attentionTheory.ts`，各机制页面可直接打开官方来源。报告中的真实维度、压缩比或 Runtime 收益不能直接从这些缩小的教学计算推导。

## 可复算算例与基准

`INPUTS` 为 8 个固定向量。通用矩阵生成规则（r/c 从 0 开始）：

```text
W[r,c] = (((r+1)(c+2) + seed(r+2) + c×seed) mod 11 − 5)/8
         + (r=c ? 0.6 : 0)
Q Head h: seed=h+1；KV Group g: WK seed=g+7，WV seed=g+13
Wᴼ: 4×16，seed=21
```

使用列向量 `Wx`，不额外归一化普通 MHA。t2 输入 `[0,1,0,0.5]`，只读取 t1/t2：

| Head | Scaled scores [t1,t2] | Weights [t1,t2] | Head Output |
| --- | --- | --- | --- |
| H0 | [0.493359375, 0.605859375] | [0.471904626, 0.528095374] | [0.455196423, 0.373732046, 0.199160801, 0.100839199] |
| H1 | [0.241015625, −0.088281250] | [0.581588286, 0.418411714] | [0.462445650, 0.018308010, 0.219715504, −0.175469164] |
| H2 | [0.123828125, 0.397265625] | [0.432063389, 0.567936611] | [0.495309346, −0.129178606, 0.125035818, 0.053873060] |
| H3 | [0.124609375, 0.133203125] | [0.497851576, 0.502148424] | [0.176127923, 0.332404778, −0.008103016, 0.152792952] |

Concat 后乘 Wᴼ 得到 **[−1.509501348, −0.300789321, 0.262616586, 0.225589283]**。该算例由独立的直接矩阵计算复核，并固化为测试。将任一 Head 的某个输出通道加 1，最终结果的变化正好是 Wᴼ 对应列；证明所有 Heads 都参与最终结果。

其他独立基准：Softmax([0, ln3])=[.25,.75]；q=[1,0]、K=[[0,1],[0,−1]]、V=[[2,4],[6,8]] 得到 [4,6]。MLA 逐 Head / token 核对显式重建与吸收路径；GDN/KDA 独立重算 decay、prediction、outer-product update 与 readout；CSA/HCA 核对 channel weights、source overlap、sink 分母、inverse RoPE、两级分组输出投影。共享选择、Local Block、缓存淘汰与跨层引用使用单独语义断言，不能只靠数值 oracle 自证。

## 验收方法与产物

- `src/lib/attention/engine.test.ts`：独立算术基准、所有 Heads / tokens、合并敏感性、共享映射、选择边界、压缩和 State 更新、逐阶段对象快照与去重。
- `src/lib/attention/sceneGraph.test.ts`：13 种机制 × 8 tokens × 6 stages 的节点/边完整性、全 Heads 参与、精确读取对象、无未来/未选中读取、无提前输出、回放一致。
- `scripts/architecture-repro.py`：Chromium / WebKit 真实 WebGL、13 种机制各 6 个关键阶段、Head focus / Inspector、双机制同一时钟、暂停/回放/键盘、旧链接迁移、390px、标签遮挡、2D / reduced-motion / 无 WebGL、资源释放。
- 每个浏览器保存 39 张关键阶段截图（13 × 桌面 Score / Output + 手机 Score），输出 `acceptance.json`。默认目录 `output/playwright/attention-v2/` 被 Git 忽略；在干净 checkout 按文档命令可重建，生产验收使用单独目录。

验收后发布仅包含本次 Attention 文件的 commit，使用独立 checkout 构建。生产发布、备份位置、资产哈希和浏览器验收保存在部署产物中；工作区已有其他功能改动保留。

连续拖动／快速单步先更新本地画面，停止变化 400 ms 后合并保存 frame 到 URL；机制、视图与 Head 切换同时保存当前位置。这样避免 [WebKit history 写入频率限制](https://bugs.webkit.org/show_bug.cgi?id=156115)。浏览器验收包含 20 次连续快速 seek、最终 URL 和刷新恢复。

### 本地验收结果

- 类型检查、生产构建通过；相关资料 / 数值 / 语义测试 **169 项通过**。
- 当前工作区完整前端测试 **105 个文件 / 1,857 项通过**（包含工作区已有但不随本次提交的其他功能测试）。干净发布 checkout 的完整测试结果另存部署日志。
- Chromium / WebKit 均完成 **13 种机制 × 6 个阶段 = 78 次阶段检查**、39 张截图、13 次 2D / 3D context 切换检查；0 标签重叠、0 页面错误；最后离开页面均为 3 个 context 创建 / 3 个释放。
- 20 次快速 seek、最终 URL 与刷新恢复、共享时钟、回放、Head focus、正确缓存对象 Inspector、390px、reduced motion 和 WebGL 失败回退均通过。
- 构建保留已有大 chunk 提示；没有通过提高阈值隐藏提示。Three.js 独立按需加载。

后续线上导航复核补充：合并写入 URL 的定时器在 hash 跳转后作废；区分自身保存和外部导航，在提交旧播放位置的副作用前同步新链接。新增带待保存 frame 的三次旧链接跳转回归，Chromium / WebKit 均通过。
