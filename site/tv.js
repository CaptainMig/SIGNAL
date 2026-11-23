// ---------------------------------------------------------------------------
// Live TV rail — OFF BY DEFAULT. A companion to the audit, never the centrepiece.
//
// HARD RULE: the ONLY permitted video is the official YouTube embed of a
// broadcaster's own public live channel (YouTube licenses these for embedding
// by design). No scraping, proxying, hotlinking or reframing of any stream
// from any site. Ported from v1 (signal/src/lib/tv.js, TvRail.jsx).
//
// Nothing loads until the viewer taps a channel: no iframe, no YouTube
// script, no network. One stream at a time; muted on start. The last-picked
// channel is remembered on this device (localStorage) and offered as a
// one-tap resume, never auto-played.
// ---------------------------------------------------------------------------
import { esc } from './ui.js';

export const LIVE_TV_CHANNELS = [
  { name: 'NBC News NOW', channelId: 'UCeY0bbntWzzVIaj2z3QigXg' },
  { name: 'Bloomberg Television', channelId: 'UCIALMKvObZNtJ6AmdCLP7Lg' },
  { name: 'Al Jazeera English', channelId: 'UCNye-wNBqNL5ZzHSJj3l8Bg' },
  { name: 'DW News', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' },
  { name: 'France 24 English', channelId: 'UCQfwfsi5VrQ8yKZ-UWmAEFg' },
];

export const TV_STORAGE_KEY = 'signal.tv.channel';
export const TV_LOAD_TIMEOUT_MS = 12_000;

// Official YouTube embed URL for a channel's current live stream. Muted;
// autoplay applies only because the iframe is mounted solely after a tap.
export function embedUrl(ch) {
  const params = 'autoplay=1&mute=1&rel=0';
  if (ch.videoId) return `https://www.youtube.com/embed/${encodeURIComponent(ch.videoId)}?${params}`;
  return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(ch.channelId)}&${params}`;
}

export function channelByName(name) {
  return LIVE_TV_CHANNELS.find((c) => c.name === name) || null;
}

// Per-device memory of the last-picked channel. Every read and write is
// guarded: storage can be absent or blocked and the rail must still work.
export function rememberedChannel(storage = globalThis.localStorage) {
  try {
    return channelByName(storage?.getItem(TV_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function rememberChannel(ch, storage = globalThis.localStorage) {
  try {
    storage?.setItem(TV_STORAGE_KEY, ch.name);
  } catch {
    /* per-device convenience only */
  }
}

export function renderTvSection() {
  const remembered = rememberedChannel();
  const buttons = LIVE_TV_CHANNELS.map((c) => `<button type="button" data-tv-channel="${esc(c.name)}" class="${remembered?.name === c.name ? 'remembered' : ''}">${esc(c.name)}</button>`).join('');
  return `<details class="section tv" id="live-tv">
    <summary class="panel-head"><span>LIVE TV · OFFICIAL BROADCASTER EMBEDS</span><span class="tv-state" data-tv-state>OFF · TAP A CHANNEL TO START</span></summary>
    <div class="section-body">
      <div class="filters tv-channels" data-tv-channels>${buttons}</div>
      <div class="tv-stage" data-tv-stage>
        <div class="tv-box" data-tv-box><div class="tv-idle note">${remembered ? `Last time: ${esc(remembered.name)}. Tap it to resume. ` : ''}No video loads until you tap a channel.</div></div>
        <div class="note" data-tv-caption></div>
      </div>
      <div class="note">Official broadcaster YouTube live embeds only — a companion to the audit, not a source of record. Muted on start; one stream at a time. No streams are scraped, proxied or reframed.</div>
    </div>
  </details>`;
}

export function wireTv(root, { storage = globalThis.localStorage, timeoutMs = TV_LOAD_TIMEOUT_MS } = {}) {
  const section = root.querySelector('#live-tv');
  if (!section) return;
  const box = section.querySelector('[data-tv-box]');
  const caption = section.querySelector('[data-tv-caption]');
  const state = section.querySelector('[data-tv-state]');
  const channels = section.querySelector('[data-tv-channels]');
  let timer = null;

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    box.innerHTML = '';
  }

  function play(ch) {
    stop();
    rememberChannel(ch, storage);
    channels.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tvChannel === ch.name));
    state.textContent = `ON · ${ch.name.toUpperCase()} · MUTED`;
    caption.textContent = `${ch.name} · official YouTube live embed`;
    const frame = document.createElement('iframe');
    frame.src = embedUrl(ch);
    frame.title = `${ch.name} — official YouTube live stream`;
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('loading', 'eager');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    const unavailable = () => {
      stop();
      box.innerHTML = `<div class="tv-idle note red">STREAM UNAVAILABLE · ${esc(ch.name)}</div>`;
      caption.textContent = 'The embed did not load. The stream may be offline, region-blocked, or embedding may be disabled for this channel.';
      state.textContent = `OFF · ${ch.name.toUpperCase()} UNAVAILABLE`;
    };
    frame.addEventListener('error', unavailable);
    frame.addEventListener('load', () => {
      if (timer) clearTimeout(timer);
      timer = null;
    });
    timer = setTimeout(unavailable, timeoutMs);
    box.appendChild(frame);
  }

  channels.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tv-channel]');
    if (!b) return;
    const ch = channelByName(b.dataset.tvChannel);
    if (ch) play(ch);
  });
  // Closing the section stops the stream: nothing plays out of sight.
  section.addEventListener('toggle', () => {
    if (!section.open) {
      stop();
      box.innerHTML = `<div class="tv-idle note">No video loads until you tap a channel.</div>`;
      caption.textContent = '';
      state.textContent = 'OFF · TAP A CHANNEL TO START';
      channels.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    }
  });
}
