import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { ScPublicAnonService } from './sc-public-anon.service.js';
import {
  extractCookieHydrationData,
  getCookieValue,
  proxyTarget,
  type CookieHydrationData,
  type ScTranscodingInfo,
} from './sc-public-utils.js';

@Injectable()
export class ScPublicCookiesService {
  private static readonly USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';
  private static readonly ORIGIN = 'https://soundcloud.com';
  private static readonly REFERER = 'https://soundcloud.com/';

  private readonly logger = new Logger(ScPublicCookiesService.name);
  private readonly streamProxyUrl: string;
  private readonly cookies: string;
  private readonly oauthToken: string | null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly scPublicAnon: ScPublicAnonService,
  ) {
    this.streamProxyUrl = this.configService.get<string>('soundcloud.streamProxyUrl') ?? '';
    this.cookies = this.configService.get<string>('soundcloud.cookies') ?? '';
    this.oauthToken = getCookieValue(this.cookies, 'oauth_token');
  }

  get hasCookies(): boolean {
    return !!this.cookies;
  }

  async getStreamViaCookies(
    trackUrn: string,
  ): Promise<{ stream: NodeJS.ReadableStream; headers: Record<string, string> } | null> {
    if (!this.cookies) return null;

    const trackId = trackUrn.replace(/.*:/, '');
    const track = await this.scPublicAnon.getTrackById(trackId);
    if (!track.permalink_url) {
      this.logger.warn(`No permalink_url for track ${trackId}`);
      return null;
    }

    const hydration = await this.fetchHydrationSound(track.permalink_url);
    if (!hydration?.sound) return null;
    if (!hydration.clientId) {
      this.logger.warn(`cookie stream hydration has no client_id for track ${trackId}`);
      return null;
    }
    if (!this.oauthToken) {
      this.logger.warn('cookie stream oauth_token cookie is missing');
      return null;
    }

    const transcodings: ScTranscodingInfo[] = hydration.sound.media?.transcodings ?? [];
    const trackAuth = hydration.sound.track_authorization ?? '';
    const full = transcodings.filter((t) => !t.snipped && !t.url.includes('/preview'));
    if (!full.length) {
      this.logger.warn(`No non-snippet transcodings for track ${trackId}`);
      return null;
    }
    const hq = full.filter((t) => t.quality === 'hq');
    const sq = full.filter((t) => t.quality !== 'hq');
    const sortByEncryption = (items: ScTranscodingInfo[]) => [
      ...items.filter((t) => !t.format?.protocol?.includes('encrypted')),
      ...items.filter((t) => t.format?.protocol?.includes('encrypted')),
    ];
    const ordered = [...sortByEncryption(hq), ...sortByEncryption(sq)];

    for (const transcoding of ordered) {
      try {
        const streamUrl = await this.resolveEncryptedTranscoding(transcoding.url, trackAuth, hydration.clientId);

        return await this.scPublicAnon.streamFromHls(streamUrl, transcoding.format.mime_type);
      } catch (err: any) {
        this.logger.warn(
          `Cookie stream ${transcoding.preset} failed: ${err.message}`,
        );
      }
    }

    return null;
  }

  private async fetchHydrationSound(permalinkUrl: string): Promise<CookieHydrationData | null> {
    try {
      const { url, headers } = proxyTarget(this.streamProxyUrl, permalinkUrl, {
        'User-Agent': ScPublicCookiesService.USER_AGENT,
        Cookie: this.cookies,
      });

      const { data: html } = await firstValueFrom(
        this.httpService.get<string>(url, { headers, responseType: 'text' }),
      );

      return extractCookieHydrationData(html);
    } catch (err: any) {
      this.logger.warn(`Failed to fetch track page: ${err.message}`);
      return null;
    }
  }

  private buildResolveHeaders(): Record<string, string> {
    if (!this.oauthToken) {
      throw new Error('Missing oauth_token cookie');
    }

    return {
      Accept: '*/*',
      Authorization: `OAuth ${this.oauthToken}`,
      Origin: ScPublicCookiesService.ORIGIN,
      Referer: ScPublicCookiesService.REFERER,
      'User-Agent': ScPublicCookiesService.USER_AGENT,
    };
  }

  private async resolveTranscodingUrl(transcodingUrl: string, clientId: string): Promise<string> {
    const target = `${transcodingUrl}${transcodingUrl.includes('?') ? '&' : '?'}client_id=${clientId}`;
    const { url, headers } = proxyTarget(this.streamProxyUrl, target, this.buildResolveHeaders());
    const { data } = await firstValueFrom(
      this.httpService.get<{ url: string }>(url, { headers }),
    );
    return data.url;
  }

  private async resolveEncryptedTranscoding(
    transcodingUrl: string,
    trackAuthorization: string,
    clientId: string,
  ): Promise<string> {
    const separator = transcodingUrl.includes('?') ? '&' : '?';
    const target = `${transcodingUrl}${separator}client_id=${clientId}&track_authorization=${trackAuthorization}`;
    const { url, headers } = proxyTarget(this.streamProxyUrl, target, this.buildResolveHeaders());
    const { data } = await firstValueFrom(
      this.httpService.get<{ url: string; licenseAuthToken?: string }>(url, { headers }),
    );
    return data.url;
  }
}
