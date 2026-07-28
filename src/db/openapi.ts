import type { OpenAPIV3 } from "openapi-types";

export const OPENAPI_DOCUMENT: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Релизы 1С API",
    version: "1.0.0",
    description:
      "Публичный API каталога конфигураций, истории релизов и расчёта цепочек обновлений. " +
      "Данные формируются из releases.1c.ru и онлайн-каталога обновлений 1С.",
  },
  servers: [{ url: "/", description: "Текущий сервер" }],
  tags: [
    { name: "Сервис", description: "Состояние приложения и статистика" },
    { name: "Каталог", description: "Конфигурации и версии" },
    { name: "Обновления", description: "Цепочки обновлений, патчи и ссылки" },
  ],
  paths: {
    "/api/health": {
      get: {
        tags: ["Сервис"],
        summary: "Состояние приложения",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Приложение доступно",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "has_its", "its_accounts"],
                  properties: {
                    ok: { type: "boolean", example: true },
                    has_its: { type: "boolean", example: true },
                    its_accounts: { type: "integer", example: 2 },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/revision": {
      get: {
        tags: ["Сервис"],
        summary: "Ревизия каталога",
        description: "Используется клиентом для фоновой проверки изменений данных.",
        operationId: "getCatalogRevision",
        responses: {
          "200": {
            description: "Время последнего изменения каталога",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    revision: { type: "string", format: "date-time", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/configs": {
      get: {
        tags: ["Каталог"],
        summary: "Каталог конфигураций",
        description:
          "Без параметров возвращает весь доступный каталог. Параметр q ищет по коду, названию и разработчику. " +
          "Параметр version возвращает конфигурации, в истории которых присутствует точная версия.",
        operationId: "getConfigurations",
        parameters: [
          {
            name: "q",
            in: "query",
            description: "Строка поиска",
            schema: { type: "string" },
            example: "Управление торговлей",
          },
          {
            name: "version",
            in: "query",
            description: "Точный номер релиза",
            schema: { type: "string" },
            example: "11.5.27.61",
          },
        ],
        responses: {
          "200": {
            description: "Список конфигураций",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Configuration" },
                },
              },
            },
          },
        },
      },
    },
    "/api/versions": {
      get: {
        tags: ["Каталог"],
        summary: "История версий конфигурации",
        operationId: "getConfigurationVersions",
        parameters: [
          {
            name: "config",
            in: "query",
            required: true,
            description: "Внутренний код конфигурации или release:<id> для проекта без соответствия LST",
            schema: { type: "string" },
            example: "УправлениеТорговлей",
          },
          {
            name: "includeResources",
            in: "query",
            description: "Совместимость: включить все ссылки в общий ответ. Для интерфейса рекомендуется ленивый endpoint version-resources.",
            schema: { type: "boolean", default: false },
          },
          {
            name: "project",
            in: "query",
            description: "ID проекта releases.1c.ru для изоляции редакций, использующих общий граф LST",
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "Версии, метаданные, допустимые переходы и ссылки",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VersionHistory" },
              },
            },
          },
        },
      },
    },
    "/api/version-resources": {
      get: {
        tags: ["Обновления"],
        summary: "Ссылки и файлы конкретного релиза",
        description: "Лениво возвращает материалы только выбранной версии.",
        operationId: "getVersionResources",
        parameters: [
          { $ref: "#/components/parameters/Config" },
          { $ref: "#/components/parameters/Version" },
          {
            name: "project",
            in: "query",
            description: "ID конкретного проекта releases.1c.ru",
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "Ссылки релиза и состояние их доступности",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["resources", "sync_status"],
                  properties: {
                    resources: { type: "array", items: { $ref: "#/components/schemas/VersionResource" } },
                    sync_status: { type: "string", enum: ["pending", "ok", "error"] },
                    synced_at: { type: "string", format: "date-time", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/release-changes": {
      get: {
        tags: ["Обновления"],
        summary: "Лента изменений релизов",
        description:
          "Новые версии, изменения требований платформы, новые материалы и исправления, обнаруженные импортом.",
        operationId: "getReleaseChanges",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 40 },
          },
          {
            name: "before",
            in: "query",
            description: "Непрозрачный курсор следующей страницы",
            schema: { type: "string" },
          },
          {
            name: "type",
            in: "query",
            schema: {
              type: "string",
              enum: ["new_version", "platform_changed", "resource_added", "patch_added"],
            },
          },
          {
            name: "project",
            in: "query",
            description: "Ограничить ленту одним проектом releases.1c.ru",
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "Страница событий в обратном хронологическом порядке",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items", "next_cursor"],
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/ReleaseChange" } },
                    next_cursor: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/patches": {
      get: {
        tags: ["Обновления"],
        summary: "Исправления ошибок для версии",
        operationId: "getVersionPatches",
        parameters: [
          { $ref: "#/components/parameters/Config" },
          {
            name: "version",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "project",
            in: "query",
            description: "ID конкретного проекта releases.1c.ru",
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "Список патчей",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["patches"],
                  properties: {
                    patches: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Patch" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/chain": {
      get: {
        tags: ["Обновления"],
        summary: "Рассчитать цепочку обновлений",
        description:
          "Возвращает кратчайшую цепочку. При одинаковой длине предпочитаются более новые промежуточные версии. " +
          "Версии для тестирования из расчёта исключаются.",
        operationId: "calculateUpdateChain",
        parameters: [
          { $ref: "#/components/parameters/Config" },
          {
            name: "from",
            in: "query",
            required: true,
            description: "Исходная версия",
            schema: { type: "string" },
            example: "11.5.26.112",
          },
          {
            name: "to",
            in: "query",
            required: true,
            description: "Целевая стабильная версия",
            schema: { type: "string" },
            example: "11.5.27.61",
          },
        ],
        responses: {
          "200": {
            description: "Результат расчёта",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChainResult" },
              },
            },
          },
        },
      },
    },
    "/api/stats": {
      get: {
        tags: ["Сервис"],
        summary: "Сводная статистика каталога",
        operationId: "getCatalogStats",
        responses: {
          "200": {
            description: "Количество конфигураций, переходов и уникальных версий",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["configurations", "edges", "versions"],
                  properties: {
                    configurations: { type: "integer" },
                    edges: { type: "integer" },
                    versions: { type: "integer" },
                    last_updated: { type: "string", format: "date", nullable: true },
                    lastRun: { type: "object", nullable: true, additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/openapi.json": {
      get: {
        tags: ["Сервис"],
        summary: "Спецификация OpenAPI",
        operationId: "getOpenApiDocument",
        responses: {
          "200": {
            description: "OpenAPI 3.0 в формате JSON",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
  components: {
    parameters: {
      Config: {
        name: "config",
        in: "query",
        required: true,
        description: "Внутренний код конфигурации",
        schema: { type: "string" },
        example: "УправлениеТорговлей",
      },
      Version: {
        name: "ver",
        in: "query",
        required: true,
        description: "Номер версии",
        schema: { type: "string" },
        example: "11.5.27.61",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" } },
      },
      ReleaseChange: {
        type: "object",
        required: ["id", "event_type", "project_id", "project_name", "details", "occurred_at", "detected_at"],
        properties: {
          id: { type: "integer" },
          event_type: {
            type: "string",
            enum: ["new_version", "platform_changed", "resource_added", "patch_added"],
          },
          project_id: { type: "integer" },
          config_id: { type: "integer", nullable: true },
          project_name: { type: "string" },
          project_nick: { type: "string", nullable: true },
          group_name: { type: "string", nullable: true },
          version: { type: "string", nullable: true },
          is_test: { type: "boolean" },
          details: { type: "object", additionalProperties: true },
          occurred_at: { type: "string", format: "date-time" },
          detected_at: { type: "string", format: "date-time" },
        },
      },
      Configuration: {
        type: "object",
        required: ["id", "name", "display_name"],
        properties: {
          id: { type: "string", example: "96" },
          project_id: { type: "integer", nullable: true },
          name: { type: "string", example: "УправлениеТорговлей" },
          display_name: { type: "string", example: "Управление торговлей, редакция 11" },
          vendor: { type: "string", nullable: true },
          releases_href: { type: "string", nullable: true, example: "/project/Trade110" },
          group_name: { type: "string", nullable: true },
          region: { type: "string", nullable: true, example: "ru" },
          latest_version: { type: "string", nullable: true, example: "11.5.27.61" },
          latest_date: { type: "string", format: "date", nullable: true },
          latest_platform: { type: "string", nullable: true },
          latest_recommended_platform: { type: "string", nullable: true },
          next_release_version: { type: "string", nullable: true },
          next_release_planned_date: { type: "string", nullable: true },
          next_release_plan_updated: { type: "string", format: "date", nullable: true },
          version_count: { type: "integer" },
          has_graph: { type: "boolean" },
          mapping_status: { type: "string", enum: ["auto", "manual", "unmatched", "lst-only"] },
          transition_mode: { type: "string", enum: ["explicit", "unrestricted", "unknown"] },
          available_accounts: { type: "integer" },
          available_account_labels: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
      },
      VersionResource: {
        type: "object",
        properties: {
          kind: { type: "string" },
          category: { type: "string" },
          title: { type: "string" },
          href: { type: "string" },
          file_name: { type: "string", nullable: true },
          file_extension: { type: "string", nullable: true },
          file_size_bytes: { type: "integer", format: "int64", nullable: true },
          published_at: { type: "string", format: "date", nullable: true },
          sha512: { type: "string", nullable: true },
          is_file: { type: "boolean" },
        },
        additionalProperties: true,
      },
      VersionMetadata: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["releases", "lst"] },
          release_date: { type: "string", format: "date", nullable: true },
          min_platform: { type: "string", nullable: true },
          recommended_platform: { type: "string", nullable: true },
          file_size_bytes: { type: "integer", format: "int64", nullable: true },
          download_href: { type: "string", nullable: true },
          is_test: { type: "boolean" },
          previous_versions: { type: "array", items: { type: "string" } },
          resources: { type: "array", items: { $ref: "#/components/schemas/VersionResource" } },
        },
        additionalProperties: true,
      },
      VersionHistory: {
        type: "object",
        required: ["versions", "meta", "cfu"],
        properties: {
          versions: { type: "array", items: { type: "string" } },
          editions: {
            type: "array",
            items: {
              type: "object",
              required: ["edition", "versions"],
              properties: {
                edition: { type: "integer" },
                versions: { type: "array", items: { type: "string" } },
              },
            },
          },
          meta: { type: "object", additionalProperties: { $ref: "#/components/schemas/VersionMetadata" } },
          cfu: { type: "object", additionalProperties: { type: "string" } },
          releases_href: { type: "string", nullable: true },
          graph_ready: { type: "boolean" },
          transition_mode: { type: "string", enum: ["explicit", "unrestricted", "unknown"] },
          resources_included: { type: "boolean" },
        },
      },
      Patch: {
        type: "object",
        properties: {
          uuid: { type: "string" },
          title: { type: "string", nullable: true },
          patch_date: { type: "string", format: "date", nullable: true },
          download_key: { type: "string", nullable: true },
        },
      },
      ChainStep: {
        type: "object",
        required: ["fromVersion", "toVersion", "cfuPath"],
        properties: {
          fromVersion: { type: "string" },
          toVersion: { type: "string" },
          cfuPath: { type: "string" },
        },
      },
      ChainResult: {
        type: "object",
        required: ["found", "steps", "length"],
        properties: {
          found: { type: "boolean" },
          steps: { type: "array", items: { $ref: "#/components/schemas/ChainStep" } },
          length: { type: "integer" },
          note: { type: "string", nullable: true },
          error: { type: "string", nullable: true },
        },
      },
    },
  },
};
