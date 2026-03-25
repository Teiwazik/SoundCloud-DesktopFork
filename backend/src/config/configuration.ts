function collectStreamProxyUrls(): string[] {
  const urls: string[] = [];
  const primary = process.env.SC_STREAM_PROXY_URL || process.env.SC_PROXY_URL || '';
  if (primary) urls.push(primary);
  for (let i = 2; ; i++) {
    const url = process.env[`SC_STREAM_PROXY_URL_${i}`];
    if (!url) break;
    urls.push(url);
  }
  return urls;
}

export default () => ({
  port: Number.parseInt(process.env.PORT || '3000', 10),
  soundcloud: {
    clientId: process.env.SOUNDCLOUD_CLIENT_ID || '',
    clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET || '',
    redirectUri: process.env.SOUNDCLOUD_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    proxyUrl: process.env.SC_PROXY_URL || '',
    streamProxyUrls: collectStreamProxyUrls(),
    cookies: process.env.SC_COOKIES || '',
  },
  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number.parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME || 'soundcloud',
    password: process.env.DATABASE_PASSWORD || 'soundcloud',
    name: process.env.DATABASE_NAME || 'soundcloud_desktop',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  admin: {
    token: process.env.ADMIN_TOKEN || '',
  },
});
