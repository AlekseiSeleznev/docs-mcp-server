# Обновление Docs MCP до 3.3.0

Дата начала: 19 октября 2026 года. Приёмка ещё выполняется.

- Исходный fork: `0bd77903cef59dde5361fb288c5d265dbf5961c6`.
- Upstream: `v3.3.0`, `4cb4390b20a86a472ec4d6d6d45490adfdb2ba35`.
- Рабочий индекс до обновления: 120 библиотек, 120 версий, 35 983 страницы,
  187 494 фрагмента и столько же векторов, 128 страниц с publication metadata.
- До обновления включён `rerank-3-lite`, 30 кандидатов; BGE-M3, 1024 измерения.
- Исходный рабочий каталог чистый; слияние выполняется в отдельном worktree.
- Сохранены Voyage/fail-open/circuit breaker, Source Artifacts и resources,
  publication metadata, минимальный MCPB, hosted bridge, Claude OAuth,
  библиотечные навыки и их автоматическое обновление.
- Новый `openBackend` использует наш factory с reranker. Новые `list_pages` и
  `read_page` доступны в основном read-only MCP; произвольный fetch и операции
  записи на нём по-прежнему отсутствуют.
- Новые схемы MCP и явный `replace` объединены с нашими аннотациями безопасности.
- Ошибка соединения с worker остаётся без приватного URL.
- В SQL поиска сохранён dense-recall floor и publication metadata; добавлены
  исправления и стабильный порядок upstream.

Проверки и сведения об окончательном переключении будут добавлены после приёмки.
Порядок миграции и возврата:
[deploy/upgrades/3.3.0/README.md](../../deploy/upgrades/3.3.0/README.md).

Источник изменений:
[upstream release 3.3.0](https://github.com/arabold/docs-mcp-server/releases/tag/v3.3.0).
