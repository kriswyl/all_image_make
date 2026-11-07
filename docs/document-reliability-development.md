# 文档可靠性与 PPT 增量改造开发规范

日期：2026-11-06  
基线：ChatCanvas v2.3.4 当前代码。  
状态：设计决策已确定；**A 已完成（真实 6/6）、B 已完成（含完整 6 轮复验）、C 已完成（ChangeScope + 局部检查 + 真实视觉验收）、D1 已完成（整稿职责与布局计划），见第 13–16 节**。本文是开发规范与实现状态记录，不是发布记录。  
本轮执行范围：只交付 A；A 验收通过后进入 B、C。本文同时规定后续接口边界，避免返工。

## 1. 目标、范围与事实基线

目标按优先级排序：用户要求跨轮不丢失；制作、编辑、补做遵守相同约束；局部修改不引入无关变化；减少无关页面的模型调用；提高整稿表达和版式多样性。

不新建 Agent 框架、通用运行时或第二套版本系统。模型继续使用原生 function calling；工具组预加载和能力发现沿用现有实现。文档内容是待处理数据，不得作为授权、需求或工具指令来源。

### 1.1 已有能力与真正增量

| 已有代码                                                     | 已有能力                            | 本次需要补的增量                          |
| -------------------------------------------------------- | ------------------------------- | --------------------------------- |
| `src/server/chat-tools/registry.ts`、`execution-store.ts` | 工具执行状态、操作记录、中断恢复                | 契约绑定、统一错误和暂停原因，不另造执行状态机           |
| `src/server/workflow-store.ts`                           | 工作流所有权、预算、阶段记录                  | 固定契约 revision、关联输入版本和受保护引用        |
| `src/server/db.ts`                                       | 文件版本家族、PPT 报告、批次缓存              | 契约及其修订、活跃引用保护；B 再加入候选状态           |
| `src/server/presentation-execution.ts`                   | engine、目标页数、模型用量、恢复参数           | specId/specRevision；旧断点兼容         |
| `src/server/presentation-workflow.ts`                    | 当前请求页数解析、模板规划、分页质量报告            | 从持久化契约取约束；制作与修改统一检查               |
| `src/server/presentation-revision.ts`                    | 单页补做、内容审校、视觉修复、操作幂等             | 明确变更范围；局部视觉检查；后续原包修改              |
| `src/server/presentation-elements.ts`                    | `objectName: element.id`；连线分段命名 | 补齐复合对象命名、导出后映射校验、局部补丁             |
| `src/server/presentation-project.ts`                     | PPT 内嵌 plan/images、内容指纹         | 映射版本、修改后 plan/OOXML 同步；保留外部修改拒绝机制 |
| `src/server/chat-tools/word-document.ts`                 | 正文 run 替换、保留其他包部件               | 按需增加可定位的段落、样式、表格操作                |
| `src/server/chat-tools/spreadsheet-document.ts`          | ExcelJS 数据/格式操作、复杂工作簿编辑拒绝       | 精确声明支持范围；后续增加原包限定操作               |

事实限定：

- 当前消息明确要求 10 页时，已进行的离线验证得到 10 页，包括规划失败回退。缺口是跨轮要求继承和修改入口一致性，不能宣称已复现默认路径必然输出 30 页。
- 页数缺失时仍可能使用资料批次数推导默认值；一旦契约中已有页数，不允许再次进入该默认分支。
- `TemplateReport` 是结果报告，不是用户任务契约。
- ExcelJS 修改后整本序列化，不等于原包单元格级补丁；Word 正文 XML 也会重新序列化。不能承诺整个 ZIP 字节不变。
- PPT 单页补做仍调用整稿 `renderAiPresentation`；现有缓存不等于原包增量写入。
- `objectName` 已进入 `cNvPr.name`，不是从零建立元素映射。一个逻辑元素可能对应多个形状；数字 shapeId 仅在所属页面内使用。
- 三类检查已经存在。本期统一它们的输入、约束和交付口径，不重新开发三套检查器。

## 2. 二十项决策表

| 编号 | 最终决策                                                                                                                                        |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | 使用 conversationId + specId + 不可变 revision；familyId 可暂空，首次发布绑定。续做和修改优先按显式文件/工作流绑定继承，不能仅凭关键词或“没有 fileId”继承。新制作意图新建 Spec；已准备但未生成的唯一任务可被“开始”消费。 |
| 2  | 页数采用判别联合 exact/min/max/range，范围保留上下界；保存 evidence/sourceMessageId。目标页数另存，不混同约束。发布前硬校验；先尝试约束内合并内容，真正无法同时满足时才追问。                               |
| 3  | 采用绑定 fileId/sha256 的 ChangeScope；模型可选择业务目标，但 DocumentRef、依赖部件和允许变更范围由服务端推导并校验。                                                              |
| 4  | A 保留当前保存流程并加入统一门禁；B 复用 workspace_documents 增加 candidate/published 状态。publish 是唯一转为 published 的入口，候选默认隐藏，终止且无引用后 24 小时可清理。                   |
| 5  | A/B/C 保留 doc_edit 现有 pages/appendSlides/order/design 接口并加强校验；后续增加限定对象操作，渐进替代，不能立即删除旧接口。                                                     |
| 6  | A 修改验收口径并增加失败门禁，备注不计正文覆盖；暂不重写模板布局。必需内容被截断时不得标为可用成品。D2 再改溢出重排策略。                                                                             |
| 7  | 默认硬检查通过后交付，视觉检查独立后台状态；用户明确要求检查完成再交付时阻塞正式成品发布。未检查不能显示已验证。                                                                                    |
| 8  | 默认版式重复仅提示；只有明确约定的可执行多样性约束才阻止成品发布。“好看/有设计感”不是可机械判定的硬条件。                                                                                      |
| 9  | draft=true 不计首次可用；pendingPages 非空不算完成。精简页只有必需正文覆盖及硬约束通过才可用，未知不得冒充通过。                                                                        |
| 10 | 复用并版本化扩展 shared/presentation-report.ts；报告绑定文件 sha256 和 Spec revision；不并入 ExecutionState，不新建通用质量状态机。                                         |
| 11 | 扩展现有 evaluate-presentation 入口；fixture 的事实清单独立保存，禁止从生成结果反推期望值。全部使用虚构资料。                                                                      |
| 12 | 比较解压后部件内容；ZIP 元数据不参与。Content_Types 不整体豁免；允许变化由操作预先推导并验证具体项。                                                                                 |
| 13 | 分别记录生成/审校页面集合、模型调用、WPS 打开/导出、端到端耗时。C 要求模型局部处理，不承诺 WPS 不加载整稿。                                                                                |
| 14 | 工程估算包含 fixture、必要测试、开发版构建和桌面回归；真实渠道等待单列。F 仅范围预研，不承诺工期或交付。                                                                                   |
| 15 | legacy 冻结新增能力，保留显式开关和旧断点续跑；不自动跨引擎迁移，不因新引擎失败静默切 legacy。共用发布门禁。                                                                               |
| 16 | locator 必须是格式专属可校验结构，绑定 sha256，回读唯一命中且类型/指纹正确；禁止以内容相似度自动套用旧补丁。                                                                              |
| 17 | 活跃引用保护是 A 必做。A 对有未完成任务/待检查引用的 family 保守跳过清理，B 才细化为版本级保护。                                                                                    |
| 18 | 暂不承诺项逐条写入本文第 12 节；不引入 Python、LibreOffice、Docling、Pandoc、任意代码执行。                                                                             |
| 19 | 先 A，验收通过再 B/C。交付本文不代表开始实现 A，也不授权发布或打包。                                                                                                      |
| 20 | 针对行为缺口先写失败用例再改代码；已有正确行为作为回归用例保留。设计写 docs，CHANGELOG 只在实际功能完成时记录。                                                                             |

## 3. 任务契约与继承规则（A）

### 3.1 数据模型

新增 `presentation-spec-store.ts`，接入现有数据库迁移。逻辑上维护以下数据，不复制 workflow_runs 和 workspace_documents 的职能：

- `presentation_specs`：specId、conversationId、当前 revision、可选 familyId、生命周期、创建时间。
- `presentation_spec_revisions`：specId、revision、完整契约 JSON、原因、来源消息、创建时间；只追加。
- 工作流/恢复数据绑定 specId + specRevision；文件报告绑定相同版本。一个文件版本不允许事后换绑契约。
- 工作流引用复用现有记录；若无法从现有字段可靠查询，则增加小型文档引用表，不以扫描 prompt 字符串替代引用关系。

以下为接口契约草案，落地使用 Zod 校验，不接受任意 JSON：

```ts
type Evidence = {
  sourceMessageId: string;
  text: string;
};

type PageCountConstraint = Evidence & (
  | { kind: "exact"; value: number }
  | { kind: "min"; value: number }
  | { kind: "max"; value: number }
  | { kind: "range"; min: number; max: number }
);

type RequiredContent = {
  id: string;
  evidence: Evidence;
  description: string;
  placement: "visible";
  sourceRefs: Array<{ fileId: string; sha256: string; nodeId: string }>;
  verification: "deterministic" | "semantic";
};

type PresentationSpec = {
  schemaVersion: 1;
  specId: string;
  revision: number;
  conversationId: string;
  familyId?: string;
  sources: Array<{ fileId: string; sha256: string }>;
  pageCount?: PageCountConstraint;
  pageCountBasis: "total" | "body";
  cover: "include" | "exclude";
  requiredContent: RequiredContent[];
  preserveSourceData: boolean;
  requiredAssets: Array<{ assetId: string; sha256: string; evidence: Evidence }>;
  styleRequest?: Evidence;
  visualPolicy: "background" | "before_publish";
};
```

用户证据必须回读当前会话对应的用户消息，确认原文匹配。模型不能通过伪造 messageId、引用附件中的指令或把推断写成用户证据提升约束优先级。默认策略单独记录 default 来源，不伪造 Evidence。

Spec 的“必需内容”仅来自用户明确要求及其指向的源材料；模型提炼的普通大纲项不自动升级为用户硬约束。无法定位“三个案例”指哪个时，应读取来源消歧，仍不唯一才询问。

### 3.2 生成前也能保存要求

仅在 doc_convert 执行时创建 Spec 不足以覆盖“先定要求，下一轮再开始”。A 增加文档组内轻量原生工具 `presentation_spec_update`：

- 接受创建/更新意图、已知源 fileId、页数或必需内容候选及消息证据；revision、哈希、归属由服务端生成或解析。
- 可保存未绑定产物的 prepared Spec，不触发制作，不发起额外独立意图模型请求。
- 当前 Agent 的正常工具选择负责调用该工具；明确制作/修改时也从当前用户消息再次校验并补齐要求，避免工具漏调用。
- 明确、无歧义的页数等由服务端提取；语义项由模型提出后验证来源。不依赖关键词将所有带数字的聊天都写成任务。
- 用户说“暂不生成”时，仅保存 prepared Spec；UI 展示简短需求摘要，允许继续自然语言修改，不强制增加确认步骤。

### 3.3 继承、分叉与 revision

按以下优先级定位任务：

1. 显式文件卡操作/工作流 ID → 读取其绑定的 Spec revision。
2. 显式 `fileId` → 读取该文件版本的 Spec，不沿用其他文档的最新 Spec。
3. 当前消息明确延续唯一活动或 prepared 任务 → 继承该任务。
4. 明确“另做一份/新做一份” → 新 specId，即使源文件相同也不复用旧任务。
5. 同时存在多个合理目标且未指明 → 询问目标，不按“最后一个 family”盲选。

`doc_convert` 自带源 fileId，不能据此判为新任务：它可能是前一轮 prepared Spec 的实际执行。必须区分源文件与目标产物的归属。

- “换风格/补第 3 页”：继承目标文件的要求；风格变化追加 revision，纯执行重试不新增 revision。
- “改成 12 页”：追加 revision，保留旧 revision。生成中的任务冻结原 revision；收到影响当前任务的新要求时取消/暂停旧执行后创建新执行绑定，禁止中途热改契约。
- “在上个版本上修改”：以选定版本的 revision 为基线追加新 revision，不误用较新分支的约束。
- 清除 resume 不删除 Spec；已完成文件仍能继承要求。无文件指向的普通新任务不继承已完成 Spec。
- Spec revision、源哈希、引擎和渲染器版本进入适用缓存键。只在能证明无影响时复用旧页面；不能借改 revision 重置预算并无限重试。

### 3.4 页数算法与冲突

- 范围 1–200；用户显式超限返回可解释约束冲突，不能静默 clamp 成 200。
- 默认总页数包含封面；“正文 10 页，另加封面”记录 basis=body 并在解析后的目标中明确总页数 11。无法确定封面语义才询问。
- exact 固定 value；min/max/range 将规划候选值限制在合法集合；chosenTargetPages 写入检查点，恢复时不重新根据批次数计算。
- 用户没有硬页数要求才使用默认估计。默认值应显示为系统估计，不伪装用户要求。
- “约 10 页/10 页左右”作为软偏好保存，不能擅自解释成硬 exact 或自行发明容差区间。A 可按偏好目标 10 规划，但偏离时报告而非假称违反硬约束。
- “原文第 3 页/资料共 18 页/每章 2 页”不直接当总页数。组合要求需解析后计算，未支持的歧义返回澄清。
- outline、补做、编辑和最终文件均共用约束。删除 legacy 的“完整覆盖自动优先于明确页数”隐式策略。
- 18 章可以合并进 9 个正文页，章数多不是冲突。先在页数内合并；只有必需内容在可读条件下不能容纳、或要求本身矛盾时暂停询问。
- 参数错误、解析错误等可在已有预算内修复；禁止通过丢弃 Spec、换源或切引擎绕过门禁。

## 4. 修改范围与定位（A 最小范围，后续扩展）

```ts
type DocumentRef = {
  fileId: string;
  sha256: string;
  nodeId: string;
  kind: "slide" | "shape" | "paragraph" | "cell";
  locator: FormatLocator;
  contentHash: string;
};

type ChangeScope = {
  fileId: string;
  sha256: string;
  targets: DocumentRef[];
  preserveRest: true;
  effects: Array<"content" | "appearance" | "order" | "page_count" | "shared_resource">;
};
```

`FormatLocator` 是受控判别联合，不是任意路径或 unknown。原生部件路径只能由解析器取得，必须在已校验包内、关联关系合法且符合支持的部件类型。

A 中模型仍使用页码选择修改对象，服务端基于文件版本转换为 slide DocumentRef。页码只是显示/输入位置，不是跨版本永久 ID。新建文件没有基线，不强造 preserveRest 范围。

范围推导规则：

- pages → 指定页面；appendSlides → 新页面及页数影响；order → 页序及相应页码展示；design → 整稿样式。
- 图片替换先检查资源引用者，必要时复制资源并改目标关系，不擅自修改共享媒体。
- 服务端校验模型选择是否符合本次用户修改意图；全稿 design 不能作为“只改第 3 页”的执行方式。
- 视觉修复不得偷偷扩展用户限定范围。其他页问题可报告；若必须改其他页才能满足要求，说明原因并请求明确扩展。
- A 比较未授权页面的结构化内容、图片引用与数据；当前整稿渲染不能宣称部件字节保真。原包哈希门禁在限定 XML 修改实现后启用。

外部另存规则：同版本回读必须唯一命中，类型和指纹一致。外部文件变化先重建索引；旧 nodeId 不跨哈希直接使用。初期不自动模糊映射。将来可用原生 ID、内容指纹、父结构、相邻文本共同证明唯一对应；零个或多个候选均重新定位，不能以相似度阈值偷偷接受。

## 5. 质量、溢出与发布

### 5.1 A 的统一门禁

新增 `presentation-contract-check.ts`，制作、doc_edit、单页补做、视觉修复都调用。A 用统一包装函数检查后调用现有 `saveWorkspaceDocument`，不提前迁移全部文件存储。

检查至少包含：

1. 契约归属、revision、源文件哈希和取消/执行所有权有效。
2. 最终 PPT 实际页数符合契约；不能只比较渲染结果和已经错误的 plan。
3. 必需正文可见覆盖、指定图片存在、必须保留的数据一致。
4. 当前支持的布局硬检查通过；不把可疑几何全部视为审美问题，也不把估算通过冒充实际视觉通过。
5. 修改范围内外的结构变化符合声明，未扩大编辑范围。

确定性事实包括精确数值、单位、指定文本、已知资源哈希。语义要求可利用现有内容审校提供 supported/missing/unknown 结果；不能仅凭 sourceIds 存在判通过。必需内容 unknown 时不标成已满足，先进行预算内的读取/核验，仍未知则保留草稿并说明。

### 5.2 溢出行为

A 不重写当前缩字和截断渲染器，但必须修正判定：

- 备注只计算来源留存，不计算正文覆盖。
- 必需内容被截断、隐藏或仅进入备注 → 硬检查不通过，不发布为可用成品。
- 非必需内容精简 → 报告降级；按现有阈值及契约判断是否草稿。
- 沿用已有预算内修复路径，不新增无界重试。未能修复可交付明确标记的草稿或暂停，不能用“文件能打开”宣告完成。
- 固定 fixture 包含可在 10 页容纳的事实，正常成功用例必须通过；另设确实超载用例，验收其正确诊断/暂停。不能把所有 18 章压 10 页都挡成草稿来算修复完成。

D2 再实现装不下返回容量诊断、换适合布局、内容压缩及约束内重排。最小字号和明确页数不可静默突破。

### 5.3 B 的候选与发布模型

|                                             |                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 复用 workspace_documents，增加 \`state=candidate | published\`，迁移历史记录默认为 published。候选记录包含工作流/操作归属、specRevision、基线哈希、lease/更新时间、过期时间；family 的正式版本号在发布时分配。 |

- 普通列表、下载、文件卡、文件计数和 family 历史默认只暴露 published；内部候选读取必须验证运行归属。
- 候选仍计入磁盘容量配额，防止通过隐藏状态绕过限制。
- 创建候选与正式发布使用不同幂等键；旧的 getByOperation 查询不得把 candidate 当作成功结果。
- 默认清理条件：任务已终止且无引用/租约，最后更新时间超过 24 小时。活动、暂停待续做、等待检查的产物不按 TTL 自动删除。启动时及之后低频清理；不引入独立常驻进程。
- 候选变更后旧检查全部作废。报告必须绑定候选 bytes 的 sha256，不能拿旧报告发布新文件。

```ts
type PublishInput = {
  conversationId: string;
  operationId: string;
  candidateId: string;
  expectedCandidateSha256: string;
  specId: string;
  specRevision: number;
  baseline?: { fileId: string; sha256: string };
  validationId: string;
  disposition: "ready" | "draft";
};

type PublishResult = {
  fileId: string;
  familyId: string;
  version: number;
  sha256: string;
  disposition: "ready" | "draft";
  report: PresentationQualityReport;
};
```

validationId 指向可信检查器保存的结果，不接受模型自报 passed。publish 内再次验证输入、检查结果、执行所有权和取消状态。失败的必需约束只可进入显式 draft 分支；安全、归属、原文件保护检查失败不允许以 draft 绕过。

保留已有临时文件及原子落盘做法。文件系统和 SQLite 不能假装同一个原子事务：发布日志记录 candidate hash、目标名、操作 ID；重启后核对已有字节和 DB 状态，补齐登记或清理未发布孤儿，不重新生成或重复增加版本。

### 5.4 视觉策略和质量状态

复用 `src/shared/presentation-report.ts`，增加向后兼容的可选字段：contractValidation、specRef、readiness、visibleCoverage；保留既有字段。报告属于文件 sha256，不属于“当前会话最新结果”。

- 默认 background：硬检查通过可以 ready 交付。工具/制作任务完成，文件卡独立显示视觉检查排队、进行中、未检查或报告。
- before_publish：视觉检查完成且无阻塞问题才能 ready 发布。不可用/超时不得标为完成；可提供标明未检查的草稿，任务暂停等待依赖或用户明确调整策略。
- 后台报告只更新报告，不产生版本；实际修复才产生子版本。新版本可提供给用户，不静默覆盖其当前下载文件。
- 可选后台检查失败不反转已完成制作任务为执行失败，但必须更新文件风险提示。
- 每一原生 tool_call 都应得到终态或明确等待状态；工作流运行状态、文件可用状态、视觉任务状态分别保存，通过统一投影函数映射 UI，禁止一个 completed 代表三个维度全部通过。


时间指标：draftReadyAt、usableReadyAt、requiredWorkCompletedAt、optionalVisualCompletedAt。draft=true 不计 usableReadyAt；pendingPages 非空不计任务完成；少量精简页必须通过实际必需内容检查。无用户要求可用资料的“占位页”不算可用。

## 6. PPT 增量检查、对象映射与设计扩展

### 6.1 C：局部检查

- 服务端根据 ChangeScope 形成内容生成/审校和视觉页面集合。
- 局部文字或形状样式变化只处理相关页；共享主题、页面尺寸、资源或顺序变化扩展集合。
- 保留原页码传给审校；不能把截取出的第 3 页报告成第 1 页。
- 结果缓存键包含相关内容、资源、主题、渲染尺寸、引擎版本及检查策略，不只依赖页码。
- 已有检查按证据复用；不将旧版本全部检查状态无条件复制到新版本。
- WPS 可能仍打开整份文件。记录 open/export/model 时间，不能把“只导出一页”宣传为 Office 完全只处理一页。

### 6.2 M：限定原包修改，独立于设计系统

复用 objectName，补齐图标子对象和连线标签名称。导出后读取 OOXML 建立如下映射，不依赖 pptxgenjs 私有数组或假定数字 ID 连续：

```ts
type PptObjectBinding = {
  logicalElementId: string;
  slidePart: string;
  objects: Array<{ shapeId: string; objectName: string; role: string }>;
  relatedParts: string[];
};
```

映射绑定文件指纹。名称不唯一或缺少完整子对象时拒绝原位补丁，不猜对象。首先限定本应用生成的文本框/普通形状的字号、颜色、位置、尺寸操作；表格、图表、图片依赖更新按后续单独用例扩展。

OOXML、plan、对象映射和 fingerprint 必须同步形成新文件版本。无法准确映射回 plan 的操作不得继续声称旧 plan 有效。保留 readPresentationProject 的外部改动检测。

“整页重做”不等同于“改一个 shape”。前者需要页面依赖闭包和关系迁移，单独验收；不因存在 shapeId 就承诺所有图表或外部文档都可安全修改。

### 6.3 D：设计系统

D1 整稿规划增加 role、seriesId、layoutId；D2 实现主题令牌、组件参数、布局槽位和容量诊断；D3 加重复布局提示。模型提交声明式参数，坐标由可信布局代码生成；旧完整元素接口渐进保留，不能一次删除。

契约分层：ThemeTokens 提供色彩/字体/间距；ComponentSpec 提供内容和容量；PageComposition 提供职责/槽位/组件；布局器输出现有 PresentationElement[] 和诊断，复用 renderElements。

重复检测初始算法：

1. 排除页码及重复页眉页脚，按已声明角色识别，不能靠位置随意忽略正文。
2. 将主要对象类型和 x/y/w/h 归一化到画布，以 0.05 比例量化，包含主体区域和对象数量形成几何签名；不把文本内容或配色差异当成结构变化。
3. 非同一已规划系列的连续三页，主体布局相同而职责不同，发出提示。必要时相似签名比较使用固定阈值并以 fixture 校准，不称为客观审美标准。
4. 同一案例/步骤系列允许重复；无固定最大页数。seriesId 必须对应整稿计划中的分组，不允许生成阶段临时填标签逃避检查。
5. 明确要求“每页不同”时，契约保存可执行的主体布局差异要求。正文图表本身因内容需要重复时，冲突应解释，不随机换布局凑数。

设计系统与原包修改只共享 ID 规范，没有必须等待 M 完成的依赖。

## 7. 保留校验、评测和性能口径

### 7.1 部件差异

- 比较解压后内容，不比较 ZIP 时间戳、条目顺序和压缩结果。
- 非目标部件要求原始内容哈希一致；目标 XML 比较节点/属性和关系的允许差异。
- `[Content_Types].xml` 不全局豁免；新增资源时只允许声明的新增类型。`.rels` 只允许预先计算的关系变化；内嵌 plan/映射/fingerprint 只允许对应修改。
- 样式/共享资源变化必须事先计算引用者，影响范围扩大应体现在 Scope 中。
- 允许变化由操作类型和解析结果生成，测试固定，不允许模型修改、也不允许运行失败后扩大豁免列表。
- A 仅要求结构化非目标变化校验；M 的原包操作才验收未涉及部件的哈希保持。

### 7.2 固定 fixture

扩展 `scripts/evaluate-presentation.ts`，建议将资料与断言分离到 `tests/fixtures/presentation-contract/`：

- sources：18 章虚构内容、图片及可定位来源。
- requirements：10 页含封面、三个必需案例、数值和单位、必须使用图片、可合并章节。
- conversation：跨轮要求、开始、换风格、修改指定页、另做一份等消息序列。
- expected：页数约束、可见事实、案例关系、允许修改范围、期望状态。

事实清单由开发者根据虚构源文件独立编写。模型输出不得修改 expected。备注覆盖、正文覆盖和人审结论分别报告；sourceIds 和 F01 等标签仅用于来源定位，标签存在不等于其事实表达正确。

离线测试验证控制流、边界和失败路径；真实模型测试验证实际表达和渠道行为；WPS 检查验证文件呈现。三者不可互相替代。真实渠道只使用用户已经允许的虚构验收资料及授权范围，不上传实际文档。

### 7.3 A 必须通过的用例

| ID  | 场景                                  | 通过条件                                     |
| --- | ----------------------------------- | ---------------------------------------- |
| A01 | 当前消息要求 10 页，18 章来源                  | 正常规划和规划重试失败回退均为 10 页；已有行为不回退             |
| A02 | 第一轮“10 页含封面，先不生成”，第二轮“开始”           | 第一轮只保存要求；第二轮用同一 Spec，10 页且必需事实可见         |
| A03 | 制作完成后“换风格”                          | 同 family，继承页数/必需内容；新 revision，不误建无约束任务   |
| A04 | 同会话另做一份 PPT                         | 新 specId，不继承上一份 10 页；模糊指代多个文件时询问         |
| A05 | 明确改成 12 页、返回旧版本编辑                   | 修订追加；各次执行绑定正确 revision，旧文件契约不被改写         |
| A06 | exact/min/max/range、正文另加封面、中文数字     | 符合各自语义；源文件页码不污染约束；显式超限不静默截断              |
| A07 | doc_edit/appendSlides/order/补做/视觉修复 | 全部经过同一门禁；超页、删必需内容或越范围不发布成品               |
| A08 | 必需案例仅在备注、正文被截断                      | 可见覆盖失败，标草稿/暂停；正常可容纳样例仍必须成功               |
| A09 | 外部改动、并发改 Spec、取消与晚到结果               | 拒绝旧哈希/旧所有权回写，无重复版本或跨任务串写                 |
| A10 | 重启恢复、旧断点、模型未调用 Spec 工具              | 已保存要求恢复；旧任务不猜历史约束；当前显式要求仍被校验             |
| A11 | 活跃引用与版本清理                           | 暂停、运行、待检查引用的 family 不被 prune；终止且释放后可清理   |
| A12 | 版本/候选/状态回归                          | A 不改变既有可读文件和下载流程；草稿不计成品完成；一般聊天不意外创建 Spec |

### 7.4 C 性能验收

独立记录：内容生成页面集合、内容审校页面集合、视觉审校页面集合、各阶段模型调用/token、WPS 打开与导出页数、缓存命中、总耗时，以及首次草稿/可用/完成时间。

固定十页资料修改第 3 页：只向模型提交相关页面及必要上下文；不生成/审阅无关九页。共享资源或全稿主题修改另有扩大范围用例。WPS 整稿加载不导致该局部模型范围测试失败，但必须如实报告，不能宣称完成原生局部渲染。

同一模型、渠道、资料和设置重复至少三次对比中位数及范围；冷/热缓存分开。未实测前不设“必定 60 秒”承诺；不得通过取消用户要求的审校来达成速度指标。

## 8. 状态、恢复、legacy 与清理

- 原生工具 ExecutionState、工作流 WorkflowStatus、文件质量报告继续分工，统一投影结果，不新增一套互相竞争的运行状态。
- Spec/输入版本变化使相关检查点失效，旧有效文件保留；续跑复用的是已验证兼容的阶段，不能只因 key 命中就使用。
- legacy 环境开关保留，默认仍 template。无 engine 的旧断点保持 legacy；有 engine 的按原引擎续跑。
- 旧断点缺 Spec 时，从持久化的 targetPages、原始任务请求和已知源哈希构建带 legacy-derived 来源的契约；不能从整个会话最近的数字补齐。无法恢复要求则标为未知，必要时澄清。
- 历史已发布文件继续可下载；新一次修改时做显式约束绑定，不因新版本门禁把历史文件判成不可读。
- 不自动迁移到新引擎。若未来迁移，必须有明确版本适配、页数/来源/图片/预算/断点一致性测试。
- A 新增引用登记/释放并保护 family：running、paused、等待任务/依赖/确认和 pending 视觉检查均算活跃；failed/cancelled/completed 在确认无后续依赖后释放。旧记录无法证明未引用时保守保留。
- B 可收窄为版本级保护。任何阶段都不能借固定 keep=3 删除活跃任务基线；容量不足要报告，不牺牲引用完整性。

## 9. 开发增量、依赖与工时

估算为单开发者聚焦工程日，包含必要用例、针对性测试、开发版构建与桌面回归，不含用户反馈等待、渠道故障等待和正式发布。实际发现接口风险时更新估算，不以赶时间跳过验收。

| 阶段 | 范围                                    | 依赖           | 完成标准                   | 粗估            |
| -- | ------------------------------------- | ------------ | ---------------------- | ------------- |
| A  | Spec 存储/工具/跨轮继承、统一约束门禁、报告、family 活跃保护 | 现有底座         | A01–A12、构建、桌面跨轮冒烟通过    | 5–8 日         |
| B  | 候选状态、发布入口、质量/视觉策略、恢复对账                | A            | 候选隐藏、版本不刷屏、幂等和晚到结果测试通过 | 4–6 日         |
| C  | Scope 驱动的局部模型/视觉检查、缓存和性能指标            | A；正式发布集成依赖 B | 第 3 页局部处理与全局变化扩域均通过    | 3–5 日         |
| M1 | 补齐命名、导出后映射、只读映射验证                     | A；B 发布接口     | 普通及复合对象可定位，歧义拒绝        | 2–4 日         |
| M2 | 限定文本/形状 XML 补丁、plan 同步、部件 diff        | M1、B         | 非目标部件保留、外部修改拒绝、WPS 回归  | 4–7 日         |
| D1 | 整稿职责、系列和布局计划                          | A            | 页数和内容不丢，计划控制页面表达       | 2–3 日         |
| D2 | 主题/组件/槽位契约，有限变体及溢出诊断                  | D1 接口        | 同一资料有可辨别设计差异，容量边界通过    | 5–8 日         |
| D3 | 重复布局提示及真实样例评测                         | D1、D2        | 识别无理由重复，案例系列不误拦        | 2–3 日         |
| E  | Word/Excel 明确操作扩面                     | A、B，逐操作评审    | 按每种操作建立保留/拒绝测试         | 初始限定范围 8–15 日 |
| F  | 外部复杂 PPT、整页依赖闭包替换等预研                  | 对应能力验证       | 先确定支持矩阵再估算             | 不承诺工期/交付      |

A 的 fixture、存储测试可以同步准备；C 与 M1 可在公共接口冻结后分别开发；D1/D2 不依赖 M2。此处是工程依赖关系，不意味着必须开启多个 Agent 或同时修改核心文件。

本轮不把 A/B/C 合为一个大提交；先以 A 的实际验收结果决定 B 的迁移。正式发布、版本号、安装包、GitHub/Gitee 更新均不在本轮范围。

## 10. A 文件级施工单

| 文件                                              | 改动                                          |
| ----------------------------------------------- | ------------------------------------------- |
| `src/shared/presentation-spec.ts`（新增）           | Spec、Evidence、约束与错误类型，schema 及向后兼容规则        |
| `src/server/presentation-spec-store.ts`（新增）     | 追加 revision、归属、查询、绑定和冲突校验                   |
| `src/server/presentation-contract-check.ts`（新增） | 页数/必需内容/修改范围/可交付性共用门禁                       |
| `src/server/db.ts`                              | 迁移接入、引用登记、family 清理保护；A 不加候选状态              |
| `src/server/chat-tools/` 文档工具注册                 | 注册轻量 Spec 更新工具；保留现有 doc_edit 参数；服务端生成 Scope |
| `src/server/agent.ts`                           | 当前用户消息证据、任务定位、prepared Spec 承接、完成后保留 Spec   |
| `src/server/presentation-execution.ts`          | 恢复数据绑定 specId/revision，旧断点适配                |
| `src/server/presentation-workflow.ts`           | 契约驱动目标页数/必需内容；缓存与检查点绑定 revision             |
| `src/server/ai-presentation.ts`                 | legacy 同样遵守明确约束，取消隐式完整覆盖优先                  |
| `src/server/chat-tools/documents.ts`            | 所有 PPT 输出经过 A 门禁再进入现有保存方法                   |
| `src/server/presentation-revision.ts`           | 补做、审校/修复绑定正确 Spec 和范围；实际修改前后检查              |
| `src/shared/presentation-report.ts` 与文件卡        | 可用/草稿/契约未满足的兼容展示，视觉状态独立                     |
| `scripts/evaluate-presentation.ts`、相关 tests     | 分离备注与正文覆盖，跨轮及编辑验收，兼容旧评测场景                   |

接口内部命名可调整，但本文的归属、状态和校验语义不能以“实现细节”为由改变。

## 11. 开发工作方式与退出条件

1. 先补 A02/A04/A07/A08/A11 的失败测试；A01 作为已通过行为的回归测试，不人为制造失败。
2. 实现最小 Spec 持久化和继承，再接每个输出入口门禁；每接一个入口测试对应行为。
3. 跑针对性单测/集成测试，完成构建和要求的全量检查；没有新变化或失败时不无意义重复测试。
4. 用虚构资料完成真实渠道与桌面跨轮验收。记录环境、引擎、模型、约束、结果和未验证项；未跑真实渠道不能写“真实验收通过”。
5. 更新本文件的实现状态和独立验收记录；CHANGELOG 只写已完成变化。本文初稿不写成已实现功能。
6. 完成 A 后提交结果与剩余问题，不自动打包发布。重大范围变更、引入新运行时、无法兼容原数据时再询问用户；通常实现选择自主处理。

A 退出条件：核心成功样例可用、已知失败场景正确暂停或拒绝、旧文件与断点兼容、无跨任务要求串用、无清理活跃版本、无虚假成品状态，开发版构建与桌面验收有记录。

## 12. 明确不承诺清单

本期 A/B/C 不交付以下能力；不能在后续验收时当作本期遗漏：

- Word→PDF 导出：待独立验证 WPS Word 能力、部署与可靠性。
- 扫描 PDF OCR、复杂 PDF 版面恢复。
- 外部 PPT SmartArt、动画、母版及任意复杂组对象编辑。
- 完整 Word 分页引擎、完整 Excel 公式依赖图和公式计算引擎。
- 任意代码、Shell、模型生成 JavaScript 的执行；Node vm/worker/工作目录限制不称为安全沙箱。
- Python、LibreOffice、Docling、Pandoc、新 Agent 运行时。
- 全格式无损转换、任意外部另存后的永久对象 ID、全量自动三方合并。
- 绝对速度承诺、全自动审美正确性保证、仅凭程序检查保证文档语义完全准确。

Excel→CSV 是后续 E 的候选小增量，不是已实现能力；必须另定工作表选择、范围、编码和公式/缓存值输出策略。

后续新增能力优先添加有明确边界的组合式工具。是否需要任意代码执行，由真实无法覆盖的用例驱动并单独评审。

## 13. 实现状态（2026-11-06 施工，2026-11-07 续补）

13.1 只记录实际写入代码的内容；验收结论与未验证项见 13.2，剩余工作见 13.3。

### 13.1 已实现

| 范围                | 落地位置                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约类型与页数语义         | `src/shared/presentation-spec.ts`（exact/min/max/range、中文数字、干扰项过滤、软偏好拒绝、basis=body 换算、chooseTargetPages/冲突检测）                                                                                                                                                                                                                                                                                                                                              |
| 契约存储              | `src/server/presentation-spec-store.ts`（不可变 revision、prepared/active/completed、family 绑定、validation 结果、活跃引用登记）                                                                                                                                                                                                                                                                                                                                            |
| 统一门禁              | `src/server/presentation-contract-check.ts`（页数硬断言、必需内容**仅正文可见**覆盖、非目标页结构化对比、blocking 与 draft 分级、validationId）                                                                                                                                                                                                                                                                                                                                             |
| 数据库               | `db-schema.ts` 新增 4 张表；`db.ts` 挂载 store、会话删除显式清理、`pruneWorkspaceFamily` 活跃引用保护                                                                                                                                                                                                                                                                                                                                                                            |
| Agent 接入          | 新增文档组工具 `presentation_spec_update`；`resolvePresentationSpec` 支持 prepared 继承、另做一份分叉、多目标冲突；`PresentationResume` 绑定 specId/revision；toolSignature 兼容新旧签名；workflow 改为契约驱动页数，缓存键绑定 revision；工具文本证据改用 `db.getMessage` 回读真实用户消息                                                                                                                                                                                                                                  |
| 输出门禁              | `doc_convert`（template/legacy）、`doc_edit`（仅明确局部修改做非目标页对比）、`presentation-revision`（视觉修复/单页补做）统一经 `saveWorkspaceDocument` 调用门禁                                                                                                                                                                                                                                                                                                                              |
| 报告与评测口径           | `shared/presentation-report.ts` 增加向后兼容的 `contractValidation/specRef/readiness/visibleCoverage` 及四个时间点；`scripts/evaluate-presentation.ts` 的 `covered` 只认可见文本，备注覆盖单独记为 `notesCovered`；新增 `--pages P` 把目标页数与 `--chapters N` 解耦，压缩场景（P < N+1）不再要求每章独立成页，改为逐条核对每章事实编号与示例数值是否在正文可见，并在报告里列出 `missingFacts/missingNumbers`；离线固定返回的总策划按 `planningUnits` 合并章节，避免误触发 `planningFallback`。默认基线（P = N+1）保持历史判据不变，两者职责分离：本脚本是参数化生成质量评测，`eval:contract` 是固定 fixture 的契约评测 |
| 状态投影与文件卡          | 新增 `shared/presentation-status.ts`，把「文件可用 / 视觉检查 / 契约」拆成三个维度；`PresentationFileReport.tsx` 展示可用状态、正文可见覆盖与首次可用时间（仅对经过门禁的文件）                                                                                                                                                                                                                                                                                                                                 |
| 家族归属与 revision 入口 | `bindFamilyOnly` 首次发布只登记 family 不追加 revision；`presentation-revision.ts` 的补做/审校/视觉修复沿用已发布文件绑定的 specId/specRevision                                                                                                                                                                                                                                                                                                                                         |
| 独立 fixture 与补齐用例  | `tests/fixtures/presentation-contract/`（sources/requirements/conversation/expected 四份分离，全部虚构资料，含 1×1 PNG 图片素材）；`tests/presentation-contract-fixture.test.ts` 覆盖 A02–A05、A09、A10、A12 及 fixture 自洽                                                                                                                                                                                                                                                          |
| 取消与晚到结果补测         | `tests/presentation-contract-cancel.test.ts` 4 项：注入 `PresentationPaused` 与真实 `AbortSignal`，验证中断后保持草稿/待补全、页数符合契约也不升级为可用成品（门禁 `DRAFT` failure 生效）、`usableReadyAt` 不写入、spec revision 不被消费、同 operationId 的晚到结果不新增版本。补齐 A09 的并发取消注入缺口                                                                                                                                                                                                                          |
| 外部改动与图片落位         | `tests/presentation-contract-external.test.ts` 用真实 OOXML 包验证：外部改 `ppt/` 部件后 `contentFingerprint` 拒绝读回、旧 revision 补丁被阻断、不同 operationId 不串写、归属不符阻断；门禁改为按 `imageIndex` 判定指定素材真正落位，并检查 `unplacedImages`                                                                                                                                                                                                                                                       |
| 视觉时间点             | `presentation-revision.ts` 在视觉检查 `complete` 时写入 `optionalVisualCompletedAt`，不影响文件可用状态                                                                                                                                                                                                                                                                                                                                                                     |
| 可复用评测脚本           | `scripts/evaluate-presentation-contract.ts` + `npm run eval:contract`；接入独立 fixture，离线跑 6 轮跨轮（C01–C06）与 4 个负面用例（N01–N04），输出 `artifacts/presentation-contract-eval/<时间戳>/report.json`；`--api` 只检查后端连通性，不发起付费生成                                                                                                                                                                                                                                              |
| 真实渠道评测脚本          | `scripts/evaluate-presentation-contract-real.ts` + `npm run eval:contract:real`；必须同时给 `--real --i-authorize-billing`，驱动本机后端创建会话并逐轮发消息，下载真实 PPTX 读取页数与文件卡状态；只用虚构资料，会话保留在桌面端供查看                                                                                                                                                                                                                                                                             |
| 评测发现并修复的缺口        | 用户说「必须保留三个案例」时，案例全文在源资料而非聊天消息里；原实现要求每条 `requiredContent` 逐字出现在用户消息中，导致硬约束被全部丢弃。现在允许以消息中确有的明确要求句作为证据，item 仅作源材料描述；无明确要求时仍坚持逐字回读                                                                                                                                                                                                                                                                                                                            |
| 真实链路发现并修复的 3 个缺口  | ① 用户上一轮说「10 页」、下一轮只说「开始」时，模型才调契约工具，当前消息无页数 → 新增历史消息回溯（会话尚无 PPT 产物时取最近明确页数，证据绑定原消息 id）；② 「重新把整份资料做成 PPT」误继承上一份 5 页契约 → 新增新任务分支，收尾旧契约并新建空约束；③ Agent 拿到 prepared 契约进入生成后未激活，发布门禁按会话查不到当前任务而整段跳过 → doc_convert 执行前显式激活                                                                                                                                                                                                                                        |
| 门禁行为修正            | 精简页 / 待补全页由原报告的 `DRAFT_THRESHOLD` 自行判定，门禁不再二次升级为草稿，保住「单页精简仍可正常交付」的既有行为                                                                                                                                                                                                                                                                                                                                                                                    |
| legacy            | 取消「完整覆盖自动优先于明确页数」的提示词策略                                                                                                                                                                                                                                                                                                                                                                                                                                   |


### 13.2 本地验证

- `npx vitest run --config vitest.config.ts`：**94 个测试文件、664 项全部通过**（新增 `tests/presentation-spec.test.ts` 8 项、`tests/presentation-contract.test.ts` 7 项、`tests/presentation-contract-fixture.test.ts` 6 项、`tests/presentation-contract-external.test.ts` 3 项、`tests/presentation-contract-cancel.test.ts` 4 项，以及文件卡 UI 1 项）。
- `npx tsc --noEmit`、`npm run build`：均通过；仍有既存的 Vite 大包与字体体积提示，无编译错误。构建曾因 NodeNext 要求 `.js` 扩展名失败一次，已修。
- `npm run eval:contract -- --api http://127.0.0.1:17892`：**10/10 通过**（C01–C06 与 N01–N04 全绿，退出码 0），报告落在 `artifacts/presentation-contract-eval/`。`--api` 检查显示后端可达、11 个渠道、1 个已启用 `openai-chat` 渠道、版本 2.3.4；脚本未发起任何生成请求。
- 从 D 盘真实路径执行；`npm test` / vitest 包装层偶发不自行退出，但日志汇总完整、无 FAIL。
- **真实渠道评测（用户已授权计费）**：第一次因脚本未上传虚构资料，模型每轮都回复「上传区是空的」而从不调用 `doc_convert`，结果 1/6；补上 `POST /api/conversations/:id/documents` 上传后，R1 通过，R2 触发真实生成，约 **9 分 20 秒**完成，最终产出 **10 页可编辑 PPT**（18 模块数据保留、三个案例单独成页），但脚本 240s 超时先判失败，后续轮次被「上一条还在处理中」拒绝，脚本侧记 1/6。会话 `d2725f40-…` 保留在桌面端可查看。
- 真实链路日志显示模型在 R2 才调 `presentation_spec_update` 且结果为「未指定页数」，10 页是靠模型自建大纲维持，不是契约强制 —— 由此定位并修复了上表 3 个缺口。脚本侧同步修复：上传资料、默认超时 15 分钟、每轮发送前 `waitIdle`、显式 `--i-authorize-billing` 双开关。
- **修复后真实复验（`--rounds 2`，用户已授权计费）**：**2/2 通过**。会话 `39149e2c-…`，R1「先保存要求，不生成 PPT」23.8s 通过、未产生文件；R2「开始」268.3s 产出 **10 页**且符合契约，报告 `artifacts/presentation-contract-eval-real/2026-11-07T07-41-18-641Z/report.json`。这确认了「上一轮明确 10 页 → 下一轮只说开始」的跨轮继承与契约强制生效，且真实生成比首轮实测快（约 4.5 分钟而非 9 分 20 秒）。
- **生成质量评测新增压缩场景**：`node artifacts/eval-runtime/scripts/evaluate-presentation.js --chapters 18 --pages 10` 页数正确收敛到 **10 页**，但 `visibleFacts/visibleNumbers` 为 **17/18**（`missingFacts:[2]`、`missingNumbers:[2]`）。核查 PPTX 后确认：第 2 页塞两章内容时，第二条 bullet 被 `presentation-templates.ts` 的溢出处理截断成残留文本，完整的模块 2 数值被移入演讲备注。这是第 12 条决策 / D2「装不下返回诊断，不擅自缩字号或塞备注」要解决的既有缺陷，新评测口径正确判为红灯；默认基线（10 章 / 11 页）仍全绿，**此红灯按计划保留，不在 A 阶段修渲染器**。
- **修复后完整真实 6 轮验收（用户已授权计费）**：**6/6 通过，退出码 0**。会话 `a276aeb2-…`，报告 `artifacts/presentation-contract-eval-real/2026-11-07T07-48-33-106Z/report.json`，总耗时 13m26s。逐轮：R1 只存要求不产文件（28.9s）→ R2「开始」10 页（112.4s）→ R3「换成杂志风」仍 10 页（191.4s）→ R4「改第 3 页」仍 10 页（88.4s）→ R5「改成 12 页」12 页（122.9s）→ R6「另做一份 8 页」8 页、不继承 12 页（256.9s）。
  - **环境**：Tauri 桌面热重载开发版，后端 `127.0.0.1:17892`（v2.3.4），引擎 `template`，渠道适配器 `openai-chat`，模型 `deepseek-v4.1-flash-1017`；资料为 18 章虚构文本（报告记录源文 SHA-256 前缀），不上传真实文档。
  - **约束**：精确 10 页（含封面、basis=total）、3 个必需案例、3 条必需事实、正文可见才算覆盖且备注不计入；revision 改为 12 页；分叉任务另起 8 页。
  - **未验证项**：未做 WPS 像素级视觉检查；由脚本经本机 API 驱动同一后端（会话与 PPTX 保留在桌面端可查看），非人手在窗口里逐轮点击；仅开发版 `npm run build`，未做桌面打包版回归；未做不同渠道 / 模型对照，也未做中断运行中 HTTP 请求的进程级并发取消注入。
- 脚本报告已补齐 `environment / constraints / unverified / startedAt / finishedAt / durationMs` 字段以满足第 11 节第 4 条的记录要求；**本次 6/6 报告生成于该改动之前，字段以本节文字为准，报告 JSON 保持原始输出、未回写**。
- **A 阶段判定**：第 11 节退出条件的 7 项（核心样例可用、失败场景拒绝、旧文件与断点兼容、无跨任务串用、无清理活跃版本、无虚假成品状态、开发版构建与桌面验收有记录）均有代码与测试 / 评测记录；上列未验证项按第 11 节第 4 条如实登记，不写「完整验收通过」。CHANGELOG 仍未改（A 是内部阶段，未发版、未打包发布）。
- Tauri 桌面热重载已启动：Rust debug 编译完成，桌面窗口运行，后端 `127.0.0.1:17892`、Vite `5173`，`tsx watch` 已多次随改动自动重启。这是开发环境，不等于第 11 节要求的「桌面跨轮验收」。

### 13.3 剩余工作与边界

- ~~**取消注入**：未做真实 `AbortSignal` 并发取消注入~~ → 已补 `tests/presentation-contract-cancel.test.ts` 4 项，见 13.1；仍未做完整长任务进程级取消（中断已在运行的 HTTP 生成请求），属于 C 阶段。
- ~~**真实渠道 6 轮**：未跑~~ → 修复后完整 6 轮 **6/6 通过**，见 13.2。仍未做的是人手在桌面窗口逐轮点击的冒烟与 WPS 像素级视觉检查；复验命令：`npm run eval:contract:real -- --real --i-authorize-billing --api http://127.0.0.1:17892`（可加 `--rounds N` 控制成本）。
- ~~原 `scripts/evaluate-presentation.ts` 仍用 `chapters+1` 期望值~~ → 已用 `--pages` 解耦，压缩场景另查正文可见事实与数值；与独立 fixture 保持职责分离（参数化质量评测 vs 固定契约评测），不做强行串联。
- **溢出内容藏进备注**：压缩场景红灯已复现（见 13.2），渲染器溢出策略的修改属于 D2，A 阶段不动 `presentation-templates.ts`。
- **质量状态**：文件卡只展示可用状态、可见覆盖与首次可用时间，未展示完整四段时间线；后台视觉检查（B）才会在更多路径写 `optionalVisualCompletedAt`。
- **后续阶段**：B 已完成，见第 14 节；C 第一刀已完成，见第 15 节；C 的性能指标/缓存剩余部分、D（设计系统）、M（原包修改）、E/F 未开工。
- **真实验收口径**：真实渠道 6 轮已按用户授权通过（见 13.2），会话与 PPTX 保留在桌面端；脚本通过本机 API 驱动同一后端，不是人手在窗口里逐轮点击。WPS 加载项在线（端口 58890）但本轮未做像素级视觉检查，故只写「6/6 通过 + 已登记未验证项」，不写「完整验收通过」。

按第 11 节要求：未跑真实渠道不写验收结论；CHANGELOG 在实际功能完成前不记录；本轮不打包、不发布、不提交 Release。

## 14. B 阶段实现状态（2026-11-07）

对应 §5.3 / §5.4 与第 9 节增量 B。**B 的测试是在实现完成后补齐的，未严格采用「先写失败用例再改代码」**（A 阶段采用了该流程）；所有断言覆盖的是实现后行为，验收口径按文档逐条核对。

### 14.1 已实现

| 范围      | 落地位置                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候选状态迁移  | `db-schema.ts`：`workspace_documents` 加 `state`（历史行默认 `published`）与 `candidate_meta`；新增 `document_publish_log`（candidate hash / 目标名 / 操作 ID / validationId / disposition，`conversation_id + operation_id` 唯一）                                                                                                                                                                                                                                             |
| 发布契约类型  | `src/shared/document-publish.ts`：`PublishInput / PublishResult / CandidateMeta / VisualPolicy / CANDIDATE_TTL_MS / CANDIDATE_OPERATION_PREFIX`；`validationId: string \| null`，null 仅用于无任务契约的普通文档                                                                                                                                                                                                                                                         |
| 路径工具抽离  | `src/server/workspace-paths.ts`：`safeName / workspaceDir` 从 `documents.ts` 抽出，避免 `documents.ts ↔ document-publish.ts` 循环依赖；安全语义（会话校验、越界、符号链接）不变                                                                                                                                                                                                                                                                                                          |
| 候选创建    | `src/server/document-publish.ts` 的 `createCandidateDocument`：原子写文件 + 登记 `state='candidate'`，`operation_id` 用 `candidate:` 前缀与正式发布隔离；同操作同字节复用、字节变化则旧候选与其检查一并作废；支持 `lease` 与 TTL                                                                                                                                                                                                                                                                           |
| 统一发布    | `publishDocument` 是唯一把 `state` 改为 `published` 的入口。发布前复核：正式幂等日志、候选归属、磁盘字节哈希、执行所有权、契约 specId/revision、可信 `validationId` 的绑定哈希与 revision、基线一致性、取消状态。安全/归属类失败（`SPEC_OWNERSHIP / SPEC_REVISION / SCOPE_VIOLATION / REQUIRED_ASSET / UNPLACED_IMAGES`）不允许以显式 `draft` 绕过；必需约束失败只走 `draft`                                                                                                                                                                       |
| 存储方法    | `db.ts`：`listWorkspaceDocuments(..., {includeCandidates})` 默认只暴露 published、`getWorkspaceDocumentByOperation` 只看 published、新增 `getAnyWorkspaceDocument / addCandidateDocument / getCandidateByOperation / getCandidateById / listCandidateDocuments / deleteCandidateDocument / getPublishLog / publishCandidateDocument`。正式版本号在发布时分配；`pruneWorkspaceFamily` 与 `cleanupWorkspaceVersions` 只处理 published；`deleteConversation` 补清 validations 与 publish log |
| 保存链路接入  | `chat-tools/documents.ts` 的 `saveWorkspaceDocument` 改为「创建候选 → A 统一硬检查 → publish」；无契约/普通文档沿用 `validationId=null` 的直接发布；容量配额用 `includeCandidates:true` 把候选计入；晚到结果命中正式幂等，不刷版本                                                                                                                                                                                                                                                                               |
| 视觉与质量策略 | `ContractCheckContext` 增 `visualPolicy / visualReview`；默认 `background`（硬检查通过即 ready 交付），`before_publish` 下视觉检查未完成抛 `PublishPending`、候选保留等待。质量状态仍走 A 的 `presentation-status.ts` 投影，不并入 `ExecutionState`；后台检查只更新报告不产生版本                                                                                                                                                                                                                                    |
| 恢复对账    | `reconcileCandidates`（重启核对候选登记与磁盘字节，清理孤儿，不重建/不重复加版本）、`cleanupExpiredCandidates`（只删无租约、无活跃家族引用、已过期的候选）；`src/server/index.ts` 启动时各跑一次，另有 6 小时 unref 低频清扫，不引入独立常驻进程                                                                                                                                                                                                                                                                                         |
| B 验收用例  | `tests/document-publish.test.ts` 12 项：候选隐藏、publish 唯一入口与版本分配、幂等键分离与晚到结果、候选字节变化后旧 validation 作废、安全失败不可 draft 绕过、before_publish 阻塞与 background 放行、TTL 保护租约/活跃引用、重启对账清理孤儿、无契约普通文档、blocking 时中间稿留在候选区、历史文件默认 published、检查完成再交付不刷版本                                                                                                                                                                                                                           |

### 14.2 本地验证

- `npx vitest run --config vitest.config.ts`：**95 个测试文件、676 项全部通过**，退出码 0（新增 `tests/document-publish.test.ts` 12 项）。
- `npx tsc --noEmit`、`npm run build`：通过；仅既存的 Vite 大包提示。
- `npm run eval:contract`：离线 **10/10**，C01–C06 与 N01–N04 全绿 —— 说明 A 的跨轮契约评测在 B 的候选/发布链路下行为不变。
- 热重载后端随 `src` 改动多次重启并正常监听 `127.0.0.1:17892`，新列迁移未报错。
- **B 改造后的真实渠道最短冒烟（用户已授权计费）**：`npm run eval:contract:real -- --real --i-authorize-billing --api http://127.0.0.1:17892 --rounds 2` → **2/2 通过，退出码 0**。会话 `8b290cc6-…`，报告 `artifacts/presentation-contract-eval-real/2026-11-07T08-25-14-636Z/report.json`；R1 只存要求不产文件（21.8s），R2「开始」产出 **10 页**（317.0s）。环境：Tauri 热重载开发版、后端 v2.3.4、引擎 `template`、模型 `deepseek-v4.1-flash-1017`、18 章虚构资料。说明候选/发布两阶段改造没有破坏真实生成与文件卡读数。
- **B 之后完整真实 6 轮复验**：第一次 **5/6**（会话 `e484bca5-…`，报告 `2026-11-07T08-34-39-882Z/report.json`）。R1–R4、R6 通过；R5「改成 12 页」耗时 302.8s 但**没有产生新文件**，消息序列显示模型连续 10 次只读调用后收到 `渠道返回了无法验证的工具调用。请重试或切换对话模型`（`agent.ts:619`，服务端已自动重试一次仍失败），从未进入 `doc_convert` / 保存环节 —— 属渠道侧 function call 协议偶发失败，与 B 的候选/发布代码无关。
  - 处理：给评测脚本加 `--max-round-retries`（默认 1），**只对明确的渠道协议错误**重发同一指令并如实记录 `roundRetries`；页数不符、草稿、超时等真实失败不重试，避免掩盖缺陷。
  - 重跑（会话 `d5b4bcde-…`，报告 `2026-11-07T08-59-37-930Z/report.json`）：**6/6 通过，退出码 0**，逐轮 10 → 10 → 10 → 12 → 分叉 8 页，R5 产出 12 页（344.6s），未触发重试。至此 B 之后的完整真实跨轮验收通过。

### 14.3 未完成边界

- ~~**真实渠道冒烟**：待跑~~ → `--rounds 2` 2/2 与 B 之后完整 6 轮 6/6 均已完成，见 14.2（含一次渠道协议失败与重跑记录）。
- **before_publish 的用户入口**：策略已在 `ContractCheckContext` 与 `publishDocument` 打通并有测试，但 `doc_convert / doc_edit` 尚未从用户自然语言里解析「检查完成再交付」，当前所有真实调用仍走默认 `background`。
- **视觉检查结果来源**：`visualReview` 目前由调用方显式传入，未与 `presentation_versions.visual_state` / WPS 后台队列打通（属 C）。
- **容量与清理**：TTL 清扫已接启动钩子，但「任务已终止」的判定目前依赖 `lease` 与家族活跃引用，未与 `workflow-store` 的终态逐一对账。
- **后续阶段**：C 第一刀已落地（第 15 节），C 剩余的性能指标、跨版本缓存与真实性能验收、D、M、E/F 未开工。B/C 均未改 `CHANGELOG`、未提交、未打包、未发布。

## 15. C 阶段第一刀实现状态（2026-11-07）

对应 §4、§6.1、§7.4 与第 9 节增量 C 的**第一刀**：把「整稿处理」改成由服务端推导的 ChangeScope 驱动三集合。这一轮**先写了失败用例**（纯函数层 import 失败、视觉层仍整稿遍历、端到端接入缺失），红灯确认后再实现。

### 15.1 已实现

| 范围               | 落地位置                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChangeScope 纯函数层 | `src/shared/change-scope.ts`：`deriveChangeScope`（按 `pages / appendSlides / order / design / imageAssetIds` 推导 `effects`，页码去重升序、越界拒绝，**服务端推导、模型不能自报**）、`resolveCheckSets`（`appearance / order / page_count / shared_resource` 任一命中即扩域到全稿）、`changeScopeCacheKey`（含 fileId/sha256/targets/effects + 主题/资源/渲染尺寸/引擎版本/检查策略） |
| 局部视觉检查           | `src/server/presentation-visual-review.ts`：新增 `pageNumbers?: number[]`（1-based 原页码）与 `VisualReviewResult.checkedPages`；只遍历选中页、用 `pages[page-1]` 取截图，**模型 payload、issues、进度文案全部保留原页码**；WPS 仍渲染整稿并在 summary 里如实声明「其余页沿用既有检查结果」；缓存键升级 `visual-v2` 含原页码、页面指纹、检查策略与主题                                                       |
| `doc_edit` 接入    | `chat-tools/documents.ts`：按操作参数推导 ChangeScope → `resolveCheckSets` → 把 `visualPages` 传给视觉回调；`localOnly` 改用 `!checkSets.widened`；`ContractCheckContext` 增加 `checkSets`                                                                                                                                                  |
| Agent 回调透传       | `src/server/agent.ts` 的 `visualReview` 回调接收 `pageNumbers` 并传给 `reviewRenderedPresentation`；新建文档不传，保持整稿检查                                                                                                                                                                                                               |
| 报告指标             | `src/shared/presentation-report.ts` 增加可选 `checkSets`（contentPages / auditPages / visualPages / widened / reason），由 `saveWorkspaceDocument` 在有任务契约时写进版本报告                                                                                                                                                               |
| 性能指标（§7.4）       | `presentation-visual-review.ts` 产出 `VisualReviewMetrics`：实际提交模型的页集合、`modelCalls`（只算真实调用，缓存命中单列）、`cacheHits`、`modelMs`，以及 `wps.renders / exportedPages / renderMs`；`TemplateReport.metrics` 落盘，`doc_edit` 与 `presentation-revision` 的 review 动作都写入。WPS 导出页数如实记整稿，不宣称只处理一页                                               |
| revision 接入      | `presentation-revision.ts` 的 review 动作显式传原页码 `1..count` 并把视觉指标写进报告；即使以后改成真正的局部子集，页码也不会被重编号；`audit` 动作把抽样审校页集合写进 `checkSets.auditPages`                                                                                                                                                                                                                             |
| 评测脚本健壮性          | `scripts/evaluate-presentation-contract-real.ts` 增加 `--max-round-retries`（默认 1）：**只对明确的渠道协议错误**重发同一指令并记录 `roundRetries`；页数不符、草稿、超时等真实失败不重试                                                                                                                                                                             |
| 局部视觉性能验收 | 新增 `scripts/verify-presentation-local-visual.ts` + `npm run eval:local-visual`：在已有十页会话上 PATCH 开启看图、只改指定页，核对「视觉页集合 = 目标页」并输出模型调用/缓存/WPS 导出页数与耗时；**必须校验本轮新增 pptx**，避免读旧产物假通过；支持 `--pages` 逐轮换页与多次取中位数 |
| 按证据复用（§6.1） | 视觉缓存键改为「引擎/模型指纹 + 检查策略 + 原页码 + 页内容与截图指纹 + 主题」，**不再包含文件哈希或截取位置**：新版本里内容与呈现相同的页可复用旧结论，页内容变化则自然失效。`doc_edit` 原先只有 `converting` 才传缓存，已改为与新建共用 `presentation_batch_cache` |
| C 用例             | `tests/change-scope.test.ts` 7 项（局部/扩域/越界/缓存键）、`tests/change-scope-visual.test.ts` 8 项（只提交第 3 页、原页码、整稿回归、去重与越界、指标分开记、缓存命中、跨版本按证据复用、页内容变化失效）、`tests/change-scope-edit.test.ts` 2 项（doc_edit 端到端：局部收窄与整稿换色扩域、报告记录三集合）                                                                                                                     |

### 15.2 验证

- `npx vitest run --config vitest.config.ts`：**98 个测试文件、693 项全部通过**，退出码 0（新增 C 用例 17 项）。
- `npx tsc --noEmit`、`npm run build`：通过；`npm run eval:contract` 离线 **10/10**；热重载后端 `/api/health` 正常。
- 回归修复：`deriveChangeScope` 初版对 `pages: []` 过严，破坏 `tests/presentation-edit.test.ts` 的既有行为（空 pages 搭配 `appendSlides/design`）。已改为「完全没有 effect 才拒绝」，该项恢复全绿。
- **B 之后完整真实 6 轮复验**（在 C 改动之前执行）：第一次 5/6（R5 渠道协议错误、未产出文件），加有限重试后重跑 **6/6 通过**，详见 14.2。
- **C 改动后的真实渠道冒烟（用户已授权计费）**：`--rounds 4 --max-round-retries 1` → **4/4 通过**，会话 `91306b47-…`，报告 `artifacts/presentation-contract-eval-real/2026-11-07T09-37-32-587Z/report.json`。R1 18.7s、R2 317.9s、R3 222.8s、**R4「改第 3 页」61.2s 产出 10 页**。
  - 读取真实产物的 `presentation-status` 确认：R4 修改版报告 `checkSets = {contentPages:[3], auditPages:[3], visualPages:[3], widened:false}`、`readiness: ready` —— **ChangeScope 的局部收窄在真实链路生效**。
  - 同一会话 R3「换风格」的产物报告 `checkSets = [1,2,3,7,8]`、`widened:false` —— 模型实际只重写了 5 页而没有提交整稿 `design`。C 的指标把「声称换风格、实际只改 5 页」如实暴露出来，这是可观察性提升；最终是否算作整稿换风格仍取决于模型提交的操作，属 D3/抽查范畴。
  - `metrics` 为空：评测会话创建时 `visionEnabled:false`，真实链路未走视觉模型，局部视觉耗时仍只由单元/集成测试覆盖。
- **真实局部视觉验收（用户已授权计费；渠道已确认支持看图）**：新增 `scripts/verify-presentation-local-visual.ts` + `npm run eval:local-visual`，在已有十页会话 `91306b47-…` 上 PATCH 开启看图，发「把第 3 页改成卡片结构，其余页保持完全不变」：
  - 结果：**视觉页 `[3]`**、模型调用 2 次（初始检查 + 修补后复查）、缓存命中 0、模型耗时 **78,003ms**、**WPS 导出 10 页 / 3,799ms**、总耗时 **131,656ms**；报告 `artifacts/presentation-local-visual/2026-11-07T09-56-36-164Z/report.json`。
  - 这补上了 C 之前完全空白的两个问题：**局部视觉检查确实只提交第 3 页**（2 次调用都针对该页）；**WPS 仍整份导出 10 页**，如实记录，不宣称 Office 只处理一页。
  - 耗时构成：视觉模型约占 78s / 132s，WPS 渲染约 3.8s；即使只检查一页，真实成本仍明显高于不开启看图的纯修改（同会话 R4 为 61s）。
  - 追加样本（`--pages 5,7 --repeat 2`，逐轮改不同页，避免模型拒绝重复导出）：第 5 页视觉页 `[5]`、模型 1 次、35,051ms、WPS 10 页/2,211ms、总 **228,543ms**；第 7 页视觉页 `[7]`、模型 1 次、23,085ms、WPS 10 页/1,910ms、总 **160,515ms**。三个单页样本总耗时中位数 **160,515ms**（131,656 / 228,543 / 160,515），报告 `artifacts/presentation-local-visual/2026-11-07T10-01-17-437Z/report.json`。
  - 三次都是**不同页**的单页局部修改，严格程度低于「同一资料同一页重复三次」；后者不可行的原因见下一条。
  - **评测脚本口径修正（一次假通过）**：最初对同一页连续跑两次时，模型正确拒绝「第 3 页已经是卡片结构，再导出只会多出一个内容相同的版本」，脚本却读了旧产物的指标并判 PASS。已改为**必须校验本轮新增 pptx**，否则记 `noNewVersion`、不计入成功样本也不判脚本失败；并新增 `--pages` 支持逐轮换页。

### 15.3 C 剩余与边界

- ~~**跨版本缓存**：未做按证据复用~~ → 视觉检查已改为按证据复用（键=引擎/模型指纹+策略+原页码+页内容与截图指纹+主题），`doc_edit` 与 revision 都接入 `presentation_batch_cache`，C16/C17 覆盖跨版本命中与内容变化失效。**`changeScopeCacheKey` 尚未用于内容生成/审校阶段**，那部分仍按 operationId+页码缓存。
- **性能指标**：视觉阶段已落盘并取得三个真实单页样本与中位数；**内容生成与内容审校阶段的 calls/tokens 仍未逐阶段记录**；同页冷/热缓存对比未做（模型会拒绝重复导出，需另设计用例）。
- **入口覆盖**：`presentation-revision.ts` 的 `review` 与 `audit` 都已记录各自页面集合并保留原页码；`before_publish` 的 `visualReview` 仍未与 WPS 后台队列 `visual_state` 打通（策略接口与测试已有，缺队列联动）。
- ~~**真实性能验收**：未测视觉耗时~~ → 已用 `npm run eval:local-visual` 在开启看图的真实会话上测到三个单页样本（见 15.2），总耗时中位数 160,515ms。剩余：**同页冷/热缓存对比未做**（同页重复会被模型拒绝重复导出，需要另造内容微调或改成「先清空再改」的用例）；**内容生成与内容审校阶段的 calls/tokens 仍未逐阶段记录**。不承诺「必定 N 秒」。
- **后续阶段**：D1 已完成，见第 16 节；D2（主题/组件/槽位）、D3（重复提示升级与评测）、M（原包修改）、E/F 未开工。C 未改 `CHANGELOG`、未提交、未打包、未发布。

## 16. D1 整稿职责与布局计划实现状态（2026-11-07）

对应 §6.3 的 D1：「整稿规划增加 role、seriesId、layoutId」，完成标准是「页数和内容不丢，计划控制页面表达」。

### 16.1 已实现

| 范围 | 落地位置 |
| --- | --- |
| 职责与版式纯函数层 | `src/shared/presentation-roles.ts`：8 种 `PageRole`（claim/evidence/comparison/process/case/action/section/appendix）、`preferredLayouts` 候选版式（首选 + 降级）、`inferRole` 按标题与位置确定性兜底、`findRepeatedRuns` 连续同构图检测（同一 seriesId 不算重复）、`layoutFitsRole`。版式字面量与 `slideContentSchema` 由测试断言不漂移 |
| 规划输出 | `presentation-workflow.ts` 的 `outlineSchema.pages` 增加可选 `role / seriesId`，总策划提示词要求分配职责与系列并说明「同系列允许一致」；规划回退（`planningFallback`）也按位置推断职责，避免整稿退化成一类页面 |
| 内容生成 | 每页的 `input` 增加 `pageRole / preferredLayouts / seriesId / deckRoles`（整稿角色分布）；内容策划提示词给出「职责→版式」映射并明确「连续三页不要同一版式，除非同 seriesId」。角色缺失时用 `inferRole` 兜底 |
| 报告 | `TemplateReport.deckPlan`：每页 `role / layout / fitsRole / seriesId`，`repeatedRuns`（起始页、结束页、版式、职责集合），以及 `roleDistribution / concentration`。全部只作提示，不参与 `draft` 判定 |
| 职责集中度 | `summarizeRoles`：单一职责占比 ≥60% 时给出 `concentration` 提示。用来补上「模型把大多数单元都标成 claim → 重复检测因职责相同而失效」的盲区（真实链路已复现该盲区） |
| D1 用例 | `tests/presentation-roles.test.ts` 6 项（字面量不漂移、候选版式、兜底规则、连续同构图、同系列豁免、不同版式/同职责不触发）、`tests/presentation-deck-plan.test.ts` 4 项（职责落到每页且内容不丢、同系列不报重复、模型不按职责选版式时被报出、漏填 role 时兜底） |

### 16.2 验证

- `npx vitest run --config vitest.config.ts`：**100 个测试文件、706 项全部通过**，退出码 0（新增 D1 用例 13 项）。
- `npm run eval:contract` 离线 **10/10**；`npx tsc --noEmit`、`npm run build` 通过（首次构建因测试里 `images` 类型断言错误失败，已修）。
- **真实链路（D1 初版，会话 `abfaf56e-…`，报告 `artifacts/presentation-contract-eval-real/2026-11-07T10-15-54-221Z/report.json`）**：R1/R2 通过，产出 10 页（9 正文 + 封面）。真实产物的 `deckPlan` 为：
  - 版式分布 `bullets×6 / table×1 / cards×1 / process×1`，职责分布 `claim×7 / evidence×1 / action×1`，`repeatedRuns = []`。
  - 版式比改造前（整稿 bullets）确有改善，但**模型把 7 个单元都标成 claim**，于是「职责不同才判无理由重复」的规则失效 —— 视觉上仍有 6 页同构，报告却说没有重复。
  - 补强：总策划提示词明确「role 要反映实际职责，不要把大多数单元标成 claim；资料支持时至少出现两类非 claim 职责」；`deckPlan` 新增 `roleDistribution` 与 `concentration`（单一职责占比 ≥60% 即提示），把规划偷懒暴露成可核对的数据；新增 D11–D13 用例复现该盲区。
  - **补强后真实链路（会话 `2dd5be44-…`，报告 `artifacts/presentation-contract-eval-real/2026-11-07T10-23-33-756Z/report.json`）**：R1/R2 通过，R2 162.4s。`deckPlan` 变为：
    - 职责 `claim×2 / evidence×2 / case×3 / comparison×1 / action×1`，`concentration` 未触发；
    - 版式 `bullets×3 / table×1 / chart×1 / cards×3 / comparison×1` —— **9 页里出现 5 种版式**，且每页 `fitsRole=true`；
    - `repeatedRuns=[]`：连续 3 页 cards 属于同一案例系列，按规则正确豁免。
    - 对照初版（`claim×7`、`bullets×6`），这正是 D1 想要的效果：**职责分散后版式自然分散**，而不是靠机械要求「每页不同」。
  - 仍未解决：`readiness` 两次都是 `draft`（必需内容/页数约束未全部通过），属 A 门禁的口径问题，与 D1 的职责计划无关，需单独查。

### 16.3 剩余

- **D2**：主题令牌、组件参数、布局槽位与容量诊断；当前 `presentation-templates.ts` 仍是 7 个 `if/else` 版式 + 固定坐标，款式丰富度未变。
- **D3**：`repeatedRuns` 目前只写报告、不做升级（用户明确要求「每页不同」时才应变成验收条件）；几何签名与相似度阈值未做，也未接固定样例评测。
- `layoutId` 尚未作为**可注册模板包**的标识，只是「推荐版式候选」；模板库仍是内置 7 种。
- 外部文件与 `doc_edit` 侧的整稿计划未接入（`doc_edit` 直接提交 pages，没有职责字段）。
- ~~`readiness` 两次都是 `draft`，原因未查~~ → 已定位并修复，见第 17 节。

## 17. 「成品永远是草稿」的根因与修复（2026-11-07）

### 17.1 根因

真实产物报告里写着：

```
reason: 必需内容「必须保留三个案例」未出现在页面正文（备注不计入）；
        必需内容「先不生成」需要语义核验，未确认可见
visibleCoverage: { required: 2, satisfied: 0, unknown: 1 }
```

`presentation_spec_update` 把**用户的要求句原文**存进了 `requiredContent.description`，而门禁用 `description` 去页面正文做**逐字匹配**。「必须保留三个案例」「先不生成」永远不会出现在幻灯片上，所以满足数永远是 0 —— 产物永久停在草稿。这不是门禁太严，是**把结构性要求和过程指令当成了页面文本**。

### 17.2 修复

| 类别 | 处理 |
| --- | --- |
| 过程指令（先不生成 / 直接生成 / 开始 / 继续 / 换风格…） | 直接丢弃，不落 `requiredContent`（`PROCESS_INSTRUCTION`） |
| 数量型结构要求（「保留三个案例」等） | 解析成 `structure: [{ kind: "case_count", value: 3 }]`，由 D1 的 `deckPlan` 里 `role=case` 的页数核对，不参与逐字匹配（`CASE_COUNT_PATTERN` + 中文数字解析） |
| 用户确实说过的文本（数值 / 单位 / 具体案例标题） | 仍进 `requiredContent`，`verification=deterministic`；**只有能在当前用户消息里逐字找到才接收**（带引号时按引号内文本核对） |
| 模型自己总结的执行要点（「18 个模块归纳压缩进 10 页」「保留免责说明：…」） | **丢弃**。这类句子不会逐字出现在页面上，接收它们等于让产物永久停在草稿 |

- `src/shared/presentation-spec.ts`：新增 `structureRequirementSchema` 与 `structure`（默认空数组，旧数据兼容）。
- `src/server/presentation-spec-store.ts`：`create / update` 支持 `structure`。
- `src/server/presentation-contract-check.ts`：结构要求用 `report.deckPlan.pages.filter(role==="case").length` 核对；**缺少职责计划时记为 unknown，既不谎报满足，也不单独判草稿**（避免修改入口的旧产物被一刀切成草稿）。
- 回归修复：一度把「案例」从确定性关键词删掉，导致具体案例标题（「案例 A：…」）被误判为语义项、离线评测掉到 7/10；已恢复，数量句在前面已经拦截，不会误伤。
- **结构要求必须传给规划**：真实链路验证时出现「要求保留 3 个案例，页面职责计划里只有 0 个案例页」—— 结构约束只被门禁读取，没有进入生成。现已把 `structure.caseCount` 作为 `requiredCaseCount` 传给 `runTemplatePresentation`：总策划提示词要求「至少 N 个 role=case 单元」，规划回退时也保证前 N 个单元承担案例职责（D14/D15 覆盖）。

### 17.3 验证

- `tests/presentation-required-classification.test.ts` 7 项：数量要求进结构约束、过程指令不落库、可验证事实仍进必需内容、无明确要求时逐字回读、职责计划满足/不足、缺职责计划记 unknown、证据绑定原消息，以及「模型自报的执行要点被丢弃」。
- 离线契约评测的 C01 改为**模拟用户已确认的事实**直接写入契约（工具现在只接收用户原话），门禁本身仍按原口径测量。
- `npx vitest run` **101 个测试文件、715 项全部通过**；`npm run eval:contract` 离线 **10/10**；`tsc --noEmit`、`npm run build` 通过。
- 注意：`npx vitest` 在本机会偶发被 SIGTERM（包装层问题，项目既有现象），用 `node ./node_modules/vitest/vitest.mjs run` 直接执行正常。
- **真实链路最终结果（会话 `9e945e09-…`，报告 `artifacts/presentation-contract-eval-real/2026-11-07T11-21-19-561Z/report.json`）**：R1/R2 通过，产物 **`readiness=ready`、`draft=false`、`usableReadyAt` 有值** —— 文件卡不再显示「草稿」。对照修复前的 `draft` + `satisfied:0`，这是本轮要的结果。
  - 但必须说清前提：这份产物**没有 `deckPlan`**，结构要求被记为 `visibleCoverage.unknown=1`，所以「三个案例已满足」这次**没有被真正核对**，ready 来自「没有其他失败项」。职责计划为何缺失（引擎分派或规划回退）尚未确认 —— `presentation_resumes` 表里没有 engine 列可直接查。
  - 产物含 1 张精简页（1/9 ≈ 0.11，低于 `DRAFT_THRESHOLD`），因此 `draft=false`；这也说明「有精简页但未超阈值」不会被升级成草稿，符合 A 的口径。
- **顺带修掉一个环境级阻塞**：`doc_convert` 曾因 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` 中断导致 R2 无产物。该标记不在项目代码里，是宿主环境的文件删除守卫；触发目标正是候选创建里的 `.pending-` 临时文件。已改为 `fs.writeFileSync(full, bytes, { flag: "wx" })` 直接原子创建（目标存在即失败、不覆盖、不写半文件），**正常保存路径零删除操作**；重跑后 R2 恢复正常产出 10 页。

### 17.4 边界

- `doc_edit` 保存时没有 `report`，因此结构要求在修改入口只能记 unknown、不能核对；要真正覆盖修改入口，需要把上一版报告的 `deckPlan` 继承进来（下一步）。
- 结构要求目前只支持 `case_count`；「必须包含某个章节」「必须用某张图」等尚未归类。
- **结构要求与 `deckPlan` 强耦合**：没有职责计划时只能记 unknown、无法核对（第 17.3 节的真实产物就是这种情况）。要让「保留 N 个案例」在所有路径都可验证，需要 legacy 引擎或修改入口也产出职责计划，或改用「正文里出现 N 个不同案例标题」的文本证据。
- 候选文件改为 `wx` 原子写后，写盘中途崩溃可能留下部分文件（原 `.pending-` 方案不会）。若要彻底避免，需要在写入后做长度/哈希自检，或改用 OS 级原子重命名的替代方案。

## 18. 结构要求在每条路径上可核对（2026-11-07）

第 17.3 节留了一个开放问题：真实产物没有 `deckPlan`，结构要求只能记 unknown。本轮把它查清并补上。

### 18.1 真正原因：修改入口保存时不带报告

直接查 `presentation_versions`，同一会话的产物分成两类：

| 文件 | 报告键 |
|---|---|
| 原始 `…_10页大纲.pptx` | 含 **`deckPlan`**、`repairedPages` 等 |
| 三个 `…_10页大纲-修改版.pptx` | **没有 `deckPlan`**，也没有 `fallbackPages/pendingPages` 的原始语义 |

也就是说第 17.3 节读到的「没有职责计划」其实是 `doc_edit` 的产物：

```ts
saveWorkspaceDocument(..., bytes, operationId, undefined /* ← 报告丢了 */, lineage, { plan, ... })
```

`report` 传 `undefined` 时门禁只能拿一份**默认空报告**做校验，于是：

- `deckPlan` 消失 → 结构要求记 unknown；
- 上一版的精简页 / 待补全页信息丢失；
- 修改一页就把整稿的质量上下文一起清空。

这不是「legacy 引擎不产出职责计划」，是**修改入口没有把上一版的整稿计划继承下来**。

### 18.2 修复

| 项 | 内容 |
|---|---|
| 报告继承 | 新增 `src/server/presentation-deck-carry.ts`：`carryDeckReport()` 按**内容指纹**把原页职责对回新页面（未改动页沿用原 `role/seriesId`，被改动页按新标题重新 `inferRole`），重算 `roleDistribution / concentration / repeatedRuns`，并把 `fallbackPages` 等计数过滤到仍存在的页、剔除本轮明确修改的页 |
| 诚实边界 | 整稿内容已变，原内容审校结论不再代表当前文件：`audit` 置 `unavailable`、`issues` 清空；不伪造新的质量结论 |
| 接入 | `doc_edit` 的 PPT 分支读取被改文件的 `getPresentationVersion().report` 并传入 `saveWorkspaceDocument`；没有原报告时返回 `undefined`，保持既有行为 |
| 正文证据兜底 | `countVisibleCaseLabels()`：从**可见文本**（不含备注）统计不同案例标签数（`案例 A` / `案例 1` / `案例三`）。结构要求判定改为取「职责计划 case 页数」与「正文案例标签数」的较大值；两者都没有时才记 unknown |
| 失败口径 | 有证据但不足时明确失败：`要求保留 3 个案例，职责计划里 0 个案例页、正文里 2 个不同案例` |

这样「保留 N 个案例」在**新建、修改、旧产物**三条路径上都能核对，不再依赖某一版引擎是否写了 `deckPlan`。

### 18.3 验证

- 新增 `tests/presentation-deck-carry.test.ts` 7 项：未改页沿用职责、被改页重新推断、计数过滤、`audit` 置为不可用、无原报告时不造报告、正文标签计数、备注不计入、正文满足/不足两种门禁口径。
- `node ./node_modules/vitest/vitest.mjs run`：**102 个测试文件、722 项全部通过**，退出码 0。
- `npm run eval:contract` 离线 **10/10**；`tsc --noEmit` 与 `npm run build` 通过。
- 真实渠道 R1–R4 结果见 18.4。

### 18.4 真实链路结果（R1–R4）

`npm run eval:contract:real -- --real --i-authorize-billing --api http://127.0.0.1:17892 --rounds 4 --max-round-retries 1`
→ **4/4 通过**，会话 `06ebc1a8-1174-4b4f-bce5-2ee5661f49d1`，报告 `artifacts/presentation-contract-eval-real/2026-11-07T11-42-19-489Z/report.json`。

| 轮次 | 结果 | 耗时 |
|---|---|---|
| R1 先保存要求 | 不产生 PPT | 22.7s |
| R2 开始 | 10 页 | 224.1s |
| R3 换风格 | 10 页 | 227.3s |
| R4 改第 3 页 | 10 页 | 68.3s |

直查 `presentation_versions` 对比同一会话的文件：

| 文件 | `deckPlan` | 说明 |
|---|---|---|
| 原始 `.pptx` | 9 页、`case×3`、`claim1/evidence2/comparison1/case3/process1/action1` | 模板引擎产出 |
| R3 修改版 | **10 页、`case×3`** | 继承成功 |
| R4 修改版 | **10 页、`case×3`**，`comparison` 由 1 变 2、`evidence` 由 2 变 1 | 第 3 页改成对比结构后按新标题重新推断，其余页沿用原职责 |

也就是说：**修改入口不再丢掉整稿计划**，结构要求可以在修改版上核对，而且「改了哪一页就哪一页换职责」符合预期。

### 18.5 第二层问题：必需内容仍被整句指令占满

R1–R4 暴露出 `visibleCoverage` 仍然失败，但**不是**结构要求：

```
required: 3, satisfied: 1, unknown: 1
reason: 必需内容「含封面」需要语义核验，未确认可见；
        必需内容「把这份 18 章文档整理成 10 页 PPT」未出现在页面正文（备注不计入）
```

- 「含封面」是**版式/结构**要求，Spec 里已有 `cover` 字段，不该当成页面文字；
- 「把这份 18 章文档整理成 10 页 PPT」是**整句任务指令**，它当然「逐字出现在用户消息里」，所以原来那道「逐字回读」根本挡不住它。

修法（`presentation-spec-tool.ts`）：

| 类别 | 判定 | 处理 |
|---|---|---|
| 封面要求 | `含封面 / 包含封面 / 封面计入 …` | 写 `cover: "include"`，不落 `requiredContent` |
| 整句任务指令 | 含 `做成/整理成/生成/输出/制作/改成/换成 …`，或以 `把/请/帮我/这份 …` 开头，或与整条消息等价 | 丢弃 |
| 引号内原话 | `「…」` / `"…"` | 照收（用户明确要保留的原话优先） |
| 其余 | 逐字出现在用户消息中 | 落 `requiredContent` |

新增 `tests/presentation-required-classification.test.ts` 的 E08（整句指令 + 含封面，真实链路原句复现）与 E09（引号内原话照收）。

### 18.6 验证汇总

- `node ./node_modules/vitest/vitest.mjs run`：**102 个测试文件、724 项全部通过**。
- `npm run eval:contract` 离线 **10/10**；`tsc --noEmit`、`npm run build` 通过。
- 真实渠道 4/4（R1–R4），以及口径修复后的 `--rounds 2` 复验结果见 18.7。

### 18.7 口径修复后的真实复验

`--rounds 2 --max-round-retries 1` → **2/2 通过**，会话 `6e42ba7c-12e9-4c7a-a87c-34c6a9e741e8`，报告 `artifacts/presentation-contract-eval-real/2026-11-07T12-03-42-661Z/report.json`。R1 16.7s（不产文件）、R2 238.1s（10 页）。

产物报告：

```
readiness = ready     draft = false     audit = complete
visibleCoverage = { required: 1, satisfied: 1, unknown: 0 }
deckPlan: 正文 9 页  cases=3  roles={section:1, evidence:3, claim:1, case:3, action:1}
reason: (无)
```

对照第 17.3 节那次「ready 但没有 `deckPlan`、结构要求记 unknown」，这次的区别是**结构要求真的被核对并通过了**：

- `required: 1` —— 只剩「三个案例」这一条结构要求；整句任务指令与「含封面」不再混进 `requiredContent`（封面走 `cover` 字段）；
- `satisfied: 1` —— 由 `deckPlan` 的 `case=3` 判定，不是靠 unknown 蒙过去的；
- `deckPlan` 有 9 页正文、5 种职责（section / evidence / claim / case / action），D1 的职责分布与 A 的结构核对同时成立。

至此，「保留 N 个案例」在**新建、修改、旧产物**三条路径上都能给出确定结论：有职责计划就用它，没有就用正文的案例标签，两者都没有才记 unknown。

### 18.8 仍存在的边界

- `carryDeckReport` 用内容指纹匹配职责，**页序变化（`order`）后仍能对上**，但整页重写且标题也改的情况下会重新推断，可能与原意图不同 —— 它只保证「不丢计划」，不保证「还原人工意图」。
- 正文案例标签计数依赖「案例 + 编号」这种命名习惯；若资料里写成「门店改造」「渠道试点」这类不加「案例」前缀的标题，仍会记 unknown，需要后续接入来源定位（`sourceRefs`）而不是字符串模式。
- legacy 引擎仍不产出 `deckPlan`；它现在靠正文证据兜底，职责/版式分布统计在 legacy 产物上仍然缺失。

## 19. D2 第一刀：主题令牌层（2026-11-07）

### 19.1 做了什么

把「皮肤」从渲染器里抽成数据，**坐标仍由确定性代码算**，模型依旧不输出 `x/y/w/h`。

| 项 | 内容 |
|---|---|
| 令牌类型 | 新增 `src/shared/presentation-theme.ts`：`ThemeTokens = { colors, typography, layout, cover }`。`colors.panel` / `colors.ink` 可省略，省略时按背景推导并保留对比度兜底 |
| 内置主题 | `blue`（商务蓝，与改造前几何完全一致）、`magazine`（杂志风）、`mono`（极简黑白）、`warm`（暖色教学） |
| 真实差异 | 不只是换色：标题字号 28/32/34/38、左边距 0.62–0.9、行高上限 1.05–1.36、强调线从细横条变为竖块（杂志风）或通栏细线（极简）、面板圆角 `roundRect` / `rect` 之别、封面底与封面色独立 |
| 风格映射 | `themeFromText()` 把「杂志风 / 极简 / 暖色教学 / 商务汇报」映射到主题；匹配不到返回 `undefined`，**不硬猜** |
| 工具入口 | `doc_convert` 新增可选 `style`（主题 id 或风格描述）；工具描述明确「整体风格用 style，单页配色仍用 design」 |
| 契约入口 | `PresentationSpec.styleRequest.text` 也参与主题解析，跨轮「换成杂志风」可继承 |
| 报告 | `TemplateReport.theme = { id, name, description, requested }`，让「换了风格到底变了什么」可核对 |
| 一致性 | 单页补做（`presentation-revision.ts`）沿用 `report.theme`，不会出现「补做的一页换了皮肤」 |

优先级：`design`（用户显式给的颜色字体）> 主题令牌 > 推导兜底。深色底上正文仍强制浅色，主题不能把文字压到看不清。

### 19.2 验证

- 新增 `tests/presentation-theme.test.ts` 7 项：主题互异与解析、风格文本映射、几何真实差异、面板形状与字体、design 覆盖且保对比度、封面随主题且纯色封面可读、同主题渲染确定性。
- `tests/presentation-deck-plan.test.ts` 增加 D27/D28：主题进入生成链路并写进报告、未知主题回退默认。
- `node ./node_modules/vitest/vitest.mjs run`：**103 个测试文件、733 项全部通过**。
- `npm run eval:contract` 离线 **10/10**；`tsc --noEmit`、`npm run build` 通过。
- 默认主题输出与改造前逐字节一致（`presentation-workflow` / `presentation-edit` / `presentation-visual-version` 既有断言全绿）。

### 19.3 真实链路验证

真实渠道（`deepseek-v4.1-flash-1017`，8 章虚构资料，请求「做成 8 页 PPT，含封面，整体用杂志风」）：

| 项 | 结果 |
|---|---|
| 会话 | `59863d54-c877-4dfc-a2c1-28b2b983a34e` |
| `report.theme` | `{ id: "magazine", name: "杂志风", requested: "magazine" }` |
| `readiness` | **ready**（`draft=false`） |
| `visibleCoverage` | `{ required: 0, satisfied: 0, unknown: 0 }`（本次请求没有可逐字核对的事实，也没有遗留的伪必需项） |

解开 PPTX 逐元素比对，模板路径的产物与令牌完全对齐（单位：英寸 / pt）：

| 元素 | blue 默认 | magazine 实测 |
|---|---|---|
| `accent-rule` | x 0.76 / y 0.45 / 0.48×0.06 | **x 0.62 / y 0.52 / 0.28×0.16**（竖块） |
| `title` | x 0.76 / w 11.80 / h 1.08 / **32pt** | **x 0.62 / w 12.12 / h 1.42 / 38pt** |
| `takeaway` | y 1.76 / 19pt | **y 2.22 / 20pt** |
| `marker-0` | 0.12×0.05（横条） | **0.09×0.52（竖条）** |
| `cover-rule` | y 1.52 / 0.62×0.06 | **y 1.34 / 0.34×0.20** |
| `cover-title` | 32pt | **40pt** |

也就是说：**换主题确实改变了版式几何，而不只是换颜色**，而且全程没有模型输出坐标。

#### 但发现一个真实边界：模型后续改稿会绕过主题

同一会话里，模板产物之后又生成了「修改版」：其正文页元素变成 `p2-rule / p2-title / p2-sub / p2-table` 这类命名 —— 这是**模型自己提交的整页元素**，不是渲染器输出，主题令牌完全不参与。

后果：主题只对「模板渲染器生成的页」有效；一旦模型在 `doc_edit` 里提交自带坐标与样式的元素页，皮肤就被绕开，也解释了历史上「改一版就变成九页同构图」的现象。

这条不是本轮能修的：要治它必须收窄 `doc_edit` 的入参（改为「定位 ID + 声明式参数」，由可信代码算坐标），也就是文档第 12 条的 `PageComposition` 组件契约 —— 属于 D2 后续 / D3。

### 19.4 与文档第 12 条的差距

文档要求的三层契约是 `ThemeTokens` / `PageComposition`（槽位）/ `LayoutResult`（含 diagnostics）。本轮只落地第一层和「按职责选版式」的既有能力，**没有做组件库与槽位声明**：

- 版式仍是 7 个固定分支（`bullets/cards/comparison/process/table/chart/image`），没有可注册的组件定义；
- 「装不下返回诊断」尚未实现：当前仍是「缩字号 → 二分截断 → 溢出内容进备注」，这与第 12 条冲突，属 D2 后续；
- 主题只影响几何与配色，不影响「选哪种版式」，后者仍由职责映射 + 模型选择决定。

## 20. 版式多样性度量（2026-11-07）

讨论「收窄 `doc_edit` 入参会不会降低多样性」时，双方都没有数字。本轮先补尺子，不动架构。

### 20.1 三个口径

`scripts/measure-presentation-diversity.ts` + `npm run eval:diversity`，只读打开已有 `.pptx`，不调模型、不写版本：

| 指标 | 定义 | 为什么需要 |
|---|---|---|
| 骨架多样性 | 元素 id 去掉页码前缀与序号后的类型序列去重数 / 正文页数 | 抓「结构真的不一样」 |
| 几何多样性 | 元素 `x/y/w/h` 按 0.05 英寸量化后排序成串，去重数 / 正文页数 | 抓「换了元素名但布局一样」（第 6.3 节提过的几何签名） |
| 连续同构 | 最长连续相同几何的页数 | 抓「九页同构图」，单看比例会漏掉 |

判据（初版，可校准）：**几何多样性 ≥ 0.6，且最长连续同构 < 4**。作者归属（渲染器 / 模型自由元素）不作为判据，但单独记为提示 —— 它是「主题被绕过」的直接证据。

封面与首屏不计入正文页；`--limit` 默认 10，支持 `--conversation`、`--data`、`--json`；报告写 `artifacts/presentation-diversity/<时间戳>/report.json`。

### 20.2 首次基线（8 个已有产物）

| 会话 | 产物 | 正文页 | 骨架 | 几何 | 最长连续 | 模型排版页 | 结论 |
|---|---|---|---|---|---|---|---|
| `59863d54` | 杂志风修改版（最终稿） | 7 | 4 (0.571) | 4 (0.571) | **4** | 7 | **FAIL** |
| `59863d54` | 杂志风模板原稿 | 7 | 6 (0.857) | 6 (0.857) | 1 | 0 | PASS |
| `4bd4e9e2` | 杂志风修改版 | 7 | 7 (1.0) | 7 (1.0) | 1 | 1 | PASS（含 1 页提示） |
| `6e42ba7c` | 十页源稿（blue） | 9 | 4 (0.444) | 4 (0.444) | 2 | 0 | **FAIL** |
| `06ebc1a8` | 十页修改版 | 9 | 8 (0.889) | 8 (0.889) | 1 | 0 | PASS |

中位数：几何多样性 **0.857**，最长连续 **4**，模型排版页合计 **8**。

两个 FAIL 恰好对应此前的两类抱怨，而且原因不同：

- `59863d54` 最终稿：7 页**全部**由模型自由元素排版，第 3–6 页连 14 个元素与字号都相同 —— 这是「九页同构图」的直接复现；
- `6e42ba7c` 十页源稿：渲染器产出，但 9 页正文只用了 4 种几何，多页因溢出降级成同一种 `bullets + overflow-note` 骨架 —— 这是「款式单一」的直接复现，且与主题无关。

### 20.3 这个数字怎么用

- **扩组件/布局前后各跑一次**，比较几何多样性与最长连续，而不是凭印象说「变好看了」。
- **收窄 `doc_edit` 入参前后各跑一次**，验证「多样性没有下降」这个假设 —— 如果几何多样性掉了，说明组件库还不够，应先补组件再收窄。
- 判据数值（0.6 / 4 页）是**可校准参数**，不是决策；调整前应先在同一批产物上对比新旧阈值，避免为了让结果好看而调阈值。

### 20.4 边界

- 只统计结构，不判断「构图是否贴合内容」：6 页 6 种几何也可能是乱排。
- 章节页（`section`）目前只在标题以 `section/cover` 开头时排除，靠标题识别不可靠，应由 `deckPlan.role` 提供（D3）。
- 模型自由元素页的识别依赖命名习惯（`p2-rule` 这类），命名变了会误判为渲染器产物；后续应改为读 `presentation.json` 的方案标记，而不是猜名字。

## 21. 外部审查的七处入口级缺陷（2026-11-07）

外部代码审查指出七项「模块能工作、但入口之间传递断掉」的问题。逐条核对代码后**全部成立**，本轮全部修复，并补跨入口回归。

| # | 问题 | 修复 |
|---|---|---|
| 1 [P1] | 保存时用 `findActive(conversationId)` 重新挑契约；补做入口用 `findByFamily` 取家族当前 revision | `TemplatePresentation.specRef` 携带本次执行绑定的 `specId + revision` 一路传到 `saveWorkspaceDocument`；`ContractCheckContext.specRef` 优先于 `findActive`；`doc_edit` 与 `presentation-revision` 改用文件报告里的 `specRef`，不再按家族最新 revision 校验 |
| 2 [P1] | 有 prepared 契约时「改成 12 页」被丢弃；两份 prepared 时「开始」盲选第一份；`NEW_TASK_PATTERN` 含「重做」会把「重做第 3 页」判成新任务 | 先解析本轮显式约束：命中页数即 `updateOwned` 追加 revision；多份候选时「开始」也返回消歧提示；`NEW_TASK_PATTERN` 收窄为「整份/全部资料 + 重做/重新/做成」等组合 |
| 3 [P1] | 结构要求无证据时记 `unknown` 但 `ok=true`；`visibleText` 无条件统计 `slide.title`；指定图片只比数量 | 无证据改为 `STRUCTURE_UNVERIFIED` 失败；元素页只统计元素内实际渲染文字（`title` 是元数据）；素材校验改为按 `assetId → imageIndex` 绑定核对，无绑定记录报 `REQUIRED_ASSET_UNVERIFIED`，不猜 |
| 4 [P1] | `runPresentationSpecUpdate` 接受模型传入的 `specId` 直接更新，可跨会话改契约 | 存储层新增 `requireOwned / ownedRevision / updateOwned / setLifecycleOwned`；工具、Agent 激活、断点恢复全部走带归属校验的入口；越权返回失败的工具结果而不是系统异常 |
| 5 [P1] | 门禁判成草稿后，工具仍按检查前的报告返回「已导出」，工作流标记完成并清断点 | `saveWorkspaceDocument` 返回 `{ report, disposition }`；`doc_convert` 用最终报告决定 `paused`、文案与 `uiData`，草稿不再被宣布完成，断点保留 |
| 6 [P1] | `registerFamilyRef / releaseFamilyRef` 只有定义没有调用 | 暂停/待补全的 PPT 家族在保存时登记 `paused` 引用，Agent 清理断点时释放；`pruneWorkspaceFamily` 额外按断点精确匹配整族保留；启动时清理无断点的残留引用，避免磁盘永远清不下去 |
| 7 [P2] | `visualPolicy` 只读 `contract`，业务调用没人传 | 保存时策略取 `contract.visualPolicy ?? spec.visualPolicy`；`presentation_spec_update` 识别「检查完成再交付」并写入 Spec |

### 21.1 新增回归（`tests/presentation-entry-consistency.test.ts`，8 项）

- G01 跨会话改契约被拒且原契约不变；
- G02 已有 10 页时「改成 12 页」生成 revision 2，旧 revision 仍可回溯；
- G03 两份待制作要求时「开始」返回消歧，不盲选；
- G04「重做第 3 页」继承原任务，不新建；
- G05 发布按绑定 revision 校验，会话里 active 已变成 12 页也不影响本次 10 页发布；
- G06 门禁判草稿时 `disposition=draft`、`report.draft=true`，数据库与返回值一致；
- G07 元素页只把标题写进 `title`、没画进元素时，判定为未可见；
- G08「视觉检查完成再交付」写进 Spec 并传到发布层。

### 21.2 验证

- `node ./node_modules/vitest/vitest.mjs run`：**104 个测试文件、742 项全部通过**。
- `npm run eval:contract` 离线 **10/10**；`tsc --noEmit`、`npm run build` EXIT=0；热重载后端健康。
- 行为变更（有意）两处，已同步旧用例：E05 由「未知不阻断」改为「未知即未通过」；图片校验由「有图即算」改为「按素材身份算」。

### 21.3 仍未覆盖的边界

- `doc_edit` / `presentation-revision` 的素材绑定没有接入（只有新建路径记录了 `assetBindings`），修改路径若带 `requiredAssets` 会报 `REQUIRED_ASSET_UNVERIFIED`；
- 「等待视觉检查再发布」只打通了策略传递与等待分支，**恢复发布**（检查完成后自动发布候选）尚未接 WPS 队列，目前会停在候选并给出说明；
- 家族引用是粗粒度开关（命中即整族不清理），暂停任务长期不续做时仍会占住磁盘，只能靠启动清理兜底；
- 本章只做入口一致性，未重跑真实渠道；真实链路需要在下一轮与 D2 扩展一起回归。
