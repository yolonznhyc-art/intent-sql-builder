(() => {
  "use strict";

  const STORAGE_KEY = "intent_sql_builder_v1";
  const FILE_SYNC_DB = "intent_sql_builder_file_sync";
  const FILE_SYNC_STORE = "handles";
  const FILE_SYNC_KEY = "active_config";
  const AGGREGATE_SORT_FIELD = "__aggregate__";

  const ACTIONS = [
    { value: "select", label: "查询" },
    { value: "aggregate", label: "统计" },
    { value: "insert", label: "新增" },
    { value: "update", label: "修改" },
    { value: "delete", label: "删除" },
  ];

  const OPERATOR_LABELS = {
    "=": "等于",
    "!=": "不等于",
    ">": "大于",
    ">=": "大于等于",
    "<": "小于",
    "<=": "小于等于",
    contains: "包含",
    starts_with: "开头是",
    ends_with: "结尾是",
    in: "属于列表",
    between: "介于",
    is_null: "为空",
    is_not_null: "不为空",
  };

  const RELATION_RULES = [
    { value: "LEFT JOIN", label: "保留主表全部记录", short: "保留主表", help: "主表没有匹配记录时也显示" },
    { value: "INNER JOIN", label: "只保留两边能对上的记录", short: "只看匹配", help: "两张表字段能对应上才显示" },
    { value: "RIGHT JOIN", label: "保留关联表全部记录", short: "保留关联表", help: "关联表没有匹配记录时也显示" },
    { value: "FULL JOIN", label: "两边记录都尽量保留", short: "两边都保留", help: "任意一边没有匹配记录也保留" },
  ];

  const PASTE_FORMATS = [
    { value: "bip", label: "BIP数据字典格式", parse: parseBipDictionaryFormat },
  ];

  const IDENTIFIER_QUOTE_POLICIES = [
    { value: "always", label: "始终引用", help: "保留表名/字段名原样大小写；在 PostgreSQL、Oracle 等数据库中引用后通常要求精确大小写。" },
    { value: "auto", label: "必要时引用", help: "普通英文/数字/下划线名称不加引号；关键字或特殊名称自动加引号，更接近数据库默认大小写折叠。" },
    { value: "never", label: "不引用", help: "完全依赖数据库默认规则；遇到关键字、空格或特殊字符时可能不可执行。" },
  ];

  const IDENTIFIER_CASE_POLICIES = [
    { value: "preserve", label: "保留大小写" },
    { value: "lower", label: "统一小写" },
    { value: "upper", label: "统一大写" },
  ];

  const TEXT_MATCH_CASE_POLICIES = [
    { value: "dialectDefault", label: "按数据库/排序规则" },
    { value: "caseInsensitive", label: "忽略大小写" },
    { value: "caseSensitive", label: "区分大小写" },
  ];

  const SQLITE_VERSION_POLICIES = [
    { value: "pre_3_39", label: "SQLite < 3.39", help: "不允许 RIGHT JOIN / FULL JOIN，避免在旧版 SQLite 中生成不可执行 SQL。" },
    { value: "3_39_plus", label: "SQLite 3.39+", help: "允许 RIGHT JOIN / FULL JOIN；SQLite 3.39.0 起支持这两类 JOIN。" },
  ];

  const SQL_RESERVED_WORDS = new Set([
    "ADD", "ALL", "ALTER", "AND", "AS", "ASC", "BETWEEN", "BY", "CASE", "CREATE", "DELETE", "DESC", "DISTINCT",
    "DROP", "ELSE", "EXISTS", "FALSE", "FROM", "FULL", "GROUP", "HAVING", "IN", "INNER", "INSERT", "INTO",
    "IS", "JOIN", "LEFT", "LIKE", "LIMIT", "NOT", "NULL", "ON", "OR", "ORDER", "OUTER", "RIGHT", "SELECT",
    "SET", "TABLE", "THEN", "TRUE", "UNION", "UPDATE", "VALUES", "VIEW", "WHEN", "WHERE", "WITH"
  ]);

  // The generic list above is deliberately small.  These additions cover words
  // that are valid in some engines but cannot safely be emitted unquoted in a
  // particular dialect.
  const DIALECT_RESERVED_WORDS = {
    oracle: new Set(["ACCESS", "AUDIT", "CHAR", "CHECK", "COLUMN", "COMMENT", "CONNECT", "CURRENT", "DATE", "DECIMAL", "DEFAULT", "FLOAT", "GRANT", "INDEX", "INTEGER", "LEVEL", "NUMBER", "OPTION", "PUBLIC", "RAW", "ROW", "ROWID", "ROWNUM", "ROWS", "SESSION", "SMALLINT", "SYSDATE", "TRIGGER", "UID", "UNIQUE", "USER", "VARCHAR", "VARCHAR2"]),
    dameng: new Set(["ACCESS", "CHAR", "CHECK", "COLUMN", "COMMENT", "CONNECT", "CURRENT", "DATE", "DECIMAL", "DEFAULT", "FLOAT", "GRANT", "INDEX", "INTEGER", "LEVEL", "NUMBER", "OPTION", "PUBLIC", "RAW", "ROW", "ROWID", "ROWNUM", "ROWS", "SESSION", "SMALLINT", "SYSDATE", "TRIGGER", "UID", "UNIQUE", "USER", "VARCHAR"]),
    sqlserver: new Set(["ADD", "AUTHORIZATION", "BACKUP", "BREAK", "BROWSE", "BULK", "CHECKPOINT", "CLUSTERED", "CONSTRAINT", "CONTAINS", "CURRENT_DATE", "CURRENT_USER", "DATABASE", "DBCC", "DENY", "DISK", "DISTRIBUTED", "DUMP", "ERRLVL", "ESCAPE", "EXCEPT", "EXEC", "EXECUTE", "FILE", "FILLFACTOR", "FOREIGN", "FREETEXT", "GO", "IDENTITY", "INTERSECT", "KEY", "KILL", "LINENO", "NATIONAL", "NOCHECK", "NONCLUSTERED", "OPEN", "OPENDATASOURCE", "OPENQUERY", "OPENROWSET", "PERCENT", "PLAN", "PRECISION", "PRIMARY", "PRINT", "PROC", "PROCEDURE", "RAISERROR", "READ", "REFERENCES", "REPLICATION", "RESTORE", "RETURN", "REVOKE", "RULE", "SAVE", "SCHEMA", "SECURITYAUDIT", "STATISTICS", "TOP", "TRANSACTION", "TRIGGER", "TRUNCATE", "TSEQUAL", "UNIQUE", "USER", "USE", "VARYING", "WAITFOR"]),
  };

  const DIALECTS = [
    {
      value: "generic",
      label: "通用 SQL",
      quoteOpen: '"',
      quoteClose: '"',
      paramStyle: "namedColon",
      pagination: "limitOffset",
      trueLiteral: "TRUE",
      falseLiteral: "FALSE",
      types: { text: "TEXT", number: "NUMERIC", date: "DATE", boolean: "BOOLEAN" },
      identifierCaseNote: "通用 SQL 的未引用标识符大小写规则由实际数据库决定。",
      textCaseNote: "LIKE 是否区分大小写由实际数据库和排序规则决定。",
    },
    {
      value: "postgresql",
      label: "PostgreSQL",
      quoteOpen: '"',
      quoteClose: '"',
      paramStyle: "dollar",
      pagination: "limitOffset",
      trueLiteral: "TRUE",
      falseLiteral: "FALSE",
      types: { text: "TEXT", number: "NUMERIC", date: "DATE", boolean: "BOOLEAN" },
      supportsILike: true,
      quotedIdentifiersCaseSensitive: true,
      identifierCaseNote: "未引用标识符会折叠为小写；双引号标识符会保留大小写并要求精确匹配。",
      textCaseNote: "LIKE 默认区分大小写；ILIKE 可用于忽略大小写。",
    },
    {
      value: "mysql",
      label: "MySQL / MariaDB",
      quoteOpen: "`",
      quoteClose: "`",
      paramStyle: "qmark",
      pagination: "limitOffset",
      trueLiteral: "TRUE",
      falseLiteral: "FALSE",
      types: { text: "VARCHAR(255)", number: "DECIMAL(18,2)", date: "DATE", boolean: "TINYINT(1)" },
      unsupportedJoinTypes: ["FULL JOIN"],
      identifierCaseNote: "表名大小写受 lower_case_table_names、操作系统和存储引擎影响；列名通常不区分大小写。",
      textCaseNote: "LIKE 是否区分大小写主要取决于字段 collation；强制区分大小写时会使用 BINARY。",
    },
    {
      value: "sqlite",
      label: "SQLite",
      quoteOpen: '"',
      quoteClose: '"',
      paramStyle: "qmark",
      pagination: "limitOffset",
      trueLiteral: "1",
      falseLiteral: "0",
      types: { text: "TEXT", number: "NUMERIC", date: "TEXT", boolean: "INTEGER" },
      identifierCaseNote: "标识符通常不区分大小写，即使使用双引号也不会像 PostgreSQL 那样形成大小写敏感名称。",
      textCaseNote: "LIKE 默认大小写行为受 SQLite 设置和字符范围影响；强制区分大小写时会使用 GLOB。",
    },
    {
      value: "sqlserver",
      label: "SQL Server",
      quoteOpen: "[",
      quoteClose: "]",
      paramStyle: "atName",
      pagination: "sqlServer",
      trueLiteral: "1",
      falseLiteral: "0",
      types: { text: "NVARCHAR(255)", number: "DECIMAL(18,2)", date: "DATE", boolean: "BIT" },
      joinAliases: { "FULL JOIN": "FULL OUTER JOIN" },
      identifierCaseNote: "标识符和文本比较是否区分大小写通常由数据库/列 collation 决定。",
      textCaseNote: "LIKE 是否区分大小写取决于 collation；需要严格控制时建议在真实库中指定合适的 COLLATE。",
    },
    {
      value: "oracle",
      label: "Oracle",
      quoteOpen: '"',
      quoteClose: '"',
      paramStyle: "namedColon",
      pagination: "offsetFetch",
      trueLiteral: "1",
      falseLiteral: "0",
      types: { text: "VARCHAR2(255)", number: "NUMBER", date: "DATE", boolean: "NUMBER(1)" },
      dateLiteral: true,
      quotedIdentifiersCaseSensitive: true,
      joinAliases: { "FULL JOIN": "FULL OUTER JOIN" },
      identifierCaseNote: "未引用标识符会折叠为大写；双引号标识符会保留大小写并要求精确匹配。",
      textCaseNote: "LIKE 通常区分大小写；忽略大小写会使用 LOWER(字段) LIKE LOWER(参数)。",
    },
    {
      value: "dameng",
      label: "达梦 DM",
      quoteOpen: '"',
      quoteClose: '"',
      paramStyle: "namedColon",
      pagination: "offsetFetch",
      trueLiteral: "1",
      falseLiteral: "0",
      types: { text: "VARCHAR(255)", number: "NUMBER", date: "DATE", boolean: "BIT" },
      dateLiteral: true,
      quotedIdentifiersCaseSensitive: true,
      joinAliases: { "FULL JOIN": "FULL OUTER JOIN" },
      identifierCaseNote: "未引用标识符通常折叠为大写；双引号标识符会保留大小写并要求精确匹配。",
      textCaseNote: "LIKE 的大小写行为受数据库兼容模式和排序规则影响；忽略大小写会使用 LOWER。",
    },
    {
      value: "kingbase",
      label: "人大金仓 KingbaseES",
      quoteOpen: '"',
      quoteClose: '"',
      paramStyle: "namedColon",
      pagination: "limitOffset",
      trueLiteral: "TRUE",
      falseLiteral: "FALSE",
      types: { text: "TEXT", number: "NUMERIC", date: "DATE", boolean: "BOOLEAN" },
      supportsILike: true,
      quotedIdentifiersCaseSensitive: true,
      identifierCaseNote: "通常兼容 PostgreSQL 的未引用小写折叠规则；兼容模式不同时请以实际库为准。",
      textCaseNote: "LIKE/ILIKE 行为通常兼容 PostgreSQL；兼容模式不同时请以实际库为准。",
    },
  ];

  const BUILDER_STEPS = [
    { value: "action", index: 1, label: "做什么" },
    { value: "target", index: 2, label: "对谁做" },
    { value: "fields", index: 3, label: "字段" },
    { value: "relations", index: 4, label: "关系" },
    { value: "conditions", index: 5, label: "条件" },
    { value: "result", index: 6, label: "排序分页" },
    { value: "advanced", index: 7, label: "高级能力", advanced: true },
  ];

  const LEGACY_DEMO_TABLE_COUNT = 4;
  const LEGACY_DEMO_FIELD_COUNTS = "6,6,5,5";
  const LEGACY_DEMO_SIGNATURE_HASH = 3934683063;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const text = (value) => String(value ?? "").trim();

  const elements = {};
  let state = normalizeState(loadState() || createDefaultState());
  let currentGenerated = null;
  let activeResultTab = "sql";
  let activeBuilderStep = "action";
  let selectedHistoryIndex = -1;
  let fileSyncHandle = null;
  let fileSyncReady = false;
  let fileSyncStatus = "未连接本地配置文件；当前使用浏览器本地保存。";
  let fileSyncTimer = 0;
  let fileSyncBootPending = typeof indexedDB !== "undefined";
  let selectedDictionaryField = "";
  let historyTimer = 0;
  let dictionaryEditor = { dictionaryId: null, tableName: null, fieldName: null };
  let dictionaryManageRows = [];
  let expandedTableNames = new Set();
  let tableStructureEditor = { originalTableName: "", rows: [] };

  function createDefaultIntent(baseTable = "") {
    return {
      action: "select",
      baseTable,
      selectedFields: [],
      mutationFields: [],
      mutationValues: {},
      distinct: false,
      aggregate: { fn: "count", field: "*" },
      joins: [],
      condition: { id: uid(), type: "group", logic: "AND", not: false, children: [] },
      groupBy: false,
      groupFields: [],
      sort: { field: "", direction: "ASC" },
      limit: 50,
      offset: 0,
      advanced: { with: "", computed: "", having: "", union: "" },
      expert: { kind: "none", sql: "" },
    };
  }

  function createEmptyDictionary(name = "数据字典 1") {
    return { id: uid(), name, tables: [] };
  }

  function createDefaultState() {
    const dictionary = createEmptyDictionary();
    return {
      version: 4,
      mode: "normal",
      dialect: "generic",
      sqliteVersion: "pre_3_39",
      identifierQuote: "auto",
      identifierCase: "preserve",
      textMatchCase: "dialectDefault",
      activeDictionaryId: dictionary.id,
      dictionaries: [dictionary],
      selectedDictionaryTable: "",
      dictionary: dictionary.tables,
      intent: createDefaultIntent(""),
      templates: [],
      history: [],
    };
  }

  function loadState() {
    // Read legacy browser data only as a one-time migration source. New changes
    // are never written back here; connecting a file removes this legacy copy.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function configPayload() {
    syncActiveDictionaryState();
    return {
      version: 4,
      mode: state.mode,
      dialect: state.dialect,
      sqliteVersion: state.sqliteVersion,
      identifierQuote: state.identifierQuote,
      identifierCase: state.identifierCase,
      textMatchCase: state.textMatchCase,
      activeDictionaryId: state.activeDictionaryId,
      dictionaries: state.dictionaries,
      selectedDictionaryTable: state.selectedDictionaryTable,
      dictionary: state.dictionary,
      intent: state.intent,
      templates: state.templates,
      history: state.history,
    };
  }

  function saveState() {
    const payload = configPayload();
    if (fileSyncBootPending) return;
    if (fileSyncReady && fileSyncHandle) {
      scheduleFileSync(payload);
    }
  }

  function normalizeTables(tables) {
    return (Array.isArray(tables) ? tables : []).map((table, index) => ({
      name: cleanIdentifier(table.name) || table.name || `table_${index + 1}`,
      label: text(table.label) || table.name || `表 ${index + 1}`,
      fields: Array.isArray(table.fields)
        ? table.fields.map((field, fieldIndex) => ({
            name: cleanIdentifier(field.name) || field.name || `field_${fieldIndex + 1}`,
            label: text(field.label) || field.name || `字段 ${fieldIndex + 1}`,
            type: ["text", "number", "date", "boolean"].includes(field.type) ? field.type : "text",
            primary: Boolean(field.primary),
          }))
        : [],
    }));
  }

  function isOldDemoDictionary(tables) {
    if (!Array.isArray(tables) || tables.length !== LEGACY_DEMO_TABLE_COUNT) return false;
    const fieldCounts = tables.map((table) => table.fields.length).join(",");
    if (fieldCounts !== LEGACY_DEMO_FIELD_COUNTS) return false;
    return hashLegacyDictionarySignature(tables) === LEGACY_DEMO_SIGNATURE_HASH;
  }

  function hashLegacyDictionarySignature(tables) {
    const signature = tables
      .map((table) => `${table.name}:${table.fields.map((field) => field.name).join(",")}`)
      .join("|");
    let hash = 0;
    for (const char of signature) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash;
  }

  function normalizeDictionaries(input) {
    const source = input || {};
    let dictionaries = [];
    if (Array.isArray(source.dictionaries) && source.dictionaries.length) {
      dictionaries = source.dictionaries.map((dictionary, index) => ({
        id: dictionary.id || uid(),
        name: text(dictionary.name) || `数据字典 ${index + 1}`,
        tables: normalizeTables(dictionary.tables || dictionary.dictionary || []),
      }));
    } else {
      let tables = normalizeTables(source.dictionary || []);
      if (isOldDemoDictionary(tables)) tables = [];
      dictionaries = [{ id: source.activeDictionaryId || uid(), name: text(source.dictionaryName) || "数据字典 1", tables }];
    }
    return dictionaries.length ? dictionaries : [createEmptyDictionary()];
  }

  function normalizeState(input) {
    const fallback = createDefaultState();
    const source = input || {};
    const next = { ...fallback, ...source };
    next.dictionaries = normalizeDictionaries(source);
    next.activeDictionaryId = next.dictionaries.some((dictionary) => dictionary.id === source.activeDictionaryId)
      ? source.activeDictionaryId
      : next.dictionaries[0].id;
    const activeDictionary = next.dictionaries.find((dictionary) => dictionary.id === next.activeDictionaryId) || next.dictionaries[0];
    next.dictionary = activeDictionary.tables;

    const firstTable = next.dictionary[0]?.name || "";
    next.mode = ["normal", "advanced", "expert"].includes(next.mode) ? next.mode : "normal";
    next.dialect = DIALECTS.some((dialect) => dialect.value === next.dialect) ? next.dialect : "generic";
    next.sqliteVersion = SQLITE_VERSION_POLICIES.some((item) => item.value === next.sqliteVersion) ? next.sqliteVersion : "pre_3_39";
    next.identifierQuote = IDENTIFIER_QUOTE_POLICIES.some((item) => item.value === next.identifierQuote) ? next.identifierQuote : "always";
    next.identifierCase = IDENTIFIER_CASE_POLICIES.some((item) => item.value === next.identifierCase) ? next.identifierCase : "preserve";
    next.textMatchCase = TEXT_MATCH_CASE_POLICIES.some((item) => item.value === next.textMatchCase) ? next.textMatchCase : "dialectDefault";
    next.selectedDictionaryTable = tableExists(next.selectedDictionaryTable, next.dictionary)
      ? next.selectedDictionaryTable
      : firstTable;
    next.intent = { ...createDefaultIntent(firstTable), ...(source.intent || {}) };
    if (!tableExists(next.intent.baseTable, next.dictionary)) next.intent.baseTable = firstTable;
    next.intent.action = ACTIONS.some((action) => action.value === next.intent.action) ? next.intent.action : "select";
    next.intent.selectedFields = normalizeFieldRefs(next.intent.selectedFields, next.intent.baseTable).filter(fieldRefExistsInDictionary(next.dictionary));
    if (["select", "aggregate"].includes(next.intent.action) && firstTable && !next.intent.selectedFields.length) {
      next.intent.selectedFields = defaultFieldRefs(firstTable, next.dictionary);
    }
    next.intent.mutationFields = Array.isArray(next.intent.mutationFields) ? next.intent.mutationFields : [];
    next.intent.mutationValues = next.intent.mutationValues || {};
    next.intent.aggregate = { fn: "count", field: "*", ...(next.intent.aggregate || {}) };
    next.intent.aggregate.fn = ["count", "sum", "avg", "min", "max"].includes(next.intent.aggregate.fn)
      ? next.intent.aggregate.fn
      : "count";
    if (next.intent.aggregate.field !== "*" && !fieldRefExistsInDictionary(next.dictionary)(next.intent.aggregate.field)) next.intent.aggregate.field = "*";
    next.intent.joins = Array.isArray(next.intent.joins)
      ? next.intent.joins
          .filter((join) => tableExists(join.table, next.dictionary))
          .map((join) => ({ ...join, type: normalizedJoinTypeForSettings(join.type, next) }))
      : [];
    next.intent.condition = normalizeCondition(next.intent.condition);
    next.intent.groupFields = normalizeFieldRefs(next.intent.groupFields, next.intent.baseTable).filter(fieldRefExistsInDictionary(next.dictionary));
    next.intent.sort = { field: "", direction: "ASC", ...(next.intent.sort || {}) };
    if (next.intent.sort.field && next.intent.sort.field !== AGGREGATE_SORT_FIELD && !fieldRefExistsInDictionary(next.dictionary)(next.intent.sort.field)) next.intent.sort.field = "";
    next.intent.sort.direction = next.intent.sort.direction === "DESC" ? "DESC" : "ASC";
    next.intent.limit = clampNumber(next.intent.limit, 0, 100000, 50);
    next.intent.offset = clampNumber(next.intent.offset, 0, 1000000, 0);
    next.intent.advanced = { with: "", computed: "", having: "", union: "", ...(next.intent.advanced || {}) };
    next.intent.expert = { kind: "none", sql: "", ...(next.intent.expert || {}) };
    next.templates = Array.isArray(next.templates) ? next.templates : [];
    next.history = Array.isArray(next.history) ? next.history.slice(0, 20) : [];
    return next;
  }

  function normalizeCondition(node) {
    if (!node || typeof node !== "object") {
      return { id: uid(), type: "group", logic: "AND", not: false, children: [] };
    }
    if (node.type === "condition") {
      return {
        id: node.id || uid(),
        type: "condition",
        field: node.field || "",
        operator: node.operator || "=",
        value: node.value ?? "",
      };
    }
    return {
      id: node.id || uid(),
      type: "group",
      logic: node.logic === "OR" ? "OR" : "AND",
      not: Boolean(node.not),
      children: Array.isArray(node.children) ? node.children.map(normalizeCondition) : [],
    };
  }

  function normalizeFieldRefs(fields, baseTable) {
    if (!Array.isArray(fields)) return [];
    return fields
      .map((field) => {
        if (typeof field !== "string") return "";
        if (field.includes(".")) return field;
        return baseTable ? `${baseTable}.${field}` : "";
      })
      .filter(Boolean);
  }

  function defaultFieldRefs(tableName, dictionary) {
    const source = Array.isArray(dictionary) ? dictionary : state.dictionary;
    return (source.find((table) => table.name === tableName)?.fields || [])
      .slice(0, 3)
      .map((field) => `${tableName}.${field.name}`);
  }

  function fieldRefExistsInDictionary(dictionary) {
    return (ref) => {
      if (!ref || ref === "*") return false;
      const [tableName, fieldName] = String(ref).split(".");
      return Boolean(dictionary.find((table) => table.name === tableName)?.fields.some((field) => field.name === fieldName));
    };
  }

  function getActiveDictionary() {
    return state.dictionaries.find((dictionary) => dictionary.id === state.activeDictionaryId) || state.dictionaries[0];
  }

  function syncActiveDictionaryState() {
    const activeDictionary = getActiveDictionary();
    if (activeDictionary) activeDictionary.tables = state.dictionary;
  }

  function tableExists(name, dictionary = state.dictionary) {
    return Boolean(name) && dictionary.some((table) => table.name === name);
  }

  function cleanIdentifier(value) {
    const cleaned = text(value).replace(/[^\w]/g, "_");
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned) ? cleaned : cleaned.replace(/^[^A-Za-z_]+/, "");
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
  }

  function initElements() {
    [
      "dictionarySelect",
      "dictionaryManageModal",
      "openDictionaryManageButton",
      "dictionaryImportModal",
      "tableEditorModal",
      "tableEditorTitle",
      "tableEditorNameInput",
      "tableEditorLabelInput",
      "tableEditorGrid",
      "tableEditorRows",
      "addStructureRowButton",
      "deleteStructureRowsButton",
      "saveTableStructureButton",
      "dictionaryManageRows",
      "addDictionaryRowButton",
      "deleteDictionaryRowsButton",
      "saveDictionaryManagerButton",
      "pasteImportForm",
      "pasteFormatSelect",
      "dictionaryPasteInput",
      "importDictionaryPasteButton",
      "pasteImportStatus",
      "dictionaryList",
      "dialectSelect",
      "sqliteVersionField",
      "sqliteVersionSelect",
      "identifierQuoteSelect",
      "identifierCaseSelect",
      "textMatchCaseSelect",
      "builderStepTabs",
      "actionButtons",
      "baseTableSelect",
      "intentSentence",
      "distinctInput",
      "aggregatePicker",
      "aggregateSelect",
      "fieldSelector",
      "mutationValues",
      "addJoinButton",
      "joinEditor",
      "joinGraph",
      "addRootConditionButton",
      "conditionTree",
      "groupByToggle",
      "groupBySelect",
      "sortFieldSelect",
      "sortDirectionSelect",
      "limitInput",
      "offsetInput",
      "withInput",
      "computedInput",
      "havingInput",
      "unionInput",
      "expertKindSelect",
      "expertSqlInput",
      "copySqlButton",
      "saveHistoryButton",
      "sqlOutput",
      "paramSqlOutput",
      "paramsOutput",
      "explainOutput",
      "riskOutput",
      "fileSyncModal",
      "historyModal",
      "openFileSyncButton",
      "openHistoryButton",
      "historyList",
      "historySqlPreview",
      "connectFileSyncButton",
      "createFileSyncButton",
      "saveFileSyncButton",
      "fileSyncStatus",
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
    ensureAggregateFieldPicker();
  }

  function ensureAggregateFieldPicker() {
    let picker = document.getElementById("aggregateFieldPicker");
    if (!picker) {
      picker = document.createElement("label");
      picker.id = "aggregateFieldPicker";
      picker.className = "compact-label";
      picker.innerHTML = '统计字段<select id="aggregateFieldSelect"></select>';
      elements.aggregatePicker?.after(picker);
    }
    elements.aggregateFieldPicker = picker;
    elements.aggregateFieldSelect = document.getElementById("aggregateFieldSelect");
  }

  function render() {
    state = normalizeState(state);
    sanitizeCurrentIntentForDictionary();
    sanitizeCurrentJoinsForDialect();
    document.body.classList.toggle("mode-advanced", state.mode === "advanced");
    document.body.classList.toggle("mode-expert", state.mode === "expert");
    renderModes();
    renderDialect();
    renderActions();
    renderDictionarySwitcher();
    renderDictionary();
    renderBaseTable();
    renderOutputFields();
    renderJoins();
    renderConditionTree();
    renderResultControls();
    renderAdvancedControls();
    renderHistory();
    renderFileSyncStatus();
    renderBuilderSteps();
    syncOutputs(true);
  }

  function renderModes() {
    $$(".mode-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    });
  }

  function renderDialect() {
    if (elements.dialectSelect) {
      elements.dialectSelect.innerHTML = DIALECTS.map(
        (dialect) => `<option value="${escapeAttr(dialect.value)}">${escapeHtml(dialect.label)}</option>`,
      ).join("");
      elements.dialectSelect.value = state.dialect;
    }
    if (elements.sqliteVersionField) elements.sqliteVersionField.hidden = state.dialect !== "sqlite";
    if (elements.sqliteVersionSelect) {
      elements.sqliteVersionSelect.innerHTML = SQLITE_VERSION_POLICIES.map(
        (item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.label)}</option>`,
      ).join("");
      elements.sqliteVersionSelect.value = state.sqliteVersion;
      elements.sqliteVersionSelect.title = SQLITE_VERSION_POLICIES.find((item) => item.value === state.sqliteVersion)?.help || "";
    }
    if (elements.identifierQuoteSelect) {
      elements.identifierQuoteSelect.innerHTML = IDENTIFIER_QUOTE_POLICIES.map(
        (item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.label)}</option>`,
      ).join("");
      elements.identifierQuoteSelect.value = state.identifierQuote;
      elements.identifierQuoteSelect.title = IDENTIFIER_QUOTE_POLICIES.find((item) => item.value === state.identifierQuote)?.help || "";
    }
    if (elements.identifierCaseSelect) {
      elements.identifierCaseSelect.innerHTML = IDENTIFIER_CASE_POLICIES.map(
        (item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.label)}</option>`,
      ).join("");
      elements.identifierCaseSelect.value = state.identifierCase;
    }
    if (elements.textMatchCaseSelect) {
      elements.textMatchCaseSelect.innerHTML = TEXT_MATCH_CASE_POLICIES.map(
        (item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.label)}</option>`,
      ).join("");
      elements.textMatchCaseSelect.value = state.textMatchCase;
    }
  }

  function renderActions() {
    elements.actionButtons.innerHTML = ACTIONS.map(
      (action) =>
        `<button type="button" data-action="${action.value}" class="${state.intent.action === action.value ? "active" : ""}">${action.label}</button>`,
    ).join("");
  }

  function isSelectLikeAction(action = state.intent.action) {
    return action === "select" || action === "aggregate";
  }

  function isStepAvailable(step) {
    const action = state.intent.action;
    if (step === "relations") return isSelectLikeAction(action);
    if (step === "conditions") return action !== "insert";
    if (step === "result") return isSelectLikeAction(action);
    if (step === "advanced") return state.mode === "expert" || (state.mode === "advanced" && isSelectLikeAction(action));
    return true;
  }

  function visibleBuilderSteps() {
    return BUILDER_STEPS.filter((step) => isStepAvailable(step.value) && (!step.advanced || state.mode !== "normal"));
  }

  function renderBuilderSteps() {
    const visibleSteps = visibleBuilderSteps();
    if (!visibleSteps.some((step) => step.value === activeBuilderStep)) activeBuilderStep = visibleSteps[0]?.value || "action";
    elements.builderStepTabs.innerHTML = visibleSteps
      .map(
        (step) => `<button class="builder-step-tab ${step.value === activeBuilderStep ? "active" : ""}" type="button" data-builder-step="${step.value}">
          <span class="builder-step-number">${step.index}</span>
          <span class="builder-step-text"><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(builderStepSummary(step.value))}</small></span>
        </button>`,
      )
      .join("");
    $$('[data-step-panel]').forEach((panel) => {
      let available = isStepAvailable(panel.dataset.stepPanel);
      if (panel.id === "advancedCard") available = state.mode !== "normal" && isSelectLikeAction();
      if (panel.id === "expertCard") available = state.mode === "expert";
      panel.hidden = !available;
      panel.classList.toggle("active", available && panel.dataset.stepPanel === activeBuilderStep);
    });
  }

  function builderStepSummary(step) {
    const intent = state.intent;
    if (step === "action") return ACTIONS.find((action) => action.value === intent.action)?.label || "查询";
    if (step === "target") return getTable(intent.baseTable) ? tableLabel(intent.baseTable) : "未选择主表";
    if (step === "fields") {
      if (intent.action === "delete") return "删除不使用字段";
      if (intent.action === "insert") return `${intent.mutationFields.length || 0} 个新增字段`;
      if (intent.action === "update") return `${intent.mutationFields.length || 0} 个修改字段`;
      if (intent.action === "aggregate") return aggregateLabel(intent.aggregate);
      return intent.selectedFields.length ? `${intent.selectedFields.length} 个输出字段` : "全部字段";
    }
    if (step === "relations") return intent.joins.length ? `${intent.joins.length} 段关系` : "未关联其它表";
    if (step === "conditions") return conditionLabel(intent.condition) || "暂无条件";
    if (step === "result") {
      const sort = intent.sort.field ? `排序：${sortFieldLabel(intent.sort.field)}` : "不排序";
      const page = intent.limit ? `最多 ${intent.limit} 条` : "不限制条数";
      const offset = intent.offset ? `，跳过 ${intent.offset} 条` : "";
      return `${sort}，${page}${offset}`;
    }
    if (step === "advanced") {
      if (state.mode === "expert") return intent.expert.kind !== "none" ? `专家：${intent.expert.kind}` : "未选择专家能力";
      return hasApplicableAdvancedFragment() ? "已有高级片段" : "未填写高级片段";
    }
    return "";
  }

  function renderDictionarySwitcher() {
    elements.dictionarySelect.innerHTML = state.dictionaries
      .map((dictionary) => `<option value="${escapeAttr(dictionary.id)}">${escapeHtml(dictionary.name)} (${dictionary.tables.length} 表)</option>`)
      .join("");
    elements.dictionarySelect.value = state.activeDictionaryId;
  }

  function renderDictionary() {
    const activeDictionary = getActiveDictionary();
    const totalFields = state.dictionary.reduce((sum, table) => sum + table.fields.length, 0);
    if (!getTable(state.selectedDictionaryTable) && state.dictionary.length) state.selectedDictionaryTable = state.dictionary[0].name;
    if (!expandedTableNames.size && state.selectedDictionaryTable) expandedTableNames.add(state.selectedDictionaryTable);
    const root = `<div class="dict-tree-root tree-node-row"><button class="tree-node-main tree-root-main" type="button" data-tree-root="${escapeAttr(activeDictionary?.id || "")}"><span class="tree-glyph">▦</span><span class="tree-node-text"><strong>${escapeHtml(activeDictionary?.name || "未命名字典")}</strong><small>${state.dictionary.length} 张表，${totalFields} 个字段</small></span></button><span class="tree-node-actions"><button class="micro-button" type="button" data-tree-add-table>+表</button><button class="micro-button" type="button" data-tree-import>导入</button></span></div>`;
    if (!state.dictionary.length) {
      selectedDictionaryField = "";
      elements.dictionaryList.innerHTML = `<div class="dict-tree">${root}<div class="tree-empty empty-state">当前字典还没有表。点击“新表”或使用“导入”自动添加表和字段。</div></div>`;
      return;
    }
    const tables = state.dictionary.map((table) => {
      const active = table.name === state.selectedDictionaryTable;
      const expanded = expandedTableNames.has(table.name);
      const isBase = table.name === state.intent.baseTable;
      const fields = table.fields.map((field) => {
        const selected = active && selectedDictionaryField === field.name;
        const used = isFieldUsedInIntent(table.name, field.name);
        const actionLabel = state.intent.action === "delete" ? "不使用" : ["insert", "update"].includes(state.intent.action) ? (used ? "已写入" : "写入") : used ? "已输出" : "输出";
        const actionDisabled = state.intent.action === "delete" ? "disabled" : "";
        return `<div class="tree-node-row tree-field-row ${selected ? "active" : ""}"><button class="tree-node-main" type="button" data-tree-field="${escapeAttr(field.name)}" data-field-table="${escapeAttr(table.name)}"><span class="tree-glyph">•</span><span class="tree-node-text"><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.name)} · ${escapeHtml(field.type)}${field.primary ? " · 主键" : ""}</small></span></button><span class="tree-node-actions"><button class="micro-button ${used ? "active" : ""}" type="button" data-use-field="${escapeAttr(field.name)}" data-field-table="${escapeAttr(table.name)}" ${actionDisabled}>${actionLabel}</button><button class="micro-button" type="button" data-edit-field="${escapeAttr(field.name)}" data-field-table="${escapeAttr(table.name)}">改</button><button class="micro-button danger" type="button" data-delete-field="${escapeAttr(field.name)}" data-field-table="${escapeAttr(table.name)}">删</button></span></div>`;
      }).join("");
      return `<article class="tree-table ${active ? "active" : ""} ${expanded ? "expanded" : ""} ${isBase ? "is-base" : ""}"><div class="tree-node-row tree-table-row"><button class="tree-toggle" type="button" data-toggle-table="${escapeAttr(table.name)}" aria-label="展开或收起 ${escapeAttr(table.label)}" aria-expanded="${expanded}">${expanded ? "▾" : "▸"}</button><button class="tree-node-main" type="button" data-tree-table="${escapeAttr(table.name)}"><span class="tree-node-text"><strong>${escapeHtml(table.label)}</strong><small>${escapeHtml(table.name)} · ${table.fields.length} 字段</small></span></button><span class="tree-node-actions"><button class="micro-button ${isBase ? "active" : ""}" type="button" data-use-table="${escapeAttr(table.name)}">主表</button><button class="micro-button" type="button" data-add-field="${escapeAttr(table.name)}">+字段</button><button class="micro-button" type="button" data-edit-table="${escapeAttr(table.name)}">改</button><button class="micro-button danger" type="button" data-delete-table="${escapeAttr(table.name)}">删</button></span></div>${expanded ? `<div class="tree-children">${fields || '<div class="tree-empty empty-state">这张表还没有字段。点击“+字段”添加。</div>'}</div>` : ""}</article>`;
    }).join("");
    elements.dictionaryList.innerHTML = `<div class="dict-tree">${root}<div class="tree-children tree-table-list">${tables}</div></div>`;
  }
  function renderTreeSelectionHint() {
    if (!elements.treeSelectionHint) return;
    const table = getTable(state.selectedDictionaryTable);
    const field = table?.fields.find((item) => item.name === selectedDictionaryField);
    if (!table) {
      elements.treeSelectionHint.textContent = "当前选中字典。可以新建表，或从 BIP 数据字典格式导入表和字段。";
      return;
    }
    if (field) {
      elements.treeSelectionHint.textContent = `当前选中字段：${table.label}.${field.label} (${table.name}.${field.name})。可编辑字段、删除字段，或把它加入当前意图。`;
      return;
    }
    elements.treeSelectionHint.textContent = `当前选中表：${table.label} (${table.name})。可设为主表、新增字段、改名或删除。`;
  }

  function isFieldUsedInIntent(tableName, fieldName) {
    const ref = `${tableName}.${fieldName}`;
    if (["insert", "update"].includes(state.intent.action) && state.intent.baseTable === tableName) {
      return state.intent.mutationFields.includes(fieldName);
    }
    return state.intent.selectedFields.includes(ref) || state.intent.groupFields.includes(ref) || state.intent.sort.field === ref;
  }
  function renderBaseTable() {
    if (!state.dictionary.length) {
      elements.baseTableSelect.innerHTML = '<option value="">请先新增表</option>';
      elements.baseTableSelect.value = "";
      return;
    }
    elements.baseTableSelect.innerHTML = state.dictionary
      .map((table) => `<option value="${escapeAttr(table.name)}">${escapeHtml(table.label)} (${escapeHtml(table.name)})</option>`)
      .join("");
    elements.baseTableSelect.value = state.intent.baseTable;
  }

  function renderOutputFields() {
    const intent = state.intent;
    const fields = getAvailableFields();
    const isMutation = ["insert", "update"].includes(intent.action);
    const canUseDistinct = intent.action === "select";
    const heading = $('[data-step-panel="fields"] h2');
    if (heading) {
      heading.textContent = intent.action === "insert" ? "新增字段" : intent.action === "update" ? "修改字段" : intent.action === "delete" ? "字段" : intent.action === "aggregate" ? "统计字段" : "保留字段";
    }
    elements.distinctInput.checked = Boolean(intent.distinct);
    elements.distinctInput.disabled = !canUseDistinct;
    elements.distinctInput.closest("label").hidden = !canUseDistinct;
    elements.aggregatePicker.style.display = intent.action === "aggregate" ? "grid" : "none";
    elements.aggregateFieldPicker.style.display = intent.action === "aggregate" ? "grid" : "none";
    elements.aggregateSelect.value = intent.aggregate.fn;
    const aggregateFields = getAggregateFields(intent.aggregate.fn);
    const aggregateOptions = [
      ...(intent.aggregate.fn === "count" ? [{ value: "*", label: "全部记录 (*)" }] : []),
      ...aggregateFields.map((field) => ({ value: field.ref, label: `${field.label} (${field.ref})` })),
    ];
    elements.aggregateFieldSelect.innerHTML = aggregateOptions
      .map((field) => `<option value="${escapeAttr(field.value)}">${escapeHtml(field.label)}</option>`)
      .join("");
    elements.aggregateFieldSelect.value = intent.aggregate.field || "";

    if (!getTable(intent.baseTable)) {
      elements.fieldSelector.innerHTML = '<div class="empty-state">请先在当前数据字典中新增表和字段。</div>';
      elements.mutationValues.innerHTML = "";
      elements.aggregatePicker.style.display = "none";
      elements.aggregateFieldPicker.style.display = "none";
      return;
    }

    if (intent.action === "delete") {
      elements.fieldSelector.innerHTML = '<div class="empty-state">删除只需要选择对象和主表条件，不选择输出字段，也不设置表关系。</div>';
      elements.mutationValues.innerHTML = "";
      return;
    }

    if (isMutation) {
      elements.fieldSelector.innerHTML = fields
        .filter((field) => field.table === intent.baseTable)
        .map((field) => {
          const checked = intent.mutationFields.includes(field.name);
          return `<label class="field-chip">
            <input type="checkbox" data-mutation-toggle="${escapeAttr(field.name)}" ${checked ? "checked" : ""} />
            <span>${escapeHtml(field.label)} <span class="table-meta">${escapeHtml(field.name)}</span></span>
          </label>`;
        })
        .join("");
      elements.mutationValues.innerHTML = fields
        .filter((field) => field.table === intent.baseTable && intent.mutationFields.includes(field.name))
        .map(
          (field) => `<label>
            ${escapeHtml(field.label)}
            <input type="text" data-mutation-field="${escapeAttr(field.name)}" value="${escapeAttr(intent.mutationValues[field.name] ?? "")}" placeholder="${escapeAttr(field.type)} 值" />
          </label>`,
        )
        .join("");
      return;
    }

    elements.fieldSelector.innerHTML = fields
      .map((field) => {
        const checked = intent.selectedFields.includes(field.ref);
        return `<label class="field-chip">
          <input type="checkbox" data-output-field="${escapeAttr(field.ref)}" ${checked ? "checked" : ""} />
          <span>${escapeHtml(field.label)} <span class="table-meta">${escapeHtml(field.ref)}</span></span>
        </label>`;
      })
      .join("");
    elements.mutationValues.innerHTML = "";
  }

  function renderRelationFieldPicker(property, options, selectedValue) {
    const selected = options.find((option) => option.value === selectedValue) || options[0];
    return `<details class="relation-field-picker"><summary>${escapeHtml(selected?.label || "请选择字段")}</summary><div class="relation-field-options">${options.map((option) => `<button type="button" class="relation-field-option ${option.value === selected?.value ? "active" : ""}" data-join-field-choice="${property}" data-join-field-value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</button>`).join("")}</div></details>`;
  }

  function renderJoins() {
    elements.addJoinButton.disabled = !isSelectLikeAction();
    if (!isSelectLikeAction()) {
      elements.joinEditor.innerHTML = '<div class="relation-not-applicable"><strong>当前操作不需要关联关系</strong><span>新增、修改、删除请直接在主表上操作；如需跨表查询，请切换到查询或统计。</span></div>';
      elements.joinGraph.innerHTML = '<div class="relation-graph-empty">当前操作不显示关系图。</div>';
      return;
    }
    const base = state.intent.baseTable;
    const baseTable = getTable(base);
    const allFields = getDictionaryFields();
    if (!baseTable) {
      elements.joinEditor.innerHTML = '<div class="relation-empty-start"><span class="relation-empty-icon">↔</span><div><strong>先选择主表</strong><p>确定要查询的主数据后，才能把其他表关联进来。</p></div></div>';
      renderGraph();
      return;
    }
    if (state.dictionary.length < 2) {
      elements.joinEditor.innerHTML = '<div class="relation-empty-start"><span class="relation-empty-icon">↔</span><div><strong>还需要另一张表</strong><p>至少准备两张表，才能建立字段间的关联关系。</p></div></div>';
      renderGraph();
      return;
    }
    if (!state.intent.joins.length) {
      elements.joinEditor.innerHTML = `<section class="relation-empty-start"><span class="relation-empty-icon">↔</span><div><strong>把另一张表关联进来</strong><p>例如：用“订单.客户ID”等于“客户.客户ID”，查询订单时同时带出客户信息。</p></div><small>当前主表：${escapeHtml(tableLabel(base))}。点击上方“添加关联”开始。</small></section>`;
    } else {
      elements.joinEditor.innerHTML = state.intent.joins.map((join, index) => {
        const targetTable = getTable(join.table) || firstNonBaseTable(base) || baseTable;
        const targetName = targetTable?.name || base;
        const existingTables = new Set([base, ...state.intent.joins.slice(0, index).map((item) => item.table)]);
        const selectableTables = state.dictionary.filter((table) => table.name !== base && (table.name === targetName || !existingTables.has(table.name)));
        const leftOptions = allFields.filter((field) => existingTables.has(field.table)).map((field) => ({ value: field.ref, label: fieldOptionLabel(field.ref) }));
        const rightOptions = allFields.filter((field) => field.table === targetName).map((field) => ({ value: field.ref, label: fieldOptionLabel(field.ref) }));
        const rule = relationRule(join.type);
        return `<section class="join-row relation-workbench" data-join-index="${index}"><div class="relation-guide"><div><strong>关联 ${index + 1}</strong><span>选择要拉进来的表，并让两边字段一一对应。</span></div><button class="mini-button danger" type="button" data-remove-join="${index}">移除关联</button></div><div class="relation-preview"><span>关系预览</span><strong>${escapeHtml(relationSentence(join))}</strong></div><div class="relation-target"><span class="relation-step">1</span><label>关联哪张表<select data-join-prop="table">${selectableTables.map((table) => `<option value="${escapeAttr(table.name)}" ${targetName === table.name ? "selected" : ""}>${escapeHtml(table.label)} (${escapeHtml(table.name)})</option>`).join("")}</select></label></div><div class="relation-field-pair"><div class="relation-field"><span class="relation-step">2</span><label>已有表的字段${renderRelationFieldPicker("left", leftOptions, join.left)}</label></div><span class="relation-equals">=</span><div class="relation-field"><span class="relation-step">3</span><label>关联表的字段${renderRelationFieldPicker("right", rightOptions, join.right)}</label></div></div><div class="relation-settings"><label>连接方式<select data-join-prop="type">${availableRelationRules().map((item) => `<option value="${item.value}" ${join.type === item.value ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select><span class="field-hint">${escapeHtml(rule.help)}</span></label></div></section>`;
      }).join("");
    }
    renderGraph();
  }

  function renderGraph() {
    const joins = state.intent.joins;
    const baseTable = getTable(state.intent.baseTable);
    if (!baseTable || !joins.length) {
      elements.joinGraph.innerHTML = '<div class="empty-state">表关系图会在添加关系后生成。</div>';
      return;
    }
    const width = 720;
    const height = 180;
    const nodes = [{ name: baseTable.name, label: baseTable.label, x: 28, y: 64 }];
    joins.forEach((join, index) => {
      const table = getTable(join.table);
      nodes.push({ name: join.table, label: table?.label || join.table, x: 250 + index * 170, y: index % 2 ? 100 : 34 });
    });
    const lines = joins
      .map((join, index) => {
        const target = nodes[index + 1];
        const label = relationRule(join.type).short;
        return `<line class="graph-line" x1="168" y1="92" x2="${target.x}" y2="${target.y + 28}"></line>
          <text class="graph-label" x="${(168 + target.x) / 2 - 12}" y="${(92 + target.y + 28) / 2 - 5}">${escapeHtml(label)}</text>`;
      })
      .join("");
    const nodeSvg = nodes
      .map(
        (node) => `<g class="graph-node" transform="translate(${node.x}, ${node.y})">
          <rect width="140" height="56"></rect>
          <text x="12" y="23">${escapeHtml(node.label)}</text>
          <text x="12" y="41" class="graph-label">${escapeHtml(node.name)}</text>
        </g>`,
      )
      .join("");
    elements.joinGraph.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="表关系图">${lines}${nodeSvg}</svg>`;
  }

  function renderConditionTree() {
    const canUseConditions = state.intent.action !== "insert";
    elements.addRootConditionButton.disabled = !canUseConditions;
    if (!canUseConditions) {
      elements.conditionTree.innerHTML = '<div class="condition-not-applicable"><strong>新增不需要筛选条件</strong><span>填写要新增的字段和值即可。</span></div>';
      return;
    }
    const root = state.intent.condition;
    const riskText = state.intent.action === "select" || state.intent.action === "aggregate" ? "不设置条件将处理全部数据。" : "不设置条件会影响全部数据，请谨慎操作。";
    if (!root.children.length) {
      elements.conditionTree.innerHTML = `<section class="condition-workbench condition-workbench-empty" data-node-id="${escapeAttr(root.id)}"><div class="condition-empty-start"><span class="condition-empty-icon">⌕</span><div><strong>先说说要筛选哪些数据</strong><p>例如：订单金额大于 1000，或创建日期在本月。</p></div><button class="condition-primary" type="button" data-add-condition="${escapeAttr(root.id)}">+ 添加第一条条件</button><small>${riskText}</small></div></section>`;
      return;
    }
    elements.conditionTree.innerHTML = renderConditionNode(root, true);
  }

  function renderConditionNode(node, isRoot = false) {
    if (node.type === "condition") {
      const fields = getConditionFields();
      const fieldMissing = node.field && !fields.some((field) => field.ref === node.field);
      return `<div class="condition-row" data-node-id="${escapeAttr(node.id)}"><span class="condition-row-label">条件</span><label><span>字段</span><select data-condition-prop="field">${!node.field ? '<option value="" selected disabled>请选择字段</option>' : ""}${fieldMissing ? `<option value="${escapeAttr(node.field)}" selected disabled>${escapeHtml(node.field)}（当前不可用）</option>` : ""}${fields.map((field) => `<option value="${escapeAttr(field.ref)}" ${node.field === field.ref ? "selected" : ""}>${escapeHtml(field.label)} (${escapeHtml(field.ref)})</option>`).join("")}</select></label><label><span>判断方式</span><select data-condition-prop="operator">${Object.entries(OPERATOR_LABELS).map(([value, label]) => `<option value="${escapeAttr(value)}" ${node.operator === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label><span>比较值</span><input data-condition-prop="value" value="${escapeAttr(node.value ?? "")}" placeholder="输入值；多个值用逗号分隔" /></label><div class="condition-row-actions"><button class="mini-button" type="button" data-convert-group="${escapeAttr(node.id)}">设为括号组</button><button class="mini-button danger" type="button" data-remove-node="${escapeAttr(node.id)}">移除</button></div></div>`;
    }
    const children = node.children.map((child) => renderConditionNode(child)).join("");
    const logicText = node.logic === "AND" ? "全部满足" : "任一满足";
    const advanced = `<details class="condition-advanced"><summary>高级设置</summary><div class="condition-advanced-body"><label class="checkline"><input type="checkbox" data-group-prop="not" ${node.not ? "checked" : ""} />不满足以下条件（NOT）</label><button class="mini-button" type="button" data-add-group="${escapeAttr(node.id)}">+ 添加括号组</button>${isRoot ? "" : `<button class="mini-button danger" type="button" data-remove-node="${escapeAttr(node.id)}">移除括号组</button>`}</div></details>`;
    if (isRoot) {
      return `<section class="condition-workbench" data-node-id="${escapeAttr(node.id)}"><div class="condition-guide"><div><strong>筛选哪些数据？</strong><span>按顺序设置字段、判断方式和比较值。</span></div><span class="condition-count">${node.children.length} 条条件</span></div><div class="condition-root-toolbar"><div class="condition-joiner"><span>以下条件</span><select data-group-prop="logic"><option value="AND" ${node.logic === "AND" ? "selected" : ""}>全部满足</option><option value="OR" ${node.logic === "OR" ? "selected" : ""}>任一满足</option></select><span>即可</span></div><button class="condition-primary" type="button" data-add-condition="${escapeAttr(node.id)}">+ 添加条件</button>${advanced}</div><div class="condition-children">${children}</div></section>`;
    }
    return `<section class="condition-nested-group" data-node-id="${escapeAttr(node.id)}"><div class="condition-nested-toolbar"><span class="condition-nested-title">括号条件组</span><div class="condition-joiner"><span>组内条件</span><select data-group-prop="logic"><option value="AND" ${node.logic === "AND" ? "selected" : ""}>全部满足</option><option value="OR" ${node.logic === "OR" ? "selected" : ""}>任一满足</option></select></div><button class="mini-button" type="button" data-add-condition="${escapeAttr(node.id)}">+ 条件</button>${advanced}</div><div class="condition-children">${children || '<div class="empty-state">先给这个括号组添加一条条件。</div>'}</div></section>`;
  }

  function renderResultControls() {
    const canUseResult = isSelectLikeAction();
    const canGroup = state.intent.action === "aggregate";
    const groupToggleLabel = elements.groupByToggle.closest("label");
    const groupSelectLabel = elements.groupBySelect.closest("label");
    groupToggleLabel.hidden = !canGroup;
    groupSelectLabel.hidden = !canGroup;
    elements.groupByToggle.checked = canGroup && Boolean(state.intent.groupBy);
    elements.groupByToggle.disabled = !canGroup;
    const groupFields = getAvailableFields();
    elements.groupBySelect.innerHTML = groupFields
      .map((field) => `<option value="${escapeAttr(field.ref)}" ${state.intent.groupFields.includes(field.ref) ? "selected" : ""}>${escapeHtml(field.label)} (${escapeHtml(field.ref)})</option>`)
      .join("");
    elements.groupBySelect.disabled = !canGroup || !state.intent.groupBy;

    const sortOptions = getSortFieldOptions();
    elements.sortFieldSelect.innerHTML = [
      '<option value="">不排序</option>',
      ...sortOptions.map((field) => `<option value="${escapeAttr(field.value)}">${escapeHtml(field.label)}</option>`),
    ].join("");
    if (!sortOptions.some((field) => field.value === state.intent.sort.field)) state.intent.sort.field = "";
    elements.sortFieldSelect.value = state.intent.sort.field || "";
    elements.sortFieldSelect.disabled = !canUseResult;
    elements.sortDirectionSelect.value = state.intent.sort.direction || "ASC";
    elements.sortDirectionSelect.disabled = !canUseResult;
    elements.limitInput.value = canUseResult ? state.intent.limit || 0 : 0;
    elements.limitInput.disabled = !canUseResult;
    elements.offsetInput.value = canUseResult ? state.intent.offset || 0 : 0;
    elements.offsetInput.disabled = !canUseResult;
  }

  function renderAdvancedControls() {
    elements.withInput.value = state.intent.advanced.with || "";
    elements.computedInput.value = state.intent.advanced.computed || "";
    elements.havingInput.value = state.intent.advanced.having || "";
    elements.havingInput.disabled = state.intent.action !== "aggregate";
    elements.havingInput.placeholder = state.intent.action === "aggregate" ? "COUNT(*) > :p 或 SUM(amount) > 1000" : "仅统计时可用";
    elements.unionInput.value = state.intent.advanced.union || "";
    elements.expertKindSelect.value = state.intent.expert.kind || "none";
    elements.expertSqlInput.value = state.intent.expert.sql || "";
  }

  function renderTemplates() {
    if (!state.templates.length) {
      elements.templateList.innerHTML = '<div class="empty-state">暂无模板</div>';
      return;
    }
    elements.templateList.innerHTML = state.templates
      .map(
        (item, index) => `<button class="list-button" type="button" data-load-template="${index}">
          <span>${escapeHtml(item.name)}</span><span>${escapeHtml(formatTime(item.savedAt))}</span>
        </button>`,
      )
      .join("");
  }

  function renderHistory() {
    if (selectedHistoryIndex >= state.history.length) selectedHistoryIndex = -1;
    if (!state.history.length) {
      elements.historyList.innerHTML = '<div class="empty-state">暂无历史</div>';
      elements.historySqlPreview.textContent = "选择一条历史记录查看 SQL。";
      return;
    }
    elements.historyList.innerHTML = state.history
      .map(
        (item, index) => `<button class="list-button ${index === selectedHistoryIndex ? "active" : ""}" type="button" data-preview-history="${index}">
          <span>${escapeHtml(item.summary)}</span><span>${escapeHtml(formatTime(item.savedAt))}</span>
        </button>`,
      )
      .join("");
    const item = state.history[selectedHistoryIndex];
    elements.historySqlPreview.textContent = item?.displaySql || item?.sql || "选择一条历史记录查看 SQL。";
  }

  function syncOutputs(skipHistory = false) {
    currentGenerated = generate();
    renderResultControls();
    renderBuilderSteps();
    elements.intentSentence.textContent = currentGenerated.summary;
    elements.sqlOutput.textContent = currentGenerated.displaySql;
    elements.paramSqlOutput.textContent = currentGenerated.sql;
    elements.paramsOutput.textContent = JSON.stringify(currentGenerated.params, null, 2);
    elements.explainOutput.innerHTML = currentGenerated.explain.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
    elements.riskOutput.innerHTML = renderRisks(currentGenerated.risks);
    setActiveResultTab(activeResultTab);
    saveState();
  }

  function renderRisks(risks) {
    if (!risks.length) {
      return '<div class="risk-item risk-ok">未发现明显风险；SQL 仍只生成不执行。</div>';
    }
    return risks
      .map((risk) => `<div class="risk-item risk-${risk.level}"><strong>${escapeHtml(risk.title)}</strong><br>${escapeHtml(risk.message)}</div>`)
      .join("");
  }

  function generate() {
    sanitizeCurrentIntentForDictionary();
    const context = createSqlContext();
    const expert = state.mode === "expert" && state.intent.expert.kind !== "none";
    const rawSql = expert ? generateExpertSql(context) : generateIntentSql(context);
    const sql = stripParameterMarkers(rawSql);
    const summary = buildSummary();
    const displaySql = substituteSqlParams(rawSql, context.params);
    const explain = buildExplanation(context, sql);
    const risks = buildRisks(sql, context);
    return { sql, displaySql, params: context.params, summary, explain, risks };
  }

  function createSqlContext() {
    let index = 1;
    return {
      params: [],
      addParam(fieldRef, value) {
        const parsed = parseRef(fieldRef);
        const baseName = cleanIdentifier(parsed.field || parsed.table || "value") || "value";
        const name = `${baseName}_${index}`;
        const rawPlaceholder = paramPlaceholder(name, index);
        const placeholder = displayParamPlaceholder(name, index);
        const field = getFieldByRef(fieldRef);
        this.params.push({ name, placeholder, rawPlaceholder, value, type: field?.type || "text", field: fieldRef });
        index += 1;
        return rawPlaceholder;
      },
    };
  }

  function generateIntentSql(context) {
    const intent = state.intent;
    if (!getTable(intent.baseTable)) return "-- 请先在当前数据字典中新增表，并在“对谁做”里选择主表;";
    if (intent.action === "aggregate" && !intent.aggregate.field) return "-- 当前统计方式没有可用字段，请选择另一种统计方式或新增合适的字段;";
    const parts = [];
    const supportsAdvanced = state.mode !== "normal" && isSelectLikeAction(intent.action);
    const withClause = supportsAdvanced ? normalizeWithClause(intent.advanced.with) : "";
    const unionFragment = supportsAdvanced ? normalizeUnionFragment(intent.advanced.union) : null;
    const hasUnion = Boolean(unionFragment?.sql);
    if (withClause) parts.push(`WITH ${withClause}`);

    if (intent.action === "insert") parts.push(generateInsertSql(context));
    if (intent.action === "update") parts.push(generateUpdateSql(context));
    if (intent.action === "delete") parts.push(generateDeleteSql(context));
    if (intent.action === "select" || intent.action === "aggregate") {
      if (hasUnion) {
        parts.push(generateSelectSql(context, true, false));
        parts.push(`${unionFragment.keyword}\n${unionFragment.sql}`);
        parts.push(...generateResultControlClauses());
        return `${parts.filter(Boolean).join("\n")};`;
      }
      parts.push(generateSelectSql(context));
    }

    return parts.filter(Boolean).join("\n");
  }

  function generateSelectSql(context, omitTerminator = false, includeResultControls = true, options = {}) {
    const intent = state.intent;
    const computed = state.mode !== "normal" && isSelectLikeAction(intent.action) ? splitSqlExpressions(intent.advanced.computed) : [];
    let selectItems = [];
    if (intent.action === "aggregate") {
      const dimensionFields = intent.groupBy ? intent.groupFields : [];
      selectItems = dimensionFields.map(qref);
      const field = intent.aggregate.field === "*" ? "*" : qref(intent.aggregate.field);
      const alias = aggregateSqlAlias(intent.aggregate);
      selectItems.push(`${intent.aggregate.fn.toUpperCase()}(${field}) AS ${q(alias)}`);
    } else {
      selectItems = intent.selectedFields.length ? intent.selectedFields.map(qref) : ["*"];
    }
    selectItems = selectItems.concat(computed);

    const distinct = intent.distinct ? "DISTINCT " : "";
    const top = selectTopClause(includeResultControls);
    const lines = [`SELECT ${distinct}${top}${selectItems.join(",\n       ")}`, `FROM ${q(intent.baseTable)}`];
    lines.push(...generateJoinClauses());
    const where = buildConditionSql(intent.condition, context);
    if (where) lines.push(`WHERE ${where}`);
    const groupFields = intent.action === "aggregate" && intent.groupBy ? intent.groupFields : [];
    if (groupFields.length) lines.push(`GROUP BY ${groupFields.map((field) => (field.includes('"') ? field : qref(field))).join(", ")}`);
    if (state.mode !== "normal" && intent.action === "aggregate" && text(intent.advanced.having)) lines.push(`HAVING ${text(intent.advanced.having)}`);
    if (includeResultControls) lines.push(...generateResultControlClauses(options));
    return `${lines.join("\n")}${omitTerminator ? "" : ";"}`;
  }

  function generateResultControlClauses(options = {}) {
    const intent = state.intent;
    const dialect = currentDialect();
    const lines = [];
    if (options.omitResultControls) return lines;
    const orderBy = intent.sort.field ? `ORDER BY ${sortSqlExpression(intent.sort.field)} ${intent.sort.direction}` : "";

    if (dialect.pagination === "sqlServer") {
      if (orderBy) lines.push(orderBy);
      const usesTopOnly = intent.limit > 0 && intent.offset <= 0 && !hasActiveUnion();
      const needsOffsetFetch = intent.offset > 0 || (intent.limit > 0 && !usesTopOnly);
      if (needsOffsetFetch) {
        if (!orderBy) lines.push("ORDER BY (SELECT NULL)");
        lines.push(`OFFSET ${intent.offset > 0 ? intent.offset : 0} ROWS`);
        if (intent.limit > 0) lines.push(`FETCH NEXT ${intent.limit} ROWS ONLY`);
      }
      return lines;
    }

    if (orderBy) lines.push(orderBy);
    if (dialect.pagination === "offsetFetch") {
      if (intent.offset > 0) lines.push(`OFFSET ${intent.offset} ROWS`);
      if (intent.limit > 0) lines.push(intent.offset > 0 ? `FETCH NEXT ${intent.limit} ROWS ONLY` : `FETCH FIRST ${intent.limit} ROWS ONLY`);
      return lines;
    }

    if (dialect.value === "mysql" && intent.offset > 0 && intent.limit <= 0) {
      lines.push(`LIMIT ${mysqlUnlimitedRowCount()} OFFSET ${intent.offset}`);
      return lines;
    }
    if (intent.limit > 0) lines.push(`LIMIT ${intent.limit}`);
    if (intent.offset > 0) lines.push(`OFFSET ${intent.offset}`);
    return lines;
  }

  function generateInsertSql(context) {
    const intent = state.intent;
    const fields = intent.mutationFields.filter(Boolean);
    if (!fields.length) return `-- 请选择要新增的字段后再生成 INSERT INTO ${q(intent.baseTable)};`;
    const placeholders = fields.map((field) => context.addParam(`${intent.baseTable}.${field}`, intent.mutationValues[field] ?? ""));
    return [`INSERT INTO ${q(intent.baseTable)} (${fields.map(q).join(", ")})`, `VALUES (${placeholders.join(", ")});`].join("\n");
  }

  function generateUpdateSql(context) {
    const intent = state.intent;
    const fields = intent.mutationFields.filter(Boolean);
    if (!fields.length) return `-- 请选择要修改的字段后再生成 UPDATE ${q(intent.baseTable)};`;
    const setClause = fields.map((field) => `${q(field)} = ${context.addParam(`${intent.baseTable}.${field}`, intent.mutationValues[field] ?? "")}`).join(",\n    ");
    const lines = [`UPDATE ${q(intent.baseTable)}`, `SET ${setClause}`];
    const where = buildConditionSql(intent.condition, context);
    if (where) lines.push(`WHERE ${where}`);
    return `${lines.join("\n")};`;
  }

  function generateDeleteSql(context) {
    const intent = state.intent;
    const lines = [`DELETE FROM ${q(intent.baseTable)}`];
    const where = buildConditionSql(intent.condition, context);
    if (where) lines.push(`WHERE ${where}`);
    return `${lines.join("\n")};`;
  }

  function generateExpertSql(context) {
    const intent = state.intent;
    const table = getTable(intent.baseTable);
    const raw = text(intent.expert.sql);
    if (!table && intent.expert.kind !== "raw") return "-- 请先在当前数据字典中新增表，再使用专家模式生成结构类 SQL;";
    if (intent.expert.kind === "raw") return raw || "-- 在专家 SQL 片段中填写 Raw SQL;";
    if (intent.expert.kind === "createTable") {
      const primaryFields = table.fields.filter((field) => field.primary).map((field) => field.name);
      const columns = table.fields
        .map((field) => `  ${q(field.name)} ${typeToSql(field.type)}${primaryFields.length === 1 && field.primary ? " PRIMARY KEY" : ""}`)
        .concat(primaryFields.length > 1 ? [`  PRIMARY KEY (${primaryFields.map(q).join(", ")})`] : [])
        .join(",\n");
      return `CREATE TABLE ${q(table.name)} (\n${columns || primaryKeyFallbackSql()}\n);`;
    }
    if (intent.expert.kind === "alterTable") return raw || alterAddColumnSql(intent.baseTable);
    if (intent.expert.kind === "createIndex") return raw || `CREATE INDEX ${q(`idx_${intent.baseTable}_field`)}\nON ${q(intent.baseTable)} (${q(table.fields[0]?.name || "id")});`;
    if (intent.expert.kind === "createView") {
      const viewContext = createSqlContext();
      const selectSql = isSelectLikeAction()
        ? generateSelectSql(viewContext, false, false, { omitResultControls: true })
        : `SELECT *\nFROM ${q(intent.baseTable)};`;
      const staticSelectSql = substituteSqlParams(selectSql, viewContext.params);
      return raw || `CREATE VIEW ${q(`v_${intent.baseTable}`)} AS\n${staticSelectSql}`;
    }
    if (intent.expert.kind === "transaction") return raw || `${transactionBeginSql()};\n${generateIntentSql(context)}\nCOMMIT;`;
    if (intent.expert.kind === "permission") {
      if (currentDialect().value === "sqlite") return "-- SQLite 不支持 GRANT / REVOKE；请使用操作系统文件权限控制访问。";
      return raw || `GRANT SELECT ON ${q(intent.baseTable)} TO role_name;`;
    }
    return "-- 未选择专家类型;";
  }

  function generateJoinClauses() {
    return state.intent.joins
      .filter((join) => join.table && join.left && join.right)
      .map((join) => `${dialectJoinKeyword(join.type || "INNER JOIN")} ${q(join.table)} ON ${qref(join.left)} = ${qref(join.right)}`);
  }

  function textPatternValue(operator, raw, glob = false) {
    const value = glob ? escapeGlobLiteral(raw) : escapeLikeLiteral(raw);
    if (glob) {
      if (operator === "contains") return `*${value}*`;
      if (operator === "starts_with") return `${value}*`;
      if (operator === "ends_with") return `*${value}`;
      return value;
    }
    if (operator === "contains") return `%${value}%`;
    if (operator === "starts_with") return `${value}%`;
    if (operator === "ends_with") return `%${value}`;
    return value;
  }

  function buildTextMatchCondition(fieldRef, operator, rawValue, context) {
    const dialect = currentDialect();
    const expression = qref(fieldRef);
    const mode = state.textMatchCase;
    if (mode === "caseSensitive" && dialect.value === "sqlite") {
      return `${expression} GLOB ${context.addParam(fieldRef, textPatternValue(operator, rawValue, true))}`;
    }
    const placeholder = context.addParam(fieldRef, textPatternValue(operator, rawValue));
    if (mode === "caseInsensitive") {
      if (dialect.supportsILike) return `${expression} ILIKE ${placeholder} ESCAPE '!'`;
      return `LOWER(${expression}) LIKE LOWER(${placeholder}) ESCAPE '!'`;
    }
    if (mode === "caseSensitive" && dialect.value === "mysql") {
      return `BINARY ${expression} LIKE ${placeholder} ESCAPE '!'`;
    }
    return `${expression} LIKE ${placeholder} ESCAPE '!'`;
  }

  function buildConditionSql(node, context) {
    if (!node) return "";
    if (node.type === "condition") {
      if (!node.field) return "";
      if (!conditionFieldAllowedInSql(node.field)) return "";
      const operator = node.operator || "=";
      if (operator === "is_null") return `${qref(node.field)} IS NULL`;
      if (operator === "is_not_null") return `${qref(node.field)} IS NOT NULL`;
      if (operator === "between") {
        const [left, right] = splitValues(node.value);
        return `${qref(node.field)} BETWEEN ${context.addParam(node.field, left ?? "")} AND ${context.addParam(node.field, right ?? "")}`;
      }
      if (operator === "in") {
        const values = splitValues(node.value);
        if (!values.length) return "";
        return `${qref(node.field)} IN (${values.map((value) => context.addParam(node.field, value)).join(", ")})`;
      }
      if (["contains", "starts_with", "ends_with"].includes(operator)) return buildTextMatchCondition(node.field, operator, node.value, context);
      return `${qref(node.field)} ${operator} ${context.addParam(node.field, node.value ?? "")}`;
    }
    const children = node.children.map((child) => buildConditionSql(child, context)).filter(Boolean);
    if (!children.length) return "";
    const grouped = children.length === 1 ? children[0] : `(${children.join(` ${node.logic} `)})`;
    return node.not ? `NOT (${grouped})` : grouped;
  }

  function conditionHasUnsupportedSqlField(node) {
    if (!node) return false;
    if (node.type === "condition") return Boolean(node.field) && fieldRefExists(node.field) && !conditionFieldAllowedInSql(node.field);
    return (node.children || []).some(conditionHasUnsupportedSqlField);
  }

  function buildSummary() {
    const intent = state.intent;
    const table = getTable(intent.baseTable);
    const actionText = ACTIONS.find((action) => action.value === intent.action)?.label || "查询";
    if (!table) return "请先在当前数据字典中新增表和字段，然后选择要查询的对象。";
    const target = `${table.label}(${table.name})`;
    const fields =
      intent.action === "delete"
        ? "不返回字段"
        : intent.action === "aggregate"
          ? intent.groupBy && intent.groupFields.length
            ? `${aggregateLabel(intent.aggregate)}，按 ${fieldListLabel(intent.groupFields)} 分组`
            : `${aggregateLabel(intent.aggregate)}，不保留明细字段`
          : ["insert", "update"].includes(intent.action)
            ? `写入 ${intent.mutationFields.length || 0} 个字段`
            : `保留 ${fieldListLabel(intent.selectedFields)}`;
    const relations = isSelectLikeAction(intent.action) && intent.joins.length ? `，关联 ${intent.joins.map((join) => tableLabel(join.table)).join("、")}` : "";
    const condition = intent.action === "insert" ? "" : conditionLabel(intent.condition);
    const unsupportedCondition = intent.action !== "insert" && conditionHasUnsupportedSqlField(intent.condition);
    const order = isSelectLikeAction(intent.action) && intent.sort.field ? `，按 ${sortFieldLabel(intent.sort.field)} ${intent.sort.direction === "DESC" ? "倒序" : "正序"} 排列` : "";
    const pageParts = [];
    if (isSelectLikeAction(intent.action) && intent.limit) pageParts.push(`最多 ${intent.limit} 条`);
    if (isSelectLikeAction(intent.action) && intent.offset) pageParts.push(`跳过 ${intent.offset} 条`);
    const page = pageParts.length ? `，${pageParts.join("，")}` : "";
    const conditionText = intent.action === "insert" ? "，新增不使用条件" : condition ? `，条件是 ${condition}${unsupportedCondition ? "（部分条件不会生成）" : ""}` : "，当前没有条件";
    return `${actionText} ${target}：${fields}${relations}${conditionText}${order}${page}。`;
  }

  function buildExplanation(context, sql) {
    const intent = state.intent;
    const lines = [];
    const dialect = currentDialect();
    lines.push("系统只在本地根据意图生成 SQL、参数和说明，不连接也不执行任何数据库。");
    lines.push(`当前数据库方言：${dialect.label}${dialect.value === "sqlite" ? `（${casePolicyLabel(SQLITE_VERSION_POLICIES, state.sqliteVersion)}）` : ""}；标识符引用、分页、参数占位符和建表字段类型会按该方言生成。`);
    lines.push(`大小写策略：标识符${casePolicyLabel(IDENTIFIER_CASE_POLICIES, state.identifierCase)}，${casePolicyLabel(IDENTIFIER_QUOTE_POLICIES, state.identifierQuote)}；文本 LIKE 匹配${casePolicyLabel(TEXT_MATCH_CASE_POLICIES, state.textMatchCase)}。${dialect.identifierCaseNote || ""} ${dialect.textCaseNote || ""}`.trim());
    if (!getTable(intent.baseTable)) {
      lines.push("当前还没有可生成 SQL 的主表。先在左侧新增数据字典、表和字段。");
      return lines;
    }
    lines.push(`本次操作是 ${ACTIONS.find((item) => item.value === intent.action)?.label}，主表是 ${tableLabel(intent.baseTable)}。`);
    if (isSelectLikeAction(intent.action) && intent.joins.length) lines.push(`关联关系：${intent.joins.map((join) => relationSentence(join)).join("；")}。`);
    if (context.params.length) lines.push(`用户输入值已转换为 ${context.params.length} 个命名参数；SQL预览页会代入显示，参数化页保留占位符版本。`);
    if (intent.action === "aggregate" && intent.groupBy) lines.push(`结果会按 ${fieldListLabel(intent.groupFields)} 分组。`);
    if (isSelectLikeAction(intent.action) && intent.sort.field) lines.push(`结果会按 ${sortFieldLabel(intent.sort.field)} ${intent.sort.direction === "DESC" ? "倒序" : "正序"}排序。`);
    lines.push(`WHERE 条件：${intent.action === "insert" ? "新增不使用 WHERE 条件" : conditionLabel(intent.condition) || "无"}。`);
    if (hasApplicableAdvancedFragment()) lines.push("高级片段会原样进入 SQL，请把 WITH、HAVING、UNION、函数和 CASE 控制在可信模板内。");
    if (state.mode === "expert" && intent.expert.kind !== "none") lines.push("专家模式可能生成 DDL、权限、事务或 Raw SQL，适合熟悉 SQL 后再使用。");
    lines.push(`生成 SQL 长度 ${sql.length} 个字符。`);
    return lines;
  }

  function currentDictionaryIdentifierNames() {
    return state.dictionary.flatMap((table) => [table.name, ...(table.fields || []).map((field) => field.name)]);
  }

  function identifiersNeedQuotes() {
    return currentDictionaryIdentifierNames()
      .map(normalizeIdentifierOutput)
      .filter((name) => !isSafeUnquotedIdentifier(name));
  }

  function buildRisks(sql, context) {
    const intent = state.intent;
    const risks = [];
    const hasWhere = /\bWHERE\b/i.test(sql);
    if (!getTable(intent.baseTable)) {
      risks.push({ level: "low", title: "尚未选择主表", message: "当前字典还没有可用于生成 SQL 的主表。" });
      return risks;
    }
    if (["update", "delete"].includes(intent.action) && conditionHasUnsupportedSqlField(intent.condition)) {
      risks.push({ level: "medium", title: "关联表条件未生成", message: "普通修改/删除只支持主表条件；关联表条件已从 SQL 中跳过，避免生成无效语句。" });
    }
    if (["update", "delete"].includes(intent.action) && !hasWhere) {
      risks.push({ level: "high", title: "无条件修改/删除", message: "当前 SQL 没有 WHERE 条件，如果执行会影响整张表。" });
    }
    if (intent.action === "update" && !intent.mutationFields.length) {
      risks.push({ level: "medium", title: "未选择修改字段", message: "UPDATE 需要至少一个 SET 字段，否则 SQL 只是占位草稿。" });
    }
    if (intent.action === "insert" && !intent.mutationFields.length) {
      risks.push({ level: "medium", title: "未选择新增字段", message: "INSERT 需要至少一个字段和值。" });
    }
    if (["select", "aggregate"].includes(intent.action) && !intent.selectedFields.length && intent.action !== "aggregate") {
      risks.push({ level: "low", title: "返回全部字段", message: "未选择输出字段时会生成 SELECT *，可能暴露不需要的列。" });
    }
    if (["select", "aggregate"].includes(intent.action) && !intent.limit && !hasWhere) {
      risks.push({ level: "low", title: "无分页全表查询", message: "没有 WHERE 且没有 LIMIT，真实执行时可能扫描大量数据。" });
    }
    if (hasApplicableAdvancedFragment()) {
      risks.push({ level: "medium", title: "高级 SQL 片段", message: "WITH、HAVING、UNION 或计算字段为手写片段，系统不会完全解析其语义。" });
    }
    const unsupportedJoin = unsupportedJoinTypesForCurrentSettings().find((joinType) => intent.joins.some((join) => String(join.type).toUpperCase() === joinType));
    if (unsupportedJoin) {
      risks.push({ level: "high", title: "当前方言不支持部分 JOIN", message: `${currentDialect().label} 当前设置不支持 ${unsupportedJoin}，系统会阻止在关系菜单中选择该类型；如需兼容，请改写为 LEFT/RIGHT JOIN + UNION。` });
    }
    if (currentDialect().value === "mysql" && intent.offset > 0 && intent.limit <= 0 && ["select", "aggregate"].includes(intent.action)) {
      risks.push({ level: "low", title: "MySQL 无限跳过已改写", message: `MySQL 不支持裸 OFFSET，当前会生成 LIMIT ${mysqlUnlimitedRowCount()} OFFSET ${intent.offset} 来表达“跳过但不限制返回条数”。` });
    }
    const unsafeIdentifiers = state.identifierQuote === "never" ? identifiersNeedQuotes() : [];
    if (unsafeIdentifiers.length) {
      risks.push({ level: "medium", title: "未引用标识符风险", message: `当前选择“不引用”标识符，但 ${unsafeIdentifiers.slice(0, 5).join("、")} 可能是关键字或不符合普通标识符规则。` });
    }
    if (state.identifierQuote === "always" && currentDialect().quotedIdentifiersCaseSensitive) {
      risks.push({ level: "low", title: "引用标识符大小写敏感", message: `${currentDialect().label} 中被引用的表名/字段名通常需要和真实库对象大小写完全一致；如果真实库使用未引用建表，建议选择“必要时引用”并统一大小写。` });
    }
    if (state.textMatchCase === "dialectDefault" && ["mysql", "sqlserver", "sqlite", "generic", "dameng"].includes(currentDialect().value)) {
      risks.push({ level: "low", title: "LIKE 大小写取决于环境", message: `${currentDialect().label} 的文本匹配可能受 collation、兼容模式或数据库设置影响；需要稳定结果时请选择“忽略大小写”或“区分大小写”。` });
    }
    if (state.textMatchCase === "caseSensitive" && ["sqlserver", "generic", "dameng"].includes(currentDialect().value)) {
      risks.push({ level: "medium", title: "强制区分大小写可能仍受排序规则影响", message: `${currentDialect().label} 对大小写敏感匹配的最终行为可能仍取决于真实库 collation/兼容模式；必要时在专家片段中指定数据库原生 COLLATE。` });
    }
    if (state.mode === "expert" && intent.expert.kind !== "none") {
      risks.push({ level: intent.expert.kind === "raw" ? "high" : "medium", title: "专家模式", message: "专家模式可生成结构、权限、事务或 Raw SQL，当前仍只生成不执行。" });
    }
    if (context.params.some((param) => text(param.value) === "")) {
      risks.push({ level: "low", title: "空参数", message: "存在空参数值，请确认这是有意为空，而不是尚未填写。" });
    }
    return risks;
  }

  function attachEvents() {
    $(".mode-switch").addEventListener("click", (event) => {
      const button = event.target.closest("[data-mode]");
      if (!button) return;
      state.mode = button.dataset.mode;
      render();
    });

    elements.dialectSelect?.addEventListener("change", () => {
      state.dialect = elements.dialectSelect.value;
      const changed = sanitizeCurrentJoinsForDialect();
      render();
      if (changed) showToast(`${currentDialect().label} 不支持已选 JOIN，已自动改为“保留主表”。`);
    });

    elements.sqliteVersionSelect?.addEventListener("change", () => {
      state.sqliteVersion = elements.sqliteVersionSelect.value;
      const changed = sanitizeCurrentJoinsForDialect();
      render();
      if (changed) showToast("当前 SQLite 版本设置不支持 RIGHT/FULL JOIN，已自动改为“保留主表”。");
    });

    elements.identifierQuoteSelect?.addEventListener("change", () => {
      state.identifierQuote = elements.identifierQuoteSelect.value;
      render();
    });

    elements.identifierCaseSelect?.addEventListener("change", () => {
      state.identifierCase = elements.identifierCaseSelect.value;
      render();
    });

    elements.textMatchCaseSelect?.addEventListener("change", () => {
      state.textMatchCase = elements.textMatchCaseSelect.value;
      render();
    });

    elements.builderStepTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-builder-step]");
      if (!button) return;
      activeBuilderStep = button.dataset.builderStep;
      renderBuilderSteps();
    });

    elements.actionButtons.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      state.intent.action = button.dataset.action;
      if (state.intent.action === "aggregate" && !state.intent.aggregate.field) state.intent.aggregate.field = "*";
      sanitizeIntentForAction();
      render();
    });

    elements.baseTableSelect.addEventListener("change", () => setIntentBaseTable(elements.baseTableSelect.value));

    elements.dictionarySelect.addEventListener("change", () => switchDictionary(elements.dictionarySelect.value));
    elements.pasteImportForm.addEventListener("submit", handlePasteImportSubmit);

    elements.openDictionaryManageButton.addEventListener("click", openDictionaryManager);
    elements.dictionaryManageModal.addEventListener("click", (event) => { if (event.target.closest("[data-close-dictionary-manage]")) elements.dictionaryManageModal.hidden = true; });
    elements.addDictionaryRowButton.addEventListener("click", () => { dictionaryManageRows.push({ id: "", name: "", selected: false }); renderDictionaryManagerRows(); });
    elements.deleteDictionaryRowsButton.addEventListener("click", () => { if (!dictionaryManageRows.some((row) => row.selected)) return showToast("请先勾选要删除的字典。"); dictionaryManageRows = dictionaryManageRows.filter((row) => !row.selected); renderDictionaryManagerRows(); });
    elements.dictionaryManageRows.addEventListener("input", handleDictionaryManagerInput);
    elements.dictionaryManageRows.addEventListener("change", handleDictionaryManagerInput);
    elements.saveDictionaryManagerButton.addEventListener("click", saveDictionaryManager);
    elements.dictionaryImportModal.addEventListener("click", (event) => { if (event.target.closest("[data-close-dictionary-import]")) elements.dictionaryImportModal.hidden = true; });

    elements.dictionaryList.addEventListener("click", handleDictionaryClick);
    elements.tableEditorModal.addEventListener("click", (event) => { if (event.target.closest("[data-close-table-editor]")) closeTableStructureEditor(); });
    elements.addStructureRowButton.addEventListener("click", () => { tableStructureEditor.rows.push(createStructureRow()); renderTableStructureEditorRows(); });
    elements.deleteStructureRowsButton.addEventListener("click", () => { const count = tableStructureEditor.rows.filter((row) => row.selected).length; if (!count) return showToast("请先勾选要删除的行。"); tableStructureEditor.rows = tableStructureEditor.rows.filter((row) => !row.selected); renderTableStructureEditorRows(); });
    elements.saveTableStructureButton.addEventListener("click", saveTableStructureEditor);
    elements.tableEditorRows.addEventListener("input", handleTableStructureInput);
    elements.tableEditorRows.addEventListener("change", handleTableStructureChange);
    elements.tableEditorRows.addEventListener("click", handleTableStructureRowClick);
    elements.tableEditorGrid.addEventListener("paste", handleTableStructurePaste);
    elements.distinctInput.addEventListener("change", () => {
      state.intent.distinct = elements.distinctInput.checked;
      syncOutputs();
    });

    elements.aggregateSelect.addEventListener("change", () => {
      state.intent.aggregate.fn = elements.aggregateSelect.value;
      sanitizeIntentForAction();
      render();
    });

    elements.aggregateFieldSelect.addEventListener("change", () => {
      state.intent.aggregate.field = elements.aggregateFieldSelect.value;
      syncOutputs();
    });

    elements.fieldSelector.addEventListener("change", (event) => {
      const output = event.target.closest("[data-output-field]");
      const mutation = event.target.closest("[data-mutation-toggle]");
      if (output) {
        toggleArrayValue(state.intent.selectedFields, output.dataset.outputField, output.checked);
      }
      if (mutation) {
        toggleArrayValue(state.intent.mutationFields, mutation.dataset.mutationToggle, mutation.checked);
      }
      render();
    });

    elements.mutationValues.addEventListener("input", (event) => {
      const input = event.target.closest("[data-mutation-field]");
      if (!input) return;
      state.intent.mutationValues[input.dataset.mutationField] = input.value;
      syncOutputs();
    });

    elements.addJoinButton.addEventListener("click", () => {
      if (!isSelectLikeAction()) return showToast("只有查询和统计需要表关系。");
      if (!getTable(state.intent.baseTable)) return showToast("请先选择主表。");
      if (state.dictionary.length < 2) return showToast("至少需要两张表才能建立关系。");
      const joinedTables = new Set(state.intent.joins.map((join) => join.table));
      const target = state.dictionary.find((table) => table.name !== state.intent.baseTable && !joinedTables.has(table.name));
      if (!target) return showToast("每张关联表只能加入一次；如需多次关联同一张表，请在数据字典中建立别名表后再添加。");
      const targetName = target?.name || state.intent.baseTable;
      const guessedJoin = guessJoinFields(state.intent.baseTable, targetName);
      state.intent.joins.push({
        type: "LEFT JOIN",
        table: targetName,
        left: guessedJoin.left,
        right: guessedJoin.right,
        note: "",
      });
      render();
    });

    elements.joinEditor.addEventListener("change", updateJoinFromEvent);
    elements.joinEditor.addEventListener("input", updateJoinFromEvent);
    elements.joinEditor.addEventListener("click", (event) => {
      const fieldChoice = event.target.closest("[data-join-field-choice]");
      if (fieldChoice) {
        const row = fieldChoice.closest("[data-join-index]");
        const join = state.intent.joins[Number(row?.dataset.joinIndex)];
        if (!join) return;
        join[fieldChoice.dataset.joinFieldChoice] = fieldChoice.dataset.joinFieldValue;
        render();
        return;
      }
      const button = event.target.closest("[data-remove-join]");
      if (!button) return;
      state.intent.joins.splice(Number(button.dataset.removeJoin), 1);
      render();
    });

    document.addEventListener("click", (event) => {
      const currentPanel = event.target.closest(".relation-field-picker, .condition-advanced");
      $$(".relation-field-picker[open], .condition-advanced[open]").forEach((panel) => {
        if (panel !== currentPanel) panel.open = false;
      });
    });

    elements.addRootConditionButton.addEventListener("click", () => {
      addCondition(state.intent.condition.id);
      render();
    });
    elements.conditionTree.addEventListener("click", handleConditionClick);
    elements.conditionTree.addEventListener("change", handleConditionChange);
    elements.conditionTree.addEventListener("input", handleConditionInput);

    elements.groupByToggle.addEventListener("change", () => {
      if (state.intent.action !== "aggregate") return;
      state.intent.groupBy = elements.groupByToggle.checked;
      if (state.intent.groupBy && !state.intent.groupFields.length) state.intent.groupFields = getAvailableFields().slice(0, 1).map((field) => field.ref);
      sanitizeIntentForAction();
      render();
    });
    elements.groupBySelect.addEventListener("change", () => {
      state.intent.groupFields = selectedOptions(elements.groupBySelect);
      sanitizeIntentForAction();
      render();
    });
    elements.sortFieldSelect.addEventListener("change", () => {
      state.intent.sort.field = elements.sortFieldSelect.value;
      sanitizeIntentForAction();
      syncOutputs();
    });
    elements.sortDirectionSelect.addEventListener("change", () => {
      state.intent.sort.direction = elements.sortDirectionSelect.value;
      syncOutputs();
    });
    elements.limitInput.addEventListener("input", () => {
      state.intent.limit = clampNumber(elements.limitInput.value, 0, 100000, 0);
      syncOutputs();
    });
    elements.offsetInput.addEventListener("input", () => {
      state.intent.offset = clampNumber(elements.offsetInput.value, 0, 1000000, 0);
      syncOutputs();
    });

    [
      ["withInput", "with"],
      ["computedInput", "computed"],
      ["havingInput", "having"],
      ["unionInput", "union"],
    ].forEach(([id, key]) => {
      elements[id].addEventListener("input", () => {
        state.intent.advanced[key] = elements[id].value;
        syncOutputs();
      });
    });
    elements.expertKindSelect.addEventListener("change", () => {
      state.intent.expert.kind = elements.expertKindSelect.value;
      syncOutputs();
    });
    elements.expertSqlInput.addEventListener("input", () => {
      state.intent.expert.sql = elements.expertSqlInput.value;
      syncOutputs();
    });

    $$(".result-tab").forEach((button) => {
      button.addEventListener("click", () => setActiveResultTab(button.dataset.tab));
    });

    elements.copySqlButton.addEventListener("click", async () => {
      try {
        await copyTextToClipboard(currentGenerated?.displaySql || currentGenerated?.sql || "");
        showToast("SQL 已复制。");
      } catch {
        selectElementText(elements.sqlOutput);
        showToast("当前浏览器不允许直接复制，已选中 SQL，请按 Ctrl+C。");
      }
    });

    elements.saveHistoryButton.addEventListener("click", () => {
      recordHistory(currentGenerated);
      showToast("已保存到历史。");
    });

    elements.historyList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-preview-history]");
      if (!button) return;
      selectedHistoryIndex = Number(button.dataset.previewHistory);
      renderHistory();
    });

    elements.connectFileSyncButton.addEventListener("click", connectFileSync);
    elements.createFileSyncButton.addEventListener("click", createFileSync);
    elements.saveFileSyncButton.addEventListener("click", () => writeFileSyncPayload());
    elements.openFileSyncButton.addEventListener("click", openFileSyncModal);
    elements.openHistoryButton.addEventListener("click", openHistoryModal);
    elements.fileSyncModal.addEventListener("click", (event) => { if (event.target.closest("[data-close-file-sync-modal]")) closeFileSyncModal(); });
    elements.historyModal.addEventListener("click", (event) => { if (event.target.closest("[data-close-history-modal]")) elements.historyModal.hidden = true; });
  }

  function updateJoinFromEvent(event) {
    const control = event.target.closest("[data-join-prop]");
    const row = event.target.closest("[data-join-index]");
    if (!control || !row) return;
    const join = state.intent.joins[Number(row.dataset.joinIndex)];
    if (!join) return;
    if (control.dataset.joinProp === "type" && !isJoinTypeSupported(control.value)) {
      join.type = "LEFT JOIN";
      render();
      showToast(`${currentDialect().label} 当前设置不支持该 JOIN，已改为“保留主表”。`);
      return;
    }
    if (control.dataset.joinProp === "table" && state.intent.joins.some((item, index) => index !== Number(row.dataset.joinIndex) && item.table === control.value)) {
      showToast("同一张表不能重复关联；当前版本不生成表别名。");
      render();
      return;
    }
    join[control.dataset.joinProp] = control.value;
    if (control.dataset.joinProp === "table") {
      const table = getTable(control.value);
      join.right = table ? `${table.name}.${table.fields[0]?.name || "id"}` : "";
      render();
      return;
    }
    syncOutputs();
    renderGraph();
  }

  function handleConditionClick(event) {
    const addConditionButton = event.target.closest("[data-add-condition]");
    const addGroupButton = event.target.closest("[data-add-group]");
    const removeButton = event.target.closest("[data-remove-node]");
    const convertButton = event.target.closest("[data-convert-group]");
    if (addConditionButton) {
      addCondition(addConditionButton.dataset.addCondition);
      render();
    }
    if (addGroupButton) {
      addGroup(addGroupButton.dataset.addGroup);
      render();
    }
    if (removeButton) {
      removeNode(removeButton.dataset.removeNode);
      render();
    }
    if (convertButton) {
      convertConditionToGroup(convertButton.dataset.convertGroup);
      render();
    }
  }

  function handleConditionChange(event) {
    const nodeElement = event.target.closest("[data-node-id]");
    if (!nodeElement) return;
    const node = findNode(state.intent.condition, nodeElement.dataset.nodeId);
    if (!node) return;
    const conditionProp = event.target.closest("[data-condition-prop]");
    const groupProp = event.target.closest("[data-group-prop]");
    if (conditionProp) node[conditionProp.dataset.conditionProp] = conditionProp.value;
    if (groupProp) {
      if (groupProp.dataset.groupProp === "not") node.not = groupProp.checked;
      if (groupProp.dataset.groupProp === "logic") node.logic = groupProp.value;
    }
    if (node.type === "condition" && !node.field) {
      const fieldSelect = nodeElement.querySelector('[data-condition-prop="field"]');
      if (fieldSelect?.value) node.field = fieldSelect.value;
    }
    syncOutputs();
  }

  function handleConditionInput(event) {
    const input = event.target.closest('[data-condition-prop="value"]');
    const nodeElement = event.target.closest("[data-node-id]");
    if (!input || !nodeElement) return;
    const node = findNode(state.intent.condition, nodeElement.dataset.nodeId);
    if (!node) return;
    node.value = input.value;
    syncOutputs();
  }

  function addCondition(groupId) {
    const group = findNode(state.intent.condition, groupId);
    const firstField = getConditionFields()[0]?.ref || "";
    if (!firstField) return showToast(state.intent.action === "insert" ? "新增操作不需要条件。" : "请先新增表和字段，再添加条件。");
    if (group?.type === "group") group.children.push({ id: uid(), type: "condition", field: firstField, operator: "=", value: "" });
  }

  function addGroup(groupId) {
    const group = findNode(state.intent.condition, groupId);
    if (group?.type === "group") group.children.push({ id: uid(), type: "group", logic: "AND", not: false, children: [] });
  }

  function removeNode(nodeId, node = state.intent.condition) {
    if (node.type !== "group") return false;
    const index = node.children.findIndex((child) => child.id === nodeId);
    if (index >= 0) {
      node.children.splice(index, 1);
      return true;
    }
    return node.children.some((child) => removeNode(nodeId, child));
  }

  function convertConditionToGroup(nodeId, node = state.intent.condition) {
    if (node.type !== "group") return false;
    const index = node.children.findIndex((child) => child.id === nodeId);
    if (index >= 0 && node.children[index].type === "condition") {
      const old = node.children[index];
      node.children[index] = { id: uid(), type: "group", logic: "AND", not: false, children: [old] };
      return true;
    }
    return node.children.some((child) => convertConditionToGroup(nodeId, child));
  }

  function findNode(node, nodeId) {
    if (!node) return null;
    if (node.id === nodeId) return node;
    if (node.type !== "group") return null;
    for (const child of node.children) {
      const found = findNode(child, nodeId);
      if (found) return found;
    }
    return null;
  }

  function handlePasteImportSubmit(event) {
    event.preventDefault();
    const format = PASTE_FORMATS.find((item) => item.value === elements.pasteFormatSelect.value);
    const raw = elements.dictionaryPasteInput.value;
    if (!format) return showToast("暂不支持该粘贴格式。");
    if (!text(raw)) return showToast("请先粘贴数据字典内容。");
    try {
      const parsed = format.parse(raw);
      const result = applyParsedDictionaryTable(parsed);
      elements.dictionaryPasteInput.value = "";
      elements.pasteImportStatus.textContent = `已按 ${format.label} 导入：${result.tableLabel}，新增 ${result.added} 个字段，更新 ${result.updated} 个字段。`;
      elements.dictionaryImportModal.hidden = true;
      render();
      showToast(`已导入 ${result.tableLabel}。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "导入失败。";
      elements.pasteImportStatus.textContent = message;
      showToast(message);
    }
  }

  function applyParsedDictionaryTable(parsed) {
    if (!parsed?.name || !parsed?.fields?.length) throw new Error("未识别到有效表或字段。");
    const tableName = cleanIdentifier(parsed.name);
    if (!tableName) throw new Error("未识别到合法表名。");
    let table = getTable(tableName);
    let added = 0;
    let updated = 0;
    const normalizedFields = parsed.fields
      .map((field) => ({
        name: cleanIdentifier(field.name),
        label: text(field.label) || field.name,
        type: normalizeFieldType(field.type, field.referenceModel, field.label),
        primary: Boolean(field.primary),
      }))
      .filter((field) => field.name);
    if (!normalizedFields.length) throw new Error("未识别到有效字段。");

    if (!table) {
      table = { name: tableName, label: text(parsed.label) || tableName, fields: [] };
      state.dictionary.push(table);
    } else {
      table.label = text(parsed.label) || table.label;
    }

    normalizedFields.forEach((field) => {
      const existing = table.fields.find((item) => item.name === field.name);
      if (existing) {
        existing.label = field.label;
        existing.type = field.type;
        existing.primary = field.primary;
        updated += 1;
      } else {
        table.fields.push(field);
        added += 1;
      }
    });

    syncActiveDictionaryState();
    state.selectedDictionaryTable = table.name;
    if (!state.intent.baseTable || !getTable(state.intent.baseTable)) {
      state.intent = createDefaultIntent(table.name);
    }
    if (state.intent.baseTable === table.name && !state.intent.selectedFields.length) {
      state.intent.selectedFields = defaultFieldsForTable(table.name);
    }
    sanitizeCurrentIntentForDictionary();
    return { tableLabel: `${table.label}(${table.name})`, added, updated };
  }

  function parseBipDictionaryFormat(raw) {
    const lines = String(raw || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => text(line));
    const titleLine = lines.find((line) => extractBipTableTitle(line));
    if (!titleLine) throw new Error("BIP数据字典格式未识别到表名行，例如：合同基本信息 (alo_contract_b/...)。");
    const titleInfo = extractBipTableTitle(titleLine);
    const tableLabel = titleInfo.label;
    const tableCode = titleInfo.code;
    const tableName = cleanIdentifier(tableCode);
    if (!tableName) throw new Error("BIP数据字典格式未识别到括号内的表编码。");

    const headerIndex = lines.findIndex((line) => line.includes("属性编码") && line.includes("字段编码"));
    if (headerIndex < 0) throw new Error("BIP数据字典格式未识别到字段表头。");
    const rowTexts = [];
    let current = "";
    for (const line of lines.slice(headerIndex + 1)) {
      if (/^\s*\d+\s*\t/.test(line)) {
        if (current) rowTexts.push(current);
        current = line;
      } else if (current) {
        current += `\n${line}`;
      }
    }
    if (current) rowTexts.push(current);

    const fields = rowTexts.map(parseBipFieldRow).filter(Boolean);
    if (!fields.length) throw new Error("BIP数据字典格式未识别到字段明细。");
    return { name: tableName, label: tableLabel || tableName, fields };
  }

  function extractBipTableTitle(line) {
    const source = String(line || "");
    const matches = Array.from(source.matchAll(/\(([^)]*)\)/g));
    const tableMatch =
      matches.find((match) => /^[A-Za-z_][A-Za-z0-9_]*\s*\//.test(text(match[1]))) ||
      matches.find((match) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(text(match[1])));
    if (!tableMatch) return null;
    const code = text(tableMatch[1]).split("/")[0];
    return {
      label: text(source.slice(0, tableMatch.index)),
      code,
    };
  }

  function parseBipFieldRow(rowText) {
    const columns = rowText.split("\t").map((cell) => cell.trim());
    const attrCode = columns[1] || "";
    const attrName = columns[2] || "";
    const fieldCode = columns[3] || attrCode;
    if (!fieldCode) return null;
    const fieldType = columns[4] || "text";
    const required = columns[5] || "";
    const referenceModel = columns[6] || "";
    const enumText = columns[8] || "";
    return {
      name: fieldCode,
      label: attrName || attrCode || fieldCode,
      type: fieldType,
      required: required.includes("√"),
      referenceModel,
      enumText,
      primary: /主键/.test(referenceModel) || /主键/.test(attrName),
    };
  }

  function normalizeFieldType(rawType, referenceModel = "", label = "") {
    const value = `${rawType} ${referenceModel} ${label}`.toLowerCase();
    if (/bool|boolean/.test(value)) return "boolean";
    if (/date|time|日期|ufdate/.test(value)) return "date";
    if (/int|decimal|number|numeric|double|float|金额|整数|ufmoney/.test(value)) return "number";
    return "text";
  }

  function setDictionaryToolOpen(toolName) {
    elements.dictionaryManageModal.hidden = toolName !== "dictionary";
  }

  function startAddDictionary() {
    resetDictionaryForm();
    setDictionaryToolOpen("dictionary");
    elements.dictionaryNameInput.focus();
  }

  function startAddTable() {
    selectedDictionaryField = "";
    openTableStructureEditor();
  }

  function startAddField(tableName) {
    const table = getTable(tableName);
    if (!table) return showToast("请先在字典树中选择一张表。");
    state.selectedDictionaryTable = table.name;
    selectedDictionaryField = "";
    expandedTableNames.add(table.name);
    openTableStructureEditor(table.name, { appendRow: true });
  }

  function setIntentBaseTable(tableName) {
    if (!getTable(tableName)) return showToast("请先选择有效表。");
    if (state.intent.baseTable === tableName) {
      state.selectedDictionaryTable = tableName;
      selectedDictionaryField = "";
      render();
      showToast(`${tableLabel(tableName)} 已经是主表。`);
      return;
    }
    applyBaseTableSelection(tableName);
    render();
    showToast(`已把 ${tableLabel(tableName)} 设为主表。`);
  }

  function openDictionaryManager() {
    dictionaryManageRows = state.dictionaries.map((dictionary) => ({ id: dictionary.id, name: dictionary.name, selected: false }));
    renderDictionaryManagerRows();
    elements.dictionaryManageModal.hidden = false;
  }

  function renderDictionaryManagerRows() {
    elements.dictionaryManageRows.innerHTML = dictionaryManageRows.map((row, index) => `<tr><td><input type="checkbox" data-dictionary-row-selected="${index}" ${row.selected ? "checked" : ""} /></td><td>${index + 1}</td><td><input type="text" data-dictionary-row-name="${index}" value="${escapeAttr(row.name)}" placeholder="例如 销售数据字典" /></td><td>${row.id === state.activeDictionaryId ? '<span class="tree-badge">当前</span>' : row.id ? "已有字典" : "新增字典"}</td></tr>`).join("") || '<tr><td colspan="4" class="empty-state">至少保留一行字典。</td></tr>';
  }

  function handleDictionaryManagerInput(event) {
    const nameInput = event.target.closest("[data-dictionary-row-name]");
    const selectedInput = event.target.closest("[data-dictionary-row-selected]");
    if (nameInput) dictionaryManageRows[Number(nameInput.dataset.dictionaryRowName)].name = nameInput.value;
    if (selectedInput) dictionaryManageRows[Number(selectedInput.dataset.dictionaryRowSelected)].selected = selectedInput.checked;
  }

  function saveDictionaryManager() {
    const rows = dictionaryManageRows.map((row) => ({ ...row, name: text(row.name) })).filter((row) => row.name);
    if (!rows.length) return showToast("请至少保留一个数据字典。");
    if (new Set(rows.map((row) => row.name)).size !== rows.length) return showToast("数据字典名称不能重复。");
    syncActiveDictionaryState();
    const existing = new Map(state.dictionaries.map((dictionary) => [dictionary.id, dictionary]));
    const retainedIds = new Set(rows.map((row) => row.id).filter(Boolean));
    const removedWithTables = state.dictionaries.filter((dictionary) => !retainedIds.has(dictionary.id) && dictionary.tables.length);
    if (removedWithTables.length) {
      const names = removedWithTables.map((dictionary) => `${dictionary.name}（${dictionary.tables.length} 张表）`).join("、");
      if (!window.confirm(`以下数据字典包含表，删除后其中的表和字段都会移除：\n${names}\n\n确定继续保存吗？`)) return;
    }
    const next = rows.map((row) => {
      const dictionary = existing.get(row.id);
      return dictionary ? { ...dictionary, name: row.name } : createEmptyDictionary(row.name);
    });
    state.dictionaries = next;
    if (!next.some((dictionary) => dictionary.id === state.activeDictionaryId)) state.activeDictionaryId = next[0].id;
    state.dictionary = getActiveDictionary().tables;
    state.selectedDictionaryTable = state.dictionary[0]?.name || "";
    sanitizeCurrentIntentForDictionary();
    elements.dictionaryManageModal.hidden = true;
    render();
    showToast("数据字典已保存。");
  }

  function applyBaseTableSelection(tableName) {
    if (!getTable(tableName)) return;
    state.intent.baseTable = tableName;
    state.selectedDictionaryTable = tableName;
    selectedDictionaryField = "";
    state.intent.selectedFields = defaultFieldsForTable(tableName);
    state.intent.mutationFields = [];
    state.intent.mutationValues = {};
    state.intent.joins = [];
    state.intent.groupFields = [];
    state.intent.sort.field = "";
    state.intent.condition = { id: uid(), type: "group", logic: "AND", not: false, children: [] };
  }

  function toggleFieldInIntent(tableName, fieldName) {
    const table = getTable(tableName);
    const field = table?.fields.find((item) => item.name === fieldName);
    if (!table || !field) return showToast("字段不存在。");
    state.selectedDictionaryTable = tableName;
    selectedDictionaryField = fieldName;
    if (state.intent.action === "delete") return showToast("删除操作不需要输出字段，只需要设置条件。");
    const switchedBase = state.intent.baseTable !== tableName && !state.intent.joins.some((join) => join.table === tableName);
    if (switchedBase) {
      applyBaseTableSelection(tableName);
      selectedDictionaryField = fieldName;
    }
    if (["insert", "update"].includes(state.intent.action)) {
      if (state.intent.baseTable !== tableName) applyBaseTableSelection(tableName);
      const enableMutation = switchedBase ? true : !state.intent.mutationFields.includes(fieldName);
      toggleArrayValue(state.intent.mutationFields, fieldName, enableMutation);
      render();
      showToast(`${state.intent.mutationFields.includes(fieldName) ? "已加入写入字段" : "已移出写入字段"}：${field.label}`);
      return;
    }
    const ref = `${tableName}.${fieldName}`;
    const enableOutput = switchedBase ? true : !state.intent.selectedFields.includes(ref);
    toggleArrayValue(state.intent.selectedFields, ref, enableOutput);
    render();
    showToast(`${state.intent.selectedFields.includes(ref) ? "已加入输出字段" : "已移出输出字段"}：${field.label}`);
  }
  function resetDictionaryForm() {
    dictionaryEditor.dictionaryId = null;
  }

  function loadDictionaryForm(dictionaryId) {
    const dictionary = state.dictionaries.find((item) => item.id === dictionaryId);
    if (!dictionary) return;
    dictionaryEditor.dictionaryId = dictionary.id;
    elements.dictionaryForm.dataset.mode = "edit";
    elements.dictionaryNameInput.value = dictionary.name;
    const button = elements.dictionaryForm.querySelector('button[type="submit"]');
    if (button) button.textContent = "更新字典";
    setDictionaryToolOpen("dictionary");
    elements.dictionaryNameInput.focus();
  }

  function handleDictionarySubmit(event) {
    event.preventDefault();
    const name = text(elements.dictionaryNameInput.value);
    if (!name) return showToast("请填写数据字典名称。");
    const editingId = dictionaryEditor.dictionaryId;
    if (editingId) {
      const dictionary = state.dictionaries.find((item) => item.id === editingId);
      if (!dictionary) return;
      dictionary.name = name;
      resetDictionaryForm();
      setDictionaryToolOpen("");
      render();
      showToast("数据字典已更新。");
      return;
    }
    syncActiveDictionaryState();
    const dictionary = createEmptyDictionary(name);
    state.dictionaries.push(dictionary);
    state.activeDictionaryId = dictionary.id;
    state.dictionary = dictionary.tables;
    state.selectedDictionaryTable = "";
    selectedDictionaryField = "";
    state.intent = createDefaultIntent("");
    resetDictionaryForm();
    setDictionaryToolOpen("");
    render();
    showToast("数据字典已新增。");
  }

  function switchDictionary(dictionaryId) {
    const target = state.dictionaries.find((dictionary) => dictionary.id === dictionaryId);
    if (!target || target.id === state.activeDictionaryId) return;
    syncActiveDictionaryState();
    state.activeDictionaryId = target.id;
    state.dictionary = target.tables;
    const firstTable = state.dictionary[0]?.name || "";
    state.selectedDictionaryTable = firstTable;
    selectedDictionaryField = "";
    state.intent = createDefaultIntent(firstTable);
    resetDictionaryForm();
    render();
  }

  function deleteActiveDictionary() {
    if (state.dictionaries.length <= 1) return showToast("至少保留一个数据字典。");
    const activeDictionary = getActiveDictionary();
    if (!activeDictionary) return;
    if (!window.confirm(`删除数据字典 ${activeDictionary.name}？其中的表和字段会一起移除。`)) return;
    state.dictionaries = state.dictionaries.filter((dictionary) => dictionary.id !== activeDictionary.id);
    const nextDictionary = state.dictionaries[0];
    state.activeDictionaryId = nextDictionary.id;
    state.dictionary = nextDictionary.tables;
    const firstTable = state.dictionary[0]?.name || "";
    state.selectedDictionaryTable = firstTable;
    selectedDictionaryField = "";
    state.intent = createDefaultIntent(firstTable);
    resetDictionaryForm();
    setDictionaryToolOpen("");
    render();
    showToast("数据字典已删除。");
  }

  function handleDictionaryClick(event) {
    const toggleButton = event.target.closest("[data-toggle-table]");
    const addTableButton = event.target.closest("[data-tree-add-table]");
    const importButton = event.target.closest("[data-tree-import]");
    const addFieldButton = event.target.closest("[data-add-field]");
    const useTableButton = event.target.closest("[data-use-table]");
    const useFieldButton = event.target.closest("[data-use-field]");
    const editTableButton = event.target.closest("[data-edit-table]");
    const deleteTableButton = event.target.closest("[data-delete-table]");
    const editFieldButton = event.target.closest("[data-edit-field]");
    const deleteFieldButton = event.target.closest("[data-delete-field]");
    const fieldButton = event.target.closest("[data-tree-field]");
    const tableButton = event.target.closest("[data-tree-table]");
    if (toggleButton) { const name = toggleButton.dataset.toggleTable; if (expandedTableNames.has(name)) expandedTableNames.delete(name); else expandedTableNames.add(name); renderDictionary(); return; }
    if (addTableButton) return startAddTable();
    if (importButton) { elements.dictionaryImportModal.hidden = false; elements.dictionaryPasteInput.focus(); return; }
    if (addFieldButton) return startAddField(addFieldButton.dataset.addField);
    if (useTableButton) return setIntentBaseTable(useTableButton.dataset.useTable);
    if (useFieldButton) return toggleFieldInIntent(useFieldButton.dataset.fieldTable, useFieldButton.dataset.useField);
    if (editTableButton) { state.selectedDictionaryTable = editTableButton.dataset.editTable; selectedDictionaryField = ""; expandedTableNames.add(state.selectedDictionaryTable); render(); return openTableStructureEditor(state.selectedDictionaryTable); }
    if (deleteTableButton) return deleteTable(deleteTableButton.dataset.deleteTable);
    if (editFieldButton) { state.selectedDictionaryTable = editFieldButton.dataset.fieldTable; selectedDictionaryField = editFieldButton.dataset.editField; expandedTableNames.add(state.selectedDictionaryTable); render(); return openTableStructureEditor(state.selectedDictionaryTable, { focusField: selectedDictionaryField }); }
    if (deleteFieldButton) return deleteField(deleteFieldButton.dataset.fieldTable, deleteFieldButton.dataset.deleteField);
    if (fieldButton) { state.selectedDictionaryTable = fieldButton.dataset.fieldTable; selectedDictionaryField = fieldButton.dataset.treeField; expandedTableNames.add(state.selectedDictionaryTable); render(); return; }
    if (tableButton) { state.selectedDictionaryTable = tableButton.dataset.treeTable; selectedDictionaryField = ""; expandedTableNames.add(state.selectedDictionaryTable); render(); }
  }
  function createStructureRow(field = {}) {
    return { sourceName: field.name || "", name: field.name || "", label: field.label || "", type: ["text", "number", "date", "boolean"].includes(field.type) ? field.type : "text", primary: Boolean(field.primary), selected: false };
  }

  function openTableStructureEditor(tableName = "", options = {}) {
    const table = getTable(tableName);
    const editing = Boolean(table);
    tableStructureEditor = { originalTableName: table?.name || "", focusField: options.focusField || "", rows: editing ? table.fields.map(createStructureRow) : [createStructureRow()] };
    if (options.appendRow && editing) tableStructureEditor.rows.push(createStructureRow());
    elements.tableEditorTitle.textContent = editing ? `编辑表结构：${table.label}` : "新建表";
    elements.tableEditorNameInput.value = table?.name || "";
    elements.tableEditorLabelInput.value = table?.label || "";
    renderTableStructureEditorRows();
    elements.tableEditorModal.hidden = false;
    window.setTimeout(() => (editing && options.focusField ? elements.tableEditorRows.querySelector(`[data-structure-index][value="${CSS.escape(options.focusField)}"]`) : elements.tableEditorNameInput)?.focus(), 0);
  }

  function closeTableStructureEditor() {
    elements.tableEditorModal.hidden = true;
    tableStructureEditor = { originalTableName: "", rows: [] };
  }

  function renderTableStructureEditorRows() {
    const rows = tableStructureEditor.rows;
    elements.tableEditorRows.innerHTML = rows.map((row, index) => `<tr data-structure-row="${index}" class="${row.name === tableStructureEditor.focusField ? "focus-row" : ""} ${row.selected ? "selected-row" : ""}"><td><input aria-label="选择第 ${index + 1} 行" type="checkbox" data-structure-select="${index}" ${row.selected ? "checked" : ""}></td><td>${index + 1}</td><td><input data-structure-index="${index}" data-structure-prop="name" value="${escapeAttr(row.name)}" placeholder="field_code"></td><td><input data-structure-index="${index}" data-structure-prop="label" value="${escapeAttr(row.label)}" placeholder="字段名称"></td><td><select data-structure-index="${index}" data-structure-prop="type">${["text", "number", "date", "boolean"].map((type) => `<option value="${type}" ${row.type === type ? "selected" : ""}>${({ text: "文本", number: "数字", date: "日期", boolean: "布尔" })[type]}</option>`).join("")}</select></td><td><input aria-label="主键" type="checkbox" data-structure-index="${index}" data-structure-prop="primary" ${row.primary ? "checked" : ""}></td></tr>`).join("") || '<tr><td colspan="6" class="empty-state">暂无字段。点击“增行”或直接粘贴 Excel 表格。</td></tr>';
  }

  function normalizeStructureType(value) {
    const raw = text(value).toLowerCase();
    if (/bool|布尔|真假/.test(raw)) return "boolean";
    if (/date|time|日期|时间/.test(raw)) return "date";
    if (/int|decimal|number|numeric|double|float|数字|金额|整数/.test(raw)) return "number";
    return "text";
  }

  function isStructureHeader(cells) {
    const first = text(cells[0]).replace(/\s/g, "").toLowerCase();
    const second = text(cells[1]).replace(/\s/g, "").toLowerCase();
    return /^(字段编码|字段代码|fieldcode|fieldname|field)$/i.test(first) && (!second || /^(字段名称|名称|中文名|label|类型|type)$/i.test(second));
  }

  function parseStructurePaste(raw) {
    const lines = text(raw).replace(/\r/g, "").split("\n").map((line) => line.split("\t")).filter((cells) => cells.some((cell) => text(cell)));
    return lines[0] && isStructureHeader(lines[0]) ? lines.slice(1) : lines;
  }

  function handleTableStructureInput(event) {
    const control = event.target.closest("[data-structure-index][data-structure-prop]");
    if (!control) return;
    const row = tableStructureEditor.rows[Number(control.dataset.structureIndex)];
    if (!row) return;
    row[control.dataset.structureProp] = control.dataset.structureProp === "primary" ? control.checked : control.value;
  }

  function handleTableStructureChange(event) {
    const selected = event.target.closest("[data-structure-select]");
    if (selected) {
      const row = tableStructureEditor.rows[Number(selected.dataset.structureSelect)];
      if (row) row.selected = selected.checked;
      selected.closest("[data-structure-row]")?.classList.toggle("selected-row", selected.checked);
      return;
    }
    handleTableStructureInput(event);
  }

  function handleTableStructureRowClick(event) {
    if (event.target.closest("[data-structure-select]")) return;
    const rowElement = event.target.closest("[data-structure-row]");
    if (!rowElement) return;
    const row = tableStructureEditor.rows[Number(rowElement.dataset.structureRow)];
    if (!row || row.selected) return;
    row.selected = true;
    rowElement.classList.add("selected-row");
    const selector = rowElement.querySelector("[data-structure-select]");
    if (selector) selector.checked = true;
  }

  function handleTableStructurePaste(event) {
    const raw = event.clipboardData?.getData("text");
    if (!raw || (!raw.includes("\t") && !raw.includes("\n"))) return;
    const pastedRows = parseStructurePaste(raw);
    if (!pastedRows.length) return;
    const target = event.target.closest("[data-structure-index][data-structure-prop]");
    if (!target) return;
    event.preventDefault();
    const columns = ["name", "label", "type", "primary"];
    const startRow = Number(target.dataset.structureIndex);
    const startColumn = columns.indexOf(target.dataset.structureProp);
    if (startRow < 0 || startColumn < 0) return;
    while (tableStructureEditor.rows.length < startRow + pastedRows.length) tableStructureEditor.rows.push(createStructureRow());
    pastedRows.forEach((cells, rowOffset) => {
      const row = tableStructureEditor.rows[startRow + rowOffset];
      cells.forEach((value, columnOffset) => {
        const property = columns[startColumn + columnOffset];
        if (!property) return;
        row[property] = property === "primary" ? /^(√|是|y|yes|true|1|主键|primary)$/i.test(text(value)) : property === "type" ? normalizeStructureType(value) : text(value);
      });
    });
    renderTableStructureEditorRows();
    showToast(`已粘贴 ${pastedRows.length} 行。`);
  }

  function saveTableStructureEditor() {
    const originalName = tableStructureEditor.originalTableName;
    const name = cleanIdentifier(elements.tableEditorNameInput.value);
    const label = text(elements.tableEditorLabelInput.value) || name;
    if (!name) return showToast("表编码必须以字母或下划线开头，只能包含字母、数字和下划线。");
    if (state.dictionary.some((table) => table.name === name && table.name !== originalName)) return showToast("该表编码已经存在。");
    const fields = tableStructureEditor.rows.filter((row) => text(row.name) || text(row.label)).map((row) => ({ ...row, name: cleanIdentifier(row.name), label: text(row.label) || cleanIdentifier(row.name), type: normalizeStructureType(row.type) }));
    if (fields.some((field) => !field.name)) return showToast("字段编码必须以字母或下划线开头。");
    if (new Set(fields.map((field) => field.name)).size !== fields.length) return showToast("字段编码不能重复。");
    const table = originalName ? getTable(originalName) : null;
    if (table) {
      const oldName = table.name;
      table.name = name;
      table.label = label;
      if (oldName !== name) renameTableReferences(oldName, name);
      fields.forEach((field) => { if (field.sourceName && field.sourceName !== field.name) renameFieldReferences(name, field.sourceName, field.name); });
      table.fields = fields.map(({ sourceName, selected, ...field }) => field);
    } else {
      state.dictionary.push({ name, label, fields: fields.map(({ sourceName, selected, ...field }) => field) });
      if (!state.intent.baseTable) state.intent = createDefaultIntent(name);
    }
    state.selectedDictionaryTable = name;
    selectedDictionaryField = "";
    expandedTableNames.add(name);
    syncActiveDictionaryState();
    sanitizeCurrentIntentForDictionary();
    closeTableStructureEditor();
    render();
    showToast(table ? "表结构已保存。" : "表已新增。");
  }
  function deleteTable(tableName) {
    const table = getTable(tableName);
    if (!table) return;
    if (!window.confirm(`删除表 ${table.label}(${table.name})？相关字段选择、表关系和条件会被清理。`)) return;
    state.dictionary = state.dictionary.filter((item) => item.name !== tableName);
    syncActiveDictionaryState();
    const firstTable = state.dictionary[0]?.name || "";
    if (state.intent.baseTable === tableName) {
      state.intent = createDefaultIntent(firstTable);
    } else {
      state.intent.joins = state.intent.joins.filter((join) => join.table !== tableName);
      sanitizeCurrentIntentForDictionary();
    }
    state.selectedDictionaryTable = firstTable;
    selectedDictionaryField = "";
    setDictionaryToolOpen("");
    render();
    showToast("表已删除。");
  }

  function deleteField(tableName, fieldName) {
    const table = getTable(tableName);
    const field = table?.fields.find((item) => item.name === fieldName);
    if (!table || !field) return;
    if (!window.confirm(`删除字段 ${field.label}(${field.name})？相关条件、排序、分组和 JOIN 会被清理。`)) return;
    table.fields = table.fields.filter((item) => item.name !== fieldName);
    syncActiveDictionaryState();
    if (selectedDictionaryField === fieldName && state.selectedDictionaryTable === tableName) selectedDictionaryField = "";
    sanitizeCurrentIntentForDictionary();
    setDictionaryToolOpen("");
    render();
    showToast("字段已删除。");
  }

  function renameTableReferences(oldName, newName) {
    if (state.selectedDictionaryTable === oldName) state.selectedDictionaryTable = newName;
    renameTableInIntent(state.intent, oldName, newName);
    state.templates.forEach((item) => item.intent && renameTableInIntent(item.intent, oldName, newName));
    state.history.forEach((item) => item.intent && renameTableInIntent(item.intent, oldName, newName));
  }

  function renameTableInIntent(intent, oldName, newName) {
    if (intent.baseTable === oldName) intent.baseTable = newName;
    intent.selectedFields = (intent.selectedFields || []).map((ref) => replaceTableInRef(ref, oldName, newName));
    intent.groupFields = (intent.groupFields || []).map((ref) => replaceTableInRef(ref, oldName, newName));
    if (intent.sort?.field && intent.sort.field !== AGGREGATE_SORT_FIELD) intent.sort.field = replaceTableInRef(intent.sort.field, oldName, newName);
    if (intent.aggregate?.field && intent.aggregate.field !== "*") intent.aggregate.field = replaceTableInRef(intent.aggregate.field, oldName, newName);
    (intent.joins || []).forEach((join) => {
      if (join.table === oldName) join.table = newName;
      join.left = replaceTableInRef(join.left, oldName, newName);
      join.right = replaceTableInRef(join.right, oldName, newName);
    });
    mapConditionFields(intent.condition, (ref) => replaceTableInRef(ref, oldName, newName));
  }

  function renameFieldReferences(tableName, oldName, newName) {
    renameFieldInIntent(state.intent, tableName, oldName, newName);
    state.templates.forEach((item) => item.intent && renameFieldInIntent(item.intent, tableName, oldName, newName));
    state.history.forEach((item) => item.intent && renameFieldInIntent(item.intent, tableName, oldName, newName));
  }

  function renameFieldInIntent(intent, tableName, oldName, newName) {
    const mapper = (ref) => replaceFieldInRef(ref, tableName, oldName, newName);
    intent.selectedFields = (intent.selectedFields || []).map(mapper);
    intent.groupFields = (intent.groupFields || []).map(mapper);
    if (intent.sort?.field && intent.sort.field !== AGGREGATE_SORT_FIELD) intent.sort.field = mapper(intent.sort.field);
    if (intent.aggregate?.field && intent.aggregate.field !== "*") intent.aggregate.field = mapper(intent.aggregate.field);
    (intent.joins || []).forEach((join) => {
      join.left = mapper(join.left);
      join.right = mapper(join.right);
    });
    mapConditionFields(intent.condition, mapper);
    if (intent.baseTable === tableName) {
      intent.mutationFields = (intent.mutationFields || []).map((field) => (field === oldName ? newName : field));
      if (Object.prototype.hasOwnProperty.call(intent.mutationValues || {}, oldName)) {
        intent.mutationValues[newName] = intent.mutationValues[oldName];
        delete intent.mutationValues[oldName];
      }
    }
  }

  function replaceTableInRef(ref, oldName, newName) {
    const parsed = parseRef(ref);
    return parsed.table === oldName ? `${newName}.${parsed.field}` : ref;
  }

  function replaceFieldInRef(ref, tableName, oldName, newName) {
    const parsed = parseRef(ref);
    return parsed.table === tableName && parsed.field === oldName ? `${tableName}.${newName}` : ref;
  }

  function mapConditionFields(node, mapper) {
    if (!node) return;
    if (node.type === "condition") {
      node.field = mapper(node.field);
      return;
    }
    (node.children || []).forEach((child) => mapConditionFields(child, mapper));
  }

  function sanitizeCurrentIntentForDictionary() {
    const firstTable = state.dictionary[0]?.name || "";
    if (!firstTable) {
      state.selectedDictionaryTable = "";
      state.intent = createDefaultIntent("");
      syncActiveDictionaryState();
      return;
    }
    const intent = state.intent;
    if (!getTable(intent.baseTable)) {
      state.intent = createDefaultIntent(firstTable);
      return;
    }
    const seenJoinTables = new Set();
    intent.joins = (intent.joins || [])
      .filter((join) => getTable(join.table) && join.table !== intent.baseTable && !seenJoinTables.has(join.table) && (seenJoinTables.add(join.table) || true))
      .map((join) => {
        if (fieldRefExists(join.left) && fieldRefExists(join.right)) return join;
        const guessed = guessJoinFields(intent.baseTable, join.table);
        return { ...join, left: guessed.left, right: guessed.right };
      });
    intent.selectedFields = (intent.selectedFields || []).filter(fieldRefExists);
    if (intent.action === "select" && !intent.selectedFields.length) intent.selectedFields = defaultFieldsForTable(intent.baseTable);
    intent.groupFields = (intent.groupFields || []).filter(fieldRefExists);
    const baseFields = new Set((getTable(intent.baseTable)?.fields || []).map((field) => field.name));
    intent.mutationFields = (intent.mutationFields || []).filter((field) => baseFields.has(field));
    Object.keys(intent.mutationValues || {}).forEach((field) => {
      if (!baseFields.has(field)) delete intent.mutationValues[field];
    });
    sanitizeConditionFields(intent.condition);
    sanitizeIntentForAction();
  }

  function sanitizeIntentForAction() {
    const intent = state.intent;
    if (!isSelectLikeAction(intent.action)) {
      intent.joins = [];
      intent.sort.field = "";
      intent.groupBy = false;
      intent.groupFields = [];
      intent.distinct = false;
    }
    if (intent.action !== "select") intent.distinct = false;
    if (intent.action === "insert") {
      intent.condition = { id: uid(), type: "group", logic: "AND", not: false, children: [] };
    }
    if (intent.action !== "aggregate") {
      intent.groupBy = false;
      intent.groupFields = [];
      if (intent.sort.field === AGGREGATE_SORT_FIELD) intent.sort.field = "";
    }
    if (intent.action === "aggregate") {
      if (!intent.groupBy) intent.groupFields = [];
      intent.groupFields = (intent.groupFields || []).filter(fieldRefExists);
      const aggregateFields = getAggregateFields(intent.aggregate.fn);
      const allowsAllRecords = intent.aggregate.fn === "count";
      const selectedFieldIsValid = (allowsAllRecords && intent.aggregate.field === "*") || aggregateFields.some((field) => field.ref === intent.aggregate.field);
      if (!selectedFieldIsValid) intent.aggregate.field = allowsAllRecords ? "*" : aggregateFields[0]?.ref || "";
    }
    if (isSelectLikeAction(intent.action) && intent.sort.field) {
      const allowedSorts = getSortFieldOptions().map((field) => field.value);
      if (!allowedSorts.includes(intent.sort.field)) intent.sort.field = "";
    }
  }

  function sanitizeConditionFields(node) {
    if (!node) return;
    if (node.type === "condition") {
      if (!node.field || !fieldRefExists(node.field)) node.field = getConditionFields()[0]?.ref || getAvailableFields()[0]?.ref || "";
      return;
    }
    (node.children || []).forEach(sanitizeConditionFields);
  }

  function fieldRefExists(ref) {
    if (!ref || ref === "*") return false;
    const parsed = parseRef(ref);
    return Boolean(getTable(parsed.table)?.fields.some((field) => field.name === parsed.field));
  }

  function getTable(name) {
    return state.dictionary.find((table) => table.name === name);
  }

  function firstNonBaseTable(base) {
    return state.dictionary.find((table) => table.name !== base) || null;
  }

  function guessJoinFields(leftTableName, rightTableName) {
    const leftTable = getTable(leftTableName);
    const rightTable = getTable(rightTableName);
    const leftPrimary = leftTable?.fields.find((field) => field.primary)?.name || leftTable?.fields[0]?.name || "id";
    const rightPrimary = rightTable?.fields.find((field) => field.primary)?.name || rightTable?.fields[0]?.name || "id";
    const singularLeft = leftTableName.replace(/s$/, "");
    const singularRight = rightTableName.replace(/s$/, "");
    const rightForeign = rightTable?.fields.find((field) => field.name === `${singularLeft}_id` || field.name === `${leftTableName}_id`)?.name;
    const leftForeign = leftTable?.fields.find((field) => field.name === `${singularRight}_id` || field.name === `${rightTableName}_id`)?.name;
    if (rightForeign) return { left: `${leftTableName}.${leftPrimary}`, right: `${rightTableName}.${rightForeign}` };
    if (leftForeign) return { left: `${leftTableName}.${leftForeign}`, right: `${rightTableName}.${rightPrimary}` };
    return { left: `${leftTableName}.${leftPrimary}`, right: `${rightTableName}.${rightPrimary}` };
  }

  function getDictionaryFields() {
    return state.dictionary.flatMap((table) =>
      table.fields.map((field) => ({
        table: table.name,
        tableLabel: table.label,
        name: field.name,
        label: `${table.label}.${field.label}`,
        type: field.type,
        ref: `${table.name}.${field.name}`,
      })),
    );
  }

  function getAvailableFields() {
    const tables = new Set([state.intent.baseTable, ...state.intent.joins.map((join) => join.table)]);
    return getDictionaryFields().filter((field) => tables.has(field.table));
  }

  function getAggregateFields(fn = state.intent.aggregate.fn) {
    const fields = getAvailableFields();
    if (["sum", "avg"].includes(fn)) return fields.filter((field) => field.type === "number");
    return fields;
  }

  function getConditionFields() {
    const fields = getAvailableFields();
    if (state.intent.action === "insert") return [];
    if (["update", "delete"].includes(state.intent.action)) {
      return fields.filter((field) => field.table === state.intent.baseTable);
    }
    return fields;
  }

  function conditionFieldAllowedInSql(ref) {
    if (!fieldRefExists(ref)) return false;
    const parsed = parseRef(ref);
    if (state.intent.action === "insert") return false;
    if (["update", "delete"].includes(state.intent.action)) return parsed.table === state.intent.baseTable;
    return getAvailableFields().some((field) => field.ref === ref);
  }

  function getFieldByRef(ref) {
    const parsed = parseRef(ref);
    return getTable(parsed.table)?.fields.find((field) => field.name === parsed.field) || null;
  }

  function defaultFieldsForTable(tableName) {
    return (getTable(tableName)?.fields || []).slice(0, 3).map((field) => `${tableName}.${field.name}`);
  }

  function parseRef(ref) {
    const [table, field] = String(ref || "").split(".");
    return { table: table || state.intent.baseTable, field: field || table || "" };
  }

  function tableLabel(tableName) {
    const table = getTable(tableName);
    return table ? `${table.label}(${table.name})` : tableName || "未选择表";
  }

  function relationRule(type) {
    return RELATION_RULES.find((rule) => rule.value === type) || RELATION_RULES[0];
  }

  function fieldOptionLabel(ref) {
    const parsed = parseRef(ref);
    const table = getTable(parsed.table);
    const field = table?.fields.find((item) => item.name === parsed.field);
    if (!table || !field) return ref;
    return `${table.label}.${field.label} (${parsed.table}.${parsed.field})`;
  }

  function relationSentence(join) {
    const table = getTable(join.table);
    const rule = relationRule(join.type);
    const name = text(join.note) || `${tableLabel(state.intent.baseTable)} 对应 ${table ? tableLabel(table.name) : join.table}`;
    return `${name}：${fieldLabel(join.left)} 对应 ${fieldLabel(join.right)}；${rule.label}`;
  }

  function fieldLabel(ref) {
    const parsed = parseRef(ref);
    const table = getTable(parsed.table);
    const field = table?.fields.find((item) => item.name === parsed.field);
    return field && table ? `${table.label}.${field.label}` : ref;
  }

  function fieldListLabel(fields) {
    if (!fields?.length) return "全部字段";
    return fields.map(fieldLabel).join("、");
  }

  function conditionLabel(node) {
    if (!node) return "";
    if (node.type === "condition") {
      const operator = OPERATOR_LABELS[node.operator] || node.operator;
      if (["is_null", "is_not_null"].includes(node.operator)) return `${fieldLabel(node.field)} ${operator}`;
      return `${fieldLabel(node.field)} ${operator} ${text(node.value) || "未填值"}`;
    }
    const labels = node.children.map(conditionLabel).filter(Boolean);
    if (!labels.length) return "";
    const joined = labels.join(` ${node.logic} `);
    return node.not ? `NOT (${joined})` : labels.length > 1 ? `(${joined})` : joined;
  }

  function aggregateLabel(aggregate) {
    const map = { count: "计数", sum: "求和", avg: "平均", min: "最小值", max: "最大值" };
    const field = !aggregate.field ? "未选择字段" : aggregate.field === "*" ? "全部记录" : fieldLabel(aggregate.field);
    return `${map[aggregate.fn] || aggregate.fn} ${field}`;
  }

  function aggregateSqlAlias(aggregate = state.intent.aggregate) {
    return aggregate.field === "*" ? `${aggregate.fn}_all` : `${aggregate.fn}_${parseRef(aggregate.field).field}`;
  }

  function sortSqlExpression(field) {
    const intent = state.intent;
    if (intent.action === "aggregate" && field === AGGREGATE_SORT_FIELD) {
      return hasActiveUnion() ? String((intent.groupBy ? intent.groupFields.length : 0) + 1) : q(aggregateSqlAlias(intent.aggregate));
    }
    if (hasActiveUnion()) {
      const outputFields = intent.action === "aggregate" ? intent.groupFields : intent.selectedFields;
      const position = outputFields.indexOf(field);
      if (position >= 0) return String(position + 1);
    }
    return qref(field);
  }

  function sortFieldLabel(field) {
    if (state.intent.action === "aggregate" && field === AGGREGATE_SORT_FIELD) return `统计结果（${aggregateLabel(state.intent.aggregate)}）`;
    return fieldLabel(field);
  }

  function getSortFieldOptions() {
    if (!isSelectLikeAction()) return [];
    if (state.intent.action === "aggregate") {
      const groupOptions = state.intent.groupBy ? state.intent.groupFields.filter(fieldRefExists).map((ref) => ({ value: ref, label: `${fieldLabel(ref)} (${ref})` })) : [];
      return [{ value: AGGREGATE_SORT_FIELD, label: `${aggregateLabel(state.intent.aggregate)}（统计结果）` }, ...groupOptions];
    }
    if (hasActiveUnion()) return state.intent.selectedFields.filter(fieldRefExists).map((ref) => ({ value: ref, label: fieldOptionLabel(ref) }));
    return getAvailableFields().map((field) => ({ value: field.ref, label: `${field.label} (${field.ref})` }));
  }

  function hasActiveUnion() {
    return state.mode !== "normal" && isSelectLikeAction() && Boolean(normalizeUnionFragment(state.intent.advanced.union).sql);
  }

  function hasApplicableAdvancedFragment() {
    if (state.mode === "normal" || !isSelectLikeAction()) return false;
    const advanced = state.intent.advanced;
    return Boolean(text(advanced.with) || text(advanced.computed) || text(advanced.union) || (state.intent.action === "aggregate" && text(advanced.having)));
  }

  function dialectByValue(value) {
    return DIALECTS.find((dialect) => dialect.value === value) || DIALECTS[0];
  }

  function unsupportedJoinTypesForSettings(settings = state) {
    const dialect = dialectByValue(settings?.dialect);
    const unsupported = new Set(dialect.unsupportedJoinTypes || []);
    if (dialect.value === "sqlite" && settings?.sqliteVersion !== "3_39_plus") {
      unsupported.add("RIGHT JOIN");
      unsupported.add("FULL JOIN");
    }
    return Array.from(unsupported);
  }

  function unsupportedJoinTypesForCurrentSettings() {
    return unsupportedJoinTypesForSettings(state);
  }

  function normalizedJoinTypeForSettings(joinType, settings = state) {
    const normalized = String(joinType || "INNER JOIN").toUpperCase();
    const known = RELATION_RULES.some((rule) => rule.value === normalized) ? normalized : "INNER JOIN";
    return unsupportedJoinTypesForSettings(settings).includes(known) ? "LEFT JOIN" : known;
  }

  function isJoinTypeSupported(joinType, settings = state) {
    return normalizedJoinTypeForSettings(joinType, settings) === String(joinType || "INNER JOIN").toUpperCase();
  }

  function availableRelationRules() {
    return RELATION_RULES.filter((rule) => isJoinTypeSupported(rule.value));
  }

  function sanitizeCurrentJoinsForDialect() {
    let changed = 0;
    (state.intent.joins || []).forEach((join) => {
      const nextType = normalizedJoinTypeForSettings(join.type);
      if (join.type !== nextType) {
        join.type = nextType;
        changed += 1;
      }
    });
    return changed;
  }

  function currentDialect() {
    return dialectByValue(state.dialect);
  }

  function casePolicyLabel(policies, value) {
    return policies.find((item) => item.value === value)?.label || value;
  }

  function normalizeIdentifierOutput(identifier) {
    const raw = String(identifier ?? "");
    if (state.identifierCase === "lower") return raw.toLowerCase();
    if (state.identifierCase === "upper") return raw.toUpperCase();
    return raw;
  }

  function isSafeUnquotedIdentifier(identifier, dialect = currentDialect()) {
    const raw = String(identifier || "");
    const reserved = DIALECT_RESERVED_WORDS[dialect.value] || new Set();
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) && !SQL_RESERVED_WORDS.has(raw.toUpperCase()) && !reserved.has(raw.toUpperCase());
  }

  function quoteIdentifier(raw, dialect = currentDialect()) {
    const value = String(raw ?? "");
    if (dialect.quoteOpen === "[") return `[${value.replace(/]/g, "]]")}]`;
    if (dialect.quoteOpen === "`") return `\`${value.replace(/`/g, "``")}\``;
    return `"${value.replace(/"/g, '""')}"`;
  }

  function q(identifier) {
    const dialect = currentDialect();
    const raw = normalizeIdentifierOutput(identifier);
    if (state.identifierQuote === "never") return raw;
    if (state.identifierQuote === "auto" && isSafeUnquotedIdentifier(raw, dialect)) return raw;
    return quoteIdentifier(raw, dialect);
  }

  function qref(ref) {
    const parsed = parseRef(ref);
    return `${q(parsed.table)}.${q(parsed.field)}`;
  }

  function paramPlaceholder(name, index) {
    const dialect = currentDialect();
    if (dialect.paramStyle === "dollar") return `$${index}`;
    if (dialect.paramStyle === "qmark") return `?/*__intent_param_${index}__*/`;
    if (dialect.paramStyle === "atName") return `@${name}`;
    return `:${name}`;
  }

  function displayParamPlaceholder(name, index) {
    const dialect = currentDialect();
    if (dialect.paramStyle === "dollar") return `$${index}`;
    if (dialect.paramStyle === "qmark") return "?";
    if (dialect.paramStyle === "atName") return `@${name}`;
    return `:${name}`;
  }

  function selectTopClause(includeResultControls) {
    const intent = state.intent;
    const dialect = currentDialect();
    if (dialect.pagination !== "sqlServer") return "";
    if (!includeResultControls || hasActiveUnion()) return "";
    if (intent.limit > 0 && intent.offset <= 0) return `TOP (${intent.limit}) `;
    return "";
  }

  function dialectJoinKeyword(joinType) {
    const normalized = normalizedJoinTypeForSettings(joinType);
    return currentDialect().joinAliases?.[normalized] || normalized;
  }

  function escapeRegExp(value) {
    return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeSqlValue(value) {
    return String(value ?? "").replace(/'/g, "''");
  }

  function substituteSqlParams(sql, params) {
    const orderedParams = (params || []).map((param, order) => ({ ...param, order }));
    const positionalParams = orderedParams.filter((param) => (param.placeholder || `:${param.name}`) === "?");
    const namedParams = orderedParams
      .filter((param) => (param.placeholder || `:${param.name}`) !== "?")
      .sort((a, b) => {
        const left = a.rawPlaceholder || a.placeholder || `:${a.name}`;
        const right = b.rawPlaceholder || b.placeholder || `:${b.name}`;
        return right.length - left.length || b.order - a.order;
      });

    let result = String(sql || "").replace(/\?\/\*__intent_param_(\d+)__\*\//g, (_, index) => {
      const param = positionalParams[Number(index) - 1];
      return param ? sqlLiteral(param.value, param.type) : "?";
    });

    if (namedParams.length) {
      const byPlaceholder = new Map(namedParams.map((param) => [param.rawPlaceholder || param.placeholder || `:${param.name}`, param]));
      const pattern = namedParams.map((param) => escapeRegExp(param.rawPlaceholder || param.placeholder || `:${param.name}`)).join("|");
      result = result.replace(new RegExp(pattern, "g"), (placeholder) => {
        const param = byPlaceholder.get(placeholder);
        return param ? sqlLiteral(param.value, param.type) : placeholder;
      });
    }
    return result;
  }

  function stripParameterMarkers(sql) {
    return String(sql || "").replace(/\?\/\*__intent_param_\d+__\*\//g, "?");
  }

  function sqlLiteral(value, type) {
    if (value === null || value === undefined) return "NULL";
    const raw = String(value);
    const fieldType = String(type || "").toLowerCase();
    const dialect = currentDialect();
    if (isNumericSqlType(fieldType) && /^-?\d+(\.\d+)?$/.test(raw.trim())) return raw.trim();
    if (isBooleanSqlType(fieldType)) {
      if (/^(true|1|yes|y|是|已启用)$/i.test(raw.trim())) return dialect.trueLiteral;
      if (/^(false|0|no|n|否|未启用|已停用)$/i.test(raw.trim())) return dialect.falseLiteral;
    }
    if (dialect.dateLiteral && isDateSqlType(fieldType) && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return `DATE '${escapeSqlValue(raw.trim())}'`;
    return `'${escapeSqlValue(raw)}'`;
  }

  function isNumericSqlType(type) {
    return /(^|\b)(number|numeric|decimal|int|integer|bigint|smallint|tinyint|float|double|real|money)(\b|\()/i.test(type);
  }

  function isBooleanSqlType(type) {
    return /(^|\b)(boolean|bool)(\b|\()/i.test(type);
  }

  function isDateSqlType(type) {
    return /(^|\b)(date|datetime|timestamp|time)(\b|\()/i.test(type);
  }

  function splitValues(value) {
    return String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function escapeLikeLiteral(value) {
    return String(value ?? "").replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
  }

  function escapeGlobLiteral(value) {
    return String(value ?? "").replace(/[\[\]*?]/g, (character) => ({ "[": "[[]", "]": "[]]", "*": "[*]", "?": "[?]" }[character]));
  }

  function splitSqlExpressions(value) {
    const source = String(value || "").trim();
    if (!source) return [];
    const expressions = [];
    let buffer = "";
    let quote = "";
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      buffer += char;
      if (quote) {
        if (char === quote && next === quote) {
          buffer += next;
          index += 1;
        } else if (char === quote) quote = "";
        continue;
      }
      if (["'", '"', "`"].includes(char)) quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth = Math.max(0, depth - 1);
      else if (char === "," && depth === 0) {
        const item = buffer.slice(0, -1).trim();
        if (item) expressions.push(item);
        buffer = "";
      }
    }
    const last = buffer.trim().replace(/,$/, "");
    if (last) expressions.push(last);
    return expressions;
  }

  function stripTrailingSemicolon(value) {
    return String(value || "").trim().replace(/;\s*$/, "");
  }

  function normalizeWithClause(value) {
    return text(value).replace(/^WITH\s+/i, "");
  }

  function normalizeUnionFragment(value) {
    const sql = stripTrailingSemicolon(value);
    if (!sql) return { keyword: "UNION", sql: "" };
    const unionAllMatch = sql.match(/^UNION\s+ALL\s+([\s\S]+)$/i);
    if (unionAllMatch) return { keyword: "UNION ALL", sql: unionAllMatch[1].trim() };
    const unionMatch = sql.match(/^UNION\s+([\s\S]+)$/i);
    if (unionMatch) return { keyword: "UNION", sql: unionMatch[1].trim() };
    return { keyword: "UNION", sql };
  }

  function mysqlUnlimitedRowCount() {
    return "18446744073709551615";
  }

  function alterAddColumnSql(tableName) {
    const dialect = currentDialect().value;
    const columnDefinition = `${q("new_column")} ${typeToSql("text")}`;
    if (dialect === "sqlserver") return `ALTER TABLE ${q(tableName)}
ADD ${columnDefinition};`;
    if (dialect === "oracle") return `ALTER TABLE ${q(tableName)}
ADD (${columnDefinition});`;
    return `ALTER TABLE ${q(tableName)}
ADD COLUMN ${columnDefinition};`;
  }

  function typeToSql(type) {
    const types = currentDialect().types || DIALECTS[0].types;
    return types[type] || types.text || "TEXT";
  }

  function primaryKeyFallbackSql() {
    const dialect = currentDialect().value;
    if (dialect === "sqlserver") return `  ${q("id")} INT PRIMARY KEY`;
    if (["oracle", "dameng"].includes(dialect)) return `  ${q("id")} NUMBER PRIMARY KEY`;
    return `  ${q("id")} INTEGER PRIMARY KEY`;
  }

  function transactionBeginSql() {
    const dialect = currentDialect().value;
    if (["oracle", "dameng"].includes(dialect)) return "SAVEPOINT intent_builder_start";
    if (dialect === "mysql") return "START TRANSACTION";
    return "BEGIN TRANSACTION";
  }

  function selectedOptions(select) {
    return Array.from(select.selectedOptions).map((option) => option.value);
  }

  function toggleArrayValue(array, value, enabled) {
    const index = array.indexOf(value);
    if (enabled && index < 0) array.push(value);
    if (!enabled && index >= 0) array.splice(index, 1);
  }

  function setActiveResultTab(tab) {
    activeResultTab = tab || "sql";
    $$(".result-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === activeResultTab));
    [
      ["sql", elements.sqlOutput],
      ["paramSql", elements.paramSqlOutput],
      ["params", elements.paramsOutput],
      ["explain", elements.explainOutput],
      ["risks", elements.riskOutput],
    ].forEach(([name, element]) => element.classList.toggle("active", name === activeResultTab));
  }

  function openFileSyncModal() {
    elements.fileSyncModal.hidden = false;
  }

  function closeFileSyncModal(force = false) {
    if (!force && !fileSyncReady) {
      showToast("请先连接或新建本地配置文件。");
      return;
    }
    elements.fileSyncModal.hidden = true;
  }

  function openHistoryModal() {
    renderHistory();
    elements.historyModal.hidden = false;
  }

  function copyTextToClipboard(value) {
    const clipboard = window.navigator?.clipboard;
    if (clipboard?.writeText) return clipboard.writeText(value);
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    helper.remove();
    if (!copied) return Promise.reject(new Error("Clipboard copy is unavailable."));
    return Promise.resolve();
  }

  function selectElementText(element) {
    if (!element) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function scheduleHistory(generated) {
    window.clearTimeout(historyTimer);
    historyTimer = window.setTimeout(() => recordHistory(generated), 1200);
  }

  function recordHistory(generated) {
    if (!generated?.sql || generated.sql.startsWith("--")) return;
    const sameSql = state.history[0]?.sql === generated.sql;
    const sameParams = JSON.stringify(state.history[0]?.params || []) === JSON.stringify(generated.params || []);
    if (sameSql && sameParams) return;
    state.history.unshift({
      savedAt: new Date().toISOString(),
      summary: generated.summary,
      sql: generated.sql,
      displaySql: generated.displaySql,
      params: generated.params,
      intent: clone(state.intent),
      mode: state.mode,
      dialect: state.dialect,
      sqliteVersion: state.sqliteVersion,
      identifierQuote: state.identifierQuote,
      identifierCase: state.identifierCase,
      textMatchCase: state.textMatchCase,
    });
    state.history = state.history.slice(0, 20);
    renderHistory();
    saveState();
  }

  function exportConfig() {
    const payload = {
      exportedAt: new Date().toISOString(),
      ...configPayload(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `intent-sql-builder-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function importConfig(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result || "{}"));
        state = normalizeState({ ...state, ...imported });
        render();
        showToast("配置已导入。");
      } catch {
        showToast("导入失败：不是有效 JSON。");
      } finally {
        elements.importConfigInput.value = "";
      }
    };
    reader.readAsText(file);
  }

  function fileSyncSupported() {
    return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function" && typeof indexedDB !== "undefined";
  }

  function openFileSyncDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(FILE_SYNC_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(FILE_SYNC_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本地文件同步设置。"));
    });
  }

  async function saveFileSyncHandle(handle) {
    const database = await openFileSyncDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(FILE_SYNC_STORE, "readwrite");
      transaction.objectStore(FILE_SYNC_STORE).put(handle, FILE_SYNC_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("无法记住本地配置文件。"));
    });
    database.close();
  }

  async function readFileSyncHandle() {
    const database = await openFileSyncDatabase();
    const handle = await new Promise((resolve, reject) => {
      const request = database.transaction(FILE_SYNC_STORE, "readonly").objectStore(FILE_SYNC_STORE).get(FILE_SYNC_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("无法读取本地文件同步设置。"));
    });
    database.close();
    return handle;
  }

  async function clearFileSyncHandle() {
    const database = await openFileSyncDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(FILE_SYNC_STORE, "readwrite");
      transaction.objectStore(FILE_SYNC_STORE).delete(FILE_SYNC_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("无法清除本地文件同步设置。"));
    });
    database.close();
  }

  function renderFileSyncStatus() {
    if (!elements.fileSyncStatus) return;
    const supported = fileSyncSupported();
    elements.fileSyncStatus.textContent = supported ? fileSyncStatus : "当前浏览器不支持本地配置文件同步，无法继续使用本工具。";
    [elements.connectFileSyncButton, elements.createFileSyncButton, elements.saveFileSyncButton].forEach((button) => {
      if (button) button.disabled = !supported;
    });
    if (elements.saveFileSyncButton) elements.saveFileSyncButton.disabled = !supported || !fileSyncReady;
  }

  function scheduleFileSync(payload) {
    if (!fileSyncReady || !fileSyncHandle) return;
    window.clearTimeout(fileSyncTimer);
    fileSyncTimer = window.setTimeout(() => writeFileSyncPayload(payload), 500);
  }

  async function writeFileSyncPayload(payload = configPayload()) {
    if (!fileSyncReady || !fileSyncHandle) return;
    try {
      const permission = await fileSyncHandle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        fileSyncStatus = "本地配置文件需要重新授权，自动保存已暂停。";
        renderFileSyncStatus();
        return;
      }
      const writable = await fileSyncHandle.createWritable();
      await writable.write(JSON.stringify({ exportedAt: new Date().toISOString(), ...payload }, null, 2));
      await writable.close();
      fileSyncStatus = `正在同步：${fileSyncHandle.name || "已选择的配置文件"}（刚刚保存）`;
      renderFileSyncStatus();
    } catch {
      fileSyncStatus = "保存本地配置文件失败；可重新连接文件后再试。";
      renderFileSyncStatus();
    }
  }

  async function connectFileSync() {
    if (!fileSyncSupported()) return showToast("当前浏览器不支持本地配置文件同步。");
    try {
      const [handle] = fileSyncHandle ? [fileSyncHandle] : await window.showOpenFilePicker({ types: [{ description: "JSON 配置文件", accept: { "application/json": [".json"] } }], multiple: false });
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") return showToast("需要文件读写权限才能启用自动同步。");
      const imported = JSON.parse(await (await handle.getFile()).text());
      state = normalizeState({ ...state, ...imported });
      fileSyncHandle = handle;
      fileSyncReady = true;
      await saveFileSyncHandle(handle);
      localStorage.removeItem(STORAGE_KEY);
      fileSyncStatus = `正在同步：${handle.name}（已加载）`;
      render();
      closeFileSyncModal(true);
      showToast("已连接本地配置文件，之后会自动读取和保存。");
    } catch (error) {
      if (error?.name !== "AbortError") showToast("连接本地配置文件失败，请确认它是有效 JSON。");
    }
  }

  async function createFileSync() {
    if (!fileSyncSupported()) return showToast("当前浏览器不支持本地配置文件同步。");
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: "intent-sql-builder-config.json", types: [{ description: "JSON 配置文件", accept: { "application/json": [".json"] } }] });
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") return showToast("需要文件读写权限才能启用自动同步。");
      fileSyncHandle = handle;
      fileSyncReady = true;
      await saveFileSyncHandle(handle);
      localStorage.removeItem(STORAGE_KEY);
      await writeFileSyncPayload();
      closeFileSyncModal(true);
      showToast("已创建本地配置文件，之后会自动保存。");
    } catch (error) {
      if (error?.name !== "AbortError") showToast("创建本地配置文件失败。");
    }
  }

  async function restoreFileSyncOnBoot() {
    if (!fileSyncSupported()) {
      fileSyncBootPending = false;
      renderFileSyncStatus();
      openFileSyncModal();
      return;
    }
    try {
      const handle = await readFileSyncHandle();
      if (!handle) return renderFileSyncStatus();
      fileSyncHandle = handle;
      const permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        fileSyncStatus = `已记住 ${handle.name || "本地配置文件"}，请点击“连接已有文件”重新授权。`;
        return renderFileSyncStatus();
      }
      const imported = JSON.parse(await (await handle.getFile()).text());
      state = normalizeState({ ...state, ...imported });
      fileSyncReady = true;
      localStorage.removeItem(STORAGE_KEY);
      fileSyncStatus = `正在同步：${handle.name || "已选择的配置文件"}（已自动加载）`;
      render();
    } catch {
      fileSyncHandle = null;
      fileSyncReady = false;
      fileSyncStatus = "无法读取上次选择的本地配置文件；请重新连接或新建文件。";
      renderFileSyncStatus();
    } finally {
      fileSyncBootPending = false;
      if (!fileSyncReady) openFileSyncModal();
    }
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function showToast(message) {
    $(".toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2600);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function boot() {
    initElements();
    attachEvents();
    render();
    restoreFileSyncOnBoot();
    window.debugConditions = () => {
      console.log("Current conditions:", JSON.stringify(state.intent.condition, null, 2));
      console.log("Available fields:", getAvailableFields().map((f) => f.ref));
      console.log("Generated SQL:", currentGenerated?.sql);
      console.log("Params:", currentGenerated?.params);
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();









