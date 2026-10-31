import type { DatabaseSync } from "node:sqlite";

type DbRow = Record<string, string | number | null>;

/** 建表与兼容迁移；按原有顺序执行，允许中断后再次启动。 */
export function initializeSchema(db: DatabaseSync, defaultAssetsDir: string): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        auth_header_name TEXT NOT NULL DEFAULT '',
        secret_env TEXT NOT NULL DEFAULT '',
        endpoint TEXT NOT NULL DEFAULT '',
        upload_endpoint TEXT NOT NULL DEFAULT '',
        upload_headers_json TEXT NOT NULL DEFAULT '{}',
        status_endpoint TEXT NOT NULL DEFAULT '',
        models_json TEXT NOT NULL DEFAULT '[]',
        allow_private_network INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL,
        remote_task_id TEXT,
        remote_meta TEXT NOT NULL DEFAULT '',
        input_json TEXT NOT NULL,
        effective_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        -- 'generate' 是正常生成；'upload' 是用户在对话框里自己传的图（需求.md 问题 4），
        -- 它借这条表占一个 task_id 给 assets 指，但**不是**一次生成
        origin TEXT NOT NULL DEFAULT 'generate'
      );
      CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_remote_idx ON tasks(channel_id, remote_task_id);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        base_dir TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL,
        duration REAL,
        -- 音乐产物的歌名 / 歌词 / 曲风 / Suno custom_id；图片/视频为空
        title TEXT NOT NULL DEFAULT '',
        lyrics TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        remote_clip_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      -- 列表里每个任务都要按 task_id 取产物，没有索引会退化成全表扫描
      CREATE INDEX IF NOT EXISTS assets_task_idx ON assets(task_id);
      CREATE TABLE IF NOT EXISTS diagnostics (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT,
        http_status INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- 风格模板：内置的只读，自定义的可增删改；生成分镜 / 画布时拼到提示词末尾
      CREATE TABLE IF NOT EXISTS style_presets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt      TEXT NOT NULL,
        negative    TEXT NOT NULL DEFAULT '',
        builtin     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      -- 对话式 Agent（AGENT_PLAN.md §5）。产物不复制，靠 task_id / asset_id 指向现有表
      CREATE TABLE IF NOT EXISTS conversations (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        -- chat = 对话创作；board = 无限画布的 Agent 线程，不出现在侧栏
        kind                 TEXT NOT NULL DEFAULT 'chat',
        -- 无限画布线程指向的板 id；普通对话为 NULL
        board_id             TEXT,
        brain_channel_id     TEXT NOT NULL,
        brain_model          TEXT NOT NULL,
        -- 已废弃：老版本的单图画布指针。只被下面那次回填读一次，新代码不读也不写。
        -- 留着这列的另一个原因：回填要 SELECT 它，从建表语句里删掉的话，新库上跑回填会直接 no such column
        current_asset_id     TEXT,
        -- 画布：有序产物 id 的 JSON 数组（[0] 是主图，上限见 MAX_CANVAS_IMAGES）。
        -- NULL 是「还没迁移过」（只可能出现在加列之前就存在的老会话上），'[]' 才是「画布是空的」
        canvas_asset_ids     TEXT,
        status               TEXT NOT NULL DEFAULT 'idle',
        video_confirm_policy TEXT NOT NULL DEFAULT 'auto_only',
        vision_enabled       INTEGER NOT NULL DEFAULT 1,
        verbatim_prompt      INTEGER NOT NULL DEFAULT 0,
        chat_mode            TEXT NOT NULL DEFAULT 'creative',
        context_budget       INTEGER NOT NULL DEFAULT 350000,
        chat_auto_continue_limit INTEGER NOT NULL DEFAULT 20,
        -- 画布助手专用：单轮最多思考几次、任务跑完后最多自动续跑几次
        board_max_rounds     INTEGER NOT NULL DEFAULT 10,
        board_auto_continue_limit INTEGER NOT NULL DEFAULT 3,
        context_summary      TEXT NOT NULL DEFAULT '',
        context_summary_seq  INTEGER NOT NULL DEFAULT 0,
        context_anchors      TEXT NOT NULL DEFAULT '[]',
        -- 分镜的角色参考：auto = 用第一个已完成的图片镜头；manual = 指定产物；off = 不用
        storyboard_reference_asset_id TEXT,
        storyboard_reference_mode     TEXT NOT NULL DEFAULT 'auto',
        auto_continue_count  INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        role             TEXT NOT NULL,
        content          TEXT,
        plan_json        TEXT,
        tool_name        TEXT,
        tool_args_json   TEXT,
        tool_result_json TEXT,
        confirm_json     TEXT,
        task_id          TEXT,
        asset_id         TEXT,
        -- 这条消息附带的脚本文档（[{id,name,charCount}]）；全文存在 conversation_documents 里
        documents_json   TEXT,
        status           TEXT NOT NULL DEFAULT 'ok',
        error_message    TEXT,
        created_at       TEXT NOT NULL
      );
      -- 用户上传的脚本文档。全文只在这一轮喂给大脑，后续靠分镜表的 source_text 回溯
      CREATE TABLE IF NOT EXISTS conversation_documents (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        file_name        TEXT NOT NULL,
        content          TEXT NOT NULL,
        char_count       INTEGER NOT NULL,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_documents_conv_idx
        ON conversation_documents(conversation_id, created_at);
      -- 会话内分镜表：一个会话一张，镜号从 1 开始。
      -- task_id 只指向**最近一次**生成；重跑会覆盖它，旧产物仍在生成历史里
      CREATE TABLE IF NOT EXISTS conversation_shots (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        shot_index       INTEGER NOT NULL,
        source_text      TEXT NOT NULL DEFAULT '',
        prompt           TEXT NOT NULL DEFAULT '',
        -- 出场角色名；空串 = 空镜 / 道具 / 字幕，不带角色参考
        character_name   TEXT NOT NULL DEFAULT '',
        -- 场景名；空串 = 没有场景设定
        scene_name       TEXT NOT NULL DEFAULT '',
        kind             TEXT NOT NULL DEFAULT 'image',
        aspect_ratio     TEXT NOT NULL DEFAULT '',
        dialogue         TEXT NOT NULL DEFAULT '',
        speaker          TEXT NOT NULL DEFAULT '',
        shot_size        TEXT NOT NULL DEFAULT '',
        camera_move      TEXT NOT NULL DEFAULT '',
        sound_effect     TEXT NOT NULL DEFAULT '',
        duration_seconds INTEGER NOT NULL DEFAULT 5,
        video_prompt     TEXT NOT NULL DEFAULT '',
        voice            TEXT NOT NULL DEFAULT 'Kore',
        -- 视频输入：首帧默认用本镜分镜图；这里存用户主动覆盖的首帧 / 尾帧 / 参考图
        video_mode           TEXT NOT NULL DEFAULT 'first-frame',
        first_frame_asset_id TEXT,
        last_frame_asset_id  TEXT,
        reference_asset_ids  TEXT NOT NULL DEFAULT '[]',
        -- 尾帧续写出来的镜头指向来源镜头；普通镜头为 NULL
        parent_shot_id       TEXT,
        task_id          TEXT,
        video_task_id    TEXT,
        voice_task_id    TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_shots_conv_idx
        ON conversation_shots(conversation_id, shot_index);
      -- 分镜里的角色和各自绑定的参考图。名字由助手标注或用户手动输入
      CREATE TABLE IF NOT EXISTS conversation_characters (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        name             TEXT NOT NULL,
        -- 设定图提示词（外貌 / 服装 / 年龄…）
        prompt           TEXT NOT NULL DEFAULT '',
        -- 角色固定音色；空串 = 用镜头 / 默认音色
        voice            TEXT NOT NULL DEFAULT '',
        asset_id         TEXT,
        task_id          TEXT,
        confirmed        INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE(conversation_id, name)
      );
      CREATE INDEX IF NOT EXISTS conversation_characters_conv_idx
        ON conversation_characters(conversation_id, name);
      -- 场景设定图：同一套「先生成、确认、再进分镜」的流程
      CREATE TABLE IF NOT EXISTS conversation_scenes (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        name             TEXT NOT NULL,
        prompt           TEXT NOT NULL DEFAULT '',
        asset_id         TEXT,
        task_id          TEXT,
        confirmed        INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE(conversation_id, name)
      );
      CREATE INDEX IF NOT EXISTS conversation_scenes_conv_idx
        ON conversation_scenes(conversation_id, name);
      -- 镜头图的手动布局。节点本身仍由分镜现算，这里只记用户拖过的坐标；
      -- 镜头的增删不会让这一行变成新数据源，找不到对应节点的行直接忽略。
      CREATE TABLE IF NOT EXISTS conversation_graph_positions (
        conversation_id TEXT NOT NULL,
        node_id         TEXT NOT NULL,
        x               REAL NOT NULL,
        y               REAL NOT NULL,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (conversation_id, node_id)
      );
      -- 无限画布：独立于会话的自由节点画布（FREE_CANVAS_PLAN.md）
      CREATE TABLE IF NOT EXISTS boards (
        id                     TEXT PRIMARY KEY,
        title                  TEXT NOT NULL,
        doc_json               TEXT NOT NULL,
        viewport_json          TEXT NOT NULL DEFAULT '',
        selection_json         TEXT NOT NULL DEFAULT '[]',
        ui_state_json          TEXT NOT NULL DEFAULT '',
        version                INTEGER NOT NULL DEFAULT 1,
        thread_conversation_id TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS boards_updated_idx ON boards(updated_at DESC);
      -- 每次保存前的快照；撤销 / 重做只移动当前版本指针，不删未来快照
      CREATE TABLE IF NOT EXISTS board_history (
        id         TEXT PRIMARY KEY,
        board_id   TEXT NOT NULL,
        version    INTEGER NOT NULL,
        doc_json   TEXT NOT NULL,
        reason     TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(board_id, version)
      );
      CREATE INDEX IF NOT EXISTS board_history_board_idx
        ON board_history(board_id, version DESC);
      -- 派生索引：文档里引用了哪些素材；保存时重建，删素材时按它找节点
      CREATE TABLE IF NOT EXISTS board_assets (
        board_id  TEXT NOT NULL,
        asset_id  TEXT NOT NULL,
        node_id   TEXT NOT NULL,
        PRIMARY KEY (board_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS board_assets_asset_idx
        ON board_assets(board_id, asset_id);
      -- 任务 → 结果节点映射；完成事件和重启恢复都靠它回写
      CREATE TABLE IF NOT EXISTS board_tasks (
        task_id        TEXT NOT NULL,
        board_id       TEXT NOT NULL,
        config_node_id TEXT NOT NULL,
        result_node_id TEXT NOT NULL,
        kind           TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        -- 一个任务可能产出多张图（count > 1），所以主键必须是「任务 + 结果节点」
        PRIMARY KEY (task_id, result_node_id)
      );
      CREATE INDEX IF NOT EXISTS board_tasks_board_idx
        ON board_tasks(board_id, created_at DESC);
      -- 对话里生成、可反复导入无限画布的模板（分镜 / 提示词链 / 自由布局）
      CREATE TABLE IF NOT EXISTS canvas_templates (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        source          TEXT NOT NULL DEFAULT 'agent',
        conversation_id TEXT,
        doc_json        TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canvas_templates_created_idx
        ON canvas_templates(created_at DESC);
      CREATE TABLE IF NOT EXISTS storyboard_projects (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS storyboard_template_assets (
        template_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        PRIMARY KEY (template_id, node_id)
      );
      -- 旧分镜迁移记录：每个会话只迁移一次，避免重复生成画布
      CREATE TABLE IF NOT EXISTS storyboard_migrations (
        conversation_id TEXT PRIMARY KEY,
        board_id        TEXT NOT NULL,
        template_id     TEXT NOT NULL,
        version         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, seq);
      CREATE INDEX IF NOT EXISTS messages_task_idx ON messages(task_id);
      CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at DESC);
      -- 一次大脑调用的 token 用量。单独一张表而不是塞进 messages：
      -- 解析重试、身份纠正这些「同一个消息对应的额外调用」也要算进账里，
      -- 挂在消息上反而得在一堆执行路径里手动累加。
      CREATE TABLE IF NOT EXISTS brain_calls (
        id                TEXT PRIMARY KEY,
        conversation_id   TEXT NOT NULL,
        prompt_tokens     INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        reasoning_tokens  INTEGER NOT NULL,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS brain_calls_conv_idx ON brain_calls(conversation_id, created_at);
    `);
    const channelColumns = db.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
    if (!channelColumns.some((col) => col.name === "upload_endpoint")) {
      db.exec("ALTER TABLE channels ADD COLUMN upload_endpoint TEXT NOT NULL DEFAULT ''");
      db.exec("UPDATE channels SET upload_endpoint = 'https://imageproxy.zhongzhuan.chat/api/upload' WHERE rtrim(base_url, '/') = 'https://api.tiantoken.com' AND adapter_type IN ('wan-video', 'kling-video')");
    }
    if (!channelColumns.some((col) => col.name === "upload_headers_json")) {
      db.exec("ALTER TABLE channels ADD COLUMN upload_headers_json TEXT NOT NULL DEFAULT '{}'");
      db.exec(`UPDATE channels SET upload_headers_json = '{"New-Api-User":"1"}' WHERE upload_endpoint = 'https://imageproxy.zhongzhuan.chat/api/upload'`);
    }
    // Migration: add duration column to assets if it doesn't exist
    const columnsResult = db.prepare("PRAGMA table_info(assets)").all() as Array<{name: string}>;
    const hasDuration = columnsResult.some((col) => col.name === "duration");
    if (!hasDuration) {
      db.exec("ALTER TABLE assets ADD COLUMN duration REAL");
    }
    // Migration: 每条产物记住自己所在的目录，用户改素材目录后旧历史仍然可读
    const hasBaseDir = columnsResult.some((col) => col.name === "base_dir");
    if (!hasBaseDir) {
      db.exec("ALTER TABLE assets ADD COLUMN base_dir TEXT NOT NULL DEFAULT ''");
    }
    // 新生成的记录自带 base_dir；加列前留下的行回填成默认目录
    db.prepare("UPDATE assets SET base_dir = ? WHERE base_dir = ''").run(defaultAssetsDir);
    // Migration: 看图改（AGENT_PLAN.md §11）用的缩略图。存的是相对 thumbs/ 的文件名，
    // 不是绝对路径——数据目录被搬走时它跟着走
    const hasThumbPath = columnsResult.some((col) => col.name === "thumb_path");
    if (!hasThumbPath) {
      db.exec("ALTER TABLE assets ADD COLUMN thumb_path TEXT NOT NULL DEFAULT ''");
    }
    // 音乐产物的歌名；老行默认空串，不影响图片/视频
    if (!columnsResult.some((col) => col.name === "title")) {
      db.exec("ALTER TABLE assets ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    }
    if (!columnsResult.some((col) => col.name === "lyrics")) {
      db.exec("ALTER TABLE assets ADD COLUMN lyrics TEXT NOT NULL DEFAULT ''");
    }
    if (!columnsResult.some((col) => col.name === "tags")) {
      db.exec("ALTER TABLE assets ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
    }
    // Suno 的 custom_id：翻唱 / 混音要引用已有歌曲，必须存下来
    if (!columnsResult.some((col) => col.name === "remote_clip_id")) {
      db.exec("ALTER TABLE assets ADD COLUMN remote_clip_id TEXT NOT NULL DEFAULT ''");
    }
    // messages 建表早于「视频确认卡片」，补上待确认计划的列（§13.6 ①）
    const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!messageColumns.some((col) => col.name === "confirm_json")) {
      db.exec("ALTER TABLE messages ADD COLUMN confirm_json TEXT");
    }
    // 一条用户消息可以引用**多张**已有产物（从画布或消息里拖进输入框的那几张）。
    // asset_id 是个单列，装不下，所以单开一个 JSON 数组；老行读出来就是空数组。
    if (!messageColumns.some((col) => col.name === "asset_refs")) {
      db.exec("ALTER TABLE messages ADD COLUMN asset_refs TEXT");
    }
    // 脚本文档：气泡上只显示文件条，全文在 conversation_documents 里
    if (!messageColumns.some((col) => col.name === "documents_json")) {
      db.exec("ALTER TABLE messages ADD COLUMN documents_json TEXT");
    }
    // 上传的图借 tasks 占一个 task_id（assets.task_id 是 NOT NULL，而重建表会动到真实数据），
    // 靠 origin 把它和真正的生成记录区分开（需求.md 问题 4）
    const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskColumns.some((col) => col.name === "origin")) {
      db.exec("ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'generate'");
    }
    if (!taskColumns.some((col) => col.name === "library_scope")) {
      db.exec("ALTER TABLE tasks ADD COLUMN library_scope TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!taskColumns.some((col) => col.name === "owner_conversation_id")) {
      db.exec("ALTER TABLE tasks ADD COLUMN owner_conversation_id TEXT");
    }
    // 上游任务的附加元数据（Midjourney 的按钮等）；空串表示没有
    if (!taskColumns.some((col) => col.name === "remote_meta")) {
      db.exec("ALTER TABLE tasks ADD COLUMN remote_meta TEXT NOT NULL DEFAULT ''");
    }
    // 画布从一根指针改成一组图（有序列表）：加列 + 把老指针搬进来
    const conversationColumns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    if (!conversationColumns.some((col) => col.name === "canvas_asset_ids")) {
      db.exec("ALTER TABLE conversations ADD COLUMN canvas_asset_ids TEXT");
    }
    // 「原话直发」：有时候用户就是要自己那句话原样发出去，不许大脑润色（需求.md 问题 1）
    if (!conversationColumns.some((col) => col.name === "verbatim_prompt")) {
      db.exec("ALTER TABLE conversations ADD COLUMN verbatim_prompt INTEGER NOT NULL DEFAULT 0");
    }
    if (!conversationColumns.some((col) => col.name === 'chat_mode')) {
      db.exec("ALTER TABLE conversations ADD COLUMN chat_mode TEXT NOT NULL DEFAULT 'creative'");
    }
    for (const [name, ddl] of [
      ["context_budget", "INTEGER NOT NULL DEFAULT 350000"],
      ["chat_auto_continue_limit", "INTEGER NOT NULL DEFAULT 20"],
      ["board_max_rounds", "INTEGER NOT NULL DEFAULT 10"],
      ["board_auto_continue_limit", "INTEGER NOT NULL DEFAULT 3"],
      ["context_summary", "TEXT NOT NULL DEFAULT ''"],
      ["context_summary_seq", "INTEGER NOT NULL DEFAULT 0"],
      ["context_anchors", "TEXT NOT NULL DEFAULT '[]'"],
    ]) {
      if (!conversationColumns.some((col) => col.name === name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${ddl}`);
    }
    if (!db.prepare("SELECT value FROM settings WHERE key = ?").get("chatAutoContinueDefault20")) {
      db.exec("UPDATE conversations SET chat_auto_continue_limit = 20 WHERE chat_auto_continue_limit = 3");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("chatAutoContinueDefault20", "1");
    }
    // 旧版本的默认值迁移一次；其他自定义预算保留。
    if (!db.prepare("SELECT value FROM settings WHERE key = ?").get("contextBudgetDefault350k")) {
      db.exec("UPDATE conversations SET context_budget = 350000 WHERE context_budget = 15000");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("contextBudgetDefault350k", "1");
    }
    const shotColumns = db.prepare("PRAGMA table_info(conversation_shots)").all() as Array<{ name: string }>;
    if (!shotColumns.some((col) => col.name === "character_name")) {
      db.exec("ALTER TABLE conversation_shots ADD COLUMN character_name TEXT NOT NULL DEFAULT ''");
    }
    if (!shotColumns.some((col) => col.name === "scene_name")) {
      db.exec("ALTER TABLE conversation_shots ADD COLUMN scene_name TEXT NOT NULL DEFAULT ''");
    }
    // 分镜从「只有画面描述」升级成「台词 + 景别 / 运镜 + 视频提示词」；
    // 老数据库按列幂等补，历史镜头读到空串 / 默认时长，不会损坏原数据。
    for (const [column, ddl] of [
      ["dialogue", "ALTER TABLE conversation_shots ADD COLUMN dialogue TEXT NOT NULL DEFAULT ''"],
      ["speaker", "ALTER TABLE conversation_shots ADD COLUMN speaker TEXT NOT NULL DEFAULT ''"],
      ["shot_size", "ALTER TABLE conversation_shots ADD COLUMN shot_size TEXT NOT NULL DEFAULT ''"],
      ["camera_move", "ALTER TABLE conversation_shots ADD COLUMN camera_move TEXT NOT NULL DEFAULT ''"],
      ["sound_effect", "ALTER TABLE conversation_shots ADD COLUMN sound_effect TEXT NOT NULL DEFAULT ''"],
      ["duration_seconds", "ALTER TABLE conversation_shots ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 5"],
      ["video_prompt", "ALTER TABLE conversation_shots ADD COLUMN video_prompt TEXT NOT NULL DEFAULT ''"],
      ["voice", "ALTER TABLE conversation_shots ADD COLUMN voice TEXT NOT NULL DEFAULT 'Kore'"],
      ["video_mode", "ALTER TABLE conversation_shots ADD COLUMN video_mode TEXT NOT NULL DEFAULT 'first-frame'"],
      ["first_frame_asset_id", "ALTER TABLE conversation_shots ADD COLUMN first_frame_asset_id TEXT"],
      ["last_frame_asset_id", "ALTER TABLE conversation_shots ADD COLUMN last_frame_asset_id TEXT"],
      ["reference_asset_ids", "ALTER TABLE conversation_shots ADD COLUMN reference_asset_ids TEXT NOT NULL DEFAULT '[]'"],
      ["parent_shot_id", "ALTER TABLE conversation_shots ADD COLUMN parent_shot_id TEXT"],
      ["video_task_id", "ALTER TABLE conversation_shots ADD COLUMN video_task_id TEXT"],
      ["voice_task_id", "ALTER TABLE conversation_shots ADD COLUMN voice_task_id TEXT"],
    ] as const) {
      if (!shotColumns.some((col) => col.name === column)) db.exec(ddl);
    }
    const characterColumns = db.prepare("PRAGMA table_info(conversation_characters)").all() as Array<{ name: string }>;
    for (const [column, ddl] of [
      ["prompt", "ALTER TABLE conversation_characters ADD COLUMN prompt TEXT NOT NULL DEFAULT ''"],
      ["voice", "ALTER TABLE conversation_characters ADD COLUMN voice TEXT NOT NULL DEFAULT ''"],
      ["task_id", "ALTER TABLE conversation_characters ADD COLUMN task_id TEXT"],
      ["confirmed", "ALTER TABLE conversation_characters ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!characterColumns.some((item) => item.name === column)) db.exec(ddl);
    }
    // 分镜角色参考：老会话默认走 auto（第一个已完成的图片镜头）
    if (!conversationColumns.some((col) => col.name === "storyboard_reference_asset_id")) {
      db.exec("ALTER TABLE conversations ADD COLUMN storyboard_reference_asset_id TEXT");
    }
    if (!conversationColumns.some((col) => col.name === "storyboard_reference_mode")) {
      db.exec("ALTER TABLE conversations ADD COLUMN storyboard_reference_mode TEXT NOT NULL DEFAULT 'auto'");
    }
    // 无限画布线程：普通对话默认 chat；board 线程不出现在侧栏
    if (!conversationColumns.some((col) => col.name === "kind")) {
      db.exec("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    }
    if (!conversationColumns.some((col) => col.name === "board_id")) {
      db.exec("ALTER TABLE conversations ADD COLUMN board_id TEXT");
    }
    // 一块板只能有一条 Agent 线程；必须在 kind / board_id 都加完之后再建
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_board_thread_idx
        ON conversations(board_id) WHERE kind = 'board' AND board_id IS NOT NULL
    `);
    // P0 的 board_tasks 是 task_id 单主键，装不下 count>1 的多个结果节点。
    // P1 接入前这张表还没有任何行，所以旧表直接重建；有数据就保留旧表不动。
    const boardTaskColumns = db.prepare("PRAGMA table_info(board_tasks)").all() as Array<{ name: string; pk: number }>;
    const hasCompositeTaskPk = boardTaskColumns.some((column) => column.name === "result_node_id" && column.pk > 0);
    if (boardTaskColumns.length && !hasCompositeTaskPk) {
      const rows = db.prepare("SELECT COUNT(*) AS total FROM board_tasks").get() as DbRow;
      if (Number(rows.total) === 0) {
        db.exec(`
          DROP TABLE board_tasks;
          CREATE TABLE board_tasks (
            task_id        TEXT NOT NULL,
            board_id       TEXT NOT NULL,
            config_node_id TEXT NOT NULL,
            result_node_id TEXT NOT NULL,
            kind           TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            PRIMARY KEY (task_id, result_node_id)
          );
          CREATE INDEX IF NOT EXISTS board_tasks_board_idx
            ON board_tasks(board_id, created_at DESC);
        `);
      }
    }
    /**
     * 回填**键在 `IS NULL` 上，而不是键在「刚加完列」上**，两个原因：
     *
     * 1. 这个项目没有 git 兜底。万一 ALTER 成功、回填跑到一半进程被杀，下次启动还得能补上。
     * 2. 一旦写成 `[]` 就再也不会被回填——所以用户清空画布之后重启，老指针**不会**把画布复活。
     *
     * JSON 在 JS 这边拼，不用 SQLite 的 json_array()：省一个对 JSON1 扩展的依赖，
     * 也和文件里 parseJson 的读写方向对称。
     */
    const legacyCanvas = db
      .prepare("SELECT id, current_asset_id FROM conversations WHERE canvas_asset_ids IS NULL")
      .all() as Array<{ id: string; current_asset_id: string | null }>;
    const writeCanvas = db.prepare("UPDATE conversations SET canvas_asset_ids = ? WHERE id = ?");
    for (const row of legacyCanvas) {
      writeCanvas.run(JSON.stringify(row.current_asset_id ? [row.current_asset_id] : []), row.id);
    }

    // 分镜迁移从 v1（只有镜头节点）升级到 v2（含角色 / 场景设定参考）
    const storyboardMigrationColumns = db.prepare("PRAGMA table_info(storyboard_migrations)").all() as Array<{ name: string }>;
    if (!storyboardMigrationColumns.some((column) => column.name === "version")) {
      db.exec("ALTER TABLE storyboard_migrations ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    }

    // 产品名从「创作板」改成「无限画布」：只改默认标题和 Agent 线程前缀，
    // 用户自己改过的板名不动。
    db.prepare("UPDATE boards SET title = '未命名无限画布' WHERE title = '未命名创作板'").run();
    db.prepare(`
      UPDATE conversations SET title = replace(title, '创作板', '无限画布')
      WHERE kind = 'board' AND board_id IS NOT NULL AND title LIKE '创作板%'
    `).run();

}
