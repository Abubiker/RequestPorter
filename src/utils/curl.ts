import { generateId } from "../data/id";
import type { AuthConfig, HttpMethod, KeyValue } from "../domain/models";

interface ParsedCurlRequest {
  method: HttpMethod;
  url: string;
  headers: KeyValue[];
  queryParams: KeyValue[];
  body: string;
  auth: AuthConfig;
  name: string;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function tokenizeCurl(command: string): string[] {
  const normalized = command.replace(/\\\n/g, " ").trim();
  const matches = normalized.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  return (matches ?? []).map((token) => stripQuotes(token));
}

function toMethod(method: string): HttpMethod {
  const upper = method.toUpperCase();
  switch (upper) {
    case "GET":
    case "POST":
    case "PUT":
    case "DELETE":
    case "PATCH":
    case "HEAD":
    case "OPTIONS":
      return upper;
    default:
      throw new Error(`Unsupported HTTP method in cURL: ${method}`);
  }
}

function buildName(method: HttpMethod, url: string): string {
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.pathname || "/"}`;
  } catch {
    return `${method} ${url}`;
  }
}

function parseHeaderRow(row: string): KeyValue {
  const separatorIndex = row.indexOf(":");
  if (separatorIndex === -1) {
    return {
      id: generateId("header"),
      key: row.trim(),
      value: "",
      enabled: true,
    };
  }

  const key = row.slice(0, separatorIndex).trim();
  const value = row.slice(separatorIndex + 1).trim();
  return {
    id: generateId("header"),
    key,
    value,
    enabled: true,
  };
}

export function parseCurlCommand(command: string): ParsedCurlRequest {
  const tokens = tokenizeCurl(command);

  if (!tokens.length || tokens[0].toLowerCase() !== "curl") {
    throw new Error("Input must start with `curl`");
  }

  let method: HttpMethod = "GET";
  let url = "";
  let body = "";
  const headers: KeyValue[] = [];
  let auth: AuthConfig = { type: "none" };

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    switch (token) {
      case "-X":
      case "--request": {
        const value = tokens[index + 1];
        if (!value) {
          throw new Error("Missing value after --request");
        }
        method = toMethod(value);
        index += 1;
        break;
      }
      case "-H":
      case "--header": {
        const value = tokens[index + 1];
        if (!value) {
          throw new Error("Missing value after --header");
        }
        const parsedHeader = parseHeaderRow(value);
        const authMatch = /^authorization$/i.test(parsedHeader.key)
          ? parsedHeader.value.match(/^Bearer\s+(.+)$/i)
          : null;
        if (authMatch) {
          auth = {
            type: "bearer",
            value: authMatch[1].trim(),
          };
        } else {
          headers.push(parsedHeader);
        }
        index += 1;
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-urlencode": {
        const value = tokens[index + 1];
        if (!value) {
          throw new Error("Missing value after --data");
        }
        body = value;
        if (method === "GET") {
          method = "POST";
        }
        index += 1;
        break;
      }
      case "--url": {
        const value = tokens[index + 1];
        if (!value) {
          throw new Error("Missing value after --url");
        }
        url = value;
        index += 1;
        break;
      }
      case "-G":
      case "--get": {
        method = "GET";
        break;
      }
      case "-I":
      case "--head": {
        method = "HEAD";
        break;
      }
      default: {
        if (token.startsWith("http://") || token.startsWith("https://")) {
          url = token;
        }
        break;
      }
    }
  }

  if (!url) {
    throw new Error("Unable to find URL in cURL command");
  }

  let resolvedUrl = url;
  const queryParams: KeyValue[] = [];
  try {
    const parsedUrl = new URL(url);
    parsedUrl.searchParams.forEach((value, key) => {
      queryParams.push({
        id: generateId("query"),
        key,
        value,
        enabled: true,
      });
    });
    parsedUrl.search = "";
    resolvedUrl = parsedUrl.toString();
  } catch {
    // Keep original URL if parsing fails.
  }

  return {
    method,
    url: resolvedUrl,
    headers,
    queryParams,
    body,
    auth,
    name: buildName(method, resolvedUrl),
  };
}
