<p align="center">
  <a href="https://github.com/Teiwazik/SoundCloud-DesktopFork/releases/latest">
    <img src="https://raw.githubusercontent.com/zxcloli666/SoundCloud-Desktop/legacy/icons/appLogo.png" width="170" alt="SoundCloud Desktop Fork" />
  </a>
</p>

<h1 align="center">SoundCloud Desktop Fork</h1>

<p align="center">
  Форк нативного SoundCloud-клиента на Tauri v2 для Windows, Linux и macOS<br/>
  Без рекламы · Без капчи · Улучшенный плеер · Активные релизы
</p>

<p align="center">
  <a href="https://github.com/Teiwazik/SoundCloud-DesktopFork/releases/latest">
    <img src="https://img.shields.io/github/v/release/Teiwazik/SoundCloud-DesktopFork?style=for-the-badge&logo=github&color=FF5500&label=VERSION" alt="Version"/>
  </a>
  <a href="https://github.com/Teiwazik/SoundCloud-DesktopFork/releases">
    <img src="https://img.shields.io/github/downloads/Teiwazik/SoundCloud-DesktopFork/total?style=for-the-badge&logo=download&color=FF5500&label=Downloads" alt="Downloads"/>
  </a>
  <a href="https://github.com/Teiwazik/SoundCloud-DesktopFork/stargazers">
    <img src="https://img.shields.io/github/stars/Teiwazik/SoundCloud-DesktopFork?style=for-the-badge&logo=github&color=FF5500&label=Stars" alt="Stars"/>
  </a>
</p>

<p align="center">
  <a href="https://github.com/Teiwazik/SoundCloud-DesktopFork/releases/latest">
    <img src="https://img.shields.io/badge/Скачать-Последнюю_Версию-FF5500?style=for-the-badge" alt="Download"/>
  </a>
  <a href="https://teiwazik.github.io/soundcloud-desktopfork-site/">
    <img src="https://img.shields.io/badge/Сайт_форка-GitHub_Pages-1f6feb?style=for-the-badge" alt="Fork Site"/>
  </a>
  <a href="https://github.com/zxcloli666/SoundCloud-Desktop">
    <img src="https://img.shields.io/badge/Основной_репозиторий-Upstream-24292f?style=for-the-badge" alt="Upstream"/>
  </a>
</p>

---

## Статистика загрузок

<p align="center">
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/downloads-chart.svg" alt="Downloads chart" width="800"/>
</p>

<p align="center">
  Актуально для <b>7.0.0</b> · <b>4481</b> total downloads · <b>6</b> stars
</p>

---

## Что это

**SoundCloud Desktop Fork** — форк клиента SoundCloud с упором на стабильные релизы, качество воспроизведения и улучшения UX/рекомендаций.

- Нативная оболочка: **Tauri v2 + Rust**
- Интерфейс: **React 19 + Vite + Tailwind**
- Поддержка: **Windows / Linux / macOS**
- Автообновления через GitHub Releases

---

## Ключевые улучшения в этом форке

### Интерфейс и playback UX

- Добавлен отдельный **HQ/LQ badge** в mini player и fullscreen-панелях.
- Улучшены fullscreen-режимы lyrics/artwork и переходы обложек (low-res -> high-res).
- Исправлены конфликтные обновления прогресса и снижено визуальное "дёргание" таймлайна.
- Исправлено поведение громкости при **crossfade** (без резкого скачка на стыках).

### Fullscreen, lyrics, визуал

- Оптимизированы fullscreen-панели (lyrics/artwork) и фоновые эффекты.
- Снижены лишние re-render/DOM-конфликты на прогресс-баре.
- Улучшена плавность отображения прогресса и переключений треков.

### Рекомендации (fork-only)

- Расширена векторизация треков (**Qdrant 96D**).
- Добавлен **hybrid recommend/search/rerank** pipeline.
- Добавлены **региональные тренды** (Apple/Deezer) в пул discovery.
- Поддержан **LLM rerank** (через настраиваемый endpoint/model).

### Импорт и локализация (fork-only)

- Добавлен импорт плейлистов из **Spotify** и **YouTube Music**.
- Добавлена локализация **Ukrainian (`uk`)** в desktop.

### Release/Updater инфраструктура

- Исправлен релизный pipeline для корректной линейки версий **6.x**.
- Ротация ключей подписи updater и обновление release-артефактов.
- Актуальные `latest.json` и `.sig` для стабильной проверки подписи.

### Что исключено из списка улучшений

Чтобы не дублировать upstream, в этом README перечислены только отличия форка, которые отсутствуют в `zxcloli666/SoundCloud-Desktop` на текущем сравнении.

---

## Скачать

Релизы: https://github.com/Teiwazik/SoundCloud-DesktopFork/releases/latest

### Windows
- `*.exe` (рекомендуется)
- `*.msi`

### Linux
- `.deb` (amd64/arm64)
- `.rpm` (x86_64/aarch64)
- `.AppImage` (amd64/aarch64)
- `.flatpak`

### macOS
- `*_x64.dmg` (Intel)
- `*_aarch64.dmg` (Apple Silicon)

---

## Сайт форка

- GitHub Pages: https://teiwazik.github.io/soundcloud-desktopfork-site/
- Репозиторий сайта: https://github.com/Teiwazik/soundcloud-desktopfork-site

---

## Скриншоты

<p align="center">
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/assets/screenshots/home-library.png" width="48%" alt="Главный экран с библиотекой" />
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/assets/screenshots/theme-settings.png" width="48%" alt="Настройки темы" />
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/assets/screenshots/visualizer-settings.png" width="48%" alt="Настройки визуализатора" />
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/assets/screenshots/playback-settings.png" width="48%" alt="Настройки воспроизведения" />
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/assets/screenshots/lyrics-main.png" width="48%" alt="Lyrics экран" />
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/assets/screenshots/lyrics-comments.png" width="48%" alt="Lyrics и комментарии" />
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/assets/screenshots/cover-centered-comments.png" width="48%" alt="Центрированная обложка с комментариями" />
  <img src="https://raw.githubusercontent.com/Teiwazik/SoundCloud-DesktopFork/main/assets/screenshots/discord-activity-text.png" width="48%" alt="Discord Activity text mode" />
</p>

---

## Основной репозиторий (upstream)

Если хотите сверять изменения с оригинальным проектом:

- https://github.com/zxcloli666/SoundCloud-Desktop

---

## Разработка

### Требования

- Node.js 22+
- pnpm 10+
- Rust stable

### Запуск desktop

```bash
git clone https://github.com/Teiwazik/SoundCloud-DesktopFork.git
cd SoundCloud-DesktopFork/desktop
pnpm install
pnpm tauri dev
```

### Проверки

```bash
npx tsc --noEmit
npx biome check src/
cargo check
```

---

## Поддержать разработку

Привет 👋 Я делаю этот форк один, по вечерам и ночам — без рекламы, без подписок и без донатных капканов в самом приложении. Если он тебе зашёл и сэкономил тебе деньги на SoundCloud Go+ или просто сделал прослушку приятнее — я буду рад любой копейке. Это правда помогает: оплатить серверы для бэкенда (Qdrant, прокси, релизные раннеры), купить мак для тестов, и просто не выгореть.

Никаких обязательств, всё по желанию. Спасибо ❤️

> **BTC**
> ```
> bc1qsedzjhahqj27ch799yl78wmwlxmeytgaw4ffwv
> ```
>
> **ETH**
> ```
> 0x880e1bd382d50f7c2b63baccab804f08ad820011
> ```
>
> **USDT (TRC20)**
> ```
> TMdtfqkGAANNYdvTswxSguXBTGmxvLpjWK
> ```
>
> **TRX**
> ```
> TMdtfqkGAANNYdvTswxSguXBTGmxvLpjWK
> ```
>
> **Visa**
> ```
> 4441 1111 4879 8352
> ```

---

## Лицензия

MIT, см. файл `LICENSE`.

SoundCloud — торговая марка SoundCloud Ltd. Проект не аффилирован с SoundCloud.

---

## Теги

`soundcloud` `soundcloud-client` `desktop-app` `tauri` `react` `typescript` `rust` `cross-platform` `music-player` `music-streaming` `fork` `soundcloud-fork` `windows` `linux` `macos` `geo-unblock` `proxy` `ad-blocker`
