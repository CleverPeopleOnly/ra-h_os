import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DatabaseError } from '@/types/database';

export interface SQLiteConfig {
  dbPath: string;
  vecExtensionPath: string;
}

export interface SQLiteQueryResult<T = any> {
  rows: T[];
  changes?: number;
  lastInsertRowid?: number;
}

class SQLiteClient {
  private static instance: SQLiteClient;
  private db: Database.Database;
  private config: SQLiteConfig;
  private readonly readOnly: boolean;
  private readonly embeddingsDisabled: boolean;

  private constructor() {
    this.config = this.getSQLiteConfig();
    this.readOnly = process.env.SQLITE_READONLY === 'true';
    this.embeddingsDisabled = process.env.DISABLE_EMBEDDINGS === 'true';
    
    // Initialize database connection
    const dbDirectory = path.dirname(this.config.dbPath);
    if (!this.readOnly && !fs.existsSync(dbDirectory)) {
      fs.mkdirSync(dbDirectory, { recursive: true });
    }
    this.db = this.readOnly
      ? new Database(this.config.dbPath, { readonly: true, fileMustExist: true })
      : new Database(this.config.dbPath);
    
    // Load sqlite-vec extension (skip entirely if embeddings are disabled)
    if (!this.embeddingsDisabled) {
      try {
        this.db.loadExtension(this.config.vecExtensionPath);
        console.log('SQLite vector extension loaded successfully');
      } catch (error) {
        // Do not fail hard — allow the app to run without vector features
        console.error('Warning: Failed to load vector extension:', error);
      }
    }

    // Configure SQLite settings
    if (this.readOnly) {
      try {
        this.db.pragma('query_only = ON');
      } catch (error) {
        console.warn('Failed to enable query_only pragma in read-only mode:', error);
      }
    } else {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = 10000');
      this.db.pragma('temp_store = memory');
      this.db.pragma('busy_timeout = 5000');

      // Ensure vector virtual tables are present and healthy (skip if disabled)
      if (!this.embeddingsDisabled) {
        this.ensureVectorTables();
        this.healVectorTablesIfCorrupt();
      }

      // Ensure logging schema (rename memory->logs if needed, create triggers/views)
      this.ensureLoggingAndMemorySchema();
    }

    console.log('SQLite client initialized successfully');
  }

  private getSQLiteConfig(): SQLiteConfig {
    const dbPath = process.env.SQLITE_DB_PATH || path.join(
      process.env.HOME || '~', 
      'Library/Application Support/RA-H/db/rah.sqlite'
    );
    
    const vecExtensionPath = process.env.SQLITE_VEC_EXTENSION_PATH || 
      './vendor/sqlite-extensions/vec0.dylib';

    return {
      dbPath,
      vecExtensionPath
    };
  }

  public static getInstance(): SQLiteClient {
    if (!SQLiteClient.instance) {
      SQLiteClient.instance = new SQLiteClient();
    }
    return SQLiteClient.instance;
  }

  public query<T extends Record<string, any> = any>(
    sql: string, 
    params?: any[]
  ): SQLiteQueryResult<T> {
    try {
      const sqlLower = sql.trim().toLowerCase();
      
      // Handle different query types
      if (sqlLower.startsWith('select') || 
          sqlLower.startsWith('with') ||
          sqlLower.includes('returning')) {
        // SELECT queries and queries with RETURNING clause
        const stmt = this.db.prepare(sql);
        const rows = params ? stmt.all(...params) : stmt.all();
        return { rows: rows as T[] };
      } else {
        // INSERT/UPDATE/DELETE queries without RETURNING
        const stmt = this.db.prepare(sql);
        const result = params ? stmt.run(...params) : stmt.run();
        return { 
          rows: [],
          changes: result.changes,
          lastInsertRowid: Number(result.lastInsertRowid)
        };
      }
    } catch (error) {
      console.error('SQLite query error:', error);
      throw this.handleError(error);
    }
  }

  public prepare(sql: string) {
    return this.db.prepare(sql);
  }

  public transaction<T>(callback: () => T): T {
    if (this.readOnly) {
      throw {
        message: 'SQLite client is read-only',
        code: 'SQLITE_READONLY',
        details: 'Transactions are not allowed in read-only mode'
      } as DatabaseError;
    }
    // Proactively validate/repair vec vtables before any write transaction
    if (!this.embeddingsDisabled) {
      this.healVectorTablesIfCorrupt();
    }
    const txn = this.db.transaction(callback);
    try {
      return txn();
    } catch (error) {
      throw this.handleError(error);
    }
  }

  public async testConnection(): Promise<boolean> {
    try {
      const result = this.query('SELECT datetime() as current_time');
      return result.rows.length > 0;
    } catch (error) {
      console.error('SQLite connection test failed:', error);
      return false;
    }
  }

  public async checkVectorExtension(): Promise<boolean> {
    if (this.embeddingsDisabled) {
      return false;
    }
    try {
      const result = this.query('SELECT vec_version() as version');
      return result.rows.length > 0;
    } catch (error) {
      console.error('Vector extension check failed:', error);
      return false;
    }
  }

  public async checkTables(): Promise<string[]> {
    try {
      const result = this.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      );
      return result.rows.map(row => row.name);
    } catch (error) {
      console.error('Table check failed:', error);
      return [];
    }
  }

  public ensureVectorExtensions(): void {
    try {
      // Test for vec_nodes and vec_chunks; create them if missing
      const hasVecNodes = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('vec_nodes');
      if (!hasVecNodes) {
        this.db.exec(`
          CREATE VIRTUAL TABLE vec_nodes USING vec0(
            node_id INTEGER PRIMARY KEY,
            embedding FLOAT[1536]
          );
        `);
        console.log('Created vec_nodes virtual table');
      }

      const hasVecChunks = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('vec_chunks');
      if (!hasVecChunks) {
        this.db.exec(`
          CREATE VIRTUAL TABLE vec_chunks USING vec0(
            chunk_id INTEGER PRIMARY KEY,
            embedding FLOAT[1536]
          );
        `);
        console.log('Created vec_chunks virtual table');
      }
    } catch (error) {
      console.warn('Vector extension not available:', error);
    }
  }

  private ensureVectorTables(): void {
    if (this.readOnly) {
      return;
    }
    // Wrapper to keep existing public API stable
    this.ensureVectorExtensions();
  }

  private ensureLoggingAndMemorySchema(): void {
    if (this.readOnly) {
      return;
    }
    try {
      // 1) If logs table missing but legacy memory table exists, migrate
      const hasLogs = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").get();
      const hasLegacyMemory = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory'").get();
      if (!hasLogs && hasLegacyMemory) {
        // Drop old view to release dependency
        this.db.exec(`DROP VIEW IF EXISTS memory_v;`);
        this.db.exec(`ALTER TABLE memory RENAME TO logs;`);
      }

      // 2) Ensure logs table exists (fresh install)
      const hasLogsNow = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").get();
      if (!hasLogsNow) {
        this.db.exec(`
          CREATE TABLE logs (
            id INTEGER PRIMARY KEY,
            ts TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            table_name TEXT NOT NULL,
            action TEXT NOT NULL,
            row_id INTEGER NOT NULL,
            summary TEXT,
            snapshot_json TEXT
          );
        `);
      }

      // Ensure nodes table has expected columns for memory nodes
      try {
        const nodeCols = this.db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
        const ensureNodeCol = (name: string, ddl: string) => {
          if (!nodeCols.some(col => col.name === name)) {
            try {
              this.db.exec(ddl);
            } catch (colErr) {
              console.warn(`Failed to add nodes.${name}`, colErr);
            }
          }
        };
        ensureNodeCol('description', "ALTER TABLE nodes ADD COLUMN description TEXT;");
        ensureNodeCol('type', "ALTER TABLE nodes ADD COLUMN type TEXT;");
      } catch (nodeErr) {
        console.warn('Failed to ensure nodes columns:', nodeErr);
      }

      // Ensure chats table tracks creation timestamp for ordering
      try {
        const chatCols = this.db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>;
        if (chatCols.some(col => col.name === 'created_at')) {
          // no-op, column exists
        } else if (chatCols.length > 0) {
          this.db.exec("ALTER TABLE chats ADD COLUMN created_at TEXT DEFAULT (CURRENT_TIMESTAMP);");
        }
      } catch (chatErr) {
        console.warn('Failed to ensure chats.created_at column:', chatErr);
      }

      // 3) Helpful indexes on logs (clean up old names first)
      this.db.exec(`
        DROP INDEX IF EXISTS idx_memory_ts;
        DROP INDEX IF EXISTS idx_memory_table_ts;
        DROP INDEX IF EXISTS idx_memory_table_row;
        CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
        CREATE INDEX IF NOT EXISTS idx_logs_table_ts ON logs(table_name, ts);
        CREATE INDEX IF NOT EXISTS idx_logs_table_row ON logs(table_name, row_id);
      `);

      // 4) Recreate triggers to write to logs (use CREATE IF NOT EXISTS)
      const hasChats = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chats'").get();
      this.db.exec(`
        DROP TRIGGER IF EXISTS trg_nodes_ai;
        DROP TRIGGER IF EXISTS trg_nodes_au;
        CREATE TRIGGER IF NOT EXISTS trg_nodes_ai AFTER INSERT ON nodes BEGIN
          INSERT INTO logs(table_name, action, row_id, summary, snapshot_json)
          VALUES('nodes', 'insert', NEW.id,
                 printf('node created: %s', COALESCE(NEW.title,'')),
                 json_object('id', NEW.id, 'title', NEW.title, 'link', NEW.link));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_nodes_au AFTER UPDATE ON nodes BEGIN
          INSERT INTO logs(table_name, action, row_id, summary, snapshot_json)
          VALUES('nodes', 'update', NEW.id,
                 printf('node updated: %s', COALESCE(NEW.title,'')),
                 json_object('id', NEW.id, 'title', NEW.title, 'link', NEW.link));
        END;

        DROP TRIGGER IF EXISTS trg_edges_ai;
        DROP TRIGGER IF EXISTS trg_edges_au;
        CREATE TRIGGER IF NOT EXISTS trg_edges_ai AFTER INSERT ON edges BEGIN
          INSERT INTO logs(table_name, action, row_id, summary, snapshot_json)
          VALUES('edges', 'insert', NEW.id,
                 printf('edge %d→%d (%s)', NEW.from_node_id, NEW.to_node_id, COALESCE(NEW.source,'')),
                 json_object(
                   'id', NEW.id,
                   'from', NEW.from_node_id,
                   'to', NEW.to_node_id,
                   'source', NEW.source,
                   'from_title', substr((SELECT title FROM nodes WHERE id = NEW.from_node_id), 1, 120),
                   'to_title', substr((SELECT title FROM nodes WHERE id = NEW.to_node_id), 1, 120)
                 ));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_edges_au AFTER UPDATE ON edges BEGIN
          INSERT INTO logs(table_name, action, row_id, summary, snapshot_json)
          VALUES('edges', 'update', NEW.id,
                 printf('edge updated %d→%d', NEW.from_node_id, NEW.to_node_id),
                 json_object(
                   'id', NEW.id,
                   'from', NEW.from_node_id,
                   'to', NEW.to_node_id,
                   'source', NEW.source,
                   'from_title', substr((SELECT title FROM nodes WHERE id = NEW.from_node_id), 1, 120),
                   'to_title', substr((SELECT title FROM nodes WHERE id = NEW.to_node_id), 1, 120)
                 ));
        END;
      `);

      if (hasChats) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS trg_chats_ai;
          CREATE TRIGGER IF NOT EXISTS trg_chats_ai AFTER INSERT ON chats BEGIN
            INSERT INTO logs(table_name, action, row_id, summary, snapshot_json)
            VALUES('chats', 'insert', NEW.id,
                   printf('chat: %s (%s)', COALESCE(NEW.helper_name,''), COALESCE(NEW.thread_id,'')),
                   json_object(
                     'id', NEW.id,
                     'helper', NEW.helper_name,
                     'thread', NEW.thread_id,
                     'user_message', COALESCE(NEW.user_message,''),
                     'assistant_message', COALESCE(NEW.assistant_message,''),
                     'user_preview', substr(COALESCE(NEW.user_message,''), 1, 120),
                     'assistant_preview', substr(COALESCE(NEW.assistant_message,''), 1, 120),
                     'system_message', COALESCE(json_extract(NEW.metadata, '$.system_message'), ''),
                     'input_tokens', COALESCE(json_extract(NEW.metadata, '$.input_tokens'), 0),
                     'output_tokens', COALESCE(json_extract(NEW.metadata, '$.output_tokens'), 0),
                     'cost_usd', COALESCE(json_extract(NEW.metadata, '$.estimated_cost_usd'), 0.0),
                     'cache_hit', COALESCE(json_extract(NEW.metadata, '$.cache_hit'), 0),
                     'model', COALESCE(json_extract(NEW.metadata, '$.model_used'), ''),
                     'tools_count', COALESCE(json_extract(NEW.metadata, '$.tool_calls_count'), 0),
                     'trace_id', COALESCE(json_extract(NEW.metadata, '$.trace_id'), ''),
                     'voice_tts_chars', COALESCE(json_extract(NEW.metadata, '$.voice_tts_chars'), 0),
                     'voice_tts_cost_usd', COALESCE(json_extract(NEW.metadata, '$.voice_tts_cost_usd'), 0),
                     'voice_tts_chars_total', COALESCE(json_extract(NEW.metadata, '$.voice_tts_chars_total'), 0),
                     'voice_tts_cost_usd_total', COALESCE(json_extract(NEW.metadata, '$.voice_tts_cost_usd_total'), 0),
                     'voice_request_id', COALESCE(json_extract(NEW.metadata, '$.voice_request_id'), ''),
                     'voice_tts_request_count', COALESCE(json_extract(NEW.metadata, '$.voice_tts_request_count'), 0)
                   ));
          END;
        `);
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS voice_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER,
          session_id TEXT,
          helper_name TEXT,
          request_id TEXT,
          message_id TEXT,
          voice TEXT,
          model TEXT,
          chars INTEGER,
          cost_usd REAL,
          duration_ms INTEGER,
          text_preview TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_voice_usage_session ON voice_usage(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_voice_usage_chat ON voice_usage(chat_id);
      `);

      // 5) Views: logs_v (drop any legacy memory_v alias)
      this.db.exec(`DROP VIEW IF EXISTS logs_v; DROP VIEW IF EXISTS memory_v;`);
      try {
        this.db.exec(`
        CREATE VIEW logs_v AS
        SELECT 
          m.id,
          m.ts,
          m.table_name,
          m.action,
          m.row_id,
          m.summary,
          m.enriched_summary,
          m.snapshot_json,
          CASE WHEN m.table_name='nodes' THEN n.title END AS node_title,
          CASE WHEN m.table_name='edges' THEN nf.title END AS edge_from_title,
          CASE WHEN m.table_name='edges' THEN nt.title END AS edge_to_title,
          CASE WHEN m.table_name='chats' THEN c.helper_name END AS chat_helper,
          CASE WHEN m.table_name='chats' THEN substr(c.user_message,1,120) END AS chat_user_preview,
          CASE WHEN m.table_name='chats' THEN substr(c.assistant_message,1,120) END AS chat_assistant_preview,
          CASE WHEN m.table_name='chats' THEN c.user_message END AS chat_user_full,
          CASE WHEN m.table_name='chats' THEN c.assistant_message END AS chat_assistant_full
        FROM logs m
        LEFT JOIN nodes n ON (m.table_name='nodes' AND m.row_id = n.id)
        LEFT JOIN edges e ON (m.table_name='edges' AND m.row_id = e.id)
        LEFT JOIN nodes nf ON e.from_node_id = nf.id
        LEFT JOIN nodes nt ON e.to_node_id = nt.id
        LEFT JOIN chats c ON (m.table_name='chats' AND m.row_id = c.id);
      `);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/already exists/i.test(error.message || '')
        ) {
          throw error;
        }
      }
      // Do not recreate memory_v; alias has been removed.

      // 6) Chat memory state tracking for chat-triggered memories
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chat_memory_state (
          thread_id TEXT PRIMARY KEY,
          helper_name TEXT,
          last_processed_chat_id INTEGER DEFAULT 0,
          last_processed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chat_memory_thread ON chat_memory_state(thread_id);
      `);

      // Agent delegation table for orchestrator/worker coordination
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agent_delegations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT UNIQUE NOT NULL,
            task TEXT NOT NULL,
            context TEXT,
            expected_outcome TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            summary TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);
      } catch (e) {
        console.warn('Failed to ensure agent_delegations table:', e);
      }

      // 8) Logs retention trigger (~10k most recent rows)
      try {
        this.db.exec(`
          DROP TRIGGER IF EXISTS trg_logs_prune;
          CREATE TRIGGER IF NOT EXISTS trg_logs_prune AFTER INSERT ON logs BEGIN
            DELETE FROM logs WHERE id < NEW.id - 10000;
          END;
        `);
      } catch {}

      // 7) Ensure agents table schema (backward compatibility)
      try {
        const agentCols = this.db.prepare('PRAGMA table_info(agents)').all() as any[];
        if (agentCols.length) {
          const hasKey = agentCols.some(col => col.name === 'key');
          const hasComponentKey = agentCols.some(col => col.name === 'component_key');
          if (!hasKey && hasComponentKey) {
            try { this.db.exec('ALTER TABLE agents RENAME COLUMN component_key TO key;'); } catch {}
          }

          if (!agentCols.some(col => col.name === 'role')) {
            try { this.db.exec("ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'executor';"); } catch {}
          }
          if (!agentCols.some(col => col.name === 'memory')) {
            try { this.db.exec('ALTER TABLE agents ADD COLUMN memory TEXT;'); } catch {}
          }
          if (!agentCols.some(col => col.name === 'prompts')) {
            try { this.db.exec("ALTER TABLE agents ADD COLUMN prompts TEXT DEFAULT '[]';"); } catch {}
          }
        }
      } catch (e) {
        console.warn('Agent schema ensure failed:', e);
      }

      // 8) Ensure chats schema (remove legacy focused_memory_id, ensure agent columns)
      if (hasChats) {
        try {
          let chatCols = this.db.prepare('PRAGMA table_info(chats)').all() as any[];
          const hasFocusedMemoryId = chatCols.some((c: any) => c.name === 'focused_memory_id');
          if (hasFocusedMemoryId) {
            console.log('Removing legacy chats.focused_memory_id column');
            let flippedForeignKeys = false;
            try {
              this.db.exec('PRAGMA foreign_keys=OFF;');
              flippedForeignKeys = true;
              this.db.exec(`
                BEGIN TRANSACTION;
                ALTER TABLE chats RENAME TO chats_legacy_cleanup;
                CREATE TABLE chats (
                  id INTEGER PRIMARY KEY,
                  chat_type TEXT,
                  helper_name TEXT,
                  agent_type TEXT DEFAULT 'orchestrator',
                  delegation_id INTEGER,
                  user_message TEXT,
                  assistant_message TEXT,
                  thread_id TEXT,
                  focused_node_id INTEGER,
                  created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
                  metadata TEXT,
                  FOREIGN KEY (focused_node_id) REFERENCES nodes(id) ON DELETE SET NULL
                );
                INSERT INTO chats (
                  id, chat_type, helper_name, agent_type, delegation_id,
                  user_message, assistant_message, thread_id, focused_node_id,
                  created_at, metadata
                )
                SELECT id, chat_type, helper_name, agent_type, delegation_id,
                       user_message, assistant_message, thread_id, focused_node_id,
                       created_at, metadata
                  FROM chats_legacy_cleanup;
                DROP TABLE chats_legacy_cleanup;
                CREATE INDEX IF NOT EXISTS idx_chats_thread ON chats(thread_id);
                COMMIT;
              `);
            } catch (migrationErr) {
              console.warn('Failed to migrate chats table (focused_memory_id removal):', migrationErr);
              try { this.db.exec('ROLLBACK;'); } catch {}
            } finally {
              if (flippedForeignKeys) {
                try { this.db.exec('PRAGMA foreign_keys=ON;'); } catch {}
              }
            }
            chatCols = this.db.prepare('PRAGMA table_info(chats)').all() as any[];
          }

          this.db.exec("CREATE INDEX IF NOT EXISTS idx_chats_thread ON chats(thread_id);");

          const ensureCol = (name: string, ddl: string) => {
            if (!chatCols.some((c: any) => c.name === name)) {
              try { this.db.exec(ddl); } catch (colErr) { console.warn(`Failed to add chats.${name}`, colErr); }
            }
          };
          ensureCol('agent_type', "ALTER TABLE chats ADD COLUMN agent_type TEXT DEFAULT 'orchestrator';");
          ensureCol('delegation_id', 'ALTER TABLE chats ADD COLUMN delegation_id INTEGER;');
        } catch (e) {
          console.warn('Failed to update chats schema:', e);
        }
      }

      try {
        const chatColsPost = hasChats
          ? this.db.prepare('PRAGMA table_info(chats)').all() as any[]
          : [];
        const stillHasFocusedMemoryId = chatColsPost.some((c: any) => c.name === 'focused_memory_id');
        if (stillHasFocusedMemoryId) {
          console.warn('Skipping legacy memory table drop because chats.focused_memory_id is still present.');
        } else {
          this.db.exec(`
            DROP TRIGGER IF EXISTS trg_episodic_prune;
            DROP TABLE IF EXISTS episodic_memory;
            DROP TABLE IF EXISTS episodic_pipeline_state;
            DROP TABLE IF EXISTS semantic_memory;
            DROP TABLE IF EXISTS semantic_pipeline_state;
            DROP TABLE IF EXISTS memory_pipeline_state;
            DROP TABLE IF EXISTS memory;
          `);
        }
      } catch (dropLegacyErr) {
        console.warn('Failed to drop legacy memory pipeline tables:', dropLegacyErr);
      }

      // 9) Ensure dimensions table exists (v0.1.16+ schema migration)
      const hasDimensions = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dimensions'").get();
      if (!hasDimensions) {
        console.log('Creating dimensions table for v0.1.16+ features...');
        this.db.exec(`
          CREATE TABLE dimensions (
            name TEXT PRIMARY KEY,
            description TEXT,
            is_priority INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);
        
        // Seed default locked dimensions
        const defaultDimensions = ['research', 'ideas', 'projects', 'memory', 'preferences'];
        const insertDimension = this.db.prepare(`
          INSERT INTO dimensions (name, is_priority, updated_at)
          VALUES (?, 1, datetime('now'))
          ON CONFLICT(name) DO UPDATE SET is_priority = 1, updated_at = datetime('now')
        `);
        
        for (const dimension of defaultDimensions) {
          try {
            insertDimension.run(dimension);
          } catch (e) {
            console.warn(`Failed to seed dimension '${dimension}':`, e);
          }
        }
        console.log('Dimensions table created and seeded with default locked dimensions');
      } else {
        // Check if existing dimensions table has description column
        const dimensionCols = this.db.prepare('PRAGMA table_info(dimensions)').all() as Array<{ name: string }>;
        const hasDescription = dimensionCols.some(col => col.name === 'description');
        if (!hasDescription) {
          console.log('Adding description column to existing dimensions table...');
          try {
            this.db.exec('ALTER TABLE dimensions ADD COLUMN description TEXT;');
            console.log('Description column added to dimensions table');
          } catch (e) {
            console.warn('Failed to add description column to dimensions table:', e);
          }
        }
      }

      console.log('Logging + memory schema ensured');
    } catch (error) {
      console.error('Failed to ensure logging/memory schema:', error);
    }
  }

  private healVectorTablesIfCorrupt(): void {
    if (this.readOnly) {
      return;
    }
    // Attempt lightweight reads to detect CORRUPT_VTAB; if detected, drop/recreate vtables
    const tryRead = (table: string) => {
      try {
        this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
      } catch (e: any) {
        const msg = String(e?.message || '');
        const code = (e && e.code) ? String(e.code) : '';
        if (code === 'SQLITE_CORRUPT_VTAB' || msg.includes('database disk image is malformed') || msg.includes('CORRUPT_VTAB')) {
          console.warn(`Detected corrupted virtual table ${table} (${code || 'error'}). Recreating...`);
          try {
            this.db.exec(`DROP TABLE IF EXISTS ${table};`);
          } catch {}
          const ddl = table === 'vec_nodes'
            ? `CREATE VIRTUAL TABLE vec_nodes USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[1536]);`
            : `CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[1536]);`;
          try {
            this.db.exec(ddl);
            console.log(`Recreated ${table} virtual table`);
          } catch (re) {
            console.error(`Failed to recreate ${table}:`, re);
          }
        } else {
          // Other errors should bubble up normally
          // eslint-disable-next-line no-unsafe-finally
          throw e;
        }
      }
    };

    tryRead('vec_nodes');
    tryRead('vec_chunks');
  }

  private handleError(error: any): DatabaseError {
    return {
      message: error.message || 'SQLite operation failed',
      code: error.code || 'SQLITE_ERROR',
      details: error
    };
  }

  public close(): void {
    this.db.close();
  }
}

// Export singleton instance (similar to PostgreSQL client interface)
export const sqliteDb = SQLiteClient.getInstance();

// Export function to get client instance
export const getSQLiteClient = () => sqliteDb;

// Export class for testing
export { SQLiteClient };
