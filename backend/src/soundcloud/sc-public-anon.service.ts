import type { Readable } from 'node:stream';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  extractClientIdFromHydration,
  pickTranscoding,
  proxyGetWithRetry,
  type ScResolvedTrack,
  streamFromHls,
} from './sc-public-utils.js';

const SC_BASE_URL = 'https://soundcloud.com';
const SC_API_V2 = 'https://api-v2.soundcloud.com';

@Injectable()
export class ScPublicAnonService {
  private readonly logger = new Logger(ScPublicAnonService.name);
  private readonly streamProxyUrls: string[];
  private clientId: string | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.streamProxyUrls = this.configService.get<string[]>('soundcloud.streamProxyUrls') ?? [];
  }

  async getClientId(): Promise<string> {
    if (this.clientId) return this.clientId;
    return this.refreshClientId();
  }

  async getTrackById(trackId: string): Promise<ScResolvedTrack> {
    const clientId = await this.getClientId();
    const target = `${SC_API_V2}/tracks/${trackId}?client_id=${clientId}`;

    try {
      const { data } = await proxyGetWithRetry<ScResolvedTrack>(
        this.httpService,
        this.streamProxyUrls,
        target,
      );
      return data;
    } catch {
      const newClientId = await this.invalidateAndRefresh();
      const retryTarget = `${SC_API_V2}/tracks/${trackId}?client_id=${newClientId}`;
      const { data } = await proxyGetWithRetry<ScResolvedTrack>(
        this.httpService,
        this.streamProxyUrls,
        retryTarget,
      );
      return data;
    }
  }

  async resolveTranscodingUrl(transcodingUrl: string, explicitClientId?: string): Promise<string> {
    const clientId = explicitClientId ?? (await this.getClientId());
    const target = `${transcodingUrl}${transcodingUrl.includes('?') ? '&' : '?'}client_id=${clientId}`;

    try {
      const { data } = await proxyGetWithRetry<{ url: string }>(
        this.httpService,
        this.streamProxyUrls,
        target,
      );
      return data.url;
    } catch {
      if (explicitClientId) throw new Error('Failed to resolve transcoding url');

      const newClientId = await this.invalidateAndRefresh();
      const retryTarget = `${transcodingUrl}${transcodingUrl.includes('?') ? '&' : '?'}client_id=${newClientId}`;
      const { data } = await proxyGetWithRetry<{ url: string }>(
        this.httpService,
        this.streamProxyUrls,
        retryTarget,
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

    const { data } = await proxyGetWithRetry<{ url: string; licenseAuthToken?: string }>(
      this.httpService,
      this.streamProxyUrls,
      target,
    );
    return data.url;
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
      return streamFromHls(
        this.httpService,
        this.streamProxyUrls,
        m3u8Url,
        transcoding.format.mime_type,
      );
    }

    const transcoding = pickTranscoding(transcodings, format);
    if (!transcoding) return null;

    try {
      const m3u8Url = await this.resolveTranscodingUrl(transcoding.url);
      return await streamFromHls(
        this.httpService,
        this.streamProxyUrls,
        m3u8Url,
        transcoding.format.mime_type,
      );
    } catch {
      this.logger.warn(`Stream failed for track ${trackId}, refreshing client_id`);
      await this.invalidateAndRefresh();
      const retryTrack = await this.getTrackById(trackId);
      const retryTranscoding = pickTranscoding(retryTrack.media?.transcodings ?? [], format);
      if (!retryTranscoding) return null;
      const m3u8Url = await this.resolveTranscodingUrl(retryTranscoding.url);
      return streamFromHls(
        this.httpService,
        this.streamProxyUrls,
        m3u8Url,
        retryTranscoding.format.mime_type,
      );
    }
  }

  private async refreshClientId(): Promise<string> {
    const { data: html } = await proxyGetWithRetry<string>(
      this.httpService,
      this.streamProxyUrls,
      SC_BASE_URL,
      { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      { responseType: 'text' },
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
}
