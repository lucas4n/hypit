import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Magnific generates only through its MCP server, with OAuth (the REST key is refused there).
 *
 * The consent is NOT done here. It is the Machinement dashboard's "Conectar Magnific" button,
 * which writes `credentials/magnific-mcp.json` in the socialmedia engine; this module reads that
 * same file and lets the SDK refresh it. Same shape and same 0600 rule as
 * `socialmedia/src/tools/magnific-oauth.ts` — keep the two in step.
 */
export const MAGNIFIC_MCP_URL = "https://mcp.magnific.com";

type Stored = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

class SharedFileOAuth implements OAuthClientProvider {
  constructor(private readonly file: string) {}

  get redirectUrl(): string {
    // Only used for a new consent, which this module never starts; the dashboard owns it.
    return "http://localhost:4321/api/tools/magnific/callback";
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Machinement dashboard",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state(): string { return randomBytes(16).toString("hex"); }
  clientInformation() { return this.read().client; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.write({ ...this.read(), client }); }
  tokens() { return this.read().tokens; }
  saveTokens(tokens: OAuthTokens) { this.write({ ...this.read(), tokens }); }
  saveCodeVerifier(codeVerifier: string) { this.write({ ...this.read(), codeVerifier }); }
  codeVerifier(): string {
    const verifier = this.read().codeVerifier;
    if (!verifier) throw new Error("Magnific consent is incomplete; reconnect it in the Machinement dashboard");
    return verifier;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const stored = this.read();
    if (scope === "all" || scope === "tokens") delete stored.tokens;
    if (scope === "all" || scope === "client") delete stored.client;
    if (scope === "all" || scope === "verifier") delete stored.codeVerifier;
    this.write(stored);
  }
  redirectToAuthorization(): void {
    throw new Error("Magnific needs a new consent: open the Machinement dashboard → Ferramentas → Conectar Magnific");
  }

  private read(): Stored {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf8")) as Stored;
  }
  private write(stored: Stored) {
    writeFileSync(this.file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    // `mode` is ignored when the file already exists.
    chmodSync(this.file, 0o600);
  }
}

export type MagnificCall = (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** One lazily opened MCP session per Provider; a failed call drops it so the next one reconnects. */
export function magnificSession(credentialsFile: string): MagnificCall {
  let connecting: Promise<Client> | undefined;
  const connect = () => connecting ??= (async () => {
    const oauth = new SharedFileOAuth(credentialsFile);
    if (!oauth.tokens() || !oauth.clientInformation()) {
      throw new Error(`No Magnific credential at ${credentialsFile}; connect it in the Machinement dashboard (Ferramentas → Conectar Magnific)`);
    }
    const client = new Client({ name: "machinement-hypit", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(MAGNIFIC_MCP_URL), { authProvider: oauth });
    // The SDK's own types disagree under exactOptionalPropertyTypes (`sessionId?: string`).
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    return client;
  })();

  return async (tool, args) => {
    try {
      const client = await connect();
      const result = await client.callTool({ name: tool, arguments: args });
      const text = (result.content as { type: string; text?: string }[] | undefined)
        ?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
      if (result.isError) throw new Error(`Magnific ${tool} failed: ${text.slice(0, 500)}`);
      if (result.structuredContent !== undefined) return result.structuredContent as Record<string, unknown>;
      // Some tools answer JSON only in the text block.
      try { return JSON.parse(text) as Record<string, unknown>; }
      catch { throw new Error(`Magnific ${tool} returned no structured result`); }
    } catch (error) {
      connecting = undefined;
      throw error;
    }
  };
}
