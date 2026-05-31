#!/usr/bin/env node
// AGE-34: IPC protocol-version gate. DAEMON_VERSION is only the artifact
// freshness key; IPC_PROTOCOL_VERSION is the wire/schema compatibility key.
// If the canonical IPC contract fingerprint changes without a protocol bump or
// an explicit IPC_COMPAT_NOTE, old shims may incorrectly consider themselves
// compatible with a daemon whose wire contract moved.
//
// Scope v1: exported protocol.ts/config.ts contract only. Per-method IPC
// params/results are intentionally out of scope until those contracts are
// centralized in a typed method registry.
//
// Usage: node scripts/check-ipc-protocol-bump.mjs [baseRef]
//   baseRef defaults to env BASE_REF, else origin/universal-overhaul.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseRef = process.argv[2] || process.env.BASE_REF || "origin/universal-overhaul";

export const IPC_FILES = {
  config: "core-daemon/config.ts",
  protocol: "core-daemon/ipc/protocol.ts",
};

const COMPAT_NOTE_TOKEN = "IPC_COMPAT_NOTE";
const FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function fileAtRef(ref, file) {
  try {
    return git(["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function readHeadFile(file) {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

function safeRevParse(ref) {
  try {
    return git(["rev-parse", ref]).trim();
  } catch {
    return null;
  }
}

function commitMessages(baseSha) {
  try {
    return git(["log", "--format=%B", `${baseSha}..HEAD`]);
  } catch {
    return "";
  }
}

function canonicalJson(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortDeep(child)]),
  );
}

function sha256Short(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function sourcePath(file) {
  return path.resolve("/", file).replace(/\\/g, "/");
}

function normalizeFileName(fileName) {
  return path.resolve(fileName).replace(/\\/g, "/");
}

function createProgramFromContents(files) {
  const normalized = new Map(
    Object.entries(files).map(([file, content]) => [sourcePath(file), content]),
  );
  const compilerOptions = {
    allowJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultResolveModuleNames = host.resolveModuleNames?.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const normalizedName = normalizeFileName(fileName);
    if (normalized.has(normalizedName)) {
      return ts.createSourceFile(
        normalizedName,
        normalized.get(normalizedName),
        languageVersion,
        true,
      );
    }
    return defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => normalized.has(normalizeFileName(fileName)) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => normalized.get(normalizeFileName(fileName)) ?? ts.sys.readFile(fileName);
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      if (moduleName.endsWith(".js")) {
        const candidate = normalizeFileName(path.resolve(path.dirname(containingFile), moduleName.replace(/\.js$/, ".ts")));
        if (normalized.has(candidate)) {
          return { resolvedFileName: candidate, extension: ts.Extension.Ts };
        }
      }
      return (
        defaultResolveModuleNames?.([moduleName], containingFile, undefined, undefined, compilerOptions)[0] ??
        ts.resolveModuleName(moduleName, containingFile, compilerOptions, host).resolvedModule
      );
    });

  return ts.createProgram({
    rootNames: [sourcePath(IPC_FILES.config), sourcePath(IPC_FILES.protocol)],
    options: compilerOptions,
    host,
  });
}

function sourceFile(program, file) {
  const wanted = sourcePath(file);
  const found = program.getSourceFiles().find((sf) => normalizeFileName(sf.fileName) === wanted);
  if (!found) throw new Error(`Unable to load TypeScript source file ${file}`);
  return found;
}

function declarationKind(declaration) {
  if (ts.isInterfaceDeclaration(declaration)) return "interface";
  if (ts.isTypeAliasDeclaration(declaration)) return "type";
  if (ts.isFunctionDeclaration(declaration)) return "function";
  if (ts.isVariableDeclaration(declaration)) return "const";
  return "unknown";
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function typeToString(checker, type, node) {
  return checker.typeToString(type, node, FORMAT_FLAGS);
}

function serializeProperties(checker, type, node) {
  const properties = {};
  for (const prop of checker.getPropertiesOfType(type).sort((a, b) => a.name.localeCompare(b.name))) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0] ?? node;
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    properties[prop.name] = {
      optional: Boolean(prop.flags & ts.SymbolFlags.Optional),
      type: typeToString(checker, propType, decl),
    };
  }
  const indexSignatures = checker.getIndexInfosOfType(type).map((info) => ({
    key: info.keyType ? typeToString(checker, info.keyType, node) : "unknown",
    readonly: info.isReadonly,
    type: typeToString(checker, info.type, node),
  }));
  return { properties, ...(indexSignatures.length ? { indexSignatures } : {}) };
}

function serializeConst(checker, declaration) {
  const initializer = declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
  if (initializer && ts.isObjectLiteralExpression(initializer)) {
    const members = {};
    for (const prop of initializer.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : prop.name?.getText();
      if (!name) continue;
      const type = checker.getTypeAtLocation(prop.initializer);
      members[name] = typeToString(checker, type, prop.initializer);
    }
    return { kind: "const-object", members };
  }
  const type = checker.getTypeAtLocation(declaration);
  return { kind: "const", type: typeToString(checker, type, declaration) };
}

function serializeFunction(checker, symbol, node) {
  const type = checker.getTypeOfSymbolAtLocation(symbol, node);
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  return {
    kind: "function",
    signatures: signatures.map((signature) => ({
      parameters: signature.parameters.map((param) => {
        const decl = param.valueDeclaration ?? node;
        const paramType = checker.getTypeOfSymbolAtLocation(param, decl);
        return {
          name: param.name,
          optional:
            Boolean(param.flags & ts.SymbolFlags.Optional) ||
            (ts.isParameter(decl) && (Boolean(decl.questionToken) || Boolean(decl.initializer))),
          type: typeToString(checker, paramType, decl),
        };
      }),
      returns: typeToString(checker, checker.getReturnTypeOfSignature(signature), node),
    })),
  };
}

function serializeTypeAlias(checker, declaration) {
  const type = checker.getTypeFromTypeNode(declaration.type);
  const out = {
    kind: "type",
    type: typeToString(checker, type, declaration),
  };
  if (type.isUnion()) {
    out.union = type.types.map((member) => typeToString(checker, member, declaration)).sort();
  }
  return out;
}

function serializeInterface(checker, declaration) {
  const type = checker.getTypeAtLocation(declaration);
  return {
    kind: "interface",
    ...serializeProperties(checker, type, declaration),
  };
}

function serializeExport(checker, symbol, source) {
  const declaration = symbol.declarations?.find((decl) => decl.getSourceFile() === source);
  if (!declaration) return null;
  if (ts.isVariableDeclaration(declaration)) return serializeConst(checker, declaration);
  if (ts.isFunctionDeclaration(declaration)) return serializeFunction(checker, symbol, declaration);
  if (ts.isInterfaceDeclaration(declaration)) return serializeInterface(checker, declaration);
  if (ts.isTypeAliasDeclaration(declaration)) return serializeTypeAlias(checker, declaration);
  return { kind: declarationKind(declaration), text: declaration.getText(source) };
}

function moduleExports(checker, source) {
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return new Map();
  return checker.getExportsOfModule(moduleSymbol);
}

function exportedSymbolByName(checker, source, name) {
  return moduleExports(checker, source).find((symbol) => symbol.name === name);
}

export function ipcProtocolContractFromContents(files) {
  const program = createProgramFromContents(files);
  const checker = program.getTypeChecker();
  const config = sourceFile(program, IPC_FILES.config);
  const protocol = sourceFile(program, IPC_FILES.protocol);
  const protocolVersionSymbol = exportedSymbolByName(checker, config, "IPC_PROTOCOL_VERSION");
  if (!protocolVersionSymbol) throw new Error("IPC_PROTOCOL_VERSION export not found.");

  const protocolVersion = serializeExport(checker, protocolVersionSymbol, config);
  const exports = {
    IPC_PROTOCOL_VERSION: protocolVersion,
  };

  for (const symbol of moduleExports(checker, protocol).sort((a, b) => a.name.localeCompare(b.name))) {
    const serialized = serializeExport(checker, symbol, protocol);
    if (serialized) exports[symbol.name] = serialized;
  }

  return sortDeep({
    surface: "agents-comm-bus/ipc",
    files: [IPC_FILES.config, IPC_FILES.protocol],
    exports,
  });
}

export function contractFingerprint(contract) {
  const json = canonicalJson(contract);
  return { json, hash: sha256Short(json) };
}

export function diffContracts(base, head, prefix = "") {
  if (JSON.stringify(base) === JSON.stringify(head)) return [];
  if (
    base === null ||
    head === null ||
    typeof base !== "object" ||
    typeof head !== "object" ||
    Array.isArray(base) ||
    Array.isArray(head)
  ) {
    return [{ path: prefix || "<root>", base, head }];
  }
  const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
  return keys.flatMap((key) => diffContracts(base[key], head[key], prefix ? `${prefix}.${key}` : key));
}

export function evaluateProtocolChange(base, head, options = {}) {
  const baseFp = contractFingerprint(base);
  const headFp = contractFingerprint(head);
  if (baseFp.hash === headFp.hash) {
    return { ok: true, reason: "unchanged", baseFp, headFp, diffs: [] };
  }
  const baseProtocol = ipcProtocolVersion(base);
  const headProtocol = ipcProtocolVersion(head);
  const diffs = diffContracts(base, head);
  if (baseProtocol !== headProtocol) {
    return { ok: true, reason: "protocol-bumped", baseFp, headFp, baseProtocol, headProtocol, diffs };
  }
  if (options.compatNote) {
    return { ok: true, reason: "compat-note", baseFp, headFp, baseProtocol, headProtocol, diffs };
  }
  return { ok: false, reason: "missing-protocol-bump", baseFp, headFp, baseProtocol, headProtocol, diffs };
}

export function ipcProtocolVersion(contract) {
  const raw = contract?.exports?.IPC_PROTOCOL_VERSION?.type;
  return typeof raw === "string" ? raw.replace(/^['"]|['"]$/g, "") : null;
}

function contractAtRef(ref) {
  const files = {};
  for (const [key, file] of Object.entries(IPC_FILES)) {
    const content = ref === "HEAD" ? readHeadFile(file) : fileAtRef(ref, file);
    if (content == null) return null;
    files[key === "config" ? IPC_FILES.config : IPC_FILES.protocol] = content;
  }
  return ipcProtocolContractFromContents(files);
}

function hasCompatNote(baseSha) {
  return process.env.IPC_COMPAT_NOTE || commitMessages(baseSha).includes(COMPAT_NOTE_TOKEN);
}

function main() {
  const baseSha = safeRevParse(baseRef);
  if (!baseSha) {
    console.log(`[check-ipc-protocol-bump] base ref "${baseRef}" not found; skipping (nothing to compare).`);
    return;
  }

  const base = contractAtRef(baseSha);
  const head = contractAtRef("HEAD");
  if (!base || !head) {
    console.log("[check-ipc-protocol-bump] IPC contract files missing at base or HEAD; skipping.");
    return;
  }

  const baseFp = contractFingerprint(base);
  const headFp = contractFingerprint(head);
  const evaluation = evaluateProtocolChange(base, head, { compatNote: hasCompatNote(baseSha) });
  if (evaluation.reason === "unchanged") {
    console.log(`[check-ipc-protocol-bump] ✓ IPC protocol export fingerprint unchanged (${headFp.hash}).`);
    return;
  }

  if (evaluation.reason === "protocol-bumped") {
    console.log(
      `[check-ipc-protocol-bump] ✓ IPC contract changed and IPC_PROTOCOL_VERSION changed ` +
        `(${evaluation.baseProtocol} -> ${evaluation.headProtocol}).`,
    );
    return;
  }

  if (evaluation.reason === "compat-note") {
    console.log(
      `[check-ipc-protocol-bump] ✓ IPC contract changed without a protocol bump, ` +
        `but ${COMPAT_NOTE_TOKEN} is present. Review compatibility intentionally.`,
    );
    return;
  }

  console.error("\n[check-ipc-protocol-bump] ✖ IPC PROTOCOL VERSION NOT UPDATED\n");
  console.error(
    `  IPC contract fingerprint changed (${baseFp.hash} -> ${headFp.hash}) but ` +
      `IPC_PROTOCOL_VERSION is still "${evaluation.headProtocol}".\n`,
  );
  console.error("  Changed contract entries:");
  for (const diff of evaluation.diffs.slice(0, 25)) {
    console.error(`    - ${diff.path}`);
    console.error(`      base: ${JSON.stringify(diff.base)}`);
    console.error(`      head: ${JSON.stringify(diff.head)}`);
  }
  if (evaluation.diffs.length > 25) {
    console.error(`    ... ${evaluation.diffs.length - 25} more`);
  }
  console.error(
    "\n  Fix: bump IPC_PROTOCOL_VERSION in core-daemon/config.ts when the wire/schema\n" +
      "       contract changes. For a deliberate compatible/no-wire change, include\n" +
      `       ${COMPAT_NOTE_TOKEN}: <reason> in the commit/PR context.\n`,
  );
  process.exit(1);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
