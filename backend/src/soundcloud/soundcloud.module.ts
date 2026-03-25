import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { OAuthAppsModule } from '../oauth-apps/oauth-apps.module.js';
import { ScPublicAnonService } from './sc-public-anon.service.js';
import { ScPublicCookiesService } from './sc-public-cookies.service.js';
import { SoundcloudService } from './soundcloud.service.js';

@Module({
  imports: [HttpModule, OAuthAppsModule],
  providers: [SoundcloudService, ScPublicAnonService, ScPublicCookiesService],
  exports: [SoundcloudService, ScPublicAnonService, ScPublicCookiesService],
})
export class SoundcloudModule {}
