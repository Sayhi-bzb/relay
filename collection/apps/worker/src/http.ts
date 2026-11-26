import { setTimeout as sleep } from "node:timers/promises";

export interface HttpClient {
  getText(url: string, headers?: Record<string, string>): Promise<string>;
  getJson<T>(url: string, headers?: Record<string, string>): Promise<T>;
}

export class FetchHttpClient implements HttpClient {
  constructor(
    private readonly timeoutMs = 15_000,
    private readonly userAgent = "ai-news-radar/0.2",
  ) {}

  private async request(url: string, headers: Record<string, string> = {}): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": this.userAgent, Accept: "*/*", ...headers },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return response;
        const error = new Error(`${url}: HTTP ${response.status}`);
        if (!isRetryableStatus(response.status) || attempt === 2) throw error;
        lastError = error;
        await sleep(retryDelayMs(response.headers.get("retry-after"), attempt));
      } catch (error) {
        lastError = error;
        if (error instanceof Error && /HTTP \d+/.test(error.message)) throw error;
        if (attempt === 2) throw error;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${url}: request failed`);
  }

  async getText(url: string, headers?: Record<string, string>): Promise<string> {
    return (await this.request(url, headers)).text();
  }

  async getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    return (await this.request(url, headers)).json() as Promise<T>;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(value: string | null, attempt: number): number {
  if (!value) return 500 * 2 ** attempt;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 0), 30_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 500 * 2 ** attempt : Math.min(Math.max(timestamp - Date.now(), 0), 30_000);
}
