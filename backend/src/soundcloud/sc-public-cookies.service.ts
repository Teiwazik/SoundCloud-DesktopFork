import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuthAppsService } from '../oauth-apps/oauth-apps.service.js';
import { ScPublicAnonService } from './sc-public-anon.service.js';
import {
  type CookieHydrationData,
  extractCookieHydrationData,
  getCookieValue,
  proxyGetWithRetry,
  type ScTranscodingInfo,
  streamFromHls,
} from './sc-public-utils.js';

@Injectable()
export class ScPublicCookiesService {
  private static readonly USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';
  private static readonly ORIGIN = 'https://soundcloud.com';
  private static readonly REFERER = 'https://soundcloud.com/';
  private static readonly FAILURE_THRESHOLD = 3;
  private static readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000;

  private readonly logger = new Logger(ScPublicCookiesService.name);
  private readonly streamProxyUrls: string[];
  private readonly cookies: string;
  private readonly oauthToken: string | null;
  private consecutiveFailures = 0;
  private degraded = false;
  private lastAlertAt = 0;
  private lastFailureReason = '';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly scPublicAnon: ScPublicAnonService,
    private readonly oauthAppsService: OAuthAppsService,
  ) {
    this.streamProxyUrls = this.configService.get<string[]>('soundcloud.streamProxyUrls') ?? [];
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
    if (!hydration) {
      return null;
    }
    if (!hydration.sound) {
      await this.recordFailure('hydration_missing_sound', trackUrn);
      return null;
    }
    if (!hydration.clientId) {
      this.logger.warn(`cookie stream hydration has no client_id for track ${trackId}`);
      await this.recordFailure('hydration_missing_client_id', trackUrn);
      return null;
    }
    if (!this.oauthToken) {
      this.logger.warn('cookie stream oauth_token cookie is missing');
      await this.recordFailure('missing_oauth_token_cookie', trackUrn);
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
        const streamUrl = await this.resolveEncryptedTranscoding(
          transcoding.url,
          trackAuth,
          hydration.clientId,
        );
        const result = await streamFromHls(
          this.httpService,
          this.streamProxyUrls,
          streamUrl,
          transcoding.format.mime_type,
        );
        await this.recordSuccess();
        return result;
      } catch (err: any) {
        this.logger.warn(`Cookie stream ${transcoding.preset} failed: ${err.message}`);
      }
    }

    await this.recordFailure('all_cookie_transcodings_failed', trackUrn);
    return null;
  }

  private async fetchHydrationSound(permalinkUrl: string): Promise<CookieHydrationData | null> {
    try {
      const { data: html } = await proxyGetWithRetry<string>(
        this.httpService,
        this.streamProxyUrls,
        permalinkUrl,
        { 'User-Agent': ScPublicCookiesService.USER_AGENT, Cookie: this.cookies },
        { responseType: 'text' },
      );

      return extractCookieHydrationData(html);
    } catch (err: any) {
      this.logger.warn(`Failed to fetch track page: ${err.message}`);
      await this.recordFailure('track_page_fetch_failed', permalinkUrl, err.message);
      return null;
    }
  }

  private async recordFailure(reason: string, subject: string, details?: string): Promise<void> {
    if (!this.cookies) return;

    this.consecutiveFailures += 1;
    this.lastFailureReason = reason;

    if (this.consecutiveFailures < ScPublicCookiesService.FAILURE_THRESHOLD) {
      return;
    }

    const now = Date.now();
    if (this.degraded && now - this.lastAlertAt < ScPublicCookiesService.ALERT_COOLDOWN_MS) {
      return;
    }

    this.degraded = true;
    this.lastAlertAt = now;

    const detailsSuffix = details
      ? `\nDetails: <code>${this.escapeHtml(details.slice(0, 300))}</code>`
      : '';
    await this.oauthAppsService.notify(
      `⚠️ <b>Cookie stream degraded</b>\n\n` +
        `Reason: <code>${this.escapeHtml(reason)}</code>\n` +
        `Consecutive failures: <b>${this.consecutiveFailures}</b>\n` +
        `Last subject: <code>${this.escapeHtml(subject)}</code>` +
        `${detailsSuffix}`,
    );
  }

  private async recordSuccess(): Promise<void> {
    if (!this.cookies) return;

    const wasDegraded = this.degraded;
    const previousFailures = this.consecutiveFailures;
    const previousReason = this.lastFailureReason;

    this.consecutiveFailures = 0;
    this.lastFailureReason = '';
    this.degraded = false;

    if (!wasDegraded) {
      return;
    }

    await this.oauthAppsService.notify(
      `✅ <b>Cookie stream restored</b>\n\n` +
        `Previous reason: <code>${this.escapeHtml(previousReason || 'unknown')}</code>\n` +
        `Failures before recovery: <b>${previousFailures}</b>`,
    );
  }

  private escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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

  private async resolveEncryptedTranscoding(
    transcodingUrl: string,
    trackAuthorization: string,
    clientId: string,
  ): Promise<string> {
    const separator = transcodingUrl.includes('?') ? '&' : '?';
    const target = `${transcodingUrl}${separator}client_id=${clientId}&track_authorization=${trackAuthorization}`;
    const { data } = await proxyGetWithRetry<{ url: string; licenseAuthToken?: string }>(
      this.httpService,
      this.streamProxyUrls,
      target,
      this.buildResolveHeaders(),
    );
    return data.url;
  }
}
