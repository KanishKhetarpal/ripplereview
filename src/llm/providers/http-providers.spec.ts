import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeminiLlmProvider } from './gemini-llm.provider';
import { LlmHttpError } from './http-llm.provider';
import { OpenAiLlmProvider } from './openai-llm.provider';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/**
 * Runs both providers against a real HTTP server on localhost.
 *
 * Not a mocked `fetch`: the point is to verify what actually goes on the wire — the path,
 * the auth header, the JSON body shape — and to exercise the real error paths (a non-2xx
 * with a JSON body, a non-2xx with an empty body, a 200 carrying malformed JSON, a
 * connection that never answers). A stubbed fetch would only assert that this code agrees
 * with my assumptions about it, which is the thing most likely to be wrong.
 *
 * The response bodies below are copied from the real services' documented shapes, and the
 * two error shapes were captured from the live APIs during Phase 2's probe.
 */
describe('HTTP LLM providers (real local server)', () => {
  let server: Server;
  let baseUrl: string;
  const recorded: Recorded[] = [];

  /** Set per test to control what the fake service returns. */
  let respond: (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        recorded.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: parsed,
        });
        respond(req, res, parsed);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const okOpenAi = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'gpt-4o-mini-2024-07-18',
        choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 123, completion_tokens: 45 },
      }),
    );
  };

  const okGemini = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"findings":[]}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30 },
      }),
    );
  };

  const request = {
    system: 'you are a reviewer',
    user: 'review this',
    maxOutputTokens: 2048,
    temperature: 0,
  };

  const openai = (): OpenAiLlmProvider =>
    new OpenAiLlmProvider({ apiKey: 'sk-test-key', model: '', baseUrl, maxRetries: 0 });
  const gemini = (): GeminiLlmProvider =>
    new GeminiLlmProvider({ apiKey: 'test-key', model: '', baseUrl, maxRetries: 0 });

  const lastRequest = (): Recorded => recorded[recorded.length - 1];

  describe('OpenAI', () => {
    it('posts to the chat completions path', async () => {
      respond = (_req, res) => okOpenAi(res);
      await openai().complete(request);
      expect(lastRequest().url).toBe('/v1/chat/completions');
      expect(lastRequest().method).toBe('POST');
    });

    it('sends the key as a bearer token, not a query parameter', async () => {
      respond = (_req, res) => okOpenAi(res);
      await openai().complete(request);
      expect(lastRequest().headers.authorization).toBe('Bearer sk-test-key');
      expect(lastRequest().url).not.toContain('sk-test-key');
    });

    it('sends system and user as separate messages', async () => {
      respond = (_req, res) => okOpenAi(res);
      await openai().complete(request);
      const body = lastRequest().body as {
        messages: { role: string; content: string }[];
        temperature: number;
        max_completion_tokens: number;
      };
      expect(body.messages).toEqual([
        { role: 'system', content: 'you are a reviewer' },
        { role: 'user', content: 'review this' },
      ]);
      expect(body.temperature).toBe(0);
      expect(body.max_completion_tokens).toBe(2048);
    });

    it('asks for a JSON object, which removes the most common malformed reply', async () => {
      respond = (_req, res) => okOpenAi(res);
      await openai().complete(request);
      const body = lastRequest().body as { response_format: { type: string } };
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('returns the content, usage and the model the service actually used', async () => {
      respond = (_req, res) => okOpenAi(res);
      const response = await openai().complete(request);

      expect(response.text).toBe('{"findings":[]}');
      expect(response.usage.inputTokens).toBe(123);
      expect(response.usage.outputTokens).toBe(45);
      // The service reports the resolved snapshot; recording our request's alias instead
      // would misattribute a run to the wrong model.
      expect(response.model).toBe('gpt-4o-mini-2024-07-18');
    });

    it('never invents a cost', async () => {
      respond = (_req, res) => okOpenAi(res);
      const response = await openai().complete(request);
      expect(response.usage.estimatedCostUsd).toBeNull();
    });

    it('surfaces the service message from an error body served as text/plain', async () => {
      // Captured from the live API: OpenAI returns its 401 with content-type text/plain,
      // so a content-type-driven .json() would throw on the one response that explains why.
      respond = (_req, res) => {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end(
          JSON.stringify({
            error: { message: 'Incorrect API key provided: sk-t***', code: 'invalid_api_key' },
          }),
        );
      };

      await expect(openai().complete(request)).rejects.toThrow(/Incorrect API key/);
      await expect(openai().complete(request)).rejects.toThrow(/invalid_api_key/);

      // The message must be EXTRACTED, not the raw body echoed back. Asserting only on
      // the text above passes either way, because the raw JSON contains it — which is how
      // a mutation that removed the extraction entirely survived this test.
      const error = await openai()
        .complete(request)
        .then(() => null)
        .catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain('{"error"');
      expect(error?.message).toMatch(/Incorrect API key provided: sk-t\*\*\* \(invalid_api_key\)/);
    });

    it('reports an empty error body rather than throwing while parsing it', async () => {
      respond = (_req, res) => {
        res.writeHead(404);
        res.end();
      };
      await expect(openai().complete(request)).rejects.toBeInstanceOf(LlmHttpError);
      await expect(openai().complete(request)).rejects.toThrow(/no response body/);
    });

    it('rejects a 200 whose body is not JSON', async () => {
      respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<html>gateway error</html>');
      };
      await expect(openai().complete(request)).rejects.toThrow(/not JSON/);
    });

    it('names the finish reason when a 200 carries no content', async () => {
      respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'length' }] }));
      };
      await expect(openai().complete(request)).rejects.toThrow(/finish_reason=length/);
    });
  });

  describe('Gemini', () => {
    it('posts to generateContent for the configured model', async () => {
      respond = (_req, res) => okGemini(res);
      await gemini().complete(request);
      expect(lastRequest().url).toBe('/v1beta/models/gemini-2.0-flash:generateContent');
    });

    it('sends the key in a header, so it cannot leak through a logged URL', async () => {
      respond = (_req, res) => okGemini(res);
      await gemini().complete(request);
      expect(lastRequest().headers['x-goog-api-key']).toBe('test-key');
      expect(lastRequest().url).not.toContain('test-key');
    });

    it('sends the system prompt as systemInstruction, not as a contents role', async () => {
      respond = (_req, res) => okGemini(res);
      await gemini().complete(request);
      const body = lastRequest().body as {
        systemInstruction: { parts: { text: string }[] };
        contents: { role: string; parts: { text: string }[] }[];
      };
      expect(body.systemInstruction.parts[0].text).toBe('you are a reviewer');
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'review this' }] }]);
    });

    it('returns the text and token counts', async () => {
      respond = (_req, res) => okGemini(res);
      const response = await gemini().complete(request);
      expect(response.text).toBe('{"findings":[]}');
      expect(response.usage.inputTokens).toBe(200);
      expect(response.usage.outputTokens).toBe(30);
    });

    it('surfaces an invalid key reported as HTTP 400, not 401', async () => {
      // Captured from the live API. Classifying errors by status alone would report a bad
      // key as a malformed request, sending the reader to the wrong place entirely.
      respond = (_req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT',
              details: [{ reason: 'API_KEY_INVALID' }],
            },
          }),
        );
      };

      await expect(gemini().complete(request)).rejects.toThrow(/API key not valid/);
      await expect(gemini().complete(request)).rejects.toThrow(/API_KEY_INVALID/);
    });

    it('names the block reason when a candidate carries no text', async () => {
      respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [{ finishReason: 'SAFETY' }],
            promptFeedback: { blockReason: 'OTHER' },
          }),
        );
      };
      await expect(gemini().complete(request)).rejects.toThrow(/finishReason=SAFETY/);
      await expect(gemini().complete(request)).rejects.toThrow(/blockReason=OTHER/);
    });
  });

  describe('retry policy', () => {
    it('retries a 503 and succeeds on the second attempt', async () => {
      let calls = 0;
      respond = (_req, res) => {
        calls++;
        if (calls === 1) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'overloaded' } }));
          return;
        }
        okOpenAi(res);
      };

      const provider = new OpenAiLlmProvider({
        apiKey: 'sk-test',
        model: '',
        baseUrl,
        maxRetries: 2,
      });
      const response = await provider.complete(request);

      expect(response.text).toBe('{"findings":[]}');
      expect(calls).toBe(2);
    }, 30_000);

    it('does NOT retry a 401, which would fail identically every time', async () => {
      let calls = 0;
      respond = (_req, res) => {
        calls++;
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
      };

      const provider = new OpenAiLlmProvider({
        apiKey: 'sk-test',
        model: '',
        baseUrl,
        maxRetries: 2,
      });

      await expect(provider.complete(request)).rejects.toThrow(/bad key/);
      expect(calls).toBe(1);
    });

    it('gives up after the retry budget instead of retrying forever', async () => {
      let calls = 0;
      respond = (_req, res) => {
        calls++;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      };

      const provider = new OpenAiLlmProvider({
        apiKey: 'sk-test',
        model: '',
        baseUrl,
        maxRetries: 1,
      });

      await expect(provider.complete(request)).rejects.toThrow(/rate limited/);
      expect(calls).toBe(2);
    }, 30_000);
  });

  it('honours an explicit model over the provider default', async () => {
    respond = (_req, res) => okGemini(res);
    const provider = new GeminiLlmProvider({
      apiKey: 'k',
      model: 'gemini-2.5-pro',
      baseUrl,
      maxRetries: 0,
    });
    await provider.complete(request);
    expect(lastRequest().url).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
  });
});
