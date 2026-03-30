import { isTauri } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

interface RequestMertEmbeddingParams {
  endpoint: string;
  model: string;
  filePath: string;
  trackUrn: string;
  timeoutMs?: number;
}

interface MertAnalyzeBody {
  model: string;
  file_path: string;
  track_urn: string;
}

const CANDIDATE_PATHS = ['/api/mert/analyze', '/mert/analyze', '/analyze'];

const numberArrayFromUnknown = (value: unknown): number[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: number[] = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out.length > 0 ? out : null;
};

const extractEmbedding = (payload: unknown): number[] | null => {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  return (
    numberArrayFromUnknown(obj.embedding) ||
    numberArrayFromUnknown(obj.vector) ||
    numberArrayFromUnknown((obj.result as Record<string, unknown> | undefined)?.embedding) ||
    numberArrayFromUnknown((obj.result as Record<string, unknown> | undefined)?.vector) ||
    numberArrayFromUnknown((obj.data as Record<string, unknown> | undefined)?.embedding) ||
    numberArrayFromUnknown((obj.data as Record<string, unknown> | undefined)?.vector) ||
    null
  );
};

async function postJson(url: string, body: MertAnalyzeBody, signal: AbortSignal): Promise<Response> {
  const request = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };

  if (isTauri()) {
    try {
      return await tauriFetch(url, request);
    } catch {}
  }

  return fetch(url, request);
}

export async function requestMertEmbedding(params: RequestMertEmbeddingParams): Promise<number[] | null> {
  const { endpoint, model, filePath, trackUrn, timeoutMs = 15000 } = params;
  const normalizedEndpoint = endpoint.trim().replace(/\/$/, '');
  if (!normalizedEndpoint || !model.trim() || !filePath.trim() || !trackUrn.trim()) return null;

  const body: MertAnalyzeBody = {
    model: model.trim(),
    file_path: filePath,
    track_urn: trackUrn,
  };

  for (const candidatePath of CANDIDATE_PATHS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await postJson(`${normalizedEndpoint}${candidatePath}`, body, controller.signal);
      if (!res.ok) continue;
      const data = (await res.json()) as unknown;
      const embedding = extractEmbedding(data);
      if (embedding?.length) {
        return embedding;
      }
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}
