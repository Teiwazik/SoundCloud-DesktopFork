use std::io::Cursor;
use std::num::NonZero;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use rustfft::{FftPlanner, num_complex::Complex};
use biquad::{Biquad, Coefficients, DirectForm1, Hertz, ToHertz, Type, Q_BUTTERWORTH_F64};
use rodio::mixer::Mixer;
use rodio::source::SeekError;
use rodio::stream::DeviceSinkBuilder;
use rodio::{Decoder, Player, Source};
use sha2::{Digest, Sha256};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata as SmtcMetadata, MediaPlayback, MediaPosition,
    PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager};

/* ── Constants ─────────────────────────────────────────────── */

const EQ_BANDS: usize = 10;
const EQ_FREQS: [f64; EQ_BANDS] = [
    30.0, 60.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 14000.0,
];
const EQ_Q: f64 = 1.414; // ~1 octave bandwidth for peaking filters
const TICK_INTERVAL_MS: u64 = 100;
const NORMALIZATION_ANALYSIS_SAMPLES: usize = 48_000 * 2 * 30;
const NORMALIZATION_BLOCK_SAMPLES: usize = 48_000;
const NORMALIZATION_TARGET_RMS: f64 = 0.14;
const NORMALIZATION_TARGET_PEAK: f64 = 0.95;
const NORMALIZATION_MAX_BOOST_DB: f64 = 9.0;
const NORMALIZATION_MAX_ATTENUATION_DB: f64 = -8.0;
const NORMALIZATION_CACHE_VERSION: u8 = 2;
const MAX_SEEK_FALLBACK_SOURCE_BYTES: usize = 12 * 1024 * 1024;
const CROSSFADE_HEADROOM: f32 = 0.88;

type ChannelCount = NonZero<u16>;
type SampleRate = NonZero<u32>;

/* ── EQ Parameters (shared between audio thread and commands) ─ */

pub struct EqParams {
    pub enabled: bool,
    pub gains: [f64; EQ_BANDS], // dB, -12 to +12
}

impl Default for EqParams {
    fn default() -> Self {
        Self {
            enabled: false,
            gains: [0.0; EQ_BANDS],
        }
    }
}

/* ── EQ Source wrapper ─────────────────────────────────────── */

struct EqSource<S: Source<Item = f32>> {
    source: S,
    params: Arc<RwLock<EqParams>>,
    filters_l: [DirectForm1<f64>; EQ_BANDS],
    filters_r: [DirectForm1<f64>; EQ_BANDS],
    channels: ChannelCount,
    sample_rate: SampleRate,
    current_channel: u16,
    // Cached gains to detect changes and recompute coefficients
    cached_gains: [f64; EQ_BANDS],
    cached_enabled: bool,
}

impl<S: Source<Item = f32>> EqSource<S> {
    fn new(source: S, params: Arc<RwLock<EqParams>>) -> Self {
        let sample_rate = source.sample_rate();
        let channels = source.channels();
        let fs: Hertz<f64> = (sample_rate.get() as f64).hz();

        let make_filters = || {
            std::array::from_fn(|i| {
                let filter_type = if i == 0 {
                    Type::LowShelf(0.0)
                } else if i == EQ_BANDS - 1 {
                    Type::HighShelf(0.0)
                } else {
                    Type::PeakingEQ(0.0)
                };
                let q = if i == 0 || i == EQ_BANDS - 1 {
                    Q_BUTTERWORTH_F64
                } else {
                    EQ_Q
                };
                let coeffs =
                    Coefficients::<f64>::from_params(filter_type, fs, EQ_FREQS[i].hz(), q)
                        .unwrap();
                DirectForm1::<f64>::new(coeffs)
            })
        };

        Self {
            source,
            params,
            filters_l: make_filters(),
            filters_r: make_filters(),
            channels,
            sample_rate,
            current_channel: 0,
            cached_gains: [0.0; EQ_BANDS],
            cached_enabled: false,
        }
    }

    fn update_coefficients(&mut self, gains: &[f64; EQ_BANDS]) {
        let fs: Hertz<f64> = (self.sample_rate.get() as f64).hz();
        for i in 0..EQ_BANDS {
            if (gains[i] - self.cached_gains[i]).abs() < 0.01 {
                continue;
            }
            let filter_type = if i == 0 {
                Type::LowShelf(gains[i])
            } else if i == EQ_BANDS - 1 {
                Type::HighShelf(gains[i])
            } else {
                Type::PeakingEQ(gains[i])
            };
            let q = if i == 0 || i == EQ_BANDS - 1 {
                Q_BUTTERWORTH_F64
            } else {
                EQ_Q
            };
            if let Ok(coeffs) =
                Coefficients::<f64>::from_params(filter_type, fs, EQ_FREQS[i].hz(), q)
            {
                self.filters_l[i] = DirectForm1::<f64>::new(coeffs);
                self.filters_r[i] = DirectForm1::<f64>::new(coeffs);
            }
        }
        self.cached_gains = *gains;
    }
}

impl<S: Source<Item = f32>> Iterator for EqSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.source.next()?;
        let ch = self.current_channel;
        self.current_channel = (ch + 1) % self.channels.get();

        // Read EQ params (non-blocking — skip if locked)
        let snapshot = self.params.try_read().ok().map(|p| (p.enabled, p.gains));
        if let Some((enabled, gains)) = snapshot {
            if enabled != self.cached_enabled || gains != self.cached_gains {
                if enabled {
                    self.update_coefficients(&gains);
                }
                self.cached_enabled = enabled;
            }
        }

        if !self.cached_enabled {
            return Some(sample);
        }

        let mut out = sample as f64;
        let filters = if ch == 0 {
            &mut self.filters_l
        } else {
            &mut self.filters_r
        };
        for f in filters.iter_mut() {
            out = Biquad::run(f, out);
        }
        Some(out.clamp(-1.0, 1.0) as f32)
    }
}

impl<S: Source<Item = f32>> Source for EqSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

struct GainSource<S: Source<Item = f32>> {
    source: S,
    gain: f32,
}

impl<S: Source<Item = f32>> GainSource<S> {
    fn new(source: S, gain: f32) -> Self {
        Self { source, gain }
    }
}

impl<S: Source<Item = f32>> Iterator for GainSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        self.source
            .next()
            .map(|sample| (sample * self.gain).clamp(-1.0, 1.0))
    }
}

impl<S: Source<Item = f32>> Source for GainSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.source.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

/* ── Visualizer Source ─────────────────────────────────────── */

const FFT_SIZE: usize = 2048;

struct AnalyzerSource<S: Source<Item = f32>> {
    source: S,
    buffer: Vec<f32>,
    sender: std::sync::mpsc::SyncSender<Vec<f32>>,
}

impl<S: Source<Item = f32>> AnalyzerSource<S> {
    fn new(source: S, sender: std::sync::mpsc::SyncSender<Vec<f32>>) -> Self {
        Self {
            source,
            buffer: Vec::with_capacity(FFT_SIZE),
            sender,
        }
    }
}

impl<S: Source<Item = f32>> Iterator for AnalyzerSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.source.next()?;
        self.buffer.push(sample);
        if self.buffer.len() >= FFT_SIZE {
            let _ = self.sender.try_send(std::mem::take(&mut self.buffer));
            self.buffer.reserve(FFT_SIZE);
        }
        Some(sample)
    }
}

impl<S: Source<Item = f32>> Source for AnalyzerSource<S> {
    fn current_span_len(&self) -> Option<usize> { self.source.current_span_len() }
    fn channels(&self) -> ChannelCount { self.source.channels() }
    fn sample_rate(&self) -> SampleRate { self.source.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.source.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> { self.source.try_seek(pos) }
}

/* ── OGG/Opus Source ───────────────────────────────────────── */

struct OpusSource {
    reader: ogg::reading::PacketReader<Cursor<Vec<u8>>>,
    decoder: audiopus::coder::Decoder,
    channels: ChannelCount,
    buffer: Vec<f32>,
    buf_pos: usize,
    serial: u32,
    pre_skip: usize,
    samples_skipped: usize,
}

impl OpusSource {
    fn new(data: Vec<u8>) -> Result<Self, String> {
        let mut reader = ogg::reading::PacketReader::new(Cursor::new(data));

        let head_pkt = reader
            .read_packet()
            .map_err(|e| format!("OGG read error: {}", e))?
            .ok_or("No OpusHead packet")?;

        let head = &head_pkt.data;
        if head.len() < 19 || &head[..8] != b"OpusHead" {
            return Err("Invalid OpusHead".into());
        }

        let serial = head_pkt.stream_serial();
        let ch_count = head[9];
        let pre_skip = u16::from_le_bytes([head[10], head[11]]) as usize;

        let opus_ch = if ch_count == 1 {
            audiopus::Channels::Mono
        } else {
            audiopus::Channels::Stereo
        };

        // Skip OpusTags
        reader
            .read_packet()
            .map_err(|e| format!("OGG read error: {}", e))?;

        let decoder = audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, opus_ch)
            .map_err(|e| format!("Opus decoder error: {:?}", e))?;

        let ch = if ch_count == 1 { 1u16 } else { 2u16 };

        Ok(Self {
            reader,
            decoder,
            channels: NonZero::new(ch).unwrap(),
            buffer: Vec::new(),
            buf_pos: 0,
            serial,
            pre_skip: pre_skip * ch as usize,
            samples_skipped: 0,
        })
    }

    fn decode_next_packet(&mut self) -> bool {
        loop {
            match self.reader.read_packet() {
                Ok(Some(pkt)) => {
                    if pkt.data.is_empty() {
                        continue;
                    }
                    let ch = self.channels.get() as usize;
                    let mut buf = vec![0f32; 5760 * ch];
                    match self
                        .decoder
                        .decode_float(Some(&pkt.data), &mut buf, false)
                    {
                        Ok(samples_per_ch) => {
                            let total = samples_per_ch * ch;
                            buf.truncate(total);

                            if self.samples_skipped < self.pre_skip {
                                let skip = (self.pre_skip - self.samples_skipped).min(total);
                                self.samples_skipped += skip;
                                if skip >= total {
                                    continue;
                                }
                                self.buffer = buf[skip..].to_vec();
                            } else {
                                self.buffer = buf;
                            }
                            self.buf_pos = 0;
                            return true;
                        }
                        Err(_) => continue,
                    }
                }
                _ => return false,
            }
        }
    }
}

impl Iterator for OpusSource {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.buf_pos >= self.buffer.len() {
            if !self.decode_next_packet() {
                return None;
            }
        }
        let sample = self.buffer[self.buf_pos];
        self.buf_pos += 1;
        Some(sample)
    }
}

impl Source for OpusSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        NonZero::new(48000).unwrap()
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let target_gp = (pos.as_secs_f64() * 48000.0) as u64;

        match self.reader.seek_absgp(Some(self.serial), target_gp) {
            Ok(_) => {
                let opus_ch = if self.channels.get() == 1 {
                    audiopus::Channels::Mono
                } else {
                    audiopus::Channels::Stereo
                };
                self.decoder =
                    audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, opus_ch)
                        .map_err(|_| SeekError::NotSupported {
                            underlying_source: "opus decoder reinit failed",
                        })?;
                self.buffer.clear();
                self.buf_pos = 0;
                self.samples_skipped = self.pre_skip;
                Ok(())
            }
            Err(_) => Err(SeekError::NotSupported {
                underlying_source: "ogg seek failed",
            }),
        }
    }
}

/* ── Decode helper ─────────────────────────────────────────── */

fn normalization_cache_file(cache_dir: &Path, cache_key: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(cache_key.as_bytes());
    let hash = hex::encode(hasher.finalize());
    cache_dir.join(format!("{hash}.gain"))
}

fn read_cached_normalization_gain(cache_dir: Option<&Path>, cache_key: Option<&str>) -> Option<f32> {
    let path = normalization_cache_file(cache_dir?, cache_key?);
    let raw = std::fs::read_to_string(path).ok()?;
    let (version, value) = raw.trim().split_once(':')?;
    if version != NORMALIZATION_CACHE_VERSION.to_string() {
        return None;
    }
    value.parse::<f32>().ok()
}

fn write_cached_normalization_gain(cache_dir: Option<&Path>, cache_key: Option<&str>, gain: f32) {
    let Some(cache_dir) = cache_dir else { return; };
    let Some(cache_key) = cache_key else { return; };

    if std::fs::create_dir_all(cache_dir).is_err() {
        return;
    }

    let path = normalization_cache_file(cache_dir, cache_key);
    let _ = std::fs::write(path, format!("{NORMALIZATION_CACHE_VERSION}:{gain:.6}"));
}

fn normalization_gain_from_samples<I>(samples: I) -> f32
where
    I: IntoIterator<Item = f32>,
{
    let mut peak = 0.0f64;
    let mut count = 0usize;
    let mut block_sum_sq = 0.0f64;
    let mut block_count = 0usize;
    let mut block_powers = Vec::new();

    for sample in samples.into_iter().take(NORMALIZATION_ANALYSIS_SAMPLES) {
        let value = sample as f64;
        let abs = value.abs();
        peak = peak.max(abs);
        block_sum_sq += value * value;
        block_count += 1;
        count += 1;

        if block_count >= NORMALIZATION_BLOCK_SAMPLES {
            block_powers.push(block_sum_sq / block_count as f64);
            block_sum_sq = 0.0;
            block_count = 0;
        }
    }

    if block_count > 0 {
        block_powers.push(block_sum_sq / block_count as f64);
    }

    if count == 0 || block_powers.is_empty() {
        return 1.0;
    }

    block_powers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let keep_from = ((block_powers.len() as f64) * 0.4).floor() as usize;
    let kept = &block_powers[keep_from.min(block_powers.len().saturating_sub(1))..];
    let gated_power = kept.iter().copied().sum::<f64>() / kept.len() as f64;
    let rms = gated_power.sqrt().max(1e-6);
    let target_gain = NORMALIZATION_TARGET_RMS / rms;
    let peak_safe_gain = if peak > 0.0 {
        NORMALIZATION_TARGET_PEAK / peak
    } else {
        target_gain
    };

    let max_boost = 10f64.powf(NORMALIZATION_MAX_BOOST_DB / 20.0);
    let max_attenuation = 10f64.powf(NORMALIZATION_MAX_ATTENUATION_DB / 20.0);
    let gain = target_gain
        .min(peak_safe_gain)
        .clamp(max_attenuation, max_boost);

    if (gain - 1.0).abs() < 0.05 {
        1.0
    } else {
        gain as f32
    }
}

fn resolve_normalization_gain(
    bytes: &[u8],
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
) -> Result<f32, String> {
    if let Some(gain) = read_cached_normalization_gain(cache_dir, cache_key) {
        return Ok(gain);
    }

    let gain = if let Ok(source) = Decoder::new(Cursor::new(bytes.to_vec())) {
        normalization_gain_from_samples(source)
    } else {
        normalization_gain_from_samples(
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?,
        )
    };

    write_cached_normalization_gain(cache_dir, cache_key, gain);
    Ok(gain)
}

fn create_player_from_bytes(
    bytes: &[u8],
    mixer: &Mixer,
    volume: f32,
    normalization_gain: f32,
    eq_params: Arc<RwLock<EqParams>>,
    vis_tx: Option<std::sync::mpsc::SyncSender<Vec<f32>>>,
) -> Result<(Player, Option<f64>), String> {
    let player = Player::connect_new(mixer);
    player.set_volume(volume.clamp(0.0, 2.0));

    let duration;
    if let Ok(source) = Decoder::new(Cursor::new(bytes.to_vec())) {
        duration = source.total_duration().map(|d| d.as_secs_f64());
        let gain_source = GainSource::new(source, normalization_gain);
        let eq_source = EqSource::new(gain_source, eq_params);
        if let Some(ref tx) = vis_tx {
            player.append(AnalyzerSource::new(eq_source, tx.clone()));
        } else {
            player.append(eq_source);
        }
    } else {
        let source = OpusSource::new(bytes.to_vec())
            .map_err(|e| format!("Failed to decode: {}", e))?;
        duration = source.total_duration().map(|d| d.as_secs_f64());
        let gain_source = GainSource::new(source, normalization_gain);
        let eq_source = EqSource::new(gain_source, eq_params);
        if let Some(ref tx) = vis_tx {
            player.append(AnalyzerSource::new(eq_source, tx.clone()));
        } else {
            player.append(eq_source);
        }
    }

    Ok((player, duration))
}

/* ── Audio State (managed by Tauri) ────────────────────────── */

/// Messages sent to the media controls thread
enum MediaCmd {
    SetMetadata {
        title: String,
        artist: String,
        cover_url: Option<String>,
        duration_secs: f64,
    },
    SetPlaying(bool),
    SetPosition(f64),
}

/// Command sent to the audio output thread (which owns MixerDeviceSink)
enum AudioThreadCmd {
    SwitchDevice {
        name: Option<String>,
        reply: std::sync::mpsc::Sender<Result<Mixer, String>>,
    },
    /// Auto-reconnect when the audio device is invalidated (e.g. BT profile switch)
    Reconnect,
}

pub struct AudioState {
    player: Mutex<Option<Arc<Player>>>,
    crossfade_player: Mutex<Option<Arc<Player>>>,
    mixer: Arc<Mutex<Mixer>>,
    eq_params: Arc<RwLock<EqParams>>,
    normalization_enabled: AtomicBool,
    normalization_gain: Mutex<f32>,
    volume: Mutex<f32>, // 0.0 - 2.0
    has_track: AtomicBool,
    ended_notified: AtomicBool,
    /// Set by error callback when stream breaks, cleared after reconnect completes
    device_error: Arc<AtomicBool>,
    /// Set by audio thread on device reconnect (e.g. BT profile switch), cleared by tick emitter
    device_reconnected: Arc<AtomicBool>,
    load_gen: AtomicU64,
    media_tx: Mutex<Option<std::sync::mpsc::Sender<MediaCmd>>>,
    audio_tx: std::sync::mpsc::Sender<AudioThreadCmd>,
    /// Saved source bytes for seek fallback (reload + seek forward)
    source_bytes: Mutex<Option<Vec<u8>>>,
    seek_in_progress: AtomicBool,
    pub visualizer_tx: Mutex<Option<std::sync::mpsc::SyncSender<Vec<f32>>>>,
}

fn open_device_sink(
    device_id: Option<&str>,
    reconnect_tx: &std::sync::mpsc::Sender<AudioThreadCmd>,
    error_flag: &Arc<AtomicBool>,
) -> Result<rodio::stream::MixerDeviceSink, String> {
    use cpal::traits::{DeviceTrait, HostTrait};

    // Error callback: on stream error (e.g. BT profile switch → AUDCLNT_E_DEVICE_INVALIDATED),
    // signal audio thread to reconnect. AtomicBool prevents spamming.
    let sent = Arc::new(AtomicBool::new(false));
    let sent_clone = sent.clone();
    let tx = reconnect_tx.clone();
    let err_flag = error_flag.clone();
    let error_cb = move |err: cpal::StreamError| {
        eprintln!("[audio] stream error: {err}");
        err_flag.store(true, Ordering::Relaxed);
        if !sent_clone.swap(true, Ordering::Relaxed) {
            tx.send(AudioThreadCmd::Reconnect).ok();
        }
    };

    if let Some(id) = device_id {
        let host = cpal::default_host();
        if let Ok(devices) = host.output_devices() {
            for dev in devices {
                if dev.id().ok().map(|d| d.to_string()).as_deref() == Some(id) {
                    let mut sink = DeviceSinkBuilder::from_device(dev)
                        .map_err(|e| format!("Failed to open device '{}': {}", id, e))?
                        .with_error_callback(error_cb)
                        .open_stream()
                        .map_err(|e| format!("Failed to open device '{}': {}", id, e))?;
                    sink.log_on_drop(false);
                    return Ok(sink);
                }
            }
        }
        return Err(format!("Device '{}' not found", id));
    }

    let mut sink = DeviceSinkBuilder::from_default_device()
        .map_err(|e| format!("No audio output: {}", e))?
        .with_error_callback(error_cb)
        .open_stream()
        .map_err(|e| format!("No audio output: {}", e))?;
    sink.log_on_drop(false);
    Ok(sink)
}

pub fn init() -> AudioState {
    // Spawn audio output on a dedicated thread (MixerDeviceSink may be !Send on some platforms)
    let (mixer_tx, mixer_rx) = std::sync::mpsc::channel::<Arc<Mutex<Mixer>>>();
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<AudioThreadCmd>();
    let device_error_flag = Arc::new(AtomicBool::new(false));
    let reconnected_flag = Arc::new(AtomicBool::new(false));

    let cmd_tx_for_thread = cmd_tx.clone();
    let reconnected_for_thread = reconnected_flag.clone();
    let error_flag_for_thread = device_error_flag.clone();
    std::thread::Builder::new()
        .name("audio-output".into())
        .spawn(move || {
            let cmd_tx = cmd_tx_for_thread;
            let reconnected = reconnected_for_thread;
            let error_flag = error_flag_for_thread;
            let mut device_sink =
                open_device_sink(None, &cmd_tx, &error_flag).expect("no audio output device");
            let shared_mixer = Arc::new(Mutex::new(device_sink.mixer().clone()));
            mixer_tx.send(shared_mixer.clone()).ok();

            loop {
                match cmd_rx.recv() {
                    Ok(AudioThreadCmd::SwitchDevice { name, reply }) => {
                        // Drop old sink first
                        drop(device_sink);

                        match open_device_sink(name.as_deref(), &cmd_tx, &error_flag) {
                            Ok(new_sink) => {
                                let mixer = new_sink.mixer().clone();
                                *shared_mixer.lock().unwrap() = mixer.clone();
                                device_sink = new_sink;
                                reply.send(Ok(mixer)).ok();
                            }
                            Err(e) => {
                                // Fallback to default
                                device_sink =
                                    open_device_sink(None, &cmd_tx, &error_flag).expect("no audio output device");
                                *shared_mixer.lock().unwrap() = device_sink.mixer().clone();
                                reply.send(Err(e)).ok();
                            }
                        }
                    }
                    Ok(AudioThreadCmd::Reconnect) => {
                        eprintln!("[audio] device invalidated, reconnecting...");
                        // Small delay to let the OS settle after BT profile switch
                        std::thread::sleep(Duration::from_millis(500));

                        drop(device_sink);
                        match open_device_sink(None, &cmd_tx, &error_flag) {
                            Ok(new_sink) => {
                                *shared_mixer.lock().unwrap() = new_sink.mixer().clone();
                                device_sink = new_sink;
                                reconnected.store(true, Ordering::Relaxed);
                                eprintln!("[audio] reconnected successfully");
                            }
                            Err(e) => {
                                eprintln!("[audio] reconnect failed: {e}, retrying...");
                                std::thread::sleep(Duration::from_secs(1));
                                device_sink =
                                    open_device_sink(None, &cmd_tx, &error_flag).expect("no audio output device");
                                *shared_mixer.lock().unwrap() = device_sink.mixer().clone();
                                reconnected.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .expect("failed to spawn audio thread");

    let shared_mixer = mixer_rx.recv().expect("audio thread failed to init");

    AudioState {
        player: Mutex::new(None),
        crossfade_player: Mutex::new(None),
        mixer: shared_mixer,
        eq_params: Arc::new(RwLock::new(EqParams::default())),
        normalization_enabled: AtomicBool::new(true),
        normalization_gain: Mutex::new(1.0),
        volume: Mutex::new(0.25), // 50/200
        has_track: AtomicBool::new(false),
        ended_notified: AtomicBool::new(false),
        device_error: device_error_flag,
        device_reconnected: reconnected_flag,
        load_gen: AtomicU64::new(0),
        media_tx: Mutex::new(None),
        audio_tx: cmd_tx,
        source_bytes: Mutex::new(None),
        seek_in_progress: AtomicBool::new(false),
        visualizer_tx: Mutex::new(None),
    }
}

/// Start background thread that emits position ticks and track-end events
pub fn start_tick_emitter(app: &AppHandle) {
    let handle = app.clone();
    std::thread::Builder::new()
        .name("audio-tick".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(TICK_INTERVAL_MS));
            let state = handle.state::<AudioState>();

            // Check if audio device was reconnected (e.g. BT profile switch)
            if state.device_reconnected.swap(false, Ordering::Relaxed) {
                handle.emit("audio:device-reconnected", ()).ok();
            }

            if !state.has_track.load(Ordering::Relaxed) {
                continue;
            }

            let player = state.player.lock().unwrap();
            if let Some(ref p) = *player {
                if p.empty() {
                    if state.seek_in_progress.load(Ordering::Relaxed) {
                        continue;
                    }
                    // Suppress track-end during device error (BT profile switch etc.)
                    if !state.device_error.load(Ordering::Relaxed)
                        && !state.ended_notified.swap(true, Ordering::Relaxed)
                    {
                        handle.emit("audio:ended", ()).ok();
                    }
                } else {
                    let pos = p.get_pos().as_secs_f64();
                    handle.emit("audio:tick", pos).ok();
                }
            }
        })
        .expect("failed to spawn tick thread");
}

/// Start media controls (MPRIS on Linux, SMTC on Windows) on a dedicated thread
pub fn start_media_controls(app: &AppHandle) {
    let handle = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<MediaCmd>();

    // Store sender in AudioState
    let state = app.state::<AudioState>();
    *state.media_tx.lock().unwrap() = Some(tx);

    std::thread::Builder::new()
        .name("media-controls".into())
        .spawn(move || {
            #[cfg(not(target_os = "windows"))]
            let hwnd = None;

            #[cfg(target_os = "windows")]
            let hwnd = {
                use tauri::Manager;
                handle
                    .get_webview_window("main")
                    .and_then(|w| {
                        use raw_window_handle::HasWindowHandle;
                        w.window_handle().ok().and_then(|wh| match wh.as_raw() {
                            raw_window_handle::RawWindowHandle::Win32(h) => {
                                Some(h.hwnd.get() as *mut std::ffi::c_void)
                            }
                            _ => None,
                        })
                    })
            };

            let config = PlatformConfig {
                display_name: "SoundCloud Desktop",
                dbus_name: "soundcloud_desktop",
                hwnd,
            };

            let mut controls = match MediaControls::new(config) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[MediaControls] Failed to create: {:?}", e);
                    return;
                }
            };

            let event_handle = handle.clone();
            controls
                .attach(move |event: MediaControlEvent| {
                    match event {
                        MediaControlEvent::Play => {
                            event_handle.emit("media:play", ()).ok();
                        }
                        MediaControlEvent::Pause => {
                            event_handle.emit("media:pause", ()).ok();
                        }
                        MediaControlEvent::Toggle => {
                            event_handle.emit("media:toggle", ()).ok();
                        }
                        MediaControlEvent::Next => {
                            event_handle.emit("media:next", ()).ok();
                        }
                        MediaControlEvent::Previous => {
                            event_handle.emit("media:prev", ()).ok();
                        }
                        MediaControlEvent::SetPosition(MediaPosition(pos)) => {
                            event_handle.emit("media:seek", pos.as_secs_f64()).ok();
                        }
                        MediaControlEvent::Seek(dir) => {
                            let offset = match dir {
                                souvlaki::SeekDirection::Forward => 10.0,
                                souvlaki::SeekDirection::Backward => -10.0,
                            };
                            event_handle.emit("media:seek-relative", offset).ok();
                        }
                        _ => {}
                    }
                })
                .ok();

            // Process commands from main thread
            loop {
                match rx.recv() {
                    Ok(MediaCmd::SetMetadata {
                        title,
                        artist,
                        cover_url,
                        duration_secs,
                    }) => {
                        controls
                            .set_metadata(SmtcMetadata {
                                title: Some(&title),
                                artist: Some(&artist),
                                cover_url: cover_url.as_deref(),
                                duration: if duration_secs > 0.0 {
                                    Some(Duration::from_secs_f64(duration_secs))
                                } else {
                                    None
                                },
                                ..Default::default()
                            })
                            .ok();
                    }
                    Ok(MediaCmd::SetPlaying(playing)) => {
                        let state = handle.state::<AudioState>();
                        let pos = state
                            .player
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|p| p.get_pos())
                            .unwrap_or_default();
                        let progress = Some(MediaPosition(pos));
                        let playback = if playing {
                            MediaPlayback::Playing { progress }
                        } else {
                            MediaPlayback::Paused { progress }
                        };
                        controls.set_playback(playback).ok();
                    }
                    Ok(MediaCmd::SetPosition(secs)) => {
                        // Just update position without changing play state
                        let state = handle.state::<AudioState>();
                        let is_playing = state
                            .player
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|p| !p.is_paused() && !p.empty())
                            .unwrap_or(false);
                        let progress = Some(MediaPosition(Duration::from_secs_f64(secs)));
                        let playback = if is_playing {
                            MediaPlayback::Playing { progress }
                        } else {
                            MediaPlayback::Paused { progress }
                        };
                        controls.set_playback(playback).ok();
                    }
                    Err(_) => break, // Channel closed
                }
            }
        })
        .expect("failed to spawn media-controls thread");
}

/* ── Tauri Commands ────────────────────────────────────────── */

fn volume_to_rodio(v: f64) -> f32 {
    // Frontend: 0-200, where 100 = normal. rodio: 0.0 = silent, 1.0 = normal
    (v / 100.0).min(2.0).max(0.0) as f32
}

fn effective_output_volume(_state: &AudioState, base_volume: f32) -> f32 {
    base_volume.clamp(0.0, 2.0)
}

fn store_seek_fallback_bytes(state: &AudioState, bytes: Vec<u8>) {
    if bytes.len() <= MAX_SEEK_FALLBACK_SOURCE_BYTES {
        *state.source_bytes.lock().unwrap() = Some(bytes);
    } else {
        *state.source_bytes.lock().unwrap() = None;
    }
}

/// Load and play audio from a file path
#[tauri::command]
pub fn audio_load_file(
    path: String,
    cache_key: Option<String>,
    crossfade_secs: Option<f64>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioState>,
) -> Result<AudioLoadResult, String> {
    let bytes =
        std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;

    let mixer = state.mixer.lock().unwrap().clone();
    let vol = *state.volume.lock().unwrap();
    let normalization_cache_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join("audio-normalization"));
    let normalization_gain = if state.normalization_enabled.load(Ordering::Relaxed) {
        resolve_normalization_gain(
            &bytes,
            normalization_cache_dir.as_deref(),
            cache_key.as_deref(),
        )?
    } else {
        1.0
    };
    let (new_player, duration_secs) = create_player_from_bytes(
        &bytes,
        &mixer,
        vol,
        normalization_gain,
        state.eq_params.clone(),
        state.visualizer_tx.lock().unwrap().clone(),
    )?;
    let new_player = Arc::new(new_player);
    *state.normalization_gain.lock().unwrap() = normalization_gain;

    let mut old_player_opt = None;
    {
        let mut player = state.player.lock().unwrap();
        if let Some(old) = player.take() {
            old_player_opt = Some(old);
        }
    }

    let effective_vol = effective_output_volume(&state, vol);
    if let Some(cf_duration) = crossfade_secs {
        if let Some(old_player) = old_player_opt {
            if !old_player.is_paused() && !old_player.empty() {
                // We have a fading-out track. Move it to crossfade_player
                let mut cf_lock = state.crossfade_player.lock().unwrap();
                if let Some(old_cf) = cf_lock.take() {
                    old_cf.stop();
                }
                
                new_player.set_volume(0.0);
                *cf_lock = Some(old_player.clone());
                
                let cf_player = old_player.clone();
                let np_player = new_player.clone();
                let steps = (cf_duration * 1000.0 / 20.0) as u32;
                if steps > 0 {
                    std::thread::spawn(move || {
                        let target = (effective_vol * CROSSFADE_HEADROOM).clamp(0.0, 2.0);
                        for i in 0..=steps {
                            let t = (i as f32) / (steps as f32);
                            let np_v = (t * t * target).clamp(0.0, 2.0);
                            let cf_v = ((1.0 - t * t) * target).clamp(0.0, 2.0);
                            np_player.set_volume(np_v);
                            cf_player.set_volume(cf_v);
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        cf_player.stop();
                    });
                } else {
                    new_player.set_volume(effective_vol.clamp(0.0, 2.0));
                    old_player.stop();
                }
            } else {
                old_player.stop();
            }
        }
    } else {
        if let Some(old) = old_player_opt {
            old.stop();
        }
    }

    *state.player.lock().unwrap() = Some(new_player);
    store_seek_fallback_bytes(&state, bytes);
    state.has_track.store(true, Ordering::Relaxed);
    state.ended_notified.store(false, Ordering::Relaxed);
    state.device_error.store(false, Ordering::Relaxed);

    Ok(AudioLoadResult {
        duration_secs,
        stream_quality: None,
        stream_content_type: None,
    })
}

#[derive(serde::Serialize)]
pub struct AudioLoadResult {
    pub duration_secs: Option<f64>,
    pub stream_quality: Option<String>,
    pub stream_content_type: Option<String>,
}

/// Load and play audio from a URL (downloads fully, optionally caches).
#[tauri::command]
pub async fn audio_load_url(
    url: String,
    session_id: Option<String>,
    cache_path: Option<String>,
    cache_key: Option<String>,
    crossfade_secs: Option<f64>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioState>,
) -> Result<AudioLoadResult, String> {
    let gen = state.load_gen.load(Ordering::Relaxed);

    // Download
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(sid) = &session_id {
        req = req.header("x-session-id", sid);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let stream_quality = resp
        .headers()
        .get("x-stream-quality")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase())
        .filter(|v| v == "hq" || v == "lq");
    let stream_content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase());
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();

    let empty_result = AudioLoadResult {
        duration_secs: None,
        stream_quality: None,
        stream_content_type: None,
    };

    // Stale check after download — another track may have started loading
    if state.load_gen.load(Ordering::Relaxed) != gen {
        return Ok(empty_result);
    }

    // Cache in background
    if let Some(path) = cache_path {
        let data = bytes.clone();
        tokio::spawn(async move {
            tokio::fs::write(&path, &data).await.ok();
        });
    }

    // Decode and play
    let mixer = state.mixer.lock().unwrap().clone();
    let vol = *state.volume.lock().unwrap();
    let normalization_cache_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join("audio-normalization"));
    let normalization_gain = if state.normalization_enabled.load(Ordering::Relaxed) {
        resolve_normalization_gain(
            &bytes,
            normalization_cache_dir.as_deref(),
            cache_key.as_deref(),
        )?
    } else {
        1.0
    };
    let (new_player, duration_secs) = create_player_from_bytes(
        &bytes,
        &mixer,
        vol,
        normalization_gain,
        state.eq_params.clone(),
        state.visualizer_tx.lock().unwrap().clone(),
    )?;
    let new_player = Arc::new(new_player);
    *state.normalization_gain.lock().unwrap() = normalization_gain;

    let mut old_player_opt = None;
    {
        let mut player = state.player.lock().unwrap();
        if let Some(old) = player.take() {
            old_player_opt = Some(old);
        }
    }

    let effective_vol = effective_output_volume(&state, vol);
    if let Some(cf_duration) = crossfade_secs {
        if let Some(old_player) = old_player_opt {
            if !old_player.is_paused() && !old_player.empty() {
                // We have a fading-out track. Move it to crossfade_player
                let mut cf_lock = state.crossfade_player.lock().unwrap();
                if let Some(old_cf) = cf_lock.take() {
                    old_cf.stop();
                }
                
                new_player.set_volume(0.0);
                *cf_lock = Some(old_player.clone());
                
                let cf_player = old_player.clone();
                let np_player = new_player.clone();
                let steps = (cf_duration * 1000.0 / 20.0) as u32;
                if steps > 0 {
                    std::thread::spawn(move || {
                        let target = (effective_vol * CROSSFADE_HEADROOM).clamp(0.0, 2.0);
                        for i in 0..=steps {
                            let t = (i as f32) / (steps as f32);
                            let np_v = (t * t * target).clamp(0.0, 2.0);
                            let cf_v = ((1.0 - t * t) * target).clamp(0.0, 2.0);
                            np_player.set_volume(np_v);
                            cf_player.set_volume(cf_v);
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        cf_player.stop();
                    });
                } else {
                    new_player.set_volume(effective_vol.clamp(0.0, 2.0));
                    old_player.stop();
                }
            } else {
                old_player.stop();
            }
        }
    } else {
        if let Some(old) = old_player_opt {
            old.stop();
        }
    }

    // Stale check again after processing stops
    if state.load_gen.load(Ordering::Relaxed) != gen {
        return Ok(empty_result);
    }

    *state.player.lock().unwrap() = Some(new_player);
    store_seek_fallback_bytes(&state, bytes);
    state.has_track.store(true, Ordering::Relaxed);
    state.ended_notified.store(false, Ordering::Relaxed);
    state.device_error.store(false, Ordering::Relaxed);

    Ok(AudioLoadResult {
        duration_secs,
        stream_quality,
        stream_content_type,
    })
}

#[tauri::command]
pub fn audio_play(state: tauri::State<'_, AudioState>) {
    if let Ok(player) = state.player.try_lock() {
        if let Some(ref p) = *player {
            p.play();
        }
    }
}

#[tauri::command]
pub fn audio_pause(state: tauri::State<'_, AudioState>) {
    if let Ok(player) = state.player.try_lock() {
        if let Some(ref p) = *player {
            p.pause();
        }
    }
}

#[tauri::command]
pub fn audio_stop(state: tauri::State<'_, AudioState>) {
    // Use try_lock to avoid blocking IPC if another thread holds the lock (e.g. stuck stop())
    state.has_track.store(false, Ordering::Relaxed);
    state.load_gen.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut player) = state.player.try_lock() {
        if let Some(old) = player.take() {
            old.stop();
        }
    }
    if let Ok(mut cf_player) = state.crossfade_player.try_lock() {
        if let Some(old_cf) = cf_player.take() {
            old_cf.stop();
        }
    }
    if let Ok(mut bytes) = state.source_bytes.try_lock() {
        *bytes = None;
    }
}

#[tauri::command]
pub fn audio_seek(position: f64, state: tauri::State<'_, AudioState>) -> Result<(), String> {
    struct SeekInProgressGuard<'a> {
        state: &'a AudioState,
    }

    impl Drop for SeekInProgressGuard<'_> {
        fn drop(&mut self) {
            self.state.seek_in_progress.store(false, Ordering::Relaxed);
        }
    }

    state.seek_in_progress.store(true, Ordering::Relaxed);
    let _seek_guard = SeekInProgressGuard { state: &state };
    state.ended_notified.store(true, Ordering::Relaxed);

    let target = Duration::from_secs_f64(position);

    // Try normal seek first
    {
        let player = state.player.lock().unwrap();
        if let Some(ref p) = *player {
            if p.try_seek(target).is_ok() {
                state.ended_notified.store(false, Ordering::Relaxed);
                state.has_track.store(true, Ordering::Relaxed);
                state.device_error.store(false, Ordering::Relaxed);
                return Ok(());
            }
        }
    }

    // Fallback: reload from saved source bytes and seek forward
    let bytes = state.source_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes else {
        return Err("No source to reload for seek".into());
    };

    let mixer = state.mixer.lock().unwrap().clone();
    let vol = *state.volume.lock().unwrap();
    let normalization_gain = if state.normalization_enabled.load(Ordering::Relaxed) {
        *state.normalization_gain.lock().unwrap()
    } else {
        1.0
    };
    let (new_player, _) = create_player_from_bytes(
        &bytes,
        &mixer,
        vol,
        normalization_gain,
        state.eq_params.clone(),
        state.visualizer_tx.lock().unwrap().clone(),
    )?;

    if position > 0.0 {
        new_player.try_seek(target).ok();
    }

    let was_paused = state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.is_paused())
        .unwrap_or(false);

    let mut player = state.player.lock().unwrap();
    if let Some(old) = player.take() {
        old.stop();
    }
    let mut cf_player = state.crossfade_player.lock().unwrap();
    if let Some(old_cf) = cf_player.take() {
        old_cf.stop();
    }
    *player = Some(Arc::new(new_player));
    state.ended_notified.store(false, Ordering::Relaxed);
    state.has_track.store(true, Ordering::Relaxed);
    state.device_error.store(false, Ordering::Relaxed);

    if was_paused {
        if let Some(ref p) = *player {
            p.pause();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn audio_set_volume(volume: f64, state: tauri::State<'_, AudioState>) {
    let vol = volume_to_rodio(volume);
    *state.volume.lock().unwrap() = vol;
    if let Some(ref p) = *state.player.lock().unwrap() {
        p.set_volume(effective_output_volume(&state, vol));
    }
}

#[tauri::command]
pub fn audio_get_position(state: tauri::State<'_, AudioState>) -> f64 {
    state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.get_pos().as_secs_f64())
        .unwrap_or(0.0)
}

#[tauri::command]
pub fn audio_set_eq(enabled: bool, gains: Vec<f64>, state: tauri::State<'_, AudioState>) {
    if let Ok(mut params) = state.eq_params.write() {
        params.enabled = enabled;
        for (i, &g) in gains.iter().enumerate().take(EQ_BANDS) {
            params.gains[i] = g.clamp(-12.0, 12.0);
        }
    }
}

#[tauri::command]
pub fn audio_set_normalization(enabled: bool, state: tauri::State<'_, AudioState>) {
    state.normalization_enabled.store(enabled, Ordering::Relaxed);
    let vol = *state.volume.lock().unwrap();
    if let Some(ref p) = *state.player.lock().unwrap() {
        p.set_volume(effective_output_volume(&state, vol));
    }
}

#[tauri::command]
pub fn audio_is_playing(state: tauri::State<'_, AudioState>) -> bool {
    state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| !p.is_paused() && !p.empty())
        .unwrap_or(false)
}

#[tauri::command]
pub fn audio_set_metadata(
    title: String,
    artist: String,
    cover_url: Option<String>,
    duration_secs: f64,
    state: tauri::State<'_, AudioState>,
) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetMetadata {
            title,
            artist,
            cover_url,
            duration_secs,
        })
        .ok();
    }
}

#[tauri::command]
pub fn audio_set_playback_state(playing: bool, state: tauri::State<'_, AudioState>) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetPlaying(playing)).ok();
    }
}

#[tauri::command]
pub fn audio_set_media_position(position: f64, state: tauri::State<'_, AudioState>) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetPosition(position)).ok();
    }
}

/* ── Audio Device Management ──────────────────────────────── */

/// Audio sink info from PulseAudio/PipeWire
#[derive(serde::Serialize, Clone)]
pub struct AudioSink {
    pub name: String,        // internal name for pactl
    pub description: String, // human-readable
    pub is_default: bool,
}

#[tauri::command]
pub fn audio_list_devices() -> Vec<AudioSink> {
    #[cfg(target_os = "linux")]
    {
        audio_list_devices_pactl()
    }
    #[cfg(not(target_os = "linux"))]
    {
        audio_list_devices_cpal()
    }
}

/// Linux: pactl returns clean PipeWire/PulseAudio sinks (no ALSA plugin spam)
#[cfg(target_os = "linux")]
fn audio_list_devices_pactl() -> Vec<AudioSink> {
    let output = match std::process::Command::new("pactl")
        .args(["--format=json", "list", "sinks"])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };

    let default_sink = std::process::Command::new("pactl")
        .args(["get-default-sink"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let sinks: Vec<serde_json::Value> = match serde_json::from_slice(&output) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    sinks
        .iter()
        .filter_map(|s| {
            let name = s.get("name")?.as_str()?.to_string();
            let description = s.get("description")?.as_str()?.to_string();
            Some(AudioSink {
                is_default: name == default_sink,
                name,
                description,
            })
        })
        .collect()
}

/// Windows/macOS: cpal returns clean device list
#[cfg(not(target_os = "linux"))]
fn audio_list_devices_cpal() -> Vec<AudioSink> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let default_id = host
        .default_output_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());

    let devices = match host.output_devices() {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };

    devices
        .filter_map(|dev| {
            let id = dev.id().ok()?.to_string();
            let description = dev
                .description()
                .ok()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|| id.clone());
            Some(AudioSink {
                is_default: default_id.as_deref() == Some(id.as_str()),
                name: id,
                description,
            })
        })
        .collect()
}

#[tauri::command]
pub fn audio_switch_device(
    device_name: Option<String>,
    state: tauri::State<'_, AudioState>,
) -> Result<(), String> {
    // On Linux, set PipeWire/PulseAudio default sink first, then reopen default cpal device.
    // On other platforms, open the cpal device directly by id.
    #[cfg(target_os = "linux")]
    let switch_name: Option<String> = {
        if let Some(ref name) = device_name {
            std::process::Command::new("pactl")
                .args(["set-default-sink", name])
                .status()
                .map_err(|e| format!("pactl failed: {}", e))?;
        }
        None // always reopen default — pactl already switched it
    };
    #[cfg(not(target_os = "linux"))]
    let switch_name: Option<String> = device_name;

    // Stop current playback
    {
        let mut player = state.player.lock().unwrap();
        if let Some(old) = player.take() {
            old.stop();
        }
        state.has_track.store(false, Ordering::Relaxed);
        state.load_gen.fetch_add(1, Ordering::Relaxed);
    }

    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state
        .audio_tx
        .send(AudioThreadCmd::SwitchDevice {
            name: switch_name,
            reply: reply_tx,
        })
        .map_err(|e| e.to_string())?;

    let new_mixer = reply_rx
        .recv()
        .map_err(|e| format!("Device switch failed: {}", e))?
        .map_err(|e| e)?;

    *state.mixer.lock().unwrap() = new_mixer;
    Ok(())
}

/* ── Track Download ───────────────────────────────────────── */

#[tauri::command]
pub async fn save_track_to_path(
    cache_path: String,
    dest_path: String,
) -> Result<String, String> {
    tokio::fs::copy(&cache_path, &dest_path)
        .await
        .map_err(|e| format!("Copy failed: {}", e))?;
    Ok(dest_path)
}

/* ── Visualizer Thread ────────────────────────────────────── */

pub fn start_visualizer_thread(app: &AppHandle) {
    let handle = app.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(2);

    let state = app.state::<AudioState>();
    *state.visualizer_tx.lock().unwrap() = Some(tx);

    std::thread::Builder::new()
        .name("audio-visualizer".into())
        .spawn(move || {
            let mut planner = FftPlanner::new();
            let fft = planner.plan_fft_forward(FFT_SIZE);
            let mut complex_buffer = vec![Complex { re: 0.0, im: 0.0 }; FFT_SIZE];
            let mut window = vec![0.0f32; FFT_SIZE];
            
            use std::f32::consts::PI;
            for i in 0..FFT_SIZE {
                window[i] = 0.5 * (1.0 - (2.0 * PI * i as f32 / (FFT_SIZE as f32 - 1.0)).cos());
            }

            while let Ok(samples) = rx.recv() {
                let mut is_silent = true;
                for i in 0..FFT_SIZE {
                    let s = samples[i];
                    if s.abs() > 0.001 { is_silent = false; }
                    complex_buffer[i] = Complex {
                        re: s * window[i],
                        im: 0.0,
                    };
                }

                if is_silent {
                    handle.emit("audio:visualizer", vec![0u8; 64]).ok();
                    continue;
                }

                fft.process(&mut complex_buffer);

                let mut bins = vec![0u8; 64];
                let max_freq: f32 = 20000.0;
                let sample_rate: f32 = 48000.0;
                
                for i in 0..64 {
                    let min_f = 20.0f32 * (max_freq / 20.0f32).powf(i as f32 / 64.0);
                    let max_f = 20.0f32 * (max_freq / 20.0f32).powf((i + 1) as f32 / 64.0);
                    
                    let min_idx = ((min_f / sample_rate) * FFT_SIZE as f32) as usize;
                    let max_idx = ((max_f / sample_rate) * FFT_SIZE as f32) as usize;
                    let min_idx = min_idx.max(1).min(FFT_SIZE / 2 - 1);
                    let max_idx = max_idx.max(min_idx + 1).min(FFT_SIZE / 2);

                    let mut sum = 0.0;
                    for j in min_idx..max_idx {
                        let c = complex_buffer[j];
                        sum += (c.re * c.re + c.im * c.im).sqrt();
                    }
                    let avg = sum / (max_idx - min_idx).max(1) as f32;
                    
                    let val = (avg * 1.5).min(255.0) as u8;
                    bins[i] = val;
                }
                
                handle.emit("audio:visualizer", bins).ok();
            }
        })
        .expect("failed to spawn visualizer thread");
}
