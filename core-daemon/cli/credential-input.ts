import { readFile } from "node:fs/promises";

export interface CredentialInputOptions {
  botToken?: string;
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
  credentialsJson?: string;
}

export async function resolveCredentialInput(
  options: CredentialInputOptions,
): Promise<Record<string, unknown>> {
  const sources: string[] = [];
  if (options.botToken) sources.push("--bot-token");
  if (options.credentials) sources.push("credentials");
  if (options.credentialsFile) sources.push("--credentials-file");
  if (options.credentialsJson) sources.push("--credentials-json");

  if (sources.length === 0) {
    throw new Error(
      "credentials are required; pass --bot-token, --credentials-file <path.json>, " +
        "or --credentials-json <json>",
    );
  }
  if (sources.length > 1) {
    throw new Error(
      `credential input is ambiguous; pass only one of ${sources.join(", ")}`,
    );
  }

  let credentials: Record<string, unknown>;
  switch (sources[0]) {
    case "--bot-token":
      credentials = { botToken: options.botToken! };
      break;
    case "credentials":
      credentials = { ...options.credentials! };
      break;
    case "--credentials-file":
      credentials = await parseCredentialFile(options.credentialsFile!);
      break;
    case "--credentials-json":
      credentials = parseCredentialJson(options.credentialsJson!, "--credentials-json");
      break;
    default:
      throw new Error("unreachable credential input source");
  }

  return credentials;
}

async function parseCredentialFile(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "UNKNOWN";
    throw new Error(`could not read credentials file ${filePath}: ${code}`);
  }
  return parseCredentialJson(raw, `credentials file ${filePath}`);
}

function parseCredentialJson(raw: string, sourceLabel: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${sourceLabel} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourceLabel} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
