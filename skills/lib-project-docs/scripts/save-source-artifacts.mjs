#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

function parseArguments(argv) {
  let destination;
  let count;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--destination") destination = value;
    if (flag === "--count") count = Number.parseInt(value ?? "", 10);
  }
  if (!destination || !isAbsolute(destination)) {
    throw new Error("--destination must be an absolute path");
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
    throw new Error("--count must be an integer from 1 to 1000");
  }
  return { count, destination: resolve(destination) };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("blob must be canonical base64");
  }
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) {
    throw new Error("blob must be canonical base64");
  }
  return data;
}

function validateFormat(data, mimeType) {
  if (
    mimeType === "text/xml" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml")
  ) {
    const xml = data.subarray(0, 16_384).toString("utf8").toLowerCase();
    if (!xml.includes("definitions") || !xml.includes("bpmn")) {
      throw new Error("invalid BPMN XML");
    }
    return;
  }
  if (mimeType.endsWith("wordprocessingml.document")) {
    const zip = data.toString("latin1");
    if (!data.subarray(0, 2).equals(Buffer.from("PK")) || !zip.includes("word/")) {
      throw new Error("invalid DOCX");
    }
    return;
  }
  if (mimeType.endsWith("spreadsheetml.sheet")) {
    const zip = data.toString("latin1");
    if (!data.subarray(0, 2).equals(Buffer.from("PK")) || !zip.includes("xl/")) {
      throw new Error("invalid XLSX");
    }
    return;
  }
  if (mimeType.endsWith("presentationml.presentation")) {
    const zip = data.toString("latin1");
    if (!data.subarray(0, 2).equals(Buffer.from("PK")) || !zip.includes("ppt/")) {
      throw new Error("invalid PPTX");
    }
    return;
  }
  if (mimeType === "application/msword") {
    const ole = data.toString("latin1");
    if (
      !data
        .subarray(0, 8)
        .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) ||
      !ole.includes("WordDocument")
    ) {
      throw new Error("invalid DOC");
    }
    return;
  }
  if (mimeType === "application/vnd.ms-project") {
    const ole = data.toString("latin1");
    if (
      !data
        .subarray(0, 8)
        .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) ||
      !(ole.includes("Microsoft Project") || ole.includes("MSProject"))
    ) {
      throw new Error("invalid MPP");
    }
    return;
  }
  if (mimeType === "application/pdf") {
    if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("invalid PDF");
    }
    return;
  }
  if (mimeType === "text/plain") {
    if (data.includes(0)) throw new Error("invalid text");
    return;
  }
  throw new Error("unsupported media type");
}

function validateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record must be an object");
  }
  const { blob, mimeType, sha256: expectedSha256, sizeBytes, suggestedFilename } =
    value;
  if (
    typeof suggestedFilename !== "string" ||
    suggestedFilename.length === 0 ||
    basename(suggestedFilename) !== suggestedFilename ||
    suggestedFilename.includes("\\")
  ) {
    throw new Error("suggestedFilename must be a safe file name");
  }
  if (typeof mimeType !== "string" || mimeType.length === 0) {
    throw new Error("mimeType must be a non-empty string");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("sizeBytes must be a non-negative integer");
  }
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("sha256 must be a lowercase SHA-256 digest");
  }
  const data = decodeBase64(blob);
  if (data.length !== sizeBytes || sha256(data) !== expectedSha256) {
    throw new Error("payload integrity check failed");
  }
  validateFormat(data, mimeType);
  return { data, expectedSha256, suggestedFilename };
}

function candidateName(name, index) {
  if (index === 0) return name;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} (${index})${extension}`;
}

function saveRecord(destination, record) {
  const { data, expectedSha256, suggestedFilename } = validateRecord(record);
  for (let index = 0; ; index += 1) {
    const path = join(destination, candidateName(suggestedFilename, index));
    if (existsSync(path)) {
      if (statSync(path).isFile() && sha256(readFileSync(path)) === expectedSha256) {
        return { name: suggestedFilename, path, status: "reused" };
      }
      continue;
    }
    let descriptor;
    try {
      descriptor = openSync(path, "wx", 0o644);
      writeFileSync(descriptor, data);
      fsyncSync(descriptor);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") continue;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    if (sha256(readFileSync(path)) !== expectedSha256) {
      throw new Error("written file integrity check failed");
    }
    return { name: suggestedFilename, path, status: "saved" };
  }
}

function main() {
  const { count, destination } = parseArguments(process.argv.slice(2));
  mkdirSync(destination, { recursive: true });
  const rawMode = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  if (rawMode) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdout.write(`${JSON.stringify({ ready: true, count })}\n`);

  let buffer = "";
  let completed = 0;
  let stopped = false;
  const restoreTerminal = () => {
    if (rawMode) process.stdin.setRawMode(false);
  };
  const fail = (error) => {
    if (stopped) return;
    stopped = true;
    restoreTerminal();
    const message = error instanceof Error ? error.message : "unknown writer error";
    process.stderr.write(`${JSON.stringify({ error: message })}\n`, () => process.exit(1));
  };
  const acceptLine = (line) => {
    if (line.length === 0) return;
    const record = JSON.parse(line);
    const result = saveRecord(destination, record);
    completed += 1;
    const final = completed === count;
    process.stdout.write(`${JSON.stringify(result)}\n`, () => {
      if (!final || stopped) return;
      stopped = true;
      restoreTerminal();
      process.exit(0);
    });
  };

  process.stdin.on("data", (chunk) => {
    if (stopped) return;
    try {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        acceptLine(line);
        if (stopped) break;
      }
    } catch (error) {
      fail(error);
    }
  });
  process.stdin.on("end", () => {
    if (!stopped && completed !== count) {
      fail(new Error(`unexpected end of input after ${completed} of ${count} records`));
    }
  });
  process.stdin.on("error", fail);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown writer error";
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}
