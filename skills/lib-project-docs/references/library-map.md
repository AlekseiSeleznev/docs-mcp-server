# Карта библиотек проектной документации

Версия библиотек: `1.0.0`. Source Release: `2026.8.21`.
`processId` равен техническому имени библиотеки.
`solutionId`: `project-docs-luve`, `project-docs-mane` или `project-docs-polis`.

## Проекты

| Код | Название | Алиасы |
|---|---|---|
| luve | ЛЮВЕ | Luve, Sest Luve |
| mane | МАНЕ | Mane, MANE Vostok, MAN Vostok |
| polis | Полюс | Polis |

## Разделы

| Код | Смысл | Алиасы | Библиотеки |
|---|---|---|---|
| 01-dogovor | договор | IA, MA, приложения к договору | project-docs-luve-01-dogovor, project-docs-mane-01-dogovor |
| 02-plans | планы проекта | kick-off, бюджет, ресурсный план | project-docs-mane-02-plans, project-docs-polis-02-plans |
| 03-fit-gap | Fit-Gap | опросные листы, протоколы встреч | project-docs-mane-03-fit-gap |
| 04-settings | протокол настроек | Settings Protocol, MSP 2.7 | project-docs-mane-04-settings |
| 05-infrastructure | инфраструктура | архитектура, развёртывание | project-docs-mane-05-infrastructure, project-docs-polis-05-infrastructure |
| 06-test-scenarios | сценарии тестирования | показы, MSP 2.10 | project-docs-mane-06-test-scenarios |
| 07-training | обучение | инструкции, MSP 3.12 | project-docs-mane-07-training |
| 08-roles | роли | МПФР, профили доступа | project-docs-mane-08-roles |
| 09-fs | функциональные спецификации | ФС, ЗНИ | project-docs-mane-09-fs, project-docs-polis-09-fs |
| 10-migration | миграция данных | НСИ | project-docs-mane-10-migration, project-docs-polis-10-migration |
| 11-cutover | cut-over | переход в ПЭО, Go-Live | project-docs-mane-11-cutover, project-docs-polis-11-cutover |
| 12-ope | ОПЭ | hypercare, support log | project-docs-mane-12-ope, project-docs-polis-12-ope |
| 13-lessons | уроки проекта | success stories | project-docs-mane-13-lessons |
| 14-approaches | подходы | тестирование, поддержка | project-docs-polis-14-approaches |
| 15-org-change | орг. изменения | OCM | project-docs-polis-15-org-change |

Раздел 07 у Полюса отсутствует. Вложенные папки FI, LO и WMS входят в ту же библиотеку раздела.

## Представления индекса

| Тип | Что подтверждает поиск |
|---|---|
| docx-text | текст документа |
| pptx-text | текст слайдов |
| xlsx-metadata | листы и выборка строк, не вся таблица |
| legacy-word-metadata | ограниченный текст DOC |
| unsupported-metadata | тип и имя файла, не содержимое MPP |

Исходные байты всех перечисленных файлов остаются Source Artifacts со статусом Downloaded.
