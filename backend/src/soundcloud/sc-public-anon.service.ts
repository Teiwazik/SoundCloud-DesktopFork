import { PassThrough, Readable } from 'node:stream';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  extractClientIdFromHydration,
  getContentTypeForMime,
  parseM3u8,
  pickTranscoding,
  proxyTarget,
  type ScResolvedTrack,
} from './sc-public-utils.js';

const SC_BASE_URL = 'https://soundcloud.com';
const SC_API_V2 = 'https://api-v2.soundcloud.com';
const HLS_PREFETCH_SEGMENTS = 3;

@Injectable()
export class ScPublicAnonService {
  private readonly logger = new Logger(ScPublicAnonService.name);
  private readonly streamProxyUrl: string;
  private clientId: string | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.streamProxyUrl = this.configService.get<string>('soundcloud.streamProxyUrl') ?? '';
  }

  async getClientId(): Promise<string> {
    if (this.clientId) return this.clientId;
    return this.refreshClientId();
  }

  async getTrackById(trackId: string): Promise<ScResolvedTrack> {
    const clientId = await this.getClientId();
    const target = `${SC_API_V2}/tracks/${trackId}?client_id=${clientId}`;

    try {
      const { url, headers } = proxyTarget(this.streamProxyUrl, target);
      const { data } = await firstValueFrom(
        this.httpService.get<ScResolvedTrack>(url, { headers }),
      );
      return data;
    } catch {
      const newClientId = await this.invalidateAndRefresh();
      const retryTarget = `${SC_API_V2}/tracks/${trackId}?client_id=${newClientId}`;
      const { url, headers } = proxyTarget(this.streamProxyUrl, retryTarget);
      const { data } = await firstValueFrom(
        this.httpService.get<ScResolvedTrack>(url, { headers }),
      );
      return data;
    }
  }

  async resolveTranscodingUrl(transcodingUrl: string, explicitClientId?: string): Promise<string> {
    const clientId = explicitClientId ?? (await this.getClientId());
    const target = `${transcodingUrl}${transcodingUrl.includes('?') ? '&' : '?'}client_id=${clientId}`;

    try {
      const { url, headers } = proxyTarget(this.streamProxyUrl, target);
      const { data } = await firstValueFrom(
        this.httpService.get<{ url: string }>(url, { headers }),
      );
      return data.url;
    } catch {
      if (explicitClientId) throw new Error('Failed to resolve transcoding url');

      const newClientId = await this.invalidateAndRefresh();
      const retryTarget = `${transcodingUrl}${transcodingUrl.includes('?') ? '&' : '?'}client_id=${newClientId}`;
      const { url, headers } = proxyTarget(this.streamProxyUrl, retryTarget);
      const { data } = await firstValueFrom(
        this.httpService.get<{ url: string }>(url, { headers }),
      );
      return data.url;
    }
  }

  async resolveEncryptedTranscoding(
    transcodingUrl: string,
    trackAuthorization: string,
    explicitClientId?: string,
  ): Promise<string> {
    const clientId = explicitClientId ?? (await this.getClientId());
    const separator = transcodingUrl.includes('?') ? '&' : '?';
    const target = `${transcodingUrl}${separator}client_id=${clientId}&track_authorization=${trackAuthorization}`;

    const { url, headers } = proxyTarget(this.streamProxyUrl, target);
    const { data } = await firstValueFrom(
      this.httpService.get<{ url: string; licenseAuthToken?: string }>(url, { headers }),
    );
    return data.url;
  }

  async streamFromHls(
    m3u8Url: string,
    mimeType: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> }> {
    const { url, headers } = proxyTarget(this.streamProxyUrl, m3u8Url);
    const { data: m3u8Content } = await firstValueFrom(
      this.httpService.get<string>(url, { headers, responseType: 'text' }),
    );

    const { initUrl, segmentUrls } = parseM3u8(m3u8Content, m3u8Url);
    if (!segmentUrls.length) {
      throw new Error('No segments found in m3u8 playlist');
    }

    const initSegmentPromise = initUrl ? this.downloadSegment(initUrl) : Promise.resolve<Buffer | null>(null);

    const passthrough = new PassThrough();
    this.pipeSegments(passthrough, initSegmentPromise, segmentUrls).catch((err) => {
      this.logger.error(`HLS segment streaming failed: ${err.message}`);
      passthrough.destroy(err);
    });

    return { stream: passthrough, headers: { 'content-type': getContentTypeForMime(mimeType) } };
  }

  async getStreamForTrack(
    trackUrn: string,
    format?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    const trackId = trackUrn.replace(/.*:/, '');

    const track = await this.getTrackById(trackId);
    const transcodings = track.media?.transcodings;

    if (!transcodings?.length) {
      this.logger.warn(`No transcodings for track ${trackId}, refreshing client_id`);
      await this.invalidateAndRefresh();
      const retryTrack = await this.getTrackById(trackId);
      const retryTranscodings = retryTrack.media?.transcodings;
      if (!retryTranscodings?.length) return null;

      const transcoding = pickTranscoding(retryTranscodings, format);
      if (!transcoding) return null;
      const m3u8Url = await this.resolveTranscodingUrl(transcoding.url);
      return this.streamFromHls(m3u8Url, transcoding.format.mime_type);
    }

    const transcoding = pickTranscoding(transcodings, format);
    if (!transcoding) return null;

    try {
      const m3u8Url = await this.resolveTranscodingUrl(transcoding.url);
      return await this.streamFromHls(m3u8Url, transcoding.format.mime_type);
    } catch {
      this.logger.warn(`Stream failed for track ${trackId}, refreshing client_id`);
      await this.invalidateAndRefresh();
      const retryTrack = await this.getTrackById(trackId);
      const retryTranscoding = pickTranscoding(retryTrack.media?.transcodings ?? [], format);
      if (!retryTranscoding) return null;
      const m3u8Url = await this.resolveTranscodingUrl(retryTranscoding.url);
      return this.streamFromHls(m3u8Url, retryTranscoding.format.mime_type);
    }
  }

  private async refreshClientId(): Promise<string> {
    const { url, headers } = proxyTarget(this.streamProxyUrl, SC_BASE_URL, {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    });

    const { data: html } = await firstValueFrom(
      this.httpService.get<string>(url, { headers, responseType: 'text' }),
    );

    const clientId = extractClientIdFromHydration(html);
    if (!clientId) {
      throw new Error('Failed to extract SoundCloud client_id from page');
    }

    this.clientId = clientId;
    this.logger.log('Refreshed SoundCloud public client_id');
    return clientId;
  }

  private invalidateAndRefresh(): Promise<string> {
    this.clientId = null;
    return this.refreshClientId();
  }

  private async pipeSegments(
    output: PassThrough,
    initSegmentPromise: Promise<Buffer | null>,
    segmentUrls: string[],
  ): Promise<void> {
    try {
      const initSegment = await initSegmentPromise;
      if (initSegment) {
        if (initSegment.includes(Buffer.from('enca'))) {
          throw new Error('Stream is CENC encrypted');
        }
        if (!output.writable) return;
        output.write(initSegment);
      }

      const inflight: Array<Promise<Buffer>> = [];
      let nextIndex = 0;

      const fillQueue = () => {
        while (
          nextIndex < segmentUrls.length &&
          inflight.length < HLS_PREFETCH_SEGMENTS
        ) {
          inflight.push(this.downloadSegment(segmentUrls[nextIndex]));
          nextIndex += 1;
        }
      };

      fillQueue();

      while (inflight.length > 0) {
        const chunk = await inflight.shift()!;
        if (!output.writable) break;
        output.write(chunk);
        fillQueue();
      }
      output.end();
    } catch (err) {
      output.destroy(err as Error);
    }
  }

  private async downloadSegment(segmentUrl: string): Promise<Buffer> {
    const { url, headers } = proxyTarget(this.streamProxyUrl, segmentUrl);
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers, responseType: 'arraybuffer' }),
    );
    return Buffer.from(data);
  }
}
