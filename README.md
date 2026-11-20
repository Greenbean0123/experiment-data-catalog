# 实验数据目录 / Experiment Data Catalog

按项目管理实验条件、结果和多种表征数据的本地工具，首次启动自带一个“默认项目”。每个人运行自己的程序，实验记录和附件保存在自己电脑；课题专用的约定（别名、物相预设、编号规则、英文标签）放在各自数据目录的 `local-catalog.json`，见“实验室约定”。

## Windows 桌面试用版

解压 `Experiment-Data-Catalog-Desktop-v0.1-Windows-x64.zip`，双击里面的 **Experiment Data Catalog.exe**。应用会在自己的窗口打开。程序包含 Python，界面使用系统安装的 Microsoft Edge WebView2 Runtime。

- 首次打开会在 `%LOCALAPPDATA%\ExperimentDataCatalog\data` 建立空白实验库。升级时更新解压的程序目录，数据目录可继续使用。
- 使用现有实验库时，通过 `--data-dir` 传入含 `experiments.sqlite3` 和 `files` 的目录。在 PowerShell 中运行 `& ".\Experiment Data Catalog.exe" --data-dir "D:\实验数据\data"`。
- 本地附件、实验包和备份通过系统保存窗口选择存放位置。关闭应用会停止其本地服务。关闭时若有草稿或正在执行的操作，应用会询问是否退出。
- 桌面版使用本机端口 `18766`，日志在 `%LOCALAPPDATA%\ExperimentDataCatalog\desktop.log`。缺少 WebView2 时可从微软安装 Evergreen Runtime。

开发构建在 Windows x64 上使用 Python 3.12 虚拟环境。安装 `requirements-desktop.txt` 后运行 `python package_desktop.py`，生成的 ZIP 位于 `dist`。

**Desktop trial (Windows x64).** Extract the ZIP and run **Experiment Data Catalog.exe**. The app uses the installed WebView2 Runtime and ships with Python. Its blank catalog is created at `%LOCALAPPDATA%\ExperimentDataCatalog\data`. Launch with `--data-dir` to open an existing catalog folder. Closing the app also stops its local service.

## 浏览器版

1. 解压完整程序文件夹，放在普通本地目录。
2. 安装 Python 3.9 或以上版本，建议使用仍受支持的 Python 3.12+。不需要安装第三方 Python 包。
3. Windows 双击 **启动 实验数据目录.cmd**，浏览器会打开 `http://127.0.0.1:8765`。
4. 左侧选择项目，点旁边的“＋”可新建大项目。点击“新建实验”，选择所属项目并录入样品编号和已知条件；保存后添加数据附件。
5. 用完可双击 **停止 实验数据目录.cmd**。关闭浏览器标签页本身不会停止本地服务。

**会话保护。** 每次启动都会生成新的会话令牌，只有通过启动入口打开的页面能读写数据；本机其他账户或程序即使访问 `127.0.0.1` 端口也无法使用。程序重启后，旧标签页会显示“需要从启动入口重新打开”，再次运行启动入口即可（服务已在运行时会直接打开现有会话）。

右上角 **English / 中文** 可即时切换界面语言，并记住这台浏览器的选择。表格、筛选器、详情、编辑和对比弹窗、操作提示均提供中英文；CSV 的列名和记录状态随当前语言导出。样品编号、备注、文件名和自定义条件保留原文，切换语言不会修改实验数据或清空未保存内容。

右上角 **深色 / 浅色（Dark / Light）** 可切换主题，并独立记住选择；首次使用跟随系统明暗偏好。侧栏、表格、标签、表单与弹窗均适配深色。

导入生成的分类标签、“资料集-”名称和导入说明的英文显示，由数据目录中的 `local-catalog.json` 配置，支持按英文名称搜索。这些标签和句式来自各自的实验记录，因此与数据一起保存并随备份迁移，不写入程序源码。实验系列的已知分类在编辑器、下拉建议、列表和详情中显示当前语言；保存与 CSV 保留原始分类名称，自定义名称保留原文。原始附件、来源路径与自由填写的备注不自动翻译。

实验日期统一手动输入 `YYYY-MM-DD`，如 `2026-11-16`；英文占位为 `YYYY-MM-DD`，中文为“年-月-日”。使用文本输入替代受系统语言影响的原生日历，保存前检查真实日历日期（含闰年），未知日期可留空。

英文模式按 `local-catalog.json` 中的规则显示导入说明的英文正文；详情可展开“Show original text”查看原文，比较和检索同样使用英文显示。编辑器先显示英文预览，通过“Edit original text”展开编辑原始备注；保存其他条件不会把译文覆盖到原文。翻译使用本地已知措辞规则，未接入在线翻译；新增的自由文本和真实路径、文件名保持原样。CSV 和备份继续保留原始备注。

首次启动自动建立空白 `data` 文件夹。运行中的程序只监听 `127.0.0.1`，其他电脑不能直接访问。页面不依赖外部字体、脚本、分析服务或云端接口。

命令行也可以启动（macOS/Linux 使用 `python3`）：

```text
python server.py --open
```

命令行运行时按 Ctrl+C 停止。端口被其他软件占用时可使用 `python server.py --port 8766 --open`；Windows 停止入口针对默认 8765 端口，自定义端口可运行 `python server.py --port 8766 --stop`。

## 能做什么

- **样品结果摘要**：在工作台或详情点击“编辑结果”，点击物相按钮选择或取消，可同时选择多个，也可输入自定义物相。可以记录形貌、结论，并标记“待确认 / 已确认”。在数据预览中，物相按钮立即保存到附件下拉框所选文件所属的样品，叠图可以继续查看。可在 `local-catalog.json` 为项目预设常用物相，新选项也会取自本项目已有标签。输入新标签后点击“添加”或按 Enter，保存也会收录输入框中的标签。可关联本样品已有的 XRD、TEM 或其他证据附件，点击证据可打开预览。
- **按结果查找**：“实验列表”的“实验结果”一行可按物相、形貌和确认状态筛选，并与前驱体、溶剂、温度、时间联合使用；可单独查找尚未记录结果的样品。标签精确匹配，混相可选多个标签；导入资料集不参与结果筛选。关键词检索也覆盖结果标签与结论，样品比较、双语 CSV 与完整备份均保留结果及证据关联。
- 结果确认与实验进度独立，结论由用户填写；不从文件名、备注或谱图自动推断物相。旧记录升级后结果为空，旧页面保存不会清空已有结果，复制条件新建样品时清空结果与证据。界面和确认状态提供中英文；自定义结果标签与结论保留原文，不自动翻译。
- 按“项目 → 实验编号 → 样品与数据”组织；可选择单个项目或全部项目。展开后通过独立的内嵌表格查看样品、条件和附件，直接下载前两个文件，更多文件在详情查看。
- **实验管理** 默认显示 Dashboard：当前项目的实验、样品、附件和待补全统计，条件分布表格、样品状态，以及最近更新。条件表可切换前驱体、温度、时间、溶剂 / 配体，只保留“条件值”和“对应实验”两列。点击条件进入匹配列表；点击具体编号直接打开工作台，查看该实验的样品、条件和数据。每行按项目和编号去重；选择全部项目时同时显示项目名，同一实验可以出现在不同条件行。编号超过 8 个时通过“更多实验”展开，切换语言保留展开状态。仅列出未归档实验，排除资料集；未知条件单列在最后，0 为有效值，温度和时间按数值排序。表格随内容自动增高，统一通过页面滚动，不设内部滚动条；表头停留在顶部栏下方，长名称和编号自动换行。“实验列表”标签保留条件检索、展开样品、对比和导出。
- 左侧 **实验工作台 / Experiment workspace** 打开独立工作页：中间检索和选择编号，右上查看条件，右下按类别切换附件与备注。编号支持名称正序 / 倒序，数字按自然顺序排列（2 在 10 前），记住排序且不改变已选实验；编号栏可拖动分隔条、方向键调宽及收起，小屏幕改为上下排列。
- 添加大项目，统计、筛选、对比及 CSV 导出随所选项目更新。使用项目模板或有样品来源关联的记录受模板和来源的项目约束。
- 保存实验编号、样品编号、系列、日期、前驱体、温度、反应/取样时间、溶剂 / 配体和备注。
- **实验共用条件**：同项目、同实验编号的新样品会预填前驱体、温度、溶剂 / 配体及添加量。历史记录中的冲突字段待确认。在样品编辑器勾选“设为本实验的共用条件”并保存，可同步当前样品和沿用共用条件的其他样品，首次设置也会补入可用的空白条件。普通保存用于单独编辑样品；反应 / 取样时间、模板和自定义字段按样品记录。修改历史可恢复样品字段，共用值由样品编辑器管理。
- **前驱体**和**溶剂 / 配体**分别可多选，最多各 20 项。在样品编辑器内新增常用名称，保存后会勾选新项并保留其他选择和草稿。请求超时后读取常用选项确认是否已写入。筛选和条件分布按单项匹配，旧记录中的组合名称保持原样。CSV 的前驱体列显示全部已选名称，实验 ZIP 的清单和完整备份保留多选结构。
- 工作台编号列表显示样品状态，支持待补全、已记录、待表征、已完成四类筛选。实验内只要有一个样品匹配就列出，其他样品保留可查看；状态编辑可更新所选单个样品或全部样品，按钮注明数量。同一批更新中只要有旧版本冲突或记录已归档，整批不写入，避免部分成功。实验完成由用户标记，不由字段填写情况自动推断。
- 添加自定义条件及单位，如前驱体用量、摩尔比、加料时刻和气氛。
- 每个已选的溶剂 / 配体可分别填写添加量，单位选 **mL**、**mmol** 或 **g**。留空表示未知，0 为有效值。编辑、复制条件、工作台、对比、CSV 与完整备份均保留添加量。筛选和条件分组按材料名称。数值按所选单位保存。
- 组合筛选条件，搜索编号、备注、自定义条件和附件名称。
- 展开实验后勾选样品，或用“全选筛选样品”选择当前筛选中的未归档样品（包含折叠组，排除资料集），最多 500 条；折叠实验不会清空选择。选择 2–6 条时可并排比较。
- **批量编辑**：在“实验管理 → 实验列表”选好样品后，点击“批量编辑”。前驱体、温度、时间、溶剂 / 配体、实验状态、物相、形貌、结果确认和结论默认均为“不修改”；只设置需要更新的字段。材料和结果标签支持替换、追加或清空，部分单值字段支持清空。先逐条预览修改前后，再确认整批保存；相同值不重复保存。任一样品已变更或归档时整批不写入，失败保留草稿，响应丢失时先读取核对而不重复提交。
- 批量修改溶剂 / 配体时，保留材料的原有添加量，移除材料的添加量也会删除；新加材料的用量保持未知，具体变化显示在预览中。结果证据保留各样品自己的关联。首版不批量改编号、所属项目、备注、附件、证据或添加量，可在单样品编辑器中修改。
- **修改历史／撤销**：左侧“修改历史”查看当前项目的操作；样品详情中可查看该样品的历史。显示修改前后值，先预览再确认撤销，支持只撤销当前样品或整次剩余操作。编辑、批量编辑、状态更新、归档和恢复均留痕；若相关字段已有后续修改或预览后版本变化，整批撤销取消，无关字段的后续编辑保留。新建会留痕，通过归档管理；附件及常用选项管理不在撤销范围内，暂不提供重做。历史从升级到支持修改历史的版本后开始，更早的修改无法补建。
- **待核对清单**：按项目、类型、处理状态和编号筛选。打开条目可对照实验本照片、来源文字及当前记录。点底部“确认已核对”会更新核对状态，处理说明可选。要修改样品，点“采用此值”或填写确认值，再选“预览回填 → 确认回填”。“暂不采用”需要填写处理说明，已处理项可重新打开。复杂条件可进入样品编辑器，缺失实验可带编号新建。条件和附件检查自动更新，照片冲突由用户处理。撤销核对回填会重新打开对应任务。
- 从已有记录复制条件，新样品编号、实验编号、日期和备注会清空；附件不会重复复制。
- 预置 XRD、NMR、TEM、SEM、XPS、DFT 和其他类别；可新增 Raman、UV-Vis 等自定义类别，各项目共用。保存文件副本与 SHA-256 校验值。
- 导出当前筛选结果为 UTF-8 CSV，可用 Excel 打开。
- **附件管理**：在样品详情的附件旁点“管理”，可重命名、更改数据类别，或移到同一项目中另一个未归档的样品；文件内容和校验值不变。“移到回收站”后附件不再出现在样品、导出和对比中，结果摘要里的证据关联暂时隐藏，恢复后自动回来。左侧 **回收站** 可按当前项目或全部项目查看、恢复（原样品已有同名同类附件时需改名），或永久删除以释放磁盘空间；永久删除不能撤销。回收站中的附件仍包含在完整备份里。附件操作会列在“修改历史”的“附件操作”中，但不在撤销范围内。
- 归档和恢复记录；增量备份到文件夹，或下载包含全部实验和附件的完整 ZIP 备份（见“备份和恢复”）。
- 保留 ByeWind Dashboard 的浅紫、浅蓝统计卡，参考 Shadcn Admin 的紧凑表格与分段导航、Tabler 的轻边框与标签；条件表格占满主区域，样品状态放在右侧，窄屏移到下方。沿用本地双语、暗色、可折叠侧栏、表格和弹窗；侧栏列出全部数据类别及当前项目中的附件数量，点击即可筛选。

实验编号留空时，自动识别 `XY-III-352-01`、`XY-III-352-05` 的主编号为 `XY-III-352`。`redo`、时间点和测量后缀仍保留为各自样品。在 `local-catalog.json` 的 `notebook_prefixes` 中列出前缀后，`XY-1-279` 和 `XY-I-279` 归入同一实验，样品保留原编号。可在编辑器手动填写实验编号调整归属；点击“添加样品”会预填该编号。未识别格式以完整样品编号分组。资料集单列显示在实验之后，不计入实验统计。

筛选按样品实际条件匹配，父行显示匹配数与该实验的样品总数。父行仅在条件一致时显示共同值，不同值或部分缺失会明确提示。CSV 包含折叠组内的匹配样品，并附实验编号与所属项目。

左侧“实验项目”旁的 **＋** 或编辑器中的“新建项目”用于添加大项目。左侧 **数据类别** 可新增、选择或删除类型；上传文件时也能点击类型旁的 **＋**，当前已选文件会保留。删除面板显示所有项目（包含归档）的附件数量：有附件时必须选择另一个类别接收，文件副本、ID、校验值和来源保留；同一样品出现同名同类别冲突时整次操作回滚。至少保留一个类别；默认类别删除后重启不会复现。名称最长 80 字符，不区分大小写去重；自定义名称保留原文，内置标签支持中英文。项目暂不支持删除。

在“实验工作台”中，选择“全部样品”会列出各条件的不同值；选择单个样品可查看自定义条件并打开编辑/上传弹窗。同编号但不同项目的实验分别列出。该页搜索编号和样品，不受实验列表中的条件筛选影响；资料集仍从实验管理的“实验列表”访问。

旧版本首次升级会把原记录归入“默认项目”，保留 ID、条件、备注、附件、修改时间和版本号，附件副本不会移动。数据库结构自动升级，升级前请先使用旧版“完整备份”；升级后的数据库应搭配新版程序。

温度单位统一为 °C，反应/取样时间统一为 min。未知条件应留空；0 是有效数值。同一项目内样品编号必须唯一，包含已归档记录；不同项目允许相同的样品编号和实验编号。附件上传不会改动源文件；同一样品下相同名称和类型的附件不会被覆盖。

单个附件最大 256 MB。仪器原始目录可以先打包成 ZIP，再作为附件添加。“实验工作台 → 数据与备注 → 数据预览”支持 PNG/JPEG/GIF/WebP 图片及 UTF-8 CSV。CSV 前两列为数值时默认显示曲线图，可切换“曲线图 / Plot”和“数值表 / Table”；多列 XRD 文件也支持，例如用 twotheta、yobs 绘图，ycal、bkg、diff 等其余列保留在表格。绘图保留文件顺序，不平滑、不归一化、不推断峰归属。CSV 预览上限 5 MB、20,000 行；表格最多显示 51 行、20 列，长单元格截取前 1,000 字符，完整数据可下载。非数值表格不强行绘图；ZIP、ITX、ASC 等原始格式仍需下载并使用相应软件，不读取 ZIP 内部绘图。

**Experiments** opens a Dashboard with real project statistics and recent records; use **Experiment list** for filtering and comparisons. The separate **Experiment workspace** has natural name sorting (A → Z / Z → A), a resizable experiment list, sample selection, and data categories. Under **Data and notes**, numeric CSV files default to **Plot**, with a **Table** toggle. The first two columns are plotted even in multi-column XRD files; all table columns remain available within the preview limits. **Data categories → Delete** requires a destination for existing attachments; files are preserved, and filename conflicts abort the operation. All previews run locally. Instrument archives remain downloadable files.

**Result summary** records each sample's phases, morphologies, conclusion, and **Pending confirmation / Confirmed** state. In **Edit results**, toggle one or more phase buttons or enter a custom tag. In **Data preview**, toggles save immediately to the sample that owns the selected attachment, with overlays still visible. In the editor, select supporting files already attached to that sample. Clicking evidence opens its preview; archived evidence is downloadable. **Experiment list** combines result filters with synthesis conditions, including a **No result recorded** filter. Search, comparisons, CSV and full backups retain results and evidence links. Result confirmation is separate from experiment progress. Existing records stay unknown after upgrading, older pages preserve results when saving other fields, and copying conditions clears results and evidence. Custom tags and conclusions keep their original language; no automatic phase assignment or translation is performed.

**Shared conditions.** New samples with the same experiment number within a project prefill the available precursors, temperature, solvents / ligands, and amounts. Conflicting historical fields need confirmation. Select **Set shared conditions for this experiment** before saving to update the shared values and the samples using them. An ordinary save edits an individual sample. Enter reaction or sampling time, template fields, and custom conditions for each sample. Undo restores sample fields. To change the defaults for future samples, set them in the editor.

**Bulk edit** in **Experiments → Experiment list** updates selected samples. Use individual checkboxes or **Select filtered samples** to select up to 500 active samples, including collapsed groups; imported datasets are excluded. Comparisons remain limited to 2–6 samples. Precursor, temperature, time, solvents / ligands, progress, phases, morphologies, confirmation and conclusion all default to **Keep unchanged**. Lists support replace, append or clear; some scalar fields can also be cleared. Review each sample's before / after values, then confirm the whole batch. A stale or archived sample aborts all changes; unchanged values do not create revisions. Failed saves retain the draft, and a lost response is checked by reading saved records without repeating the submission. Material amounts are retained for names kept and removed for names dropped; newly added names have unknown amounts. Each sample's evidence links are preserved. This version leaves IDs, projects, notes, attachments, evidence selection and amount entry to the individual sample editor.

**Precursors** and **solvents / ligands** each accept up to 20 selections. Add and select a saved name inside the sample editor. Existing selections and draft fields stay in place. If a response is lost, the editor reads back the saved choices. Filters and condition distribution work by individual component, and historical mixture names are kept intact. The precursor CSV column lists all selected names. The experiment ZIP manifest and full backup retain separate entries. **Temperature** and **time** have saved-value dropdowns plus editable numeric inputs. The **＋** button saves the current number for reuse without saving the experiment. Existing values populate the choices automatically, including zero. Successful sample saves return the authoritative record and revision. If a response is interrupted, the editor checks the saved record without resubmitting. Conflicting edits preserve the draft. Returning to the page refreshes the list when no dialog is open.

工作台的样品选择旁提供 **编辑样品**，直接打开当前样品的编辑器；有多个样品时先选择其中一个，单样品实验可直接编辑。**打开详情** 保留附件上传等操作。顶部搜索框保留 Ctrl+K / ⌘K 和 / 快捷键，弹窗内不抢占焦点。桌面侧栏与主内容处于同一页面滚动布局，继续吸顶显示，并跟随浏览器支持的原生边缘回弹；收起侧栏和小屏布局保留。

**Edit sample** beside the workspace sample selector opens the editor directly. Select one sample first in a multi-sample experiment; **Open details** keeps file upload and other actions available. The compact global search retains its shortcuts without stealing focus from dialogs. Desktop navigation stays sticky in the page scroll flow and follows native edge overscroll where the browser supports it.

温度和时间可直接输入，也可从旁边的常用值下拉框选择，**＋** 将当前数值保存为常用，无需提前保存实验。已有记录中的数值自动收集（包括 0），单位分别是 °C 和 min。保存后立即采用服务器确认的记录和版本更新页面，不依赖再次刷新列表；响应丢失时先读取核对，确认内容相同才认定已保存，不重复提交。真正的版本冲突保留草稿并提示，不自动覆盖其他窗口的修改。回到页面且未打开弹窗时会刷新列表。

溶剂 / 配体名称旁的 **×** 用于从常用列表删除；温度 / 时间先选常用值，再点旁边的 **×**。删除不会修改已有实验，也不会清除当前草稿中的材料或数值；刷新、保存历史记录及重启后仍保持删除。已从常用列表删除的材料在所属历史记录中继续显示和编辑，可通过新增同名选项重新加入常用列表。添加量随每条样品保存，未知时留空；CSV 同时包含带添加量的摘要和独立 JSON 列。

Use **×** beside a solvent / ligand to remove it from saved choices. For temperatures and times, select a saved value, then use **×**. Existing experiments and current draft values are preserved. Deleted options remain removed after reloads, record edits and restarts. Explicitly adding the name again restores it. Each selected material has its own optional amount in **mL**, **mmol**, or **g**. Zero is valid. Leave unknown amounts blank. Edits, condition copies, workspace views, comparisons, CSV exports, and full backups retain the amount and its selected unit. Filtering and grouping use material names.

**Change history / Undo** is available in the sidebar and each sample's details. Inspect before / after values, preview, then confirm undo for the current sample or the remaining batch. Edits, bulk edits, progress changes, archive and restore are recorded. Conflicting field changes or stale preview revisions abort the entire undo; unrelated later edits are preserved. Creation is recorded and managed through archiving. File management, reusable choices and redo are outside this version. History begins when the catalog is upgraded to a version with change history; earlier changes cannot be reconstructed.

**Review queue** filters source conflicts, missing conditions, missing data and manual flags by project, type, status or ID. Compare notebook photos and source text with the current record. **Mark as reviewed** updates the item status and accepts an optional note. To update the sample, choose or enter a value and use **Preview changes**, then **Confirm changes**. Dismissal requires a note. Resolved items can be reopened. Automatic checks refresh as conditions and attachments change. Undoing a review-applied value reopens the item.

## 材料实验通用功能 / Materials lab workflows

- **实验模板**：选定项目，在侧栏打开“实验模板”。可从粉体、薄膜示例开始，添加条件与结果字段，选择文本、数字、单选或多选，并给数字设单位。用 JSON 在项目间复用模板。保存新版后，新样品使用新版，旧样品和复制的条件保留原版本及单位。旧样品可在编辑器选择应用当前模板。必填项在标记“已完成”时检查。标记“未测量”“测量失败”或“未获得目标结果”时，结果字段可以留空。
- **导入文件夹**：选定项目并选择目录或单独选文件，设置样品编号提取规则和数据类别。先预览，可逐行改编号、类别或取消勾选，重新预览后再确认。只有勾选且归属明确的文件会复制，其他勾选项进入待核对。每批至多 300 个文件，单个上限 256 MiB。当前批次保留未成功复制的文件，方便重试。重新打开后可重选原目录，取消勾选已导入项。
- **样品来源**：在编辑样品时选择同项目的来源样品并填写处理过程。每条样品可选一个来源，分样可建多条产物记录。沿后续处理连接各步样品，详情里可查看来源链和直接产物。
- **数值对比与 XRD 叠图**：在实验列表勾选 2–6 个样品并打开对比。已填写数值可并排查看，同项目同模板版本的数值字段可作为散点图坐标。叠图从不同样品各选一份 UTF-8 XRD CSV，前两列须为 2θ（度）和实测强度。每份文件上限 5 MiB、20,000 个非空行。先显示原始强度，可按每条曲线各自的最小值和最大值归一化。原附件保留原始数值。
- **导出实验包**：从工作台打开一个实验，或在实验列表选样品后导出。列表按选中样品所属实验导出同一归档状态下的全部样品，包括筛选隐藏的样品。最多 500 条样品。ZIP 包含样品条件和结果、导出时存在的原附件、校验值及来源引用，省略样品备注和附件来源路径。对外发出前检查附件内容。恢复目录时使用完整备份。

- **Experiment template**. Select a project, choose a powder or film example, then define text, numeric, single-choice or multiple-choice fields for conditions and results. Numeric fields can have units. Move a definition between projects as JSON. New samples use the current version, and existing or copied conditions keep their original version and units. Apply the current version explicitly to older untemplated samples. Required values are checked at **Complete**, with result fields waived for an unmeasured, failed, or no-target outcome.
- **Import folder**. Select a project, choose a folder or individual files, then set the sample ID rule and category. Preview, correct or uncheck rows, and preview again before confirming. Checked files with unresolved matches enter the review queue. Limits are 300 files per batch and 256 MiB per file. For a retry after closing, reselect the original folder and uncheck previous copies.
- **Sample origin**. Choose one parent from the same project and enter the treatment. For splits, create a record for each child. Details link to the ancestor chain and direct children.
- **Comparison plots**. Select 2–6 samples. Use the table or plot signals recorded with the same project and template version. For an XRD overlay, select UTF-8 CSVs from at least two samples with 2θ in degrees and measured intensity as the first two columns. Each file is limited to 5 MiB and 20,000 nonblank rows. The plot starts with measured intensities and supports optional min–max normalization.
- **Export experiment ZIP**. Use the workspace or select samples in the list. The list expands each selected group to all samples in that archive state, including filtered-out samples, up to 500. The package includes conditions, results, original attachments present at export, checksums, and references to outside parents. Stored source paths and sample notes are omitted. Use **Full backup** for recovery.

## 实验室约定（可选）/ Lab conventions

程序本身不含任何课题专用内容。每个实验库可以在数据目录放一个 `local-catalog.json`，保存只适用于自己课题的约定；文件随“完整备份”和“备份到文件夹”一起保存，不属于程序源码，也不要提交到代码仓库。所有键都可省略，不放这个文件时程序按通用方式工作。

```json
{
  "notebook_prefixes": ["AB"],
  "precursor_aliases": [
    {"label": "Compound A (CA)", "aliases": ["CA", "compound-a"]}
  ],
  "phase_presets": {"default": ["Phase I", "Phase II"]},
  "translations": {
    "en": {"自定义核对类型": "Custom review type"},
    "categories": {"温度系列": "Temperature series"},
    "datasetTitles": {"图谱汇总": "Plot collection"},
    "noteLines": {"未知条件保留为空。": "Unknown conditions were left blank."},
    "noteRules": [{"pattern": "^导入来源：(.+)。$", "replacement": "Import source: $1."}]
  }
}
```

- `notebook_prefixes`：这些前缀的编号中，实验本第 1 册写作 `1` 或 `I` 都视为同一册，例如 `AB-1-079` 与 `AB-I-079` 归入同一实验。
- `precursor_aliases`：前驱体的显示名称及别名，只影响显示、筛选和排序（按列出的顺序），保存的原值不变。
- `phase_presets`：按项目 ID 提供结果摘要中的物相按钮；项目中已有的标签仍会自动加入。
- `translations`：英文界面下系列名、资料集名称、导入说明句式和其他自定义标签的译法。

修改后重新打开页面即可生效（`notebook_prefixes` 需重启程序）。

## 数据在哪里

```text
data/
  experiments.sqlite3   项目、条件、记录、附件索引、修改历史与待核对处理
  files/                附件副本，以内部 ID 存储
  review-sources/       待核对来源照片，以内部 ID 存储
  local-catalog.json    本实验库的约定：别名、物相预设、编号前缀、英文标签（可选，随备份保存）
  migration-backups/    数据库结构升级前自动保存的快照（仅在升级时生成）
  .catalog.lock         运行中的程序持有的锁，防止两个程序同时写同一个数据目录
```

不要直接重命名 `files` 内的文件。浏览器缓存不是数据存储位置，清空浏览器缓存不会清除实验记录。

**同一个数据目录同一时间只能由一个程序打开。** 浏览器版和桌面版指向同一个 `data` 时，后启动的一方会提示“此数据目录已被另一个程序打开”并退出，不会写入任何内容。

**数据库结构版本。** 数据库记录结构版本号（`PRAGMA user_version`）。新版程序第一次打开旧库时，先在 `data/migration-backups/` 保存一份原数据库再升级；旧版程序遇到更新版本创建的库会拒绝打开，不做任何修改。

## 备份和恢复

左侧 **完整备份** 打开备份窗口，提供两种方式。左侧入口出现 **!** 表示从未备份或距上次备份已超过 7 天。**CSV 仅用于台账导出，不是完整备份。**

- **备份到文件夹（推荐）**：填写另一块磁盘或移动硬盘上的文件夹完整路径，例如 `E:\实验数据备份`。首次复制全部数据，之后只复制新增附件，并逐个核对 SHA-256；窗口显示进度，关闭窗口后备份继续进行。数据库快照最后写入，中途断电或拔盘时上一次备份仍然完整。`db-history/` 保留最近 30 次数据库快照。可勾选“重新校验备份中已有的文件”检查备份盘是否损坏。程序会拒绝把备份写进当前数据目录、另一个正在使用的实验库，或另一个实验库的备份文件夹。
- **下载完整 ZIP**：生成单个 ZIP 后开始下载，适合发给自己或拷到别处。数据量大时需要等待数分钟，并需要约两倍数据量的临时磁盘空间。已压缩的附件（zip、图片等）直接存入，不再重复压缩。

同一时间只运行一个备份。备份内容包括项目、类别、数据库、已归档记录、全部附件、修改历史、待核对处理及来源照片。

恢复步骤：

1. 停止正在运行的实验数据目录。
2. 保留现有程序及其 `data` 文件夹，作为恢复前备份。
3. 文件夹备份：把备份文件夹里的整个 `data` 文件夹复制到一份干净的程序目录（或用 `--data-dir` 直接指向它）。ZIP 备份：把 ZIP 内的整个 `data` 文件夹解压到干净的程序目录。
4. 启动新目录里的程序，检查记录和附件。

不要合并两个不同的 `data` 文件夹，也不要在程序运行时手工替换数据库。

**Backups.** **Full backup** in the sidebar opens the backup window; a **!** badge means no backup yet or the last one is more than 7 days old. **Back up to a folder** (recommended) mirrors the catalog to a folder on another disk: the first run copies everything, later runs copy only new attachments and verify each SHA-256, and the database snapshot is written last so an interrupted run leaves the previous backup intact. **Download full ZIP** builds one archive before the download starts. Only one backup runs at a time. One program may open a data folder at a time, and catalogs created by a newer program are refused rather than modified; a database snapshot is saved to `data/migration-backups/` before each schema upgrade.

## 分享软件

运行 `python package_app.py` 可生成 `dist/Experiment-Data-Catalog-local.zip`。该包仅包含程序和说明，**排除 data、科研附件、日志与本机研究材料**。接收者需安装 Python，然后解压并启动；首次运行得到自己的空白工作区。

程序包包含完整可编辑源码，页面底部“下载源码”也提供同一文件白名单生成的 ZIP。因复用 New API 的主题代码，当前组合发行版采用 **AGPL-3.0-or-later**，分享时应保留源码、许可证和第三方声明；见 `LICENSE` 与 `THIRD_PARTY_NOTICES.txt`。实验数据不属于软件分发包，也不会因该声明被作为开源代码发布。

这套工具适合个人本地使用。它没有跨电脑同步或多人账号隔离，不应直接把服务开放到公网。若将来需要集中托管、登录权限或多人同步，应另行设计服务端账户和存储体系。

## 检查与故障排查

```text
python -m unittest -v test_server.py
node test_app.cjs
```

Node.js 仅用于前端逻辑测试，正常使用不需要。测试使用临时数据库；不会改动正式实验数据。

如需运行中英文切换及交互的 DOM 集成测试，开发者可额外安装测试工具：

```text
npm install --prefix .test-tools --no-save --no-package-lock --ignore-scripts jsdom@26.1.0
node test_ui.cjs
```

`.test-tools` 不进入分发包。DOM 测试覆盖名称、语言/主题记忆、分组展开、筛选、对比、添加样品、编辑归属、内容保留和错误提示，以及项目隔离、自定义类别、重复名称、上传文件保留，不替代真实浏览器的视觉检查。请使用近期版本的 Chrome、Edge、Firefox 或 Safari。

启动失败时查看 `server-error.log`。浏览器显示连接失败时，重新运行启动入口并刷新。多窗口同时编辑同一条实验时，后保存的旧版本会收到冲突提示；请先保留编辑内容，再刷新核对。

## 设计参考

- [eLabFTW](https://github.com/elabftw/elabftw)：结构化实验条件、单位和模板思路。
- [Grist](https://github.com/gristlabs/grist-core)：关联数据及条件筛选思路。
- [Taste Skill](https://github.com/Leonxlnx/taste-skill)：参考一致的排版、间距、边界对齐、交互反馈和可访问性原则；应用沿用本地控制台布局。未引入其营销页面、字体或运行脚本。
- [New API](https://github.com/QuantumNous/new-api)：基础主题变量、管理控制台侧栏、紧凑表格和圆角弹窗。
- [Dashboard UI Kit — ByeWind](https://www.figma.com/community/file/1210542873091115123/dashboard-ui-kit-dashboard-free-admin-dashboard)：参考用户提供的 Figma 副本，采用 68 px 顶栏、轻边界、20 px 圆角图表面板、浅紫/浅蓝统计卡及右侧最近更新布局；按真实实验数据调整内容。视觉参考按 CC BY 4.0 署名，详见第三方声明。

`web/newapi-theme.css` 基于 New API 提交 `b388140acfd80369ec6243b16869daff1b4051f4` 的 `web/src/styles/theme.css`，保留上游版权和许可声明。布局及交互代码针对实验数据管理流程编写，没有引入 New API 的模型网关或账户系统，也不表示与上游存在合作关系。原独立代码的 MIT 声明保存在 `LICENSE-MIT`；组合发行版按 AGPL 提供。
