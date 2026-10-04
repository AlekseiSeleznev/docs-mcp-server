#!/usr/bin/env python3
"""Build a pinned, curated Markdown import without copying private project files."""

import argparse
import concurrent.futures
import csv
import hashlib
import json
import re
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

COMMIT = "a2d584ced20332e7174abf94770c2dd986845a2a"
VERSION = "2026.10.2"
SOURCE = f"https://github.com/Pr-Mex/vanessa-automation/blob/{COMMIT}/"
ROOT = Path(__file__).resolve().parents[1]
SOURCE_BLOBS = {}


def read_source(cache, path):
    """Read exact upstream bytes, fetching only the pinned commit on cache misses."""
    target = cache / path
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://raw.githubusercontent.com/Pr-Mex/vanessa-automation/{COMMIT}/"
        target.write_bytes(urllib.request.urlopen(url + urllib.parse.quote(path), timeout=60).read())
    data = target.read_bytes()
    expected = SOURCE_BLOBS.get(path)
    actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if expected is None or actual != expected:
        raise ValueError(f"Pinned source verification failed: {path}")
    return data.decode("utf-8-sig")


def clean_lesson(text):
    """Remove presentation-only paragraphs while retaining source statements."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    paragraphs = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = re.sub(r"^\d{3}\.\s*", "", paragraph.strip())
        if not paragraph or re.search(
            r"Ссылка на видео|Привет!|На этом всё|Давай откроем|Загрузим тестовый|"
            r"[Зз]агрузим тестовый|Загр\^узим|ЗагрУзим|Откроем второй", paragraph
        ):
            continue
        # Screenshot narration with no self-contained technical statement.
        if re.search(r"вот этот|вот здесь|показан|показано|этот шаг|указывается здесь|задаётся здесь|"
                     r"выглядит так|на картинке|на скриншоте|выделен|подсвечен|Важный момент\.$|"
                     r"Продолжим\.$|Здесь приведён|В этом примере данная строка", paragraph, re.I):
            continue
        paragraphs.append(paragraph)
    return "\n\n".join(paragraphs)


def sections(text, level=2):
    """Split only at actual Markdown headings outside fenced code blocks."""
    result = []
    current = []
    fenced = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
        if not fenced and re.match(rf"^#{{{level}}} ", line) and current:
            result.append("\n".join(current).strip())
            current = []
        current.append(line)
    if current:
        result.append("\n".join(current).strip())
    return result


def main():
    """Write deterministic pages, provenance inventory and the standard import package."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    tree_path = args.cache / "tree.json"
    if not tree_path.exists():
        args.cache.mkdir(parents=True, exist_ok=True)
        url = f"https://api.github.com/repos/Pr-Mex/vanessa-automation/git/trees/{COMMIT}?recursive=1"
        tree_path.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    tree = json.loads(tree_path.read_text())
    if tree.get("truncated"):
        raise ValueError("Source tree is truncated")
    SOURCE_BLOBS.update({item["path"]: item["sha"] for item in tree["tree"] if item["type"] == "blob"})
    rows = list(csv.DictReader((ROOT / "docs/research/vanessa-automation/inventory.csv").open()))
    pages = []
    excluded = []

    def add(title, body, path, section="", extra_sources=()):
        if len(body.strip()) < 30:
            return
        source_link = SOURCE + urllib.parse.quote(path, safe="/") if path.startswith(("docs/", "training/")) or path == "LICENSE" else ""
        provenance = (
            f"Источник: Vanessa Automation; {path}; {section or title}.\n\n"
            f"Исходная ссылка: <{source_link}>\n\nCommit источника: `{COMMIT}`. "
            f"Снимок библиотеки: {VERSION}.\n\n"
        ) if source_link else (
            f"Источник: внутренняя методика команды; {path}; {title}.\n\n"
            f"Обобщённое изложение без проектных данных. Снимок: {VERSION}.\n\n"
        )
        edition = "Редакция основной справки: 1.2.043.1.\n\n" if "MainHelp/1.2.043.1/" in path else ""
        suffix = "\n\n" + "\n".join(f"Источник примера: <{SOURCE + urllib.parse.quote(p, safe='/')}>" for p in extra_sources) if extra_sources else ""
        body = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", body)
        content = f"# Vanessa Automation — {title}\n\n{provenance}{edition}{body.strip()}{suffix}\n"
        identity = hashlib.sha256(f"{path}\n{section}\n{title}".encode()).hexdigest()[:16]
        member = f"pages/{identity}.md"
        pages.append({"member": member, "title": title, "source_path": path,
                      "section": section or title, "source_url": source_link,
                      "sha256": hashlib.sha256(content.encode()).hexdigest(), "content": content})

    for row in rows:
        path = row["path"]
        decision = row["decision"]
        if decision not in {"keep", "prepare", "extract"}:
            continue
        text = read_source(args.cache, path)
        if decision == "prepare":
            title = re.sub(r"(?<=[а-яёa-z])(?=[А-ЯЁA-Z])", " ", Path(path).stem)
            lesson_path = "training/features/" + "/".join(Path(path).parts[-2:]).replace(".MD", ".feature")
            driver = read_source(args.cache, lesson_path)
            references = re.findall(r'training\\features\\Примеры\\([^"\n]+\.feature)', driver)
            examples = []
            example_paths = []
            for ref in dict.fromkeys(references):
                example_path = "training/features/Примеры/" + ref.replace("\\", "/")
                example = read_source(args.cache, example_path)
                # Use only the currently documented primary server-variable method.
                if Path(path).stem == "КакИспользоватьПеременнуюДляВычисленияНаСервере":
                    example = example.split("\t* Также есть такой вариант")[0]
                # Private-looking connection literals are not reproduced.
                if re.search(r"(?i)(?:пароль|password)\s*=|(?:\d{1,3}\.){3}\d{1,3}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", example):
                    excluded.append({"path": example_path, "reason": "connection-or-tag-example-not-reproduced"})
                    continue
                examples.append(f"## Пример {Path(ref).stem}\n\n"
                                "Имена объектов, полей и пути в примере относятся к учебной базе; "
                                "проверьте их в метаданных своего проекта.\n\n```gherkin\n" + example.rstrip() + "\n```")
                example_paths.append(example_path)
            body = clean_lesson(text)
            if Path(path).stem == "КакИспользоватьПеременнуюДляВычисленияНаСервере":
                body = "Использовать специальные шаги вычисления выражений на сервере с передачей значений переменных. " \
                       "Ниже восстановлен основной способ из исходного учебного сценария; старые обходные способы исключены."
            # A lesson requiring a visual example is omitted unless text is recovered.
            dependent = bool(re.search(r"Загрузим|Загрузим|тестовый пример|первым параметром|в этом примере|пример показан", text, re.I))
            if dependent and not examples:
                excluded.append({"path": path, "reason": "visual-example-not-recovered"})
                continue
            if len(body) < 220 and not examples:
                excluded.append({"path": path, "reason": "insufficient-self-contained-text"})
                continue
            if examples:
                body += "\n\n" + "\n\n".join(examples)
            add(title, body, path, extra_sources=example_paths)
        elif path == "docs/AI/index.md":
            for part in sections(text):
                heading = part.splitlines()[0].lstrip("# ")
                if heading in {"Быстрый старт", "Пример запуска сеанса 1С из командной строки так, чтобы сразу запустился MCP сервер"}:
                    add(heading, part, path, heading)
                elif heading == "Доступные инструменты:":
                    for line in part.splitlines():
                        match = re.match(r"\| \*\*([^*]+)\*\* \| (.*) \|", line)
                        if match:
                            add("MCP инструмент " + match[1], match[2], path, match[1])
        elif path == "docs/JsonParams/JsonParamsRU.md":
            for part in sections(text):
                heading = part.splitlines()[0].lstrip("# ")
                if part.startswith("## ") and "Автоинструкции" not in heading:
                    parameters = list(re.finditer(r"(?m)^\s*\*\s+\*\*([^*]+)\*\*\s*:", part))
                    if parameters:
                        for i, match in enumerate(parameters):
                            end = parameters[i + 1].start() if i + 1 < len(parameters) else len(part)
                            name = match[1]
                            add("VAParams " + name, "## " + heading + "\n\n" + part[match.start():end], path, heading + " / " + name)
                    else:
                        add("VAParams — " + heading, part, path, heading)
        elif path == "docs/FAQ/index.md":
            # Admit only topics corroborated by the current main help/specialized docs.
            corroboration = {
                1: "docs/MainHelp/1.2.043.1/Глава02/ЗакладкаСервисОсновныеТеги.MD",
                23: "docs/VAExtension/VAExtension.md",
            }
            allowed = set(corroboration)
            for part in sections(text):
                match = re.match(r"## (\d+)\. (.+)", part)
                if match and int(match[1]) in allowed:
                    if int(match[1]) == 1:
                        part = part.split("* Да пусть падает")[0]
                    if int(match[1]) == 23:
                        part = part.split("* (Устарело)")[0]
                    add("FAQ — " + match[2], part, path, match[0][3:], extra_sources=(corroboration[int(match[1])],))
            excluded.append({"path": path, "reason": "only-current-corroborated-topics-selected"})
        elif path == "docs/index.md":
            for part in sections(text):
                heading = part.splitlines()[0].lstrip("# ")
                if heading in {"Установка через OneScript", "Рекомендуемая концепция написания тестовых сценариев"}:
                    add(heading, part, path, heading)
        elif path == "docs/UIAutomation/UIAutomation.md":
            excluded.append({"path": path, "reason": "covered-by-current-mainhelp-ui-automation"})
        else:
            for part in sections(text):
                heading = part.splitlines()[0].lstrip("# ")
                add(heading or Path(path).stem, part, path, heading)

    # Editorial summaries: policy statements only, no imported private source bytes.
    add("Организация проекта — методика команды", """
## Структура

Хранить сценарии тестов отдельно от переиспользуемых экспортных сценариев. Выделить
каталоги внешних тестовых файлов, результатов прогона, скриншотов и архивных версий.
Настройки окружения отделить от сценариев; при переключении окружения использовать
отдельный файл настроек и сохранять настройки других участников команды.

## Соглашения команды

Один feature-файл описывает бизнес-процесс и может содержать несколько последовательных
сценариев. Команда использует префиксы `гл` для глобальных переменных и `пар` для
параметров экспортных сценариев. Это соглашение команды, а не требование Vanessa.
Приёмка теста включает прогон в целевом окружении и фиксацию версии конфигурации.
""", "Структура проекта Autotest.docx")
    add("Поддержка тестов при обновлении — методика команды", """
## Процесс обновления

Развернуть отдельную тестовую базу целевой версии, подготовить данные и выполнить полный
прогон. Разделить ошибки на изменения интерфейса, изменения бизнес-логики и проблемы
тестовых данных. Назначить исправления, проверить их локально и повторить полный прогон.
Зафиксировать принятую версию сценариев вместе с версией конфигурации и результатами.
Сохранять предыдущие версии для воспроизведения тестов на прежних конфигурациях.

## Политика команды

Команда планирует актуализацию библиотеки под LTS-релизы конфигурации. Это ограничение
ресурсов команды, а не ограничение Vanessa. Способ версионирования общих экспортных
сценариев в исходной методике ещё не выбран; варианты не включены как принятый регламент.
""", "Методика актуализации библиотеки тестов.docx")
    add("Приёмка сценариев — методика команды", """
Проверять сценарии отдельно и в пакетном прогоне. Переиспользовать экспортные сценарии,
сохранять сведения о предпосылках и необходимых тестовых данных. После изменения
конфигурации повторно проверять сценарии в целевой версии: имена элементов интерфейса
и последовательность бизнес-процесса могут измениться.

Статус принятого теста должен опираться на результат прогона. Описание теста или
запись в реестре сами по себе не подтверждают его работоспособность.

Технические приёмы работы с переменными, таблицами и ожиданиями приведены в отдельных
страницах upstream. Черновые ограничения и противоречивые рекомендации регламента
в этот набор не перенесены.
""", "Регламент Vanessa Automation.docx")
    license_text = read_source(args.cache, "LICENSE")
    add("Лицензия upstream BSD 3-Clause", license_text, "LICENSE", "Лицензия")
    archive = args.output / "book.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for page in sorted(pages, key=lambda p: p["member"]):
            info = zipfile.ZipInfo(page["member"], (2026, 10, 2, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(info, page["content"])
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    manifest = {"book": {"title": "Vanessa Automation — автотестирование 1С", "slug": "vanessa-automation",
                           "edition": VERSION, "snapshot_date": "2026-10-02"},
                "package": {"format": "markdown-v1"}, "source_commit": COMMIT,
                "zip": {"filename": archive.name, "sha256": digest}, "counts": {"markdown": len(pages)},
                "markdown": [{k: v for k, v in p.items() if k != "content"} for p in pages],
                "exclusions": excluded}
    (args.output / "book.manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (args.output / "book.sha256").write_text(f"{digest}  book.zip\n")
    (args.output / "book.report.md").write_text(
        f"# Vanessa Automation curated import\n\n- Recommended maxPages: {len(pages) + 5}\n"
        f"- ZIP SHA-256: {digest}\n- Markdown pages: {len(pages)}\n- Source commit: {COMMIT}\n"
        "- Private source documents: not included\n- Standard step inventory: outside this release\n"
    )
    print(json.dumps({"pages": len(pages), "excluded_during_preparation": len(excluded), "sha256": digest}))


if __name__ == "__main__":
    main()
